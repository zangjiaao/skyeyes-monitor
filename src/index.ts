import { handleFetch } from "./http";
import { log } from "./log";
import { COLLECT_DLQ_NAME } from "./messages";
import { deadlineSweep, handleDeadLetter, handleQueueMessage, startRun } from "./pipeline";

const COLLECT_CRON = "0 2 * * *";
const DEADLINE_CRON = "0 3 * * *";

export default {
  async fetch(request, env): Promise<Response> {
    return handleFetch(request, env);
  },

  async scheduled(controller, env): Promise<void> {
    const cron = controller.cron.trim();
    try {
      if (cron === DEADLINE_CRON) {
        const result = await deadlineSweep(env);
        log("info", "截止时间汇总结束", result);
        return;
      }
      if (cron === COLLECT_CRON) {
        const result = await startRun(env, { force: false });
        log("info", "定时采集已处理", { runId: result.runId, batches: result.batches, skipped: result.skipped });
        return;
      }
      log("info", "忽略未识别的 cron", { cron });
    } catch (error) {
      log("error", "定时任务失败", { cron, error: error instanceof Error ? error.message : "unknown" });
      throw error;
    }
  },

  async queue(batch, env): Promise<void> {
    const deadLetter = batch.queue === COLLECT_DLQ_NAME;
    for (const message of batch.messages) {
      try {
        if (deadLetter) {
          await handleDeadLetter(env, message.body);
          message.ack();
          continue;
        }
        const outcome = await handleQueueMessage(env, message.body);
        if (outcome === "busy") {
          message.retry({ delaySeconds: 240 });
          continue;
        }
        message.ack();
      } catch (error) {
        log("error", "队列消息失败", {
          queue: batch.queue,
          error: error instanceof Error ? error.message : "unknown",
        });
        message.retry({ delaySeconds: deadLetter ? 240 : 60 });
      }
    }
  },
} satisfies ExportedHandler<Env>;
