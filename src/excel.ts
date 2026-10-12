import * as XLSX from "xlsx";

const MAX_CELL = 32_000;

export interface ExcelCountry {
  code: string;
  name: string;
}

export interface ExcelInputRecord {
  countryCode: string;
  countryName: string;
  source: "x" | "web";
  url: string;
  originalText: string;
  publishedAt: string;
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  matchedTarget: string;
  collectedDate: string;
  translationZh: string;
}

export interface WorkbookView {
  today: string;
  yesterday: string;
}

export const SUMMARY_HEADERS = ["国家代码", "国家名称", "累计", "今日", "昨日"] as const;

export const COUNTRY_HEADERS = [
  "国家代码",
  "国家名称",
  "来源",
  "原文",
  "中文译文",
  "发布时间",
  "作者账号",
  "作者显示名",
  "作者主页",
  "链接",
  "命中目标",
  "收集日期",
  "是否今日",
  "是否昨日",
] as const;

const SUMMARY_SHEET = "总览";
const TODAY_SHEET = "今日";
const YESTERDAY_SHEET = "昨日";

export function sanitizeSheetName(input: string): string {
  const cleaned = input.replace(/[\\/?*[\]:]/g, " ").replace(/'/g, " ").trim();
  const sliced = cleaned.slice(0, 31);
  return sliced.length > 0 ? sliced : "country";
}

function uniqueSheetName(preferred: string, used: Set<string>): string {
  const base = sanitizeSheetName(preferred);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("sheet name exhausted");
}

function safeCell(value: string): string {
  const clipped = value.length > MAX_CELL ? value.slice(0, MAX_CELL) : value;
  if (/^[=+\-@]/.test(clipped)) return `'${clipped}`;
  return clipped;
}

function sourceLabel(source: "x" | "web"): string {
  return source === "x" ? "X" : "网页";
}

function recordRow(record: ExcelInputRecord, view: WorkbookView): string[] {
  return [
    safeCell(record.countryCode),
    safeCell(record.countryName),
    sourceLabel(record.source),
    safeCell(record.originalText),
    safeCell(record.translationZh),
    safeCell(record.publishedAt),
    safeCell(record.authorHandle),
    safeCell(record.authorName),
    safeCell(record.authorUrl),
    safeCell(record.url),
    safeCell(record.matchedTarget),
    safeCell(record.collectedDate),
    record.collectedDate === view.today ? "是" : "否",
    record.collectedDate === view.yesterday ? "是" : "否",
  ];
}

function compareRecords(left: ExcelInputRecord, right: ExcelInputRecord): number {
  if (left.collectedDate !== right.collectedDate) return right.collectedDate.localeCompare(left.collectedDate);
  if (left.publishedAt !== right.publishedAt) return right.publishedAt.localeCompare(left.publishedAt);
  return left.url.localeCompare(right.url);
}

export function buildMonitoringWorkbook(
  records: readonly ExcelInputRecord[],
  countries: readonly ExcelCountry[],
  view: WorkbookView,
): XLSX.WorkBook {
  const names = new Map<string, string>();
  for (const country of countries) names.set(country.code, country.name);
  for (const record of records) {
    if (!names.has(record.countryCode)) names.set(record.countryCode, record.countryName);
  }

  const codes = [...names.keys()].sort((left, right) => left.localeCompare(right));
  const workbook = XLSX.utils.book_new();
  const used = new Set<string>([SUMMARY_SHEET, TODAY_SHEET, YESTERDAY_SHEET]);

  const summaryRows: (string | number)[][] = [[...SUMMARY_HEADERS]];
  for (const code of codes) {
    const inCountry = records.filter((record) => record.countryCode === code);
    summaryRows.push([
      code,
      names.get(code) ?? code,
      inCountry.length,
      inCountry.filter((record) => record.collectedDate === view.today).length,
      inCountry.filter((record) => record.collectedDate === view.yesterday).length,
    ]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), SUMMARY_SHEET);

  const todayRows = records.filter((record) => record.collectedDate === view.today).sort(compareRecords);
  const yesterdayRows = records.filter((record) => record.collectedDate === view.yesterday).sort(compareRecords);
  appendRecordSheet(workbook, TODAY_SHEET, todayRows, view);
  appendRecordSheet(workbook, YESTERDAY_SHEET, yesterdayRows, view);

  for (const code of codes) {
    const rows = records.filter((record) => record.countryCode === code).sort(compareRecords);
    if (rows.length === 0) continue;
    const sheetName = uniqueSheetName(names.get(code) ?? code, used);
    appendRecordSheet(workbook, sheetName, rows, view);
  }
  return workbook;
}

function appendRecordSheet(
  workbook: XLSX.WorkBook,
  name: string,
  records: readonly ExcelInputRecord[],
  view: WorkbookView,
): void {
  const rows = [[...COUNTRY_HEADERS], ...records.map((record) => recordRow(record, view))];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
}

export function workbookToUint8Array(workbook: XLSX.WorkBook): Uint8Array {
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Uint8Array(output);
}
