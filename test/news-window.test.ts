import { describe, expect, it } from "vitest";
import type { SearchRequest } from "../src/domain/types";
import { rssItemsToRecords } from "../src/sources/google-news";

const request: SearchRequest = {
  targets: [{ id: "t1", kind: "keyword", name: "示例", query: "示例" }],
  window: {
    start: new Date("2026-10-11T02:00:00.000Z"),
    end: new Date("2026-10-12T02:00:00.000Z"),
  },
  countryName: "示例国家甲",
  fetchImpl: fetch,
};

describe("Google News 解析", () => {
  it("保留原始发布时间，缺 pubDate 时留空，由统一门槛决定去留", () => {
    const records = rssItemsToRecords([
      {
        title: "窗口内",
        link: "https://news.example/in",
        pubDate: "Sun, 11 Oct 2026 10:00:00 GMT",
        description: "",
        source: "Example",
      },
      {
        title: "窗口外",
        link: "https://news.example/out",
        pubDate: "Fri, 20 Sep 2024 07:00:00 GMT",
        description: "",
        source: "Example",
      },
      {
        title: "没有时间",
        link: "https://news.example/none",
        pubDate: "",
        description: "",
        source: "Example",
      },
    ], request);
    expect(records.map((record) => [record.url, record.publishedAt])).toEqual([
      ["https://news.example/in", "2026-10-11T10:00:00.000Z"],
      ["https://news.example/out", "2024-09-20T07:00:00.000Z"],
      ["https://news.example/none", null],
    ]);
  });
});
