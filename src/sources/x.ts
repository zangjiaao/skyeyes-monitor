import { buildXTermQuery, searchPlan } from "../domain/batch";
import { dedupeRecords, makeDedupeKey } from "../domain/dedupe";
import { cleanText, verifyHit } from "../domain/terms";
import type { CollectedRecord, QueryTarget, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { parseRetryAfter, retryDelaySeconds, shouldWaitInBatch, sleep } from "./x-rate";

const ENDPOINT = "https://api.twitterapi.io/twitter/tweet/advanced_search";

export class RateLimitError extends Error {
  readonly delaySeconds: number;
  readonly retryAfterSeconds: number | null;
  readonly recorded: boolean;

  constructor(message: string, options?: {
    delaySeconds?: number;
    retryAfterSeconds?: number | null;
    recorded?: boolean;
  }) {
    super(message);
    this.name = "RateLimitError";
    this.delaySeconds = options?.delaySeconds ?? 45;
    this.retryAfterSeconds = options?.retryAfterSeconds ?? null;
    this.recorded = options?.recorded ?? false;
  }
}

interface TweetAuthor {
  userName?: string;
  name?: string;
  url?: string;
  followers?: number;
  followersCount?: number;
  followers_count?: number;
  createdAt?: string;
  created_at?: string;
}

interface Tweet {
  id?: string;
  url?: string;
  text?: string;
  lang?: string;
  createdAt?: string;
  author?: TweetAuthor;
  retweeted_tweet?: unknown;
  promoted?: boolean;
  isAd?: boolean;
  is_promoted?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function parseXCreatedAt(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readFollowers(author: TweetAuthor | undefined): number | null {
  const value = author?.followers ?? author?.followersCount ?? author?.followers_count;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tweetsToRecords(
  tweets: Tweet[],
  request: SearchRequest,
  target: QueryTarget,
  term: string,
): CollectedRecord[] {
  const records: CollectedRecord[] = [];
  for (const tweet of tweets) {
    const id = tweet.id?.trim() ?? "";
    const url = tweet.url?.trim() || (id ? `https://x.com/i/status/${id}` : "");
    const text = cleanText(tweet.text?.trim() ?? "");
    if (!url || !text) continue;
    const handle = tweet.author?.userName?.trim() ?? "";
    const matched = { id: target.id, name: target.name };
    const retweet = Boolean(tweet.retweeted_tweet) || /^rt\s+@/i.test(text);
    records.push({
      dedupeKey: makeDedupeKey("x", id || null, url),
      source: "x",
      externalId: id || null,
      url,
      countryName: request.countryName,
      matchedTargetId: matched.id,
      matchedTarget: matched.name,
      matchedTerm: term,
      authorHandle: handle,
      authorName: tweet.author?.name?.trim() ?? "",
      authorUrl: tweet.author?.url?.trim() || (handle ? `https://x.com/${handle}` : ""),
      authorFollowers: readFollowers(tweet.author),
      authorCreatedAt: parseXCreatedAt(tweet.author?.createdAt ?? tweet.author?.created_at),
      isRetweet: retweet,
      isAd: tweet.promoted === true || tweet.isAd === true || tweet.is_promoted === true,
      text,
      publishedAt: parseXCreatedAt(tweet.createdAt),
      sourceLang: tweet.lang?.trim() || null,
    });
  }
  return records;
}

async function noteRateLimit(
  request: SearchRequest,
  status: number,
  retryAfterSeconds: number | null,
  delaySeconds: number,
): Promise<boolean> {
  if (!request.onRateLimit) return false;
  try {
    await request.onRateLimit({ status, retryAfterSeconds, delaySeconds });
    return true;
  } catch {
    return false;
  }
}

export const xProvider: SourceProvider = {
  id: "x",
  async search(request: SearchRequest): Promise<SearchResult> {
    if (!request.apiKey) {
      throw new Error("未配置 TWITTERAPI_IO_KEY");
    }
    const maxPages = request.maxPages ?? 5;
    const records: CollectedRecord[] = [];
    let calls = 0;
    let filtered = 0;
    let waits = 0;
    const pause = request.sleepImpl ?? sleep;
    const plan = searchPlan(request.targets);
    const resume = request.resume?.source === "x" ? request.resume : null;
    let stepIndex = resume?.step ?? 0;
    let pageIndex = resume?.page ?? 0;
    let cursor = resume?.cursor ?? "";
    for (; stepIndex < plan.length; stepIndex += 1) {
      const step = plan[stepIndex];
      const query = buildXTermQuery(step.target, step.term, request.window, {
        excludeRetweets: request.excludeRetweets !== false,
      });
      if (!query) {
        pageIndex = 0;
        cursor = "";
        continue;
      }
      for (; pageIndex < maxPages; pageIndex += 1) {
        const url = new URL(ENDPOINT);
        url.searchParams.set("query", query);
        url.searchParams.set("queryType", "Latest");
        if (cursor) url.searchParams.set("cursor", cursor);
        let response: Response;
        for (;;) {
          if (request.beforeRequest) await request.beforeRequest();
          response = await request.fetchImpl(url, {
            headers: { "X-API-Key": request.apiKey },
          });
          calls += 1;
          if (response.status !== 429 && response.status !== 503) break;
          const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
          const delaySeconds = retryDelaySeconds({
            attempt: (request.queueAttempt ?? 1) - 1 + waits,
            retryAfterSeconds,
          });
          const recorded = await noteRateLimit(request, response.status, retryAfterSeconds, delaySeconds);
          if (shouldWaitInBatch(delaySeconds, waits)) {
            waits += 1;
            await pause(delaySeconds * 1000);
            continue;
          }
          throw new RateLimitError(`twitterapi.io 限流 ${response.status}`, {
            delaySeconds,
            retryAfterSeconds,
            recorded,
          });
        }
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`twitterapi.io ${response.status}: ${detail.slice(0, 300)}`);
        }
        const payload = asRecord(await response.json());
        const tweets = Array.isArray(payload?.tweets) ? payload.tweets as Tweet[] : [];
        const pageRecords: CollectedRecord[] = [];
        for (const record of tweetsToRecords(tweets, request, step.target, step.term)) {
          const verdict = verifyHit({
            text: record.text,
            authorHandle: record.authorHandle,
            target: step.target,
            queriedTerm: step.term,
          });
          if (!verdict.ok || !verdict.term) {
            filtered += 1;
            continue;
          }
          pageRecords.push({ ...record, matchedTerm: verdict.term });
        }
        const hasNext = payload?.has_next_page === true;
        const next = typeof payload?.next_cursor === "string" ? payload.next_cursor : "";
        const finishedTerm = !hasNext || !next || next === cursor;
        const nextResume = finishedTerm
          ? { source: "x" as const, step: stepIndex + 1, page: 0, cursor: "" }
          : { source: "x" as const, step: stepIndex, page: pageIndex + 1, cursor: next };
        if (request.onPage) {
          await request.onPage({ records: pageRecords, resume: nextResume, calls, filtered });
        } else {
          records.push(...pageRecords);
        }
        if (finishedTerm) break;
        cursor = next;
      }
      pageIndex = 0;
      cursor = "";
    }
    return { records: dedupeRecords(records), calls, filtered };
  },
};
