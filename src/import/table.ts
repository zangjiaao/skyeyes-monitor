import * as XLSX from "xlsx";
import { TARGET_KINDS, type TargetKind } from "../domain/types";

export interface ImportRow {
  countryCode: string;
  kind: TargetKind;
  name: string;
  query: string;
  enabled: boolean;
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

export function recordsFromRows(rows: Record<string, string>[]): ImportRow[] {
  return rows.map((row, index) => {
    const countryCode = (row.country_code || row.country || "").trim();
    const kind = (row.kind || "").trim() as TargetKind;
    const name = (row.name || "").trim();
    const query = (row.query || name).trim();
    const enabledRaw = (row.enabled || "1").trim().toLowerCase();
    if (!countryCode || !name || !query) {
      throw new Error(`第 ${index + 2} 行缺少 country_code、name 或 query`);
    }
    if (!TARGET_KINDS.includes(kind)) {
      throw new Error(`第 ${index + 2} 行 kind 必须是 ${TARGET_KINDS.join("/")}`);
    }
    return {
      countryCode,
      kind,
      name,
      query,
      enabled: !["0", "false", "no"].includes(enabledRaw),
    };
  });
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
  return recordsFromRows(records);
}

export function parseXlsx(bytes: Uint8Array): ImportRow[] {
  const workbook = XLSX.read(bytes, { type: "array" });
  const name = workbook.SheetNames[0];
  if (!name) return [];
  const sheet = workbook.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return recordsFromRows(rows.map((row) => {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) record[key.trim()] = String(value ?? "").trim();
    return record;
  }));
}
