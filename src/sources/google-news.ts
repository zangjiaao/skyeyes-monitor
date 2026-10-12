import { buildNewsQuery } from "../domain/batch";
import { makeDedupeKey } from "../domain/dedupe";
import { matchTarget } from "../domain/match";
import type { CollectedRecord, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { RateLimitError } from "./x";
import { parseRssItems } from "./xml";

export function rssItemsToRecords(
  items: ReturnType<typeof parseRssItems>,
  request: SearchRequest,
): CollectedRecord[] {
  return items.flatMap((item) => {
    const text = [item.title, item.description].filter(Boolean).join("\n");
    if (!item.link || !text) return [];
    const matched = matchTarget(text, "", request.targets);
    const published = item.pubDate ? new Date(item.pubDate) : null;
    const publishedAt = published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
    return [{
      dedupeKey: makeDedupeKey("google_news", null, item.link),
      source: "google_news" as const,
      externalId: null,
      url: item.link,
      countryName: request.countryName,
      matchedTargetId: matched?.id ?? null,
      matchedTarget: matched?.name ?? "批次未精确命中",
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
    const query = buildNewsQuery(request.targets, request.window);
    if (!query) return { records: [], calls: 0 };
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "zh-CN");
    url.searchParams.set("gl", "CN");
    url.searchParams.set("ceid", "CN:zh-Hans");
    const response = await request.fetchImpl(url);
    if (response.status === 429 || response.status === 503) {
      throw new RateLimitError(`Google News RSS 限流 ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`Google News RSS ${response.status}`);
    }
    const xml = await response.text();
    return { records: rssItemsToRecords(parseRssItems(xml), request), calls: 1 };
  },
};
