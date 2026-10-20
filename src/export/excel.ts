import * as XLSX from "xlsx";
import { publishPeriod, timeColumnLabel, zonedWallClock, type PeriodLabel, type ScheduleConfig } from "../domain/time";

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
  relevanceScore?: string;
  summaryZh?: string;
}

export interface WorkbookInput {
  countries: { name: string }[];
  records: ExcelRecord[];
  reference: Date;
  timeZone: string;
  scheduleHour: number;
  windowHours: number;
  /**
   * 是否追加「今日」「昨日」汇总表。累计文件需要这两张表。
   * 邮件附件只含本轮窗口，参考时刻又是窗口结束，昨日窗口整段落在附件之外，表会恒为空，所以关掉。
   */
  periodSheets?: boolean;
}

const DATE_FORMAT = "yyyy-mm-dd hh:mm";
const PUBLISHED_COLUMN = 1;
const COLLECTED_COLUMN = 9;

function headersFor(timeZone: string, reference: Date): string[] {
  return [
    "原文",
    timeColumnLabel("发布时间", timeZone, reference),
    "作者账号",
    "作者显示名",
    "主页",
    "来源",
    "链接",
    "分组",
    "命中目标",
    timeColumnLabel("采集时间", timeZone, reference),
    "中文译文",
    "时段",
    "命中检索词",
    "相关度",
    "中文摘要",
  ];
}

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

function row(record: ExcelRecord, period: PeriodLabel, timeZone: string): Array<string | Date> {
  return [
    record.originalText,
    zonedWallClock(record.publishedAt, timeZone) ?? "",
    record.authorHandle,
    record.authorName,
    record.authorUrl,
    SOURCE_LABEL[record.source] ?? record.source,
    record.url,
    record.countryName,
    record.matchedTarget,
    zonedWallClock(record.collectedAt, timeZone) ?? "",
    record.translationZh,
    period,
    record.matchedTerm ?? "",
    record.relevanceScore ?? "",
    record.summaryZh ?? "",
  ];
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  records: ReadonlyArray<readonly [ExcelRecord, PeriodLabel]>,
  timeZone: string,
  reference: Date,
): void {
  const headers = headersFor(timeZone, reference);
  const data = [headers, ...records.map(([record, period]) => row(record, period, timeZone))];
  const sheet = XLSX.utils.aoa_to_sheet(data, { UTC: true, dateNF: DATE_FORMAT });
  sheet["!cols"] = headers.map((_, index) => ({
    wch: index === 0 || index === 10 ? 40 : index === PUBLISHED_COLUMN || index === COLLECTED_COLUMN ? 36 : 18,
  }));
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
    addSheet(workbook, sheetName(name, used), countryRows, input.timeZone, input.reference);
  }

  if (input.periodSheets !== false) {
    addSheet(
      workbook,
      sheetName("今日", used),
      annotated.filter(([, period]) => period === "今日"),
      input.timeZone,
      input.reference,
    );
    addSheet(
      workbook,
      sheetName("昨日", used),
      annotated.filter(([, period]) => period === "昨日"),
      input.timeZone,
      input.reference,
    );
  }

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
