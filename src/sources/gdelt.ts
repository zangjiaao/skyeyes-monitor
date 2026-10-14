import { packGdeltQueries } from "../domain/batch";
import { dedupeRecords, makeDedupeKey } from "../domain/dedupe";
import { cleanText, verifyHit } from "../domain/terms";
import { formatGdelt } from "../domain/time";
import type { CollectedRecord, QueryTarget, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { RateLimitError } from "./x";
import { gdeltRetryDelaySeconds, parseRetryAfter } from "./x-rate";

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  sourcecountry?: string;
}

function parseSeendate(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function gdeltArticlesToRecords(
  articles: GdeltArticle[],
  request: SearchRequest,
  attribution?: { target: QueryTarget; term: string },
): CollectedRecord[] {
  return articles.flatMap((article) => {
    const url = article.url?.trim() ?? "";
    const text = cleanText(article.title?.trim() ?? "");
    if (!url || !text) return [];
    return [{
      dedupeKey: makeDedupeKey("gdelt", null, url),
      source: "gdelt" as const,
      externalId: null,
      url,
      countryName: request.countryName,
      matchedTargetId: attribution?.target.id ?? null,
      matchedTarget: attribution?.target.name ?? "批次未精确命中",
      matchedTerm: attribution?.term ?? null,
      authorHandle: "",
      authorName: article.domain?.trim() || article.sourcecountry?.trim() || "",
      authorUrl: article.domain ? `https://${article.domain}` : "",
      text,
      publishedAt: parseSeendate(article.seendate),
    }];
  });
}

function attributeTerm(text: string, target: QueryTarget, terms: string[]): string | null {
  const scoped = { ...target, terms, query: terms[0] ?? target.query };
  const hits = terms
    .map((term) => verifyHit({ text, authorHandle: "", target: scoped, queriedTerm: term }))
    .filter((verdict) => verdict.ok && verdict.term)
    .sort((left, right) => (right.term?.length ?? 0) - (left.term?.length ?? 0));
  return hits[0]?.term ?? null;
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

export const gdeltProvider: SourceProvider = {
  id: "gdelt",
  async search(request: SearchRequest): Promise<SearchResult> {
    const groups = request.targets.flatMap((target) => packGdeltQueries(target).map((group) => ({ target, group })));
    const records: CollectedRecord[] = [];
    let calls = 0;
    let filtered = 0;
    const resume = request.resume?.source === "gdelt" ? request.resume : null;
    let stepIndex = resume?.step ?? 0;
    for (; stepIndex < groups.length; stepIndex += 1) {
      const { target, group } = groups[stepIndex];
      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", group.query);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", "75");
      url.searchParams.set("startdatetime", formatGdelt(request.window.start));
      url.searchParams.set("enddatetime", formatGdelt(request.window.end));
      if (request.beforeRequest) await request.beforeRequest();
      const response = await request.fetchImpl(url);
      calls += 1;
      if (response.status === 429 || response.status === 503) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"), Date.now());
        const delaySeconds = gdeltRetryDelaySeconds({
          attempt: Math.max(0, (request.queueAttempt ?? 1) - 1),
          retryAfterSeconds,
        });
        const recorded = await noteRateLimit(request, response.status, retryAfterSeconds, delaySeconds);
        throw new RateLimitError(`GDELT 限流 ${response.status}`, {
          delaySeconds,
          retryAfterSeconds,
          recorded,
        });
      }
      if (!response.ok) throw new Error(`GDELT ${response.status}`);
      const payload = await response.json() as { articles?: GdeltArticle[] };
      const articles = Array.isArray(payload.articles) ? payload.articles : [];
      const pageRecords: CollectedRecord[] = [];
      for (const article of articles) {
        let converted: CollectedRecord[] = [];
        try {
          converted = gdeltArticlesToRecords([article], request, { target, term: group.terms[0] ?? "" });
        } catch {
          filtered += 1;
          continue;
        }
        for (const record of converted) {
          const term = attributeTerm(record.text, target, group.terms);
          if (!term) {
            filtered += 1;
            continue;
          }
          pageRecords.push({ ...record, matchedTerm: term });
        }
      }
      const nextResume = { source: "gdelt" as const, step: stepIndex + 1, page: 0, cursor: "" };
      if (request.onPage) {
        await request.onPage({ records: pageRecords, resume: nextResume, calls, filtered });
      } else {
        records.push(...pageRecords);
      }
    }
    return { records: dedupeRecords(records), calls, filtered };
  },
};
