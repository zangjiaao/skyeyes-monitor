import { openDatabase, asD1 } from "./helpers/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectMessage } from "../src/pipeline/messages";
import { COORDINATOR_WALL_MS } from "../src/pipeline/lease";
import { createApp } from "../src/http/app";
import { pacing } from "../src/pipeline/pacing";
import { ActiveRunError, RunScopeError, finalizeRun, processBatch, startRun } from "../src/pipeline/run";

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalSleep = pacing.sleep;
const originalPacingNow = pacing.now;

afterEach(() => {
  vi.restoreAllMocks();
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  pacing.sleep = originalSleep;
  pacing.now = originalPacingNow;
});


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


describe("按分组诊断采集", () => {
  it("区分上游命中、规则和时间过滤、跨组去重、仅入库和插入冲突", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlite = openDatabase();
    sqlite.exec("DELETE FROM targets; DELETE FROM countries;");
    for (const [key, value] of Object.entries({
      x_enabled: "1", google_news_enabled: "0", gdelt_enabled: "0",
      ai_enabled: "0", translation_enabled: "0", relevance_enabled: "0", x_qps: "2",
    })) {
      sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    }
    for (const [id, name] of [["old", "a-old"], ["new", "z-new"]]) {
      sqlite.prepare("INSERT INTO countries VALUES (?, ?, ?, 1, ?)").run(id, name, id, "2026-10-13T00:00:00Z");
      sqlite.prepare(`INSERT INTO targets (id, country_id, kind, name, query, enabled, created_at)
        VALUES (?, ?, 'keyword', ?, 'ProbeKeyword', 1, ?)`)
        .run(id, id, name, "2026-10-13T00:00:00Z");
    }
    const now = new Date("2026-10-14T02:00:00Z");
    pacing.sleep = async () => {};
    const tweet = (id: string, text: string, createdAt?: string) => ({ id, text, createdAt });
    globalThis.fetch = async () => Response.json({ tweets: [
      tweet("good", "ProbeKeyword announces a significant new development today", "2026-10-14T01:00:00Z"),
      tweet("short", "ProbeKeyword", "2026-10-14T01:00:00Z"),
      tweet("outside", "Older announcement regarding ProbeKeyword from last week", "2026-10-01T01:00:00Z"),
      tweet("unknown", "Unconfirmed date for the report about ProbeKeyword"),
      tweet("no-hit", "This unrelated article does not contain the search term", "2026-10-14T01:00:00Z"),
    ], has_next_page: false });
    const messages: CollectMessage[] = [];
    const env = {
      DB: asD1(sqlite), TWITTERAPI_IO_KEY: "secret-key-never-log",
      COLLECT_QUEUE: {
        async send(body: CollectMessage) { messages.push(body); },
        async sendBatch(batch: Iterable<{ body: CollectMessage }>) {
          for (const item of batch) messages.push(item.body);
        },
      },
    } as unknown as Env;
    const started = await startRun(env, {
      trigger: "manual", now, slotKey: "",
      windowStart: new Date("2026-10-13T02:00:00Z"), windowEnd: now,
    });
    const batch = messages.find((message) => message.type === "batch");
    if (!batch || batch.type !== "batch") throw new Error("missing batch");
    await processBatch(env, started.runId, batch.batchId);
    const entries = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(entries.filter((entry) => entry.message === "run group planned")).toHaveLength(2);
    expect(entries.find((entry) => entry.message === "source query request" && entry.countryId === "new"))
      .toMatchObject({ targetId: "new", targetName: "z-new", step: 1, page: 0 });
    expect(entries.find((entry) => entry.message === "source query result" && entry.countryId === "new"))
      .toMatchObject({ rawItems: 5, matchedItems: 4, rejectedItems: 1 });
    expect(entries.find((entry) => entry.message === "source page stored" && entry.countryId === "old"))
      .toMatchObject({ inserted: 2, added: 1, storeOnly: 1, reasons: {
        "rule:short": 1, "time:out_of_window": 1, "time:unknown": 1,
      } });
    expect(entries.find((entry) => entry.message === "source page stored" && entry.countryId === "new"))
      .toMatchObject({ inserted: 0, added: 0, reasons: {
        global_duplicate: 1, insert_conflict: 1, "rule:short": 1, "time:out_of_window": 1,
      } });
    expect(entries.find((entry) => entry.message === "batch done"))
      .toMatchObject({ items: 8, added: 1, filtered: 6, scope: "invocation" });
    expect(JSON.stringify(entries)).not.toContain("secret-key-never-log");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM records").get()).toMatchObject({ n: 2 });
    sqlite.close();
  });
});


describe("手动指定分组", () => {
  function harness() {
    const sqlite = openDatabase();
    const sent: CollectMessage[] = [];
    const env = {
      ENVIRONMENT: "development", DB: asD1(sqlite),
      COLLECT_QUEUE: {
        async send(body: CollectMessage) { sent.push(body); },
        async sendBatch(batch: Iterable<{ body: CollectMessage }>) {
          for (const item of batch) sent.push(item.body);
        },
      },
    } as unknown as Env;
    const ctx = {
      access: { async getIdentity() { return { email: "dev@example.com" }; } },
      waitUntil() {}, passThroughOnException() {},
    } as unknown as ExecutionContext;
    const now = new Date("2026-10-14T02:00:00Z");
    const input = {
      trigger: "manual" as const, now, slotKey: "",
      windowStart: new Date("2026-10-13T02:00:00Z"), windowEnd: now,
    };
    const idsFor = (runId: string) => sqlite.prepare("SELECT target_ids FROM batches WHERE run_id = ?")
      .all(runId).map((row) => JSON.parse(String(row.target_ids)) as string[]);
    return { sqlite, env, ctx, input, idsFor, sent };
  }

  it("API 创建的任务只包含指定分组的启用目标", async () => {
    const h = harness();
    const response = await createApp().request("/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryIds: ["country_demo_beta"] }),
    }, h.env, h.ctx);
    expect(response.status).toBe(202);
    const result = await response.json() as { runId: string };
    expect(h.idsFor(result.runId)).toEqual([["target_demo_b1"], ["target_demo_b1"]]);
    expect(h.sent.filter((message) => message.type === "batch")).toHaveLength(2);
    h.sqlite.close();
  });

  it("多选分组去重，不重复创建检索目标", async () => {
    const h = harness();
    const result = await startRun(h.env, { ...h.input,
      countryIds: ["country_demo_alpha", "country_demo_beta", "country_demo_beta"],
    });
    for (const ids of h.idsFor(result.runId)) {
      expect(ids.sort()).toEqual(["target_demo_a1", "target_demo_a2", "target_demo_b1"]);
    }
    h.sqlite.close();
  });

  it.each(["manual", "schedule"] as const)("%s 不指定范围时仍包含全部启用目标", async (trigger) => {
    const h = harness();
    const result = await startRun(h.env, { ...h.input, trigger });
    for (const ids of h.idsFor(result.runId)) {
      expect(ids.sort()).toEqual(["target_demo_a1", "target_demo_a2", "target_demo_b1"]);
    }
    h.sqlite.close();
  });

  it.each([[], null, "country_demo_alpha", [5], [""], ["missing"]])("API 拒绝无效分组范围 %j", async (countryIds) => {
    const h = harness();
    const response = await createApp().request("/api/runs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryIds }),
    }, h.env, h.ctx);
    expect(response.status).toBe(400);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM runs").get()).toMatchObject({ n: 0 });
    expect(h.sent).toHaveLength(0);
    h.sqlite.close();
  });

  it.each(["disabled", "empty"])("拒绝 %s 分组且不会取消已有运行", async (mode) => {
    const h = harness();
    const first = await startRun(h.env, h.input);
    if (mode === "disabled") h.sqlite.exec("UPDATE countries SET enabled = 0 WHERE id = 'country_demo_beta'");
    else h.sqlite.exec("UPDATE targets SET enabled = 0 WHERE country_id = 'country_demo_beta'");
    await expect(startRun(h.env, { ...h.input, countryIds: ["country_demo_beta"], confirm: true }))
      .rejects.toBeInstanceOf(RunScopeError);
    expect(h.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(first.runId)).toMatchObject({ status: "running" });
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM runs").get()).toMatchObject({ n: 1 });
    h.sqlite.close();
  });

  it("已有任务需要确认，确认后仍只采集选中的分组", async () => {
    const h = harness();
    const first = await startRun(h.env, h.input);
    await expect(startRun(h.env, { ...h.input, countryIds: ["country_demo_beta"] }))
      .rejects.toBeInstanceOf(ActiveRunError);
    const next = await startRun(h.env, { ...h.input, countryIds: ["country_demo_beta"], confirm: true });
    expect(h.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(first.runId)).toMatchObject({ status: "cancelled" });
    expect(h.idsFor(next.runId)).toEqual([["target_demo_b1"], ["target_demo_b1"]]);
    h.sqlite.close();
  });

  it("目标 API 保存、读取和切换匹配方式，旧文件导入不会重置模式", async () => {
    const h = harness();
    const app = createApp();
    const response = await app.request("/api/targets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId: "country_demo_beta", kind: "keyword", name: "Relations",
        terms: "Taiwan Japan", matchMode: "all_words" }),
    }, h.env, h.ctx);
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: string };
    expect(h.sqlite.prepare("SELECT match_mode FROM targets WHERE id = ?").get(id)).toMatchObject({ match_mode: "all_words" });
    const get = await app.request("/api/targets?countryId=country_demo_beta", {}, h.env, h.ctx);
    const payload = await get.json() as { targets: Array<{ id: string; match_mode: string }> };
    expect(payload.targets.find((row) => row.id === id)?.match_mode).toBe("all_words");
    for (const mode of ["phrase", "all_words"]) {
      const patched = await app.request(`/api/targets/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchMode: mode }),
      }, h.env, h.ctx);
      expect(patched.status).toBe(200);
      expect(h.sqlite.prepare("SELECT match_mode FROM targets WHERE id = ?").get(id)).toMatchObject({ match_mode: mode });
    }
    const invalid = await app.request(`/api/targets/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "should-not-save", matchMode: "unknown" }),
    }, h.env, h.ctx);
    expect(invalid.status).toBe(400);
    expect(h.sqlite.prepare("SELECT name FROM targets WHERE id = ?").get(id)).toMatchObject({ name: "Relations" });
    const form = new FormData();
    form.set("file", new File([
      `目标ID,分组代码,类型,显示名,检索词\n${id},demo-beta,keyword,Relations,Taiwan Japan\n`,
    ], "targets.csv", { type: "text/csv" }));
    const imported = await app.request("/api/targets/import", { method: "POST", body: form }, h.env, h.ctx);
    expect(imported.status).toBe(200);
    expect(h.sqlite.prepare("SELECT match_mode FROM targets WHERE id = ?").get(id)).toMatchObject({ match_mode: "all_words" });
    const exported = await app.request("/api/targets/export.csv", {}, h.env, h.ctx);
    expect(await exported.text()).toContain("all_words");
    for (const [targetId, name, mode] of [[id, "Relations", "phrase"], ["", "Imported", "all_words"], ["", "Imported", "phrase"]]) {
      const changedForm = new FormData();
      changedForm.set("file", new File([
        `目标ID,分组代码,类型,显示名,检索词,匹配方式\n${targetId},demo-beta,keyword,${name},Taiwan Japan,${mode}\n`,
      ], "targets.csv", { type: "text/csv" }));
      const changed = await app.request("/api/targets/import", { method: "POST", body: changedForm }, h.env, h.ctx);
      expect(changed.status).toBe(200);
      expect(h.sqlite.prepare("SELECT match_mode FROM targets WHERE name = ?").get(name)).toMatchObject({ match_mode: mode });
    }
    expect(h.sqlite.prepare("SELECT match_mode FROM targets WHERE id = 'target_demo_b1'").get()).toMatchObject({ match_mode: "phrase" });
    h.sqlite.close();
  });

  it("所选分组任务将保存的 all_words 模式传给查询与校验并实际入库", async () => {
    const h = harness();
    h.sqlite.exec("UPDATE targets SET enabled = 0;");
    for (const [key, value] of Object.entries({
      google_news_enabled: "0", ai_enabled: "0", translation_enabled: "0", relevance_enabled: "0",
    })) h.sqlite.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, value);
    const response = await createApp().request("/api/targets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ countryId: "country_demo_beta", kind: "keyword", name: "Relations",
        terms: "Taiwan Japan", matchMode: "all_words" }),
    }, h.env, h.ctx);
    expect(response.status).toBe(201);
    h.env.TWITTERAPI_IO_KEY = "test-key";
    const queries: string[] = [];
    globalThis.fetch = async (input) => {
      queries.push(new URL(String(input)).searchParams.get("query") ?? "");
      return Response.json({ tweets: [
        { id: "relation-1", text: "Japan strengthens economic ties with Taiwan today", createdAt: "2026-10-14T01:00:00Z" },
        { id: "relation-2", text: "Japan reports unrelated domestic developments today", createdAt: "2026-10-14T01:00:00Z" },
      ], has_next_page: false });
    };
    const result = await startRun(h.env, { ...h.input, countryIds: ["country_demo_beta"] });
    const batch = h.sent.find((message) => message.type === "batch");
    if (!batch || batch.type !== "batch") throw new Error("missing batch");
    await processBatch(h.env, result.runId, batch.batchId);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^"Taiwan" "Japan" since_time:/);
    expect(h.sqlite.prepare("SELECT original_text, matched_term, country_id FROM records").all()).toEqual([
      expect.objectContaining({ original_text: "Japan strengthens economic ties with Taiwan today",
        matched_term: "Taiwan Japan", country_id: "country_demo_beta" }),
    ]);
    h.sqlite.close();
  });

});
