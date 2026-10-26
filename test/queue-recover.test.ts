import { describe, expect, it } from "vitest";
import { parseSettings, validateSettingsPatch } from "../src/config/settings";
import { STALE_ENQUEUE_MS } from "../src/pipeline/lease";
import {
  ActiveRunError,
  cancelRun,
  claimBatch,
  processBatch,
  requeueStuckBatches,
  startRun,
} from "../src/pipeline/run";
import { tryReserveXSlot } from "../src/sources/x-rate";

interface RunRow {
  id: string;
  status: string;
  notes: string | null;
  finished_at: string | null;
  started_at: string;
  slot_key: string;
  window_start: string;
  window_end: string;
  batches_failed: number;
}

interface BatchRow {
  id: string;
  run_id: string;
  status: string;
  attempts: number;
  enqueued_at: string | null;
  next_wake_at?: string | null;
  lease_expires_at: string | null;
  lease_token: string | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  batch_index: number;
  source: string;
  country_id: string;
  target_ids: string;
}

const RECOVERABLE = new Set(["running", "partial", "failed"]);

function createHarness(seed: { runs?: RunRow[]; batches?: BatchRow[] } = {}) {
  const runs = new Map((seed.runs ?? []).map((row) => [row.id, { ...row }]));
  const batches = new Map((seed.batches ?? []).map((row) => [row.id, { ...row }]));
  const sent: MessageSendRequest<unknown>[] = [];
  const statements: string[] = [];

  function runOf(id: string | undefined): RunRow | undefined {
    return id ? runs.get(id) : undefined;
  }

  function recoverableBatches(runId?: string): BatchRow[] {
    return [...batches.values()].filter((batch) => {
      if (runId && batch.run_id !== runId) return false;
      const run = runOf(batch.run_id);
      return Boolean(run && RECOVERABLE.has(run.status));
    });
  }

  function scopeRunId(sql: string, binds: unknown[]): string | undefined {
    if (!sql.includes("run_id = ?")) return undefined;
    const last = binds[binds.length - 1];
    return typeof last === "string" ? last : undefined;
  }

  function execute(sql: string, binds: unknown[]): { results: unknown[]; first: unknown; changes: number } {
    statements.push(sql);
    const runId = scopeRunId(sql, binds);

    if (sql.includes("LIKE 'claim:%'")) {
      const cutoff = String(binds[0]);
      let changes = 0;
      for (const batch of batches.values()) {
        if (runId && batch.run_id !== runId) continue;
        if (batch.status === "queued" && batch.enqueued_at?.startsWith("claim:") && batch.enqueued_at < cutoff) {
          batch.enqueued_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("超过重试次数") && sql.includes("attempts >= ?") && sql.startsWith("UPDATE")) {
      const nowIso = String(binds[0]);
      const maxAttempts = Number(binds[1]);
      const force = Number(binds[2]) === 1;
      const now = String(binds[3]);
      let changes = 0;
      for (const batch of recoverableBatches(runId)) {
        const expired = batch.lease_expires_at == null || batch.lease_expires_at <= now;
        if (batch.status === "running" && batch.attempts >= maxAttempts && (force || expired)) {
          batch.status = "failed";
          batch.error = "超过重试次数";
          batch.finished_at = nowIso;
          batch.lease_token = null;
          batch.lease_expires_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SET status = 'queued', lease_token = NULL") && sql.includes("status = 'running'")) {
      const maxAttempts = Number(binds[0]);
      const force = Number(binds[1]) === 1;
      const now = String(binds[2]);
      let changes = 0;
      for (const batch of recoverableBatches(runId)) {
        const expired = batch.lease_expires_at == null || batch.lease_expires_at <= now;
        if (batch.status === "running" && batch.attempts < maxAttempts && (force || expired)) {
          batch.status = "queued";
          batch.lease_token = null;
          batch.lease_expires_at = null;
          batch.enqueued_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("未入队：%'")) {
      let changes = 0;
      for (const batch of recoverableBatches(runId)) {
        if (batch.status === "failed" && (batch.error ?? "").startsWith("未入队：")) {
          batch.status = "queued";
          batch.error = null;
          batch.finished_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SET enqueued_at = NULL") && sql.includes("enqueued_at IS NOT NULL")) {
      const force = Number(binds[0]) === 1;
      const staleBefore = String(binds[1]);
      const respectsWake = sql.includes("next_wake_at");
      const wakeForce = respectsWake ? Number(binds[2]) === 1 : true;
      const nowIso = respectsWake ? String(binds[3]) : "";
      let changes = 0;
      for (const batch of recoverableBatches(runId)) {
        const wakeDue = !respectsWake || wakeForce || !batch.next_wake_at || batch.next_wake_at <= nowIso;
        if (batch.status === "queued" && batch.enqueued_at && (force || batch.enqueued_at <= staleBefore) && wakeDue) {
          batch.enqueued_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SELECT DISTINCT run_id")) {
      const force = Number(binds[0]) === 1;
      const createdBefore = String(binds[1]);
      const respectsWake = sql.includes("next_wake_at");
      const wakeForce = respectsWake ? Number(binds[2]) === 1 : true;
      const nowIso = respectsWake ? String(binds[3]) : "";
      const ids = [...batches.values()]
        .filter((batch) => batch.status === "queued" && batch.enqueued_at == null)
        .filter((batch) => !runId || batch.run_id === runId)
        .filter((batch) => force || batch.created_at <= createdBefore)
        .filter((batch) => !respectsWake || wakeForce || !batch.next_wake_at || batch.next_wake_at <= nowIso)
        .map((batch) => batch.run_id);
      const results = [...new Set(ids)].map((id) => ({ run_id: id }));
      return { results, first: results[0] ?? null, changes: 0 };
    }

    if (sql.startsWith("SELECT status FROM runs")) {
      const run = runOf(String(binds[0]));
      return { results: run ? [run] : [], first: run ? { status: run.status } : null, changes: 0 };
    }

    if (sql.includes("status IN ('running', 'partial', 'finalizing')")) {
      const active = [...runs.values()]
        .filter((run) => run.status === "running" || run.status === "partial" || run.status === "finalizing")
        .sort((left, right) => right.started_at.localeCompare(left.started_at));
      return { results: active, first: active[0] ?? null, changes: 0 };
    }

    if (sql.includes("SET status = 'running', finished_at = NULL")) {
      const run = runOf(String(binds[0]));
      let changes = 0;
      const reopenIncomplete = sql.includes("'incomplete'");
      if (run && (run.status === "failed" || (reopenIncomplete && run.status === "incomplete"))) {
        run.status = "running";
        run.finished_at = null;
        changes = 1;
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("UPDATE batches") && sql.includes("status = 'cancelled'")) {
      const id = String(binds[1]);
      let changes = 0;
      for (const batch of batches.values()) {
        const owner = sql.includes("run_id = ?") && !sql.includes("WHERE id = ?") ? id : batch.run_id;
        const matchesRun = sql.includes("WHERE id = ?") ? batch.id === id && batch.run_id === String(binds[2]) : batch.run_id === owner;
        if (matchesRun && (batch.status === "queued" || batch.status === "running")) {
          batch.status = "cancelled";
          batch.error = "已取消";
          batch.finished_at = String(binds[0]);
          batch.lease_token = null;
          batch.lease_expires_at = null;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("UPDATE runs") && sql.includes("status = 'cancelled'")) {
      const run = runOf(String(binds[2]));
      let changes = 0;
      if (run && run.status !== "completed" && run.status !== "cancelled") {
        run.status = "cancelled";
        run.finished_at = String(binds[0]);
        run.notes = "已取消";
        changes = 1;
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SELECT id, status FROM runs WHERE id")) {
      const run = runOf(String(binds[0]));
      return { results: run ? [run] : [], first: run ?? null, changes: 0 };
    }

    if (sql.includes("FROM runs WHERE id")) {
      const run = runOf(String(binds[0]));
      return { results: run ? [run] : [], first: run ?? null, changes: 0 };
    }

    if (sql.includes("INSERT INTO runs")) {
      const row: RunRow = {
        id: String(binds[0]),
        slot_key: String(binds[1]),
        status: "running",
        notes: null,
        finished_at: null,
        started_at: String(binds[5]),
        window_start: String(binds[3]),
        window_end: String(binds[4]),
        batches_failed: 0,
      };
      runs.set(row.id, row);
      return { results: [], first: null, changes: 1 };
    }

    if (sql.includes("SELECT id, batch_index FROM batches") && sql.includes("enqueued_at IS NULL")) {
      let matched = [...batches.values()].filter((batch) => batch.run_id === binds[0] && batch.status === "queued" && batch.enqueued_at == null);
      if (sql.includes("created_at <= ?")) matched = matched.filter((batch) => batch.created_at <= String(binds[1]));
      matched.sort((left, right) => left.batch_index - right.batch_index);
      const results = matched.slice(0, 100).map((batch) => ({ id: batch.id, batch_index: batch.batch_index }));
      return { results, first: results[0] ?? null, changes: 0 };
    }

    if (sql.includes("SET enqueued_at = ?") && sql.includes("enqueued_at IS NULL") && sql.includes("id IN")) {
      const token = String(binds[0]);
      const owner = String(binds[1]);
      const ids = new Set(binds.slice(2).map(String));
      let changes = 0;
      for (const batch of batches.values()) {
        if (batch.run_id === owner && batch.status === "queued" && batch.enqueued_at == null && ids.has(batch.id)) {
          batch.enqueued_at = token;
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("WHERE run_id = ? AND enqueued_at = ?")) {
      const matched = [...batches.values()]
        .filter((batch) => batch.run_id === binds[0] && batch.enqueued_at === binds[1])
        .sort((left, right) => left.batch_index - right.batch_index)
        .map((batch) => ({ id: batch.id, batch_index: batch.batch_index }));
      return { results: matched, first: matched[0] ?? null, changes: 0 };
    }

    if (sql.includes("SET enqueued_at = ? WHERE enqueued_at = ?")) {
      let changes = 0;
      for (const batch of batches.values()) {
        if (batch.enqueued_at === binds[1]) {
          batch.enqueued_at = String(binds[0]);
          changes += 1;
        }
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SUM(CASE WHEN status")) {
      const owner = String(binds[0]);
      const rows = [...batches.values()].filter((batch) => batch.run_id === owner);
      const count = (pred: (batch: BatchRow) => boolean) => rows.filter(pred).length;
      const sentCount = count((batch) => batch.enqueued_at != null && !batch.enqueued_at.startsWith("claim:") && ["queued", "running", "done"].includes(batch.status));
      const failed = count((batch) => batch.status === "failed");
      const pending = count((batch) => batch.status === "queued" && (batch.enqueued_at == null || batch.enqueued_at.startsWith("claim:")));
      const done = count((batch) => batch.status === "done");
      const running = count((batch) => batch.status === "queued" || batch.status === "running");
      const row = { sent: sentCount, failed, pending, done, n: rows.length };
      if (sql.includes("AS pending")) return { results: [row], first: { ...row, pending: running }, changes: 0 };
      return { results: [row], first: row, changes: 0 };
    }

    if (sql.includes("SELECT status, notes FROM runs")) {
      const run = runOf(String(binds[0]));
      return { results: run ? [run] : [], first: run ?? null, changes: 0 };
    }

    if (sql.includes("UPDATE runs") && sql.includes("status IN ('running', 'partial', 'failed')")) {
      const run = runOf(String(binds[binds.length - 1]));
      let changes = 0;
      if (run && ["running", "partial", "failed"].includes(run.status)) {
        run.status = String(binds[0]);
        run.notes = binds[1] == null ? null : String(binds[1]);
        changes = 1;
      }
      return { results: [], first: null, changes };
    }

    if (sql.includes("SET status = 'running', lease_token")) {
      const token = String(binds[0]);
      const lease = String(binds[1]);
      const id = String(binds[2]);
      const owner = String(binds[3]);
      const maxAttempts = Number(binds[4]);
      const now = String(binds[5]);
      const batch = batches.get(id);
      const claimable = Boolean(batch && batch.run_id === owner && batch.attempts < maxAttempts && (
        batch.status === "queued" || (batch.status === "running" && (batch.lease_expires_at == null || batch.lease_expires_at <= now))
      ));
      if (!claimable || !batch) return { results: [], first: null, changes: 0 };
      batch.status = "running";
      batch.lease_token = token;
      batch.lease_expires_at = lease;
      return { results: [], first: null, changes: 1 };
    }

    if (sql.includes("attempts >= ?") && sql.includes("status IN ('queued', 'running')")) {
      const id = String(binds[1]);
      const maxAttempts = Number(binds[3]);
      const now = String(binds[4]);
      const batch = batches.get(id);
      if (!batch || batch.attempts < maxAttempts) return { results: [], first: null, changes: 0 };
      const open = batch.status === "queued" || (batch.status === "running" && (batch.lease_expires_at == null || batch.lease_expires_at <= now));
      if (!open) return { results: [], first: null, changes: 0 };
      batch.status = "failed";
      batch.error = "超过重试次数";
      batch.finished_at = String(binds[0]);
      batch.lease_token = null;
      batch.lease_expires_at = null;
      return { results: [], first: null, changes: 1 };
    }

    if (sql.includes("FROM batches WHERE id = ?")) {
      const batch = batches.get(String(binds[0]));
      return { results: batch ? [batch] : [], first: batch ?? null, changes: 0 };
    }

    if (sql.includes("FROM settings")) return { results: [], first: null, changes: 0 };

    if (sql.includes("COUNT(*) AS n FROM batches WHERE status = 'running'")) {
      const n = [...batches.values()].filter((batch) => batch.status === "running").length;
      return { results: [{ n }], first: { n }, changes: 0 };
    }

    if (sql.includes("FROM countries")) return { results: [], first: null, changes: 0 };
    if (sql.includes("batches_total")) return { results: [], first: null, changes: 1 };
    if (sql.includes("SET status = 'finalizing'")) {
      const run = runOf(String(binds[0]));
      if (!run || (run.status !== "running" && run.status !== "partial")) return { results: [], first: null, changes: 0 };
      run.status = "finalizing";
      return { results: [], first: null, changes: 1 };
    }

    if (sql.includes("FROM records") || sql.includes("FROM recipients") || sql.includes("FROM batches")) {
      return { results: [], first: null, changes: 0 };
    }
    if (sql.includes("UPDATE runs")) return { results: [], first: null, changes: 0 };
    throw new Error(`未预期的 SQL：${sql}`);
  }

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
    batch: async (list: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const item of list) results.push(await item.run());
      return results;
    },
  };
  const env = {
    ENVIRONMENT: "development",
    EXCEL_FILENAME: "skyeyes.xlsx",
    DB: db,
    COLLECT_QUEUE: {
      async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
        sent.push(...messages);
      },
    },
    EXPORTS: { async put() {} },
  } as unknown as Env;
  return { env, runs, batches, sent, statements };
}

function run(id = "run-1", status = "running"): RunRow {
  return {
    id,
    status,
    notes: null,
    finished_at: null,
    started_at: "2026-10-13T02:00:00.000Z",
    slot_key: `slot-${id}`,
    window_start: "2026-10-12T02:00:00.000Z",
    window_end: "2026-10-13T02:00:00.000Z",
    batches_failed: 0,
  };
}

function batch(partial: Partial<BatchRow> & Pick<BatchRow, "id">): BatchRow {
  return {
    run_id: "run-1",
    status: "queued",
    attempts: 0,
    enqueued_at: "2026-10-13T02:00:00.000Z",
    lease_expires_at: null,
    lease_token: null,
    created_at: "2026-10-13T02:00:00.000Z",
    finished_at: null,
    error: null,
    batch_index: 0,
    source: "google_news",
    country_id: "c1",
    target_ids: "[]",
    ...partial,
  };
}

describe("队列以 D1 为准", () => {
  it("取消已入队和进行中的批次，之后的同步不会把运行改回进行中", async () => {
    const harness = createHarness({
      runs: [run()],
      batches: [
        batch({ id: "queued", enqueued_at: "2026-10-13T02:05:00.000Z" }),
        batch({ id: "running", status: "running", lease_expires_at: "2026-10-13T02:20:00.000Z", lease_token: "live" }),
        batch({ id: "done", status: "done" }),
      ],
    });
    const cancelled = await cancelRun(harness.env, "run-1");
    expect(cancelled.cancelledBatches).toBe(2);
    expect(harness.runs.get("run-1")?.status).toBe("cancelled");
    expect(harness.batches.get("queued")?.status).toBe("cancelled");
    expect(harness.batches.get("running")?.status).toBe("cancelled");
    expect(harness.batches.get("done")?.status).toBe("done");

    const recovered = await requeueStuckBatches(harness.env, { force: true, runId: "run-1" });
    expect(recovered.batches).toBe(0);
    expect(harness.sent).toHaveLength(0);
    expect(harness.runs.get("run-1")?.status).toBe("cancelled");
    expect(harness.batches.get("queued")?.status).toBe("cancelled");
  });

  it("丢失的唤醒和过期租约会被收回，刚入队的批次不会被自动重发", async () => {
    const now = new Date("2026-10-13T03:00:00.000Z");
    const stale = new Date(now.getTime() - STALE_ENQUEUE_MS - 60_000).toISOString();
    const harness = createHarness({
      runs: [run()],
      batches: [
        batch({ id: "lost", enqueued_at: stale, created_at: stale }),
        batch({ id: "fresh", enqueued_at: now.toISOString(), created_at: stale, batch_index: 1 }),
        batch({
          id: "expired",
          status: "running",
          attempts: 1,
          lease_expires_at: stale,
          lease_token: "old",
          created_at: stale,
          batch_index: 2,
        }),
        batch({
          id: "exhausted",
          status: "running",
          attempts: 5,
          lease_expires_at: stale,
          lease_token: "old-2",
          created_at: stale,
          batch_index: 3,
        }),
      ],
    });
    const recovered = await requeueStuckBatches(harness.env, { now });
    expect(harness.batches.get("exhausted")?.status).toBe("failed");
    expect(harness.batches.get("fresh")?.status).toBe("queued");
    expect(harness.batches.get("fresh")?.enqueued_at).toBe(now.toISOString());
    const ids = harness.sent.map((message) => (message.body as { batchId: string }).batchId).sort();
    expect(ids).toEqual(["expired", "lost"]);
    expect(harness.sent.every((message) => message.delaySeconds == null)).toBe(true);
    expect(recovered.batches).toBe(2);

    const forced = await requeueStuckBatches(harness.env, { now, force: true, runId: "run-1" });
    expect(forced.batches).toBeGreaterThan(0);
    expect(harness.sent.some((message) => (message.body as { batchId: string }).batchId === "fresh")).toBe(true);
  });

  it("还没到唤醒时间的批次不会被提前重发，手动恢复可以立刻重发", async () => {
    const now = new Date("2026-10-13T03:00:00.000Z");
    const stale = new Date(now.getTime() - STALE_ENQUEUE_MS - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();
    const harness = createHarness({
      runs: [run()],
      batches: [
        batch({ id: "waiting", enqueued_at: stale, created_at: stale, next_wake_at: future }),
      ],
    });
    const recovered = await requeueStuckBatches(harness.env, { now, runId: "run-1" });
    expect(recovered.batches).toBe(0);
    expect(harness.batches.get("waiting")?.enqueued_at).toBe(stale);
    expect(harness.sent).toHaveLength(0);

    const forced = await requeueStuckBatches(harness.env, { now, force: true, runId: "run-1" });
    expect(forced.batches).toBe(1);
    expect(harness.sent.map((message) => (message.body as { batchId: string }).batchId)).toEqual(["waiting"]);
  });

  it("租约还在时重复投递不会再次领取", async () => {
    const harness = createHarness({
      runs: [run()],
      batches: [batch({ id: "b1", status: "queued", enqueued_at: "2026-10-13T02:00:00.000Z" })],
    });
    const now = new Date();
    const first = await claimBatch(harness.env, "run-1", "b1", now);
    expect(first?.token).toBeTruthy();
    expect(harness.batches.get("b1")?.status).toBe("running");
    expect(harness.batches.get("b1")?.attempts).toBe(0);
    const second = await claimBatch(harness.env, "run-1", "b1", new Date(now.getTime() + 1000));
    expect(second).toBeNull();
    expect(harness.batches.get("b1")?.lease_token).toBe(first?.token);

    await processBatch(harness.env, "run-1", "b1");
    expect(harness.statements.some((sql) => sql.includes("INSERT INTO records"))).toBe(false);
    expect(harness.batches.get("b1")?.status).toBe("running");
    expect(harness.batches.get("b1")?.lease_token).toBe(first?.token);
  });

  it("进行中的运行会挡住下一轮，确认后才取消再开始", async () => {
    const harness = createHarness({
      runs: [run()],
      batches: [batch({ id: "live", status: "running", lease_token: "live" })],
    });
    const input = {
      trigger: "manual" as const,
      now: new Date("2026-10-13T04:00:00.000Z"),
      slotKey: "",
      windowStart: new Date("2026-10-12T04:00:00.000Z"),
      windowEnd: new Date("2026-10-13T04:00:00.000Z"),
    };
    await expect(startRun(harness.env, input)).rejects.toBeInstanceOf(ActiveRunError);
    expect(harness.runs.get("run-1")?.status).toBe("running");
    expect(harness.batches.get("live")?.status).toBe("running");

    const started = await startRun(harness.env, { ...input, confirm: true });
    expect(harness.runs.get("run-1")?.status).toBe("cancelled");
    expect(harness.batches.get("live")?.status).toBe("cancelled");
    expect(harness.runs.get(started.runId)?.status).not.toBe("cancelled");
    expect(parseSettings({}).queueConcurrency).toBe(4);
    expect(() => validateSettingsPatch({ queue_concurrency: "9" })).toThrow(/1 到 8/);
  });
});

describe("X 时间槽", () => {
  it("槽位还远时不占用下一次请求", async () => {
    let nextAt = 0;
    const db = {
      prepare(sql: string) {
        return {
          bind: (...binds: number[]) => ({
            run: async () => {
              if (sql.includes("INSERT OR IGNORE") && nextAt === 0) nextAt = 0;
              return { meta: { changes: 1 } };
            },
            first: async () => {
              if (sql.includes("UPDATE")) {
                const now = binds[0];
                const interval = binds[1];
                const limit = binds[3];
                if (nextAt <= limit) {
                  const slotAt = Math.max(nextAt, now);
                  nextAt = slotAt + interval;
                  return { next_at_ms: nextAt };
                }
                return null;
              }
              return { next_at_ms: nextAt };
            },
          }),
        };
      },
    } as unknown as D1Database;
    const now = 1_000_000;
    nextAt = now + 20_000;
    const deferred = await tryReserveXSlot(db, 0.2, 2_000, now);
    expect(deferred.ok).toBe(false);
    expect(deferred.waitMs).toBe(20_000);
    expect(nextAt).toBe(now + 20_000);
    nextAt = now;
    const ready = await tryReserveXSlot(db, 10, 2_000, now);
    expect(ready.ok).toBe(true);
    if (ready.ok) expect(ready.waitMs).toBeLessThanOrEqual(2_000);
  });
});
