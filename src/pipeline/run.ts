import { loadSettings, type AppSettings } from "../config/settings";
import { batchTargetsForQuery } from "../domain/batch";
import { dedupeRecords } from "../domain/dedupe";
import type { SourceId, TargetKind } from "../domain/types";
import { SOURCE_IDS } from "../domain/types";
import { buildDigest } from "../email/compose";
import { sendWithCloudflare } from "../email/cloudflare";
import { sendWithResend } from "../email/resend";
import { ATTACHMENT_LIMIT_BYTES, type OutboundEmail } from "../email/types";
import { buildMonitorWorkbook, type ExcelRecord } from "../export/excel";
import { errorMessage, log, logError } from "../log";
import { getProvider } from "../sources/registry";
import { RateLimitError } from "../sources/x";
import { translateToChinese } from "../translate";
import type { CollectMessage } from "./messages";

const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_EXCEL_ROWS = 50000;

interface CountryRow {
  id: string;
  name: string;
  code: string;
  enabled: number;
}

interface TargetRow {
  id: string;
  country_id: string;
  kind: TargetKind;
  name: string;
  query: string;
  enabled: number;
}

interface RunRow {
  id: string;
  status: string;
  window_start: string;
  window_end: string;
  batches_failed: number;
}

interface BatchRow {
  id: string;
  run_id: string;
  country_id: string;
  source: SourceId;
  target_ids: string;
  status: string;
}

interface RecordRow {
  country_name: string;
  original_text: string;
  published_at: string | null;
  author_handle: string;
  author_name: string;
  author_url: string;
  source: string;
  url: string;
  matched_target: string;
  collected_at: string;
  translation_zh: string | null;
}

async function runChunk(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (let index = 0; index < statements.length; index += 40) {
    const chunk = statements.slice(index, index + 40);
    results.push(...await db.batch(chunk));
  }
  return results;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (!(error instanceof Error)) return false;
  return /限流|429|502|503|504|network|ECONN|fetch failed/i.test(error.message);
}

export async function startRun(env: Env, input: {
  trigger: "schedule" | "manual";
  now: Date;
  slotKey: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<{ runId: string; created: boolean; batches: number }> {
  const settings = await loadSettings(env.DB);
  const runId = crypto.randomUUID();
  const slotKey = input.trigger === "manual" ? `manual-${runId}` : input.slotKey;
  const startedAt = input.now.toISOString();
  const deadlineAt = new Date(input.now.getTime() + settings.finalizeDeadlineMinutes * 60 * 1000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).bind(
      runId,
      slotKey,
      input.trigger,
      input.windowStart.toISOString(),
      input.windowEnd.toISOString(),
      startedAt,
      deadlineAt,
    ).run();
  } catch (error) {
    const existing = await env.DB.prepare("SELECT id FROM runs WHERE slot_key = ?")
      .bind(input.slotKey)
      .first<{ id: string }>();
    if (existing && input.trigger === "schedule") {
      log("schedule already started", { runId: existing.id, slotKey: input.slotKey });
      return { runId: existing.id, created: false, batches: 0 };
    }
    throw error;
  }

  const countries = await env.DB.prepare(
    "SELECT id, name, code, enabled FROM countries WHERE enabled = 1 ORDER BY name",
  ).all<CountryRow>();
  const inserts: D1PreparedStatement[] = [];
  const messages: MessageSendRequest<CollectMessage>[] = [];

  for (const country of countries.results) {
    const targets = await env.DB.prepare(
      "SELECT id, country_id, kind, name, query, enabled FROM targets WHERE country_id = ? AND enabled = 1 ORDER BY name",
    ).bind(country.id).all<TargetRow>();
    const queryTargets = targets.results.map((target) => ({
      id: target.id,
      kind: target.kind,
      name: target.name,
      query: target.query,
    }));
    for (const source of SOURCE_IDS) {
      if (!settings.sources[source] || queryTargets.length === 0) continue;
      const groups = batchTargetsForQuery(queryTargets, settings.batchSize);
      for (const group of groups) {
        const batchId = crypto.randomUUID();
        inserts.push(env.DB.prepare(
          `INSERT INTO batches (
            id, run_id, country_id, source, batch_index, target_ids, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        ).bind(
          batchId,
          runId,
          country.id,
          source,
          messages.length,
          JSON.stringify(group.map((target) => target.id)),
          startedAt,
        ));
        messages.push({
          body: { type: "batch", runId, batchId },
          delaySeconds: Math.min(messages.length * 3, 900),
        });
      }
    }
  }

  if (inserts.length > 0) await runChunk(env.DB, inserts);
  await env.DB.prepare("UPDATE runs SET batches_total = ? WHERE id = ?").bind(messages.length, runId).run();
  log("run started", { runId, trigger: input.trigger, batches: messages.length });
  if (messages.length === 0) {
    await finalizeRun(env, runId, "complete");
  } else {
    await env.COLLECT_QUEUE.sendBatch(messages);
  }
  return { runId, created: true, batches: messages.length };
}

async function loadTargets(db: D1Database, ids: string[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, country_id, kind, name, query, enabled FROM targets WHERE id IN (${marks})`,
  ).bind(...ids).all<TargetRow>();
  return result.results;
}

export async function processBatch(env: Env, runId: string, batchId: string): Promise<void> {
  const batch = await env.DB.prepare(
    "SELECT id, run_id, country_id, source, target_ids, status FROM batches WHERE id = ?",
  ).bind(batchId).first<BatchRow>();
  if (!batch || batch.run_id !== runId || batch.status === "done" || batch.status === "failed") return;
  const run = await env.DB.prepare(
    "SELECT id, status, window_start, window_end, batches_failed FROM runs WHERE id = ?",
  ).bind(runId).first<RunRow>();
  if (!run) return;

  await env.DB.prepare(
    "UPDATE batches SET status = 'running', attempts = attempts + 1 WHERE id = ?",
  ).bind(batchId).run();

  try {
    const settings = await loadSettings(env.DB);
    const country = await env.DB.prepare("SELECT id, name, code, enabled FROM countries WHERE id = ?")
      .bind(batch.country_id)
      .first<CountryRow>();
    if (!country) throw new Error("国家不存在");
    const ids = JSON.parse(batch.target_ids) as string[];
    const targets = await loadTargets(env.DB, ids);
    const provider = getProvider(batch.source);
    const result = await provider.search({
      targets: targets.map((target) => ({
        id: target.id,
        kind: target.kind,
        name: target.name,
        query: target.query,
      })),
      window: { start: new Date(run.window_start), end: new Date(run.window_end) },
      countryName: country.name,
      // Workers 里的 fetch 必须绑定 globalThis，否则会报 Illegal invocation。
      fetchImpl: globalThis.fetch.bind(globalThis),
      apiKey: batch.source === "x" ? env.TWITTERAPI_IO_KEY : undefined,
      maxPages: settings.xMaxPages,
    });
    const unique = dedupeRecords(result.records);
    const collectedAt = new Date().toISOString();
    const translated: Array<typeof unique[number] & { translation: string | null }> = [];
    for (const record of unique) {
      let translation: string | null = null;
      if (settings.translationEnabled && record.text) {
        try {
          translation = await translateToChinese(
            env.AI,
            record.text,
            settings.translationSourceLang,
            settings.translationTargetLang,
          );
        } catch (error) {
          logError("translation failed", error, { dedupeKey: record.dedupeKey });
        }
      }
      translated.push({ ...record, translation });
    }
    const statements: D1PreparedStatement[] = translated.map((record) => env.DB.prepare(
      `INSERT INTO records (
        id, dedupe_key, source, external_id, url, country_id, country_name,
        matched_target_id, matched_target, author_handle, author_name, author_url,
        original_text, published_at, collected_at, translation_zh, run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`,
    ).bind(
      crypto.randomUUID(),
      record.dedupeKey,
      record.source,
      record.externalId,
      record.url,
      country.id,
      country.name,
      record.matchedTargetId,
      record.matchedTarget,
      record.authorHandle,
      record.authorName,
      record.authorUrl,
      record.text,
      record.publishedAt,
      collectedAt,
      record.translation,
      runId,
    ));
    const inserted = await runChunk(env.DB, statements);
    const added = inserted.reduce((sum, item) => sum + (item.meta.changes ?? 0), 0);
    const finishedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE batches SET status = 'done', items_found = ?, calls = ?, finished_at = ?, error = NULL WHERE id = ?`,
      ).bind(unique.length, result.calls, finishedAt, batchId),
      env.DB.prepare(
        "UPDATE runs SET records_added = records_added + ?, batches_done = batches_done + 1 WHERE id = ?",
      ).bind(added, runId),
      env.DB.prepare(
        "INSERT INTO api_usage (id, run_id, source, calls, items, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), runId, batch.source, result.calls, unique.length, finishedAt),
    ]);
    log("batch done", { runId, batchId, source: batch.source, items: unique.length, added });
    await maybeEnqueueFinalize(env, runId);
  } catch (error) {
    if (isRetryable(error)) {
      logError("batch retry", error, { runId, batchId });
      throw error;
    }
    await markBatchFailed(env, runId, batchId, errorMessage(error));
    await maybeEnqueueFinalize(env, runId);
  }
}

async function markBatchFailed(env: Env, runId: string, batchId: string, message: string): Promise<void> {
  const finishedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE batches SET status = 'failed', error = ?, finished_at = ?
     WHERE id = ? AND status NOT IN ('done', 'failed')`,
  ).bind(message.slice(0, 500), finishedAt, batchId).run();
  if ((result.meta.changes ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE runs SET batches_failed = batches_failed + 1 WHERE id = ?",
    ).bind(runId).run();
  }
  logError("batch failed", new Error(message), { runId, batchId });
}

async function maybeEnqueueFinalize(env: Env, runId: string): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS pending FROM batches WHERE run_id = ? AND status IN ('queued', 'running')`,
  ).bind(runId).first<{ pending: number }>();
  const run = await env.DB.prepare("SELECT status FROM runs WHERE id = ?").bind(runId).first<{ status: string }>();
  if ((pending?.pending ?? 0) === 0 && run?.status === "running") {
    await env.COLLECT_QUEUE.send({ type: "finalize", runId, reason: "complete" } satisfies CollectMessage);
  }
}

async function loadExcelRecords(db: D1Database): Promise<{ records: ExcelRecord[]; truncated: boolean }> {
  const newestFirst: ExcelRecord[] = [];
  let offset = 0;
  const pageSize = 1000;
  let truncated = false;
  while (newestFirst.length < MAX_EXCEL_ROWS) {
    const page = await db.prepare(
      `SELECT country_name, original_text, published_at, author_handle, author_name, author_url,
              source, url, matched_target, collected_at, translation_zh
       FROM records ORDER BY collected_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(pageSize, offset).all<RecordRow>();
    if (page.results.length === 0) break;
    for (const row of page.results) {
      if (newestFirst.length >= MAX_EXCEL_ROWS) break;
      newestFirst.push({
        countryName: row.country_name,
        originalText: row.original_text,
        publishedAt: row.published_at ?? "",
        authorHandle: row.author_handle,
        authorName: row.author_name,
        authorUrl: row.author_url,
        source: row.source,
        url: row.url,
        matchedTarget: row.matched_target,
        collectedAt: row.collected_at,
        translationZh: row.translation_zh ?? "",
      });
    }
    offset += page.results.length;
    if (page.results.length < pageSize) break;
    if (newestFirst.length >= MAX_EXCEL_ROWS) {
      const extra = await db.prepare("SELECT id FROM records LIMIT 1 OFFSET ?").bind(MAX_EXCEL_ROWS).first();
      truncated = Boolean(extra);
    }
  }
  return { records: newestFirst.reverse(), truncated };
}

export async function storeExcel(env: Env, settings: AppSettings): Promise<{ bytes: Uint8Array; key: string; truncated: boolean }> {
  const countries = await env.DB.prepare("SELECT name FROM countries ORDER BY name").all<{ name: string }>();
  const loaded = await loadExcelRecords(env.DB);
  const bytes = buildMonitorWorkbook({
    countries: countries.results,
    records: loaded.records,
    reference: new Date(),
    timeZone: settings.timeZone,
  });
  const key = settings.excelKey || env.EXCEL_FILENAME || "skyeyes.xlsx";
  await env.EXPORTS.put(key, bytes, {
    httpMetadata: { contentType: EXCEL_TYPE },
  });
  return { bytes, key, truncated: loaded.truncated };
}

async function sendDigest(
  env: Env,
  settings: AppSettings,
  message: OutboundEmail,
): Promise<{ status: string; error: string | null }> {
  if (!settings.emailEnabled) return { status: "skipped", error: null };
  const recipients = await env.DB.prepare(
    "SELECT email FROM recipients WHERE enabled = 1 ORDER BY email",
  ).all<{ email: string }>();
  const to = recipients.results.map((row) => row.email);
  if (to.length === 0) return { status: "skipped", error: "没有启用的收件人" };
  if (!settings.emailFrom) return { status: "failed", error: "未配置发件人" };
  const outbound = { ...message, from: settings.emailFrom, fromName: settings.emailFromName, to };
  try {
    if (settings.emailProvider === "cloudflare") {
      await sendWithCloudflare(env.EMAIL, outbound);
    } else {
      if (!env.RESEND_API_KEY) return { status: "failed", error: "未配置 RESEND_API_KEY" };
      await sendWithResend(env.RESEND_API_KEY, outbound);
    }
    return { status: "sent", error: null };
  } catch (error) {
    logError("email failed", error);
    return { status: "failed", error: errorMessage(error).slice(0, 500) };
  }
}

export async function finalizeRun(env: Env, runId: string, reason: "complete" | "deadline"): Promise<void> {
  const claim = await env.DB.prepare(
    "UPDATE runs SET status = 'finalizing' WHERE id = ? AND status = 'running'",
  ).bind(runId).run();
  if ((claim.meta.changes ?? 0) === 0) return;

  const settings = await loadSettings(env.DB);
  const run = await env.DB.prepare(
    "SELECT id, status, window_start, window_end, batches_failed FROM runs WHERE id = ?",
  ).bind(runId).first<RunRow>();
  if (!run) return;
  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS pending
     FROM batches WHERE run_id = ?`,
  ).bind(runId).first<{ done: number | null; failed: number | null; pending: number | null }>();
  const failed = counts?.failed ?? 0;
  const pending = counts?.pending ?? 0;
  const incomplete = reason === "deadline" || failed > 0 || pending > 0;
  let notes = incomplete ? "有批次未完成，已发送目前收集到的内容。" : "";
  let emailStatus = "skipped";
  let emailError: string | null = null;

  try {
    const stored = await storeExcel(env, settings);
    if (stored.truncated) notes = [notes, `Excel 只保留最新 ${MAX_EXCEL_ROWS} 条，更早的记录仍在数据库中。`].filter(Boolean).join(" ");
    const grouped = await env.DB.prepare(
      `SELECT country_name, source, COUNT(*) AS n
       FROM records WHERE run_id = ? GROUP BY country_name, source`,
    ).bind(runId).all<{ country_name: string; source: string; n: number }>();
    const byCountry = new Map<string, { added: number; bySource: Record<string, number> }>();
    for (const row of grouped.results) {
      const current = byCountry.get(row.country_name) ?? { added: 0, bySource: {} };
      current.added += row.n;
      current.bySource[row.source] = row.n;
      byCountry.set(row.country_name, current);
    }
    const downloadUrl = settings.appBaseUrl ? `${settings.appBaseUrl}/api/export/excel` : null;
    const attached = stored.bytes.byteLength <= ATTACHMENT_LIMIT_BYTES;
    const digest = buildDigest({
      incomplete,
      windowStart: run.window_start,
      windowEnd: run.window_end,
      timeZone: settings.timeZone,
      countries: [...byCountry.entries()].map(([name, value]) => ({ name, ...value })),
      failedBatches: failed,
      downloadUrl,
      attached,
      notes,
    });
    const sent = await sendDigest(env, settings, {
      from: settings.emailFrom,
      fromName: settings.emailFromName,
      to: [],
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
      attachment: attached
        ? { filename: stored.key.split("/").pop() || "skyeyes.xlsx", content: stored.bytes, contentType: EXCEL_TYPE }
        : undefined,
    });
    emailStatus = sent.status;
    emailError = sent.error;
  } catch (error) {
    logError("finalize failed", error, { runId });
    emailStatus = "failed";
    emailError = errorMessage(error).slice(0, 500);
    notes = [notes, "收尾时生成 Excel 或发送邮件失败。"].filter(Boolean).join(" ");
  }

  await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, batches_done = ?, batches_failed = ?,
         email_status = ?, email_error = ?, notes = ?
     WHERE id = ?`,
  ).bind(
    incomplete || emailStatus === "failed" ? "incomplete" : "completed",
    new Date().toISOString(),
    counts?.done ?? 0,
    failed,
    emailStatus,
    emailError,
    notes || null,
    runId,
  ).run();
  log("run finalized", { runId, reason, incomplete, emailStatus });
}

export async function handleDeadLetter(env: Env, message: CollectMessage): Promise<void> {
  if (message.type === "batch") {
    await markBatchFailed(env, message.runId, message.batchId, "超过队列重试次数");
    await maybeEnqueueFinalize(env, message.runId);
    return;
  }
  await finalizeRun(env, message.runId, message.reason);
}

export async function finalizeOverdue(env: Env, now: Date): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM runs WHERE status = 'running' AND deadline_at <= ?",
  ).bind(now.toISOString()).all<{ id: string }>();
  for (const row of rows.results) {
    await finalizeRun(env, row.id, "deadline");
  }
}
