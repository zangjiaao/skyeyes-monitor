import { callDeepseek } from "../ai/interpret";
import { loadSettings } from "../config/settings";
import { logError } from "../log";
import { acceptableChinese, translateToChinese } from "../translate";

export const RETRANSLATE_LIMIT = 20;

interface TranslateRow {
  id: string;
  original_text: string;
  source_lang: string | null;
  matched_target?: string | null;
}

export async function retranslateRecords(env: Env, input: {
  mode: "selected" | "failed";
  ids: string[];
}): Promise<{ translated: number; failed: number; attempted: number; remaining: number }> {
  const settings = await loadSettings(env.DB);
  const rows = input.mode === "selected"
    ? await selectedRows(env.DB, input.ids.slice(0, RETRANSLATE_LIMIT))
    : await failedRows(env.DB);
  let translated = 0;
  let failed = 0;
  for (const row of rows) {
    const text = row.original_text ?? "";
    if (settings.aiEnabled && settings.aiProvider === "deepseek" && env.DEEPSEEK_API_KEY?.trim()) {
      const deep = await callDeepseek({
        apiKey: env.DEEPSEEK_API_KEY.trim(),
        model: settings.aiModel,
        text,
        targetName: row.matched_target || "监测对象",
        terms: [],
        description: "",
        fetchImpl: globalThis.fetch.bind(globalThis),
      });
      if (deep.ok && deep.parsed.translation && acceptableChinese(text, deep.parsed.translation)) {
        const sourceLang = (deep.parsed.sourceLang || row.source_lang || "und").slice(0, 12);
        await env.DB.prepare(
          `UPDATE records
           SET translation_zh = ?, translation_status = 'ok', translation_error = NULL, source_lang = ?
           WHERE id = ?`,
        ).bind(deep.parsed.translation, sourceLang, row.id).run();
        translated += 1;
        continue;
      }
    }
    const outcome = await translateToChinese(
      env.AI,
      text,
      row.source_lang,
      settings.translationTargetLang,
      settings.translationSourceLang,
      settings.translationFallbackModel,
    );
    if (outcome.status === "ok" && outcome.text) {
      await env.DB.prepare(
        `UPDATE records
         SET translation_zh = ?, translation_status = 'ok', translation_error = NULL, source_lang = ?
         WHERE id = ?`,
      ).bind(outcome.text, outcome.sourceLang, row.id).run();
      translated += 1;
      continue;
    }
    const reason = (outcome.error || "翻译失败").slice(0, 200);
    logError("translation failed", new Error(reason), { id: row.id });
    await env.DB.prepare(
      `UPDATE records
       SET translation_zh = NULL, translation_status = 'translation_failed', translation_error = ?, source_lang = ?
       WHERE id = ?`,
    ).bind(reason, outcome.sourceLang, row.id).run();
    failed += 1;
  }
  const remaining = input.mode === "selected"
    ? Math.max(0, input.ids.length - RETRANSLATE_LIMIT)
    : await countFailed(env.DB);
  return { translated, failed, attempted: rows.length, remaining };
}

async function selectedRows(db: D1Database, ids: string[]): Promise<TranslateRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, original_text, source_lang, matched_target FROM records
     WHERE deleted_at IS NULL AND id IN (${marks})`,
  ).bind(...ids).all<TranslateRow>();
  return result.results;
}

async function failedRows(db: D1Database): Promise<TranslateRow[]> {
  const result = await db.prepare(
    `SELECT id, original_text, source_lang, matched_target FROM records
     WHERE deleted_at IS NULL
       AND (
         translation_status = 'translation_failed'
         OR translation_zh IS NULL
         OR length(trim(translation_zh)) = 0
       )
     ORDER BY collected_at DESC LIMIT ?`,
  ).bind(RETRANSLATE_LIMIT).all<TranslateRow>();
  return result.results;
}

async function countFailed(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM records
     WHERE deleted_at IS NULL
       AND (
         translation_status = 'translation_failed'
         OR translation_zh IS NULL
         OR length(trim(translation_zh)) = 0
       )`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
