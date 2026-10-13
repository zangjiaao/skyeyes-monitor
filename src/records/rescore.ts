import { scoreRelevance } from "../domain/relevance";
import { logError } from "../log";

export const RESCORE_LIMIT = 20;

interface ScoreRow {
  id: string;
  original_text: string;
  matched_target: string;
}

export async function rescoreRecords(env: Env, input: {
  mode: "selected" | "unscored";
  ids: string[];
}): Promise<{ scored: number; failed: number; attempted: number; remaining: number }> {
  const rows = input.mode === "selected"
    ? await selectedRows(env.DB, input.ids.slice(0, RESCORE_LIMIT))
    : await unscoredRows(env.DB);
  let scored = 0;
  let failed = 0;
  for (const row of rows) {
    const outcome = await scoreRelevance(env.AI, row.original_text, row.matched_target);
    if (outcome.score != null) {
      await env.DB.prepare(
        "UPDATE records SET relevance_score = ?, relevance_error = NULL WHERE id = ?",
      ).bind(outcome.score, row.id).run();
      scored += 1;
      continue;
    }
    const reason = (outcome.error || "评分失败").slice(0, 200);
    logError("relevance score failed", new Error(reason), { id: row.id });
    await env.DB.prepare(
      "UPDATE records SET relevance_error = ? WHERE id = ? AND relevance_score IS NULL",
    ).bind(reason, row.id).run();
    failed += 1;
  }
  const remaining = input.mode === "selected"
    ? Math.max(0, input.ids.length - RESCORE_LIMIT)
    : await countUnscored(env.DB);
  return { scored, failed, attempted: rows.length, remaining };
}

async function selectedRows(db: D1Database, ids: string[]): Promise<ScoreRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, original_text, matched_target FROM records
     WHERE deleted_at IS NULL AND id IN (${marks})`,
  ).bind(...ids).all<ScoreRow>();
  return result.results;
}

async function unscoredRows(db: D1Database): Promise<ScoreRow[]> {
  const result = await db.prepare(
    `SELECT id, original_text, matched_target FROM records
     WHERE deleted_at IS NULL AND relevance_score IS NULL AND relevance_error IS NULL
     ORDER BY collected_at DESC LIMIT ?`,
  ).bind(RESCORE_LIMIT).all<ScoreRow>();
  return result.results;
}

async function countUnscored(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM records
     WHERE deleted_at IS NULL AND relevance_score IS NULL AND relevance_error IS NULL`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
