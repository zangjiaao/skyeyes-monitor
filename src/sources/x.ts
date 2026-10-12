import { buildXQuery } from "../domain/batch";
import { makeDedupeKey } from "../domain/dedupe";
import { matchTarget } from "../domain/match";
import type { CollectedRecord, SearchRequest, SearchResult, SourceProvider } from "../domain/types";

const ENDPOINT = "https://api.twitterapi.io/twitter/tweet/advanced_search";

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface TweetAuthor {
  userName?: string;
  name?: string;
  url?: string;
}

interface Tweet {
  id?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  author?: TweetAuthor;
  retweeted_tweet?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function parseXCreatedAt(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function tweetsToRecords(tweets: Tweet[], request: SearchRequest): CollectedRecord[] {
  const records: CollectedRecord[] = [];
  for (const tweet of tweets) {
    if (tweet.retweeted_tweet) continue;
    const id = tweet.id?.trim() ?? "";
    const url = tweet.url?.trim() || (id ? `https://x.com/i/status/${id}` : "");
    const text = tweet.text?.trim() ?? "";
    if (!url || !text) continue;
    const handle = tweet.author?.userName?.trim() ?? "";
    const matched = matchTarget(text, handle, request.targets);
    records.push({
      dedupeKey: makeDedupeKey("x", id || null, url),
      source: "x",
      externalId: id || null,
      url,
      countryName: request.countryName,
      matchedTargetId: matched?.id ?? null,
      matchedTarget: matched?.name ?? "批次未精确命中",
      authorHandle: handle,
      authorName: tweet.author?.name?.trim() ?? "",
      authorUrl: tweet.author?.url?.trim() || (handle ? `https://x.com/${handle}` : ""),
      text,
      publishedAt: parseXCreatedAt(tweet.createdAt),
    });
  }
  return records;
}

export const xProvider: SourceProvider = {
  id: "x",
  async search(request: SearchRequest): Promise<SearchResult> {
    if (!request.apiKey) {
      throw new Error("未配置 TWITTERAPI_IO_KEY");
    }
    const query = buildXQuery(request.targets, request.window);
    if (!query) return { records: [], calls: 0 };
    const maxPages = request.maxPages ?? 5;
    const records: CollectedRecord[] = [];
    let calls = 0;
    let cursor = "";
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("query", query);
      url.searchParams.set("queryType", "Latest");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await request.fetchImpl(url, {
        headers: { "X-API-Key": request.apiKey },
      });
      calls += 1;
      if (response.status === 429 || response.status === 503) {
        throw new RateLimitError(`twitterapi.io 限流 ${response.status}`);
      }
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`twitterapi.io ${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = asRecord(await response.json());
      const tweets = Array.isArray(payload?.tweets) ? payload.tweets as Tweet[] : [];
      records.push(...tweetsToRecords(tweets, request));
      const hasNext = payload?.has_next_page === true;
      const next = typeof payload?.next_cursor === "string" ? payload.next_cursor : "";
      if (!hasNext || !next || next === cursor) break;
      cursor = next;
    }
    return { records, calls };
  },
};
