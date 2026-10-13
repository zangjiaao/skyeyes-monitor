import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildTargetExportCsv,
  buildTargetExportXlsx,
  buildTargetTemplateCsv,
  buildTargetTemplateXlsx,
  parseCsv,
  previewCsv,
  previewXlsx,
  type ExistingTarget,
} from "../src/import/table";

const STORED: ExistingTarget[] = [
  {
    id: "target-army",
    countryCode: "pk",
    kind: "organization",
    name: "俾路支解放军",
    terms: ["BLA", "Baloch Liberation Army"],
    excludeTerms: ["Biologics License"],
    description: "说明",
    enabled: true,
    caseSensitive: false,
  },
  {
    id: "target-watch",
    countryCode: "pk",
    kind: "handle",
    name: "俾路支观察",
    terms: ["balochwatch"],
    excludeTerms: [],
    description: "",
    enabled: true,
    caseSensitive: false,
  },
];

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

  it("Excel 含填写说明，中文表头和英文表头等价", async () => {
    const bytes = await buildTargetTemplateXlsx();
    const book = XLSX.read(bytes, { type: "array" });
    expect(book.SheetNames).toEqual(["目标", "填写说明"]);
    const help = XLSX.utils.sheet_to_json<string[]>(book.Sheets["填写说明"], { header: 1 });
    expect(help[1]?.[0]).toBe("目标ID");
    const sheet = book.Sheets["目标"];
    const xml = new TextDecoder().decode(bytes);
    expect(sheet["!autofilter"]?.ref).toBe("A1:I3");
    expect(xml).toContain('<col min="1" max="1" width="38');
    expect(xml).toContain('<col min="9" max="9" width="24');
    expect(xml).toContain('state="frozen"');
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

describe("目标导出后再导入", () => {
  it("CSV 带 BOM，表头与模板一致，原样再导入是无变化", () => {
    const csv = buildTargetExportCsv(STORED);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith("\uFEFF目标ID,国家代码,类型,显示名,检索词")).toBe(true);
    expect(buildTargetTemplateCsv().split("\r\n")[0]).toBe(csv.split("\r\n")[0]);
    const preview = previewCsv(csv, ["pk"], STORED);
    expect(preview.errorCount).toBe(0);
    expect(preview.rows.map((row) => row.action)).toEqual(["unchanged", "unchanged"]);
    expect(preview.rows.map((row) => row.id)).toEqual(["target-army", "target-watch"]);
  });

  it("改显示名是更新，空 ID 是新建，未知 ID 报错", () => {
    const csv = buildTargetExportCsv(STORED);
    const renamed = previewCsv(csv.replace("俾路支解放军", "俾路支解放军改名"), ["pk"], STORED);
    expect(renamed.rows[0]?.action).toBe("update");
    expect(renamed.rows[0]?.name).toBe("俾路支解放军改名");
    expect(renamed.errorCount).toBe(0);

    const created = previewCsv(`目标ID,国家代码,类型,显示名,检索词
,pk,keyword,新目标,hello
`, ["pk"], STORED);
    expect(created.rows[0]).toMatchObject({ id: "", action: "create", name: "新目标" });

    const unknown = previewCsv(`id,country_code,kind,name,terms
missing-id,pk,keyword,新目标,hello
`, ["pk"], STORED);
    expect(unknown.rows[0]?.errors).toContain("未知目标 ID");
    expect(unknown.errorCount).toBe(1);
  });

  it("文件里少一行不会产生删除", () => {
    const csv = buildTargetExportCsv([STORED[0]]);
    const preview = previewCsv(csv, ["pk"], STORED);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]?.action).toBe("unchanged");
    expect(preview.rows.some((row) => (row.action as string) === "delete")).toBe(false);
  });

  it("Excel 导出冻结表头并带填写说明，改检索词后是更新", async () => {
    const bytes = await buildTargetExportXlsx(STORED);
    const book = XLSX.read(bytes, { type: "array" });
    expect(book.SheetNames).toEqual(["目标", "填写说明"]);
    const sheet = book.Sheets["目标"];
    const xml = new TextDecoder().decode(bytes);
    expect(sheet["!autofilter"]?.ref).toBe("A1:I3");
    expect(xml).toContain('<col min="1" max="1" width="38');
    expect(xml).toContain('state="frozen"');
    const preview = previewXlsx(bytes, ["pk"], STORED);
    expect(preview.rows.map((row) => row.action)).toEqual(["unchanged", "unchanged"]);

    const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });
    grid[1][4] = "BLA";
    const edited = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(edited, XLSX.utils.aoa_to_sheet(grid), "目标");
    const editedBytes = new Uint8Array(XLSX.write(edited, { type: "array", bookType: "xlsx" }));
    const updated = previewXlsx(editedBytes, ["pk"], STORED);
    expect(updated.rows[0]?.action).toBe("update");
    expect(updated.rows[0]?.terms).toEqual(["BLA"]);
    expect(updated.rows[1]?.action).toBe("unchanged");
  });
});
