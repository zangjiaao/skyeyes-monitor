import { chunk } from "./batching";

export interface CountryRow {
  id: number;
  code: string;
  name: string;
}

export interface TargetRow {
  id: number;
  country_id: number;
  kind: string;
  name: string;
  query: string;
  active: number;
}

export interface RecipientRow {
  id: number;
  email: string;
  active: number;
}

export interface RunRow {
  id: string;
  collected_date: string;
  window_start: string;
  window_end: string;
  status: "collecting" | "finalizing" | "completed" | "partial";
  expected_batches: number;
  completed_batches: number;
  failed_batches: number;
  note: string | null;
  finalize_started_at: string | null;
  created_at: string;
  finalized_at: string | null;
}

export interface BatchRow {
  id: string;
  run_id: string;
  country_id: number;
  source: "x" | "web";
  provider_id: string;
  target_ids: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface RecordRow {
  id: number;
  source: "x" | "web";
  url: string;
  original_text: string;
  published_at: string | null;
  author_handle: string | null;
  author_name: string | null;
  author_url: string | null;
  country_code: string;
  country_name: string;
  matched_target: string;
  collected_date: string;
  translation_zh: string | null;
  lang: string | null;
}

export interface NewRecordInput {
  dedupeKey: string;
  source: "x" | "web";
  externalId: string;
  url: string;
  originalText: string;
  publishedAt: string | null;
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  countryId: number;
  countryCode: string;
  countryName: string;
  matchedTarget: string;
  collectedDate: string;
  runId: string;
  lang: string | null;
}

function changed(result: D1Result): boolean {
  return (result.meta.changes ?? 0) > 0;
}

export async function listCountries(env: Env): Promise<CountryRow[]> {
  const { results } = await env.DB.prepare("SELECT id, code, name FROM countries ORDER BY code").all<CountryRow>();
  return results;
}

export async function insertCountry(env: Env, code: string, name: string, now: string): Promise<CountryRow> {
  const row = await env.DB.prepare("INSERT INTO countries (code, name, created_at) VALUES (?, ?, ?) RETURNING id, code, name")
    .bind(code, name, now)
    .first<CountryRow>();
  if (!row) throw new Error("insert_country_failed");
  return row;
}

export async function deleteCountry(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM countries WHERE id = ?").bind(id).run();
  return changed(result);
}

export async function countTargetsForCountry(env: Env, countryId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM targets WHERE country_id = ?").bind(countryId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getCountryByCode(env: Env, code: string): Promise<CountryRow | null> {
  return env.DB.prepare("SELECT id, code, name FROM countries WHERE code = ?").bind(code).first<CountryRow>();
}

export async function getCountryById(env: Env, id: number): Promise<CountryRow | null> {
  return env.DB.prepare("SELECT id, code, name FROM countries WHERE id = ?").bind(id).first<CountryRow>();
}

export async function listTargets(env: Env, countryCode?: string): Promise<TargetRow[]> {
  if (countryCode) {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.country_id, t.kind, t.name, t.query, t.active
       FROM targets t JOIN countries c ON c.id = t.country_id
       WHERE c.code = ? ORDER BY t.id`,
    )
      .bind(countryCode)
      .all<TargetRow>();
    return results;
  }
  const { results } = await env.DB.prepare(
    "SELECT id, country_id, kind, name, query, active FROM targets ORDER BY id",
  ).all<TargetRow>();
  return results;
}

export async function findTargetByQuery(env: Env, countryId: number, query: string): Promise<{ id: number } | null> {
  return env.DB.prepare("SELECT id FROM targets WHERE country_id = ? AND lower(query) = lower(?)")
    .bind(countryId, query)
    .first<{ id: number }>();
}

export async function insertTarget(
  env: Env,
  input: { countryId: number; kind: string; name: string; query: string },
  now: string,
): Promise<TargetRow> {
  const row = await env.DB.prepare(
    `INSERT INTO targets (country_id, kind, name, query, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)
     RETURNING id, country_id, kind, name, query, active`,
  )
    .bind(input.countryId, input.kind, input.name, input.query, now)
    .first<TargetRow>();
  if (!row) throw new Error("insert_target_failed");
  return row;
}

export async function deleteTarget(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(id).run();
  return changed(result);
}

export async function listActiveTargets(env: Env, countryId: number): Promise<TargetRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, country_id, kind, name, query, active FROM targets WHERE country_id = ? AND active = 1 ORDER BY id",
  )
    .bind(countryId)
    .all<TargetRow>();
  return results;
}

export async function listTargetsByIds(env: Env, ids: readonly number[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id, country_id, kind, name, query, active FROM targets WHERE active = 1 AND id IN (${marks})`,
  )
    .bind(...ids)
    .all<TargetRow>();
  return results;
}

export async function listRecipients(env: Env): Promise<RecipientRow[]> {
  const { results } = await env.DB.prepare("SELECT id, email, active FROM recipients ORDER BY id").all<RecipientRow>();
  return results;
}

export async function listActiveRecipientEmails(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT email FROM recipients WHERE active = 1 ORDER BY id").all<{ email: string }>();
  return results.map((row) => row.email);
}

export async function findRecipient(env: Env, email: string): Promise<{ id: number } | null> {
  return env.DB.prepare("SELECT id FROM recipients WHERE lower(email) = lower(?)").bind(email).first<{ id: number }>();
}

export async function insertRecipient(env: Env, email: string, now: string): Promise<RecipientRow> {
  const row = await env.DB.prepare("INSERT INTO recipients (email, active, created_at) VALUES (?, 1, ?) RETURNING id, email, active")
    .bind(email, now)
    .first<RecipientRow>();
  if (!row) throw new Error("insert_recipient_failed");
  return row;
}

export async function deleteRecipient(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM recipients WHERE id = ?").bind(id).run();
  return changed(result);
}

export async function findLatestRunForDate(env: Env, collectedDate: string): Promise<RunRow | null> {
  return env.DB.prepare("SELECT * FROM runs WHERE collected_date = ? ORDER BY created_at DESC LIMIT 1")
    .bind(collectedDate)
    .first<RunRow>();
}

export async function getRun(env: Env, id: string): Promise<RunRow | null> {
  return env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first<RunRow>();
}

export async function getLatestRun(env: Env): Promise<RunRow | null> {
  return env.DB.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT 1").first<RunRow>();
}

export async function insertRun(
  env: Env,
  input: { id: string; collectedDate: string; windowStart: string; windowEnd: string; now: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (
      id, collected_date, window_start, window_end, status, expected_batches, completed_batches, failed_batches, created_at
    ) VALUES (?, ?, ?, ?, 'collecting', 0, 0, 0, ?)`,
  )
    .bind(input.id, input.collectedDate, input.windowStart, input.windowEnd, input.now)
    .run();
}

export async function insertBatches(
  env: Env,
  runId: string,
  batches: readonly { id: string; countryId: number; source: "x" | "web"; providerId: string; targetIds: number[] }[],
  now: string,
): Promise<void> {
  for (const group of chunk(batches, 40)) {
    const statements = group.map((batch) =>
      env.DB.prepare(
        `INSERT INTO batches (id, run_id, country_id, source, provider_id, target_ids, status, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      ).bind(batch.id, runId, batch.countryId, batch.source, batch.providerId, JSON.stringify(batch.targetIds), now),
    );
    if (statements.length > 0) await env.DB.batch(statements);
  }
}

export async function setExpectedBatches(env: Env, runId: string, expected: number): Promise<void> {
  await env.DB.prepare("UPDATE runs SET expected_batches = ? WHERE id = ?").bind(expected, runId).run();
}

export async function getBatch(env: Env, id: string): Promise<BatchRow | null> {
  return env.DB.prepare("SELECT * FROM batches WHERE id = ?").bind(id).first<BatchRow>();
}

export async function listBatches(env: Env, runId: string): Promise<BatchRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM batches WHERE run_id = ? ORDER BY created_at, id",
  )
    .bind(runId)
    .all<BatchRow>();
  return results;
}

export async function listPendingBatches(env: Env, runId: string): Promise<BatchRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM batches WHERE run_id = ? AND status = 'pending' ORDER BY created_at, id",
  )
    .bind(runId)
    .all<BatchRow>();
  return results;
}

export async function bumpAttempt(env: Env, batchId: string): Promise<void> {
  await env.DB.prepare("UPDATE batches SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(batchId).run();
}

export async function noteBatchError(env: Env, batchId: string, error: string): Promise<void> {
  await env.DB.prepare("UPDATE batches SET error = ? WHERE id = ? AND status = 'pending'").bind(error.slice(0, 200), batchId).run();
}

export async function completeBatch(env: Env, batchId: string, runId: string, now: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE batches SET status = 'done', error = NULL, finished_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(now, batchId)
    .run();
  if (!changed(result)) return false;
  await env.DB.prepare("UPDATE runs SET completed_batches = completed_batches + 1 WHERE id = ?").bind(runId).run();
  return true;
}

export async function failBatch(env: Env, batchId: string, runId: string, error: string, now: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE batches SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(error.slice(0, 200), now, batchId)
    .run();
  if (!changed(result)) return false;
  await env.DB.prepare("UPDATE runs SET failed_batches = failed_batches + 1 WHERE id = ?").bind(runId).run();
  return true;
}

export async function countIncompleteBatches(env: Env, runId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM batches WHERE run_id = ? AND status != 'done'")
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function insertRecord(env: Env, input: NewRecordInput, now: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `INSERT INTO records (
      dedupe_key, source, external_id, url, original_text, published_at,
      author_handle, author_name, author_url, country_id, country_code, country_name,
      matched_target, collected_date, translation_zh, run_id, lang, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
    RETURNING id`,
  )
    .bind(
      input.dedupeKey,
      input.source,
      input.externalId,
      input.url,
      input.originalText.slice(0, 8000),
      input.publishedAt,
      input.authorHandle,
      input.authorName,
      input.authorUrl,
      input.countryId,
      input.countryCode,
      input.countryName,
      input.matchedTarget,
      input.collectedDate,
      input.runId,
      input.lang,
      now,
    )
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function setTranslation(env: Env, id: number, translation: string): Promise<void> {
  await env.DB.prepare("UPDATE records SET translation_zh = ? WHERE id = ?").bind(translation.slice(0, 8000), id).run();
}

export async function listUntranslated(env: Env, limit: number): Promise<{ id: number; original_text: string; lang: string | null }[]> {
  if (limit <= 0) return [];
  const { results } = await env.DB.prepare(
    "SELECT id, original_text, lang FROM records WHERE translation_zh IS NULL ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all<{ id: number; original_text: string; lang: string | null }>();
  return results;
}

export async function countRecords(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM records").first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listRecordsForExport(env: Env, limit: number): Promise<RecordRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source, url, original_text, published_at, author_handle, author_name, author_url,
            country_code, country_name, matched_target, collected_date, translation_zh, lang
     FROM records
     ORDER BY collected_date DESC, id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<RecordRow>();
  return results;
}

export interface CountryCount {
  code: string;
  name: string;
  x_count: number;
  web_count: number;
}

export async function countNewByCountry(env: Env, collectedDate: string): Promise<CountryCount[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.code AS code, c.name AS name,
            COALESCE(SUM(CASE WHEN r.source = 'x' THEN 1 ELSE 0 END), 0) AS x_count,
            COALESCE(SUM(CASE WHEN r.source = 'web' THEN 1 ELSE 0 END), 0) AS web_count
     FROM countries c
     LEFT JOIN records r ON r.country_id = c.id AND r.collected_date = ?
     GROUP BY c.id
     ORDER BY c.code`,
  )
    .bind(collectedDate)
    .all<CountryCount>();
  return results;
}

export async function countUntranslatedOnDate(env: Env, collectedDate: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM records WHERE collected_date = ? AND translation_zh IS NULL",
  )
    .bind(collectedDate)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countRecordsOnDate(env: Env, collectedDate: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE collected_date = ?")
    .bind(collectedDate)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function claimFinalize(env: Env, runId: string, now: string, leaseExpiredBefore: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
     SET status = 'finalizing', finalize_started_at = ?
     WHERE id = ?
       AND (
         status = 'collecting'
         OR (status = 'finalizing' AND (finalize_started_at IS NULL OR finalize_started_at <= ?))
       )`,
  )
    .bind(now, runId, leaseExpiredBefore)
    .run();
  return changed(result);
}

export async function releaseFinalize(env: Env, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs
     SET status = 'collecting', finalize_started_at = NULL
     WHERE id = ? AND status = 'finalizing' AND finalized_at IS NULL`,
  )
    .bind(runId)
    .run();
}

export async function reopenRun(env: Env, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs
     SET status = 'collecting', finalize_started_at = NULL, finalized_at = NULL
     WHERE id = ?`,
  )
    .bind(runId)
    .run();
}

export async function finishRun(
  env: Env,
  runId: string,
  status: "completed" | "partial",
  note: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET status = ?, note = ?, finalized_at = ? WHERE id = ? AND status = 'finalizing'`,
  )
    .bind(status, note.slice(0, 4000), now, runId)
    .run();
}

export async function listRunsForDeadline(env: Env, createdBefore: string, leaseExpiredBefore: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM runs
     WHERE (status = 'collecting' AND created_at <= ?)
        OR (status = 'finalizing' AND (finalize_started_at IS NULL OR finalize_started_at <= ?))
     ORDER BY created_at`,
  )
    .bind(createdBefore, leaseExpiredBefore)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}
