import { loadSettings } from "./config/settings";
import { decideSchedule, rollingWindow } from "./domain/time";
import { logError } from "./log";
import { finalizeOverdue, startRun } from "./pipeline/run";

export async function handleScheduled(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date(scheduledTime);
  await finalizeOverdue(env, now);
  const settings = await loadSettings(env.DB);
  const decision = decideSchedule(now, {
    timeZone: settings.timeZone,
    scheduleHour: settings.scheduleHour,
    windowHours: settings.windowHours,
  });
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
    logError("scheduled run failed", error, { slotKey: decision.slotKey });
    throw error;
  }
}

export async function startManualRun(env: Env, now = new Date()): Promise<{ runId: string; batches: number }> {
  const settings = await loadSettings(env.DB);
  const window = rollingWindow(now, settings.windowHours);
  const started = await startRun(env, {
    trigger: "manual",
    now,
    slotKey: "",
    windowStart: window.start,
    windowEnd: window.end,
  });
  return { runId: started.runId, batches: started.batches };
}
