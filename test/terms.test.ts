import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/import/table";
import { termMatches, verifyHit } from "../src/domain/terms";
import type { QueryTarget } from "../src/domain/types";
import { xProvider } from "../src/sources/x";

const window = {
  start: new Date("2026-10-11T02:00:00.000Z"),
  end: new Date("2026-10-12T02:00:00.000Z"),
};

const army: QueryTarget = {
  id: "army",
  kind: "organization",
  name: "俾路支解放军",
  query: "BLA",
  terms: ["BLA", "Balochistan Liberation Army", "俾路支解放军", "Baloch"],
  excludeTerms: ["Biologics License", "bla bla"],
  caseSensitive: true,
};

function page(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("检索词匹配", () => {
  it("短缩写按整词和大小写匹配", () => {
    expect(termMatches("the BLA said", "BLA", false)).toBe(true);
    expect(termMatches("bla bla", "BLA", false)).toBe(false);
    expect(termMatches("blank", "BLA", false)).toBe(false);
    expect(termMatches("BLAND", "BLA", false)).toBe(false);
    expect(termMatches("the bla said", "BLA", true)).toBe(false);
    expect(termMatches("Balochistan Liberation Army", "Baloch", false)).toBe(false);
    expect(termMatches("the Baloch fighters", "Baloch", false)).toBe(true);
    expect(termMatches("报道提到俾路支解放军", "俾路支解放军", false)).toBe(true);
    expect(termMatches("liberation army", "Liberation Army", false)).toBe(true);
    expect(termMatches("liberation army", "Liberation Army", true)).toBe(false);
  });

  it("排除词优先，命中的词来自这次查询而不是别的目标", () => {
    expect(verifyHit({
      text: "The BLA said it claimed an attack",
      authorHandle: "",
      target: army,
      queriedTerm: "BLA",
    })).toEqual({ ok: true, term: "BLA" });
    expect(verifyHit({
      text: "FDA Biologics License Application mentions BLA",
      authorHandle: "",
      target: army,
      queriedTerm: "BLA",
    })).toEqual({ ok: false, term: null });
    expect(verifyHit({
      text: "bla bla is not the group",
      authorHandle: "",
      target: army,
      queriedTerm: "BLA",
    })).toEqual({ ok: false, term: null });
    expect(verifyHit({
      text: "只写了俾路支解放军",
      authorHandle: "",
      target: army,
      queriedTerm: "BLA",
    })).toEqual({ ok: true, term: "俾路支解放军" });
    const front: QueryTarget = {
      id: "front",
      kind: "organization",
      name: "俾路支解放阵地",
      query: "BLF",
      terms: ["BLF"],
    };
    expect(verifyHit({
      text: "The BLA said",
      authorHandle: "",
      target: front,
      queriedTerm: "BLF",
    })).toEqual({ ok: false, term: null });
  });

  it("账号目标按作者归属，正文不必再出现检索词", () => {
    const handle: QueryTarget = {
      id: "h1",
      kind: "handle",
      name: "示例账号",
      query: "example_handle",
      terms: ["example_handle"],
    };
    expect(verifyHit({
      text: "正文里没有账号名",
      authorHandle: "@Example_Handle",
      target: handle,
      queriedTerm: "example_handle",
    })).toEqual({ ok: true, term: "example_handle" });
  });
});

describe("每个目标、每条检索词有自己的页数", () => {
  it("高流量缩写不会吃掉同目标其他词的翻页", async () => {
    const queries: string[] = [];
    const result = await xProvider.search({
      targets: [army, {
        id: "front",
        kind: "organization",
        name: "俾路支解放阵地",
        query: "BLF",
        terms: ["BLF", "Balochistan Liberation Front"],
      }],
      window,
      countryName: "巴基斯坦",
      apiKey: "test-key",
      maxPages: 2,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        const query = url.searchParams.get("query") ?? "";
        queries.push(query);
        const term = query.startsWith('"') ? query.slice(1, query.indexOf('"', 1)) : "BLF";
        const id = String(queries.length);
        return page({
          tweets: [{
            id,
            text: `update ${term}`,
            url: `https://x.com/a/status/${id}`,
            createdAt: "Tue Oct 13 00:00:00 +0000 2026",
          }],
          has_next_page: true,
          next_cursor: `cursor-${id}`,
        });
      },
      beforeRequest: async () => {},
    });
    expect(queries).toHaveLength(12);
    const blaPages = queries.filter((query) => query.startsWith('"BLA"'));
    const chinesePages = queries.filter((query) => query.includes("俾路支解放军"));
    const blfPages = queries.filter((query) => query.startsWith('"BLF"'));
    expect(blaPages).toHaveLength(2);
    expect(chinesePages).toHaveLength(2);
    expect(blfPages).toHaveLength(2);
    expect(blaPages.every((query) => !query.includes("俾路支解放军") && !query.includes("BLF"))).toBe(true);
    expect(result.records.every((record) => record.matchedTargetId === "army" || record.matchedTargetId === "front")).toBe(true);
    const blaHit = result.records.find((record) => record.matchedTerm === "BLA");
    expect(blaHit?.matchedTarget).toBe("俾路支解放军");
    expect(result.records.find((record) => record.text.includes("俾路支解放军"))?.matchedTerm).toBe("俾路支解放军");
    expect(result.records.some((record) => record.matchedTarget === "俾路支解放阵地" && record.matchedTerm === "BLF")).toBe(true);
  });
});

describe("导入多个检索词", () => {
  it("竖线、同名多行会合并成一个目标", () => {
    const rows = parseCsv(`country_code,kind,name,query,exclude,case_sensitive,enabled
pk,organization,俾路支解放军,BLA|Balochistan Liberation Army|俾路支解放军,Biologics License|bla bla,1,1
pk,organization,俾路支解放军,俾路支解放阵地,,1,1
`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      countryCode: "pk",
      kind: "organization",
      name: "俾路支解放军",
      query: "BLA",
      caseSensitive: true,
      terms: ["BLA", "Balochistan Liberation Army", "俾路支解放军", "俾路支解放阵地"],
      excludeTerms: ["Biologics License", "bla bla"],
    });
  });
});
