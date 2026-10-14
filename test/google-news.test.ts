import { describe, expect, it } from "vitest";
import { dedupeRecords } from "../src/domain/dedupe";
import { normalizeTitle } from "../src/domain/gate";
import type { SearchRequest } from "../src/domain/types";
import { validateSettingsPatch } from "../src/config/settings";
import { googleNewsProvider, parseGoogleNewsEditions, rssItemsToRecords } from "../src/sources/google-news";
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
  googleNewsEditions: "en-US",
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

  it("默认同时查 en-US 和 zh-CN，按链接和标题合并，并记下版本", async () => {
    const urls: string[] = [];
    const english = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>BLA claims a new attack</title>
        <link>https://news.google.com/rss/articles/EN1?oc=5</link>
        <pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate>
        <description>BLA claims a new attack</description>
        <source url="https://example.com">Example</source>
      </item>
      <item>
        <title>A different BLA report from London</title>
        <link>https://news.google.com/rss/articles/EN2</link>
        <pubDate>Sun, 11 Oct 2026 09:00:00 GMT</pubDate>
        <description>A different BLA report from London</description>
      </item>
    </channel></rss>`;
    const chinese = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>BLA claims a new attack</title>
        <link>https://news.google.com/rss/articles/ZH1?hl=zh-CN</link>
        <pubDate>Sun, 11 Oct 2026 08:05:00 GMT</pubDate>
        <description>BLA claims a new attack</description>
      </item>
      <item>
        <title>俾路支解放军 BLA 宣布行动</title>
        <link>https://news.google.com/rss/articles/ZH2</link>
        <pubDate>Sun, 11 Oct 2026 12:00:00 GMT</pubDate>
        <description>俾路支解放军 BLA 宣布行动</description>
      </item>
    </channel></rss>`;
    const result = await googleNewsProvider.search({
      ...request,
      googleNewsEditions: undefined,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        urls.push(url.toString());
        expect(url.searchParams.get("q")).toContain("after:2026-10-11");
        expect(url.searchParams.get("q")).toContain("before:2026-10-13");
        expect(url.searchParams.get("hl")).toBeTruthy();
        expect(url.searchParams.get("gl")).toBeTruthy();
        expect(url.searchParams.get("ceid")).toBeTruthy();
        return new Response(url.searchParams.get("ceid") === "CN:zh-Hans" ? chinese : english);
      },
    });
    expect(urls.map((value) => new URL(value).searchParams.get("ceid"))).toEqual(["US:en", "CN:zh-Hans"]);
    expect(new URL(urls[0]).searchParams.get("hl")).toBe("en-US");
    expect(new URL(urls[0]).searchParams.get("gl")).toBe("US");
    expect(result.calls).toBe(2);
    const editions = result.records.map((record) => [record.newsEdition, record.sourceLang, record.url]);
    expect(editions).toEqual([
      ["en-US", "en", "https://news.google.com/rss/articles/EN1?oc=5"],
      ["en-US", "en", "https://news.google.com/rss/articles/EN2"],
      ["zh-CN", "zh", "https://news.google.com/rss/articles/ZH2"],
    ]);
    expect(result.records.find((record) => record.url.includes("ZH2"))?.publishedAt).toBe("2026-10-11T12:00:00.000Z");
  });

  it("en-PK 和 ar 会变成各自的 hl、gl、ceid", () => {
    expect(parseGoogleNewsEditions("en-PK, ar").editions).toEqual([
      { id: "en-PK", hl: "en-PK", gl: "PK", ceid: "PK:en", lang: "en" },
      { id: "ar", hl: "ar", gl: "SA", ceid: "SA:ar", lang: "ar" },
    ]);
    expect(parseGoogleNewsEditions("ar-EG").editions).toEqual([
      { id: "ar-EG", hl: "ar", gl: "EG", ceid: "EG:ar", lang: "ar" },
    ]);
    expect(parseGoogleNewsEditions("US:en, zh-CN").editions.map((edition) => edition.ceid)).toEqual(["US:en", "CN:zh-Hans"]);
    expect(parseGoogleNewsEditions("").editions.map((edition) => edition.id)).toEqual(["en-US", "zh-CN"]);
    expect(validateSettingsPatch({ google_news_editions: "en-US, zh-CN, en-PK" }).google_news_editions).toBe("en-US,zh-CN,en-PK");
    expect(() => validateSettingsPatch({ google_news_editions: "everywhere" })).toThrow(/无法识别/);
  });
});
