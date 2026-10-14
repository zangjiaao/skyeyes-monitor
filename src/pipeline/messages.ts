export type CollectMessage =
  | { type: "batch"; runId: string; batchId: string }
  | { type: "enqueue"; runId: string }
  | { type: "finalize"; runId: string; reason: "complete" | "deadline" };

export function isCollectMessage(value: unknown): value is CollectMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "batch") {
    return typeof record.runId === "string" && typeof record.batchId === "string";
  }
  if (record.type === "enqueue") return typeof record.runId === "string";
  if (record.type === "finalize") {
    return typeof record.runId === "string" && (record.reason === "complete" || record.reason === "deadline");
  }
  return false;
}
