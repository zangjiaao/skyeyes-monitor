import { describe, expect, it } from "vitest";
import { callDeepseek } from "../src/ai/interpret";
import { parseSettings, validateSettingsPatch } from "../src/config/settings";
import { scoreRelevance } from "../src/domain/relevance";
import type { QueryTarget } from "../src/domain/types";
import {
  beginSourceFetch,
  interpretReservation,
  SubrequestBudget,
  SubrequestBudgetError,
  SUBREQUEST_BUDGET_DEFAULT,
} from "../src/pipeline/subrequest-budget";
import { gdeltProvider } from "../src/sources/gdelt";
import { googleNewsProvider } from "../src/sources/google-news";
import { xProvider } from "../src/sources/x";

const target: QueryTarget = {
  id: "t1",
  kind: "keyword",
  name: "信号",
  query: "alpha signal",
  terms: ["alpha signal", "b".repeat(430)],
  excludeTerms: [],
};

describe("子请求预算", () => {
  it("默认 40，合法范围是 6 到 45", () => {
    expect(parseSettings({}).subrequestBudget).toBe(SUBREQUEST_BUDGET_DEFAULT);
    expect(validateSettingsPatch({ subrequest_budget: "32" }).subrequest_budget).toBe("32");
    expect(validateSettingsPatch({ subrequest_budget: "" }).subrequest_budget).toBe("40");
    expect(() => validateSettingsPatch({ subrequest_budget: "5" })).toThrow(/6 到 45/);
    expect(() => validateSettingsPatch({ subrequest_budget: "50" })).toThrow(/6 到 45/);
    expect(new SubrequestBudget(3).limit).toBe(6);
    expect(new SubrequestBudget(80).limit).toBe(45);
  });

  it("留不下一条完整解读时不发起下一次抓取，也不把次数记上去", () => {
    const budget = new SubrequestBudget(8);
    budget.charge(4);
    expect(() => beginSourceFetch(budget, 5)).toThrow(SubrequestBudgetError);
    expect(budget.used).toBe(4);
    beginSourceFetch(budget, 0);
    expect(budget.used).toBe(5);
    const settings = parseSettings({
      ai_enabled: "1",
      ai_provider: "deepseek",
      translation_enabled: "1",
      relevance_enabled: "1",
    });
    expect(interpretReservation(settings, true)).toBe(5);
    expect(interpretReservation(parseSettings({
      ai_provider: "workers",
      translation_enabled: "1",
      relevance_enabled: "1",
    }), false)).toBe(3);
    expect(interpretReservation(parseSettings({
      ai_enabled: "0",
      translation_enabled: "0",
      relevance_enabled: "0",
    }), true)).toBe(0);
  });

  it("DeepSeek 和相关度评分在预算用尽时不会发出请求", async () => {
    let fetches = 0;
    await expect(callDeepseek({
      apiKey: "test-key",
      model: "deepseek-chat",
      text: "alpha signal coverage continues across the region",
      targetName: "信号",
      terms: ["alpha signal"],
      description: "",
      charge: () => {
        throw new SubrequestBudgetError();
      },
      fetchImpl: async () => {
        fetches += 1;
        return Response.json({});
      },
    })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(fetches).toBe(0);

    let runs = 0;
    await expect(scoreRelevance({
      async run() {
        runs += 1;
        return { response: "80" };
      },
    } as unknown as Ai, "alpha signal coverage continues", "信号", () => {
      throw new SubrequestBudgetError();
    })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(runs).toBe(0);
  });

  it("三个来源都在下一次外呼前停住", async () => {
    const window = {
      start: new Date("2026-10-13T00:00:00.000Z"),
      end: new Date("2026-10-14T00:00:00.000Z"),
    };
    const stopOnSecond = () => {
      let gates = 0;
      let fetches = 0;
      return {
        get fetches() {
          return fetches;
        },
        beforeRequest: async () => {
          gates += 1;
          if (gates === 2) throw new SubrequestBudgetError();
        },
        fetchImpl: async () => {
          fetches += 1;
          return Response.json({ articles: [], tweets: [], has_next_page: true, next_cursor: "p2" });
        },
      };
    };

    const gdelt = stopOnSecond();
    await expect(gdeltProvider.search({
      targets: [target],
      window,
      countryName: "示例",
      beforeRequest: gdelt.beforeRequest,
      fetchImpl: gdelt.fetchImpl,
    })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(gdelt.fetches).toBe(1);

    const news = stopOnSecond();
    await expect(googleNewsProvider.search({
      targets: [{ ...target, terms: ["alpha signal"] }],
      window,
      countryName: "示例",
      googleNewsEditions: "en-US,zh-CN",
      beforeRequest: news.beforeRequest,
      fetchImpl: async () => {
        news.fetchImpl();
        return new Response(`<?xml version="1.0"?><rss><channel><item>
          <title>alpha signal bulletin covers the northern corridor today</title>
          <link>https://news.example/only</link>
          <pubDate>Tue, 13 Oct 2026 12:00:00 GMT</pubDate>
          <description>alpha signal bulletin covers the northern corridor today</description>
        </item></channel></rss>`);
      },
    })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(news.fetches).toBe(1);

    const x = stopOnSecond();
    await expect(xProvider.search({
      targets: [{ ...target, terms: ["alpha signal"] }],
      window,
      countryName: "示例",
      apiKey: "test-key",
      maxPages: 3,
      beforeRequest: x.beforeRequest,
      fetchImpl: x.fetchImpl,
    })).rejects.toBeInstanceOf(SubrequestBudgetError);
    expect(x.fetches).toBe(1);
  });
});
