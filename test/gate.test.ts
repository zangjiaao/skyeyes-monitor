import { describe, expect, it } from "vitest";
import {
  decideAdmission,
  isRepublish,
  normalizeTitle,
  ruleRejectReason,
  sampleRecord,
  type FilterRules,
} from "../src/domain/gate";
import { parseRelevanceScore } from "../src/domain/relevance";
import type { SourceId } from "../src/domain/types";

const window = {
  start: new Date("2026-10-11T02:00:00.000Z"),
  end: new Date("2026-10-12T02:00:00.000Z"),
};
const now = new Date("2026-10-12T02:00:00.000Z");
const rules: FilterRules = {
  minTextLength: 10,
  excludeWords: ["抽奖"],
  blockedAccounts: ["spammer", "ads.example"],
  minFollowers: 100,
  minAccountAgeDays: 30,
  excludeRetweets: true,
  excludeAds: true,
};

function admit(
  source: SourceId,
  partial: Parameters<typeof sampleRecord>[1],
  extra: Partial<Parameters<typeof decideAdmission>[0]> = {},
) {
  const record = sampleRecord(source, partial);
  return decideAdmission({
    publishedAt: record.publishedAt,
    window,
    ruleReason: ruleRejectReason(record, rules, now),
    republish: false,
    relevanceEnabled: true,
    relevanceScore: 80,
    relevanceThreshold: 40,
    ...extra,
  });
}

describe("统一时间门槛", () => {
  it("缺少或无法解析的发布时间不进入日报", () => {
    for (const source of ["x", "google_news", "gdelt"] as const) {
      expect(admit(source, { publishedAt: null }).action).toBe("store_only");
      expect(admit(source, { publishedAt: null }).excludeReason).toBe("time:unknown");
      expect(admit(source, { publishedAt: "明天" }).action).toBe("store_only");
    }
  });

  it("窗口外的条目对每个来源都丢弃", () => {
    for (const source of ["x", "google_news", "gdelt"] as const) {
      const outside = admit(source, { publishedAt: "2024-09-20T07:00:00.000Z" });
      const inside = admit(source, { publishedAt: "2026-10-11T06:00:00.000Z" });
      expect(outside).toMatchObject({ action: "drop", timeStatus: "out_of_window" });
      expect(inside.action).toBe("deliver");
    }
  });
});

describe("旧文重发", () => {
  it("相同链接或近似标题已存在时不算新内容", () => {
    const title = normalizeTitle("OpenAI 发布新模型\n更多背景");
    const near = normalizeTitle("OpenAI 发布新模型！");
    const existing = [{
      urlKey: "https://publisher.example/story",
      titleKey: title,
      publishedAt: "2024-01-01T00:00:00.000Z",
    }];
    const fuzzyExisting = [{
      urlKey: "https://publisher.example/old",
      titleKey: normalizeTitle("国务院发布新的经济数据解读"),
      publishedAt: "2025-05-01T00:00:00.000Z",
    }];
    expect(isRepublish({
      urlKey: "https://news.example/republish",
      titleKey: normalizeTitle("国务院发布新的经济数据解读全文"),
    }, fuzzyExisting)).toBe(true);
    expect(isRepublish({ urlKey: "https://news.google.com/rss/articles/new", titleKey: near }, existing)).toBe(true);
    expect(isRepublish({ urlKey: "https://publisher.example/story", titleKey: normalizeTitle("完全不同的标题内容在这里") }, existing)).toBe(true);
    expect(isRepublish({
      urlKey: "https://publisher.example/other",
      titleKey: normalizeTitle("另一则关于能源价格的新闻"),
    }, existing)).toBe(false);
    expect(isRepublish({ urlKey: "https://publisher.example/story", titleKey: title }, [{
      urlKey: "https://publisher.example/story",
      titleKey: title,
      publishedAt: null,
    }])).toBe(false);
    expect(admit("google_news", {}, { republish: true, ruleReason: null }).action).toBe("drop");
  });
});

describe("规则过滤", () => {
  it("在入库前丢掉过短、排除词、屏蔽账号、转推、广告、粉丝和账号年龄不足的条目", () => {
    const base = { publishedAt: "2026-10-11T06:00:00.000Z" };
    expect(admit("x", { ...base, text: "太短" }).excludeReason).toBe("rule:short");
    expect(admit("google_news", { ...base, text: "转发抽奖活动，正文足够长。" }).excludeReason).toBe("rule:word");
    expect(admit("x", { ...base, authorHandle: "@Spammer" }).excludeReason).toBe("rule:blocked");
    expect(admit("gdelt", { ...base, url: "https://ads.example/a", authorUrl: "https://ads.example" }).excludeReason).toBe("rule:blocked");
    expect(admit("x", { ...base, isRetweet: true }).excludeReason).toBe("rule:retweet");
    expect(admit("x", { ...base, isAd: true }).excludeReason).toBe("rule:ad");
    expect(admit("x", { ...base, authorFollowers: 12 }).excludeReason).toBe("rule:followers");
    expect(admit("x", { ...base, authorFollowers: null }).excludeReason).toBeNull();
    expect(admit("x", { ...base, authorCreatedAt: "2026-10-01T00:00:00.000Z" }).excludeReason).toBe("rule:account_age");
    expect(admit("x", { ...base, authorCreatedAt: "2020-01-01T00:00:00.000Z" }).excludeReason).toBeNull();
  });
});

describe("相关度阈值", () => {
  it("低于阈值的条目留档但不进入日报，评分失败时仍进入", () => {
    const low = admit("x", {}, { relevanceScore: 20, ruleReason: null });
    const high = admit("x", {}, { relevanceScore: 80, ruleReason: null });
    const missing = admit("x", {}, { relevanceScore: null, ruleReason: null });
    const disabled = admit("x", {}, { relevanceScore: 1, relevanceThreshold: 0, ruleReason: null });
    expect(low).toMatchObject({ action: "store_only", excludeReason: "relevance" });
    expect(high.action).toBe("deliver");
    expect(missing.action).toBe("deliver");
    expect(disabled.action).toBe("deliver");
  });

  it("只接受单独的 0 到 100 整数", () => {
    expect(parseRelevanceScore("72")).toBe(72);
    expect(parseRelevanceScore('{"score": 15}')).toBe(15);
    expect(parseRelevanceScore("大概 80 分")).toBeNull();
    expect(parseRelevanceScore("150")).toBeNull();
  });
});
