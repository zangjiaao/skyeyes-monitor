import { describe, expect, it } from "vitest";
import { buildGdeltTermQuery, buildNewsTermQuery, buildXTermQuery, packGdeltQueries } from "../src/domain/batch";
import { parseMatchMode, verifyHit } from "../src/domain/terms";
import type { QueryTarget } from "../src/domain/types";
import { buildTargetExportCsv, buildTargetExportXlsx, previewCsv, previewXlsx, type ExistingTarget } from "../src/import/table";

const target: QueryTarget = {
  id: "relations", name: "Relations", kind: "keyword", query: "Taiwan Japan",
  terms: ["Taiwan Japan", "China Pakistan"], matchMode: "all_words",
};
const window = { start: new Date("2026-11-04T00:00:00Z"), end: new Date("2026-11-05T00:00:00Z") };
const hit = (text: string, extra: Partial<QueryTarget> = {}) => verifyHit({
  text, authorHandle: "", target: { ...target, ...extra }, queriedTerm: "Taiwan Japan",
});

describe("匹配方式", () => {
  it.each([
    "Taiwan and Japan strengthen relations", "Japan strengthens ties with Taiwan", "Taiwan–Japan relations",
    "Taiwan\nJapan", "japan discusses taiwan",
  ])("全部词允许顺序、标点和间隔变化：%s", (text) => {
    expect(hit(text)).toEqual({ ok: true, term: "Taiwan Japan" });
  });

  it("不匹配缺少一个词、整词边界错误或跨行拼出的条件", () => {
    for (const text of ["Taiwan news", "Japan news", "Taiwan Japanese relations", "Taiwan Pakistan summit"]) {
      expect(hit(text)).toEqual({ ok: false, term: null });
    }
    expect(hit("Pakistan and China hold talks")).toEqual({ ok: true, term: "China Pakistan" });
  });

  it("旧目标默认连续匹配，显式 phrase 保留原来的行为", () => {
    for (const matchMode of [undefined, "phrase"] as const) {
      expect(hit("Japan strengthens ties with Taiwan", { matchMode }).ok).toBe(false);
      expect(hit("Taiwan Japan relations", { matchMode }).ok).toBe(true);
    }
  });

  it("大小写开关、英文大写缩写和排除短语仍生效", () => {
    expect(hit("japan and taiwan", { caseSensitive: true }).ok).toBe(false);
    expect(hit("Taiwan and Japan trade war", { excludeTerms: ["trade war"] }).ok).toBe(false);
    expect(hit("Taiwan and Japan discuss how war affects trade", { excludeTerms: ["trade war"] }).ok).toBe(true);
    const extra = { terms: ["BLA Pakistan"], query: "BLA Pakistan" };
    expect(hit("Pakistan reports on bla", extra).ok).toBe(false);
    expect(hit("Pakistan reports on BLA", extra).term).toBe("BLA Pakistan");
  });

  it("支持中文空格分词，账号仍按作者匹配", () => {
    expect(hit("日本与台湾举行会谈", { terms: ["台湾 日本"], query: "台湾 日本" }).term).toBe("台湾 日本");
    expect(verifyHit({ text: "any text", authorHandle: "Example_Handle", queriedTerm: "example_handle",
      target: { ...target, kind: "handle", terms: ["example_handle"] },
    })).toEqual({ ok: true, term: "example_handle" });
  });

  it("三种来源使用分开的词查询，GDELT 的多行 AND 条件分别请求", () => {
    expect(buildXTermQuery(target, "Taiwan Japan", window)).toMatch(/^"Taiwan" "Japan" since_time:/);
    expect(buildNewsTermQuery(target, "Taiwan Japan", window)).toBe('"Taiwan" "Japan" after:2026-11-04 before:2026-11-06');
    expect(buildGdeltTermQuery(target, "Taiwan Japan")).toBe('"Taiwan" "Japan"');
    expect(packGdeltQueries(target)).toEqual([
      { query: '"Taiwan" "Japan"', terms: ["Taiwan Japan"] },
      { query: '"China" "Pakistan"', terms: ["China Pakistan"] },
    ]);
    const phrase = { ...target, matchMode: "phrase" as const };
    expect(buildXTermQuery(phrase, "Taiwan Japan", window)).toMatch(/^"Taiwan Japan" since_time:/);
    expect(buildNewsTermQuery(phrase, "Taiwan Japan", window)).toMatch(/^"Taiwan Japan" after:/);
    expect(packGdeltQueries(phrase)[0].query).toBe('("Taiwan Japan" OR "China Pakistan")');
  });

  it("拒绝未知模式，不将空值或拼写错误当作默认模式", () => {
    expect(parseMatchMode(undefined)).toBe("phrase");
    for (const value of [null, "", "any", 1]) expect(() => parseMatchMode(value)).toThrow();
  });
});

const stored: ExistingTarget = {
  id: "target-relations", countryCode: "demo", kind: "keyword", name: "各国关系",
  terms: ["Taiwan Japan", "Taiwan Pakistan"], excludeTerms: [], enabled: true,
  caseSensitive: false, description: "", matchMode: "all_words",
};

describe("匹配方式导入导出", () => {
  it("CSV / Excel 往返保留模式且预览显示无变化", async () => {
    const csv = buildTargetExportCsv([stored]);
    expect(csv).toContain("匹配方式");
    expect(previewCsv(csv, ["demo"], [stored]).rows[0]).toMatchObject({ matchMode: "all_words", action: "unchanged" });
    const xlsx = await buildTargetExportXlsx([stored]);
    expect(previewXlsx(xlsx, ["demo"], [stored]).rows[0]).toMatchObject({ matchMode: "all_words", action: "unchanged" });
    expect(previewCsv(csv.replace("all_words", "phrase"), ["demo"], [stored]).rows[0].action).toBe("update");
  });

  it("旧表未填模式时保留现有模式，未知模式与同名冲突必须报错", () => {
    const old = '目标ID,分组代码,类型,显示名,检索词\ntarget-relations,demo,keyword,各国关系,Taiwan Japan|Taiwan Pakistan\n';
    expect(previewCsv(old, ["demo"], [stored]).rows[0]).toMatchObject({ action: "unchanged" });
    expect(previewCsv(old.replace('检索词\n', '检索词,匹配方式\n').replace('Pakistan\n', 'Pakistan,unknown\n'), ["demo"], [stored]).errorCount).toBe(1);
    const conflict = '分组代码,类型,显示名,检索词,匹配方式\ndemo,keyword,各国关系,Taiwan Japan,all_words\ndemo,keyword,各国关系,Taiwan Pakistan,phrase\n';
    expect(previewCsv(conflict).rows[1].errors).toContain("同一目标的匹配方式不一致");
  });
});
