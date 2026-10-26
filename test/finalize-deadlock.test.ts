import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FINALIZING_GRACE_MS } from "../src/pipeline/lease";
import { STUCK_BATCH_GRACE_MS } from "../src/pipeline/queue-batch";
import {
  ActiveRunError,
  cancelRun,
  finalizeOverdue,
  processBatch,
  requeueStuckBatches,
  scheduleDeferredWake,
  startRun,
} from "../src/pipeline/run";
import { handleScheduled } from "../src/schedule";
import type { CollectMessage } from "../src/pipeline/messages";

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

function envFor(db: DatabaseSync, sent: CollectMessage[] = []): Env {
  return {
    ENVIRONMENT: "development",
    EXCEL_FILENAME: "skyeyes.xlsx",
    DB: asD1(db),
    EXPORTS: {
      async put() {
        throw new Error("不应在清扫或收割时生成 Excel");
      },
    },
    EMAIL: {
      async send() {
        throw new Error("不应重发日报");
      },
    },
    COLLECT_QUEUE: {
      async send(body: CollectMessage) {
        sent.push(body);
      },
      async sendBatch(messages: Iterable<{ body: CollectMessage }>) {
        for (const message of messages) sent.push(message.body);
      },
    },
  } as unknown as Env;
}

function insertRun(db: DatabaseSync, row: {
  id: string;
  slotKey: string;
  status: string;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string | null;
  notes?: string | null;
  emailStatus?: string | null;
  emailSentAt?: string | null;
  finalizeEnqueuedAt?: string | null;
}) {
  db.prepare(
    `INSERT INTO runs (
      id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at,
      finished_at, notes, email_status, email_sent_at, finalize_enqueued_at
    ) VALUES (?, ?, 'schedule', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.slotKey,
    row.status,
    "2026-10-21T02:00:00.000Z",
    "2026-10-22T02:00:00.000Z",
    row.startedAt,
    row.deadlineAt,
    row.finishedAt ?? null,
    row.notes ?? null,
    row.emailStatus ?? null,
    row.emailSentAt ?? null,
    row.finalizeEnqueuedAt ?? null,
  );
}

function insertBatch(db: DatabaseSync, row: {
  id: string;
  runId: string;
  source: string;
  status: string;
  createdAt: string;
  enqueuedAt?: string | null;
  leaseExpiresAt?: string | null;
  resumeJson?: string | null;
}) {
  db.prepare(
    `INSERT INTO batches (
      id, run_id, country_id, source, batch_index, target_ids, status, created_at,
      enqueued_at, lease_token, lease_expires_at, resume_json
    ) VALUES (?, ?, '', ?, 0, '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.runId,
    row.source,
    row.status,
    row.createdAt,
    row.enqueuedAt ?? null,
    row.leaseExpiresAt ? "lease" : null,
    row.leaseExpiresAt ?? null,
    row.resumeJson ?? null,
  );
}

describe("收尾死锁", () => {
  it("已发信的 incomplete 不会被自动或强制收割重新打开", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-22T06:00:00.000Z");
    const stale = "2026-10-22T03:00:00.000Z";
    insertRun(sqlite, {
      id: "run-mailed",
      slotKey: "2026-10-22T10",
      status: "incomplete",
      startedAt: "2026-10-22T02:00:15.000Z",
      deadlineAt: "2026-10-22T03:00:15.000Z",
      finishedAt: "2026-10-22T03:01:25.000Z",
      notes: "有批次未完成，已发送目前收集到的内容。",
      emailStatus: "sent",
      emailSentAt: "2026-10-22T03:01:25.000Z",
      finalizeEnqueuedAt: "2026-10-22T03:00:15.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-x",
      runId: "run-mailed",
      source: "x",
      status: "running",
      createdAt: stale,
      leaseExpiresAt: "2026-10-22T05:45:01.000Z",
      resumeJson: JSON.stringify({ source: "x", step: 161, page: 0, cursor: "" }),
    });
    insertBatch(sqlite, {
      id: "batch-queued",
      runId: "run-mailed",
      source: "gdelt",
      status: "queued",
      createdAt: stale,
      enqueuedAt: null,
    });
    const sent: CollectMessage[] = [];
    const env = envFor(sqlite, sent);

    await requeueStuckBatches(env, { now, minAgeMs: STUCK_BATCH_GRACE_MS });
    await requeueStuckBatches(env, { now, force: true });
    await requeueStuckBatches(env, { now, force: true, runId: "run-mailed" });
    await finalizeOverdue(env, now);

    const run = sqlite.prepare(
      "SELECT status, finished_at, email_status, email_sent_at FROM runs WHERE id = ?",
    ).get("run-mailed") as {
      status: string;
      finished_at: string;
      email_status: string;
      email_sent_at: string;
    };
    expect(run).toEqual({
      status: "incomplete",
      finished_at: "2026-10-22T03:01:25.000Z",
      email_status: "sent",
      email_sent_at: "2026-10-22T03:01:25.000Z",
    });
    expect(sqlite.prepare("SELECT status FROM batches WHERE id = ?").get("batch-x")).toEqual({ status: "running" });
    expect(sqlite.prepare("SELECT status, enqueued_at FROM batches WHERE id = ?").get("batch-queued")).toEqual({
      status: "queued",
      enqueued_at: null,
    });
    expect(sent).toHaveLength(0);
  });

  it("入队失败的运行仍会被收割重新打开", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-22T06:00:00.000Z");
    insertRun(sqlite, {
      id: "run-failed",
      slotKey: "2026-10-22T11",
      status: "failed",
      startedAt: "2026-10-22T05:00:00.000Z",
      deadlineAt: "2026-10-22T07:00:00.000Z",
      finishedAt: "2026-10-22T05:10:00.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-lost",
      runId: "run-failed",
      source: "x",
      status: "queued",
      createdAt: "2026-10-22T05:00:00.000Z",
      enqueuedAt: null,
    });
    const sent: CollectMessage[] = [];
    await requeueStuckBatches(envFor(sqlite, sent), { now, minAgeMs: STUCK_BATCH_GRACE_MS });
    expect(sqlite.prepare("SELECT status, finished_at FROM runs WHERE id = ?").get("run-failed")).toEqual({
      status: "running",
      finished_at: null,
    });
    expect(sent.map((message) => message.type === "batch" ? message.batchId : message.type)).toContain("batch-lost");
  });

  it("超过宽限的 finalizing 被清扫为终态，且不重发已成功的日报", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-26T02:00:00.000Z");
    const note = "有批次未完成，已发送目前收集到的内容。";
    insertRun(sqlite, {
      id: "run-stuck",
      slotKey: "2026-10-22T10",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:15.000Z",
      deadlineAt: "2026-10-22T03:00:15.000Z",
      notes: note,
      emailStatus: "sent",
      emailSentAt: "2026-10-22T03:01:25.000Z",
      finalizeEnqueuedAt: "2026-10-22T05:00:00.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-x",
      runId: "run-stuck",
      source: "x",
      status: "running",
      createdAt: "2026-10-22T02:00:15.000Z",
      leaseExpiresAt: "2026-10-22T05:45:01.000Z",
      resumeJson: JSON.stringify({ source: "x", step: 161, page: 0, cursor: "" }),
    });
    insertBatch(sqlite, {
      id: "batch-news",
      runId: "run-stuck",
      source: "google_news",
      status: "done",
      createdAt: "2026-10-22T02:00:15.000Z",
    });
    const env = envFor(sqlite);
    await finalizeOverdue(env, now);
    const run = sqlite.prepare(
      "SELECT status, finished_at, email_status, email_sent_at, notes FROM runs WHERE id = ?",
    ).get("run-stuck") as {
      status: string;
      finished_at: string;
      email_status: string;
      email_sent_at: string;
      notes: string;
    };
    expect(run.status).toBe("incomplete");
    expect(run.finished_at).toBe(now.toISOString());
    expect(run.email_status).toBe("sent");
    expect(run.email_sent_at).toBe("2026-10-22T03:01:25.000Z");
    expect(run.notes).toContain(note);
    expect(run.notes).toContain("收尾超时");
    expect(sqlite.prepare("SELECT status, error, lease_token FROM batches WHERE id = ?").get("batch-x")).toEqual({
      status: "cancelled",
      error: "已过截止时间",
      lease_token: null,
    });
    expect(sqlite.prepare("SELECT status FROM batches WHERE id = ?").get("batch-news")).toEqual({ status: "done" });

    await finalizeOverdue(env, new Date(now.getTime() + 60 * 60 * 1000));
    expect(sqlite.prepare("SELECT status, email_status FROM runs WHERE id = ?").get("run-stuck")).toEqual({
      status: "incomplete",
      email_status: "sent",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM email_log").get()).toEqual({ n: 0 });
  });

  it("批次已全部结束且邮件已发出的 finalizing 被清扫为 completed", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-22T08:00:00.000Z");
    insertRun(sqlite, {
      id: "run-done",
      slotKey: "2026-10-22T12",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:00.000Z",
      deadlineAt: "2026-10-22T06:00:00.000Z",
      emailStatus: "sent",
      emailSentAt: "2026-10-22T04:00:00.000Z",
      finalizeEnqueuedAt: "2026-10-22T04:00:00.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-done",
      runId: "run-done",
      source: "x",
      status: "done",
      createdAt: "2026-10-22T02:00:00.000Z",
    });
    await finalizeOverdue(envFor(sqlite), now);
    expect(sqlite.prepare("SELECT status, email_status FROM runs WHERE id = ?").get("run-done")).toEqual({
      status: "completed",
      email_status: "sent",
    });
  });

  it("宽限期内的 finalizing 保持原状，并继续挡住新运行", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-22T03:10:00.000Z");
    const claimedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    insertRun(sqlite, {
      id: "run-live",
      slotKey: "2026-10-22T13",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:00.000Z",
      deadlineAt: claimedAt,
      finalizeEnqueuedAt: claimedAt,
      emailStatus: "sent",
      emailSentAt: claimedAt,
    });
    insertBatch(sqlite, {
      id: "batch-live",
      runId: "run-live",
      source: "x",
      status: "running",
      createdAt: "2026-10-22T02:00:00.000Z",
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    expect(FINALIZING_GRACE_MS).toBeGreaterThan(5 * 60 * 1000);
    const env = envFor(sqlite);
    await finalizeOverdue(env, now);
    expect(sqlite.prepare("SELECT status, finished_at FROM runs WHERE id = ?").get("run-live")).toEqual({
      status: "finalizing",
      finished_at: null,
    });
    expect(sqlite.prepare("SELECT status FROM batches WHERE id = ?").get("batch-live")).toEqual({ status: "running" });
    await expect(startRun(env, {
      trigger: "manual",
      now,
      slotKey: "",
      windowStart: new Date(now.getTime() - 60 * 60 * 1000),
      windowEnd: now,
    })).rejects.toBeInstanceOf(ActiveRunError);
  });

  it("可以取消卡住的 finalizing，之后能够开始新运行", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-26T02:00:00.000Z");
    insertRun(sqlite, {
      id: "run-stuck",
      slotKey: "2026-10-22T10",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:15.000Z",
      deadlineAt: "2026-10-22T03:00:15.000Z",
      notes: "有批次未完成，已发送目前收集到的内容。",
      emailStatus: "sent",
      emailSentAt: "2026-10-22T03:01:25.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-x",
      runId: "run-stuck",
      source: "x",
      status: "running",
      createdAt: "2026-10-22T02:00:15.000Z",
      leaseExpiresAt: "2026-10-22T05:45:01.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-queued",
      runId: "run-stuck",
      source: "google_news",
      status: "queued",
      createdAt: "2026-10-22T02:00:15.000Z",
    });
    const env = envFor(sqlite);
    const cancelled = await cancelRun(env, "run-stuck");
    expect(cancelled.cancelledBatches).toBe(2);
    expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get("run-stuck")).toEqual({ status: "cancelled" });
    expect(sqlite.prepare("SELECT status FROM batches WHERE id = 'batch-x'").get()).toEqual({ status: "cancelled" });
    const started = await startRun(env, {
      trigger: "manual",
      now,
      slotKey: "",
      windowStart: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      windowEnd: now,
    });
    expect(started.created).toBe(true);
    expect(started.runId).not.toBe("run-stuck");
    expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(started.runId)).toEqual({ status: "running" });
  });

  it("清扫卡住的 finalizing 后，到点的定时任务可以开始", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-26T02:00:00.000Z");
    insertRun(sqlite, {
      id: "run-stuck",
      slotKey: "2026-10-22T10",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:15.000Z",
      deadlineAt: "2026-10-22T03:00:15.000Z",
      notes: "有批次未完成，已发送目前收集到的内容。",
      emailStatus: "sent",
      emailSentAt: "2026-10-22T03:01:25.000Z",
      finalizeEnqueuedAt: "2026-10-22T05:00:00.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-x",
      runId: "run-stuck",
      source: "x",
      status: "running",
      createdAt: "2026-10-22T02:00:15.000Z",
      leaseExpiresAt: "2026-10-22T05:45:01.000Z",
    });
    const sent: CollectMessage[] = [];
    await handleScheduled(envFor(sqlite, sent), now.getTime());
    const stuck = sqlite.prepare("SELECT status, finished_at, email_status FROM runs WHERE id = ?").get("run-stuck") as {
      status: string;
      finished_at: string | null;
      email_status: string;
    };
    expect(stuck.status).toBe("incomplete");
    expect(stuck.finished_at).toBeTruthy();
    expect(stuck.email_status).toBe("sent");
    const runs = sqlite.prepare("SELECT id, status, slot_key FROM runs ORDER BY started_at").all() as Array<{
      id: string;
      status: string;
      slot_key: string;
    }>;
    expect(runs.map((run) => run.status)).toEqual(["incomplete", "running"]);
    expect(runs[1]?.slot_key).toBe("2026-10-26T10");
    expect(sqlite.prepare("SELECT status FROM batches WHERE id = ?").get("batch-x")).toEqual({ status: "cancelled" });
    expect(sent.some((message) => message.type === "batch" && message.runId === runs[1]?.id)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM email_log").get()).toEqual({ n: 0 });
  });

  it("processBatch 在收尾和终态上取消未完成批次，不再继续采集", async () => {
    const sqlite = openDatabase();
    const statuses = ["finalizing", "incomplete", "completed", "cancelled"] as const;
    for (const status of statuses) {
      insertRun(sqlite, {
        id: `run-${status}`,
        slotKey: `slot-${status}`,
        status,
        startedAt: "2026-10-22T02:00:00.000Z",
        deadlineAt: "2026-10-22T03:00:00.000Z",
        finishedAt: status === "finalizing" ? null : "2026-10-22T03:00:00.000Z",
      });
      insertBatch(sqlite, {
        id: `batch-${status}`,
        runId: `run-${status}`,
        source: "x",
        status: "running",
        createdAt: "2026-10-22T02:00:00.000Z",
        leaseExpiresAt: "2026-10-22T02:20:00.000Z",
        resumeJson: JSON.stringify({ source: "x", step: 161, page: 0, cursor: "" }),
      });
    }
    const env = envFor(sqlite);
    for (const status of statuses) {
      await processBatch(env, `run-${status}`, `batch-${status}`);
      const batch = sqlite.prepare(
        "SELECT status, error, attempts, lease_token FROM batches WHERE id = ?",
      ).get(`batch-${status}`) as { status: string; error: string; attempts: number; lease_token: string | null };
      expect(batch.status).toBe("cancelled");
      expect(batch.error).toBe(status === "cancelled" ? "已取消" : "运行已结束");
      expect(batch.attempts).toBe(0);
      expect(batch.lease_token).toBeNull();
    }
  });

  it("收尾中的运行不会再登记延迟唤醒", async () => {
    const sqlite = openDatabase();
    insertRun(sqlite, {
      id: "run-finalizing",
      slotKey: "slot-defer",
      status: "finalizing",
      startedAt: "2026-10-22T02:00:00.000Z",
      deadlineAt: "2026-10-22T03:00:00.000Z",
    });
    insertBatch(sqlite, {
      id: "batch-defer",
      runId: "run-finalizing",
      source: "x",
      status: "running",
      createdAt: "2026-10-22T02:00:00.000Z",
      leaseExpiresAt: "2026-10-22T02:20:00.000Z",
    });
    const sent: CollectMessage[] = [];
    await scheduleDeferredWake(envFor(sqlite, sent), "run-finalizing", "batch-defer", null, 30);
    expect(sent).toHaveLength(0);
    expect(sqlite.prepare("SELECT status, next_wake_at FROM batches WHERE id = ?").get("batch-defer")).toEqual({
      status: "cancelled",
      next_wake_at: null,
    });
  });
});
