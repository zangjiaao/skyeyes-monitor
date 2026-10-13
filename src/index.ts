import { createApp } from "./http/app";
import { logError } from "./log";
import { isCollectMessage } from "./pipeline/messages";
import { handleDeadLetter, processBatch, finalizeRun } from "./pipeline/run";
import { handleScheduled } from "./schedule";
import { RateLimitError } from "./sources/x";

const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env, controller.scheduledTime));
  },
  async queue(batch, env) {
    const deadLetter = batch.queue.endsWith("-dlq");
    for (const message of batch.messages) {
      try {
        if (!isCollectMessage(message.body)) {
          message.ack();
          continue;
        }
        if (deadLetter) {
          await handleDeadLetter(env, message.body);
        } else if (message.body.type === "batch") {
          await processBatch(env, message.body.runId, message.body.batchId);
        } else {
          await finalizeRun(env, message.body.runId, message.body.reason);
        }
        message.ack();
      } catch (error) {
        logError("queue message failed", error, { queue: batch.queue });
        if (deadLetter) message.ack();
        else message.retry({
          delaySeconds: error instanceof RateLimitError ? error.delaySeconds : 45,
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;
