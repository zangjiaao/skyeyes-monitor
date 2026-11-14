import { recordRunEvent } from "./events";
import { queryCount } from "./query-plan";
import { loadSettings, type AppSettings } from "../config/settings";
import { splitLines } from "../domain/terms";
import { dedupeRecords } from "../domain/dedupe";
import {
  DELIVERABLE_SQL,
  decideAdmission,
  isRepublish,
  normalizeTitle,
  ruleRejectReason,
  titlePrefix,
  urlKeyFor,
  type ExistingIdentity,
  type FilterRules,
} from "../domain/gate";
import type { BatchResume, CollectedRecord, QueryTarget, SearchDiagnostic, SourceId, TargetKind } from "../domain/types";
import { SOURCE_IDS } from "../domain/types";
import { buildDigest, type DigestCountry } from "../email/compose";
import { emailBuckets, scopeLabel, type EmailGroup } from "../email/delivery";
import { attachmentMode, recordEmailLog } from "../email/log";
import { sendWithCloudflare } from "../email/cloudflare";
import { sendWithResend } from "../email/resend";
import { ATTACHMENT_LIMIT_BYTES, type OutboundEmail } from "../email/types";
import { buildMonitorWorkbook, type ExcelRecord } from "../export/excel";
import { runWindowDownloadPath, runWindowFilename, runWindowObjectKey } from "../export/run-file";
import { errorMessage, log, logError, logWarn } from "../log";
import { getProvider } from "../sources/registry";
import { RateLimitError } from "../sources/x";
import { GDELT_RATE_SLOT, GOOGLE_NEWS_RATE_SLOT, recordRateEvent, tryReserveSlot, tryReserveXSlot } from "../sources/x-rate";
import { interpretRecord } from "../ai/interpret";
import { findSimilarRecords } from "../records/similar";
import { translationCell } from "../translate";
import type { CollectMessage } from "./messages";
import {
  COORDINATOR_GATE_DELAY_SEC,
  COORDINATOR_WALL_MS,
  COORDINATOR_WALL_RESERVE_MS,
  DeferredBatchError,
  LEASE_MS,
  MAX_BATCH_ATTEMPTS,
  MAX_DEFER_COUNT,
  MAX_DEFER_WAIT_SEC,
  FINALIZING_GRACE_MS,
  RECOVERABLE_RUN_STATUSES,
  STALE_ENQUEUE_MS,
  batchWakeup,
} from "./lease";
import { pacing } from "./pacing";
import {
  beginSourceFetch,
  interpretReservation,
  SubrequestBudget,
  SubrequestBudgetError,
} from "./subrequest-budget";
import {
  enqueueInChunks,
  enqueueRunStatus,
  firstQueuePage,
  NOT_ENQUEUED_ERROR,
  STUCK_BATCH_GRACE_MS,
} from "./queue-batch";

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
  terms: string;
  exclude_terms: string;
  case_sensitive: number;
  enabled: number;
  description?: string;
  match_mode?: "phrase" | "all_words";
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
  attempts: number;
  resume_json?: string | null;
  defer_count?: number | null;
}

class BatchLostError extends Error {
  constructor() {
    super("批次租约已失效");
    this.name = "BatchLostError";
  }
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
  matched_term: string;
  collected_at: string;
  translation_zh: string | null;
  translation_status: string | null;
  translation_error: string | null;
  relevance_score: number | null;
  ai_summary: string | null;
}

async function runChunk(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (let index = 0; index < statements.length; index += 40) {
    const chunk = statements.slice(index, index + 40);
    results.push(...await db.batch(chunk));
  }
  return results;
}

function rulesFromSettings(settings: AppSettings): FilterRules {
  return {
    minTextLength: settings.minTextLength,
    excludeWords: settings.excludeWords,
    blockedAccounts: settings.blockedAccounts,
    minFollowers: settings.minFollowers,
    minAccountAgeDays: settings.minAccountAgeDays,
    excludeRetweets: settings.excludeRetweets,
    excludeAds: settings.excludeAds,
  };
}

function toQueryTarget(target: TargetRow): QueryTarget {
  const listed = splitLines(target.terms);
  const terms = listed.length > 0 ? listed : splitLines(target.query);
  return {
    id: target.id,
    kind: target.kind,
    name: target.name,
    query: terms[0] ?? target.query,
    terms,
    excludeTerms: splitLines(target.exclude_terms),
    caseSensitive: target.case_sensitive === 1,
    description: target.description ?? "",
    matchMode: target.match_mode ?? "phrase",
  };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof DeferredBatchError) return true;
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /限流|429|\b[45]\d\d\b|network|ECONN|fetch failed|未配置 TWITTERAPI_IO_KEY|Unexpected token|JSON/i.test(error.message);
}

export class ActiveRunError extends Error {
  readonly activeRunId: string;

  constructor(activeRunId: string) {
    super("已有运行进行中");
    this.name = "ActiveRunError";
    this.activeRunId = activeRunId;
  }
}

const ACTIVE_ENQUEUE_STATUSES = ["running", "partial", "failed"];

interface EnqueueCounts {
  sent: number;
  failed: number;
  pending: number;
}

export interface EnqueuePageResult {
  enqueued: number;
  failed: number;
  pending: number;
  warning: string | null;
}

function batchQueueMessage(runId: string, batchId: string): MessageSendRequest<CollectMessage> {
  return batchWakeup(runId, batchId);
}

async function enqueueCounts(db: D1Database, runId: string): Promise<EnqueueCounts> {
  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('queued', 'running', 'done') AND enqueued_at IS NOT NULL AND enqueued_at NOT LIKE 'claim:%' THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'queued' AND (enqueued_at IS NULL OR enqueued_at LIKE 'claim:%') THEN 1 ELSE 0 END) AS pending
     FROM batches WHERE run_id = ?`,
  ).bind(runId).first<{ sent: number | null; failed: number | null; pending: number | null }>();
  return {
    sent: counts?.sent ?? 0,
    failed: counts?.failed ?? 0,
    pending: counts?.pending ?? 0,
  };
}

async function syncRunEnqueueState(env: Env, runId: string, warning: string | null): Promise<EnqueueCounts> {
  const counts = await enqueueCounts(env.DB, runId);
  const current = await env.DB.prepare("SELECT status, notes FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string; notes: string | null }>();
  if (!current || current.status === "cancelled" || !ACTIVE_ENQUEUE_STATUSES.includes(current.status)) return counts;
  const status = enqueueRunStatus(counts);
  let notes = warning ?? current.notes;
  const enqueueNote = notes?.startsWith("未入队") || notes?.startsWith("还有批次没有写入队列");
  if (counts.failed === 0 && counts.pending === 0 && enqueueNote) notes = null;
  const finishedAt = status === "failed" ? new Date().toISOString() : null;
  await env.DB.prepare(
    `UPDATE runs
     SET status = ?, notes = ?, batches_failed = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
     WHERE id = ? AND status IN ('running', 'partial', 'failed')`,
  ).bind(status, notes, counts.failed, status, finishedAt, runId).run();
  return counts;
}

async function claimBatches(db: D1Database, runId: string, ids: string[], token: string): Promise<{ id: string; batch_index: number }[]> {
  for (let index = 0; index < ids.length; index += 80) {
    const slice = ids.slice(index, index + 80);
    const marks = slice.map(() => "?").join(",");
    await db.prepare(
      `UPDATE batches SET enqueued_at = ?
       WHERE run_id = ? AND status = 'queued' AND enqueued_at IS NULL AND id IN (${marks})`,
    ).bind(token, runId, ...slice).run();
  }
  const claimed = await db.prepare(
    "SELECT id, batch_index FROM batches WHERE run_id = ? AND enqueued_at = ? ORDER BY batch_index",
  ).bind(runId, token).all<{ id: string; batch_index: number }>();
  return claimed.results;
}

export async function continueEnqueue(
  env: Env,
  runId: string,
  options: { createdBefore?: string } = {},
): Promise<EnqueuePageResult> {
  const run = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string }>();
  if (!run || !ACTIVE_ENQUEUE_STATUSES.includes(run.status)) {
    return { enqueued: 0, failed: 0, pending: 0, warning: null };
  }
  const selected = options.createdBefore
    ? await env.DB.prepare(
      `SELECT id, batch_index FROM batches
       WHERE run_id = ? AND status = 'queued' AND enqueued_at IS NULL AND created_at <= ?
       ORDER BY batch_index LIMIT 100`,
    ).bind(runId, options.createdBefore).all<{ id: string; batch_index: number }>()
    : await env.DB.prepare(
      `SELECT id, batch_index FROM batches
       WHERE run_id = ? AND status = 'queued' AND enqueued_at IS NULL
       ORDER BY batch_index LIMIT 100`,
    ).bind(runId).all<{ id: string; batch_index: number }>();
  const candidates = selected.results.map((row) => batchQueueMessage(runId, row.id));
  const page = firstQueuePage(candidates).page;
  if (page.length === 0) {
    const counts = await syncRunEnqueueState(env, runId, null);
    return { enqueued: 0, failed: 0, pending: counts.pending, warning: null };
  }
  const token = `claim:${new Date().toISOString()}:${crypto.randomUUID()}`;
  const ids = page.map((message) => message.body.type === "batch" ? message.body.batchId : "");
  const claimed = await claimBatches(env.DB, runId, ids.filter(Boolean), token);
  if (claimed.length === 0) {
    const counts = await enqueueCounts(env.DB, runId);
    return { enqueued: 0, failed: 0, pending: counts.pending, warning: null };
  }
  const messages = claimed.map((row) => batchQueueMessage(runId, row.id));
  const sentPage = await enqueueInChunks(env.COLLECT_QUEUE, messages);
  let warning = sentPage.error;
  if (sentPage.error) {
    logError("enqueue page failed", new Error(sentPage.error), { runId, batches: claimed.length });
    const finishedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE batches
       SET status = 'failed', enqueued_at = NULL, error = ?, finished_at = ?
       WHERE enqueued_at = ?`,
    ).bind(sentPage.error, finishedAt, token).run();
  } else {
    await env.DB.prepare("UPDATE batches SET enqueued_at = ? WHERE enqueued_at = ?")
      .bind(new Date().toISOString(), token)
      .run();
  }
  const counts = await syncRunEnqueueState(env, runId, warning);
  if (counts.pending > 0) {
    const follow = await enqueueInChunks(env.COLLECT_QUEUE, [{ body: { type: "enqueue", runId } }]);
    if (follow.error) {
      logError("enqueue continuation failed", new Error(follow.error), { runId, pending: counts.pending });
      warning = warning ?? "还有批次没有写入队列。下次定时运行或状态页的「重新入队」会继续发送。";
      await syncRunEnqueueState(env, runId, warning);
    }
  }
  return {
    enqueued: sentPage.sent.length,
    failed: sentPage.failed.length,
    pending: counts.pending,
    warning,
  };
}

const RECOVERABLE_SQL = RECOVERABLE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

export async function requeueStuckBatches(env: Env, options: {
  now?: Date;
  runId?: string;
  minAgeMs?: number;
  includeFailed?: boolean;
  force?: boolean;
} = {}): Promise<{ runs: number; batches: number; warning: string | null }> {
  const now = options.now ?? new Date();
  const force = options.force === true;
  const minAgeMs = options.minAgeMs ?? 0;
  const createdBefore = new Date(now.getTime() - minAgeMs).toISOString();
  const staleBefore = new Date(now.getTime() - STALE_ENQUEUE_MS).toISOString();
  const claimCutoff = new Date(now.getTime() - STUCK_BATCH_GRACE_MS).toISOString();
  const nowIso = now.toISOString();
  const scope = options.runId ? "AND run_id = ?" : "";
  const scopeBinds = options.runId ? [options.runId] : [];
  const recoverable = `run_id IN (SELECT id FROM runs WHERE status IN (${RECOVERABLE_SQL}))`;
  await env.DB.prepare(
    `UPDATE batches SET enqueued_at = NULL
     WHERE status = 'queued' AND enqueued_at LIKE 'claim:%' AND enqueued_at < ? ${scope}`,
  ).bind(`claim:${claimCutoff}`, ...scopeBinds).run();
  await env.DB.prepare(
    `UPDATE batches
     SET status = 'failed', error = '超过重试次数', finished_at = ?, lease_token = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND attempts >= ?
       AND (? = 1 OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND ${recoverable} ${scope}`,
  ).bind(nowIso, MAX_BATCH_ATTEMPTS, force ? 1 : 0, nowIso, ...scopeBinds).run();
  await env.DB.prepare(
    `UPDATE batches
     SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, enqueued_at = NULL
     WHERE status = 'running' AND attempts < ?
       AND (? = 1 OR lease_expires_at IS NULL OR lease_expires_at <= ?)
       AND ${recoverable} ${scope}`,
  ).bind(MAX_BATCH_ATTEMPTS, force ? 1 : 0, nowIso, ...scopeBinds).run();
  if (options.includeFailed) {
    await env.DB.prepare(
      `UPDATE batches
       SET status = 'queued', error = NULL, finished_at = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE status = 'failed' AND error LIKE '未入队：%' AND ${recoverable} ${scope}`,
    ).bind(...scopeBinds).run();
  }
  await env.DB.prepare(
    `UPDATE batches SET enqueued_at = NULL
     WHERE status = 'queued' AND enqueued_at IS NOT NULL
       AND (? = 1 OR enqueued_at <= ?)
       AND (? = 1 OR next_wake_at IS NULL OR next_wake_at <= ?)
       AND ${recoverable} ${scope}`,
  ).bind(force ? 1 : 0, staleBefore, force ? 1 : 0, nowIso, ...scopeBinds).run();
  const runs = await env.DB.prepare(
    `SELECT DISTINCT run_id FROM batches
     WHERE status = 'queued' AND enqueued_at IS NULL AND (? = 1 OR created_at <= ?)
       AND (? = 1 OR next_wake_at IS NULL OR next_wake_at <= ?)
       AND run_id IN (SELECT id FROM runs WHERE status IN (${RECOVERABLE_SQL})) ${scope}`,
  ).bind(force ? 1 : 0, createdBefore, force ? 1 : 0, nowIso, ...scopeBinds).all<{ run_id: string }>();
  let batches = 0;
  let warning: string | null = null;
  for (const row of runs.results) {
    const current = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(row.run_id)
      .first<{ status: string }>();
    // `incomplete` already finished (and may already have emailed). Reopening it
    // makes the next hour deadline-finalize again and can stick on `finalizing`.
    if (!current || current.status === "cancelled" || current.status === "completed" || current.status === "finalizing" || current.status === "incomplete") {
      continue;
    }
    if (current.status === "failed") {
      await env.DB.prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ? AND status = 'failed'",
      ).bind(row.run_id).run();
    }
    const page = await continueEnqueue(env, row.run_id, !force && minAgeMs > 0 ? { createdBefore } : {});
    batches += page.enqueued;
    warning = warning ?? page.warning;
  }
  return { runs: runs.results.length, batches, warning };
}

export async function cancelRun(env: Env, runId: string): Promise<{ cancelledBatches: number }> {
  const current = await env.DB.prepare("SELECT id, status FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ id: string; status: string }>();
  if (!current) throw new Error("运行不存在");
  if (current.status === "completed") {
    throw new Error("这次运行已经结束");
  }
  const now = new Date().toISOString();
  if (current.status !== "cancelled") {
    await env.DB.prepare(
      `UPDATE runs SET status = 'cancelled', finished_at = ?, notes = '已取消', batches_failed = (
         SELECT COUNT(*) FROM batches WHERE run_id = ? AND status = 'failed'
       ) WHERE id = ? AND status NOT IN ('completed', 'cancelled')`,
    ).bind(now, runId, runId).run();
  }
  const cancelled = await env.DB.prepare(
    `UPDATE batches
     SET status = 'cancelled', error = '已取消', finished_at = ?, lease_token = NULL, lease_expires_at = NULL
     WHERE run_id = ? AND status IN ('queued', 'running')`,
  ).bind(now, runId).run();
  await recordRunEvent(env.DB, { runId, type: "run cancelled", details: { cancelledBatches: cancelled.meta.changes ?? 0 } });
  return { cancelledBatches: cancelled.meta.changes ?? 0 };
}

async function findActiveRun(db: D1Database): Promise<{ id: string; status: string } | null> {
  return db.prepare(
    "SELECT id, status FROM runs WHERE status IN ('running', 'partial', 'finalizing') ORDER BY started_at DESC LIMIT 1",
  ).first<{ id: string; status: string }>();
}

export class RunScopeError extends Error {}

export function parseRunCountryIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000
    || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 80)) {
    throw new RunScopeError("请选择至少一个有效分组；全量运行请省略 countryIds");
  }
  return [...new Set(value.map((id: string) => id.trim()))];
}

export async function startRun(env: Env, input: {
  trigger: "schedule" | "manual";
  now: Date;
  slotKey: string;
  windowStart: Date;
  windowEnd: Date;
  confirm?: boolean;
  countryIds?: string[];
}): Promise<{ runId: string; created: boolean; batches: number; enqueued: number; warning: string | null }> {
  const countryIds = parseRunCountryIds(input.countryIds);
  let scopedCountries: CountryRow[] | undefined;
  let scopedTargets: TargetRow[] | undefined;
  if (countryIds) {
    if (input.trigger !== "manual") throw new RunScopeError("只有手动运行可以指定分组");
    const enabled = await env.DB.prepare(
      "SELECT id, name, code, enabled FROM countries WHERE enabled = 1 ORDER BY name",
    ).all<CountryRow>();
    scopedCountries = enabled.results.filter((country) => countryIds.includes(country.id));
    if (scopedCountries.length !== countryIds.length) throw new RunScopeError("所选分组不存在或已停用，请刷新后重新选择");
    scopedTargets = [];
    for (const country of scopedCountries) {
      const targets = await env.DB.prepare(
        `SELECT id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, enabled, description, match_mode
         FROM targets WHERE country_id = ? AND enabled = 1 ORDER BY name`,
      ).bind(country.id).all<TargetRow>();
      if (targets.results.length === 0) throw new RunScopeError(`分组「${country.name}」没有启用的目标`);
      scopedTargets.push(...targets.results);
    }
  }
  // Validate scope before cancelling an active run or creating a new one.
  const active = await findActiveRun(env.DB);
  if (active) {
    if (!input.confirm) throw new ActiveRunError(active.id);
    if (active.status === "finalizing") throw new Error("有运行正在收尾，请稍后再开始");
    await cancelRun(env, active.id);
  }
  const settings = await loadSettings(env.DB);
  const runId = crypto.randomUUID();
  const slotKey = input.trigger === "manual" ? `manual-${runId}` : input.slotKey;
  const startedAt = input.now.toISOString();
  // First insurance check. A run that is still collecting has this pushed forward
  // instead of being cancelled. The next scheduled slot closes it so the new day can start.
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
      return { runId: existing.id, created: false, batches: 0, enqueued: 0, warning: null };
    }
    throw error;
  }

  const countries = scopedCountries ? { results: scopedCountries } : await env.DB.prepare(
    "SELECT id, name, code, enabled FROM countries WHERE enabled = 1 ORDER BY name",
  ).all<CountryRow>();
  const targetRows: TargetRow[] = [];
  for (const country of countries.results) {
    const targets = scopedTargets ? { results: scopedTargets.filter((target) => target.country_id === country.id) } : await env.DB.prepare(
      `SELECT id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, enabled, description, match_mode
       FROM targets WHERE country_id = ? AND enabled = 1 ORDER BY name`,
    ).bind(country.id).all<TargetRow>();
    targetRows.push(...targets.results);
    log("run group planned", {
      runId, countryId: country.id, countryName: country.name,
      targetCount: targets.results.length,
      termCount: targets.results.reduce((sum, target) => sum + (toQueryTarget(target).terms?.length ?? 0), 0),
      sources: SOURCE_IDS.filter((source) => settings.sources[source]),
    });
  }
  const inserts: D1PreparedStatement[] = [];
  const messages: MessageSendRequest<CollectMessage>[] = [];
  if (targetRows.length > 0) {
    const targetIds = JSON.stringify(targetRows.map((target) => target.id));
    for (const source of SOURCE_IDS) {
      if (!settings.sources[source]) continue;
      const batchId = crypto.randomUUID();
      inserts.push(env.DB.prepare(
        `INSERT INTO batches (
          id, run_id, country_id, source, batch_index, target_ids, status, created_at, queries_total
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).bind(
        batchId,
        runId,
        "",
        source,
        messages.length,
        targetIds,
        startedAt,
        queryCount(source, targetRows.map(toQueryTarget), settings.googleNewsEditions),
      ));
      messages.push(batchQueueMessage(runId, batchId));
    }
  }

  await env.DB.prepare("UPDATE runs SET scope_json = ? WHERE id = ?").bind(JSON.stringify({
    mode: countryIds ? "selected" : "all",
    countries: countries.results.map((country) => ({ id: country.id, name: country.name })),
    targetCount: targetRows.length,
  }), runId).run();
  if (inserts.length > 0) await runChunk(env.DB, inserts);
  await env.DB.prepare("UPDATE runs SET batches_total = ? WHERE id = ?").bind(messages.length, runId).run();
  log("run started", {
    runId, trigger: input.trigger, batches: messages.length,
    groupCount: countries.results.length, targetCount: targetRows.length,
    countryIds: countryIds ?? null,
    windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(), deadlineAt,
  });
  await recordRunEvent(env.DB, { runId, type: "run started", details: {
    trigger: input.trigger, targetCount: targetRows.length, groupCount: countries.results.length,
    countryIds: countryIds ?? null, windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(),
  } });
  if (messages.length === 0) {
    await finalizeRun(env, runId, "complete");
    return { runId, created: true, batches: 0, enqueued: 0, warning: null };
  }
  const page = await continueEnqueue(env, runId);
  return { runId, created: true, batches: messages.length, enqueued: page.enqueued, warning: page.warning };
}

async function loadTargets(db: D1Database, ids: string[]): Promise<TargetRow[]> {
  if (ids.length === 0) return [];
  const rows: TargetRow[] = [];
  for (let index = 0; index < ids.length; index += 80) {
    const slice = ids.slice(index, index + 80);
    const marks = slice.map(() => "?").join(",");
    const result = await db.prepare(
      `SELECT id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, enabled, description, match_mode
       FROM targets WHERE id IN (${marks})`,
    ).bind(...slice).all<TargetRow>();
    rows.push(...result.results);
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  return rows;
}

async function loadCountries(db: D1Database, ids: string[]): Promise<CountryRow[]> {
  const unique = [...new Set(ids)];
  const rows: CountryRow[] = [];
  for (let index = 0; index < unique.length; index += 80) {
    const slice = unique.slice(index, index + 80);
    const marks = slice.map(() => "?").join(",");
    const result = await db.prepare(
      `SELECT id, name, code, enabled FROM countries WHERE id IN (${marks})`,
    ).bind(...slice).all<CountryRow>();
    rows.push(...result.results);
  }
  return rows;
}

export async function claimBatch(
  env: Env,
  runId: string,
  batchId: string,
  now = new Date(),
): Promise<{ token: string } | null> {
  const token = crypto.randomUUID();
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE batches
     SET status = 'running', lease_token = ?, lease_expires_at = ?, next_wake_at = NULL
     WHERE id = ? AND run_id = ? AND attempts < ?
       AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)))`,
  ).bind(token, lease, batchId, runId, MAX_BATCH_ATTEMPTS, now.toISOString()).run();
  if ((result.meta.changes ?? 0) === 0) {
    await env.DB.prepare(
      `UPDATE batches
       SET status = 'failed', error = '超过重试次数', finished_at = ?, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ? AND run_id = ? AND attempts >= ? AND status IN ('queued', 'running')
         AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).bind(now.toISOString(), batchId, runId, MAX_BATCH_ATTEMPTS, now.toISOString()).run();
    return null;
  }
  return { token };
}

async function releaseClaim(env: Env, batchId: string, token: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE batches
     SET status = 'queued', lease_token = NULL, lease_expires_at = NULL
     WHERE id = ? AND lease_token = ? AND status = 'running'`,
  ).bind(batchId, token).run();
  return (result.meta.changes ?? 0) > 0;
}

function runHasStoppedCollecting(status: string): boolean {
  return status === "cancelled" || status === "completed" || status === "incomplete" || status === "finalizing";
}

async function ownsBatch(env: Env, batchId: string, token: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT b.status AS batch_status, b.lease_token, r.status AS run_status
     FROM batches b JOIN runs r ON r.id = b.run_id WHERE b.id = ?`,
  ).bind(batchId).first<{ batch_status: string; lease_token: string | null; run_status: string }>();
  return row?.batch_status === "running"
    && row.lease_token === token
    && !runHasStoppedCollecting(row.run_status);
}

async function renewLease(env: Env, batchId: string, token: string, now = new Date()): Promise<boolean> {
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE batches SET lease_expires_at = ?
     WHERE id = ? AND lease_token = ? AND status = 'running'
       AND EXISTS (
         SELECT 1 FROM runs
         WHERE runs.id = batches.run_id AND runs.status IN ('running', 'partial', 'failed')
       )`,
  ).bind(lease, batchId, token).run();
  return (result.meta.changes ?? 0) > 0;
}

async function cancelOpenBatches(
  env: Env,
  runId: string,
  error: string,
  options: { batchId?: string; now?: Date } = {},
): Promise<number> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const result = options.batchId
    ? await env.DB.prepare(
      `UPDATE batches
       SET status = 'cancelled', error = ?, finished_at = ?, lease_token = NULL, lease_expires_at = NULL
       WHERE run_id = ? AND id = ? AND status IN ('queued', 'running')`,
    ).bind(error, nowIso, runId, options.batchId).run()
    : await env.DB.prepare(
      `UPDATE batches
       SET status = 'cancelled', error = ?, finished_at = ?, lease_token = NULL, lease_expires_at = NULL
       WHERE run_id = ? AND status IN ('queued', 'running')`,
    ).bind(error, nowIso, runId).run();
  return result.meta.changes ?? 0;
}

async function storeCollected(env: Env, input: {
  run: RunRow;
  runId: string;
  batchId: string;
  leaseToken: string;
  country: CountryRow;
  countryFor: (targetId: string | null | undefined) => CountryRow;
  targets: TargetRow[];
  settings: AppSettings;
  records: CollectedRecord[];
  budget: SubrequestBudget;
  reservation: number;
  yieldNow?: () => boolean;
}): Promise<{
  reasons: Record<string, number>;
  inserted: number;
  storeOnly: number;
  unprocessed: number;
  added: number;
  filtered: number;
  deduped: number;
  relevanceFailures: number;
  deferred: boolean;
  deferReason: "budget" | "wall" | null;
} | null> {
  const unique = dedupeRecords(input.records);
  const fetched = input.records.length;
  let deduped = fetched - unique.length;
  let filtered = 0;
  const reasons: Record<string, number> = {};
  const countReason = (reason: string, count = 1) => {
    if (count > 0) reasons[reason] = (reasons[reason] ?? 0) + count;
  };
  countReason("page_duplicate_or_invalid", deduped);
  let processed = 0;
  const collectedAt = new Date().toISOString();
  const window = { start: new Date(input.run.window_start), end: new Date(input.run.window_end) };
  const rules = rulesFromSettings(input.settings);
  const accepted: ExistingIdentity[] = [];
  let relevanceFailures = 0;
  let deferred = false;
  let deferReason: "budget" | "wall" | null = null;
  const charge = () => input.budget.charge();
  const kept: Array<CollectedRecord & {
    translation: string | null;
    translationStatus: string | null;
    translationError: string | null;
    detectedLang: string | null;
    relevanceScore: number | null;
    relevanceError: string | null;
    aiSummary: string;
    aiReason: string;
    aiEventType: string;
    aiMentions: string;
    aiProvider: string;
    timeStatus: string;
    excludeReason: string | null;
    titleKey: string;
    urlKey: string;
  }> = [];
  for (const record of unique) {
    if (input.yieldNow?.()) {
      deferred = true;
      deferReason = "wall";
      break;
    }
    processed += 1;
    if (!record.matchedTargetId || !record.matchedTerm?.trim()) {
      filtered += 1;
      countReason("missing_attribution");
      continue;
    }
    try {
      const titleKey = normalizeTitle(record.text);
      const urlKey = urlKeyFor(record.url);
      const ruleReason = ruleRejectReason(record, rules, new Date(collectedAt));
      const timeOnly = decideAdmission({
        publishedAt: record.publishedAt,
        window,
        ruleReason: null,
        republish: false,
        relevanceEnabled: false,
        relevanceScore: null,
        relevanceThreshold: input.settings.relevanceThreshold,
      });
      if (timeOnly.timeStatus === "out_of_window" || ruleReason) {
        countReason(timeOnly.timeStatus === "out_of_window" ? "time:out_of_window" : ruleReason!);
        filtered += 1;
        continue;
      }
      let republish = false;
      if (timeOnly.timeStatus === "in_window") {
        let existing: ExistingIdentity[] = [];
        try {
          existing = await findSimilarRecords(env.DB, urlKey, titleKey);
        } catch (error) {
          logError("dedupe lookup failed", error, { runId: input.runId, batchId: input.batchId, url: record.url });
        }
        republish = isRepublish({ urlKey, titleKey }, [...existing, ...accepted]);
        if (republish) {
          deduped += 1;
          countReason("global_duplicate");
          continue;
        }
      }
      let translation: string | null = null;
      let translationStatus: string | null = null;
      let translationError: string | null = null;
      let detectedLang: string | null = record.sourceLang ?? null;
      let relevanceScore: number | null = null;
      let relevanceError: string | null = null;
      let relevant: boolean | null = null;
      let aiSummary = "";
      let aiReason = "";
      let aiEventType = "";
      let aiMentions = "";
      let aiProvider = "";
      const shouldInterpret = timeOnly.timeStatus === "in_window"
        && record.text
        && (input.settings.aiEnabled || input.settings.translationEnabled || input.settings.relevanceEnabled);
      if (shouldInterpret && input.reservation > 0 && input.budget.remaining < input.reservation) {
        processed -= 1;
        deferred = true;
        deferReason = "budget";
        break;
      }
      if (shouldInterpret) {
        if (!(await renewLease(env, input.batchId, input.leaseToken))) return null;
        const target = input.targets.find((item) => item.id === record.matchedTargetId);
        const terms = splitLines(target?.terms || target?.query || record.matchedTerm || "");
        const outcome = await interpretRecord({
          ai: env.AI,
          apiKey: env.DEEPSEEK_API_KEY || "",
          settings: input.settings,
          text: record.text,
          hintedLang: record.sourceLang,
          targetName: record.matchedTarget,
          terms,
          description: target?.description ?? "",
          matchMode: target?.match_mode ?? "phrase",
          fetchImpl: globalThis.fetch.bind(globalThis),
          charge,
        });
        translation = outcome.translation;
        translationStatus = outcome.translationStatus;
        translationError = outcome.translationError;
        detectedLang = outcome.sourceLang;
        relevanceScore = outcome.score;
        relevanceError = outcome.relevanceError;
        relevant = outcome.relevant;
        aiSummary = outcome.summary;
        aiReason = outcome.reason;
        aiEventType = outcome.eventType;
        aiMentions = outcome.mentions;
        aiProvider = outcome.provider;
        if (outcome.translationStatus === "translation_failed") {
          logError("translation failed", new Error(outcome.translationError || "翻译失败"), { dedupeKey: record.dedupeKey });
        }
        if (outcome.relevanceError) {
          relevanceFailures += 1;
          logError("relevance score failed", new Error(outcome.relevanceError), { dedupeKey: record.dedupeKey });
        }
      }
      const admission = decideAdmission({
        publishedAt: record.publishedAt,
        window,
        ruleReason,
        republish,
        relevanceEnabled: input.settings.relevanceEnabled,
        relevanceScore,
        relevanceThreshold: input.settings.relevanceThreshold,
        relevant,
      });
      if (admission.action === "drop") {
        countReason(admission.excludeReason ?? "admission_drop");
        filtered += 1;
        continue;
      }
      if (admission.timeStatus === "in_window") {
        accepted.push({ urlKey, titleKey, publishedAt: record.publishedAt });
      }
      kept.push({
        ...record,
        translation,
        translationStatus,
        translationError,
        detectedLang,
        relevanceScore,
        relevanceError,
        aiSummary,
        aiReason,
        aiEventType,
        aiMentions,
        aiProvider,
        timeStatus: admission.timeStatus,
        excludeReason: admission.excludeReason,
        titleKey,
        urlKey,
      });
    } catch (error) {
      if (error instanceof DeferredBatchError) {
        processed -= 1;
        deferred = true;
        deferReason = "budget";
        break;
      }
      filtered += 1;
      countReason("record_error");
      logError("record skipped", error, { runId: input.runId, batchId: input.batchId, url: record.url });
    }
  }
  const statements: D1PreparedStatement[] = kept.map((record) => {
    const owner = input.countryFor(record.matchedTargetId);
    return env.DB.prepare(
    `INSERT INTO records (
      id, dedupe_key, source, external_id, url, country_id, country_name,
      matched_target_id, matched_target, matched_term, author_handle, author_name, author_url,
      original_text, published_at, collected_at, translation_zh, translation_status, translation_error, source_lang, news_edition,
      ai_summary, ai_reason, ai_event_type, ai_mentions, ai_provider, run_id,
      title_key, title_prefix, url_key, time_status, relevance_score, relevance_error, exclude_reason, is_spam,
      author_followers, author_created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    record.dedupeKey,
    record.source,
    record.externalId,
    record.url,
    owner.id,
    owner.name,
    record.matchedTargetId,
    record.matchedTarget,
    record.matchedTerm ?? "",
    record.authorHandle,
    record.authorName,
    record.authorUrl,
    record.text,
    record.publishedAt,
    collectedAt,
    record.translation,
    record.translationStatus,
    record.translationError,
    record.detectedLang,
    record.newsEdition ?? null,
    record.aiSummary || null,
    record.aiReason || null,
    record.aiEventType || null,
    record.aiMentions || null,
    record.aiProvider || null,
    input.runId,
    record.titleKey,
    titlePrefix(record.titleKey),
    record.urlKey,
    record.timeStatus,
    record.relevanceScore,
    record.relevanceError,
    record.excludeReason,
    record.authorFollowers ?? null,
    record.authorCreatedAt ?? null,
  );
  });
  if (!(await ownsBatch(env, input.batchId, input.leaseToken))) return null;
  const inserted = await runChunk(env.DB, statements);
  const added = inserted.reduce((sum, item, index) => {
    if (kept[index]?.excludeReason) return sum;
    return sum + (item.meta.changes ?? 0);
  }, 0);
  let insertedCount = 0;
  let storeOnly = 0;
  inserted.forEach((item, index) => {
    const changes = item.meta.changes ?? 0;
    insertedCount += changes;
    if (changes === 0) countReason("insert_conflict");
    else if (kept[index]?.excludeReason) {
      storeOnly += changes;
      countReason(kept[index].excludeReason!, changes);
    }
  });
  return {
    added, filtered, deduped, relevanceFailures, deferred, deferReason,
    reasons, inserted: insertedCount, storeOnly, unprocessed: unique.length - processed,
  };
}

function parseResume(raw: string | null | undefined, source: SourceId): BatchResume | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as BatchResume;
    if (!value || value.source !== source || !Number.isInteger(value.step) || value.step < 0) return null;
    return {
      source,
      step: value.step,
      page: Number.isInteger(value.page) && value.page > 0 ? value.page : 0,
      cursor: typeof value.cursor === "string" ? value.cursor : "",
    };
  } catch {
    return null;
  }
}

async function paceSource(env: Env, source: SourceId, settings: AppSettings, inlineLimitMs: number, onWait?: (waitMs: number) => Promise<void>): Promise<void> {
  const inline = Math.max(0, Math.floor(inlineLimitMs));
  const now = pacing.now();
  if (source === "x") {
    const slot = await tryReserveXSlot(env.DB, settings.xQps, inline, now);
    if (!slot.ok) throw new DeferredBatchError(Math.max(1, Math.ceil(slot.waitMs / 1000)), "等待 X 请求间隔");
    if (slot.waitMs > 0) { await onWait?.(slot.waitMs); await pacing.sleep(slot.waitMs); }
    return;
  }
  const intervalSec = source === "gdelt"
    ? settings.gdeltMinIntervalSec
    : source === "google_news"
      ? settings.googleNewsMinIntervalSec
      : 0;
  if (intervalSec <= 0) return;
  const name = source === "gdelt" ? GDELT_RATE_SLOT : GOOGLE_NEWS_RATE_SLOT;
  const slot = await tryReserveSlot(env.DB, name, intervalSec * 1000, inline, now);
  if (!slot.ok) throw new DeferredBatchError(Math.max(1, Math.ceil(slot.waitMs / 1000)), `等待 ${source} 请求间隔`);
  if (slot.waitMs > 0) { await onWait?.(slot.waitMs); await pacing.sleep(slot.waitMs); }
}

export async function scheduleDeferredWake(
  env: Env,
  runId: string,
  batchId: string,
  token: string | null,
  delaySeconds: number,
  rate?: RateLimitError,
  deferReason?: string,
): Promise<void> {
  const run = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ status: string }>();
  if (!run || runHasStoppedCollecting(run.status)) {
    if (run) {
      await cancelOpenBatches(env, runId, run.status === "cancelled" ? "已取消" : "运行已结束", { batchId });
    }
    return;
  }
  const delay = Math.max(1, Math.floor(delaySeconds));
  if (token) {
    const released = await releaseClaim(env, batchId, token);
    if (!released) return;
    await env.DB.prepare(
      "UPDATE batches SET attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END WHERE id = ? AND status = 'queued'",
    ).bind(batchId).run();
  }
  const wakeAt = new Date(Date.now() + delay * 1000).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE batches
     SET defer_count = defer_count + 1,
         defer_wait_sec = defer_wait_sec + ?,
         next_wake_at = ?,
         status = CASE WHEN status = 'running' THEN 'queued' ELSE status END,
         lease_token = NULL,
         lease_expires_at = NULL
     WHERE id = ? AND run_id = ? AND status IN ('queued', 'running')
     RETURNING defer_count, defer_wait_sec`,
  ).bind(delay, wakeAt, batchId, runId).first<{ defer_count: number; defer_wait_sec: number }>();
  if (!updated) return;
  if (rate && !rate.recorded) {
    try {
      await recordRateEvent(env.DB, {
        source: rate.message.startsWith("GDELT") ? "gdelt" : rate.message.startsWith("Google") ? "google_news" : "x",
        status: 429,
        retryAfterSeconds: rate.retryAfterSeconds,
        delaySeconds: delay,
      });
    } catch (error) {
      logError("rate event failed", error, { runId, batchId });
    }
  }
  if (updated.defer_count > MAX_DEFER_COUNT || updated.defer_wait_sec > MAX_DEFER_WAIT_SEC) {
    await markBatchFailed(env, runId, batchId, `等待过久（${updated.defer_count} 次，累计 ${updated.defer_wait_sec} 秒）`);
    await maybeEnqueueFinalize(env, runId);
    return;
  }
  logWarn("batch deferred", { runId, batchId, delaySeconds: delay, deferCount: updated.defer_count });
  await recordRunEvent(env.DB, { runId, batchId, type: "batch deferred", details: {
    delaySeconds: delay, deferCount: updated.defer_count, wakeAt,
    reason: rate?.message ?? deferReason ?? "等待续跑",
  } });
  try {
    await env.COLLECT_QUEUE.send({ type: "batch", runId, batchId }, { delaySeconds: delay });
    await env.DB.prepare(
      "UPDATE batches SET enqueued_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(new Date().toISOString(), batchId).run();
  } catch (error) {
    logError("deferred wake failed", error, { runId, batchId });
  }
}

export async function processBatch(env: Env, runId: string, batchId: string): Promise<void> {
  const batch = await env.DB.prepare(
    "SELECT id, run_id, country_id, source, target_ids, status, attempts, resume_json, defer_count FROM batches WHERE id = ?",
  ).bind(batchId).first<BatchRow>();
  if (!batch || batch.run_id !== runId || batch.status === "done" || batch.status === "failed" || batch.status === "cancelled") return;
  const run = await env.DB.prepare(
    "SELECT id, status, window_start, window_end, batches_failed FROM runs WHERE id = ?",
  ).bind(runId).first<RunRow>();
  if (!run || runHasStoppedCollecting(run.status)) {
    if (run) {
      await cancelOpenBatches(
        env,
        runId,
        run.status === "cancelled" ? "已取消" : "运行已结束",
        { batchId },
      );
    }
    return;
  }

  let token: string | null = null;
  try {
    const settings = await loadSettings(env.DB);
    const budget = new SubrequestBudget(settings.subrequestBudget);
    const reservation = interpretReservation(settings, Boolean(env.DEEPSEEK_API_KEY?.trim()));
    const running = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM batches WHERE status = 'running'",
    ).first<{ n: number }>();
    if ((running?.n ?? 0) >= settings.queueConcurrency) throw new DeferredBatchError(COORDINATOR_GATE_DELAY_SEC, "达到采集并发上限，等待其他来源释放槽位");
    const claimed = await claimBatch(env, runId, batchId);
    if (!claimed) return;
    token = claimed.token;
    const leaseToken = claimed.token;
    const startedMs = pacing.now();
    await env.DB.prepare(
      "UPDATE batches SET attempts = attempts + 1 WHERE id = ? AND lease_token = ? AND status = 'running'",
    ).bind(batchId, leaseToken).run();
    const ids = JSON.parse(batch.target_ids) as string[];
    const targets = await loadTargets(env.DB, ids);
    if (targets.length === 0) throw new Error("分组不存在");
    const countries = await loadCountries(env.DB, targets.map((target) => target.country_id));
    const countryByTarget = new Map<string, CountryRow>();
    for (const target of targets) {
      const found = countries.find((item) => item.id === target.country_id);
      if (!found) throw new Error("分组不存在");
      countryByTarget.set(target.id, found);
    }
    const countryFor = (targetId: string | null | undefined): CountryRow => {
      const found = targetId ? countryByTarget.get(targetId) : undefined;
      if (!found) throw new Error("分组不存在");
      return found;
    };
    const country = countryFor(targets[0]?.id);
    const provider = getProvider(batch.source);
    const yieldNow = () => pacing.now() - startedMs >= COORDINATOR_WALL_MS - COORDINATOR_WALL_RESERVE_MS;
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const diagnosticOwner = (targetId: string | undefined) => {
      const target = targetId ? targetById.get(targetId) : undefined;
      const owner = targetId ? countryByTarget.get(targetId) : undefined;
      return { countryId: owner?.id, countryName: owner?.name, targetName: target?.name };
    };
    log("batch started", {
      runId, batchId, source: batch.source, targetCount: targets.length,
      resumeStep: parseResume(batch.resume_json, batch.source)?.step ?? 0,
      resumePage: parseResume(batch.resume_json, batch.source)?.page ?? 0,
      windowStart: run.window_start, windowEnd: run.window_end,
    });
    await recordRunEvent(env.DB, { runId, batchId, source: batch.source, type: "batch started", details: {
      resumeStep: parseResume(batch.resume_json, batch.source)?.step ?? 0,
      resumePage: parseResume(batch.resume_json, batch.source)?.page ?? 0,
    } });
    let checkpointFound = 0;
    let checkpointAdded = 0;
    let checkpointFiltered = 0;
    let checkpointDeduped = 0;
    let seenProviderFiltered = 0;
    let seenCalls = 0;
    const onDiagnostic = async (diagnostic: SearchDiagnostic) => {
      const details = { ...diagnosticOwner(diagnostic.targetId), ...diagnostic };
      const type = `source query ${diagnostic.event}`;
      log(type, { runId, batchId, source: batch.source, ...details });
      await recordRunEvent(env.DB, { runId, batchId, source: batch.source, type, details });
    };
    const result = await provider.search({
      onDiagnostic,
      targets: targets.map(toQueryTarget),
      window: { start: new Date(run.window_start), end: new Date(run.window_end) },
      countryName: country.name,
      // Workers 里的 fetch 必须绑定 globalThis，否则会报 Illegal invocation。
      fetchImpl: globalThis.fetch.bind(globalThis),
      apiKey: batch.source === "x" ? env.TWITTERAPI_IO_KEY : undefined,
      maxPages: settings.xMaxPages,
      excludeRetweets: settings.excludeRetweets,
      googleNewsEditions: settings.googleNewsEditions,
      queueAttempt: (batch.defer_count ?? 0) + 1,
      resume: parseResume(batch.resume_json, batch.source),
      beforeRequest: async (context) => {
        const remaining = COORDINATOR_WALL_MS - (pacing.now() - startedMs);
        if (remaining < COORDINATOR_WALL_RESERVE_MS) throw new DeferredBatchError(1, "本次执行时间接近上限，保存进度后续跑");
        if (!(await renewLease(env, batchId, leaseToken))) throw new BatchLostError();
        beginSourceFetch(budget, reservation);
        await paceSource(env, batch.source, settings, remaining - COORDINATOR_WALL_RESERVE_MS, async (waitMs) => {
          if (context) await onDiagnostic({ ...context, event: "wait", delaySeconds: waitMs / 1000, reason: `等待 ${batch.source} 请求间隔` });
        });
      },
      onRateLimit: async (info) => {
        await recordRateEvent(env.DB, { source: batch.source, ...info });
      },
      onPage: async (page) => {
        const stored = await storeCollected(env, {
          run, runId, batchId, leaseToken, country, countryFor, targets, settings, records: page.records,
          budget, reservation, yieldNow,
        });
        if (!stored) throw new BatchLostError();
        const providerFiltered = Math.max(0, page.filtered - seenProviderFiltered);
        seenProviderFiltered = page.filtered;
        const callDelta = Math.max(0, page.calls - seenCalls);
        seenCalls = page.calls;
        const saved = await env.DB.prepare(
          `UPDATE batches
           SET resume_json = ?, calls = calls + ?,
               items_found = items_found + ?,
               items_fetched = items_fetched + ?,
               items_deduped = items_deduped + ?,
               items_filtered = items_filtered + ?,
               items_added = items_added + ?
           WHERE id = ? AND lease_token = ? AND status = 'running'`,
        ).bind(
          JSON.stringify(stored.deferred ? (page.repeatResume ?? page.resume) : page.resume),
          callDelta,
          page.records.length,
          page.records.length,
          stored.deduped,
          stored.filtered + providerFiltered,
          stored.added,
          batchId,
          leaseToken,
        ).run();
        if ((saved.meta.changes ?? 0) === 0) throw new BatchLostError();
        if (callDelta > 0) {
          await env.DB.prepare(
            "INSERT INTO api_usage (id, run_id, source, calls, items, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).bind(crypto.randomUUID(), runId, batch.source, callDelta, page.records.length, new Date().toISOString()).run();
        }
        if (stored.added > 0 || stored.relevanceFailures > 0) {
          await env.DB.prepare(
            `UPDATE runs SET records_added = records_added + ?, relevance_failed = relevance_failed + ?
             WHERE id = ? AND status NOT IN ('cancelled')`,
          ).bind(stored.added, stored.relevanceFailures, runId).run();
        }
        const nextResume = stored.deferred ? (page.repeatResume ?? page.resume) : page.resume;
        const pageDetails = {
          ...diagnosticOwner(page.diagnostic?.targetId), ...page.diagnostic,
          matchedItems: page.records.length, inserted: stored.inserted,
          added: stored.added, storeOnly: stored.storeOnly, deduped: stored.deduped,
          filtered: stored.filtered, providerFiltered, reasons: stored.reasons,
          unprocessed: stored.unprocessed, deferred: stored.deferred, deferReason: stored.deferReason,
          nextStep: nextResume.step, nextPage: nextResume.page,
        };
        log("source page stored", { runId, batchId, source: batch.source, ...pageDetails });
        await recordRunEvent(env.DB, { runId, batchId, source: batch.source, type: "source page stored", details: pageDetails });
        checkpointAdded += stored.added;
        checkpointFiltered += stored.filtered + providerFiltered;
        checkpointDeduped += stored.deduped;
        checkpointFound += page.records.length;
        if (stored.deferred) {
          throw stored.deferReason === "wall" ? new DeferredBatchError(1, "本次执行时间接近上限，保存进度后续跑") : new SubrequestBudgetError();
        }
      },
    });
    const unique = dedupeRecords(result.records);
    const fetched = result.records.length;
    let deduped = fetched - unique.length;
    let filtered = 0;
    const collectedAt = new Date().toISOString();
    const window = { start: new Date(run.window_start), end: new Date(run.window_end) };
    const rules = rulesFromSettings(settings);
    const accepted: ExistingIdentity[] = [];
    let relevanceFailures = 0;
    let budgetDeferred = false;
    const kept: Array<CollectedRecord & {
      translation: string | null;
      translationStatus: string | null;
      translationError: string | null;
      detectedLang: string | null;
      relevanceScore: number | null;
      relevanceError: string | null;
      aiSummary: string;
      aiReason: string;
      aiEventType: string;
      aiMentions: string;
      aiProvider: string;
      timeStatus: string;
      excludeReason: string | null;
      titleKey: string;
      urlKey: string;
    }> = [];
    for (const record of unique) {
      if (!record.matchedTargetId || !record.matchedTerm?.trim()) {
        filtered += 1;
        continue;
      }
      try {
      const titleKey = normalizeTitle(record.text);
      const urlKey = urlKeyFor(record.url);
      const ruleReason = ruleRejectReason(record, rules, new Date(collectedAt));
      const timeOnly = decideAdmission({
        publishedAt: record.publishedAt,
        window,
        ruleReason: null,
        republish: false,
        relevanceEnabled: false,
        relevanceScore: null,
        relevanceThreshold: settings.relevanceThreshold,
      });
      if (timeOnly.timeStatus === "out_of_window" || ruleReason) {
        filtered += 1;
        continue;
      }
      let republish = false;
      if (timeOnly.timeStatus === "in_window") {
        // 比对失败也不能丢掉这条。已删除的行仍参与链接和标题比对。
        let existing: ExistingIdentity[] = [];
        try {
          existing = await findSimilarRecords(env.DB, urlKey, titleKey);
        } catch (error) {
          logError("dedupe lookup failed", error, { runId, batchId, url: record.url });
        }
        republish = isRepublish({ urlKey, titleKey }, [...existing, ...accepted]);
        if (republish) {
          deduped += 1;
          continue;
        }
      }
      let translation: string | null = null;
      let translationStatus: string | null = null;
      let translationError: string | null = null;
      let detectedLang: string | null = record.sourceLang ?? null;
      let relevanceScore: number | null = null;
      let relevanceError: string | null = null;
      let relevant: boolean | null = null;
      let aiSummary = "";
      let aiReason = "";
      let aiEventType = "";
      let aiMentions = "";
      let aiProvider = "";
      const shouldInterpret = timeOnly.timeStatus === "in_window"
        && record.text
        && (settings.aiEnabled || settings.translationEnabled || settings.relevanceEnabled);
      if (shouldInterpret && reservation > 0 && budget.remaining < reservation) {
        budgetDeferred = true;
        break;
      }
      if (shouldInterpret) {
        if (!(await renewLease(env, batchId, leaseToken))) return;
        const target = targets.find((item) => item.id === record.matchedTargetId);
        const terms = splitLines(target?.terms || target?.query || record.matchedTerm || "");
        const outcome = await interpretRecord({
          ai: env.AI,
          apiKey: env.DEEPSEEK_API_KEY || "",
          settings,
          text: record.text,
          hintedLang: record.sourceLang,
          targetName: record.matchedTarget,
          terms,
          description: target?.description ?? "",
          matchMode: target?.match_mode ?? "phrase",
          fetchImpl: globalThis.fetch.bind(globalThis),
          charge: () => budget.charge(),
        });
        translation = outcome.translation;
        translationStatus = outcome.translationStatus;
        translationError = outcome.translationError;
        detectedLang = outcome.sourceLang;
        relevanceScore = outcome.score;
        relevanceError = outcome.relevanceError;
        relevant = outcome.relevant;
        aiSummary = outcome.summary;
        aiReason = outcome.reason;
        aiEventType = outcome.eventType;
        aiMentions = outcome.mentions;
        aiProvider = outcome.provider;
        if (outcome.translationStatus === "translation_failed") {
          logError("translation failed", new Error(outcome.translationError || "翻译失败"), { dedupeKey: record.dedupeKey });
        }
        if (outcome.relevanceError) {
          relevanceFailures += 1;
          logError("relevance score failed", new Error(outcome.relevanceError), { dedupeKey: record.dedupeKey });
        }
      }
      const admission = decideAdmission({
        publishedAt: record.publishedAt,
        window,
        ruleReason,
        republish,
        relevanceEnabled: settings.relevanceEnabled,
        relevanceScore,
        relevanceThreshold: settings.relevanceThreshold,
        relevant,
      });
      if (admission.action === "drop") {
        filtered += 1;
        continue;
      }
      if (admission.timeStatus === "in_window") {
        accepted.push({ urlKey, titleKey, publishedAt: record.publishedAt });
      }
      kept.push({
        ...record,
        translation,
        translationStatus,
        translationError,
        detectedLang,
        relevanceScore,
        relevanceError,
        aiSummary,
        aiReason,
        aiEventType,
        aiMentions,
        aiProvider,
        timeStatus: admission.timeStatus,
        excludeReason: admission.excludeReason,
        titleKey,
        urlKey,
      });
      } catch (error) {
        if (error instanceof DeferredBatchError) {
          budgetDeferred = true;
          break;
        }
        filtered += 1;
        logError("record skipped", error, { runId, batchId, url: record.url });
      }
    }
    const statements: D1PreparedStatement[] = kept.map((record) => env.DB.prepare(
      `INSERT INTO records (
        id, dedupe_key, source, external_id, url, country_id, country_name,
        matched_target_id, matched_target, matched_term, author_handle, author_name, author_url,
        original_text, published_at, collected_at, translation_zh, translation_status, translation_error, source_lang, news_edition,
        ai_summary, ai_reason, ai_event_type, ai_mentions, ai_provider, run_id,
        title_key, title_prefix, url_key, time_status, relevance_score, relevance_error, exclude_reason, is_spam,
        author_followers, author_created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
      record.matchedTerm ?? "",
      record.authorHandle,
      record.authorName,
      record.authorUrl,
      record.text,
      record.publishedAt,
      collectedAt,
      record.translation,
      record.translationStatus,
      record.translationError,
      record.detectedLang,
      record.newsEdition ?? null,
      record.aiSummary || null,
      record.aiReason || null,
      record.aiEventType || null,
      record.aiMentions || null,
      record.aiProvider || null,
      runId,
      record.titleKey,
      titlePrefix(record.titleKey),
      record.urlKey,
      record.timeStatus,
      record.relevanceScore,
      record.relevanceError,
      record.excludeReason,
      record.authorFollowers ?? null,
      record.authorCreatedAt ?? null,
    ));
    if (!(await ownsBatch(env, batchId, leaseToken))) return;
    const inserted = await runChunk(env.DB, statements);
    const added = inserted.reduce((sum, item, index) => {
      if (kept[index]?.excludeReason) return sum;
      return sum + (item.meta.changes ?? 0);
    }, 0);
    if (budgetDeferred) throw new SubrequestBudgetError();
    const finishedAt = new Date().toISOString();
    const done = await env.DB.prepare(
      `UPDATE batches
       SET status = 'done', items_found = items_found + ?, finished_at = ?, error = NULL,
           items_fetched = items_fetched + ?, items_deduped = items_deduped + ?,
           items_filtered = items_filtered + ?, items_added = items_added + ?,
           lease_token = NULL, lease_expires_at = NULL, resume_json = NULL, next_wake_at = NULL
       WHERE id = ? AND lease_token = ? AND status = 'running'`,
    ).bind(
      unique.length,
      finishedAt,
      fetched,
      deduped,
      filtered,
      added,
      batchId,
      leaseToken,
    ).run();
    if ((done.meta.changes ?? 0) === 0) return;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE runs SET records_added = records_added + ?, batches_done = batches_done + 1,
           relevance_failed = relevance_failed + ? WHERE id = ? AND status NOT IN ('cancelled')`,
      ).bind(added, relevanceFailures, runId),
      env.DB.prepare(
        "INSERT INTO api_usage (id, run_id, source, calls, items, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), runId, batch.source, Math.max(0, result.calls - seenCalls), unique.length, finishedAt),
    ]);
    log("batch done", {
      runId,
      batchId,
      source: batch.source,
      scope: "invocation",
      items: checkpointFound + unique.length,
      added: checkpointAdded + added,
      filtered: checkpointFiltered + filtered,
      deduped: checkpointDeduped + deduped,
      relevanceFailed: relevanceFailures,
    });
    await recordRunEvent(env.DB, { runId, batchId, source: batch.source, type: "batch done" });
    await maybeEnqueueFinalize(env, runId);
  } catch (error) {
    if (error instanceof BatchLostError) return;
    if (error instanceof DeferredBatchError || error instanceof RateLimitError) {
      await scheduleDeferredWake(
        env,
        runId,
        batchId,
        token,
        error.delaySeconds,
        error instanceof RateLimitError ? error : undefined,
        error.message,
      );
      return;
    }
    if (isRetryable(error)) {
      if (token) {
        const released = await releaseClaim(env, batchId, token);
        if (!released) return;
      }
      logError("batch retry", error, { runId, batchId });
      await recordRunEvent(env.DB, { runId, batchId, source: batch.source, type: "batch retry", details: { error: errorMessage(error) } });
      throw error;
    }
    if (token && !(await ownsBatch(env, batchId, token))) return;
    await markBatchFailed(env, runId, batchId, errorMessage(error));
    await maybeEnqueueFinalize(env, runId);
  }
}

async function markBatchFailed(env: Env, runId: string, batchId: string, message: string): Promise<void> {
  const finishedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE batches SET status = 'failed', error = ?, finished_at = ?
     WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
  ).bind(message.slice(0, 500), finishedAt, batchId).run();
  if ((result.meta.changes ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE runs SET batches_failed = batches_failed + 1 WHERE id = ?",
    ).bind(runId).run();
  }
  logError("batch failed", new Error(message), { runId, batchId });
  await recordRunEvent(env.DB, { runId, batchId, type: "batch failed", details: { error: message.slice(0, 500) } });
}

export async function maybeEnqueueFinalize(env: Env, runId: string): Promise<void> {
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(
    `UPDATE runs SET finalize_enqueued_at = ?
     WHERE id = ? AND finalize_enqueued_at IS NULL
       AND status IN ('running', 'partial')
       AND (SELECT COUNT(*) FROM batches WHERE run_id = ? AND status IN ('queued', 'running')) = 0`,
  ).bind(now, runId, runId).run();
  if ((claim.meta.changes ?? 0) !== 1) return;
  const follow = await enqueueInChunks(env.COLLECT_QUEUE, [{
    body: { type: "finalize", runId, reason: "complete" },
  }]);
  if (follow.error || follow.sent.length === 0) {
    await env.DB.prepare(
      `UPDATE runs SET finalize_enqueued_at = NULL
       WHERE id = ? AND finalize_enqueued_at = ? AND status IN ('running', 'partial')`,
    ).bind(runId, now).run();
    if (follow.error) logError("finalize enqueue failed", new Error(follow.error), { runId });
  }
}

const EXCEL_COLUMNS = `country_name, original_text, published_at, author_handle, author_name, author_url,
              source, url, matched_target, matched_term, collected_at, translation_zh,
              translation_status, translation_error, relevance_score, ai_summary`;

function toExcelRecord(row: RecordRow): ExcelRecord {
  return {
    countryName: row.country_name,
    originalText: row.original_text,
    publishedAt: row.published_at ?? "",
    authorHandle: row.author_handle,
    authorName: row.author_name,
    authorUrl: row.author_url,
    source: row.source,
    url: row.url,
    matchedTarget: row.matched_target,
    matchedTerm: row.matched_term,
    collectedAt: row.collected_at,
    translationZh: translationCell(row.translation_zh, row.translation_status, row.translation_error),
    relevanceScore: row.relevance_score == null ? "" : String(row.relevance_score),
    summaryZh: row.ai_summary ?? "",
  };
}

async function loadExcelRecords(
  db: D1Database,
  whereSql: string,
  binds: unknown[],
): Promise<{ records: ExcelRecord[]; truncated: boolean }> {
  const newestFirst: ExcelRecord[] = [];
  let offset = 0;
  const pageSize = 1000;
  let truncated = false;
  while (newestFirst.length < MAX_EXCEL_ROWS) {
    const page = await db.prepare(
      `SELECT ${EXCEL_COLUMNS}
       FROM records WHERE ${whereSql}
       ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, pageSize, offset).all<RecordRow>();
    if (page.results.length === 0) break;
    for (const row of page.results) {
      if (newestFirst.length >= MAX_EXCEL_ROWS) break;
      newestFirst.push(toExcelRecord(row));
    }
    offset += page.results.length;
    if (page.results.length < pageSize) break;
    if (newestFirst.length >= MAX_EXCEL_ROWS) {
      const extra = await db.prepare(
        `SELECT id FROM records WHERE ${whereSql} LIMIT 1 OFFSET ?`,
      ).bind(...binds, MAX_EXCEL_ROWS).first();
      truncated = Boolean(extra);
    }
  }
  return { records: newestFirst.reverse(), truncated };
}

export async function storeExcel(env: Env, settings: AppSettings): Promise<{ bytes: Uint8Array; key: string; truncated: boolean }> {
  const countries = await env.DB.prepare("SELECT name FROM countries ORDER BY name").all<{ name: string }>();
  const loaded = await loadExcelRecords(env.DB, DELIVERABLE_SQL, []);
  const bytes = buildMonitorWorkbook({
    countries: countries.results,
    records: loaded.records,
    reference: new Date(),
    timeZone: settings.timeZone,
    scheduleHour: settings.scheduleHour,
    windowHours: settings.windowHours,
  });
  const key = settings.excelKey || env.EXCEL_FILENAME || "skyeyes.xlsx";
  await env.EXPORTS.put(key, bytes, {
    httpMetadata: { contentType: EXCEL_TYPE },
  });
  return { bytes, key, truncated: loaded.truncated };
}

export async function storeRunWindowExcel(
  env: Env,
  settings: AppSettings,
  run: { id: string; windowStart: string; windowEnd: string },
): Promise<{ bytes: Uint8Array | null; key: string; filename: string; truncated: boolean; count: number }> {
  const excelKey = settings.excelKey || env.EXCEL_FILENAME || "skyeyes.xlsx";
  const filename = runWindowFilename(excelKey, run.windowEnd, settings.timeZone);
  const key = runWindowObjectKey(run.id);
  const loaded = await loadExcelRecords(
    env.DB,
    `run_id = ? AND ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ?`,
    [run.id, run.windowStart, run.windowEnd],
  );
  if (loaded.records.length === 0) {
    return { bytes: null, key, filename, truncated: false, count: 0 };
  }
  const countries = await env.DB.prepare("SELECT name FROM countries ORDER BY name").all<{ name: string }>();
  const windowEnd = new Date(run.windowEnd);
  const bytes = buildMonitorWorkbook({
    countries: countries.results,
    records: loaded.records,
    reference: Number.isNaN(windowEnd.getTime()) ? new Date() : windowEnd,
    timeZone: settings.timeZone,
    scheduleHour: settings.scheduleHour,
    windowHours: settings.windowHours,
    periodSheets: false,
  });
  await env.EXPORTS.put(key, bytes, {
    httpMetadata: { contentType: EXCEL_TYPE },
  });
  return { bytes, key, filename, truncated: loaded.truncated, count: loaded.records.length };
}

function scopeCountryIds(scopeJson: string | null): string[] {
  if (!scopeJson) return [];
  try {
    const parsed = JSON.parse(scopeJson) as { countries?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed?.countries)) return [];
    return parsed.countries
      .map((country) => (typeof country?.id === "string" ? country.id : ""))
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

async function loadRunEmailGroups(env: Env, runId: string): Promise<EmailGroup[]> {
  const run = await env.DB.prepare("SELECT scope_json FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ scope_json: string | null }>();
  let ids = scopeCountryIds(run?.scope_json ?? null);
  if (ids.length === 0) {
    const fromBatches = await env.DB.prepare(
      "SELECT DISTINCT country_id AS id FROM batches WHERE run_id = ? AND country_id != ''",
    ).bind(runId).all<{ id: string }>();
    ids = fromBatches.results.map((row) => row.id);
  }
  if (ids.length === 0) {
    const fromRecords = await env.DB.prepare(
      "SELECT DISTINCT country_id AS id FROM records WHERE run_id = ? AND country_id != ''",
    ).bind(runId).all<{ id: string }>();
    ids = fromRecords.results.map((row) => row.id);
  }
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(", ");
  const countries = await env.DB.prepare(
    `SELECT id, name FROM countries WHERE delivery = 'email' AND id IN (${marks})`,
  ).bind(...ids).all<{ id: string; name: string }>();
  const links = await env.DB.prepare(
    `SELECT cr.country_id, r.email
     FROM country_recipients cr
     JOIN recipients r ON r.id = cr.recipient_id AND r.enabled = 1
     WHERE cr.country_id IN (${marks})
     ORDER BY r.email`,
  ).bind(...ids).all<{ country_id: string; email: string }>();
  const emails = new Map<string, string[]>();
  for (const link of links.results) {
    const list = emails.get(link.country_id) ?? [];
    if (!list.includes(link.email)) list.push(link.email);
    emails.set(link.country_id, list);
  }
  return countries.results.map((country) => ({
    id: country.id,
    name: country.name,
    emails: emails.get(country.id) ?? [],
  }));
}

async function bucketBatchHealth(
  env: Env,
  runId: string,
  countryIds: string[],
): Promise<{ failed: number; pending: number; cancelled: number }> {
  if (countryIds.length === 0) return { failed: 0, pending: 0, cancelled: 0 };
  const marks = countryIds.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
     FROM batches WHERE run_id = ? AND country_id IN (${marks})`,
  ).bind(runId, ...countryIds).first<{ failed: number | null; pending: number | null; cancelled: number | null }>();
  return { failed: row?.failed ?? 0, pending: row?.pending ?? 0, cancelled: row?.cancelled ?? 0 };
}

async function workbookForGroups(
  env: Env,
  settings: AppSettings,
  run: { id: string; windowStart: string; windowEnd: string },
  groups: Array<{ id: string; name: string }>,
): Promise<{ bytes: Uint8Array | null; truncated: boolean }> {
  if (groups.length === 0) return { bytes: null, truncated: false };
  const marks = groups.map(() => "?").join(", ");
  const loaded = await loadExcelRecords(
    env.DB,
    `run_id = ? AND ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ? AND country_id IN (${marks})`,
    [run.id, run.windowStart, run.windowEnd, ...groups.map((group) => group.id)],
  );
  if (loaded.records.length === 0) return { bytes: null, truncated: false };
  const windowEnd = new Date(run.windowEnd);
  return {
    bytes: buildMonitorWorkbook({
      countries: groups.map((group) => ({ name: group.name })),
      records: loaded.records,
      reference: Number.isNaN(windowEnd.getTime()) ? new Date() : windowEnd,
      timeZone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
      periodSheets: false,
    }),
    truncated: loaded.truncated,
  };
}

async function sendDigest(
  env: Env,
  settings: AppSettings,
  message: OutboundEmail,
  to: string[],
): Promise<{ status: "sent" | "skipped" | "failed"; error: string | null; messageId: string | null; recipients: string[] }> {
  if (!settings.emailEnabled) return { status: "skipped", error: null, messageId: null, recipients: [] };
  if (to.length === 0) return { status: "skipped", error: "没有启用的收件人", messageId: null, recipients: [] };
  if (!settings.emailFrom) return { status: "failed", error: "未配置发件人", messageId: null, recipients: to };
  const outbound = { ...message, from: settings.emailFrom, fromName: settings.emailFromName, to };
  try {
    const result = settings.emailProvider === "cloudflare"
      ? await sendWithCloudflare(env.EMAIL, outbound)
      : env.RESEND_API_KEY
        ? await sendWithResend(env.RESEND_API_KEY, outbound)
        : null;
    if (!result) return { status: "failed", error: "未配置 RESEND_API_KEY", messageId: null, recipients: to };
    return { status: "sent", error: null, messageId: result.id || null, recipients: to };
  } catch (error) {
    logError("email failed", error);
    return { status: "failed", error: errorMessage(error).slice(0, 500), messageId: null, recipients: to };
  }
}

async function claimDailyEmail(env: Env, runId: string, claimedAt: string): Promise<boolean> {
  const claim = await env.DB.prepare(
    `UPDATE runs SET email_sent_at = ?
     WHERE id = ? AND email_sent_at IS NULL AND COALESCE(email_status, '') != 'sent'`,
  ).bind(claimedAt, runId).run();
  return (claim.meta.changes ?? 0) === 1;
}

async function releaseDailyEmailClaim(env: Env, runId: string, claimedAt: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET email_sent_at = NULL
     WHERE id = ? AND email_sent_at = ? AND COALESCE(email_status, '') != 'sent'`,
  ).bind(runId, claimedAt).run();
}

async function sendRunDigestEmails(
  env: Env,
  settings: AppSettings,
  run: { id: string; window_start: string; window_end: string; notes: string | null },
  input: {
    notes: string;
    treatCancelledAsIncomplete: boolean;
    windowFile: { bytes: Uint8Array | null; truncated: boolean; filename: string };
    byCountry: Map<string, DigestCountry>;
  },
): Promise<{
  emailStatus: "sent" | "skipped" | "failed";
  emailError: string | null;
  emailTouched: boolean;
  notes: string;
  recipients: string[];
}> {
  let notes = input.notes;
  let emailStatus: "sent" | "skipped" | "failed" = "skipped";
  let emailError: string | null = null;
  let emailTouched = false;
  let claimedAt: string | null = null;
  const recipients: string[] = [];
  try {
    const groups = await loadRunEmailGroups(env, run.id);
    const unaddressed = groups.filter((group) => group.emails.length === 0).map((group) => group.name);
    if (unaddressed.length > 0) {
      const sentence = `这些分组配置了邮件，但没有启用的收件人：${unaddressed.join("、")}。`;
      if (!notes.includes(sentence)) notes = [notes, sentence].filter(Boolean).join(" ");
    }
    const buckets = emailBuckets(groups);
    if (buckets.length === 0) {
      return {
        emailStatus: "skipped",
        emailError: groups.length > 0 ? "没有启用的收件人" : null,
        emailTouched: true,
        notes,
        recipients,
      };
    }
    claimedAt = new Date().toISOString();
    const claimed = await claimDailyEmail(env, run.id, claimedAt);
    if (!claimed) {
      return { emailStatus: "skipped", emailError: "日报正在发送", emailTouched: false, notes, recipients };
    }
    emailTouched = true;
    const prior = await env.DB.prepare(
      "SELECT recipients FROM email_log WHERE run_id = ? AND kind = 'daily' AND status = 'sent'",
    ).bind(run.id).all<{ recipients: string }>();
    const priorKeys = new Set(prior.results.map((row) => row.recipients));
    const allCountries = await env.DB.prepare("SELECT id FROM countries").all<{ id: string }>();
    const allIds = new Set(allCountries.results.map((row) => row.id));
    const errors: string[] = [];
    let anyFailed = false;
    let anySent = false;
    for (const bucket of buckets) {
      const recipientKey = bucket.emails.join(", ");
      if (priorKeys.has(recipientKey)) {
        anySent = true;
        recipients.push(...bucket.emails);
        continue;
      }
      const health = await bucketBatchHealth(env, run.id, bucket.groupIds);
      const bucketIncomplete = health.failed > 0 || health.pending > 0 || (input.treatCancelledAsIncomplete && health.cancelled > 0);
      const coversAll = bucket.groupIds.length === allIds.size && bucket.groupIds.every((id) => allIds.has(id));
      const file = coversAll
        ? { bytes: input.windowFile.bytes, truncated: input.windowFile.truncated }
        : await workbookForGroups(env, settings, {
          id: run.id,
          windowStart: run.window_start,
          windowEnd: run.window_end,
        }, bucket.groupIds.map((id) => ({ id, name: input.byCountry.get(id)?.name ?? groups.find((group) => group.id === id)?.name ?? id })));
      const downloadUrl = coversAll && file.bytes && settings.appBaseUrl
        ? `${settings.appBaseUrl}${runWindowDownloadPath(run.id)}`
        : null;
      const attached = Boolean(file.bytes && file.bytes.byteLength <= ATTACHMENT_LIMIT_BYTES);
      const digestNotes = [
        run.notes ?? "",
        bucketIncomplete ? "有批次未完成，已发送目前收集到的内容。" : "",
        file.truncated ? `本轮新增 Excel 只保留最新 ${MAX_EXCEL_ROWS} 条。` : "",
      ].filter((part, index, parts) => part && parts.indexOf(part) === index).join(" ");
      const countries = bucket.groupIds
        .map((id) => input.byCountry.get(id))
        .filter((country): country is DigestCountry => Boolean(country))
        .sort((left, right) => left.name.localeCompare(right.name, "zh"));
      const digest = buildDigest({
        incomplete: bucketIncomplete,
        windowStart: run.window_start,
        windowEnd: run.window_end,
        timeZone: settings.timeZone,
        countries,
        failedBatches: health.failed,
        downloadUrl,
        attached,
        attachmentOmitted: Boolean(file.bytes && !attached && !downloadUrl),
        scopeLabel: buckets.length > 1 ? scopeLabel(bucket.names) : undefined,
        notes: digestNotes,
      });
      const mode = attachmentMode(attached, downloadUrl);
      const attachmentBytes = file.bytes?.byteLength ?? 0;
      const sent = await sendDigest(env, settings, {
        from: settings.emailFrom,
        fromName: settings.emailFromName,
        to: bucket.emails,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
        attachment: attached && file.bytes
          ? { filename: input.windowFile.filename, content: file.bytes, contentType: EXCEL_TYPE }
          : undefined,
      }, bucket.emails);
      if (sent.status === "sent") {
        anySent = true;
        recipients.push(...sent.recipients);
        await recordEmailLog(env.DB, {
          runId: run.id,
          kind: "daily",
          recipients: sent.recipients,
          subject: digest.subject,
          status: "sent",
          error: null,
          messageId: sent.messageId,
          attachmentMode: mode,
          attachmentBytes,
        });
      } else if (sent.status === "failed") {
        anyFailed = true;
        if (sent.error) errors.push(sent.error);
        await recordEmailLog(env.DB, {
          runId: run.id,
          kind: "daily",
          recipients: sent.recipients,
          subject: digest.subject,
          status: "failed",
          error: sent.error,
          messageId: null,
          attachmentMode: mode,
          attachmentBytes,
        });
      }
    }
    if (anyFailed) {
      await releaseDailyEmailClaim(env, run.id, claimedAt);
      return {
        emailStatus: "failed",
        emailError: errors.join("；").slice(0, 500) || "发送失败",
        emailTouched: true,
        notes,
        recipients,
      };
    }
    if (anySent) return { emailStatus: "sent", emailError: null, emailTouched: true, notes, recipients };
    await releaseDailyEmailClaim(env, run.id, claimedAt);
    return { emailStatus: "skipped", emailError: null, emailTouched: true, notes, recipients };
  } catch (error) {
    if (claimedAt) await releaseDailyEmailClaim(env, run.id, claimedAt);
    emailTouched = true;
    emailStatus = "failed";
    emailError = errorMessage(error).slice(0, 500);
    notes = [notes, "发送邮件失败。"].filter(Boolean).join(" ");
    await recordEmailLog(env.DB, {
      runId: run.id,
      kind: "daily",
      recipients: [],
      subject: "SkyEyes 每日监测",
      status: "failed",
      error: emailError,
      messageId: null,
      attachmentMode: "none",
      attachmentBytes: 0,
    });
    return { emailStatus, emailError, emailTouched, notes, recipients };
  }
}

const RESENDABLE_RUN_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);

export async function resendRunDigest(env: Env, runId: string): Promise<{
  status: "sent" | "skipped" | "failed";
  recipients: string[];
  error: string | null;
}> {
  const run = await env.DB.prepare(
    `SELECT id, status, window_start, window_end, notes, email_status, email_sent_at
     FROM runs WHERE id = ?`,
  ).bind(runId).first<{
    id: string;
    status: string;
    window_start: string;
    window_end: string;
    notes: string | null;
    email_status: string | null;
    email_sent_at: string | null;
  }>();
  if (!run) throw new Error("运行不存在");
  if (!RESENDABLE_RUN_STATUSES.has(run.status)) throw new Error("任务还在进行，结束后会自动发信");
  if (run.email_status === "sent") throw new Error("这次日报已经发出");
  if (run.email_sent_at) throw new Error("日报正在发送");
  const settings = await loadSettings(env.DB);
  if (!settings.emailEnabled) throw new Error("每日邮件未开启");
  if (!settings.emailFrom) throw new Error("未配置发件人");
  const windowFile = await storeRunWindowExcel(env, settings, {
    id: run.id,
    windowStart: run.window_start,
    windowEnd: run.window_end,
  });
  const grouped = await env.DB.prepare(
    `SELECT country_id, country_name, source, COUNT(*) AS n
     FROM records
     WHERE run_id = ? AND ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ?
     GROUP BY country_id, country_name, source`,
  ).bind(run.id, run.window_start, run.window_end).all<{ country_id: string; country_name: string; source: string; n: number }>();
  const byCountry = new Map<string, DigestCountry>();
  for (const row of grouped.results) {
    const current: DigestCountry = byCountry.get(row.country_id) ?? { name: row.country_name, added: 0, bySource: {} };
    current.added += row.n;
    current.bySource[row.source] = row.n;
    byCountry.set(row.country_id, current);
  }
  const delivered = await sendRunDigestEmails(env, settings, run, {
    notes: run.notes ?? "",
    treatCancelledAsIncomplete: true,
    windowFile,
    byCountry,
  });
  if (delivered.emailTouched) {
    await env.DB.prepare(
      `UPDATE runs SET email_status = ?, email_error = ?, notes = ?
       WHERE id = ? AND COALESCE(email_status, '') != 'sent'`,
    ).bind(delivered.emailStatus, delivered.emailError, delivered.notes || null, run.id).run();
  }
  await recordRunEvent(env.DB, {
    runId: run.id,
    type: "daily email resent",
    details: {
      status: delivered.emailStatus,
      error: delivered.emailError,
      reason: delivered.emailStatus === "sent" ? `发给 ${delivered.recipients.join("、")}` : (delivered.emailError ?? "未发送"),
    },
  });
  return { status: delivered.emailStatus, recipients: delivered.recipients, error: delivered.emailError };
}

export async function finalizeRun(env: Env, runId: string, reason: "complete" | "deadline" | "preempt"): Promise<void> {
  const claim = await env.DB.prepare(
    `UPDATE runs SET status = 'finalizing'
     WHERE id = ? AND (
       status IN ('running', 'partial')
       OR (status = 'incomplete' AND email_status = 'failed' AND email_sent_at IS NULL)
     )`,
  ).bind(runId).run();
  if ((claim.meta.changes ?? 0) === 0) return;
  await env.DB.prepare(
    "UPDATE runs SET finalize_enqueued_at = COALESCE(finalize_enqueued_at, ?) WHERE id = ?",
  ).bind(new Date().toISOString(), runId).run();
  if (reason === "deadline" || reason === "preempt") {
    await cancelOpenBatches(env, runId, reason === "preempt" ? "已到下一次定时运行" : "采集长时间没有进展");
  }

  const settings = await loadSettings(env.DB);
  const run = await env.DB.prepare(
    "SELECT id, status, window_start, window_end, batches_failed, notes FROM runs WHERE id = ?",
  ).bind(runId).first<RunRow & { notes: string | null }>();
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
  const incomplete = reason !== "complete" || failed > 0 || pending > 0;
  let notes = run.notes ?? "";
  if (incomplete && !notes.includes("有批次未完成，已发送目前收集到的内容。")) {
    notes = [notes, "有批次未完成，已发送目前收集到的内容。"].filter(Boolean).join(" ");
  }
  let emailStatus = "skipped";
  let emailError: string | null = null;
  let emailTouched = false;

  try {
    const stored = await storeExcel(env, settings);
    if (stored.truncated) notes = [notes, `Excel 只保留最新 ${MAX_EXCEL_ROWS} 条，更早的记录仍在数据库中。`].filter(Boolean).join(" ");
    const windowFile = await storeRunWindowExcel(env, settings, {
      id: runId,
      windowStart: run.window_start,
      windowEnd: run.window_end,
    });
    if (windowFile.truncated) notes = [notes, `本轮新增 Excel 只保留最新 ${MAX_EXCEL_ROWS} 条。`].filter(Boolean).join(" ");
    const grouped = await env.DB.prepare(
      `SELECT country_id, country_name, source, COUNT(*) AS n
       FROM records
       WHERE run_id = ? AND ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ?
       GROUP BY country_id, country_name, source`,
    ).bind(runId, run.window_start, run.window_end).all<{ country_id: string; country_name: string; source: string; n: number }>();
    const byCountry = new Map<string, DigestCountry>();
    for (const row of grouped.results) {
      const current: DigestCountry = byCountry.get(row.country_id) ?? { name: row.country_name, added: 0, bySource: {} };
      current.added += row.n;
      current.bySource[row.source] = row.n;
      byCountry.set(row.country_id, current);
    }
    const alreadySent = await env.DB.prepare(
      "SELECT email_sent_at, email_status FROM runs WHERE id = ?",
    ).bind(runId).first<{ email_sent_at: string | null; email_status: string | null }>();
    const sentAlready = Boolean(alreadySent?.email_sent_at) || alreadySent?.email_status === "sent";
    if (!sentAlready && settings.emailEnabled) {
      const delivered = await sendRunDigestEmails(env, settings, {
        id: runId,
        window_start: run.window_start,
        window_end: run.window_end,
        notes: run.notes,
      }, {
        notes,
        treatCancelledAsIncomplete: reason !== "complete",
        windowFile,
        byCountry,
      });
      notes = delivered.notes;
      emailStatus = delivered.emailStatus;
      emailError = delivered.emailError;
      emailTouched = delivered.emailTouched;
    } else if (!sentAlready) {
      emailTouched = true;
      emailStatus = "skipped";
    }
  } catch (error) {
    logError("finalize failed", error, { runId });
    emailTouched = true;
    emailStatus = "failed";
    emailError = errorMessage(error).slice(0, 500);
    notes = [notes, "收尾时生成 Excel 或发送邮件失败。"].filter(Boolean).join(" ");
    await recordEmailLog(env.DB, {
      runId,
      kind: "daily",
      recipients: [],
      subject: "SkyEyes 每日监测",
      status: "failed",
      error: emailError,
      messageId: null,
      attachmentMode: "none",
      attachmentBytes: 0,
    });
  }

  await env.DB.prepare(
    `UPDATE runs
     SET status = ?, finished_at = ?, batches_done = ?, batches_failed = ?, notes = ?,
         email_status = CASE WHEN ? = 1 THEN ? ELSE email_status END,
         email_error = CASE WHEN ? = 1 THEN ? ELSE email_error END
     WHERE id = ? AND status = 'finalizing'`,
  ).bind(
    incomplete || emailStatus === "failed" ? "incomplete" : "completed",
    new Date().toISOString(),
    counts?.done ?? 0,
    failed,
    notes || null,
    emailTouched ? 1 : 0,
    emailStatus,
    emailTouched ? 1 : 0,
    emailError,
    runId,
  ).run();
  log("run finalized", { runId, reason, incomplete, emailStatus });
  await recordRunEvent(env.DB, { runId, type: "run finalized", details: { reason, incomplete, emailStatus } });
}

export async function handleDeadLetter(env: Env, message: CollectMessage): Promise<void> {
  if (message.type === "batch") {
    const batch = await env.DB.prepare(
      "SELECT status, next_wake_at, lease_expires_at FROM batches WHERE id = ?",
    ).bind(message.batchId).first<{ status: string; next_wake_at: string | null; lease_expires_at: string | null }>();
    const now = new Date().toISOString();
    if (batch?.status === "queued" && batch.next_wake_at) {
      log("dead letter ignored for deferred batch", { runId: message.runId, batchId: message.batchId });
      return;
    }
    if (batch?.status === "running" && batch.lease_expires_at && batch.lease_expires_at > now) {
      log("dead letter ignored for leased batch", { runId: message.runId, batchId: message.batchId });
      return;
    }
    await markBatchFailed(env, message.runId, message.batchId, "超过队列重试次数");
    await maybeEnqueueFinalize(env, message.runId);
    return;
  }
  if (message.type === "enqueue") {
    const finishedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE batches
       SET status = 'failed', error = ?, finished_at = ?
       WHERE run_id = ? AND status = 'queued' AND (enqueued_at IS NULL OR enqueued_at LIKE 'claim:%')`,
    ).bind(NOT_ENQUEUED_ERROR, finishedAt, message.runId).run();
    await syncRunEnqueueState(env, message.runId, NOT_ENQUEUED_ERROR);
    await maybeEnqueueFinalize(env, message.runId);
    return;
  }
  await finalizeRun(env, message.runId, message.reason);
}

const STUCK_FINALIZE_NOTE = "收尾超时，已按当时的批次结果结束。";

function sweptRunStatus(
  pending: number,
  failed: number,
  cancelled: number,
  emailStatus: string | null,
): "completed" | "incomplete" {
  if (pending > 0 || failed > 0 || cancelled > 0) return "incomplete";
  if (emailStatus === "sent" || emailStatus === "skipped") return "completed";
  return "incomplete";
}

/** Force a terminal status when finalize claimed the row and then died before the update. */
export async function closeStuckFinalizing(env: Env, now: Date): Promise<string[]> {
  const graceIso = new Date(now.getTime() - FINALIZING_GRACE_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, notes, email_status FROM runs
     WHERE status = 'finalizing'
       AND (
         deadline_at <= ?
         OR (finalize_enqueued_at IS NOT NULL AND finalize_enqueued_at <= ?)
       )`,
  ).bind(graceIso, graceIso).all<{ id: string; notes: string | null; email_status: string | null }>();
  const closed: string[] = [];
  for (const row of rows.results) {
    const counts = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS pending
       FROM batches WHERE run_id = ?`,
    ).bind(row.id).first<{ done: number | null; failed: number | null; cancelled: number | null; pending: number | null }>();
    const pending = counts?.pending ?? 0;
    const failed = counts?.failed ?? 0;
    const cancelled = counts?.cancelled ?? 0;
    const status = sweptRunStatus(pending, failed, cancelled, row.email_status);
    await cancelOpenBatches(env, row.id, "已过截止时间", { now });
    const previousNotes = row.notes ?? "";
    const notes = previousNotes.includes(STUCK_FINALIZE_NOTE)
      ? previousNotes
      : [previousNotes, STUCK_FINALIZE_NOTE].filter((part) => part.length > 0).join(" ");
    const updated = await env.DB.prepare(
      `UPDATE runs
       SET status = ?, finished_at = ?, batches_done = ?, batches_failed = ?, notes = ?
       WHERE id = ? AND status = 'finalizing'`,
    ).bind(status, now.toISOString(), counts?.done ?? 0, failed, notes || null, row.id).run();
    if ((updated.meta.changes ?? 0) > 0) {
      closed.push(row.id);
      log("stuck finalizing closed", { runId: row.id, status, pending, failed, cancelled });
    }
  }
  return closed;
}

/** A batch is still doing the day's collection, including a scheduled continuation. */
export function batchIsCollecting(
  batch: {
    status: string;
    lease_expires_at?: string | null;
    next_wake_at?: string | null;
    enqueued_at?: string | null;
  },
  now: Date,
): boolean {
  if (batch.status === "running") {
    const lease = Date.parse(batch.lease_expires_at ?? "");
    return Number.isFinite(lease) && lease > now.getTime() - STALE_ENQUEUE_MS;
  }
  if (batch.status !== "queued") return false;
  const wake = Date.parse(batch.next_wake_at ?? "");
  if (Number.isFinite(wake) && wake > now.getTime()) return true;
  const enqueuedAt = batch.enqueued_at ?? "";
  if (!enqueuedAt || enqueuedAt.startsWith("claim:")) return false;
  const enqueued = Date.parse(enqueuedAt);
  return Number.isFinite(enqueued) && now.getTime() - enqueued <= STALE_ENQUEUE_MS;
}

async function runStillCollecting(env: Env, runId: string, now: Date): Promise<boolean> {
  const batches = await env.DB.prepare(
    `SELECT status, lease_expires_at, next_wake_at, enqueued_at
     FROM batches WHERE run_id = ? AND status IN ('queued', 'running')`,
  ).bind(runId).all<{
    status: string;
    lease_expires_at: string | null;
    next_wake_at: string | null;
    enqueued_at: string | null;
  }>();
  return batches.results.some((batch) => batchIsCollecting(batch, now));
}

async function postponeCollectionDeadline(env: Env, runId: string, now: Date): Promise<void> {
  const settings = await loadSettings(env.DB);
  const deadlineAt = new Date(now.getTime() + settings.finalizeDeadlineMinutes * 60 * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE runs SET deadline_at = ?
     WHERE id = ? AND status IN ('running', 'partial')`,
  ).bind(deadlineAt, runId).run();
  log("collection deadline postponed", { runId, deadlineAt });
}

export async function finalizeOverdue(
  env: Env,
  now: Date,
  options: { yieldToNextRun?: boolean } = {},
): Promise<void> {
  const swept = new Set(await closeStuckFinalizing(env, now));
  if (options.yieldToNextRun) {
    const active = await env.DB.prepare(
      "SELECT id FROM runs WHERE status IN ('running', 'partial')",
    ).all<{ id: string }>();
    for (const row of active.results) {
      if (swept.has(row.id)) continue;
      swept.add(row.id);
      await finalizeRun(env, row.id, "preempt");
    }
  }
  const rows = await env.DB.prepare(
    `SELECT id FROM runs
     WHERE deadline_at <= ? AND (
       status IN ('running', 'partial')
       OR (status = 'incomplete' AND email_status = 'failed' AND email_sent_at IS NULL)
     )`,
  ).bind(now.toISOString()).all<{ id: string }>();
  for (const row of rows.results) {
    if (swept.has(row.id)) continue;
    const current = await env.DB.prepare("SELECT status FROM runs WHERE id = ?")
      .bind(row.id)
      .first<{ status: string }>();
    if (current && (current.status === "running" || current.status === "partial") && await runStillCollecting(env, row.id, now)) {
      await postponeCollectionDeadline(env, row.id, now);
      continue;
    }
    await finalizeRun(env, row.id, "deadline");
  }
}
