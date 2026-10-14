import { describe, expect, it } from "vitest";
import { utcOffsetLabel } from "../src/domain/time";
import { readWorkbookSheets } from "../src/export/excel";
import { createApp } from "../src/http/app";

interface StoredRecord {
  id: string;
  deleted_at: string | null;
  time_status: string;
  is_spam: number;
  exclude_reason: string | null;
  published_at: string | null;
  original_text: string;
  country_name: string;
  author_handle: string;
  author_name: string;
  author_url: string;
  source: string;
  url: string;
  matched_target: string;
  matched_term: string;
  collected_at: string;
  translation_zh: string;
  translation_status: string;
  translation_error: string | null;
  relevance_score: number | null;
  ai_summary: string;
}

function createHarness() {
  const settings = new Map<string, string>();
  const rows: StoredRecord[] = [{
    id: "row-1",
    deleted_at: null,
    time_status: "in_window",
    is_spam: 0,
    exclude_reason: null,
    published_at: "2026-10-13T02:00:00.000Z",
    original_text: "一条记录",
    country_name: "示例国家甲",
    author_handle: "someone",
    author_name: "某人",
    author_url: "https://x.com/someone",
    source: "x",
    url: "https://x.com/someone/status/1",
    matched_target: "示例目标",
    matched_term: "示例",
    collected_at: "2026-10-13T02:01:00.000Z",
    translation_zh: "译文",
    translation_status: "ok",
    translation_error: null,
    relevance_score: 80,
    ai_summary: "摘要",
  }];
  const files = new Map<string, Uint8Array>();
  let puts = 0;
  const execute = (sql: string, binds: unknown[]) => {
    if (sql.includes("INSERT INTO settings")) {
      settings.set(String(binds[0]), String(binds[1]));
      return { results: [] as unknown[], first: null, changes: 1 };
    }
    if (sql.includes("FROM settings")) {
      const results = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return { results, first: results[0] ?? null, changes: 0 };
    }
    if (sql.includes("FROM countries")) {
      return { results: [{ name: "示例国家甲" }], first: { name: "示例国家甲" }, changes: 0 };
    }
    if (sql.includes("COUNT(*)")) {
      return { results: [{ n: rows.length }], first: { n: rows.length }, changes: 0 };
    }
    if (sql.includes("FROM records")) {
      let matched = rows.filter((row) => row.deleted_at == null);
      if (sql.includes("LIMIT") && binds.length >= 2) {
        const limit = Number(binds[binds.length - 2]);
        const offset = Number(binds[binds.length - 1]);
        matched = matched.slice(offset, offset + limit);
      }
      return { results: matched, first: matched[0] ?? null, changes: 0 };
    }
    return { results: [], first: null, changes: 0 };
  };
  const statement = (sql: string, binds: unknown[]) => ({
    all: async () => ({ results: execute(sql, binds).results }),
    first: async () => execute(sql, binds).first,
    run: async () => ({ meta: { changes: execute(sql, binds).changes } }),
  });
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => statement(sql, binds),
        ...statement(sql, []),
      };
    },
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
  const env = {
    ENVIRONMENT: "development",
    EXCEL_FILENAME: "skyeyes.xlsx",
    DB: db,
    EXPORTS: {
      async put(key: string, value: Uint8Array) {
        puts += 1;
        files.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
      },
    },
  } as unknown as Env;
  const ctx = {
    access: { async getIdentity() { return { email: "dev@example.com" }; } },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { app: createApp(), env, ctx, files, puts: () => puts };
}

async function putTimezone(harness: ReturnType<typeof createHarness>, timezone: string) {
  const response = await harness.app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timezone }),
  }, harness.env, harness.ctx);
  const payload = await response.json() as { excel?: boolean; excelError?: string | null; timeZone?: string; error?: string };
  return { status: response.status, payload };
}

describe("修改时区后重写 Excel", () => {
  it("时区变化才重写累计表，单元格按新时区显示", async () => {
    const harness = createHarness();
    const same = await putTimezone(harness, "Asia/Shanghai");
    expect(same.status).toBe(200);
    expect(same.payload).toMatchObject({ excel: false, timeZone: "Asia/Shanghai" });
    expect(harness.puts()).toBe(0);

    const changed = await putTimezone(harness, "America/New_York");
    expect(changed.status).toBe(200);
    expect(changed.payload).toMatchObject({ excel: true, excelError: null, timeZone: "America/New_York" });
    expect(harness.puts()).toBe(1);
    const sheets = readWorkbookSheets(harness.files.get("skyeyes.xlsx")!);
    const offset = utcOffsetLabel(new Date(), "America/New_York");
    expect(sheets["示例国家甲"][0][1]).toBe(`发布时间（America/New_York, ${offset}）`);
    expect(sheets["示例国家甲"][1][1]).toBe("2026-10-12 22:00");
    expect(sheets["示例国家甲"][1][9]).toBe("2026-10-12 22:01");
    expect(Buffer.from(harness.files.get("skyeyes.xlsx")!).includes("2026-10-13T02:00:00.000Z")).toBe(false);

    const again = await putTimezone(harness, "America/New_York");
    expect(again.payload.excel).toBe(false);
    expect(harness.puts()).toBe(1);

    const listed = await harness.app.request("/api/records?limit=10", { method: "GET" }, harness.env, harness.ctx);
    const records = await listed.json() as { timeZone?: string; utcOffset?: string };
    expect(records.timeZone).toBe("America/New_York");
    expect(records.utcOffset).toBe(offset);
  });
});
