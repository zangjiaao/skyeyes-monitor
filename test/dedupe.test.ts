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

  it("同一篇 Google News 文章忽略 oc、hl 和末尾斜杠", () => {
    const canonical = "https://news.google.com/rss/articles/ART1";
    expect(normalizeUrl("https://news.google.com/rss/articles/ART1?oc=5")).toBe(canonical);
    expect(normalizeUrl("https://news.google.com/articles/ART1/?oc=9&hl=en")).toBe(canonical);
    expect(normalizeUrl("https://news.google.com/rss/articles/ART1/")).toBe(canonical);
  });

  it("缺少链接时跳过，不让整批去重失败", () => {
    const kept = {
      source: "google_news",
      dedupeKey: "google_news:url:https://news.example/ok",
      url: "https://news.example/ok",
    };
    expect(dedupeRecords([
      kept,
      { source: "google_news", dedupeKey: "google_news:url:", url: undefined as unknown as string },
      { source: "google_news", dedupeKey: "google_news:url:", url: "" },
    ])).toEqual([kept]);
  });
});
