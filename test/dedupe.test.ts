import { describe, expect, it } from "vitest";
import { dedupeRecords, makeDedupeKey, normalizeUrl } from "../src/domain/dedupe";

describe("去重", () => {
  it("同一帖子 id 或同一链接只保留一条", () => {
    const first = {
      source: "x",
      dedupeKey: makeDedupeKey("x", "100", "https://x.com/a/status/100"),
      url: "https://x.com/a/status/100",
    };
    const sameId = {
      source: "x",
      dedupeKey: makeDedupeKey("x", "100", "https://x.com/a/status/100?utm_source=share"),
      url: "https://x.com/a/status/100?utm_source=share",
    };
    const sameUrlDifferentId = {
      source: "x",
      dedupeKey: makeDedupeKey("x", "200", "https://x.com/a/status/100"),
      url: "https://x.com/a/status/100/",
    };
    const other = {
      source: "google_news",
      dedupeKey: makeDedupeKey("google_news", null, "https://news.example/story"),
      url: "https://news.example/story",
    };
    expect(dedupeRecords([first, sameId, sameUrlDifferentId, other])).toEqual([first, other]);
  });

  it("去掉跟踪参数后再比较链接", () => {
    expect(normalizeUrl("https://Example.com/a/?utm_medium=rss&id=1"))
      .toBe("https://example.com/a?id=1");
  });
});
