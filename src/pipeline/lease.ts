export const LEASE_MS = 10 * 60 * 1000;
export const STALE_ENQUEUE_MS = 15 * 60 * 1000;
export const MAX_BATCH_ATTEMPTS = 5;
export const MAX_DEFER_COUNT = 2_000;
export const MAX_DEFER_WAIT_SEC = 6 * 60 * 60;
export const PACE_INLINE_MS = 2_000;
/**
 * Queue consumers are limited to 15 minutes of wall clock.
 * One source chain stops earlier so the continuation send still fits.
 */
export const COORDINATOR_WALL_MS = 8 * 60 * 1000;
/** Keep the tail of an invocation free for the checkpoint and the one continuation. */
export const COORDINATOR_WALL_RESERVE_MS = 20_000;
/** A chain that loses the concurrency gate waits once, instead of retrying every few seconds. */
export const COORDINATOR_GATE_DELAY_SEC = 30;
export const PLATFORM_CONCURRENCY = 8;
export const QUEUE_CONCURRENCY_DEFAULT = 4;

export const ACTIVE_RUN_STATUSES = ["running", "partial", "finalizing"] as const;
/**
 * Hourly requeue may reopen these runs. `incomplete` is terminal: flipping it
 * back to `running` starts another deadline finalize, which can die in
 * `finalizing` and block every later run.
 */
export const RECOVERABLE_RUN_STATUSES = ["running", "partial", "failed"] as const;
/**
 * A row left in `finalizing` longer than this is forced terminal.
 * One Worker invocation is at most 15 minutes; the cron gap is an hour.
 */
export const FINALIZING_GRACE_MS = 20 * 60 * 1000;

export class DeferredBatchError extends Error {
  readonly delaySeconds: number;

  constructor(delaySeconds: number) {
    super("采集稍后再试");
    this.name = "DeferredBatchError";
    this.delaySeconds = Math.max(1, Math.floor(delaySeconds));
  }
}

export function batchWakeup(runId: string, batchId: string): MessageSendRequest<{ type: "batch"; runId: string; batchId: string }> {
  return { body: { type: "batch", runId, batchId } };
}
