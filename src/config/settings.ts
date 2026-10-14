import type { SourceId } from "../domain/types";
import { canonicalGoogleNewsEditions, GOOGLE_NEWS_EDITION_LIMIT, parseGoogleNewsEditions } from "../sources/google-news";
import {
  GDELT_MIN_INTERVAL_SEC_DEFAULT,
  GOOGLE_NEWS_MIN_INTERVAL_SEC_DEFAULT,
  normalizeMinIntervalSec,
  normalizeXQps,
  X_QPS_DEFAULT,
  X_QPS_MAX,
  X_QPS_MIN,
} from "../sources/x-rate";

export const SETTING_DEFAULTS: Record<string, string> = {
  schedule_hour: "10",
  window_hours: "24",
  batch_size: "12",
  timezone: "Asia/Shanghai",
  translation_enabled: "1",
  translation_source_lang: "en",
  translation_target_lang: "zh",
  email_enabled: "0",
  email_provider: "resend",
  email_from: "",
  email_from_name: "SkyEyes",
  x_enabled: "1",
  google_news_enabled: "1",
  google_news_editions: "en-US,zh-CN",
  gdelt_enabled: "0",
  excel_key: "skyeyes.xlsx",
  allowed_admin_emails: "",
  app_base_url: "",
  finalize_deadline_minutes: "60",
  x_max_pages: "5",
  x_qps: "0.2",
  gdelt_min_interval_sec: String(GDELT_MIN_INTERVAL_SEC_DEFAULT),
  google_news_min_interval_sec: String(GOOGLE_NEWS_MIN_INTERVAL_SEC_DEFAULT),
  min_text_length: "20",
  exclude_words: "",
  blocked_accounts: "",
  min_followers: "0",
  min_account_age_days: "0",
  exclude_retweets: "1",
  exclude_ads: "1",
  relevance_enabled: "1",
  relevance_threshold: "40",
  ai_provider: "deepseek",
  ai_model: "deepseek-chat",
  ai_enabled: "1",
  queue_concurrency: "4",
};

export const EDITABLE_SETTINGS = Object.keys(SETTING_DEFAULTS);

export interface AppSettings {
  scheduleHour: number;
  windowHours: number;
  batchSize: number;
  timeZone: string;
  translationEnabled: boolean;
  translationSourceLang: string;
  translationTargetLang: string;
  emailEnabled: boolean;
  emailProvider: "resend" | "cloudflare";
  emailFrom: string;
  emailFromName: string;
  sources: Record<SourceId, boolean>;
  googleNewsEditions: string;
  excelKey: string;
  allowedAdminEmails: string[];
  appBaseUrl: string;
  finalizeDeadlineMinutes: number;
  xMaxPages: number;
  xQps: number;
  gdeltMinIntervalSec: number;
  googleNewsMinIntervalSec: number;
  minTextLength: number;
  excludeWords: string[];
  blockedAccounts: string[];
  minFollowers: number;
  minAccountAgeDays: number;
  excludeRetweets: boolean;
  excludeAds: boolean;
  relevanceEnabled: boolean;
  relevanceThreshold: number;
  aiProvider: "deepseek" | "workers";
  aiModel: string;
  aiEnabled: boolean;
  queueConcurrency: number;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true";
}

export function parseTermList(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(/[\n,;，]+/)) {
    const term = part.trim().toLowerCase();
    if (term) seen.add(term);
  }
  return [...seen];
}

function parseEmails(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const part of value.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseSettings(raw: Record<string, string>): AppSettings {
  const merged = { ...SETTING_DEFAULTS, ...raw };
  const timeZone = isValidTimeZone(merged.timezone) ? merged.timezone : "Asia/Shanghai";
  const provider = merged.email_provider === "cloudflare" ? "cloudflare" : "resend";
  return {
    scheduleHour: clampInt(merged.schedule_hour, 10, 0, 23),
    windowHours: clampInt(merged.window_hours, 24, 1, 168),
    batchSize: clampInt(merged.batch_size, 12, 1, 40),
    timeZone,
    translationEnabled: flag(merged.translation_enabled, true),
    translationSourceLang: merged.translation_source_lang || "en",
    translationTargetLang: merged.translation_target_lang || "zh",
    emailEnabled: flag(merged.email_enabled, false),
    emailProvider: provider,
    emailFrom: merged.email_from.trim(),
    emailFromName: merged.email_from_name.trim() || "SkyEyes",
    sources: {
      x: flag(merged.x_enabled, true),
      google_news: flag(merged.google_news_enabled, true),
      gdelt: flag(merged.gdelt_enabled, false),
    },
    googleNewsEditions: canonicalGoogleNewsEditions(merged.google_news_editions),
    excelKey: merged.excel_key.trim() || "skyeyes.xlsx",
    allowedAdminEmails: parseEmails(merged.allowed_admin_emails),
    appBaseUrl: merged.app_base_url.replace(/\/$/, ""),
    finalizeDeadlineMinutes: clampInt(merged.finalize_deadline_minutes, 60, 15, 180),
    xMaxPages: clampInt(merged.x_max_pages, 5, 1, 10),
    xQps: normalizeXQps(merged.x_qps),
    gdeltMinIntervalSec: normalizeMinIntervalSec(merged.gdelt_min_interval_sec, GDELT_MIN_INTERVAL_SEC_DEFAULT, 1, 300),
    googleNewsMinIntervalSec: normalizeMinIntervalSec(merged.google_news_min_interval_sec, GOOGLE_NEWS_MIN_INTERVAL_SEC_DEFAULT, 0, 60),
    minTextLength: clampInt(merged.min_text_length, 20, 0, 500),
    excludeWords: parseTermList(merged.exclude_words),
    blockedAccounts: parseTermList(merged.blocked_accounts),
    minFollowers: clampInt(merged.min_followers, 0, 0, 10_000_000),
    minAccountAgeDays: clampInt(merged.min_account_age_days, 0, 0, 3650),
    excludeRetweets: flag(merged.exclude_retweets, true),
    excludeAds: flag(merged.exclude_ads, true),
    relevanceEnabled: flag(merged.relevance_enabled, true),
    relevanceThreshold: clampInt(merged.relevance_threshold, 40, 0, 100),
    aiProvider: merged.ai_provider === "workers" ? "workers" : "deepseek",
    aiModel: merged.ai_model.trim() || "deepseek-chat",
    aiEnabled: flag(merged.ai_enabled, true),
    queueConcurrency: clampInt(merged.queue_concurrency, 4, 1, 8),
  };
}

export function validateSettingsPatch(patch: Record<string, unknown>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTINGS.includes(key)) {
      throw new Error(`未知配置项 ${key}`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`配置项 ${key} 类型不正确`);
    }
    next[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value).trim();
  }
  if (next.timezone && !isValidTimeZone(next.timezone)) {
    throw new Error("时区无效");
  }
  if (next.email_provider && next.email_provider !== "resend" && next.email_provider !== "cloudflare") {
    throw new Error("邮件服务只能是 resend 或 cloudflare");
  }
  if (next.schedule_hour) {
    const hour = Number(next.schedule_hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("运行小时必须是 0 到 23");
  }
  if (next.window_hours) {
    const hours = Number(next.window_hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("时间窗口必须是 1 到 168 小时");
  }
  if (next.batch_size) {
    const size = Number(next.batch_size);
    if (!Number.isInteger(size) || size < 1 || size > 40) throw new Error("批次大小必须是 1 到 40");
  }
  if (next.email_from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email_from)) {
    throw new Error("发件人邮箱格式不正确");
  }
  if (next.allowed_admin_emails) {
    for (const email of parseEmails(next.allowed_admin_emails)) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`管理员邮箱格式不正确: ${email}`);
    }
    next.allowed_admin_emails = parseEmails(next.allowed_admin_emails).join(",");
  }
  assertInt(next.min_text_length, 0, 500, "最短正文长度必须是 0 到 500");
  assertInt(next.min_followers, 0, 10_000_000, "最少粉丝数必须是 0 到 10000000，0 表示不限制");
  assertInt(next.min_account_age_days, 0, 3650, "最少账号天数必须是 0 到 3650，0 表示不限制");
  assertInt(next.relevance_threshold, 0, 100, "相关度阈值必须是 0 到 100，0 表示不因分数排除");
  assertInt(next.queue_concurrency, 1, 8, "同时采集批次数必须是 1 到 8");
  if (next.ai_provider && next.ai_provider !== "deepseek" && next.ai_provider !== "workers") {
    throw new Error("解读服务只能是 deepseek 或 workers");
  }
  if (next.ai_model !== undefined && next.ai_model !== "" && !/^[A-Za-z0-9._-]{1,64}$/.test(next.ai_model)) {
    throw new Error("模型名只能包含字母、数字、点、下划线和连字符");
  }
  if (next.x_qps !== undefined) {
    if (next.x_qps === "") {
      next.x_qps = String(X_QPS_DEFAULT);
    } else {
      const qps = Number(next.x_qps);
      if (!Number.isFinite(qps) || qps < X_QPS_MIN || qps > X_QPS_MAX) {
        throw new Error("X 每秒请求数必须是 0.1 到 20。未付费账号请保持 0.2，充值后最高可到 20");
      }
      next.x_qps = String(Math.round(qps * 100) / 100);
    }
  }
  if (next.gdelt_min_interval_sec !== undefined) {
    assertInt(next.gdelt_min_interval_sec, 1, 300, "GDELT 最小间隔必须是 1 到 300 秒");
    if (next.gdelt_min_interval_sec === "") next.gdelt_min_interval_sec = String(GDELT_MIN_INTERVAL_SEC_DEFAULT);
  }
  if (next.google_news_min_interval_sec !== undefined) {
    assertInt(next.google_news_min_interval_sec, 0, 60, "Google News 最小间隔必须是 0 到 60 秒，0 表示不限速");
    if (next.google_news_min_interval_sec === "") next.google_news_min_interval_sec = String(GOOGLE_NEWS_MIN_INTERVAL_SEC_DEFAULT);
  }
  if (next.google_news_editions !== undefined) {
    const parsed = parseGoogleNewsEditions(next.google_news_editions);
    if (parsed.invalid.length > 0) {
      throw new Error(`无法识别的 Google News 版本：${parsed.invalid.join("、")}。写成 en-US、zh-CN、en-PK 或 ar`);
    }
    if (parsed.editions.length === 0) throw new Error("至少填写一个 Google News 版本，例如 en-US,zh-CN");
    if (next.google_news_editions.split(/[\n,;，]+/).map((part) => part.trim()).filter(Boolean).length > GOOGLE_NEWS_EDITION_LIMIT) {
      throw new Error(`Google News 版本最多 ${GOOGLE_NEWS_EDITION_LIMIT} 个`);
    }
    next.google_news_editions = parsed.editions.map((edition) => edition.id).join(",");
  }
  if (next.exclude_words !== undefined) next.exclude_words = parseTermList(next.exclude_words).join(",");
  if (next.blocked_accounts !== undefined) next.blocked_accounts = parseTermList(next.blocked_accounts).join(",");
  if ((next.exclude_words?.length ?? 0) > 4000 || (next.blocked_accounts?.length ?? 0) > 4000) {
    throw new Error("过滤词或屏蔽账号过长");
  }
  return next;
}

function assertInt(value: string | undefined, min: number, max: number, message: string): void {
  if (value === undefined || value === "") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(message);
}

export async function loadSettings(db: D1Database): Promise<AppSettings> {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const raw: Record<string, string> = {};
  for (const row of rows.results) raw[row.key] = row.value;
  return parseSettings(raw);
}

export async function saveSettings(db: D1Database, patch: Record<string, string>): Promise<AppSettings> {
  const statements = Object.entries(patch).map(([key, value]) =>
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(key, value),
  );
  if (statements.length > 0) await db.batch(statements);
  return loadSettings(db);
}
