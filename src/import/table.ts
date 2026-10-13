import * as XLSX from "xlsx";
import { assertTermList, flagEnabled, splitImportTerms, uniqueTerms } from "../domain/terms";
import { TARGET_KINDS, type TargetKind } from "../domain/types";

export interface ImportRow {
  countryCode: string;
  kind: TargetKind;
  name: string;
  query: string;
  terms: string[];
  excludeTerms: string[];
  caseSensitive: boolean;
  enabled: boolean;
  description: string;
}

export interface ImportPreviewRow {
  line: number;
  countryCode: string;
  kind: string;
  name: string;
  terms: string[];
  excludeTerms: string[];
  description: string;
  enabled: boolean;
  caseSensitive: boolean;
  errors: string[];
  duplicateOf: number | null;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  errorCount: number;
  duplicateCount: number;
}

export const TEMPLATE_HEADERS = [
  "国家代码",
  "类型",
  "显示名",
  "检索词",
  "排除词",
  "背景说明",
  "启用",
  "英文短语区分大小写",
] as const;

export const TEMPLATE_EXAMPLES: string[][] = [
  [
    "pk",
    "organization",
    "俾路支解放军",
    "Baloch Liberation Army|Balochistan Liberation Army|BLA",
    "Biologics License",
    "关注该组织发布的声明和袭击。",
    "1",
    "0",
  ],
  [
    "pk",
    "handle",
    "俾路支观察",
    "balochwatch",
    "",
    "X 账号。检索词填账号名，不要带 @。",
    "1",
    "0",
  ],
];

const TEMPLATE_HELP: string[][] = [
  ["列", "必填", "允许的值", "说明"],
  ["国家代码", "是", "已存在的国家代码，例如 pk", "必须先在监测目标页建好国家。大小写不限。表头也可以写 country_code。"],
  ["类型", "是", "person、organization、keyword、handle，或 人物、机构、关键词、X 账号", "决定这条目标怎么匹配。表头也可以写 kind。"],
  ["显示名", "是", "任意文字", "日报里看到的名称。同一国家、类型、显示名的多行会合并成一个目标。表头也可以写 name。"],
  ["检索词", "是", "多条用 | 或单元格内换行分开", "不能为空。账号不要带 @。2 到 5 个字母的缩写请写成要匹配的大小写，例如 BLA。表头也可以写 terms 或 query。"],
  ["排除词", "否", "多条用 | 或换行分开，可留空", "命中就丢掉整条。表头也可以写 exclude 或 exclude_terms。"],
  ["背景说明", "否", "最多 800 字，可留空", "会交给 AI 解读。表头也可以写 description。"],
  ["启用", "否", "1、是、true 为启用；0、否、false 为停用", "留空视为启用。表头也可以写 enabled。"],
  ["英文短语区分大小写", "否", "1 或 是 为打开，留空或其他为关闭", "只影响更长的英文短语。2 到 5 个字母的缩写始终区分大小写。表头也可以写 case_sensitive。"],
];

const HEADER_ALIASES: Record<string, string> = {
  country_code: "country_code",
  countrycode: "country_code",
  country: "country_code",
  国家代码: "country_code",
  kind: "kind",
  类型: "kind",
  name: "name",
  显示名: "name",
  terms: "terms",
  query: "terms",
  检索词: "terms",
  exclude: "exclude_terms",
  exclude_terms: "exclude_terms",
  excludeterms: "exclude_terms",
  排除词: "exclude_terms",
  description: "description",
  背景说明: "description",
  enabled: "enabled",
  启用: "enabled",
  case_sensitive: "case_sensitive",
  casesensitive: "case_sensitive",
  英文短语区分大小写: "case_sensitive",
};

const KIND_ALIASES: Record<string, TargetKind> = {
  person: "person",
  人物: "person",
  organization: "organization",
  机构: "organization",
  keyword: "keyword",
  关键词: "keyword",
  handle: "handle",
  账号: "handle",
  x账号: "handle",
};

function canonicalHeader(header: string): string {
  const trimmed = header.trim();
  const compact = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
  return HEADER_ALIASES[trimmed] ?? HEADER_ALIASES[trimmed.toLowerCase()] ?? HEADER_ALIASES[compact] ?? trimmed;
}

function normalizeKind(value: string): TargetKind | null {
  const compact = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return KIND_ALIASES[value.trim()] ?? KIND_ALIASES[compact] ?? null;
}

function parseEnabled(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "n", "否"].includes(raw);
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

export function buildTargetTemplateCsv(): string {
  const lines = [[...TEMPLATE_HEADERS], ...TEMPLATE_EXAMPLES].map((row) => row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function buildTargetTemplateXlsx(): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS], ...TEMPLATE_EXAMPLES]), "目标");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(TEMPLATE_HELP), "填写说明");
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
  return new Uint8Array(bytes);
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim()));
}

interface Matrix {
  headers: string[];
  rows: { line: number; cells: string[] }[];
}

function matrixFromCsv(text: string): Matrix {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { headers: [], rows: [] };
  return {
    headers: rows[0].map((header) => header.trim()),
    rows: rows.slice(1).map((cells, index) => ({ line: index + 2, cells })),
  };
}

function matrixFromXlsx(bytes: Uint8Array): Matrix {
  const workbook = XLSX.read(bytes, { type: "array" });
  const named = workbook.SheetNames.find((name) => {
    const sheet = workbook.Sheets[name];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    const header = (grid[0] ?? []).map((value) => canonicalHeader(String(value ?? "")));
    return header.includes("country_code");
  }) ?? workbook.SheetNames[0];
  if (!named) return { headers: [], rows: [] };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[named], { header: 1, defval: "", raw: false });
  const headers = (grid[0] ?? []).map((value) => String(value ?? "").trim());
  const rows = grid.slice(1).flatMap((cells, index) => {
    const values = cells.map((value) => String(value ?? "").trim());
    if (!values.some((value) => value)) return [];
    return [{ line: index + 2, cells: values }];
  });
  return { headers, rows };
}

function cell(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

function readRaw(row: Record<string, string>, line: number): ImportPreviewRow {
  const countryCode = cell(row, "country_code").toLowerCase();
  const kindRaw = cell(row, "kind");
  const kind = normalizeKind(kindRaw);
  const name = cell(row, "name");
  const termsRaw = cell(row, "terms");
  const errors: string[] = [];
  if (!countryCode) errors.push("缺少国家代码");
  if (!name) errors.push("缺少显示名");
  if (!kindRaw) errors.push("缺少类型");
  else if (!kind) errors.push(`类型无效，只能是 ${TARGET_KINDS.join("、")}`);
  let terms: string[] = [];
  if (!termsRaw) errors.push("检索词不能为空");
  else {
    try {
      terms = assertTermList(splitImportTerms(termsRaw), "检索词");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "检索词无效");
    }
  }
  let excludeTerms: string[] = [];
  const excludeRaw = cell(row, "exclude_terms");
  if (excludeRaw) {
    try {
      excludeTerms = assertTermList(splitImportTerms(excludeRaw), "排除词", true);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "排除词无效");
    }
  }
  return {
    line,
    countryCode,
    kind: kind ?? kindRaw,
    name,
    terms,
    excludeTerms,
    description: cell(row, "description").slice(0, 800),
    enabled: parseEnabled(row.enabled),
    caseSensitive: flagEnabled(cell(row, "case_sensitive")),
    errors,
    duplicateOf: null,
  };
}

export function previewMatrix(matrix: Matrix, countryCodes?: Iterable<string>): ImportPreview {
  const known = new Set([...(countryCodes ?? [])].map((code) => code.trim().toLowerCase()).filter(Boolean));
  const checkCountries = countryCodes !== undefined;
  const headers = matrix.headers.map(canonicalHeader);
  const seen = new Map<string, number>();
  const rows = matrix.rows.map(({ line, cells }) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!record[header]) record[header] = (cells[index] ?? "").trim();
    });
    const raw = readRaw(record, line);
    if (checkCountries && raw.countryCode && !known.has(raw.countryCode)) {
      raw.errors.push(`未知国家代码 ${raw.countryCode}`);
    }
    if (raw.countryCode && raw.kind && raw.name && TARGET_KINDS.includes(raw.kind as TargetKind)) {
      const key = `${raw.countryCode}\0${raw.kind}\0${raw.name}`;
      const previous = seen.get(key);
      if (previous !== undefined) raw.duplicateOf = previous;
      else seen.set(key, line);
    }
    return raw;
  });
  return {
    rows,
    errorCount: rows.filter((row) => row.errors.length > 0).length,
    duplicateCount: rows.filter((row) => row.duplicateOf !== null).length,
  };
}

function rowsFromPreview(preview: ImportPreview): ImportRow[] {
  const failed = preview.rows.find((row) => row.errors.length > 0);
  if (failed) throw new Error(`第 ${failed.line} 行${failed.errors[0]}`);
  return mergeImportRows(preview.rows.map((row) => ({
    countryCode: row.countryCode,
    kind: row.kind as TargetKind,
    name: row.name,
    query: row.terms[0],
    terms: row.terms,
    excludeTerms: row.excludeTerms,
    caseSensitive: row.caseSensitive,
    enabled: row.enabled,
    description: row.description,
  })));
}

export function previewCsv(text: string, countryCodes?: Iterable<string>): ImportPreview {
  return previewMatrix(matrixFromCsv(text), countryCodes);
}

export function previewXlsx(bytes: Uint8Array, countryCodes?: Iterable<string>): ImportPreview {
  return previewMatrix(matrixFromXlsx(bytes), countryCodes);
}

export function recordsFromRows(rows: Record<string, string>[]): ImportRow[] {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return rowsFromPreview(previewMatrix({
    headers,
    rows: rows.map((row, index) => ({
      line: index + 2,
      cells: headers.map((header) => row[header] ?? ""),
    })),
  }));
}

export function mergeImportRows(rows: ImportRow[]): ImportRow[] {
  const merged = new Map<string, ImportRow>();
  for (const row of rows) {
    const key = `${row.countryCode}\0${row.kind}\0${row.name}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...row,
        terms: [...row.terms],
        excludeTerms: [...row.excludeTerms],
      });
      continue;
    }
    existing.terms = uniqueTerms([...existing.terms, ...row.terms]);
    existing.excludeTerms = uniqueTerms([...existing.excludeTerms, ...row.excludeTerms]);
    existing.query = existing.terms[0] ?? existing.query;
    existing.caseSensitive = existing.caseSensitive || row.caseSensitive;
    existing.enabled = row.enabled;
    if (row.description) existing.description = row.description;
  }
  return [...merged.values()];
}

export function parseCsv(text: string): ImportRow[] {
  const matrix = matrixFromCsv(text);
  if (matrix.rows.length === 0) return [];
  return rowsFromPreview(previewMatrix(matrix));
}

export function parseXlsx(bytes: Uint8Array): ImportRow[] {
  const matrix = matrixFromXlsx(bytes);
  if (matrix.rows.length === 0) return [];
  return rowsFromPreview(previewMatrix(matrix));
}
