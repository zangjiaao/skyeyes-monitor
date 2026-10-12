import { describe, expect, it } from "vitest";
import { rssItemsToRecords } from "../src/sources/google-news";
import type { SearchRequest } from "../src/domain/types";

const request: SearchRequest = {
  targets: [{ id: "t1", kind: "keyword", name: "示例", query: "示例" }],
  window: {
    start: new Date("2026-10-11T02:00:00.000Z"),
    end: new Date("2026-10-12T02:00:00.000Z"),
  },
  countryName: "示例国家甲",
  fetchImpl: fetch,
};

describe("Google News 时间窗", () => {
  it("丢掉窗口外的条目，保留窗口内的条目", () => {
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
    ], request);
    expect(records.map((record) => record.url)).toEqual(["https://news.example/in"]);
  });
});
