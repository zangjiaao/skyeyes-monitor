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

function cell(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

export function recordsFromRows(rows: Record<string, string>[]): ImportRow[] {
  return rows.map((row, index) => {
    const countryCode = cell(row, "country_code", "country");
    const kind = cell(row, "kind") as TargetKind;
    const name = cell(row, "name");
    const terms = assertTermList(
      splitImportTerms(cell(row, "terms", "query") || name),
      `第 ${index + 2} 行检索词`,
    );
    const excludeTerms = assertTermList(
      splitImportTerms(cell(row, "exclude", "exclude_terms")),
      `第 ${index + 2} 行排除词`,
      true,
    );
    const enabledRaw = (row.enabled || "1").trim().toLowerCase();
    if (!countryCode || !name) {
      throw new Error(`第 ${index + 2} 行缺少 country_code 或 name`);
    }
    if (!TARGET_KINDS.includes(kind)) {
      throw new Error(`第 ${index + 2} 行 kind 必须是 ${TARGET_KINDS.join("/")}`);
    }
    return {
      countryCode,
      kind,
      name,
      query: terms[0],
      terms,
      excludeTerms,
      caseSensitive: flagEnabled(cell(row, "case_sensitive", "caseSensitive")),
      enabled: !["0", "false", "no"].includes(enabledRaw),
      description: cell(row, "description").slice(0, 800),
    };
  });
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
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.trim());
  const records = rows.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? "").trim();
    });
    return record;
  });
  return mergeImportRows(recordsFromRows(records));
}

export function parseXlsx(bytes: Uint8Array): ImportRow[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const name = workbook.SheetNames[0];
  if (!name) return [];
  const sheet = workbook.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return mergeImportRows(recordsFromRows(rows.map((row) => {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) record[key.trim()] = String(value ?? "").trim();
    return record;
  })));
}
