import { DELIVERABLE_SQL } from "../domain/gate";
import { closedWindow, getZonedParts, shiftCalendarKey, zonedTimeToUtc } from "../domain/time";
import { SOURCE_IDS } from "../domain/types";

export const PAGE_SIZES = [20, 50, 100] as const;
export const MAX_KEYWORD_LENGTH = 100;

const RECORD_COLUMNS = `id, source, url, country_name, matched_target, matched_term, author_handle, author_name, author_url,
              original_text, published_at, collected_at, translation_zh, translation_status, translation_error,
              relevance_score, relevance_error, ai_summary, ai_reason, ai_event_type, ai_mentions, ai_provider, news_edition,
              exclude_reason, is_spam, time_status`;

export const RECORD_LIST_SELECT = `SELECT ${RECORD_COLUMNS} FROM records`;

export interface RecordListInput {
  view?: string;
  countryId?: string;
  target?: string;
  targetId?: string;
  source?: string;
  publishedFrom?: string;
  publishedTo?: string;
  relevance?: string;
  relevanceMin?: string;
  translation?: string;
  spam?: string;
  q?: string;
  sort?: string;
  order?: string;
  page?: string;
  pageSize?: string;
  limit?: string;
  offset?: string;
}

export interface ScheduleBounds {
  timeZone: string;
  scheduleHour: number;
  windowHours: number;
  now?: Date;
}

export interface RecordListQuery {
  where: string;
  binds: Array<string | number>;
  orderBy: string;
  limit: number;
  offset: number;
  page: number;
  pageSize: number;
}

const FILTER_KEYS = [
  "view",
  "countryId",
  "target",
  "targetId",
  "source",
  "publishedFrom",
  "publishedTo",
  "relevance",
  "relevanceMin",
  "translation",
  "spam",
  "q",
] as const satisfies readonly (keyof RecordListInput)[];

export function recordListInputFromBody(body: Record<string, unknown>): RecordListInput {
  const input: RecordListInput = {};
  for (const key of FILTER_KEYS) {
    const value = body[key];
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      input[key] = String(value);
      continue;
    }
    if (typeof value !== "string") throw new Error("筛选条件无效");
    input[key] = value;
  }
  return input;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function requireToken(value: string, label: string, max = 80): string {
  if (value.length > max) throw new Error(`${label}无效`);
  return value;
}

function calendarDayStart(day: string, timeZone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期格式应为 YYYY-MM-DD");
  const [year, month, date] = day.split("-").map(Number);
  const start = zonedTimeToUtc({ year, month, day: date, hour: 0, minute: 0, second: 0 }, timeZone);
  const parts = getZonedParts(start, timeZone);
  if (parts.year !== year || parts.month !== month || parts.day !== date) throw new Error("日期无效");
  return start.toISOString();
}

function nextCalendarDayStart(day: string, timeZone: string): string {
  const nextKey = shiftCalendarKey(day, 1);
  return calendarDayStart(nextKey, timeZone);
}

function likePattern(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_KEYWORD_LENGTH) throw new Error(`关键词最多 ${MAX_KEYWORD_LENGTH} 字`);
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

function pageWindow(input: RecordListInput): { page: number; pageSize: number; limit: number; offset: number } {
  const pageText = clean(input.page);
  const pageSizeText = clean(input.pageSize);
  if (pageText || pageSizeText) {
    const page = pageText ? Number(pageText) : 1;
    if (!Number.isInteger(page) || page < 1) throw new Error("页码无效");
    if (page > 100_000) throw new Error("页码过大");
    const pageSize = pageSizeText ? Number(pageSizeText) : 20;
    if (!PAGE_SIZES.includes(pageSize as (typeof PAGE_SIZES)[number])) {
      throw new Error("每页条数只能是 20、50 或 100");
    }
    return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
  }
  const limitRaw = Number(clean(input.limit) || 40);
  const offsetRaw = Number(clean(input.offset) || 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 40;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  return { page: Math.floor(offset / limit) + 1, pageSize: limit, limit, offset };
}

export function buildRecordListQuery(input: RecordListInput, schedule: ScheduleBounds): RecordListQuery {
  const clauses = ["deleted_at IS NULL"];
  const binds: Array<string | number> = [];
  const view = clean(input.view) || "all";
  if (view !== "all" && view !== "today" && view !== "yesterday") throw new Error("视图无效");

  const countryId = clean(input.countryId);
  if (countryId) {
    clauses.push("country_id = ?");
    binds.push(requireToken(countryId, "国家"));
  }

  const targetId = clean(input.targetId);
  const target = clean(input.target);
  if (targetId && target) {
    clauses.push("(matched_target_id = ? OR matched_target = ?)");
    binds.push(requireToken(targetId, "目标"), requireToken(target, "目标", 200));
  } else if (targetId) {
    clauses.push("matched_target_id = ?");
    binds.push(requireToken(targetId, "目标"));
  } else if (target) {
    clauses.push("matched_target = ?");
    binds.push(requireToken(target, "目标", 200));
  }

  const source = clean(input.source);
  if (source) {
    if (!SOURCE_IDS.includes(source as (typeof SOURCE_IDS)[number])) throw new Error("来源无效");
    clauses.push("source = ?");
    binds.push(source);
  }

  if (view === "today" || view === "yesterday") {
    const bounds = closedWindow(schedule.now ?? new Date(), {
      timeZone: schedule.timeZone,
      scheduleHour: schedule.scheduleHour,
      windowHours: schedule.windowHours,
    }, view === "today" ? 0 : 1);
    clauses.push(DELIVERABLE_SQL);
    clauses.push("published_at >= ? AND published_at < ?");
    binds.push(bounds.start.toISOString(), bounds.end.toISOString());
  }

  const publishedFrom = clean(input.publishedFrom);
  const publishedTo = clean(input.publishedTo);
  const fromIso = publishedFrom ? calendarDayStart(publishedFrom, schedule.timeZone) : "";
  const toIso = publishedTo ? nextCalendarDayStart(publishedTo, schedule.timeZone) : "";
  if (fromIso && toIso && fromIso >= toIso) throw new Error("开始日期不能晚于结束日期");
  if (fromIso) {
    clauses.push("published_at >= ?");
    binds.push(fromIso);
  }
  if (toIso) {
    clauses.push("published_at < ?");
    binds.push(toIso);
  }

  const relevance = clean(input.relevance) || "all";
  const relevanceMinText = clean(input.relevanceMin);
  if (relevance === "scored") clauses.push("relevance_score IS NOT NULL");
  else if (relevance === "unscored") clauses.push("relevance_score IS NULL");
  else if (relevance === "below" || relevance === "at_least") {
    if (!/^\d+$/.test(relevanceMinText)) throw new Error("相关度阈值须是 0 到 100 的整数");
    const relevanceMin = Number(relevanceMinText);
    if (relevanceMin > 100) throw new Error("相关度阈值须是 0 到 100 的整数");
    clauses.push(relevance === "below" ? "relevance_score < ?" : "relevance_score >= ?");
    binds.push(relevanceMin);
  } else if (relevance !== "all") {
    throw new Error("相关度筛选无效");
  }

  const translation = clean(input.translation) || "all";
  if (translation === "ok") clauses.push("translation_zh IS NOT NULL AND TRIM(translation_zh) <> ''");
  else if (translation === "failed") clauses.push("translation_status = 'translation_failed'");
  else if (translation === "empty") {
    clauses.push("(translation_zh IS NULL OR TRIM(translation_zh) = '') AND COALESCE(translation_status, '') <> 'translation_failed'");
  } else if (translation !== "all") {
    throw new Error("翻译状态无效");
  }

  const spam = clean(input.spam) || "all";
  if (spam === "spam") clauses.push("(is_spam = 1 OR exclude_reason = 'spam')");
  else if (spam === "not_spam") clauses.push("is_spam = 0 AND COALESCE(exclude_reason, '') <> 'spam'");
  else if (spam !== "all") throw new Error("垃圾筛选无效");

  const keyword = clean(input.q);
  if (keyword) {
    const pattern = likePattern(keyword);
    clauses.push("(original_text LIKE ? ESCAPE '\\' OR translation_zh LIKE ? ESCAPE '\\')");
    binds.push(pattern, pattern);
  }

  const sort = clean(input.sort) || "published";
  const order = clean(input.order) || "desc";
  if (order !== "asc" && order !== "desc") throw new Error("排序方向无效");
  const direction = order === "asc" ? "ASC" : "DESC";
  let orderBy: string;
  if (sort === "published") orderBy = `COALESCE(published_at, collected_at) ${direction}, id ${direction}`;
  else if (sort === "score") orderBy = `relevance_score IS NULL, relevance_score ${direction}, id ${direction}`;
  else throw new Error("排序字段无效");

  const window = pageWindow(input);
  return {
    where: clauses.join(" AND "),
    binds,
    orderBy,
    ...window,
  };
}
