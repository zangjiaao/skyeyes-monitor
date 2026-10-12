export interface SearchHit {
  externalId: string;
  url: string;
  text: string;
  publishedAt: string | null;
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  lang: string | null;
}

export interface ContentSearch {
  orQuery: string;
  windowStart: Date;
  windowEnd: Date;
}

export interface ContentProvider {
  readonly id: string;
  readonly source: "x" | "web";
  search(input: ContentSearch): Promise<SearchHit[]>;
}
