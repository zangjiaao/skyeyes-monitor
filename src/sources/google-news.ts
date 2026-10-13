import { buildNewsTermQuery, searchPlan } from "../domain/batch";
import { dedupeRecords, makeDedupeKey } from "../domain/dedupe";
import { cleanText, verifyHit } from "../domain/terms";
import type { CollectedRecord, QueryTarget, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { RateLimitError } from "./x";
import { parseRssItems, type RssItem } from "./xml";

export function rssItemsToRecords(
  items: RssItem[],
  request: SearchRequest,
  attribution?: { target: QueryTarget; term: string },
): CollectedRecord[] {
  return items.flatMap((item) => {
    const text = cleanText([item.title, item.description].filter(Boolean).join("\n"));
    if (!item.link || !text) return [];
    const published = item.pubDate ? new Date(item.pubDate) : null;
    const publishedAt = published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
    return [{
      dedupeKey: makeDedupeKey("google_news", null, item.link),
      source: "google_news" as const,
      externalId: null,
      url: item.link,
      countryName: request.countryName,
      matchedTargetId: attribution?.target.id ?? null,
      matchedTarget: attribution?.target.name ?? "批次未精确命中",
      matchedTerm: attribution?.term ?? null,
      authorHandle: "",
      authorName: item.source,
      authorUrl: "",
      text,
      publishedAt,
    }];
  });
}

export const googleNewsProvider: SourceProvider = {
  id: "google_news",
  async search(request: SearchRequest): Promise<SearchResult> {
    const records: CollectedRecord[] = [];
    let calls = 0;
    let filtered = 0;
    for (const step of searchPlan(request.targets)) {
      const query = buildNewsTermQuery(step.target, step.term, request.window);
      if (!query) continue;
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", query);
      url.searchParams.set("hl", "zh-CN");
      url.searchParams.set("gl", "CN");
      url.searchParams.set("ceid", "CN:zh-Hans");
      const response = await request.fetchImpl(url);
      calls += 1;
      if (response.status === 429 || response.status === 503) {
        throw new RateLimitError(`Google News RSS 限流 ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`Google News RSS ${response.status}`);
      }
      const xml = await response.text();
      for (const item of parseRssItems(xml)) {
        let converted: CollectedRecord[] = [];
        try {
          converted = rssItemsToRecords([item], request, { target: step.target, term: step.term });
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
