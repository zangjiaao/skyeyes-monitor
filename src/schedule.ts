import { loadSettings } from "./config/settings";
import { decideSchedule, rollingWindow } from "./domain/time";
import { log, logError } from "./log";
import { STUCK_BATCH_GRACE_MS } from "./pipeline/queue-batch";
import { ActiveRunError, finalizeOverdue, requeueStuckBatches, startRun } from "./pipeline/run";

export async function handleScheduled(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date(scheduledTime);
  const settings = await loadSettings(env.DB);
  const decision = decideSchedule(now, {
    timeZone: settings.timeZone,
    scheduleHour: settings.scheduleHour,
    windowHours: settings.windowHours,
  });
  await finalizeOverdue(env, now, { yieldToNextRun: decision.due });
  try {
    await requeueStuckBatches(env, { now, minAgeMs: STUCK_BATCH_GRACE_MS });
  } catch (error) {
    logError("requeue stuck batches failed", error);
  }
  console.log(JSON.stringify({
    message: "hourly cron",
    due: decision.due,
    slotKey: decision.slotKey,
    scheduleHour: settings.scheduleHour,
    timeZone: settings.timeZone,
  }));
  if (!decision.due) return;
  try {
    await startRun(env, {
      trigger: "schedule",
      now,
      slotKey: decision.slotKey,
      windowStart: decision.start,
      windowEnd: decision.end,
    });
  } catch (error) {
    if (error instanceof ActiveRunError) {
      log("schedule skipped because a run is active", { activeRunId: error.activeRunId, slotKey: decision.slotKey });
      return;
    }
    logError("scheduled run failed", error, { slotKey: decision.slotKey });
    throw error;
  }
}

export async function startManualRun(env: Env, now = new Date(), options: { confirm?: boolean; countryIds?: string[] } = {}): Promise<{
  runId: string;
  batches: number;
  enqueued: number;
  warning: string | null;
}> {
  try {
    if (options.countryIds === undefined) await requeueStuckBatches(env, { now, minAgeMs: STUCK_BATCH_GRACE_MS });
  } catch (error) {
    logError("requeue stuck batches failed", error);
  }
  const settings = await loadSettings(env.DB);
  const window = rollingWindow(now, settings.windowHours);
  const started = await startRun(env, {
    trigger: "manual",
    now,
    slotKey: "",
    windowStart: window.start,
    windowEnd: window.end,
    confirm: options.confirm,
    countryIds: options.countryIds,
  });
  return {
    runId: started.runId,
    batches: started.batches,
    enqueued: started.enqueued,
    warning: started.warning,
  };
}
