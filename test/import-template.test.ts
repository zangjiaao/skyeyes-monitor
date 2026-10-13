import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildTargetTemplateCsv,
  buildTargetTemplateXlsx,
  parseCsv,
  previewCsv,
  previewXlsx,
} from "../src/import/table";

describe("目标导入模板", () => {
  it("CSV 带 BOM 和中文表头，两行示例能再导回来", () => {
    const csv = buildTargetTemplateCsv();
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("国家代码,类型,显示名,检索词");
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      countryCode: "pk",
      kind: "organization",
      name: "俾路支解放军",
      terms: ["Baloch Liberation Army", "Balochistan Liberation Army", "BLA"],
      excludeTerms: ["Biologics License"],
      enabled: true,
      caseSensitive: false,
    });
    expect(rows[1]).toMatchObject({
      kind: "handle",
      name: "俾路支观察",
      terms: ["balochwatch"],
    });
  });

  it("Excel 含填写说明，中文表头和英文表头等价", () => {
    const bytes = buildTargetTemplateXlsx();
    const book = XLSX.read(bytes, { type: "array" });
    expect(book.SheetNames).toEqual(["目标", "填写说明"]);
    const help = XLSX.utils.sheet_to_json<string[]>(book.Sheets["填写说明"], { header: 1 });
    expect(help[1]?.[0]).toBe("国家代码");
    expect(help.some((row) => String(row[2] ?? "").includes("person"))).toBe(true);
    const fromXlsx = previewXlsx(bytes, ["pk"]);
    expect(fromXlsx.errorCount).toBe(0);
    expect(fromXlsx.rows.map((row) => row.name)).toEqual(["俾路支解放军", "俾路支观察"]);

    const english = parseCsv(`country_code,kind,name,terms,exclude_terms,description,enabled,case_sensitive
PK,机构,俾路支解放军,Baloch Liberation Army|BLA,,说明,是,否
`);
    expect(english[0]).toMatchObject({
      countryCode: "pk",
      kind: "organization",
      name: "俾路支解放军",
      terms: ["Baloch Liberation Army", "BLA"],
      enabled: true,
      caseSensitive: false,
      description: "说明",
    });
  });

  it("预览标出未知国家、错误类型、空检索词和重复行", () => {
    const preview = previewCsv(`国家代码,类型,显示名,检索词
pk,organization,俾路支解放军,BLA
xx,nope,坏目标,
pk,organization,俾路支解放军,Balochistan Liberation Army
`, ["pk"]);
    expect(preview.rows.map((row) => row.errors)).toEqual([
      [],
      ["类型无效，只能是 person、organization、keyword、handle", "检索词不能为空", "未知国家代码 xx"],
      [],
    ]);
    expect(preview.rows[2]?.duplicateOf).toBe(2);
    expect(preview.errorCount).toBe(1);
    expect(preview.duplicateCount).toBe(1);
    expect(() => parseCsv("国家代码,类型,显示名,检索词\npk,organization,只有名字,\n")).toThrow(/检索词不能为空/);
  });
});
