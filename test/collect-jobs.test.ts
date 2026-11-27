import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";
import { handleScheduled } from "../src/schedule";
import { asD1, openDatabase } from "./helpers/d1";

function harness() {
  const sqlite = openDatabase();
  const env = {
    ENVIRONMENT: "development",
    DB: asD1(sqlite),
    COLLECT_QUEUE: { async send() {}, async sendBatch() {} },
  } as unknown as Env;
  const ctx = {
    access: { async getIdentity() { return { email: "dev@example.com" }; } },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { sqlite, env, ctx, app: createApp() };
}

const tenShanghai = Date.parse("2026-11-05T02:00:00.000Z");

describe("采集任务", () => {
  it("可以保存定时和手动任务，并立刻按所选分组开跑", async () => {
    const h = harness();
    const created = await h.app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "试跑乙组",
        kind: "manual",
        enabled: true,
        windowHours: 6,
        countryIds: ["country_demo_beta"],
      }),
    }, h.env, h.ctx);
    expect(created.status).toBe(201);
    const job = await created.json() as { id: string; countryIds: string[] };
    expect(job.countryIds).toEqual(["country_demo_beta"]);

    const rejected = await h.app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "坏小时", kind: "schedule", enabled: true, scheduleHour: 24, countryIds: [] }),
    }, h.env, h.ctx);
    expect(rejected.status).toBe(400);

    const started = await h.app.request(`/api/jobs/${job.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, h.env, h.ctx);
    expect(started.status).toBe(202);
    const { runId } = await started.json() as { runId: string };
    const run = h.sqlite.prepare("SELECT trigger, notes, scope_json, window_start, window_end FROM runs WHERE id = ?").get(runId) as {
      trigger: string; notes: string; scope_json: string; window_start: string; window_end: string;
    };
    expect(run.trigger).toBe("manual");
    expect(run.notes).toContain("试跑乙组");
    expect(JSON.parse(run.scope_json).countries).toEqual([{ id: "country_demo_beta", name: "示例国家乙" }]);
    expect(new Date(run.window_end).getTime() - new Date(run.window_start).getTime()).toBe(6 * 60 * 60 * 1000);
    h.sqlite.close();
  });

  it("到点启动定时任务；全局小时未到时不跑全局任务，已有运行则跳过", async () => {
    const h = harness();
    h.sqlite.prepare("INSERT INTO settings (key, value) VALUES ('schedule_hour', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const created = await h.app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "上午乙组",
        kind: "schedule",
        enabled: true,
        scheduleHour: 10,
        countryIds: ["country_demo_beta"],
      }),
    }, h.env, h.ctx);
    const job = await created.json() as { id: string };

    await handleScheduled(h.env, Date.parse("2026-11-05T01:00:00.000Z"));
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM runs").get()).toMatchObject({ n: 0 });

    await handleScheduled(h.env, tenShanghai);
    const runs = h.sqlite.prepare("SELECT id, trigger, slot_key, notes FROM runs").all() as Array<{
      id: string; trigger: string; slot_key: string; notes: string;
    }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "schedule", notes: "采集任务：上午乙组" });
    expect(runs[0].slot_key).toBe(`job:${job.id}:2026-11-05T10`);

    await handleScheduled(h.env, tenShanghai + 60_000);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM runs").get()).toMatchObject({ n: 1 });
    h.sqlite.close();
  });
});
