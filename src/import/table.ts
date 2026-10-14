import * as XLSX from "xlsx";
import { assertTermList, flagEnabled, splitImportTerms, uniqueTerms } from "../domain/terms";
import { TARGET_KINDS, type TargetKind } from "../domain/types";
import { freezeFirstSheet } from "./xlsx-zip";

export interface ImportRow {
  id: string;
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

export type ImportAction = "create" | "update" | "unchanged";

export interface ExistingTarget {
  id: string;
  countryCode: string;
  kind: string;
  name: string;
  terms: string[];
  excludeTerms: string[];
  description: string;
  enabled: boolean;
  caseSensitive: boolean;
}

export interface ImportPreviewRow {
  line: number;
  id: string;
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
  action: ImportAction;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  errorCount: number;
  duplicateCount: number;
}

export const TEMPLATE_HEADERS = [
  "目标ID",
  "分组代码",
  "类型",
  "显示名",
  "检索词",
  "排除词",
  "背景说明",
  "启用",
  "英文短语区分大小写",
] as const;

const COLUMN_WIDTHS = [38, 12, 16, 24, 56, 28, 36, 10, 24];

export const TEMPLATE_EXAMPLES: string[][] = [
  [
    "demo",
    "organization",
    "俾路支解放军",
    "Baloch Liberation Army|Balochistan Liberation Army|BLA",
    "Biologics License",
    "关注该组织发布的声明和袭击。",
    "1",
    "0",
  ],
  [
    "demo",
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
  ["目标ID", "否", "导出的目标 ID，或留空", "留空则新建。填写后按这个 ID 覆盖原目标，不会另建一条。从文件里删掉一行不会删除数据库里的目标。表头也可以写 id。"],
  ["分组代码", "是", "已存在的分组代码，任意短且唯一，例如 demo", "不必使用 ISO 国家代码。必须先在监测目标页建好分组。大小写不限。旧表头 国家代码、国家、country_code、country 仍可导入。"],
  ["类型", "是", "person、organization、keyword、handle，或 人物、机构、关键词、X 账号", "决定这条目标怎么匹配。表头也可以写 kind。"],
  ["显示名", "是", "任意文字", "日报里看到的名称。同一分组、类型、显示名的多行会合并成一个目标。表头也可以写 name。"],
  ["检索词", "是", "多条用 | 或单元格内换行分开", "不能为空。账号不要带 @。2 到 5 个字母的缩写请写成要匹配的大小写，例如 BLA。表头也可以写 terms 或 query。"],
  ["排除词", "否", "多条用 | 或换行分开，可留空", "命中就丢掉整条。表头也可以写 exclude 或 exclude_terms。"],
  ["背景说明", "否", "最多 800 字，可留空", "会交给 AI 解读。表头也可以写 description。"],
  ["启用", "否", "1、是、true 为启用；0、否、false 为停用", "留空视为启用。表头也可以写 enabled。"],
  ["英文短语区分大小写", "否", "1 或 是 为打开，留空或其他为关闭", "只影响更长的英文短语。2 到 5 个字母的缩写始终区分大小写。表头也可以写 case_sensitive。"],
];

const HEADER_ALIASES: Record<string, string> = {
  id: "id",
  target_id: "id",
  targetid: "id",
  目标id: "id",
  country_code: "country_code",
  countrycode: "country_code",
  country: "country_code",
  group_code: "country_code",
  groupcode: "country_code",
  group: "country_code",
  分组代码: "country_code",
  分组: "country_code",
  国家代码: "country_code",
  国家: "country_code",
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

function templateExampleRows(): string[][] {
  return TEMPLATE_EXAMPLES.map((row) => ["", ...row]);
}

export function joinExportTerms(terms: string[]): string {
  const clean = terms.map((term) => term.trim()).filter(Boolean);
  if (clean.some((term) => term.includes("|"))) return clean.join("\n");
  return clean.join("|");
}

export function targetCells(target: ExistingTarget): string[] {
  return [
    target.id,
    target.countryCode,
    target.kind,
    target.name,
    joinExportTerms(target.terms),
    joinExportTerms(target.excludeTerms),
    target.description,
    target.enabled ? "1" : "0",
    target.caseSensitive ? "1" : "0",
  ];
}

function csvFromRows(rows: string[][]): string {
  const lines = [[...TEMPLATE_HEADERS], ...rows].map((row) => row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function buildTargetTemplateCsv(): string {
  return csvFromRows(templateExampleRows());
}

export function buildTargetExportCsv(targets: ExistingTarget[]): string {
  return csvFromRows(targets.map(targetCells));
}

function formatTargetSheet(sheet: XLSX.WorkSheet, rowCount: number): void {
  const lastRow = Math.max(rowCount, 1);
  const lastColumn = XLSX.utils.encode_col(TEMPLATE_HEADERS.length - 1);
  sheet["!autofilter"] = { ref: `A1:${lastColumn}${lastRow}` };
  sheet["!cols"] = COLUMN_WIDTHS.map((wch) => ({ wch }));
}

async function workbookBytes(rows: string[][]): Promise<Uint8Array> {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS], ...rows]);
  formatTargetSheet(sheet, rows.length + 1);
  XLSX.utils.book_append_sheet(book, sheet, "目标");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(TEMPLATE_HELP), "填写说明");
  const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });
  return freezeFirstSheet(new Uint8Array(bytes));
}

export function buildTargetTemplateXlsx(): Promise<Uint8Array> {
  return workbookBytes(templateExampleRows());
}

export function buildTargetExportXlsx(targets: ExistingTarget[]): Promise<Uint8Array> {
  return workbookBytes(targets.map(targetCells));
}

const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function nameKey(countryCode: string, kind: string, name: string): string {
  return `${countryCode}\0${kind}\0${name}`;
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
  const id = cell(row, "id");
  const countryCode = cell(row, "country_code").toLowerCase();
  const kindRaw = cell(row, "kind");
  const kind = normalizeKind(kindRaw);
  const name = cell(row, "name");
  const termsRaw = cell(row, "terms");
  const errors: string[] = [];
  if (id && !TARGET_ID_PATTERN.test(id)) errors.push("目标 ID 格式不正确");
  if (!countryCode) errors.push("缺少分组代码");
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
    id,
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
    action: "create",
  };
}

function sameStoredTarget(found: ExistingTarget, raw: ImportPreviewRow): boolean {
  return found.countryCode.trim().toLowerCase() === raw.countryCode
    && found.kind === raw.kind
    && found.name === raw.name
    && sameList(found.terms, raw.terms)
    && sameList(found.excludeTerms, raw.excludeTerms)
    && found.description === raw.description
    && found.enabled === raw.enabled
    && found.caseSensitive === raw.caseSensitive;
}

function classifyRow(
  raw: ImportPreviewRow,
  existing: ExistingTarget[] | undefined,
  byId: Map<string, ExistingTarget>,
  byName: Map<string, ExistingTarget>,
): ImportAction {
  if (raw.errors.length > 0) return "create";
  if (raw.id) {
    const found = byId.get(raw.id);
    if (!found) return "create";
    return sameStoredTarget(found, raw) ? "unchanged" : "update";
  }
  if (raw.duplicateOf !== null) return "update";
  if (!existing) return "create";
  const found = byName.get(nameKey(raw.countryCode, raw.kind, raw.name));
  if (!found) return "create";
  const terms = uniqueTerms([...found.terms, ...raw.terms]);
  const excludeTerms = uniqueTerms([...found.excludeTerms, ...raw.excludeTerms]);
  const description = raw.description || found.description;
  const caseSensitive = found.caseSensitive || raw.caseSensitive;
  const same = sameList(terms, found.terms)
    && sameList(excludeTerms, found.excludeTerms)
    && description === found.description
    && raw.enabled === found.enabled
    && caseSensitive === found.caseSensitive;
  return same ? "unchanged" : "update";
}

export function previewMatrix(
  matrix: Matrix,
  countryCodes?: Iterable<string>,
  existing?: ExistingTarget[],
): ImportPreview {
  const known = new Set([...(countryCodes ?? [])].map((code) => code.trim().toLowerCase()).filter(Boolean));
  const checkCountries = countryCodes !== undefined;
  const headers = matrix.headers.map(canonicalHeader);
  const seen = new Map<string, number>();
  const seenIds = new Map<string, number>();
  const byId = new Map<string, ExistingTarget>();
  const byName = new Map<string, ExistingTarget>();
  for (const target of existing ?? []) {
    byId.set(target.id, target);
    const key = nameKey(target.countryCode.trim().toLowerCase(), target.kind, target.name);
    if (!byName.has(key)) byName.set(key, target);
  }
  const rows = matrix.rows.map(({ line, cells }) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!record[header]) record[header] = (cells[index] ?? "").trim();
    });
    const raw = readRaw(record, line);
    if (checkCountries && raw.countryCode && !known.has(raw.countryCode)) {
      raw.errors.push(`未知分组代码 ${raw.countryCode}`);
    }
    if (raw.id && !raw.errors.includes("目标 ID 格式不正确")) {
      const previousId = seenIds.get(raw.id);
      if (previousId !== undefined) raw.errors.push(`目标 ID 与第 ${previousId} 行重复`);
      else {
        seenIds.set(raw.id, line);
        if (existing && !byId.has(raw.id)) raw.errors.push("未知目标 ID");
      }
    }
    if (raw.countryCode && raw.kind && raw.name && TARGET_KINDS.includes(raw.kind as TargetKind)) {
      const key = nameKey(raw.countryCode, raw.kind, raw.name);
      const previous = seen.get(key);
      if (!raw.id && previous !== undefined) raw.duplicateOf = previous;
      if (previous === undefined) seen.set(key, line);
    }
    raw.action = classifyRow(raw, existing, byId, byName);
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
    id: row.id,
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

export function previewCsv(text: string, countryCodes?: Iterable<string>, existing?: ExistingTarget[]): ImportPreview {
  return previewMatrix(matrixFromCsv(text), countryCodes, existing);
}

export function previewXlsx(bytes: Uint8Array, countryCodes?: Iterable<string>, existing?: ExistingTarget[]): ImportPreview {
  return previewMatrix(matrixFromXlsx(bytes), countryCodes, existing);
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
    const key = row.id ? `id\0${row.id}` : nameKey(row.countryCode, row.kind, row.name);
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
