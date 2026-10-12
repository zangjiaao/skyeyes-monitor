import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  COUNTRY_HEADERS,
  SUMMARY_HEADERS,
  buildMonitoringWorkbook,
  sanitizeSheetName,
  workbookToUint8Array,
  type ExcelInputRecord,
} from "../src/excel";

const view = { today: "2026-10-12", yesterday: "2026-10-11" };

function record(overrides: Partial<ExcelInputRecord> & Pick<ExcelInputRecord, "countryCode" | "collectedDate">): ExcelInputRecord {
  return {
    countryName: overrides.countryCode,
    source: "x",
    url: `https://example.com/${overrides.countryCode}/${overrides.collectedDate}`,
    originalText: "hello",
    publishedAt: "2026-10-12T01:00:00.000Z",
    authorHandle: "ada",
    authorName: "Ada",
    authorUrl: "https://x.com/ada",
    matchedTarget: "Ada",
    translationZh: "你好",
    ...overrides,
  };
}

function matrix(workbook: XLSX.WorkBook, name: string): string[][] {
  const sheet = workbook.Sheets[name];
  expect(sheet, name).toBeTruthy();
  const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet!, { header: 1, raw: false, defval: "" });
  return rows.map((row) => row.map((cell) => String(cell)));
}

describe("excel generation", () => {
  const records = [
    record({
      countryCode: "aa",
      countryName: "Alpha",
      collectedDate: "2026-10-12",
      source: "x",
      originalText: "=1+1",
      authorHandle: "alpha_handle",
    }),
    record({
      countryCode: "aa",
      countryName: "Alpha",
      collectedDate: "2026-10-11",
      source: "web",
      url: "https://news.example/old",
      publishedAt: "2026-10-11T03:00:00.000Z",
    }),
    record({
      countryCode: "bb",
      countryName: "Beta",
      collectedDate: "2026-10-01",
      source: "web",
      url: "https://news.example/older",
      originalText: "x".repeat(40_000),
    }),
  ];

  const workbook = buildMonitoringWorkbook(records, [
    { code: "aa", name: "Alpha" },
    { code: "bb", name: "Beta" },
    { code: "cc", name: "Gamma" },
  ], view);

  it("writes a summary, today, yesterday, and one sheet per country that has rows", () => {
    expect(workbook.SheetNames.slice(0, 3)).toEqual(["总览", "今日", "昨日"]);
    expect(workbook.SheetNames).toContain("Alpha");
    expect(workbook.SheetNames).toContain("Beta");
    expect(workbook.SheetNames).not.toContain("Gamma");

    const summary = matrix(workbook, "总览");
    expect(summary[0]).toEqual([...SUMMARY_HEADERS]);
    expect(summary.find((row) => row[0] === "aa")).toEqual(["aa", "Alpha", "2", "1", "1"]);
    expect(summary.find((row) => row[0] === "bb")).toEqual(["bb", "Beta", "1", "0", "0"]);
    expect(summary.find((row) => row[0] === "cc")).toEqual(["cc", "Gamma", "0", "0", "0"]);
  });

  it("marks today and yesterday and keeps older history on the country sheet", () => {
    const today = matrix(workbook, "今日");
    expect(today[0]).toEqual([...COUNTRY_HEADERS]);
    expect(today).toHaveLength(2);
    expect(today[1]?.[2]).toBe("X");
    expect(today[1]?.[3]).toBe("'=1+1");
    expect(today[1]?.[6]).toBe("alpha_handle");
    expect(today[1]?.[12]).toBe("是");

    const yesterday = matrix(workbook, "昨日");
    expect(yesterday).toHaveLength(2);
    expect(yesterday[1]?.[2]).toBe("网页");
    expect(yesterday[1]?.[13]).toBe("是");

    const alpha = matrix(workbook, "Alpha");
    expect(alpha.map((row) => row[11])).toEqual(["收集日期", "2026-10-12", "2026-10-11"]);
    expect(alpha[1]?.[12]).toBe("是");
    expect(alpha[1]?.[13]).toBe("否");
    expect(alpha[2]?.[12]).toBe("否");
    expect(alpha[2]?.[13]).toBe("是");

    const beta = matrix(workbook, "Beta");
    expect(beta[1]?.[3]?.length).toBe(32_000);
    expect(beta[1]?.[12]).toBe("否");
    expect(beta[1]?.[13]).toBe("否");
  });

  it("round-trips a real xlsx file and avoids reserved sheet names", () => {
    const bytes = workbookToUint8Array(workbook);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const opened = XLSX.read(bytes, { type: "array" });
    expect(opened.SheetNames).toContain("总览");
    expect(opened.SheetNames).toContain("Alpha");

    expect(sanitizeSheetName("A/B:C")).toBe("A B C");
    const reserved = buildMonitoringWorkbook(
      [record({ countryCode: "c1", countryName: "今日", collectedDate: "2026-10-12" })],
      [{ code: "c1", name: "今日" }],
      view,
    );
    expect(reserved.SheetNames.filter((name) => name === "今日")).toHaveLength(1);
    expect(reserved.SheetNames).toContain("今日-2");
  });
});
