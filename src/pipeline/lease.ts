export const LEASE_MS = 10 * 60 * 1000;
export const STALE_ENQUEUE_MS = 15 * 60 * 1000;
export const MAX_BATCH_ATTEMPTS = 5;
export const PACE_INLINE_MS = 2_000;
export const PLATFORM_CONCURRENCY = 8;
export const QUEUE_CONCURRENCY_DEFAULT = 4;

export const ACTIVE_RUN_STATUSES = ["running", "partial", "finalizing"] as const;
export const RECOVERABLE_RUN_STATUSES = ["running", "partial", "failed", "incomplete"] as const;

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
