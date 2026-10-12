import type { AppConfig } from "../config";
import { ProviderError } from "../errors";
import { fetchJson } from "./http";
import type { ContentProvider, ContentSearch, SearchHit } from "./types";

interface RawTweet {
  id?: unknown;
  url?: unknown;
  text?: unknown;
  createdAt?: unknown;
  lang?: unknown;
  isReply?: unknown;
  retweeted_tweet?: unknown;
  author?: {
    userName?: unknown;
    name?: unknown;
    url?: unknown;
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inWindow(publishedAt: string, start: Date, end: Date): boolean {
  const timestamp = Date.parse(publishedAt);
  if (Number.isNaN(timestamp)) return false;
  return timestamp >= start.getTime() && timestamp < end.getTime();
}

/**
 * twitterapi.io advanced search. Swap this class for another X backend by
 * registering a new id in `createProvider`.
 */
export class TwitterApiProvider implements ContentProvider {
  readonly id = "twitterapi_io";
  readonly source = "x" as const;

  constructor(
    private readonly apiKey: string,
    private readonly config: AppConfig,
  ) {}

  async search(input: ContentSearch): Promise<SearchHit[]> {
    if (this.apiKey.length === 0 || this.apiKey === "unused") {
      throw new ProviderError("missing_api_key", false);
    }
    const since = Math.floor(input.windowStart.getTime() / 1000);
    const until = Math.floor(input.windowEnd.getTime() / 1000);
    const suffix = this.config.xQuerySuffix;
    const query = suffix
      ? `(${input.orQuery}) since_time:${since} until_time:${until} ${suffix}`
      : `(${input.orQuery}) since_time:${since} until_time:${until}`;
    if (query.length > this.config.xMaxQueryChars) throw new ProviderError("query_too_long", false);

    const hits: SearchHit[] = [];
    const seenCursors = new Set<string>();
    let cursor = "";
    for (let page = 0; page < this.config.maxSearchPages; page += 1) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      const url = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search");
      url.searchParams.set("query", query);
      url.searchParams.set("queryType", "Latest");
      url.searchParams.set("cursor", cursor);
      const payload = await fetchJson(url.toString(), {
        headers: { "X-API-Key": this.apiKey, accept: "application/json" },
      });
      const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
      const tweets = Array.isArray(record.tweets) ? record.tweets : [];
      for (const item of tweets) {
        const hit = this.toHit(item, input);
        if (hit) hits.push(hit);
      }
      if (record.has_next_page !== true) break;
      const next = asString(record.next_cursor);
      if (next.length === 0) break;
      cursor = next;
    }
    return hits;
  }

  private toHit(value: unknown, input: ContentSearch): SearchHit | null {
    if (typeof value !== "object" || value === null) return null;
    const tweet = value as RawTweet;
    if (tweet.isReply === true) return null;
    if (tweet.retweeted_tweet) return null;
    const externalId = asString(tweet.id);
    const url = asString(tweet.url) || (externalId ? `https://x.com/i/status/${externalId}` : "");
    const text = asString(tweet.text);
    if (!externalId || !url || !text) return null;
    const createdAt = asString(tweet.createdAt);
    const published = createdAt ? new Date(createdAt) : null;
    if (!published || Number.isNaN(published.getTime())) return null;
    const publishedAt = published.toISOString();
    if (!inWindow(publishedAt, input.windowStart, input.windowEnd)) return null;
    const handle = asString(tweet.author?.userName);
    const authorUrl = asString(tweet.author?.url) || (handle ? `https://x.com/${handle}` : "");
    return {
      externalId,
      url,
      text,
      publishedAt,
      authorHandle: handle,
      authorName: asString(tweet.author?.name),
      authorUrl,
      lang: asString(tweet.lang) || null,
    };
  }
}
