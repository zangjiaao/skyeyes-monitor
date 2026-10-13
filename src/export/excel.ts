import * as XLSX from "xlsx";
import { publishPeriod, type PeriodLabel, type ScheduleConfig } from "../domain/time";

export interface ExcelRecord {
  countryName: string;
  originalText: string;
  publishedAt: string;
  authorHandle: string;
  authorName: string;
  authorUrl: string;
  source: string;
  url: string;
  matchedTarget: string;
  matchedTerm?: string;
  collectedAt: string;
  translationZh: string;
}

export interface WorkbookInput {
  countries: { name: string }[];
  records: ExcelRecord[];
  reference: Date;
  timeZone: string;
  scheduleHour: number;
  windowHours: number;
}

const HEADERS = [
  "原文",
  "发布时间",
  "作者账号",
  "作者显示名",
  "主页",
  "来源",
  "链接",
  "国家",
  "命中目标",
  "采集日期",
  "中文译文",
  "时段",
  "命中检索词",
];

const SOURCE_LABEL: Record<string, string> = {
  x: "X",
  google_news: "Google News",
  gdelt: "GDELT",
};

function sheetName(name: string, used: Set<string>): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim() || "未命名";
  let base = cleaned.slice(0, 31);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = ` ${suffix}`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function row(record: ExcelRecord, period: PeriodLabel): string[] {
  return [
    record.originalText,
    record.publishedAt,
    record.authorHandle,
    record.authorName,
    record.authorUrl,
    SOURCE_LABEL[record.source] ?? record.source,
    record.url,
    record.countryName,
    record.matchedTarget,
    record.collectedAt,
    record.translationZh,
    period,
    record.matchedTerm ?? "",
  ];
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  records: ReadonlyArray<readonly [ExcelRecord, PeriodLabel]>,
): void {
  const data = [HEADERS, ...records.map(([record, period]) => row(record, period))];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet["!cols"] = HEADERS.map((_, index) => ({ wch: index === 0 || index === 10 ? 40 : 18 }));
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

export function buildMonitorWorkbook(input: WorkbookInput): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const used = new Set<string>();
  const schedule: ScheduleConfig = {
    timeZone: input.timeZone,
    scheduleHour: input.scheduleHour,
    windowHours: input.windowHours,
  };
  const annotated = input.records.map((record) => {
    return [record, publishPeriod(record.publishedAt, input.reference, schedule)] as const;
  });

  const countryNames = [
    ...input.countries.map((country) => country.name),
    ...input.records.map((record) => record.countryName),
  ];
  const uniqueCountries: string[] = [];
  for (const name of countryNames) {
    if (!uniqueCountries.includes(name)) uniqueCountries.push(name);
  }
  if (uniqueCountries.length === 0) uniqueCountries.push("全部");

  for (const name of uniqueCountries) {
    const countryRows = name === "全部"
      ? annotated
      : annotated.filter(([record]) => record.countryName === name);
    addSheet(workbook, sheetName(name, used), countryRows);
  }

  addSheet(
    workbook,
    sheetName("今日", used),
    annotated.filter(([, period]) => period === "今日"),
  );
  addSheet(
    workbook,
    sheetName("昨日", used),
    annotated.filter(([, period]) => period === "昨日"),
  );

  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export function readWorkbookSheets(bytes: Uint8Array): Record<string, string[][]> {
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheets: Record<string, string[][]> = {};
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    sheets[name] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as string[][];
  }
  return sheets;
}
