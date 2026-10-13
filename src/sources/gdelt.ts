import { buildGdeltTermQuery, searchPlan } from "../domain/batch";
import { dedupeRecords, makeDedupeKey } from "../domain/dedupe";
import { cleanText, verifyHit } from "../domain/terms";
import { formatGdelt } from "../domain/time";
import type { CollectedRecord, QueryTarget, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { RateLimitError } from "./x";

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

export const gdeltProvider: SourceProvider = {
  id: "gdelt",
  async search(request: SearchRequest): Promise<SearchResult> {
    const records: CollectedRecord[] = [];
    let calls = 0;
    let filtered = 0;
    for (const step of searchPlan(request.targets)) {
      const query = buildGdeltTermQuery(step.target, step.term);
      if (!query) continue;
      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", query);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", "75");
      url.searchParams.set("startdatetime", formatGdelt(request.window.start));
      url.searchParams.set("enddatetime", formatGdelt(request.window.end));
      const response = await request.fetchImpl(url);
      calls += 1;
      if (response.status === 429 || response.status === 503) {
        throw new RateLimitError(`GDELT 限流 ${response.status}`);
      }
      if (!response.ok) throw new Error(`GDELT ${response.status}`);
      const payload = await response.json() as { articles?: GdeltArticle[] };
      const articles = Array.isArray(payload.articles) ? payload.articles : [];
      for (const article of articles) {
        let converted: CollectedRecord[] = [];
        try {
          converted = gdeltArticlesToRecords([article], request, { target: step.target, term: step.term });
        } catch {
          filtered += 1;
          continue;
        }
        for (const record of converted) {
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
          records.push({ ...record, matchedTerm: verdict.term });
        }
      }
    }
    return { records: dedupeRecords(records), calls, filtered };
  },
};
