import { normalizeUrl } from "./dedupe";
import type { CollectedRecord, SourceId, TimeWindow } from "./types";

export const DELIVERABLE_SQL =
  "deleted_at IS NULL AND time_status = 'in_window' AND is_spam = 0 AND COALESCE(exclude_reason, '') = '' AND published_at IS NOT NULL AND published_at <> ''";

export type TimeStatus = "in_window" | "unknown" | "out_of_window";
export type AdmissionAction = "deliver" | "store_only" | "drop";

export interface FilterRules {
  minTextLength: number;
  excludeWords: string[];
  blockedAccounts: string[];
  minFollowers: number;
  minAccountAgeDays: number;
  excludeRetweets: boolean;
  excludeAds: boolean;
}

export interface ExistingIdentity {
  urlKey: string;
  titleKey: string;
  publishedAt: string | null;
}

export interface Admission {
  action: AdmissionAction;
  timeStatus: TimeStatus;
  excludeReason: string | null;
}

const TITLE_MIN = 8;

export function classifyPublishTime(publishedAt: string | null | undefined, window: TimeWindow): TimeStatus {
  if (!publishedAt?.trim()) return "unknown";
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  if (parsed < window.start || parsed >= window.end) return "out_of_window";
  return "in_window";
}

export function normalizeTitle(text: string): string {
  const first = text.split(/\r?\n/)[0] ?? text;
  return first
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 120);
}

export function authorBlockKey(input: { authorHandle?: string; authorUrl?: string; url?: string }): string {
  const handle = input.authorHandle?.trim().replace(/^@/, "").toLowerCase() ?? "";
  if (handle) return handle;
  for (const candidate of [input.authorUrl, input.url]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      // 下一条候选地址。
    }
  }
  return "";
}

function levenshtein(left: string, right: string): number {
  const prev = new Array<number>(right.length + 1);
  const curr = new Array<number>(right.length + 1);
  for (let column = 0; column < prev.length; column += 1) prev[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    curr[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      curr[column] = Math.min(curr[column - 1] + 1, prev[column] + 1, prev[column - 1] + cost);
    }
    for (let column = 0; column < prev.length; column += 1) prev[column] = curr[column];
  }
  return prev[right.length] ?? 0;
}

export function titlesNearlyIdentical(left: string, right: string): boolean {
  if (left.length < TITLE_MIN || right.length < TITLE_MIN) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 12 && longer.includes(shorter) && shorter.length / longer.length >= 0.85) return true;
  const a = left.slice(0, 80);
  const b = right.slice(0, 80);
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.2) return false;
  const max = Math.max(a.length, b.length);
  if (max === 0) return false;
  return 1 - levenshtein(a, b) / max >= 0.9;
}

export function isRepublish(
  candidate: { urlKey: string; titleKey: string },
  existing: ExistingIdentity[],
): boolean {
  for (const row of existing) {
    if (!row.publishedAt || Number.isNaN(new Date(row.publishedAt).getTime())) continue;
    const urlMatch = Boolean(candidate.urlKey) && row.urlKey === candidate.urlKey;
    const titleMatch = titlesNearlyIdentical(candidate.titleKey, row.titleKey);
    if (urlMatch || titleMatch) return true;
  }
  return false;
}

function textForRules(record: CollectedRecord): string {
  return record.text.normalize("NFKC").toLowerCase();
}

export function ruleRejectReason(record: CollectedRecord, rules: FilterRules, now: Date): string | null {
  const text = record.text.trim();
  if (text.length < rules.minTextLength) return "rule:short";
  const haystack = textForRules(record);
  for (const word of rules.excludeWords) {
    if (word && haystack.includes(word)) return "rule:word";
  }
  const identity = authorBlockKey(record);
  if (identity && rules.blockedAccounts.includes(identity)) return "rule:blocked";
  if (rules.excludeRetweets && (record.isRetweet || /^rt\s+@/i.test(text))) return "rule:retweet";
  if (rules.excludeAds && record.isAd) return "rule:ad";
  if (rules.minFollowers > 0 && record.authorFollowers != null && record.authorFollowers < rules.minFollowers) {
    return "rule:followers";
  }
  if (rules.minAccountAgeDays > 0 && record.authorCreatedAt) {
    const created = new Date(record.authorCreatedAt);
    if (!Number.isNaN(created.getTime())) {
      const ageDays = (now.getTime() - created.getTime()) / (24 * 60 * 60 * 1000);
      if (ageDays < rules.minAccountAgeDays) return "rule:account_age";
    }
  }
  return null;
}

export function decideAdmission(input: {
  publishedAt: string | null | undefined;
  window: TimeWindow;
  ruleReason: string | null;
  republish: boolean;
  relevanceEnabled: boolean;
  relevanceScore: number | null;
  relevanceThreshold: number;
}): Admission {
  const timeStatus = classifyPublishTime(input.publishedAt, input.window);
  if (timeStatus === "out_of_window") {
    return { action: "drop", timeStatus, excludeReason: "time:out_of_window" };
  }
  if (input.ruleReason) {
    return { action: "drop", timeStatus, excludeReason: input.ruleReason };
  }
  if (timeStatus === "unknown") {
    return { action: "store_only", timeStatus, excludeReason: "time:unknown" };
  }
  if (input.republish) {
    return { action: "drop", timeStatus, excludeReason: "republish" };
  }
  if (
    input.relevanceEnabled
    && input.relevanceScore != null
    && input.relevanceScore < input.relevanceThreshold
  ) {
    return { action: "store_only", timeStatus, excludeReason: "relevance" };
  }
  return { action: "deliver", timeStatus, excludeReason: null };
}

export function urlKeyFor(url: string): string {
  return normalizeUrl(url);
}

export function sampleRecord(source: SourceId, partial: Partial<CollectedRecord> = {}): CollectedRecord {
  return {
    dedupeKey: `${source}:test`,
    source,
    externalId: null,
    url: partial.url ?? `https://example.com/${source}/item`,
    countryName: "示例国家甲",
    matchedTargetId: "t1",
    matchedTarget: "示例目标",
    authorHandle: "",
    authorName: "",
    authorUrl: "",
    text: "这是一条足够长的监测正文，用来通过最短长度。",
    publishedAt: "2026-10-11T06:00:00.000Z",
    ...partial,
  };
}
