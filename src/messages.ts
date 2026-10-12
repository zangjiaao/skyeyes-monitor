export const COLLECT_QUEUE_NAME = "skyeyes-collect";
export const COLLECT_DLQ_NAME = "skyeyes-collect-dlq";

export interface CollectQueueMessage {
  type: "collect";
  runId: string;
  batchId: string;
}

export interface FinalizeQueueMessage {
  type: "finalize";
  runId: string;
  reason: "complete" | "deadline";
}

export type QueueMessage = CollectQueueMessage | FinalizeQueueMessage;

export function parseQueueMessage(body: unknown): QueueMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.type === "collect" && typeof record.runId === "string" && typeof record.batchId === "string") {
    return { type: "collect", runId: record.runId, batchId: record.batchId };
  }
  if (
    record.type === "finalize" &&
    typeof record.runId === "string" &&
    (record.reason === "complete" || record.reason === "deadline")
  ) {
    return { type: "finalize", runId: record.runId, reason: record.reason };
  }
  return null;
}
