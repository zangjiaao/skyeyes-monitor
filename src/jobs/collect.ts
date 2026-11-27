import { loadSettings } from "../config/settings";
import { getZonedParts, rollingWindow, decideSchedule } from "../domain/time";
import { log, logError } from "../log";
import { ActiveRunError, RunScopeError, parseRunCountryIds, startRun } from "../pipeline/run";

export type JobKind = "schedule" | "manual";

export interface CollectJobRow {
  id: string;
  name: string;
  kind: JobKind;
  enabled: number;
  schedule_hour: number | null;
  window_hours: number | null;
  country_ids: string;
  created_at: string;
  updated_at: string;
}

export interface CollectJobInput {
  name: string;
  kind: JobKind;
  enabled: boolean;
  scheduleHour: number | null;
  windowHours: number | null;
  countryIds: string[];
}

export function presentJob(row: CollectJobRow): CollectJobRow & { countryIds: string[] } {
  return { ...row, countryIds: parseStoredCountryIds(row.country_ids) };
}

export function parseStoredCountryIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

function requiredHour(value: unknown): number {
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("运行小时必须是 0 到 23 的整数");
  return hour;
}

function optionalWindow(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error("采集窗口必须是 1 到 168 小时，留空则跟随全局配置");
  return hours;
}

export function parseJobBody(body: Record<string, unknown>): CollectJobInput {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) throw new Error("任务名称需要 1 到 80 字");
  if (body.kind !== "schedule" && body.kind !== "manual") throw new Error("任务类型只能是定时或手动");
  if (typeof body.enabled !== "boolean") throw new Error("请标明任务是否启用");
  const scheduleHour = body.kind === "manual" ? null : requiredHour(body.scheduleHour !== undefined ? body.scheduleHour : body.schedule_hour);
  const windowHours = optionalWindow(body.windowHours !== undefined ? body.windowHours : body.window_hours);
  const countryIds = parseJobCountryIds(body.countryIds !== undefined ? body.countryIds : body.country_ids);
  return { name, kind: body.kind, enabled: body.enabled, scheduleHour, windowHours, countryIds };
}

export function parseJobPatch(body: Record<string, unknown>): Partial<CollectJobInput> {
  const patch: Partial<CollectJobInput> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) throw new Error("任务名称需要 1 到 80 字");
    patch.name = name;
  }
  if (body.kind !== undefined) {
    if (body.kind !== "schedule" && body.kind !== "manual") throw new Error("任务类型只能是定时或手动");
    patch.kind = body.kind;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Error("请标明任务是否启用");
    patch.enabled = body.enabled;
  }
  if (body.scheduleHour !== undefined || body.schedule_hour !== undefined) {
    const raw = body.scheduleHour !== undefined ? body.scheduleHour : body.schedule_hour;
    patch.scheduleHour = raw === null || raw === "" ? null : requiredHour(raw);
  }
  if (body.windowHours !== undefined || body.window_hours !== undefined) {
    patch.windowHours = optionalWindow(body.windowHours !== undefined ? body.windowHours : body.window_hours);
  }
  if (body.countryIds !== undefined || body.country_ids !== undefined) {
    patch.countryIds = parseJobCountryIds(body.countryIds !== undefined ? body.countryIds : body.country_ids);
  }
  if (Object.keys(patch).length === 0) throw new Error("没有要修改的内容");
  return patch;
}

export function parseJobCountryIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RunScopeError("请选择至少一个有效分组；采集全部启用分组请留空");
  if (value.length === 0) return [];
  const ids = parseRunCountryIds(value);
  if (!ids) throw new RunScopeError("请选择至少一个有效分组；采集全部启用分组请留空");
  return ids;
}

export async function insertJob(db: D1Database, input: CollectJobInput): Promise<CollectJobRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO collect_jobs (
      id, name, kind, enabled, schedule_hour, window_hours, country_ids, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    input.name,
    input.kind,
    input.enabled ? 1 : 0,
    input.scheduleHour,
    input.windowHours,
    JSON.stringify(input.countryIds),
    now,
    now,
  ).run();
  const row = await db.prepare("SELECT * FROM collect_jobs WHERE id = ?").bind(id).first<CollectJobRow>();
  if (!row) throw new Error("任务没有保存成功");
  return row;
}

export async function updateJob(db: D1Database, id: string, patch: Partial<CollectJobInput>): Promise<CollectJobRow> {
  const current = await db.prepare("SELECT * FROM collect_jobs WHERE id = ?").bind(id).first<CollectJobRow>();
  if (!current) throw new Error("任务不存在");
  const kind = patch.kind ?? current.kind;
  const scheduleHour = kind === "manual" ? null : (patch.scheduleHour !== undefined ? patch.scheduleHour : current.schedule_hour);
  if (kind === "schedule" && scheduleHour == null) throw new Error("请填写每天运行的小时");
  const next: CollectJobInput = {
    name: patch.name ?? current.name,
    kind,
    enabled: patch.enabled ?? current.enabled === 1,
    scheduleHour,
    windowHours: patch.windowHours !== undefined ? patch.windowHours : current.window_hours,
    countryIds: patch.countryIds ?? parseStoredCountryIds(current.country_ids),
  };
  await db.prepare(
    `UPDATE collect_jobs
     SET name = ?, kind = ?, enabled = ?, schedule_hour = ?, window_hours = ?, country_ids = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(
    next.name,
    next.kind,
    next.enabled ? 1 : 0,
    next.scheduleHour,
    next.windowHours,
    JSON.stringify(next.countryIds),
    new Date().toISOString(),
    id,
  ).run();
  const row = await db.prepare("SELECT * FROM collect_jobs WHERE id = ?").bind(id).first<CollectJobRow>();
  if (!row) throw new Error("任务不存在");
  return row;
}

export async function startCollectJob(
  env: Env,
  jobId: string,
  options: { confirm?: boolean; now?: Date; trigger: "schedule" | "manual" },
): Promise<{ runId: string; batches: number; enqueued: number; warning: string | null } | null> {
  const job = await env.DB.prepare("SELECT * FROM collect_jobs WHERE id = ?").bind(jobId).first<CollectJobRow>();
  if (!job) throw new Error("任务不存在");
  if (options.trigger === "schedule" && (job.enabled !== 1 || job.kind !== "schedule" || job.schedule_hour == null)) return null;
  const now = options.now ?? new Date();
  const settings = await loadSettings(env.DB);
  const windowHours = job.window_hours ?? settings.windowHours;
  const countryIds = parseStoredCountryIds(job.country_ids);
  const scope = countryIds.length > 0 ? countryIds : undefined;
  if (options.trigger === "manual") {
    const window = rollingWindow(now, windowHours);
    const started = await startRun(env, {
      trigger: "manual",
      now,
      slotKey: "",
      windowStart: window.start,
      windowEnd: window.end,
      confirm: options.confirm,
      countryIds: scope,
      jobId: job.id,
      jobName: job.name,
    });
    return { runId: started.runId, batches: started.batches, enqueued: started.enqueued, warning: started.warning };
  }
  const decision = decideSchedule(now, {
    timeZone: settings.timeZone,
    scheduleHour: job.schedule_hour ?? settings.scheduleHour,
    windowHours,
  });
  if (!decision.due) return null;
  const started = await startRun(env, {
    trigger: "schedule",
    now,
    slotKey: `job:${job.id}:${decision.slotKey}`,
    windowStart: decision.start,
    windowEnd: decision.end,
    countryIds: scope,
    jobId: job.id,
    jobName: job.name,
  });
  return { runId: started.runId, batches: started.batches, enqueued: started.enqueued, warning: started.warning };
}

export async function runDueCollectJobs(env: Env, now: Date): Promise<void> {
  const settings = await loadSettings(env.DB);
  const hour = getZonedParts(now, settings.timeZone).hour;
  const jobs = await env.DB.prepare(
    "SELECT id, name, schedule_hour FROM collect_jobs WHERE kind = 'schedule' AND enabled = 1 AND schedule_hour = ?",
  ).bind(hour).all<{ id: string; name: string }>();
  for (const job of jobs.results) {
    try {
      const started = await startCollectJob(env, job.id, { now, trigger: "schedule" });
      if (started) log("collect job started", { jobId: job.id, runId: started.runId });
    } catch (error) {
      if (error instanceof ActiveRunError) {
        log("collect job skipped because a run is active", { jobId: job.id, activeRunId: error.activeRunId });
        continue;
      }
      logError("collect job failed", error, { jobId: job.id, jobName: job.name });
    }
  }
}
