import { buildOrQuery, chunk, matchTargetNames, planCountryBatches } from "./batching";
import { providerPlans, readConfig, type AppConfig } from "./config";
import { buildMonitoringWorkbook, workbookToUint8Array } from "./excel";
import { createDownloadSignature, downloadUrl } from "./download";
import {
  bumpAttempt,
  claimFinalize,
  completeBatch,
  countIncompleteBatches,
  countNewByCountry,
  countRecords,
  countRecordsOnDate,
  countUntranslatedOnDate,
  failBatch,
  findLatestRunForDate,
  finishRun,
  getBatch,
  getCountryById,
  getRun,
  insertBatches,
  insertRecord,
  insertRun,
  listActiveRecipientEmails,
  listActiveTargets,
  listCountries,
  listPendingBatches,
  listRecordsForExport,
  listRunsForDeadline,
  listTargetsByIds,
  listUntranslated,
  noteBatchError,
  releaseFinalize,
  setExpectedBatches,
  setTranslation,
  type BatchRow,
  type RecordRow,
} from "./db";
import { chunkRecipients } from "./email/encode";
import { createEmailProvider } from "./email";
import type { EmailAttachment } from "./email/types";
import { ProviderError } from "./errors";
import { log } from "./log";
import { parseQueueMessage } from "./messages";
import { createProvider } from "./providers";
import type { SearchHit } from "./providers/types";
import { renderDailySummary } from "./summary";
import { collectionWindow, formatInShanghai, type TimeWindow } from "./time-window";
import { aiRunner, translateToChinese } from "./translate";

const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const QUEUE_SEND_CHUNK = 50;

export interface StartRunResult {
  runId: string;
  batches: number;
  skipped: boolean;
  reason?: string;
  window: { start: string; end: string; collectedDate: string };
}

export type HandlerResult = "ok" | "missing" | "busy";

function windowPayload(timeWindow: TimeWindow): StartRunResult["window"] {
  return {
    start: timeWindow.start.toISOString(),
    end: timeWindow.end.toISOString(),
    collectedDate: timeWindow.collectedDate,
  };
}

function parseIdList(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is number => typeof item === "number" && Number.isInteger(item));
  } catch {
    return [];
  }
}

function dedupeKey(source: string, externalId: string, url: string): string {
  const id = externalId.trim() || url.trim();
  return `${source}:${id}`.slice(0, 1000);
}

async function enqueueCollect(env: Env, runId: string, batchIds: readonly string[]): Promise<void> {
  for (const group of chunk(batchIds, QUEUE_SEND_CHUNK)) {
    await env.COLLECT_QUEUE.sendBatch(group.map((batchId) => ({ body: { type: "collect", runId, batchId } })));
  }
}

async function maybeEnqueueFinalize(env: Env, runId: string): Promise<void> {
  const run = await getRun(env, runId);
  if (!run || run.status !== "collecting") return;
  if (run.expected_batches <= 0) return;
  if (run.completed_batches + run.failed_batches < run.expected_batches) return;
  await env.COLLECT_QUEUE.send({ type: "finalize", runId, reason: "complete" });
}

export async function startRun(env: Env, options: { force: boolean; now?: Date }): Promise<StartRunResult> {
  const now = options.now ?? new Date();
  const timeWindow = collectionWindow(now);
  const config = readConfig(env);
  const existing = await findLatestRunForDate(env, timeWindow.collectedDate);
  if (existing && !options.force) {
    return {
      runId: existing.id,
      batches: existing.expected_batches,
      skipped: true,
      reason: "该收集日已有运行记录",
      window: {
        start: existing.window_start,
        end: existing.window_end,
        collectedDate: existing.collected_date,
      },
    };
  }

  const runId = crypto.randomUUID();
  const nowIso = now.toISOString();
  await insertRun(env, {
    id: runId,
    collectedDate: timeWindow.collectedDate,
    windowStart: timeWindow.start.toISOString(),
    windowEnd: timeWindow.end.toISOString(),
    now: nowIso,
  });

  const countries = await listCountries(env);
  const countryTargets = [];
  for (const country of countries) {
    const targets = await listActiveTargets(env, country.id);
    countryTargets.push({ id: country.id, targets: targets.map((target) => ({ id: target.id, query: target.query })) });
  }
  const planned = planCountryBatches(countryTargets, providerPlans(config), {
    maxTerms: config.batchMaxTerms,
    maxQueryChars: config.batchMaxQueryChars,
  }, () => crypto.randomUUID());

  await insertBatches(env, runId, planned, nowIso);
  await setExpectedBatches(env, runId, planned.length);

  if (planned.length === 0) {
    await finalizeRun(env, runId);
    return { runId, batches: 0, skipped: false, window: windowPayload(timeWindow) };
  }

  await enqueueCollect(env, runId, planned.map((batch) => batch.id));
  await env.COLLECT_QUEUE.send(
    { type: "finalize", runId, reason: "deadline" },
    { delaySeconds: config.finalizeDelaySeconds },
  );
  log("info", "采集任务已入队", { runId, batches: planned.length });
  return { runId, batches: planned.length, skipped: false, window: windowPayload(timeWindow) };
}

export async function requeueRun(env: Env, runId: string): Promise<number> {
  const pending = await listPendingBatches(env, runId);
  await enqueueCollect(env, runId, pending.map((batch) => batch.id));
  return pending.length;
}

export async function deadlineSweep(env: Env, now = new Date()): Promise<{ finalized: number }> {
  const config = readConfig(env);
  const createdBefore = new Date(now.getTime() - config.deadlineMinAgeSeconds * 1000).toISOString();
  const leaseExpiredBefore = new Date(now.getTime() - config.finalizeLeaseSeconds * 1000).toISOString();
  const ids = await listRunsForDeadline(env, createdBefore, leaseExpiredBefore);
  let finalized = 0;
  for (const runId of ids) {
    const outcome = await finalizeRun(env, runId, now);
    if (outcome === "ok") finalized += 1;
  }
  return { finalized };
}

export async function handleQueueMessage(env: Env, body: unknown): Promise<HandlerResult> {
  const message = parseQueueMessage(body);
  if (!message) return "missing";
  if (message.type === "finalize") return finalizeRun(env, message.runId);
  return processCollect(env, message.runId, message.batchId);
}

export async function handleDeadLetter(env: Env, body: unknown): Promise<void> {
  const message = parseQueueMessage(body);
  if (!message) return;
  if (message.type === "collect") {
    const failed = await failBatch(env, message.batchId, message.runId, "dead_letter", new Date().toISOString());
    if (failed) await maybeEnqueueFinalize(env, message.runId);
    log("error", "批次进入死信队列", { runId: message.runId, batchId: message.batchId });
    return;
  }
  const outcome = await finalizeRun(env, message.runId);
  if (outcome === "busy") throw new Error("finalize_busy");
}

async function processCollect(env: Env, runId: string, batchId: string): Promise<HandlerResult> {
  const batch = await getBatch(env, batchId);
  if (!batch || batch.run_id !== runId) return "missing";
  if (batch.status !== "pending") return "ok";
  const run = await getRun(env, runId);
  if (!run) return "missing";

  await bumpAttempt(env, batchId);
  const config = readConfig(env);
  try {
    const country = await getCountryById(env, batch.country_id);
    if (!country) {
      await failBatch(env, batchId, runId, "missing_country", new Date().toISOString());
      await maybeEnqueueFinalize(env, runId);
      return "ok";
    }
    const ids = parseIdList(batch.target_ids);
    const loaded = await listTargetsByIds(env, ids);
    const byId = new Map(loaded.map((target) => [target.id, target]));
    const targets = ids.flatMap((id) => {
      const target = byId.get(id);
      return target ? [target] : [];
    });
    if (targets.length === 0) {
      await completeBatch(env, batchId, runId, new Date().toISOString());
      await maybeEnqueueFinalize(env, runId);
      return "ok";
    }

    const provider = createProvider(env, config, batch.provider_id);
    const hits = await provider.search({
      orQuery: buildOrQuery(targets.map((target) => target.query)),
      windowStart: new Date(run.window_start),
      windowEnd: new Date(run.window_end),
    });
    const inserted = await storeHits(env, batch, country, targets, hits, run.collected_date, runId);
    await translateInserted(env, config, inserted);
    await completeBatch(env, batchId, runId, new Date().toISOString());
    await maybeEnqueueFinalize(env, runId);
    log("info", "批次采集完成", { runId, batchId, source: batch.source, hits: hits.length, inserted: inserted.length });
    return "ok";
  } catch (error) {
    if (error instanceof ProviderError && !error.retryable) {
      await failBatch(env, batchId, runId, error.code, new Date().toISOString());
      await maybeEnqueueFinalize(env, runId);
      log("error", "批次失败且不再重试", { runId, batchId, error: error.code });
      return "ok";
    }
    const code = error instanceof ProviderError ? error.code : "fetch_failed";
    await noteBatchError(env, batchId, code);
    throw error;
  }
}

async function storeHits(
  env: Env,
  batch: BatchRow,
  country: { id: number; code: string; name: string },
  targets: { name: string; query: string }[],
  hits: SearchHit[],
  collectedDate: string,
  runId: string,
): Promise<{ id: number; text: string; lang: string | null }[]> {
  const inserted: { id: number; text: string; lang: string | null }[] = [];
  const now = new Date().toISOString();
  for (const hit of hits) {
    if (!hit.url) continue;
    const matched = matchTargetNames([hit.text, hit.authorName, hit.authorHandle].join("\n"), targets) || country.name;
    const id = await insertRecord(
      env,
      {
        dedupeKey: dedupeKey(batch.source, hit.externalId, hit.url),
        source: batch.source,
        externalId: hit.externalId,
        url: hit.url,
        originalText: hit.text,
        publishedAt: hit.publishedAt,
        authorHandle: hit.authorHandle,
        authorName: hit.authorName,
        authorUrl: hit.authorUrl,
        countryId: country.id,
        countryCode: country.code,
        countryName: country.name,
        matchedTarget: matched,
        collectedDate,
        runId,
        lang: hit.lang,
      },
      now,
    );
    if (id !== null) inserted.push({ id, text: hit.text, lang: hit.lang });
  }
  return inserted;
}

async function translateInserted(
  env: Env,
  config: AppConfig,
  rows: readonly { id: number; text: string; lang: string | null }[],
): Promise<void> {
  const runner = aiRunner(env.AI);
  const models = { primary: config.translationModel, fallback: config.translationFallbackModel };
  const limited = rows.slice(0, config.maxTranslationsPerBatch);
  for (const row of limited) {
    const translated = await translateToChinese(runner, row.text, row.lang, models);
    if (translated !== null) await setTranslation(env, row.id, translated);
  }
}

function toExcelRecord(row: RecordRow) {
  return {
    countryCode: row.country_code,
    countryName: row.country_name,
    source: row.source,
    url: row.url,
    originalText: row.original_text,
    publishedAt: row.published_at ?? "",
    authorHandle: row.author_handle ?? "",
    authorName: row.author_name ?? "",
    authorUrl: row.author_url ?? "",
    matchedTarget: row.matched_target,
    collectedDate: row.collected_date,
    translationZh: row.translation_zh ?? "",
  };
}

export async function finalizeRun(env: Env, runId: string, now = new Date()): Promise<HandlerResult> {
  const run = await getRun(env, runId);
  if (!run) return "missing";
  if (run.status === "completed" || run.status === "partial") return "ok";

  const config = readConfig(env);
  const nowIso = now.toISOString();
  const leaseExpiredBefore = new Date(now.getTime() - config.finalizeLeaseSeconds * 1000).toISOString();
  const claimed = await claimFinalize(env, runId, nowIso, leaseExpiredBefore);
  if (!claimed) return "busy";

  try {
    await backfillTranslations(env, config);
    const totalRecords = await countRecords(env);
    const exported = await listRecordsForExport(env, config.maxExcelRows);
    const countries = await listCountries(env);
    const workbook = buildMonitoringWorkbook(
      exported.map(toExcelRecord),
      countries.map((country) => ({ code: country.code, name: country.name })),
      { today: run.collected_date, yesterday: collectionWindow(new Date(run.window_end)).yesterdayDate },
    );
    const bytes = workbookToUint8Array(workbook);
    await env.EXPORTS.put(config.excelObjectKey, bytes, {
      httpMetadata: { contentType: EXCEL_MIME },
    });

    const incomplete = await countIncompleteBatches(env, runId);
    const notes: string[] = [];
    if (incomplete > 0) {
      notes.push(`有 ${incomplete} 个批次在汇总时尚未完成。晚到的记录仍会入库，并出现在之后重新生成的 Excel 中。`);
    }
    if (totalRecords > exported.length) {
      notes.push(`历史记录共 ${totalRecords} 条，本次 Excel 只包含最近 ${exported.length} 条。`);
    }

    const counts = await countNewByCountry(env, run.collected_date);
    const download = await signedDownload(env, config, now);
    const emailProvider = createEmailProvider(env, config);
    let attached = false;
    let attachment: EmailAttachment | undefined;
    if (bytes.byteLength <= emailProvider.maxAttachmentBytes) {
      attached = true;
      attachment = { filename: config.excelObjectKey, contentType: EXCEL_MIME, bytes };
    } else {
      notes.push(`Excel 约 ${bytes.byteLength} 字节，超过当前邮件通道的附件上限，请使用下载链接。`);
    }

    const rendered = renderDailySummary({
      collectedDate: run.collected_date,
      windowLabel: `${formatInShanghai(new Date(run.window_start))} 至 ${formatInShanghai(new Date(run.window_end))}（北京时间，不含结束时刻）`,
      partial: incomplete > 0,
      incompleteBatches: incomplete,
      newRecords: await countRecordsOnDate(env, run.collected_date),
      untranslated: await countUntranslatedOnDate(env, run.collected_date),
      countries: counts.map((row) => ({
        countryName: row.name,
        xCount: Number(row.x_count) || 0,
        webCount: Number(row.web_count) || 0,
      })),
      downloadUrl: download,
      attached,
      excelName: config.excelObjectKey,
      notes,
    });

    const recipients = await listActiveRecipientEmails(env);
    if (recipients.length === 0) {
      notes.push("没有收件人，已更新 Excel，未发送邮件。");
    } else if (!config.emailFrom.includes("@")) {
      notes.push("未配置有效的 EMAIL_FROM，已更新 Excel，未发送邮件。");
    } else {
      for (const to of chunkRecipients(recipients, 40)) {
        await emailProvider.send({
          to,
          from: config.emailFrom,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          attachment,
        });
      }
    }

    const finalNotes = notes.length > 0 ? notes : ["全部批次已完成。"];
    await finishRun(env, runId, incomplete > 0 ? "partial" : "completed", finalNotes.join("\n"), new Date().toISOString());
    log("info", "汇总完成", { runId, partial: incomplete > 0, rows: exported.length, attached });
    return "ok";
  } catch (error) {
    await releaseFinalize(env, runId);
    log("error", "汇总失败", { runId, error: error instanceof Error ? error.message : "unknown" });
    throw error;
  }
}

async function backfillTranslations(env: Env, config: AppConfig): Promise<void> {
  const rows = await listUntranslated(env, config.maxTranslationsOnFinalize);
  const runner = aiRunner(env.AI);
  const models = { primary: config.translationModel, fallback: config.translationFallbackModel };
  for (const row of rows) {
    const translated = await translateToChinese(runner, row.original_text, row.lang, models);
    if (translated !== null) await setTranslation(env, row.id, translated);
  }
}

async function signedDownload(env: Env, config: AppConfig, now: Date): Promise<string | null> {
  if (!config.publicBaseUrl) return null;
  const exp = Math.floor(now.getTime() / 1000) + config.downloadTtlSeconds;
  const signature = await createDownloadSignature(env.ADMIN_TOKEN, config.excelObjectKey, exp);
  return downloadUrl(config.publicBaseUrl, config.excelObjectKey, exp, signature);
}
