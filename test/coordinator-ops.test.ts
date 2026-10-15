import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CollectMessage } from "../src/pipeline/messages";
import { COORDINATOR_WALL_MS } from "../src/pipeline/lease";
import { pacing } from "../src/pipeline/pacing";
import { finalizeRun, processBatch, startRun } from "../src/pipeline/run";

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalSleep = pacing.sleep;
const originalPacingNow = pacing.now;

afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  pacing.sleep = originalSleep;
  pacing.now = originalPacingNow;
});

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

describe("来源协调者的队列操作", () => {
  it("2 组 × 100 目标、三个来源的一次运行只有几十次队列操作", async () => {
    expect(COORDINATOR_WALL_MS).toBeLessThan(15 * 60 * 1000);
    expect(COORDINATOR_WALL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);

    let clock = Date.parse("2026-10-14T02:00:00.000Z");
    Date.now = () => clock;
    pacing.now = () => clock;
    pacing.sleep = async (ms) => {
      clock += ms;
    };

    const sqlite = openDatabase();
    sqlite.prepare("UPDATE targets SET enabled = 0").run();
    sqlite.prepare("UPDATE recipients SET enabled = 0").run();
    for (const [key, value] of [
      ["gdelt_enabled", "1"],
      ["x_enabled", "1"],
      ["google_news_enabled", "1"],
      ["translation_enabled", "0"],
      ["ai_enabled", "0"],
      ["relevance_enabled", "0"],
      ["email_enabled", "0"],
      ["x_qps", "0.2"],
      ["x_max_pages", "5"],
      ["gdelt_min_interval_sec", "6"],
      ["google_news_min_interval_sec", "1"],
      ["google_news_editions", "en-US,zh-CN"],
      ["subrequest_budget", "40"],
      ["queue_concurrency", "4"],
    ] as const) {
      sqlite.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    }
    const nowIso = new Date(clock).toISOString();
    for (const [id, name, code] of [
      ["ops-country-a", "分组甲", "ops-a"],
      ["ops-country-b", "分组乙", "ops-b"],
    ] as const) {
      sqlite.prepare(
        "INSERT INTO countries (id, name, code, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
      ).run(id, name, code, nowIso);
    }
    const insertTarget = sqlite.prepare(
      `INSERT INTO targets (
        id, country_id, kind, name, query, terms, exclude_terms, case_sensitive, enabled, description, created_at
      ) VALUES (?, ?, 'keyword', ?, ?, '', '', 0, 1, '', ?)`,
    );
    for (const countryId of ["ops-country-a", "ops-country-b"]) {
      for (let index = 0; index < 100; index += 1) {
        const token = `opsprobe-${countryId}-${index}`;
        insertTarget.run(`${countryId}-${index}`, countryId, token, token, nowIso);
      }
    }

    const fetches = { x: 0, google_news: 0, gdelt: 0 };
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("twitterapi.io")) {
        fetches.x += 1;
        return Response.json({ tweets: [], has_next_page: false });
      }
      if (url.includes("news.google.com")) {
        fetches.google_news += 1;
        return new Response(`<?xml version="1.0"?><rss><channel></channel></rss>`);
      }
      if (url.includes("gdeltproject.org")) {
        fetches.gdelt += 1;
        return Response.json({ articles: [] });
      }
      throw new Error(`意外的外呼：${url}`);
    };

    const pending: Array<{ body: CollectMessage; delaySeconds: number }> = [];
    let writes = 0;
    let finalizes = 0;
    const queuedBatch = new Set<string>();
    function push(body: CollectMessage, delaySeconds = 0) {
      writes += 1;
      if (body.type === "batch") {
        if (queuedBatch.has(body.batchId)) throw new Error(`同一来源链重复在队列里：${body.batchId}`);
        queuedBatch.add(body.batchId);
      }
      if (body.type === "finalize") finalizes += 1;
      pending.push({ body, delaySeconds });
    }
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      TWITTERAPI_IO_KEY: "test-key",
      DEEPSEEK_API_KEY: "",
      RESEND_API_KEY: "",
      AI: { async run() { return {}; } },
      DB: asD1(sqlite),
      COLLECT_QUEUE: {
        async send(body: CollectMessage, options?: { delaySeconds?: number }) {
          push(body, options?.delaySeconds ?? 0);
        },
        async sendBatch(messages: Iterable<{ body: CollectMessage; delaySeconds?: number }>) {
          for (const message of messages) push(message.body, message.delaySeconds ?? 0);
        },
      },
      EXPORTS: { async put() {} },
      EMAIL: { async send() { return { messageId: "ops" }; } },
    } as unknown as Env;

    const started = await startRun(env, {
      trigger: "manual",
      now: new Date(clock),
      slotKey: "",
      windowStart: new Date(clock - 24 * 60 * 60 * 1000),
      windowEnd: new Date(clock),
    });
    expect(started.batches).toBe(3);
    expect(started.enqueued).toBe(3);

    let reads = 0;
    let acks = 0;
    let guard = 0;
    while (pending.length > 0 && guard < 80) {
      guard += 1;
      const message = pending.shift();
      if (!message) break;
      if (message.body.type === "batch") queuedBatch.delete(message.body.batchId);
      clock += message.delaySeconds * 1000;
      reads += 1;
      if (message.body.type === "batch") {
        await processBatch(env, message.body.runId, message.body.batchId);
      } else if (message.body.type === "finalize") {
        await finalizeRun(env, message.body.runId, message.body.reason);
      } else {
        throw new Error(`意外的队列消息：${message.body.type}`);
      }
      acks += 1;
    }

    const ops = writes + reads + acks;
    expect(guard).toBeLessThan(80);
    expect(pending).toHaveLength(0);
    expect(finalizes).toBe(1);
    expect(fetches).toEqual({ x: 200, google_news: 400, gdelt: 200 });
    expect(ops).toBe(63);
    expect(ops).toBeLessThan(100);
    const run = sqlite.prepare("SELECT status, batches_total FROM runs WHERE id = ?").get(started.runId) as {
      status: string;
      batches_total: number;
    };
    expect(run.batches_total).toBe(3);
    expect(run.status).toBe("completed");
    const chains = sqlite.prepare(
      "SELECT source, status, target_ids FROM batches WHERE run_id = ? ORDER BY batch_index",
    ).all(started.runId) as Array<{ source: string; status: string; target_ids: string }>;
    expect(chains.map((chain) => chain.source)).toEqual(["x", "google_news", "gdelt"]);
    expect(chains.every((chain) => chain.status === "done" && JSON.parse(chain.target_ids).length === 200)).toBe(true);
  });
});
