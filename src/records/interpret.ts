import { interpretRecord } from "../ai/interpret";
import { loadSettings } from "../config/settings";
import { logError } from "../log";

export const INTERPRET_LIMIT = 8;

interface InterpretRow {
  id: string;
  original_text: string;
  source_lang: string | null;
  matched_target: string;
  matched_term: string;
  terms: string | null;
  description: string | null;
}

export async function interpretStoredRecords(env: Env, input: {
  mode: "selected" | "pending";
  ids: string[];
}): Promise<{ interpreted: number; failed: number; attempted: number; remaining: number }> {
  const settings = await loadSettings(env.DB);
  const rows = input.mode === "selected"
    ? await selectedRows(env.DB, input.ids.slice(0, INTERPRET_LIMIT))
    : await pendingRows(env.DB);
  let interpreted = 0;
  let failed = 0;
  for (const row of rows) {
    const terms = (row.terms || row.matched_term || "").split(/\r?\n/).map((term) => term.trim()).filter(Boolean);
    const outcome = await interpretRecord({
      ai: env.AI,
      apiKey: env.DEEPSEEK_API_KEY || "",
      settings,
      text: row.original_text ?? "",
      hintedLang: row.source_lang,
      targetName: row.matched_target || "",
      terms,
      description: row.description ?? "",
      fetchImpl: globalThis.fetch.bind(globalThis),
    });
    const scoreFailed = outcome.score == null && Boolean(outcome.relevanceError);
    const translationFailed = outcome.translationStatus === "translation_failed";
    await env.DB.prepare(
      `UPDATE records SET
         translation_zh = ?, translation_status = ?, translation_error = ?, source_lang = ?,
         relevance_score = ?, relevance_error = ?,
         ai_summary = ?, ai_reason = ?, ai_event_type = ?, ai_mentions = ?, ai_provider = ?
       WHERE id = ?`,
    ).bind(
      outcome.translation,
      outcome.translationStatus,
      outcome.translationError,
      outcome.sourceLang,
      outcome.score,
      outcome.relevanceError,
      outcome.summary || null,
      outcome.reason || null,
      outcome.eventType || null,
      outcome.mentions || null,
      outcome.provider || null,
      row.id,
    ).run();
    if (scoreFailed || translationFailed) {
      failed += 1;
      logError("ai interpretation incomplete", new Error(outcome.relevanceError || outcome.translationError || "解读未完成"), { id: row.id });
    } else {
      interpreted += 1;
    }
  }
  const remaining = input.mode === "selected"
    ? Math.max(0, input.ids.length - INTERPRET_LIMIT)
    : await countPending(env.DB);
  return { interpreted, failed, attempted: rows.length, remaining };
}

async function selectedRows(db: D1Database, ids: string[]): Promise<InterpretRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT r.id, r.original_text, r.source_lang, r.matched_target, r.matched_term, t.terms, t.description
     FROM records r LEFT JOIN targets t ON t.id = r.matched_target_id
     WHERE r.deleted_at IS NULL AND r.id IN (${marks})`,
  ).bind(...ids).all<InterpretRow>();
  return result.results;
}

const PENDING_SQL = `
  r.deleted_at IS NULL AND (
    r.relevance_score IS NULL
    OR r.translation_status = 'translation_failed'
    OR r.translation_zh IS NULL
    OR length(trim(r.translation_zh)) = 0
  )`;

async function pendingRows(db: D1Database): Promise<InterpretRow[]> {
  const result = await db.prepare(
    `SELECT r.id, r.original_text, r.source_lang, r.matched_target, r.matched_term, t.terms, t.description
     FROM records r LEFT JOIN targets t ON t.id = r.matched_target_id
     WHERE ${PENDING_SQL}
     ORDER BY r.collected_at DESC LIMIT ?`,
  ).bind(INTERPRET_LIMIT).all<InterpretRow>();
  return result.results;
}

async function countPending(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM records r WHERE ${PENDING_SQL}`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
