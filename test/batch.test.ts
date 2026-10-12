import { describe, expect, it } from "vitest";
import { batchTargets, batchTargetsForQuery, buildXQuery } from "../src/domain/batch";
import type { QueryTarget } from "../src/domain/types";

function target(id: string, kind: QueryTarget["kind"], query: string): QueryTarget {
  return { id, kind, name: query, query };
}

describe("查询分批", () => {
  it("按批次大小切分目标", () => {
    const targets = ["a", "b", "c", "d", "e"].map((id) => target(id, "keyword", id));
    const batches = batchTargets(targets, 2);
    expect(batches).toHaveLength(3);
    expect(batches.map((group) => group.map((item) => item.id))).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("把账号和短语合成一条 OR 查询，并用 unix 时间边界", () => {
    const targets = [
      target("1", "handle", "@example_handle"),
      target("2", "organization", "示例机构甲"),
      target("3", "keyword", "示例关键词"),
    ];
    const query = buildXQuery(targets, {
      start: new Date("2026-10-11T02:00:00.000Z"),
      end: new Date("2026-10-12T02:00:00.000Z"),
    });
    expect(query).toContain("from:example_handle");
    expect(query).toContain("\"示例机构甲\"");
    expect(query).toContain(" OR ");
    expect(query).toContain("since_time:1791684000");
    expect(query).toContain("until_time:1791770400");
    expect(query).toContain("-is:retweet");
    expect(query).not.toContain("since:");
  });

  it("查询过长时提前拆批，不超过批次大小", () => {
    const targets = [
      target("1", "keyword", "甲".repeat(80)),
      target("2", "keyword", "乙".repeat(80)),
      target("3", "keyword", "丙"),
      target("4", "keyword", "丁"),
      target("5", "keyword", "戊"),
    ];
    const batches = batchTargetsForQuery(targets, 4, 100);
    expect(batches[0].map((item) => item.id)).toEqual(["1"]);
    expect(batches[1][0]?.id).toBe("2");
    expect(batches.every((group) => group.length <= 4)).toBe(true);
    expect(batches.flat()).toHaveLength(5);
  });
});
