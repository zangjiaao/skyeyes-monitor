import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../src/config/settings";
import { readWorkbookSheets } from "../src/export/excel";
import { runWindowObjectKey } from "../src/export/run-file";
import { storeExcel, storeRunWindowExcel } from "../src/pipeline/run";

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) db.exec(readFileSync(`migrations/${name}`, "utf8"));
  return db;
}

function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql.replace(/\?(\d+)/g, "?"));
      const bound = (binds: unknown[]) => {
        const args = binds.map((value) => (value === undefined ? null : value)) as SQLInputValue[];
        return {
          all: async () => ({ results: args.length === 0 ? statement.all() : statement.all(...args) }),
          first: async () => (args.length === 0 ? statement.get() : statement.get(...args)) ?? null,
          run: async () => {
            const info = args.length === 0 ? statement.run() : statement.run(...args);
            return { meta: { changes: Number(info.changes ?? 0) }, results: [] };
          },
        };
      };
      return { bind: (...binds: unknown[]) => bound(binds), ...bound([]) };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

describe("本轮窗口 Excel", () => {
  it("累计文件保留历史，邮件文件只含这次运行窗口内的新增，日期格是真日期", async () => {
    const sqlite = openDatabase();
    const runId = "33333333-3333-4333-8333-333333333333";
    const olderRunId = "44444444-4444-4444-8444-444444444444";
    const windowStart = "2026-10-12T02:00:00.000Z";
    const windowEnd = "2026-10-13T02:00:00.000Z";
    const insertRun = sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at, finished_at
      ) VALUES (?, ?, 'manual', 'completed', ?, ?, ?, ?, ?)`,
    );
    insertRun.run(runId, `manual-${runId}`, windowStart, windowEnd, windowStart, windowEnd, windowEnd);
    insertRun.run(olderRunId, `manual-${olderRunId}`, "2026-10-01T02:00:00.000Z", "2026-10-02T02:00:00.000Z", "2026-10-01T02:00:00.000Z", "2026-10-02T02:00:00.000Z", "2026-10-02T02:00:00.000Z");
    const insertRecord = sqlite.prepare(
      `INSERT INTO records (
        id, dedupe_key, source, url, country_id, country_name, matched_target, matched_term,
        original_text, published_at, collected_at, run_id, time_status, is_spam, exclude_reason, translation_zh
      ) VALUES (?, ?, 'x', ?, 'country_demo_alpha', '示例国家甲', '示例目标', 'probe', ?, ?, ?, ?, ?, ?, ?, '译文')`,
    );
    insertRecord.run(
      "rec-window", "dedupe-window", "https://example.com/window",
      "window-item", "2026-10-12T06:00:00.000Z", "2026-10-12T07:00:00.000Z",
      runId, "in_window", 0, "",
    );
    insertRecord.run(
      "rec-history", "dedupe-history", "https://example.com/history",
      "history-item", "2026-10-01T06:00:00.000Z", "2026-10-01T07:00:00.000Z",
      olderRunId, "in_window", 0, "",
    );
    insertRecord.run(
      "rec-spam", "dedupe-spam", "https://example.com/spam",
      "spam-item", "2026-10-12T08:00:00.000Z", "2026-10-12T08:00:00.000Z",
      runId, "in_window", 1, "spam",
    );
    insertRecord.run(
      "rec-outside", "dedupe-outside", "https://example.com/outside",
      "outside-item", "2026-10-10T06:00:00.000Z", "2026-10-12T08:00:00.000Z",
      runId, "out_of_window", 0, "",
    );

    const files = new Map<string, Uint8Array>();
    const env = {
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: {
        async put(key: string, value: Uint8Array) {
          files.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
        },
      },
    } as unknown as Env;
    const settings = await loadSettings(env.DB);
    const cumulative = await storeExcel(env, settings);
    const windowFile = await storeRunWindowExcel(env, settings, {
      id: runId,
      windowStart,
      windowEnd,
    });
    const empty = await storeRunWindowExcel(env, settings, {
      id: "55555555-5555-4555-8555-555555555555",
      windowStart,
      windowEnd,
    });

    expect(cumulative.key).toBe("skyeyes.xlsx");
    expect(windowFile.count).toBe(1);
    expect(windowFile.filename).toBe("skyeyes-2026-10-13.xlsx");
    expect(windowFile.key).toBe(runWindowObjectKey(runId));
    expect(empty.count).toBe(0);
    expect(empty.bytes).toBeNull();
    expect(files.has(empty.key)).toBe(false);

    const cumulativeSheets = readWorkbookSheets(files.get("skyeyes.xlsx")!);
    const windowSheets = readWorkbookSheets(files.get(windowFile.key)!);
    expect(cumulativeSheets["示例国家甲"].map((row) => row[0])).toEqual(["原文", "history-item", "window-item"]);
    expect(windowSheets["示例国家甲"].map((row) => row[0])).toEqual(["原文", "window-item"]);
    expect(windowSheets["示例国家乙"].map((row) => row[0])).toEqual(["原文"]);
    expect(windowSheets["今日"].map((row) => row[0])).toEqual(["原文", "window-item"]);
    expect(windowSheets["昨日"].map((row) => row[0])).toEqual(["原文"]);
    expect(JSON.stringify(windowSheets)).not.toContain("history-item");
    expect(JSON.stringify(windowSheets)).not.toContain("spam-item");
    expect(JSON.stringify(windowSheets)).not.toContain("outside-item");
    expect(windowSheets["示例国家甲"][1][1]).toBe("2026-10-12 14:00");
    expect(windowSheets["示例国家甲"][0][1]).toBe("发布时间（Asia/Shanghai, UTC+8）");

    const parsed = XLSX.read(files.get(windowFile.key)!, { type: "array", cellDates: true });
    const published = parsed.Sheets["示例国家甲"]?.B2;
    expect(published?.t === "d" || published?.t === "n").toBe(true);
    expect(published?.v).toBeInstanceOf(Date);
  });
});