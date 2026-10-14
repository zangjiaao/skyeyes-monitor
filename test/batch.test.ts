import { describe, expect, it } from "vitest";
import {
  batchTargets,
  batchTargetsForQuery,
  buildGdeltTermQuery,
  buildNewsTermQuery,
  buildXTermQuery,
  searchPlan,
} from "../src/domain/batch";
import type { QueryTarget } from "../src/domain/types";

function target(id: string, kind: QueryTarget["kind"], query: string, extra?: Partial<QueryTarget>): QueryTarget {
  return { id, kind, name: query, query, ...extra };
}

const window = {
  start: new Date("2026-10-11T02:00:00.000Z"),
  end: new Date("2026-10-12T02:00:00.000Z"),
};

describe("查询分批", () => {
  it("按批次大小切分任意列表", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => target(id, "keyword", id));
    const batches = batchTargets(targets, 2);
    expect(batches).toHaveLength(3);
    expect(batches.map((group) => group.map((item) => item.id))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("每个目标单独成批，不把多个目标合成一条查询", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => target(id, "keyword", id));
    const batches = batchTargetsForQuery(targets);
    expect(batches).toHaveLength(5);
    expect(batches.every((group) => group.length === 1)).toBe(true);
  });

  it("同一目标的每条检索词各占一次搜索", () => {
    const army = target("army", "organization", "BLA", {
      name: "俾路支解放军",
      terms: ["BLA", "Balochistan Liberation Army", "俾路支解放军"],
    });
    expect(searchPlan([army]).map((step) => step.term)).toEqual([
      "BLA",
      "Balochistan Liberation Army",
      "俾路支解放军",
    ]);
    expect(searchPlan([army]).every((step) => step.target.id === "army")).toBe(true);
  });

  it("单条 X 查询带上该词、排除词和 unix 时间边界", () => {
    const handle = target("1", "handle", "@example_handle");
    const phrase = target("2", "organization", "示例机构甲", {
      excludeTerms: ["Biologics License"],
    });
    const handleQuery = buildXTermQuery(handle, "example_handle", window);
    const phraseQuery = buildXTermQuery(phrase, "示例机构甲", window);
    expect(handleQuery).toContain("from:example_handle");
    expect(handleQuery).toContain("since_time:1791684000");
    expect(handleQuery).toContain("until_time:1791770400");
    expect(handleQuery).toContain("-is:retweet");
    expect(handleQuery).not.toContain(" OR ");
    expect(phraseQuery).toBe(
      '"示例机构甲" -"Biologics License" since_time:1791684000 until_time:1791770400 -is:retweet',
    );
  });

  it("新闻和 GDELT 也按单条检索词加排除", () => {
    const phrase = target("2", "keyword", "BLA", { excludeTerms: ["Biologics License"] });
    expect(buildNewsTermQuery(phrase, "BLA", window)).toBe(
      '"BLA" -"Biologics License" after:2026-10-11 before:2026-10-13',
    );
    expect(buildGdeltTermQuery(phrase, "BLA")).toBe('"BLA" NOT "Biologics License"');
  });
});
