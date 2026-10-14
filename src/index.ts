import { createApp } from "./http/app";
import { logError, logWarn } from "./log";
import { isCollectMessage } from "./pipeline/messages";
import { DeferredBatchError } from "./pipeline/lease";
import { continueEnqueue, handleDeadLetter, processBatch, finalizeRun, scheduleDeferredWake } from "./pipeline/run";
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
        } else if (message.body.type === "enqueue") {
          await continueEnqueue(env, message.body.runId);
        } else {
          await finalizeRun(env, message.body.runId, message.body.reason);
        }
        message.ack();
      } catch (error) {
        const paced = error instanceof RateLimitError || error instanceof DeferredBatchError;
        if (paced) {
          logWarn("queue message delayed", {
            queue: batch.queue,
            delaySeconds: error.delaySeconds,
            error: error.message,
          });
          const body = message.body;
          if (!deadLetter && isCollectMessage(body) && body.type === "batch") {
            await scheduleDeferredWake(
              env,
              body.runId,
              body.batchId,
              null,
              error.delaySeconds,
              error instanceof RateLimitError ? error : undefined,
            );
          }
          message.ack();
          continue;
        }
        logError("queue message failed", error, { queue: batch.queue });
        if (deadLetter) message.ack();
        else message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
