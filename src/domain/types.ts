export const TARGET_KINDS = ["person", "organization", "keyword", "handle"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const SOURCE_IDS = ["x", "google_news", "gdelt"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface QueryTarget {
  id: string;
  kind: TargetKind;
  name: string;
  /** 第一条检索词。完整列表在 terms。 */
  query: string;
  terms?: string[];
  excludeTerms?: string[];
  caseSensitive?: boolean;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface CollectedRecord {
  dedupeKey: string;
  source: SourceId;
  externalId: string | null;
  url: string;
  countryName: string;
  matchedTargetId: string | null;
  matchedTarget: string;
  matchedTerm?: string | null;
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  authorFollowers?: number | null;
  authorCreatedAt?: string | null;
  isRetweet?: boolean;
  isAd?: boolean;
  text: string;
  publishedAt: string | null;
}

export interface RateLimitNotice {
  status: number;
  retryAfterSeconds: number | null;
  delaySeconds: number;
}

export interface SearchRequest {
  targets: QueryTarget[];
  window: TimeWindow;
  countryName: string;
  fetchImpl: typeof fetch;
  apiKey?: string;
  maxPages?: number;
  excludeRetweets?: boolean;
  beforeRequest?: () => Promise<void>;
  onRateLimit?: (info: RateLimitNotice) => Promise<void>;
  sleepImpl?: (ms: number) => Promise<void>;
  queueAttempt?: number;
}

export interface SearchResult {
  records: CollectedRecord[];
  calls: number;
  filtered?: number;
}

export interface SourceProvider {
  id: SourceId;
  search(request: SearchRequest): Promise<SearchResult>;
}
