import type { AppConfig } from "../config";
import { ProviderError } from "../errors";
import { fetchJson } from "./http";
import { parseGdeltStamp } from "./rss";
import type { ContentProvider, ContentSearch, SearchHit } from "./types";

function gdeltStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class GdeltProvider implements ContentProvider {
  readonly id = "gdelt";
  readonly source = "web" as const;

  constructor(private readonly config: AppConfig) {}

  async search(input: ContentSearch): Promise<SearchHit[]> {
    const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
    url.searchParams.set("query", `(${input.orQuery})`);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("format", "json");
    url.searchParams.set("sort", "datedesc");
    url.searchParams.set("maxrecords", String(this.config.maxWebResults));
    url.searchParams.set("startdatetime", gdeltStamp(input.windowStart));
    url.searchParams.set("enddatetime", gdeltStamp(input.windowEnd));
    const payload = await fetchJson(url.toString(), { headers: { accept: "application/json" } });
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const articles = Array.isArray(record.articles) ? record.articles : [];
    const hits: SearchHit[] = [];
    for (const article of articles) {
      if (typeof article !== "object" || article === null) continue;
      const row = article as Record<string, unknown>;
      const link = asString(row.url);
      const title = asString(row.title);
      if (!link || !title) continue;
      const publishedAt = parseGdeltStamp(asString(row.seendate));
      if (publishedAt) {
        const timestamp = Date.parse(publishedAt);
        if (timestamp < input.windowStart.getTime() || timestamp >= input.windowEnd.getTime()) continue;
      }
      const domain = asString(row.domain);
      hits.push({
        externalId: link,
        url: link,
        text: title,
        publishedAt,
        authorHandle: "",
        authorName: domain,
        authorUrl: domain ? `https://${domain}` : "",
        lang: asString(row.language) || null,
      });
    }
    if (!Array.isArray(record.articles) && articles.length === 0 && typeof record.error === "string") {
      throw new ProviderError("gdelt_error", true);
    }
    return hits;
  }
}
