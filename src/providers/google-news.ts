import type { AppConfig } from "../config";
import { shanghaiDateOffset } from "../time-window";
import { fetchBounded } from "./http";
import { parseRssItems } from "./rss";
import { ProviderError } from "../errors";
import type { ContentProvider, ContentSearch, SearchHit } from "./types";

export class GoogleNewsProvider implements ContentProvider {
  readonly id = "google_news";
  readonly source = "web" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: ContentSearch): Promise<SearchHit[]> {
    const after = shanghaiDateOffset(input.windowStart, -1);
    const before = shanghaiDateOffset(input.windowEnd, 1);
    const expression = `(${input.orQuery}) after:${after} before:${before}`;
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", expression);
    url.searchParams.set("hl", this.config.newsHl);
    url.searchParams.set("gl", this.config.newsGl);
    url.searchParams.set("ceid", this.config.newsCeid);
    const { status, body } = await fetchBounded(url.toString(), { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
    if (status < 200 || status >= 300) {
      throw new ProviderError(`http_${status}`, status === 429 || status >= 500);
    }
    return parseRssItems(body)
      .filter((item) => {
        if (!item.pubDate) return true;
        const timestamp = Date.parse(item.pubDate);
        return timestamp >= input.windowStart.getTime() && timestamp < input.windowEnd.getTime();
      })
      .slice(0, this.config.maxWebResults)
      .map((item) => ({
        externalId: item.link,
        url: item.link,
        text: item.title,
        publishedAt: item.pubDate,
        authorHandle: "",
        authorName: item.sourceName,
        authorUrl: item.sourceUrl,
        lang: null,
      }));
  }
}
