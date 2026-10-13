import { describe, expect, it } from "vitest";
import { dedupeRecords } from "../src/domain/dedupe";
import { normalizeTitle } from "../src/domain/gate";
import type { SearchRequest } from "../src/domain/types";
import { googleNewsProvider, rssItemsToRecords } from "../src/sources/google-news";
import { parseRssItems } from "../src/sources/xml";

const HYPHEN = "\u2011";

const xml = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title>FDA Accepts BLA</title>
  <link>https://news.google.com/rss/articles/ART1?oc=5</link>
  <guid isPermaLink="false">ART1</guid>
  <pubDate>Mon, 12 Oct 2026 14:40:00 GMT</pubDate>
  <description>FDA Accepts BLA</description>
  <source url="https://finance.yahoo.com">Yahoo</source>
</item>
<item>
  <title>FDA Accepts BLA</title>
  <link>https://news.google.com/rss/articles/ART1?oc=9&amp;hl=en</link>
  <guid isPermaLink="false">ART1</guid>
  <pubDate>Mon, 12 Oct 2026 14:41:00 GMT</pubDate>
  <description>FDA Accepts BLA</description>
  <source url="https://finance.yahoo.com">Yahoo</source>
</item>
<item>
  <title>FDA Biologics License Application</title>
  <link>https://news.google.com/rss/articles/ART9?oc=5</link>
  <pubDate>Mon, 12 Oct 2026 14:42:00 GMT</pubDate>
  <description>FDA Biologics License Application mentions BLA</description>
</item>
<item>
  <title>ACC${HYPHEN}BLA${HYPHEN}ACC 环路</title>
  <link>https://news.google.com/rss/articles/ART2?oc=5 junk and more text that must not enter the key</link>
  <pubDate>Mon, 12 Oct 2026 15:00:00 GMT</pubDate>
  <description>ACC${HYPHEN}BLA${HYPHEN}ACC 环路</description>
</item>
<item>
  <title>Blå</title>
  <link>https://news.google.com/rss/articles/ART3/</link>
  <pubDate>Mon, 12 Oct 2026 15:10:00 GMT</pubDate>
  <description>Blå news</description>
</item>
</channel></rss>`;

const request: SearchRequest = {
  targets: [{
    id: "army",
    kind: "organization",
    name: "俾路支解放军",
    query: "BLA",
    terms: ["BLA"],
    excludeTerms: ["Biologics License"],
    caseSensitive: true,
  }],
  window: {
    start: new Date("2026-10-11T02:00:00.000Z"),
    end: new Date("2026-10-12T02:00:00.000Z"),
  },
  countryName: "巴基斯坦",
  fetchImpl: fetch,
};

describe("Google News 去重", () => {
  it("同一文章不同 oc 合并，链接后的杂文不会变成去重键", () => {
    const items = parseRssItems(xml);
    expect(items.find((item) => item.title.startsWith("ACC"))?.link)
      .toBe("https://news.google.com/rss/articles/ART2?oc=5");
    for (const item of items) expect(() => normalizeTitle(`${item.title}\n${item.description}`)).not.toThrow();
    const records = dedupeRecords(rssItemsToRecords(items, request, {
      target: request.targets[0],
      term: "BLA",
    }));
    const keys = records.map((record) => record.dedupeKey);
    expect(keys.filter((key) => key.includes("ART1"))).toHaveLength(1);
    expect(keys).toContain("google_news:url:https://news.google.com/rss/articles/ART2");
    expect(keys.every((key) => key.length < 200)).toBe(true);
    expect(records.find((record) => record.dedupeKey.includes("ART1"))?.matchedTerm).toBe("BLA");
    expect(records.find((record) => record.dedupeKey.includes("ART1"))?.matchedTarget).toBe("俾路支解放军");
  });

  it("排除词和未命中的标题被滤掉，坏记录不会让整批失败", async () => {
    const result = await googleNewsProvider.search({
      ...request,
      fetchImpl: async () => new Response(xml),
    });
    expect(result.calls).toBe(1);
    expect(result.records.map((record) => record.url).sort()).toEqual([
      "https://news.google.com/rss/articles/ART1?oc=5",
      "https://news.google.com/rss/articles/ART2?oc=5",
    ]);
    expect(result.filtered).toBeGreaterThan(0);
    expect(result.records.every((record) => record.matchedTargetId === "army" && record.matchedTerm === "BLA")).toBe(true);
    const broken = await googleNewsProvider.search({
      ...request,
      fetchImpl: async () => new Response("<rss><channel><item><title>BLA</title><link>not a url</link></item></channel></rss>"),
    });
    expect(broken.records).toEqual([]);
  });
});
