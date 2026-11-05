import { logWarn } from "../log";

const PHASES: Record<string, string> = {
  "batch started": "starting", "source query request": "fetching",
  "source query response": "parsing", "source query error": "retrying", "source query result": "processing",
  "source page stored": "processing", "source query wait": "pacing", "batch deferred": "waiting",
  "batch retry": "retrying", "batch failed": "failed", "batch done": "done",
};

/** Diagnostic persistence is best effort; a failure must not fail collection. */
export async function recordRunEvent(db: D1Database, input: {
  runId: string;
  batchId?: string;
  source?: string;
  type: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    const details = input.details ?? {};
    const now = new Date().toISOString();
    const statements = [db.prepare(
      "INSERT INTO run_events (run_id, batch_id, source, type, details_json, created_at) VALUES (?, ?, COALESCE(?, (SELECT source FROM batches WHERE id = ?)), ?, ?, ?)",
    ).bind(input.runId, input.batchId ?? null, input.source ?? null, input.batchId ?? null, input.type, JSON.stringify(details), now)];
    if (input.batchId) {
      statements.push(db.prepare(
        `UPDATE batches SET last_activity_at = ?, phase = ?,
           wait_reason = CASE WHEN ? IN ('batch deferred', 'source query wait') THEN ? WHEN ? IN ('batch started', 'source query request', 'batch done') THEN NULL ELSE wait_reason END,
           current_query_json = CASE WHEN ? = 1 THEN ? ELSE current_query_json END,
           items_received = items_received + ?,
           queries_done = CASE WHEN ? = 'batch done' THEN queries_total ELSE MAX(queries_done, ?) END
         WHERE id = ? AND run_id = ?`,
      ).bind(
        now, details.deferred === true ? "waiting" : PHASES[input.type] ?? null,
        input.type, details.reason ?? null, input.type,
        typeof details.targetId === "string" ? 1 : 0, JSON.stringify(details),
        input.type === "source query result" ? Number(details.rawItems ?? 0) : 0,
        input.type, Number(details.nextStep ?? 0), input.batchId, input.runId,
      ));
    }
    await db.batch(statements);
  } catch (error) {
    logWarn("run event persistence failed", {
      runId: input.runId, type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
