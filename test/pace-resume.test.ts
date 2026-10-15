import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettings, validateSettingsPatch } from "../src/config/settings";
import { buildGdeltTermQuery, packGdeltQueries } from "../src/domain/batch";
import type { QueryTarget } from "../src/domain/types";
import { MAX_DEFER_WAIT_SEC } from "../src/pipeline/lease";
import { pacing } from "../src/pipeline/pacing";
import { handleDeadLetter, processBatch, scheduleDeferredWake } from "../src/pipeline/run";
import { gdeltProvider } from "../src/sources/gdelt";
import { gdeltRetryDelaySeconds } from "../src/sources/x-rate";

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalSleep = pacing.sleep;
const originalPacingNow = pacing.now;

beforeEach(() => {
  pacing.sleep = async () => {};
  pacing.now = () => Date.now();
});

afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  pacing.sleep = originalSleep;
  pacing.now = originalPacingNow;
});

const phrase: QueryTarget = {
  id: "t1",
  kind: "keyword",
  name: "示例",
  query: "BLA",
  terms: ["BLA"],
  excludeTerms: ["Biologics License"],
};

describe("GDELT 查询打包", () => {
  it("短词合成一条 OR，超长后拆开，排除词留在每一组", () => {
    const target: QueryTarget = {
      id: "t1",
      kind: "keyword",
      name: "示例",
      query: "alpha",
      terms: ["alpha", "beta signal", "gamma report"],
      excludeTerms: ["sponsor"],
    };
    const packed = packGdeltQueries(target);
    expect(packed).toHaveLength(1);
    expect(packed[0]?.query).toBe('("alpha" OR "beta signal" OR "gamma report") NOT "sponsor"');
    expect(packed[0]?.terms).toEqual(["alpha", "beta signal", "gamma report"]);
    expect(packed[0]?.query.length).toBeLessThanOrEqual(450);

    const split = packGdeltQueries(target, 40);
    expect(split.length).toBeGreaterThan(1);
    expect(split.every((group) => group.query.includes('NOT "sponsor"'))).toBe(true);
    expect(split.flatMap((group) => group.terms)).toEqual(["alpha", "beta signal", "gamma report"]);

    expect(packGdeltQueries(phrase)[0]?.query).toBe(buildGdeltTermQuery(phrase, "BLA"));
  });

  it("没有 Retry-After 时按 30、60、120 秒退避", () => {
    expect(gdeltRetryDelaySeconds({ attempt: 0, retryAfterSeconds: null })).toBe(30);
    expect(gdeltRetryDelaySeconds({ attempt: 1, retryAfterSeconds: null })).toBe(60);
    expect(gdeltRetryDelaySeconds({ attempt: 2, retryAfterSeconds: null })).toBe(120);
    expect(gdeltRetryDelaySeconds({ attempt: 8, retryAfterSeconds: null })).toBe(120);
    expect(gdeltRetryDelaySeconds({ attempt: 0, retryAfterSeconds: 45 })).toBe(45);
  });

  it("多个短词只请求一次，并按最长词归因", async () => {
    const target: QueryTarget = {
      id: "t1",
      kind: "keyword",
      name: "信号",
      query: "signal",
      terms: ["signal", "alpha signal"],
      excludeTerms: ["blockedword"],
    };
    const queries: string[] = [];
    let befores = 0;
    const result = await gdeltProvider.search({
      targets: [target],
      window: {
        start: new Date("2026-10-13T00:00:00.000Z"),
        end: new Date("2026-10-14T00:00:00.000Z"),
      },
      countryName: "示例",
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        queries.push(url.searchParams.get("query") ?? "");
        return Response.json({
          articles: [
            {
              url: "https://news.example/keep",
              title: "alpha signal coverage continues across the region today",
              seendate: "20261013T120000Z",
              domain: "news.example",
            },
            {
              url: "https://news.example/drop",
              title: "signal blockedword should not be stored in the batch",
              seendate: "20261013T120000Z",
              domain: "news.example",
            },
          ],
        });
      },
      beforeRequest: async () => {
        befores += 1;
      },
    });
    expect(befores).toBe(1);
    expect(queries).toEqual(['("signal" OR "alpha signal") NOT "blockedword"']);
    expect(result.calls).toBe(1);
    expect(result.filtered).toBe(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.matchedTerm).toBe("alpha signal");
  });

  it("429 使用 Retry-After，没有响应头时按尝试次数退避", async () => {
    const delays: number[] = [];
    const search = (queueAttempt: number, retryAfter?: string) => gdeltProvider.search({
      targets: [phrase],
      window: {
        start: new Date("2026-10-13T00:00:00.000Z"),
        end: new Date("2026-10-14T00:00:00.000Z"),
      },
      countryName: "示例",
      queueAttempt,
      fetchImpl: async () => new Response("slow", {
        status: 429,
        headers: retryAfter ? { "retry-after": retryAfter } : undefined,
      }),
    });
    await expect(search(1, "45")).rejects.toMatchObject({ delaySeconds: 45, retryAfterSeconds: 45 });
    for (const attempt of [1, 2, 3, 4]) {
      await search(attempt).catch((error: { delaySeconds: number }) => {
        delays.push(error.delaySeconds);
      });
    }
    expect(delays).toEqual([30, 60, 120, 120]);
  });
});

describe("限流配置", () => {
  it("GDELT 默认 6 秒，Google News 默认 1 秒，0 只对新闻放行", () => {
    expect(parseSettings({}).gdeltMinIntervalSec).toBe(6);
    expect(parseSettings({}).googleNewsMinIntervalSec).toBe(1);
    expect(validateSettingsPatch({ gdelt_min_interval_sec: "12" }).gdelt_min_interval_sec).toBe("12");
    expect(validateSettingsPatch({ google_news_min_interval_sec: "0" }).google_news_min_interval_sec).toBe("0");
    expect(() => validateSettingsPatch({ gdelt_min_interval_sec: "0" })).toThrow(/1 到 300/);
    expect(() => validateSettingsPatch({ google_news_min_interval_sec: "61" })).toThrow(/0 到 60/);
  });
});

interface BatchState {
  id: string;
  run_id: string;
  country_id: string;
  source: string;
  target_ids: string;
  status: string;
  attempts: number;
  defer_count: number;
  defer_wait_sec: number;
  next_wake_at: string | null;
  resume_json: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  enqueued_at: string | null;
  calls: number;
  items_found: number;
  items_fetched: number;
  items_deduped: number;
  items_filtered: number;
  items_added: number;
  error: string | null;
  finished_at: string | null;
}

interface RunState {
  id: string;
  status: string;
  window_start: string;
  window_end: string;
  batches_failed: number;
  records_added: number;
  relevance_failed: number;
  batches_done: number;
}

interface RecordState {
  dedupe_key: string;
  source: string;
  external_id: string | null;
  url: string;
  matched_term: string;
  original_text: string;
  url_key: string;
  title_key: string;
  published_at: string | null;
}

interface Wake {
  body: { type: string; runId: string; batchId: string };
  delaySeconds: number;
}

function createMemory(options: {
  source: "x" | "gdelt" | "google_news";
  settings?: Record<string, string>;
  batch?: Partial<BatchState>;
  terms?: string;
  deepseekKey?: string;
}) {
  const terms = options.terms ?? "alpha signal\nbeta signal";
  const settings = new Map(Object.entries({
    ai_enabled: "0",
    translation_enabled: "0",
    relevance_enabled: "0",
    x_qps: "0.2",
    x_max_pages: "5",
    gdelt_min_interval_sec: "6",
    queue_concurrency: "4",
    min_text_length: "10",
    ...options.settings,
  }));
  const run: RunState = {
    id: "run-1",
    status: "running",
    window_start: "2026-10-13T00:00:00.000Z",
    window_end: "2026-10-14T00:00:00.000Z",
    batches_failed: 0,
    records_added: 0,
    relevance_failed: 0,
    batches_done: 0,
  };
  const batch: BatchState = {
    id: "batch-1",
    run_id: "run-1",
    country_id: "c1",
    source: options.source,
    target_ids: '["t1"]',
    status: "queued",
    attempts: 0,
    defer_count: 0,
    defer_wait_sec: 0,
    next_wake_at: null,
    resume_json: null,
    lease_token: null,
    lease_expires_at: null,
    enqueued_at: null,
    calls: 0,
    items_found: 0,
    items_fetched: 0,
    items_deduped: 0,
    items_filtered: 0,
    items_added: 0,
    error: null,
    finished_at: null,
    ...options.batch,
  };
  const records: RecordState[] = [];
  const wakes: Wake[] = [];
  const retries: unknown[] = [];
  const slots = new Map<string, number>();

  function result(first: unknown, changes = 0, results: unknown[] = []) {
    return { first, changes, results: results.length > 0 ? results : first == null ? [] : [first] };
  }

  function execute(sql: string, binds: unknown[]) {
    if (sql.includes("SELECT key, value FROM settings")) {
      const rows = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return result(rows[0] ?? null, 0, rows);
    }
    if (sql.includes("COUNT(*) AS n FROM batches WHERE status = 'running'")) {
      return result({ n: batch.status === "running" ? 1 : 0 });
    }
    if (sql.includes("COUNT(*) AS pending")) {
      const pending = batch.status === "queued" || batch.status === "running" ? 1 : 0;
      return result({ pending });
    }
    if (sql.startsWith("SELECT id, status, window_start")) return result(run);
    if (sql.includes("SELECT status FROM runs")) return result({ status: run.status });
    if (sql.includes("batch_status")) {
      return result({
        batch_status: batch.status,
        lease_token: batch.lease_token,
        run_status: run.status,
      });
    }
    if (sql.includes("resume_json, defer_count FROM batches")) return result({ ...batch });
    if (sql.includes("next_wake_at, lease_expires_at FROM batches")) {
      return result({
        status: batch.status,
        next_wake_at: batch.next_wake_at,
        lease_expires_at: batch.lease_expires_at,
      });
    }
    if (sql.includes("FROM countries")) {
      return result({ id: "c1", name: "示例", code: "EX", enabled: 1 });
    }
    if (sql.includes("FROM targets")) {
      return result({
        id: "t1",
        country_id: "c1",
        kind: "keyword",
        name: "信号",
        query: "alpha signal",
        terms,
        exclude_terms: "",
        case_sensitive: 0,
        enabled: 1,
        description: "",
      }, 0, [{
        id: "t1",
        country_id: "c1",
        kind: "keyword",
        name: "信号",
        query: "alpha signal",
        terms,
        exclude_terms: "",
        case_sensitive: 0,
        enabled: 1,
        description: "",
      }]);
    }
    if (sql.includes("FROM records") && sql.includes("url_key")) {
      const urlKey = String(binds[0] ?? "");
      const titleKey = String(binds[1] ?? "");
      const matched = records.filter((row) => (urlKey && row.url_key === urlKey) || (titleKey && row.title_key === titleKey));
      return result(matched[0] ?? null, 0, matched.map((row) => ({
        url_key: row.url_key,
        title_key: row.title_key,
        published_at: row.published_at,
      })));
    }
    if (sql.includes("FROM records")) return result(null, 0, []);
    if (sql.includes("INSERT OR IGNORE INTO rate_slots")) {
      const name = String(binds[0]);
      if (!slots.has(name)) slots.set(name, 0);
      return result(null, 1);
    }
    if (sql.includes("UPDATE rate_slots") && sql.includes("RETURNING")) {
      const now = Number(binds[0]);
      const interval = Number(binds[1]);
      const name = String(binds[2]);
      const limit = Number(binds[3]);
      const nextAt = slots.get(name) ?? 0;
      if (nextAt > limit) return result(null, 0, []);
      const slotAt = Math.max(nextAt, now);
      slots.set(name, slotAt + interval);
      return result({ next_at_ms: slotAt + interval }, 1);
    }
    if (sql.includes("SELECT next_at_ms FROM rate_slots")) {
      return result({ next_at_ms: slots.get(String(binds[0])) ?? 0 });
    }
    if (sql.includes("SET status = 'running', lease_token")) {
      const token = String(binds[0]);
      const lease = String(binds[1]);
      const attemptsOk = batch.attempts < Number(binds[4]);
      const claimable = batch.run_id === binds[3] && attemptsOk && (
        batch.status === "queued"
        || (batch.status === "running" && (batch.lease_expires_at == null || batch.lease_expires_at <= String(binds[5])))
      );
      if (!claimable) return result(null, 0, []);
      batch.status = "running";
      batch.lease_token = token;
      batch.lease_expires_at = lease;
      batch.next_wake_at = null;
      return result(null, 1);
    }
    if (sql.includes("SET attempts = attempts + 1")) {
      if (batch.lease_token === binds[1] && batch.status === "running") {
        batch.attempts += 1;
        return result(null, 1);
      }
      return result(null, 0, []);
    }
    if (sql.includes("SET attempts = CASE WHEN attempts > 0")) {
      if (batch.id === binds[0] && batch.status === "queued" && batch.attempts > 0) {
        batch.attempts -= 1;
        return result(null, 1);
      }
      return result(null, 0, []);
    }
    if (sql.includes("SET status = 'queued', lease_token = NULL") && sql.includes("lease_token = ?")) {
      if (batch.id === binds[0] && batch.lease_token === binds[1] && batch.status === "running") {
        batch.status = "queued";
        batch.lease_token = null;
        batch.lease_expires_at = null;
        return result(null, 1);
      }
      return result(null, 0, []);
    }
    if (sql.includes("SET lease_expires_at = ?") && sql.includes("status = 'running'")) {
      if (batch.id === binds[1] && batch.lease_token === binds[2] && batch.status === "running") {
        batch.lease_expires_at = String(binds[0]);
        return result(null, 1);
      }
      return result(null, 0, []);
    }
    if (sql.includes("SET resume_json")) {
      if (batch.id !== binds[7] || batch.lease_token !== binds[8] || batch.status !== "running") {
        return result(null, 0, []);
      }
      batch.resume_json = String(binds[0]);
      batch.calls += Number(binds[1]);
      batch.items_found += Number(binds[2]);
      batch.items_fetched += Number(binds[3]);
      batch.items_deduped += Number(binds[4]);
      batch.items_filtered += Number(binds[5]);
      batch.items_added += Number(binds[6]);
      return result(null, 1);
    }
    if (sql.includes("defer_count = defer_count + 1")) {
      if (batch.id !== binds[2] || batch.run_id !== binds[3] || (batch.status !== "queued" && batch.status !== "running")) {
        return result(null, 0, []);
      }
      batch.defer_count += 1;
      batch.defer_wait_sec += Number(binds[0]);
      batch.next_wake_at = String(binds[1]);
      if (batch.status === "running") batch.status = "queued";
      batch.lease_token = null;
      batch.lease_expires_at = null;
      return result({ defer_count: batch.defer_count, defer_wait_sec: batch.defer_wait_sec }, 1);
    }
    if (sql.includes("SET enqueued_at = ?") && sql.includes("status = 'queued'")) {
      if (batch.id === binds[1] && batch.status === "queued") {
        batch.enqueued_at = String(binds[0]);
        return result(null, 1);
      }
      return result(null, 0, []);
    }
    if (sql.includes("INSERT INTO records")) {
      const dedupe = String(binds[1]);
      if (records.some((row) => row.dedupe_key === dedupe)) return result(null, 0, []);
      records.push({
        dedupe_key: dedupe,
        source: String(binds[2]),
        external_id: binds[3] == null ? null : String(binds[3]),
        url: String(binds[4]),
        matched_term: String(binds[9]),
        original_text: String(binds[13]),
        title_key: String(binds[27] ?? ""),
        url_key: String(binds[29] ?? ""),
        published_at: binds[14] == null ? null : String(binds[14]),
      });
      return result(null, 1);
    }
    if (sql.includes("INSERT INTO api_usage") || sql.includes("INSERT INTO rate_events")) {
      return result(null, 1);
    }
    if (sql.includes("finalize_enqueued_at")) {
      if (sql.includes("SET finalize_enqueued_at = NULL")) return result(null, 1);
      const pending = batch.status === "queued" || batch.status === "running";
      if (!pending && (run.status === "running" || run.status === "partial")) return result(null, 1);
      return result(null, 0);
    }
    if (sql.includes("SET status = 'done'")) {
      if (batch.id !== binds[6] || batch.lease_token !== binds[7] || batch.status !== "running") {
        return result(null, 0, []);
      }
      batch.status = "done";
      batch.items_found += Number(binds[0]);
      batch.finished_at = String(binds[1]);
      batch.items_fetched += Number(binds[2]);
      batch.items_deduped += Number(binds[3]);
      batch.items_filtered += Number(binds[4]);
      batch.items_added += Number(binds[5]);
      batch.error = null;
      batch.lease_token = null;
      batch.lease_expires_at = null;
      batch.resume_json = null;
      batch.next_wake_at = null;
      return result(null, 1);
    }
    if (sql.includes("SET status = 'failed'")) {
      if (batch.status === "done" || batch.status === "failed" || batch.status === "cancelled") {
        return result(null, 0, []);
      }
      batch.status = "failed";
      batch.error = String(binds[0]);
      batch.finished_at = String(binds[1]);
      return result(null, 1);
    }
    if (sql.includes("batches_failed = batches_failed + 1")) {
      run.batches_failed += 1;
      return result(null, 1);
    }
    if (sql.includes("batches_done = batches_done + 1")) {
      run.records_added += Number(binds[0]);
      run.batches_done += 1;
      run.relevance_failed += Number(binds[1]);
      return result(null, 1);
    }
    if (sql.includes("records_added = records_added + ?")) {
      run.records_added += Number(binds[0]);
      run.relevance_failed += Number(binds[1]);
      return result(null, 1);
    }
    throw new Error(`未预期的 SQL：${sql}`);
  }

  const statement = (sql: string, binds: unknown[]) => ({
    all: async () => ({ results: execute(sql, binds).results }),
    first: async () => {
      const outcome = execute(sql, binds);
      return outcome.changes === 0 && outcome.first == null ? null : outcome.first;
    },
    run: async () => ({ meta: { changes: execute(sql, binds).changes } }),
  });
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => statement(sql, binds),
        ...statement(sql, []),
      };
    },
    batch: async (list: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) => {
      const outcomes = [];
      for (const item of list) outcomes.push(await item.run());
      return outcomes;
    },
  };
  const env = {
    ENVIRONMENT: "development",
    EXCEL_FILENAME: "skyeyes.xlsx",
    TWITTERAPI_IO_KEY: "test-key",
    DEEPSEEK_API_KEY: options.deepseekKey ?? "",
    AI: {
      async run() {
        return { translated_text: "中文译文已经足够长。", response: "80" };
      },
    },
    DB: db,
    COLLECT_QUEUE: {
      async send(body: Wake["body"], options?: { delaySeconds?: number }) {
        wakes.push({ body, delaySeconds: options?.delaySeconds ?? 0 });
      },
      async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
        for (const message of messages) {
          wakes.push({
            body: message.body as Wake["body"],
            delaySeconds: message.delaySeconds ?? 0,
          });
        }
      },
    },
    EXPORTS: { async put() {} },
  } as unknown as Env;

  async function deliver(body: Wake["body"] = { type: "batch", runId: "run-1", batchId: "batch-1" }) {
    try {
      if (body.type === "batch") await processBatch(env, body.runId, body.batchId);
      return "ack" as const;
    } catch (error) {
      retries.push(error);
      return "retry" as const;
    }
  }

  return { env, batch, run, records, wakes, retries, slots, deliver };
}

describe("推迟不消耗队列重试", () => {
  it("X 在 0.2 QPS 下在一次调用里按间隔睡完两条词各 5 页", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    let slept = 0;
    pacing.sleep = async (ms) => {
      slept += ms;
      clock += ms;
    };
    const fetches: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      fetches.push(`${url.searchParams.get("query")}|${url.searchParams.get("cursor") ?? ""}`);
      const query = url.searchParams.get("query") ?? "";
      const term = query.includes("beta signal") ? "beta" : "alpha";
      const cursor = url.searchParams.get("cursor") ?? "";
      const page = cursor ? Number(cursor.slice(1)) : 1;
      return Response.json({
        tweets: [{
          id: `${term}-${page}`,
          text: `${term} signal coverage continues across the monitored region today ${page}`,
          url: `https://x.com/a/status/${term}-${page}`,
          createdAt: "Tue Oct 13 12:00:00 +0000 2026",
          author: { userName: "reporter", name: "Reporter" },
        }],
        has_next_page: page < 5,
        next_cursor: page < 5 ? `p${page + 1}` : "",
      });
    };

    const memory = createMemory({ source: "x" });
    const first = await memory.deliver();
    expect(first).toBe("ack");
    expect(memory.retries).toHaveLength(0);
    expect(memory.batch.status).toBe("done");
    expect(memory.batch.defer_count).toBe(0);
    expect(slept).toBe(9 * 5000);
    expect(fetches).toHaveLength(10);
    expect(new Set(fetches).size).toBe(10);
    expect(fetches.filter((item) => item.startsWith('"alpha signal"'))).toHaveLength(5);
    expect(fetches.filter((item) => item.startsWith('"beta signal"'))).toHaveLength(5);
    expect(memory.records).toHaveLength(10);
    expect(new Set(memory.records.map((row) => row.external_id)).size).toBe(10);
    expect(memory.batch.items_added).toBe(10);
    expect(memory.run.records_added).toBe(10);
    expect(memory.batch.attempts).toBe(1);
    expect(memory.batch.resume_json).toBeNull();
    expect(memory.wakes.filter((wake) => wake.body.type === "batch")).toHaveLength(0);
    expect(memory.wakes.filter((wake) => wake.body.type === "finalize")).toHaveLength(1);
  });

  it("GDELT 连续 429 只增加推迟次数，不把批次打进死信", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    let hits = 0;
    globalThis.fetch = async () => {
      hits += 1;
      if (hits <= 12) return new Response("slow", { status: 429 });
      return Response.json({
        articles: [{
          url: "https://news.example/after-storm",
          title: "alpha signal coverage continues across the region today",
          seendate: "20261013T120000Z",
          domain: "news.example",
        }],
      });
    };
    const memory = createMemory({ source: "gdelt" });
    const delays: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const outcome = await memory.deliver();
      expect(outcome).toBe("ack");
      const wake = memory.wakes.shift();
      expect(wake?.body.type).toBe("batch");
      delays.push(wake?.delaySeconds ?? 0);
      clock += (wake?.delaySeconds ?? 0) * 1000;
      expect(memory.batch.status).toBe("queued");
      expect(memory.batch.attempts).toBe(0);
    }
    expect(memory.retries).toHaveLength(0);
    expect(memory.batch.defer_count).toBe(12);
    expect(delays.slice(0, 4)).toEqual([30, 60, 120, 120]);
    expect(memory.records).toHaveLength(0);

    await handleDeadLetter(memory.env, { type: "batch", runId: "run-1", batchId: "batch-1" });
    expect(memory.batch.status).toBe("queued");

    const done = await memory.deliver();
    expect(done).toBe("ack");
    expect(memory.batch.status).toBe("done");
    expect(memory.records).toHaveLength(1);
    expect(memory.records[0]?.matched_term).toBe("alpha signal");
    expect(memory.retries).toHaveLength(0);
  });

  it("真正的 5xx 仍走队列重试，推迟次数用尽才失败且不再入队", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    globalThis.fetch = async () => new Response("bad", { status: 500 });
    const memory = createMemory({ source: "gdelt" });
    const outcome = await memory.deliver();
    expect(outcome).toBe("retry");
    expect(memory.batch.status).toBe("queued");
    expect(memory.batch.attempts).toBe(1);
    expect(memory.batch.defer_count).toBe(0);
    expect(memory.wakes.filter((wake) => wake.body.type === "batch")).toHaveLength(0);
    expect(String(memory.retries[0])).toContain("GDELT 500");

    const capped = createMemory({
      source: "gdelt",
      batch: { defer_wait_sec: MAX_DEFER_WAIT_SEC - 1, status: "queued" },
    });
    await scheduleDeferredWake(capped.env, "run-1", "batch-1", null, 30);
    expect(capped.batch.status).toBe("failed");
    expect(capped.batch.error).toContain("等待过久");
    expect(capped.wakes.filter((wake) => wake.body.type === "batch")).toHaveLength(0);

    const bare = createMemory({ source: "x" });
    await handleDeadLetter(bare.env, { type: "batch", runId: "run-1", batchId: "batch-1" });
    expect(bare.batch.status).toBe("failed");
    expect(bare.batch.error).toBe("超过队列重试次数");
  });
});

describe("子请求预算", () => {
  it("Google News 在预算用尽前写入 resume_json，并用延迟消息继续，不走 retry", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    const fetches: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const term = url.searchParams.get("q")?.match(/"([^"]+)"/)?.[1] ?? "term";
      const edition = url.searchParams.get("hl") ?? "edition";
      fetches.push(`${edition}|${term}`);
      const xml = `<?xml version="1.0"?><rss><channel><item>
        <title>${term} ${edition} bulletin covers a distinct corridor today</title>
        <link>https://news.example/${edition}/${term}</link>
        <pubDate>Tue, 13 Oct 2026 12:00:00 GMT</pubDate>
        <description>${term} ${edition} bulletin covers a distinct corridor today</description>
      </item></channel></rss>`;
      return new Response(xml);
    };
    const terms = ["signal0", "signal1", "signal2", "signal3", "signal4"].join("\n");
    const memory = createMemory({
      source: "google_news",
      terms,
      settings: {
        subrequest_budget: "8",
        google_news_min_interval_sec: "0",
        google_news_editions: "en-US,zh-CN",
      },
    });
    const first = await memory.deliver();
    expect(first).toBe("ack");
    expect(memory.retries).toHaveLength(0);
    expect(fetches).toHaveLength(8);
    expect(memory.batch.attempts).toBe(0);
    expect(memory.batch.status).toBe("queued");
    expect(memory.batch.defer_count).toBe(1);
    expect(JSON.parse(memory.batch.resume_json ?? "{}")).toMatchObject({ source: "google_news", step: 8 });
    expect(memory.wakes).toHaveLength(1);
    expect(memory.wakes[0]?.delaySeconds).toBe(1);
    expect(memory.wakes[0]?.body).toEqual({ type: "batch", runId: "run-1", batchId: "batch-1" });

    let steps = 0;
    while (memory.batch.status !== "done" && steps < 6) {
      const wake = memory.wakes.shift();
      expect(wake?.body.type).toBe("batch");
      clock += (wake?.delaySeconds ?? 0) * 1000;
      const outcome = await memory.deliver(wake?.body);
      expect(outcome).toBe("ack");
      steps += 1;
    }
    expect(memory.batch.status).toBe("done");
    expect(memory.retries).toHaveLength(0);
    expect(fetches).toHaveLength(10);
    expect(memory.batch.attempts).toBe(1);
    expect(memory.batch.resume_json).toBeNull();
    expect(memory.records.length).toBeGreaterThan(0);
  });

  it("同一页的翻译超出预算时先入库已完成的条目，下次重抓这一页并补上剩下的", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    let rss = 0;
    let deepseek = 0;
    const titles = [
      "alpha signal bulletin covers the northern corridor in full today",
      "alpha signal leaders gathered for a separate southern meeting",
      "alpha signal statement arrived after the evening briefing ended",
      "alpha signal attack reported near the mountain checkpoint overnight",
    ];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        deepseek += 1;
        return Response.json({
          choices: [{
            message: {
              content: JSON.stringify({
                relevant: true,
                score: 80,
                reason: "相关",
                source_lang: "en",
                translation_zh: "武装组织宣布在北部地区发动新的袭击。",
                summary_zh: "宣布袭击",
                event_type: "attack",
                people: [],
                places: [],
              }),
            },
          }],
        });
      }
      rss += 1;
      const items = titles.map((title, index) => `<item>
        <title>${title}</title>
        <link>https://news.example/story-${index}</link>
        <pubDate>Tue, 13 Oct 2026 12:00:00 GMT</pubDate>
        <description>${title}</description>
      </item>`).join("");
      return new Response(`<?xml version="1.0"?><rss><channel>${items}</channel></rss>`);
    };
    const memory = createMemory({
      source: "google_news",
      terms: "alpha signal",
      deepseekKey: "test-key",
      settings: {
        subrequest_budget: "8",
        google_news_min_interval_sec: "0",
        google_news_editions: "en-US",
        ai_enabled: "1",
        ai_provider: "deepseek",
        translation_enabled: "1",
        relevance_enabled: "1",
      },
    });
    const first = await memory.deliver();
    expect(first).toBe("ack");
    expect(memory.retries).toHaveLength(0);
    expect(rss).toBe(1);
    expect(deepseek).toBe(3);
    expect(memory.records).toHaveLength(3);
    expect(memory.batch.attempts).toBe(0);
    expect(JSON.parse(memory.batch.resume_json ?? "{}")).toMatchObject({ source: "google_news", step: 0 });
    expect(memory.wakes[0]?.delaySeconds).toBe(1);

    const wake = memory.wakes.shift();
    clock += (wake?.delaySeconds ?? 0) * 1000;
    const second = await memory.deliver(wake?.body);
    expect(second).toBe("ack");
    expect(memory.retries).toHaveLength(0);
    expect(memory.batch.status).toBe("done");
    expect(rss).toBe(2);
    expect(deepseek).toBe(4);
    expect(memory.records).toHaveLength(4);
    expect(memory.batch.attempts).toBe(1);
  });

  it("X 翻页同样受预算限制，并从上次的页码和 cursor 继续", async () => {
    let clock = Date.parse("2026-10-14T03:00:00.000Z");
    Date.now = () => clock;
    const fetches: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "";
      const cursor = url.searchParams.get("cursor") ?? "";
      fetches.push(`${query}|${cursor}`);
      const term = query.includes("beta signal") ? "beta" : "alpha";
      const page = cursor ? Number(cursor.slice(1)) : 1;
      return Response.json({
        tweets: [{
          id: `${term}-${page}`,
          text: `${term} signal coverage continues across the monitored region today ${page}`,
          url: `https://x.com/a/status/${term}-${page}`,
          createdAt: "Tue Oct 13 12:00:00 +0000 2026",
          author: { userName: "reporter", name: "Reporter" },
        }],
        has_next_page: page < 5,
        next_cursor: page < 5 ? `p${page + 1}` : "",
      });
    };
    const memory = createMemory({
      source: "x",
      settings: { subrequest_budget: "8", x_qps: "20", x_max_pages: "5" },
    });
    const first = await memory.deliver();
    expect(first).toBe("ack");
    expect(memory.retries).toHaveLength(0);
    expect(fetches).toHaveLength(8);
    expect(memory.batch.attempts).toBe(0);
    expect(JSON.parse(memory.batch.resume_json ?? "{}")).toMatchObject({
      source: "x",
      step: 1,
      page: 3,
      cursor: "p4",
    });
    expect(memory.wakes[0]?.delaySeconds).toBe(1);

    let steps = 0;
    while (memory.batch.status !== "done" && steps < 6) {
      const wake = memory.wakes.shift();
      clock += (wake?.delaySeconds ?? 0) * 1000;
      const outcome = await memory.deliver(wake?.body);
      expect(outcome).toBe("ack");
      steps += 1;
    }
    expect(memory.batch.status).toBe("done");
    expect(memory.retries).toHaveLength(0);
    expect(fetches).toHaveLength(10);
    expect(memory.records).toHaveLength(10);
    expect(memory.batch.attempts).toBe(1);
  });
});
