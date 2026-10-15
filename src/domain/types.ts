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
  description?: string;
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
  /** X 等来源自带的语言代码。没有时由正文识别。Google News 用版本里的语言作提示。 */
  sourceLang?: string | null;
  /** Google News 的版本，例如 en-US、zh-CN、ar。 */
  newsEdition?: string | null;
}

export interface RateLimitNotice {
  status: number;
  retryAfterSeconds: number | null;
  delaySeconds: number;
}

/** 下次醒来从哪一条检索、哪一页继续。队列延迟不占用 attempts。 */
export interface BatchResume {
  source: SourceId;
  step: number;
  page: number;
  cursor: string;
}

export interface PageCheckpoint {
  records: CollectedRecord[];
  /** 这一页全部入库后，下次从这里继续。 */
  resume: BatchResume;
  /** 这一页还有没解读完的条目时，下次重抓这一页，而不是跳到 resume。 */
  repeatResume?: BatchResume;
  calls: number;
  filtered: number;
}

export interface SearchRequest {
  targets: QueryTarget[];
  window: TimeWindow;
  countryName: string;
  fetchImpl: typeof fetch;
  apiKey?: string;
  maxPages?: number;
  excludeRetweets?: boolean;
  /** Google News 版本列表，逗号分隔。空则用 en-US 和 zh-CN。 */
  googleNewsEditions?: string;
  beforeRequest?: () => Promise<void>;
  onRateLimit?: (info: RateLimitNotice) => Promise<void>;
  onPage?: (page: PageCheckpoint) => Promise<void>;
  resume?: BatchResume | null;
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
