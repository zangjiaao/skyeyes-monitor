import { afterEach, describe, expect, it, vi } from "vitest";
import { batchActivity, runStallReason } from "../src/monitoring/run-view";
import { queryCount } from "../src/pipeline/query-plan";
import { recordRunEvent } from "../src/pipeline/events";
import { processBatch, startRun } from "../src/pipeline/run";
import { createApp } from "../src/http/app";
import { asD1, openDatabase } from "./helpers/d1";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
const now = new Date("2026-11-05T10:00:00Z");
const batch = { status: "queued", created_at: "2026-11-05T08:00:00Z", enqueued_at: "2026-11-05T08:00:01Z" };

describe("等待和卡住原因", () => {
  it("正常延后不算卡住，刚到续跑时间也不会立即报卡住", () => {
    expect(batchActivity({ ...batch, next_wake_at: "2026-11-05T10:10:00Z" }, "running", now))
      .toMatchObject({ label: "按计划等待续跑", stuckReason: null });
    expect(batchActivity({ ...batch, next_wake_at: "2026-11-05T09:59:59Z" }, "running", now).stuckReason).toBeNull();
    expect(batchActivity({ ...batch, next_wake_at: "2026-11-05T09:40:00Z" }, "running", now).stuckReason).toContain("续跑时间已过");
  });
  it("区分请求、AI 处理、租约过期和已结束任务", () => {
    const running = { ...batch, status: "running", lease_expires_at: "2026-11-05T10:10:00Z" };
    expect(batchActivity({ ...running, phase: "fetching" }, "running", now).label).toBe("查询上游接口");
    expect(batchActivity({ ...running, phase: "processing" }, "running", now).label).toBe("处理翻译、评分和入库");
    expect(batchActivity({ ...running, lease_expires_at: "2026-11-05T09:59:00Z" }, "running", now).stuckReason).toContain("租约已过期");
    expect(batchActivity(batch, "incomplete", now).stuckReason).toBeNull();
    expect(runStallReason({ status: "finalizing", started_at: "2026-11-05T08:00:00Z", deadline_at: "2026-11-05T11:00:00Z", finalize_enqueued_at: "2026-11-05T09:00:00Z" }, now)).toContain("收尾");
    expect(runStallReason({ status: "running", started_at: "2026-11-05T08:00:00Z", deadline_at: "2026-11-05T09:00:00Z" }, now)).toContain("保险检查");
  });
  it("计算各来源的真实检索条件总数", () => {
    const targets = [{ id: "t", name: "Relations", query: "Taiwan Japan", terms: ["Taiwan Japan", "Taiwan Pakistan"], kind: "keyword" as const }];
    expect(queryCount("x", targets, "en-US,zh-CN")).toBe(2);
    expect(queryCount("google_news", targets, "en-US,zh-CN")).toBe(4);
    expect(queryCount("gdelt", targets, "en-US,zh-CN")).toBe(1);
    expect(queryCount("gdelt", targets.map((target) => ({ ...target, matchMode: "all_words" as const })), "en-US")).toBe(2);
  });
});

function harness() {
  const sqlite = openDatabase();
  const sent: Array<{ type: string; runId: string; batchId?: string }> = [];
  const db = asD1(sqlite);
  const env = {
    ENVIRONMENT: "development", DB: db, TWITTERAPI_IO_KEY: "not-in-event-log",
    COLLECT_QUEUE: {
      async send(body: typeof sent[number]) { sent.push(body); },
      async sendBatch(messages: Iterable<{ body: typeof sent[number] }>) { for (const message of messages) sent.push(message.body); },
    },
  } as unknown as Env;
  const ctx = { access: { async getIdentity() { return { email: "dev@example.com" }; } }, waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return { sqlite, db, env, ctx, sent, app: createApp() };
}
async function start(h: ReturnType<typeof harness>) {
  return startRun(h.env, { trigger: "manual", now, slotKey: "", countryIds: ["country_demo_beta"],
    windowStart: new Date("2026-11-04T10:00:00Z"), windowEnd: now });
}

describe("任务执行记录", () => {
  it("采集事件在 DB 留存，详情展示快照、真实进度、返回量及过滤原因", async () => {
    const h = harness();
    for (const [key, value] of Object.entries({ google_news_enabled: "0", ai_enabled: "0", translation_enabled: "0", relevance_enabled: "0" })) {
      h.sqlite.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, value);
    }
    globalThis.fetch = async () => Response.json({ tweets: [
      { id: "short", text: "示例关键词乙", createdAt: "2026-11-05T09:00:00Z" },
    ], has_next_page: false });
    const result = await start(h);
    const queued = h.sent.find((message) => message.type === "batch")!;
    await processBatch(h.env, result.runId, queued.batchId!);
    const response = await h.app.request(`/api/runs/${result.runId}`, {}, h.env, h.ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.run.scope.countries).toEqual([{ id: "country_demo_beta", name: "示例国家乙" }]);
    expect(body.run.progress).toMatchObject({ queriesDone: 1, queriesTotal: 1, received: 1, fetched: 1, filtered: 1 });
    expect(body.batches[0].activity.label).toBe("已完成");
    const events = await (await h.app.request(`/api/runs/${result.runId}/events`, {}, h.env, h.ctx)).json() as any;
    expect(events.events.map((event: any) => event.type)).toContain("source query request");
    expect(events.events.find((event: any) => event.type === "source page stored").details.reasons).toEqual({ "rule:short": 1 });
    expect(JSON.stringify(events)).not.toContain("not-in-event-log");
    h.sqlite.prepare("UPDATE countries SET name = 'Renamed' WHERE id = 'country_demo_beta'").run();
    const again = await (await h.app.request(`/api/runs/${result.runId}`, {}, h.env, h.ctx)).json() as any;
    expect(again.run.scope.countries[0].name).toBe("示例国家乙");
    h.sqlite.close();
  });

  it("分页游标严格属于当前任务，筛选及计数正确", async () => {
    const h = harness();
    const result = await start(h);
    const row = h.sqlite.prepare("SELECT id FROM batches WHERE run_id = ? LIMIT 1").get(result.runId)!;
    for (let index = 0; index < 60; index += 1) await recordRunEvent(h.db, { runId: result.runId, batchId: String(row.id), type: "source query response", details: { status: 200, page: index } });
    const first = await (await h.app.request(`/api/runs/${result.runId}/events`, {}, h.env, h.ctx)).json() as any;
    expect(first.events).toHaveLength(50);
    expect(first.nextBefore).toBeGreaterThan(0);
    const second = await (await h.app.request(`/api/runs/${result.runId}/events?before=${first.nextBefore}`, {}, h.env, h.ctx)).json() as any;
    expect(second.events).toHaveLength(11); // 60 responses plus run-started
    expect(second.nextBefore).toBeNull();
    expect(new Set([...first.events, ...second.events].map((event: any) => event.id)).size).toBe(61);
    expect((await h.app.request(`/api/runs/${result.runId}/events?before=oops`, {}, h.env, h.ctx)).status).toBe(400);
    expect((await h.app.request('/api/runs/missing/events', {}, h.env, h.ctx)).status).toBe(404);
    const active = await (await h.app.request('/api/runs?status=active', {}, h.env, h.ctx)).json() as any;
    expect(active.total).toBe(1);
    expect(active.runs[0].id).toBe(result.runId);
    expect((await h.app.request('/api/runs?page=0', {}, h.env, h.ctx)).status).toBe(400);
    h.sqlite.close();
  });

  it("详情中区分实际入库、AI 异常与任务完成", async () => {
    const h = harness();
    const result = await start(h);
    h.sqlite.prepare("UPDATE runs SET status = 'completed', relevance_failed = 1 WHERE id = ?").run(result.runId);
    h.sqlite.prepare(`INSERT INTO records (id, dedupe_key, source, url, country_id, country_name, matched_target,
      original_text, published_at, collected_at, run_id, translation_status, translation_error, relevance_error)
      VALUES ('record', 'unique', 'x', 'https://example.com', 'country_demo_beta', '示例国家乙', 'target', 'text',
        '2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z', ?, 'translation_failed', 'translation unavailable', 'score unavailable')`).run(result.runId);
    const detail = await (await h.app.request(`/api/runs/${result.runId}`, {}, h.env, h.ctx)).json() as any;
    expect(detail.records).toMatchObject({ stored: 1, translationFailed: 1, relevanceFailed: 1 });
    expect(detail.issues[0]).toMatchObject({ translation_error: "translation unavailable", relevance_error: "score unavailable" });
    const attention = await (await h.app.request('/api/runs?status=attention', {}, h.env, h.ctx)).json() as any;
    expect(attention.total).toBe(1);
    h.sqlite.prepare("UPDATE runs SET relevance_failed = 0 WHERE id = ?").run(result.runId);
    const translationOnly = await (await h.app.request('/api/runs?status=attention', {}, h.env, h.ctx)).json() as any;
    expect(translationOnly.total).toBe(1);
    expect(translationOnly.runs[0].translation_failed).toBe(1);
    h.sqlite.close();
  });

  it("总览不把未来续跑算卡住，也不会漏掉较早开始的执行中任务", async () => {
    const h = harness();
    const result = await start(h);
    const stale = new Date(Date.now() - 3600000).toISOString();
    const future = new Date(Date.now() + 3600000).toISOString();
    h.sqlite.prepare("UPDATE batches SET created_at = ?, enqueued_at = ?, next_wake_at = ? WHERE run_id = ?")
      .run(stale, stale, future, result.runId);
    let response = await (await h.app.request('/api/status', {}, h.env, h.ctx)).json() as any;
    expect(response.stuckBatches).toBe(0);
    h.sqlite.prepare("UPDATE batches SET next_wake_at = NULL, enqueued_at = ? WHERE source = 'x' AND run_id = ?")
      .run(`claim:${stale}:test`, result.runId);
    for (let index = 0; index < 35; index += 1) {
      h.sqlite.prepare(`INSERT INTO runs (id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at)
        VALUES (?, ?, 'manual', 'completed', ?, ?, ?, ?)`).run(`later-${index}`, `later-${index}`, future, future, future, future);
    }
    response = await (await h.app.request('/api/status', {}, h.env, h.ctx)).json() as any;
    expect(response.stuckBatches).toBe(1);
    expect(response.runs[0].id).toBe(result.runId);
    h.sqlite.close();
  });

  it("诊断存储失败不会让采集中断", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    const db = { prepare: h.db.prepare.bind(h.db), batch: async () => { throw new Error("diagnostic storage unavailable"); } } as unknown as D1Database;
    await expect(recordRunEvent(db, { runId: "any", type: "run started" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    h.sqlite.close();
  });
});
