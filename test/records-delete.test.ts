import { describe, expect, it } from "vitest";
import { DELIVERABLE_SQL } from "../src/domain/gate";
import { readWorkbookSheets } from "../src/export/excel";
import { createApp } from "../src/http/app";
import { MAX_BULK_DELETE } from "../src/records/delete";

interface StoredRecord {
  id: string;
  dedupe_key: string;
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
  translation_zh: string | null;
}

function record(id: string, text: string, extra: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    dedupe_key: `x:id:${id}`,
    deleted_at: null,
    time_status: "in_window",
    is_spam: 0,
    exclude_reason: null,
    published_at: "2026-10-12T06:00:00.000Z",
    original_text: text,
    country_name: "示例国家甲",
    author_handle: "someone",
    author_name: "某人",
    author_url: "https://x.com/someone",
    source: "x",
    url: `https://x.com/someone/status/${id}`,
    matched_target: "示例目标",
    matched_term: "示例",
    collected_at: "2026-10-12T07:00:00.000Z",
    translation_zh: "译文",
    ...extra,
  };
}

function visible(sql: string, rows: StoredRecord[]): StoredRecord[] {
  return rows.filter((row) => {
    if (sql.includes("deleted_at IS NULL") && row.deleted_at) return false;
    if (sql.includes("time_status = 'in_window'") && row.time_status !== "in_window") return false;
    if (sql.includes("is_spam = 0") && row.is_spam !== 0) return false;
    if (sql.includes("COALESCE(exclude_reason, '') = ''") && (row.exclude_reason ?? "") !== "") return false;
    if (sql.includes("published_at IS NOT NULL") && !row.published_at) return false;
    return true;
  });
}

function createHarness(initial: StoredRecord[]) {
  const rows = initial.map((row) => ({ ...row }));
  const statements: string[] = [];
  const files = new Map<string, Uint8Array>();
  let puts = 0;
  const db = {
    prepare(sql: string) {
      const execute = (binds: unknown[]) => {
        statements.push(sql);
        if (/delete\s+from\s+records/i.test(sql)) throw new Error("不应物理删除记录");
        if (sql.startsWith("UPDATE records SET deleted_at")) {
          const ids = binds.slice(1).map(String);
          const stamp = String(binds[0]);
          let changes = 0;
          for (const row of rows) {
            if (row.deleted_at == null && ids.includes(row.id)) {
              row.deleted_at = stamp;
              changes += 1;
            }
          }
          return { results: [] as StoredRecord[], first: null, changes };
        }
        if (sql.includes("FROM settings")) return { results: [], first: null, changes: 0 };
        if (sql.includes("FROM countries")) {
          return { results: [{ name: "示例国家甲" }], first: { name: "示例国家甲" }, changes: 0 };
        }
        if (sql.includes("COUNT(*)")) {
          const matched = visible(sql, rows);
          return { results: [{ n: matched.length }], first: { n: matched.length }, changes: 0 };
        }
        if (sql.includes("FROM records")) {
          let matched = visible(sql, rows);
          if (sql.includes("LIMIT") && binds.length >= 2) {
            const limit = Number(binds[binds.length - 2]);
            const offset = Number(binds[binds.length - 1]);
            matched = matched.slice(offset, offset + limit);
          }
          return { results: matched, first: matched[0] ?? null, changes: 0 };
        }
        throw new Error(`未预期的 SQL：${sql}`);
      };
      const statement = (binds: unknown[]) => ({
        all: async () => ({ results: execute(binds).results }),
        first: async <T,>() => execute(binds).first as T | null,
        run: async () => ({ meta: { changes: execute(binds).changes } }),
      });
      return {
        bind: (...binds: unknown[]) => statement(binds),
        ...statement([]),
      };
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
      async get(key: string) {
        const body = files.get(key);
        return body ? { body } : null;
      },
    },
  } as unknown as Env;
  const ctx = {
    access: { async getIdentity() { return { email: "dev@example.com" }; } },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { app: createApp(), env, ctx, rows, statements, files, puts: () => puts };
}

async function call(harness: ReturnType<typeof createHarness>, path: string, init?: RequestInit) {
  const response = await harness.app.request(path, init, harness.env, harness.ctx);
  const payload = await response.json() as { error?: string; deleted?: number; excel?: boolean; records?: Array<{ id: string }> };
  return { status: response.status, payload };
}

function texts(bytes: Uint8Array): string[] {
  const sheets = readWorkbookSheets(bytes);
  return Object.values(sheets).flat().map((row) => row[0]);
}

describe("删除采集记录", () => {
  it("日报查询排除已删除行，去重仍保留这些行的身份", () => {
    expect(DELIVERABLE_SQL.startsWith("deleted_at IS NULL")).toBe(true);
  });

  it("删除一条后列表和 Excel 都不再包含它，但 dedupe_key 还在", async () => {
    const harness = createHarness([
      record("keep", "应保留"),
      record("drop", "应删除"),
    ]);
    const removed = await call(harness, "/api/records/drop", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.payload).toMatchObject({ deleted: 1, excel: true });
    const listed = await call(harness, "/api/records?view=all&limit=50");
    expect(listed.payload.records?.map((row) => row.id)).toEqual(["keep"]);
    const dropped = harness.rows.find((row) => row.id === "drop");
    expect(dropped?.deleted_at).toBeTruthy();
    expect(dropped?.dedupe_key).toBe("x:id:drop");
    expect(harness.statements.some((sql) => /delete\s+from\s+records/i.test(sql))).toBe(false);
    const workbook = texts(harness.files.get("skyeyes.xlsx")!);
    expect(workbook).toContain("应保留");
    expect(workbook).not.toContain("应删除");
  });

  it("不存在的记录返回 404，并且不重写 Excel", async () => {
    const harness = createHarness([record("keep", "应保留")]);
    const removed = await call(harness, "/api/records/missing", { method: "DELETE" });
    expect(removed.status).toBe(404);
    expect(harness.puts()).toBe(0);
    expect(harness.rows[0]?.deleted_at).toBeNull();
  });

  it("批量删除只隐藏还在的记录，重复 id 只算一次", async () => {
    const harness = createHarness([
      record("a", "甲"),
      record("b", "乙"),
      record("c", "丙"),
      record("gone", "已隐藏", { deleted_at: "2026-10-01T00:00:00.000Z" }),
    ]);
    const removed = await call(harness, "/api/records/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "a", "gone", "missing"] }),
    });
    expect(removed.status).toBe(200);
    expect(removed.payload).toMatchObject({ deleted: 1, excel: true });
    expect(harness.rows.filter((row) => row.deleted_at).map((row) => row.id).sort()).toEqual(["a", "gone"]);
    const workbook = texts(harness.files.get("skyeyes.xlsx")!);
    expect(workbook).toContain("乙");
    expect(workbook).toContain("丙");
    expect(workbook).not.toContain("甲");
  });

  it("没有可删记录时不重写 Excel，非法 ids 被拒绝", async () => {
    const harness = createHarness([record("keep", "应保留")]);
    const none = await call(harness, "/api/records/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["missing"] }),
    });
    expect(none.status).toBe(200);
    expect(none.payload).toMatchObject({ deleted: 0, excel: false });
    expect(harness.puts()).toBe(0);
    const empty = await call(harness, "/api/records/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(empty.status).toBe(400);
    const tooMany = await call(harness, "/api/records/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from({ length: MAX_BULK_DELETE + 1 }, (_, index) => `id-${index}`) }),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.payload.error).toMatch(/100/);
    expect(harness.rows[0]?.deleted_at).toBeNull();
  });
});
