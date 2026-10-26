import { Hono } from "hono";
import { assertAllowedEmail, authenticate } from "../auth/access";
import { EDITABLE_SETTINGS, SETTING_DEFAULTS, loadSettings, saveSettings, validateSettingsPatch } from "../config/settings";
import { probeTranslationFallbackModel } from "../translate";
import { authorBlockKey, DELIVERABLE_SQL } from "../domain/gate";
import { closedWindow, decideSchedule, utcOffsetLabel } from "../domain/time";
import { assertTermList, flagEnabled, joinTerms, splitLines, termsFromUnknown, uniqueTerms } from "../domain/terms";
import { TARGET_KINDS, type TargetKind } from "../domain/types";
import {
  buildTargetExportCsv,
  buildTargetExportXlsx,
  buildTargetTemplateCsv,
  buildTargetTemplateXlsx,
  previewCsv,
  previewXlsx,
  type ExistingTarget,
  type ImportPreviewRow,
} from "../import/table";
import { sendTestEmail } from "../email/send-test";
import { isRunId, runWindowFilename, runWindowObjectKey } from "../export/run-file";
import { storeExcel } from "../pipeline/run";
import { hideRecords, hideRecordsMatching, parseDeleteIds } from "../records/delete";
import { RECORD_LIST_SELECT, buildRecordListQuery, recordListInputFromBody } from "../records/list";
import { rescoreRecords } from "../records/rescore";
import { retranslateRecords } from "../records/retranslate";
import { interpretStoredRecords } from "../records/interpret";
import { enqueueErrorMessage } from "../pipeline/queue-batch";
import { ActiveRunError, cancelRun, requeueStuckBatches } from "../pipeline/run";
import { startManualRun } from "../schedule";

const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type AppVars = { email: string };

function jsonError(error: unknown, status: 400 | 403 | 404 | 500 = 400): Response {
  const message = error instanceof Error ? error.message : "请求失败";
  return Response.json({ error: message }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const payload = await request.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return payload as Record<string, unknown>;
}

function descriptionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > 800) throw new Error("背景说明不能超过 800 字");
  return text;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  return value.trim();
}

interface StoredTargetRow {
  id: string;
  country_id: string;
  country_code: string;
  kind: string;
  name: string;
  query: string;
  terms: string;
  exclude_terms: string;
  description: string | null;
  enabled: number;
  case_sensitive: number;
}

interface IndexedTarget extends ExistingTarget {
  countryId: string;
}

function sameTerms(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function targetNameKey(target: { countryCode: string; kind: string; name: string }): string {
  return `${target.countryCode}\0${target.kind}\0${target.name}`;
}

async function loadExistingTargets(db: D1Database, countryId?: string): Promise<IndexedTarget[]> {
  const sql = `SELECT t.id, t.country_id, c.code AS country_code, t.kind, t.name, t.query, t.terms,
                      t.exclude_terms, t.description, t.enabled, t.case_sensitive
               FROM targets t
               JOIN countries c ON c.id = t.country_id
               ${countryId ? "WHERE t.country_id = ?" : ""}
               ORDER BY c.code, t.kind, t.name`;
  const statement = countryId ? db.prepare(sql).bind(countryId) : db.prepare(sql);
  const rows = await statement.all<StoredTargetRow>();
  return rows.results.map((row) => {
    const terms = splitLines(row.terms);
    return {
      id: row.id,
      countryId: row.country_id,
      countryCode: row.country_code,
      kind: row.kind,
      name: row.name,
      terms: terms.length > 0 ? terms : splitLines(row.query),
      excludeTerms: splitLines(row.exclude_terms),
      description: row.description ?? "",
      enabled: row.enabled === 1,
      caseSensitive: row.case_sensitive === 1,
    };
  });
}

async function applyTargetImport(
  db: D1Database,
  rows: ImportPreviewRow[],
  countryIdByCode: Map<string, string>,
  existing: IndexedTarget[],
): Promise<{ created: number; updated: number; unchanged: number }> {
  const byId = new Map(existing.map((target) => [target.id, {
    ...target,
    terms: [...target.terms],
    excludeTerms: [...target.excludeTerms],
  }]));
  const byName = new Map<string, IndexedTarget>();
  for (const target of byId.values()) {
    const key = targetNameKey(target);
    if (!byName.has(key)) byName.set(key, target);
  }
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    const countryId = countryIdByCode.get(row.countryCode);
    if (!countryId) throw new Error(`未知分组代码 ${row.countryCode}，请先创建分组`);
    if (row.id) {
      const current = byId.get(row.id);
      if (!current) throw new Error("未知目标 ID");
      const same = current.countryId === countryId
        && current.countryCode === row.countryCode
        && current.kind === row.kind
        && current.name === row.name
        && sameTerms(current.terms, row.terms)
        && sameTerms(current.excludeTerms, row.excludeTerms)
        && current.description === row.description
        && current.enabled === row.enabled
        && current.caseSensitive === row.caseSensitive;
      if (same) {
        unchanged += 1;
        continue;
      }
      await db.prepare(
        `UPDATE targets
         SET country_id = ?, kind = ?, name = ?, query = ?, terms = ?, exclude_terms = ?,
             case_sensitive = ?, enabled = ?, description = ?
         WHERE id = ?`,
      ).bind(
        countryId,
        row.kind,
        row.name,
        row.terms[0],
        joinTerms(row.terms),
        joinTerms(row.excludeTerms),
        row.caseSensitive ? 1 : 0,
        row.enabled ? 1 : 0,
        row.description,
        row.id,
      ).run();
      const oldKey = targetNameKey(current);
      if (byName.get(oldKey)?.id === current.id) byName.delete(oldKey);
      current.countryId = countryId;
      current.countryCode = row.countryCode;
      current.kind = row.kind;
      current.name = row.name;
      current.terms = [...row.terms];
      current.excludeTerms = [...row.excludeTerms];
      current.description = row.description;
      current.enabled = row.enabled;
      current.caseSensitive = row.caseSensitive;
      byName.set(targetNameKey(current), current);
      updated += 1;
      continue;
    }
    const key = targetNameKey(row);
    const current = byName.get(key);
    if (!current) {
      const id = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO targets (
          id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, description, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        countryId,
        row.kind,
        row.name,
        row.terms[0],
        joinTerms(row.terms),
        joinTerms(row.excludeTerms),
        row.caseSensitive ? 1 : 0,
        row.description,
        row.enabled ? 1 : 0,
        now,
      ).run();
      const createdTarget: IndexedTarget = {
        id,
        countryId,
        countryCode: row.countryCode,
        kind: row.kind,
        name: row.name,
        terms: [...row.terms],
        excludeTerms: [...row.excludeTerms],
        description: row.description,
        enabled: row.enabled,
        caseSensitive: row.caseSensitive,
      };
      byId.set(id, createdTarget);
      byName.set(key, createdTarget);
      created += 1;
      continue;
    }
    const terms = uniqueTerms([...current.terms, ...row.terms]);
    const excludeTerms = uniqueTerms([...current.excludeTerms, ...row.excludeTerms]);
    const caseSensitive = current.caseSensitive || row.caseSensitive;
    const description = row.description || current.description;
    const enabled = row.enabled;
    const changed = !sameTerms(terms, current.terms)
      || !sameTerms(excludeTerms, current.excludeTerms)
      || caseSensitive !== current.caseSensitive
      || description !== current.description
      || enabled !== current.enabled;
    if (!changed) {
      unchanged += 1;
      continue;
    }
    await db.prepare(
      `UPDATE targets
       SET query = ?, terms = ?, exclude_terms = ?, case_sensitive = ?, enabled = ?, description = ?
       WHERE id = ?`,
    ).bind(
      terms[0],
      joinTerms(terms),
      joinTerms(excludeTerms),
      caseSensitive ? 1 : 0,
      enabled ? 1 : 0,
      description,
      current.id,
    ).run();
    current.terms = terms;
    current.excludeTerms = excludeTerms;
    current.caseSensitive = caseSensitive;
    current.description = description;
    current.enabled = enabled;
    updated += 1;
  }
  return { created, updated, unchanged };
}

async function loadRateLimit(db: D1Database, now: Date, options: { xQps: number; gdeltMinIntervalSec: number }) {
  const empty = {
    xQps: options.xQps,
    gdeltMinIntervalSec: options.gdeltMinIntervalSec,
    hits24h: 0,
    hits7d: 0,
    gdeltHits24h: 0,
    gdeltHits7d: 0,
    lastHitAt: null as string | null,
    lastRetryAfterSeconds: null as number | null,
    recent: [] as Array<{
      id: string;
      source: string;
      status: number;
      retryAfterSeconds: number | null;
      delaySeconds: number;
      recordedAt: string;
    }>,
  };
  try {
    const since24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [day, week, recent] = await Promise.all([
      db.prepare(
        "SELECT source, COUNT(*) AS n FROM rate_events WHERE recorded_at >= ? GROUP BY source",
      ).bind(since24).all<{ source: string; n: number }>(),
      db.prepare(
        "SELECT source, COUNT(*) AS n FROM rate_events WHERE recorded_at >= ? GROUP BY source",
      ).bind(since7).all<{ source: string; n: number }>(),
      db.prepare(
        `SELECT id, source, status, retry_after_seconds, delay_seconds, recorded_at
         FROM rate_events ORDER BY recorded_at DESC LIMIT 8`,
      ).all<{
        id: string;
        source: string;
        status: number;
        retry_after_seconds: number | null;
        delay_seconds: number;
        recorded_at: string;
      }>(),
    ]);
    const count = (rows: { source: string; n: number }[], source: string) => Number(rows.find((row) => row.source === source)?.n ?? 0);
    const lastX = recent.results.find((row) => row.source === "x");
    return {
      xQps: options.xQps,
      gdeltMinIntervalSec: options.gdeltMinIntervalSec,
      hits24h: count(day.results, "x"),
      hits7d: count(week.results, "x"),
      gdeltHits24h: count(day.results, "gdelt"),
      gdeltHits7d: count(week.results, "gdelt"),
      lastHitAt: lastX?.recorded_at ?? null,
      lastRetryAfterSeconds: lastX?.retry_after_seconds ?? null,
      recent: recent.results.map((row) => ({
        id: row.id,
        source: row.source,
        status: row.status,
        retryAfterSeconds: row.retry_after_seconds,
        delaySeconds: row.delay_seconds,
        recordedAt: row.recorded_at,
      })),
    };
  } catch {
    return empty;
  }
}

interface RunProgress {
  pending: number;
  enqueued: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  fetched: number;
  deduped: number;
  filtered: number;
  added: number;
}

const EMPTY_PROGRESS: RunProgress = {
  pending: 0,
  enqueued: 0,
  running: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
  fetched: 0,
  deduped: 0,
  filtered: 0,
  added: 0,
};

async function attachRunProgress<T extends { id: string }>(db: D1Database, runs: T[]): Promise<Array<T & { progress: RunProgress }>> {
  if (runs.length === 0) return [];
  const marks = runs.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT run_id,
       SUM(CASE WHEN status = 'queued' AND enqueued_at IS NULL THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'queued' AND enqueued_at IS NOT NULL THEN 1 ELSE 0 END) AS enqueued,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(items_fetched) AS fetched,
       SUM(items_deduped) AS deduped,
       SUM(items_filtered) AS filtered,
       SUM(items_added) AS added
     FROM batches WHERE run_id IN (${marks}) GROUP BY run_id`,
  ).bind(...runs.map((run) => run.id)).all<RunProgress & { run_id: string }>();
  const byRun = new Map(rows.results.map((row) => [row.run_id, row]));
  return runs.map((run) => {
    const row = byRun.get(run.id);
    return {
      ...run,
      progress: row
        ? {
          pending: row.pending ?? 0,
          enqueued: row.enqueued ?? 0,
          running: row.running ?? 0,
          done: row.done ?? 0,
          failed: row.failed ?? 0,
          cancelled: row.cancelled ?? 0,
          fetched: row.fetched ?? 0,
          deduped: row.deduped ?? 0,
          filtered: row.filtered ?? 0,
          added: row.added ?? 0,
        }
        : EMPTY_PROGRESS,
    };
  });
}

async function refreshWorkbook(env: Env): Promise<{ excel: boolean; excelError: string | null }> {
  try {
    const settings = await loadSettings(env.DB);
    await storeExcel(env, settings);
    return { excel: true, excelError: null };
  } catch (error) {
    const excelError = error instanceof Error ? error.message : "Excel 生成失败";
    return { excel: false, excelError };
  }
}

export function createApp(): Hono<{ Bindings: Env; Variables: AppVars }> {
  const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

  app.use("/api/*", async (c, next) => {
    try {
      const email = await authenticate(c.req.raw, c.env, c.executionCtx as ExecutionContext);
      await assertAllowedEmail(c.env, email);
      c.set("email", email);
    } catch (error) {
      return jsonError(error, 403);
    }
    await next();
  });

  app.get("/api/status", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const now = new Date();
    const decision = decideSchedule(now, {
      timeZone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
    });
    const schedule = {
      timeZone: settings.timeZone,
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
    };
    const today = closedWindow(now, schedule, 0);
    const yesterday = closedWindow(now, schedule, 1);
    const [countries, totals, todayCounts, yesterdayCounts, runs, failed, usage] = await Promise.all([
      c.env.DB.prepare("SELECT id, name, code, enabled FROM countries ORDER BY name").all(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} GROUP BY country_id`).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ? GROUP BY country_id`)
        .bind(today.start.toISOString(), today.end.toISOString()).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare(`SELECT country_id, COUNT(*) AS n FROM records WHERE ${DELIVERABLE_SQL} AND published_at >= ? AND published_at < ? GROUP BY country_id`)
        .bind(yesterday.start.toISOString(), yesterday.end.toISOString()).all<{ country_id: string; n: number }>(),
      c.env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 12").all(),
      c.env.DB.prepare(
        `SELECT b.id, b.run_id, b.source, b.error, b.finished_at,
                COALESCE(NULLIF(c.name, ''), '全部') AS country_name
         FROM batches b LEFT JOIN countries c ON c.id = b.country_id
         WHERE b.status = 'failed' ORDER BY b.finished_at DESC LIMIT 20`,
      ).all(),
      c.env.DB.prepare(
        `SELECT source, SUM(calls) AS calls, SUM(items) AS items
         FROM api_usage WHERE recorded_at >= ? GROUP BY source`,
      ).bind(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()).all(),
    ]);
    const rateLimit = await loadRateLimit(c.env.DB, now, {
      xQps: settings.xQps,
      gdeltMinIntervalSec: settings.gdeltMinIntervalSec,
    });
    const stuck = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM batches b
       JOIN runs r ON r.id = b.run_id
       WHERE r.status IN ('running', 'partial', 'failed')
         AND (
           (b.status = 'queued' AND (b.enqueued_at IS NULL OR b.enqueued_at <= ?))
           OR (b.status = 'running' AND (b.lease_expires_at IS NULL OR b.lease_expires_at <= ?))
         )`,
    ).bind(new Date(now.getTime() - 15 * 60 * 1000).toISOString(), now.toISOString()).first<{ n: number }>();
    const countMap = (rows: { country_id: string; n: number }[]) => new Map(rows.map((row) => [row.country_id, row.n]));
    const totalMap = countMap(totals.results);
    const todayMap = countMap(todayCounts.results);
    const yesterdayMap = countMap(yesterdayCounts.results);
    const latestBatches = await c.env.DB.prepare(
      "SELECT source, status, error, created_at FROM batches ORDER BY created_at DESC LIMIT 30",
    ).all<{ source: string; status: string; error: string | null; created_at: string }>();
    const health = new Map<string, { status: string; error: string | null }>();
    for (const batch of latestBatches.results) {
      if (!health.has(batch.source)) health.set(batch.source, { status: batch.status, error: batch.error });
    }
    return c.json({
      now: now.toISOString(),
      email: c.get("email"),
      timezone: settings.timeZone,
      utcOffset: utcOffsetLabel(now, settings.timeZone),
      scheduleHour: settings.scheduleHour,
      windowHours: settings.windowHours,
      batchSize: settings.batchSize,
      nextRun: decision.nextRun.toISOString(),
      lastSlot: decision.slotKey,
      countries: countries.results.map((country) => {
        const row = country as { id: string; name: string; code: string; enabled: number };
        return {
          ...row,
          enabled: row.enabled === 1,
          total: totalMap.get(row.id) ?? 0,
          today: todayMap.get(row.id) ?? 0,
          yesterday: yesterdayMap.get(row.id) ?? 0,
        };
      }),
      runs: await attachRunProgress(c.env.DB, runs.results as Array<Record<string, unknown> & { id: string }>),
      stuckBatches: stuck?.n ?? 0,
      failedBatches: failed.results,
      apiUsage: usage.results,
      rateLimit,
      sources: {
        x: {
          label: "X / twitterapi.io",
          enabled: settings.sources.x,
          configured: Boolean(c.env.TWITTERAPI_IO_KEY),
          healthy: health.get("x")?.status !== "failed",
          lastError: health.get("x")?.error ?? null,
        },
        google_news: {
          label: "Google News RSS",
          enabled: settings.sources.google_news,
          configured: true,
          healthy: health.get("google_news")?.status !== "failed",
          lastError: health.get("google_news")?.error ?? null,
        },
        gdelt: {
          label: "GDELT",
          enabled: settings.sources.gdelt,
          configured: true,
          healthy: health.get("gdelt")?.status !== "failed",
          lastError: health.get("gdelt")?.error ?? null,
        },
      },
      delivery: {
        emailEnabled: settings.emailEnabled,
        provider: settings.emailProvider,
        resendConfigured: Boolean(c.env.RESEND_API_KEY),
        cloudflareConfigured: true,
        fromConfigured: Boolean(settings.emailFrom),
        translationEnabled: settings.translationEnabled,
        accessConfigured: Boolean(c.env.TEAM_DOMAIN && c.env.POLICY_AUD),
        aiProvider: settings.aiProvider,
        aiEnabled: settings.aiEnabled,
        deepseekConfigured: Boolean(c.env.DEEPSEEK_API_KEY),
      },
    });
  });

  app.get("/api/countries", async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, name, code, enabled, created_at FROM countries ORDER BY name").all();
    return c.json({ countries: rows.results });
  });

  app.post("/api/countries", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const name = requireString(body.name, "名称");
      const code = requireString(body.code, "代码").toLowerCase();
      if (!/^[a-z0-9-]{2,32}$/.test(code)) throw new Error("代码只能包含小写字母、数字和连字符");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO countries (id, name, code, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
      ).bind(id, name, code, new Date().toISOString()).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/countries/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const current = await c.env.DB.prepare("SELECT id FROM countries WHERE id = ?").bind(c.req.param("id")).first();
      if (!current) return c.json({ error: "分组不存在" }, 404);
      if (typeof body.name === "string" && body.name.trim()) {
        await c.env.DB.prepare("UPDATE countries SET name = ? WHERE id = ?").bind(body.name.trim(), c.req.param("id")).run();
      }
      if (typeof body.enabled === "boolean") {
        await c.env.DB.prepare("UPDATE countries SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, c.req.param("id")).run();
      }
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/countries/:id", async (c) => {
    const id = c.req.param("id");
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM targets WHERE country_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM countries WHERE id = ?").bind(id),
    ]);
    return c.json({ ok: true });
  });

  app.get("/api/targets", async (c) => {
    const countryId = c.req.query("countryId");
    const statement = countryId
      ? c.env.DB.prepare("SELECT * FROM targets WHERE country_id = ? ORDER BY name").bind(countryId)
      : c.env.DB.prepare("SELECT * FROM targets ORDER BY name");
    const rows = await statement.all();
    return c.json({ targets: rows.results });
  });

  app.post("/api/targets", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const countryId = requireString(body.countryId, "分组");
      const name = requireString(body.name, "名称");
      const kind = requireString(body.kind, "类型") as TargetKind;
      if (!TARGET_KINDS.includes(kind)) throw new Error("类型无效");
      const terms = assertTermList(termsFromUnknown(body.terms ?? body.query ?? body.name), "检索词");
      const excludeTerms = assertTermList(termsFromUnknown(body.excludeTerms ?? body.exclude_terms ?? ""), "排除词", true);
      const caseSensitive = flagEnabled(body.caseSensitive ?? body.case_sensitive) ? 1 : 0;
      const country = await c.env.DB.prepare("SELECT id FROM countries WHERE id = ?").bind(countryId).first();
      if (!country) throw new Error("分组不存在");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO targets (
          id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, description, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        countryId,
        kind,
        name,
        terms[0],
        joinTerms(terms),
        joinTerms(excludeTerms),
        caseSensitive,
        descriptionText(body.description),
        body.enabled === false ? 0 : 1,
        new Date().toISOString(),
      ).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/targets/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const id = c.req.param("id");
      const current = await c.env.DB.prepare("SELECT id FROM targets WHERE id = ?").bind(id).first();
      if (!current) return c.json({ error: "目标不存在" }, 404);
      if (typeof body.name === "string") {
        await c.env.DB.prepare("UPDATE targets SET name = ? WHERE id = ?").bind(body.name.trim(), id).run();
      }
      if (body.terms !== undefined || typeof body.query === "string") {
        const terms = assertTermList(termsFromUnknown(body.terms ?? body.query), "检索词");
        await c.env.DB.prepare("UPDATE targets SET query = ?, terms = ? WHERE id = ?")
          .bind(terms[0], joinTerms(terms), id).run();
      }
      if (body.excludeTerms !== undefined || body.exclude_terms !== undefined) {
        const excludeTerms = assertTermList(termsFromUnknown(body.excludeTerms ?? body.exclude_terms), "排除词", true);
        await c.env.DB.prepare("UPDATE targets SET exclude_terms = ? WHERE id = ?")
          .bind(joinTerms(excludeTerms), id).run();
      }
      if (body.caseSensitive !== undefined || body.case_sensitive !== undefined) {
        const caseSensitive = flagEnabled(body.caseSensitive ?? body.case_sensitive) ? 1 : 0;
        await c.env.DB.prepare("UPDATE targets SET case_sensitive = ? WHERE id = ?")
          .bind(caseSensitive, id).run();
      }
      if (typeof body.kind === "string") {
        if (!TARGET_KINDS.includes(body.kind as TargetKind)) throw new Error("类型无效");
        await c.env.DB.prepare("UPDATE targets SET kind = ? WHERE id = ?").bind(body.kind, id).run();
      }
      if (typeof body.enabled === "boolean") {
        await c.env.DB.prepare("UPDATE targets SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, id).run();
      }
      if (typeof body.description === "string") {
        await c.env.DB.prepare("UPDATE targets SET description = ? WHERE id = ?")
          .bind(descriptionText(body.description), id).run();
      }
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/targets/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  app.get("/api/targets/template.csv", (c) => {
    return new Response(buildTargetTemplateCsv(), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="skyeyes-targets-template.csv"',
      },
    });
  });

  app.get("/api/targets/template.xlsx", async (c) => {
    return new Response(await buildTargetTemplateXlsx(), {
      headers: {
        "Content-Type": EXCEL_TYPE,
        "Content-Disposition": 'attachment; filename="skyeyes-targets-template.xlsx"',
      },
    });
  });

  app.get("/api/targets/export.csv", async (c) => {
    const targets = await loadExistingTargets(c.env.DB, c.req.query("countryId"));
    return new Response(buildTargetExportCsv(targets), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="skyeyes-targets.csv"',
      },
    });
  });

  app.get("/api/targets/export.xlsx", async (c) => {
    const targets = await loadExistingTargets(c.env.DB, c.req.query("countryId"));
    return new Response(await buildTargetExportXlsx(targets), {
      headers: {
        "Content-Type": EXCEL_TYPE,
        "Content-Disposition": 'attachment; filename="skyeyes-targets.xlsx"',
      },
    });
  });

  app.post("/api/targets/import/preview", async (c) => {
    try {
      const form = await c.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请上传 file 字段");
      if (file.size > 2_000_000) throw new Error("文件不能超过 2MB");
      const countries = await c.env.DB.prepare("SELECT code FROM countries").all<{ code: string }>();
      const codes = countries.results.map((country) => country.code);
      const existing = await loadExistingTargets(c.env.DB);
      const preview = file.name.toLowerCase().endsWith(".csv")
        ? previewCsv(await file.text(), codes, existing)
        : previewXlsx(new Uint8Array(await file.arrayBuffer()), codes, existing);
      return c.json(preview);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/targets/import", async (c) => {
    try {
      const form = await c.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请上传 file 字段");
      if (file.size > 2_000_000) throw new Error("文件不能超过 2MB");
      const countries = await c.env.DB.prepare("SELECT id, code FROM countries").all<{ id: string; code: string }>();
      const byCode = new Map(countries.results.map((country) => [country.code, country.id]));
      const existing = await loadExistingTargets(c.env.DB);
      const name = file.name.toLowerCase();
      const preview = name.endsWith(".csv")
        ? previewCsv(await file.text(), countries.results.map((country) => country.code), existing)
        : previewXlsx(new Uint8Array(await file.arrayBuffer()), countries.results.map((country) => country.code), existing);
      if (preview.rows.length === 0) throw new Error("文件里没有数据行");
      if (preview.rows.length > 5000) throw new Error("一次最多导入 5000 行");
      const failed = preview.rows.find((row) => row.errors.length > 0);
      if (failed) throw new Error(`第 ${failed.line} 行${failed.errors[0]}`);
      const counts = await applyTargetImport(c.env.DB, preview.rows, byCode, existing);
      return c.json({ imported: preview.rows.length, ...counts });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/recipients", async (c) => {
    const rows = await c.env.DB.prepare("SELECT id, email, enabled, created_at FROM recipients ORDER BY email").all();
    return c.json({ recipients: rows.results });
  });

  app.post("/api/recipients", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const email = requireString(body.email, "邮箱").toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        "INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)",
      ).bind(id, email, new Date().toISOString()).run();
      return c.json({ id }, 201);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.patch("/api/recipients/:id", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      if (typeof body.enabled !== "boolean") throw new Error("缺少 enabled");
      await c.env.DB.prepare("UPDATE recipients SET enabled = ? WHERE id = ?")
        .bind(body.enabled ? 1 : 0, c.req.param("id")).run();
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/recipients/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM recipients WHERE id = ?").bind(c.req.param("id")).run();
    return c.json({ ok: true });
  });

  app.post("/api/email/test", async (c) => {
    try {
      let to: string | undefined;
      if ((c.req.header("content-type") ?? "").includes("application/json")) {
        const body = await readJson(c.req.raw);
        if (body.to != null && typeof body.to !== "string") throw new Error("收件人必须是邮箱");
        to = typeof body.to === "string" ? body.to : undefined;
      }
      const result = await sendTestEmail(c.env, { to });
      return c.json({ ok: true, ...result });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/email-log", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const requestedSize = Number(c.req.query("pageSize"));
    const pageSize = requestedSize === 50 || requestedSize === 100 ? requestedSize : 20;
    const requestedPage = Number(c.req.query("page"));
    const page = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.floor(requestedPage) : 1;
    const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM email_log").first<{ n: number }>();
    const total = totalRow?.n ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount);
    const rows = await c.env.DB.prepare(
      `SELECT id, run_id, kind, recipients, subject, status, error, message_id,
              attachment_mode, attachment_bytes, created_at
       FROM email_log
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).bind(pageSize, (safePage - 1) * pageSize).all();
    const now = new Date();
    return c.json({
      entries: rows.results,
      total,
      page: safePage,
      pageSize,
      timeZone: settings.timeZone,
      utcOffset: utcOffsetLabel(now, settings.timeZone),
    });
  });

  app.get("/api/settings", async (c) => {
    const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const values: Record<string, string> = { ...SETTING_DEFAULTS };
    for (const key of EDITABLE_SETTINGS) {
      if (values[key] === undefined) values[key] = "";
    }
    for (const row of rows.results) values[row.key] = row.value;
    return c.json({ settings: values });
  });

  app.put("/api/settings", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const patch = validateSettingsPatch(body);
      const previous = await loadSettings(c.env.DB);
      if (
        patch.translation_fallback_model
        && patch.translation_fallback_model !== previous.translationFallbackModel
      ) {
        await probeTranslationFallbackModel(c.env.AI, patch.translation_fallback_model);
      }
      const settings = await saveSettings(c.env.DB, patch);
      const refreshed = settings.timeZone !== previous.timeZone
        ? await refreshWorkbook(c.env)
        : { excel: false, excelError: null };
      return c.json({
        ok: true,
        scheduleHour: settings.scheduleHour,
        windowHours: settings.windowHours,
        batchSize: settings.batchSize,
        timeZone: settings.timeZone,
        ...refreshed,
      });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/records", async (c) => {
    try {
      const settings = await loadSettings(c.env.DB);
      const query = buildRecordListQuery({
        view: c.req.query("view"),
        countryId: c.req.query("countryId"),
        target: c.req.query("target"),
        targetId: c.req.query("targetId"),
        source: c.req.query("source"),
        publishedFrom: c.req.query("publishedFrom"),
        publishedTo: c.req.query("publishedTo"),
        relevance: c.req.query("relevance"),
        relevanceMin: c.req.query("relevanceMin"),
        translation: c.req.query("translation"),
        spam: c.req.query("spam"),
        q: c.req.query("q"),
        sort: c.req.query("sort"),
        order: c.req.query("order"),
        page: c.req.query("page"),
        pageSize: c.req.query("pageSize"),
        limit: c.req.query("limit"),
        offset: c.req.query("offset"),
      }, {
        timeZone: settings.timeZone,
        scheduleHour: settings.scheduleHour,
        windowHours: settings.windowHours,
      });
      const rows = await c.env.DB.prepare(
        `${RECORD_LIST_SELECT} WHERE ${query.where} ORDER BY ${query.orderBy} LIMIT ? OFFSET ?`,
      ).bind(...query.binds, query.limit, query.offset).all();
      const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${query.where}`)
        .bind(...query.binds).first<{ n: number }>();
      const now = new Date();
      return c.json({
        records: rows.results,
        total: total?.n ?? 0,
        page: query.page,
        pageSize: query.pageSize,
        timeZone: settings.timeZone,
        utcOffset: utcOffsetLabel(now, settings.timeZone),
      });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.delete("/api/records/:id", async (c) => {
    try {
      const id = c.req.param("id").trim();
      if (!id || id.length > 80) return c.json({ error: "记录不存在" }, 404);
      const deleted = await hideRecords(c.env.DB, [id]);
      if (deleted === 0) return c.json({ error: "记录不存在" }, 404);
      const excel = await refreshWorkbook(c.env);
      return c.json({ deleted, ...excel });
    } catch (error) {
      return jsonError(error, 500);
    }
  });

  app.post("/api/records/interpret", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const mode = body.mode === "selected" || body.mode === "pending" ? body.mode : "";
      if (!mode) throw new Error("mode 必须是 selected 或 pending");
      const ids = mode === "selected" ? parseDeleteIds(body.ids, "解读") : [];
      const result = await interpretStoredRecords(c.env, { mode, ids });
      return c.json(result);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/records/retranslate", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const mode = body.mode === "selected" || body.mode === "failed" ? body.mode : "";
      if (!mode) throw new Error("mode 必须是 selected 或 failed");
      const ids = mode === "selected" ? parseDeleteIds(body.ids, "翻译") : [];
      const result = await retranslateRecords(c.env, { mode, ids });
      return c.json(result);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/records/rescore", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const mode = body.mode === "selected" || body.mode === "unscored" ? body.mode : "";
      if (!mode) throw new Error("mode 必须是 selected 或 unscored");
      const ids = mode === "selected" ? parseDeleteIds(body.ids, "评分") : [];
      const result = await rescoreRecords(c.env, { mode, ids });
      return c.json(result);
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/records/delete", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const ids = parseDeleteIds(body.ids);
      const deleted = await hideRecords(c.env.DB, ids);
      if (deleted === 0) return c.json({ deleted: 0, excel: false, excelError: null });
      const excel = await refreshWorkbook(c.env);
      return c.json({ deleted, ...excel });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/records/delete-matching", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      if (body.confirm !== true) throw new Error("请确认后再删除符合筛选的记录");
      const settings = await loadSettings(c.env.DB);
      const query = buildRecordListQuery(recordListInputFromBody(body), {
        timeZone: settings.timeZone,
        scheduleHour: settings.scheduleHour,
        windowHours: settings.windowHours,
      });
      const deleted = await hideRecordsMatching(c.env.DB, query.where, query.binds);
      if (deleted === 0) return c.json({ deleted: 0, excel: false, excelError: null });
      const excel = await refreshWorkbook(c.env);
      return c.json({ deleted, ...excel });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.post("/api/records/:id/spam", async (c) => {
    try {
      const body = await readJson(c.req.raw);
      const id = c.req.param("id");
      const row = await c.env.DB.prepare(
        "SELECT id, author_handle, author_url, url FROM records WHERE id = ?",
      ).bind(id).first<{ id: string; author_handle: string; author_url: string; url: string }>();
      if (!row) return c.json({ error: "记录不存在" }, 404);
      await c.env.DB.prepare(
        "UPDATE records SET is_spam = 1, exclude_reason = 'spam' WHERE id = ?",
      ).bind(id).run();
      let blocked: string | null = null;
      if (body.blockAuthor === true) {
        blocked = authorBlockKey({
          authorHandle: row.author_handle,
          authorUrl: row.author_url,
          url: row.url,
        });
        if (!blocked) throw new Error("没有可屏蔽的作者");
        const settings = await loadSettings(c.env.DB);
        if (!settings.blockedAccounts.includes(blocked)) {
          await saveSettings(c.env.DB, {
            blocked_accounts: [...settings.blockedAccounts, blocked].join(","),
          });
        }
      }
      return c.json({ ok: true, blocked });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get("/api/export/excel", async (c) => {
    const settings = await loadSettings(c.env.DB);
    const runId = c.req.query("run")?.trim() ?? "";
    if (runId) {
      if (!isRunId(runId)) return c.json({ error: "运行不存在" }, 404);
      const run = await c.env.DB.prepare(
        "SELECT id, window_end FROM runs WHERE id = ?",
      ).bind(runId).first<{ id: string; window_end: string }>();
      if (!run) return c.json({ error: "运行不存在" }, 404);
      const object = await c.env.EXPORTS.get(runWindowObjectKey(runId));
      if (!object) return c.json({ error: "这次运行没有新增 Excel" }, 404);
      const filename = runWindowFilename(
        settings.excelKey || c.env.EXCEL_FILENAME,
        run.window_end,
        settings.timeZone,
      );
      return new Response(object.body, {
        headers: {
          "Content-Type": EXCEL_TYPE,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }
    const object = await c.env.EXPORTS.get(settings.excelKey || c.env.EXCEL_FILENAME);
    if (!object) return c.json({ error: "还没有生成 Excel，请先运行一次或点击重新生成" }, 404);
    return new Response(object.body, {
      headers: {
        "Content-Type": EXCEL_TYPE,
        "Content-Disposition": `attachment; filename="${settings.excelKey || "skyeyes.xlsx"}"`,
      },
    });
  });

  app.post("/api/export/excel", async (c) => {
    try {
      const settings = await loadSettings(c.env.DB);
      const stored = await storeExcel(c.env, settings);
      return c.json({ ok: true, key: stored.key, bytes: stored.bytes.byteLength, truncated: stored.truncated });
    } catch (error) {
      return jsonError(error, 500);
    }
  });

  app.post("/api/runs", async (c) => {
    try {
      let confirm = false;
      if ((c.req.header("content-type") ?? "").includes("application/json")) {
        const body = await readJson(c.req.raw);
        confirm = body.confirm === true;
      }
      const started = await startManualRun(c.env, new Date(), { confirm });
      return c.json(started, 202);
    } catch (error) {
      if (error instanceof ActiveRunError) {
        return c.json({ error: error.message, code: "active_run", activeRunId: error.activeRunId }, 409);
      }
      const message = error instanceof Error ? error.message : "";
      if (/15000|Unknown Internal Error|sendBatch/i.test(message)) {
        return jsonError(new Error(enqueueErrorMessage(error)), 500);
      }
      return jsonError(error, 500);
    }
  });

  app.post("/api/runs/requeue", async (c) => {
    try {
      const result = await requeueStuckBatches(c.env, { includeFailed: true, force: true });
      return c.json(result);
    } catch (error) {
      return jsonError(new Error(enqueueErrorMessage(error)), 500);
    }
  });

  app.post("/api/runs/:id/requeue", async (c) => {
    try {
      const result = await requeueStuckBatches(c.env, { runId: c.req.param("id"), includeFailed: true, force: true });
      return c.json(result);
    } catch (error) {
      return jsonError(new Error(enqueueErrorMessage(error)), 500);
    }
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    try {
      const result = await cancelRun(c.env, c.req.param("id"));
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return jsonError(error, message === "运行不存在" ? 404 : 400);
    }
  });

  app.get("/api/runs", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 30").all();
    return c.json({ runs: rows.results });
  });

  app.get("/api/runs/:id", async (c) => {
    const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(c.req.param("id")).first();
    if (!run) return c.json({ error: "运行不存在" }, 404);
    const batches = await c.env.DB.prepare(
      `SELECT b.*, COALESCE(NULLIF(c.name, ''), '全部') AS country_name FROM batches b
       LEFT JOIN countries c ON c.id = b.country_id WHERE b.run_id = ? ORDER BY b.batch_index`,
    ).bind(c.req.param("id")).all();
    return c.json({ run, batches: batches.results });
  });

  app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
