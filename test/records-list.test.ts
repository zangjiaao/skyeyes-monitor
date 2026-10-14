import { describe, expect, it } from "vitest";
import { readWorkbookSheets } from "../src/export/excel";
import { createApp } from "../src/http/app";
import { buildRecordListQuery } from "../src/records/list";

const schedule = {
  timeZone: "Asia/Shanghai",
  scheduleHour: 10,
  windowHours: 24,
  now: new Date("2026-10-13T02:00:00.000Z"),
};

describe("采集记录列表查询", () => {
  it("按页计算偏移，每页只接受 20、50、100", () => {
    const second = buildRecordListQuery({ view: "all", page: "2", pageSize: "20" }, schedule);
    expect(second.offset).toBe(20);
    expect(second.limit).toBe(20);
    expect(second.page).toBe(2);
    const third = buildRecordListQuery({ view: "all", page: "3", pageSize: "50" }, schedule);
    expect(third.offset).toBe(100);
    expect(third.limit).toBe(50);
    expect(() => buildRecordListQuery({ view: "all", page: "1", pageSize: "1000" }, schedule)).toThrow(/20、50 或 100/);
    expect(() => buildRecordListQuery({ view: "all", page: "0" }, schedule)).toThrow(/页码/);
    const legacy = buildRecordListQuery({ view: "all", limit: "50", offset: "10" }, schedule);
    expect(legacy).toMatchObject({ limit: 50, offset: 10, page: 1, pageSize: 50 });
  });

  it("筛选、关键词和排序写进同一条 WHERE", () => {
    const query = buildRecordListQuery({
      view: "all",
      countryId: "country-1",
      targetId: "target-1",
      target: "示例目标",
      source: "google_news",
      publishedFrom: "2026-10-12",
      publishedTo: "2026-10-12",
      relevance: "at_least",
      relevanceMin: "40",
      translation: "failed",
      spam: "not_spam",
      q: "100%_ok",
      sort: "score",
      order: "asc",
      page: "1",
      pageSize: "20",
    }, schedule);
    expect(query.where).toContain("deleted_at IS NULL");
    expect(query.where).toContain("country_id = ?");
    expect(query.where).toContain("(matched_target_id = ? OR matched_target = ?)");
    expect(query.where).toContain("source = ?");
    expect(query.where).toContain("published_at >= ?");
    expect(query.where).toContain("published_at < ?");
    expect(query.where).toContain("relevance_score >= ?");
    expect(query.where).toContain("translation_status = 'translation_failed'");
    expect(query.where).toContain("is_spam = 0");
    expect(query.where).toContain("LIKE ? ESCAPE '\\'");
    expect(query.orderBy).toBe("relevance_score IS NULL, relevance_score ASC, id ASC");
    expect(query.binds).toContain("%100\\%\\_ok%");
    expect(query.binds).toContain(40);
    expect(query.binds).toContain("2026-10-11T16:00:00.000Z");
    expect(query.binds).toContain("2026-10-12T16:00:00.000Z");
  });

  it("今日视图沿用可进入日报的条件，相关度阈值缺失时拒绝", () => {
    const today = buildRecordListQuery({ view: "today" }, schedule);
    expect(today.where).toContain("time_status = 'in_window'");
    expect(today.where).toContain("published_at >= ? AND published_at < ?");
    expect(today.orderBy).toContain("COALESCE(published_at, collected_at) DESC");
    expect(() => buildRecordListQuery({ view: "all", relevance: "below" }, schedule)).toThrow(/阈值/);
    expect(() => buildRecordListQuery({ view: "all", source: "reddit" }, schedule)).toThrow(/来源/);
  });
});

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
  translation_zh: string | null;
  relevance_score: number | null;
}

function record(id: string, text: string, extra: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
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
    relevance_score: 80,
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
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const files = new Map<string, Uint8Array>();
  const db = {
    prepare(sql: string) {
      const execute = (binds: unknown[]) => {
        calls.push({ sql, binds });
        if (sql.startsWith("UPDATE records SET deleted_at")) {
          const stamp = String(binds[0]);
          let changes = 0;
          for (const row of rows) {
            if (row.deleted_at != null) continue;
            if (sql.includes("id IN")) {
              if (!binds.slice(1).map(String).includes(row.id)) continue;
            } else if (sql.includes("source = ?") && row.source !== String(binds[1])) {
              continue;
            }
            row.deleted_at = stamp;
            changes += 1;
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
          if (sql.includes("ORDER BY")) {
            matched = [...matched].sort((left, right) => left.id < right.id ? -1 : 1);
          }
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
  return { app: createApp(), env, ctx, rows, calls, files };
}

async function call(harness: ReturnType<typeof createHarness>, path: string, init?: RequestInit) {
  const response = await harness.app.request(path, init, harness.env, harness.ctx);
  const payload = await response.json() as {
    error?: string;
    deleted?: number;
    excel?: boolean;
    records?: Array<{ id: string }>;
    total?: number;
    page?: number;
    pageSize?: number;
  };
  return { status: response.status, payload };
}

describe("采集记录分页接口", () => {
  it("第二页返回条数、总数和页码，并带上筛选条件", async () => {
    const rows = Array.from({ length: 45 }, (_, index) => record(`r-${String(index).padStart(2, "0")}`, `正文 ${index}`));
    rows.push(record("other", "另一来源", { source: "gdelt" }));
    const harness = createHarness(rows);
    const listed = await call(harness, "/api/records?view=all&page=2&pageSize=20&source=x&q=100%25");
    expect(listed.status).toBe(200);
    expect(listed.payload.page).toBe(2);
    expect(listed.payload.pageSize).toBe(20);
    expect(listed.payload.records).toHaveLength(20);
    expect(listed.payload.total).toBe(46);
    expect(listed.payload.records?.[0]?.id).toBe("r-19");
    const listCall = harness.calls.find((item) => item.sql.includes("LIMIT"));
    expect(listCall?.sql).toContain("source = ?");
    expect(listCall?.sql).toContain("LIKE ? ESCAPE '\\'");
    expect(listCall?.binds).toContain("%100\\%%");
    expect(listCall?.binds.slice(-2)).toEqual([20, 20]);
  });

  it("确认后按同一筛选软删除，未确认不会改数据", async () => {
    const harness = createHarness([
      record("keep-news", "新闻", { source: "gdelt", original_text: "应保留的新闻" }),
      record("drop-post", "帖子", { source: "x", original_text: "应删除的帖子" }),
    ]);
    const refused = await call(harness, "/api/records/delete-matching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "x" }),
    });
    expect(refused.status).toBe(400);
    expect(harness.rows.every((row) => row.deleted_at == null)).toBe(true);
    const removed = await call(harness, "/api/records/delete-matching", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, view: "all", source: "x" }),
    });
    expect(removed.status).toBe(200);
    expect(removed.payload).toMatchObject({ deleted: 1, excel: true });
    expect(harness.rows.find((row) => row.id === "drop-post")?.deleted_at).toBeTruthy();
    expect(harness.rows.find((row) => row.id === "keep-news")?.deleted_at).toBeNull();
    const update = harness.calls.find((item) => item.sql.startsWith("UPDATE records SET deleted_at"));
    expect(update?.sql).toContain("source = ?");
    expect(update?.sql).toContain("deleted_at IS NULL");
    expect(update?.sql.includes("id IN")).toBe(false);
    const sheets = readWorkbookSheets(harness.files.get("skyeyes.xlsx")!);
    const texts = Object.values(sheets).flat().map((row) => row[0]);
    expect(texts).toContain("应保留的新闻");
    expect(texts).not.toContain("应删除的帖子");
  });
});
