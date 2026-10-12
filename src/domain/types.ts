export const TARGET_KINDS = ["person", "organization", "keyword", "handle"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const SOURCE_IDS = ["x", "google_news", "gdelt"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface QueryTarget {
  id: string;
  kind: TargetKind;
  name: string;
  query: string;
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
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  text: string;
  publishedAt: string | null;
}

export interface SearchRequest {
  targets: QueryTarget[];
  window: TimeWindow;
  countryName: string;
  fetchImpl: typeof fetch;
  apiKey?: string;
  maxPages?: number;
}

export interface SearchResult {
  records: CollectedRecord[];
  calls: number;
}

export interface SourceProvider {
  id: SourceId;
  search(request: SearchRequest): Promise<SearchResult>;
}
