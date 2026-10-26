import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTime } from "../admin/src/api";
import { createApp } from "../src/http/app";
import { recordEmailLog } from "../src/email/log";
import { STALE_ENQUEUE_MS } from "../src/pipeline/lease";
import { STUCK_BATCH_GRACE_MS } from "../src/pipeline/queue-batch";
import { finalizeOverdue, maybeEnqueueFinalize, requeueStuckBatches } from "../src/pipeline/run";
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

function setSetting(db: DatabaseSync, key: string, value: string) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

describe("日报只发一次", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("已发信的未完成运行不会被重新打开，也不会再发一封", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-15T03:00:00.000Z");
    const windowStart = "2026-10-14T02:00:00.000Z";
    const windowEnd = "2026-10-15T02:00:00.000Z";
    const deadline = "2026-10-15T02:30:00.000Z";
    const stale = new Date(now.getTime() - STALE_ENQUEUE_MS - 60_000).toISOString();
    setSetting(sqlite, "email_enabled", "1");
    setSetting(sqlite, "email_provider", "cloudflare");
    setSetting(sqlite, "email_from", "news@example.com");
    setSetting(sqlite, "app_base_url", "https://sky.example.com");
    sqlite.prepare(
      "INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)",
    ).run("rec-ops", "ops@example.com", now.toISOString());
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES (?, ?, 'schedule', 'partial', ?, ?, ?, ?)`,
    ).run("run-scheduled", "2026-10-15T10", windowStart, windowEnd, windowStart, deadline);
    sqlite.prepare(
      `INSERT INTO batches (
        id, run_id, country_id, source, batch_index, target_ids, status, created_at, enqueued_at
      ) VALUES (?, ?, '', 'x', 0, '[]', 'queued', ?, ?)`,
    ).run("batch-x", "run-scheduled", stale, stale);

    const mails: Array<{ subject: string; to: string[] }> = [];
    const queued: CollectMessage[] = [];
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: { async put() {} },
      EMAIL: {
        async send(message: { subject: string; to: string[] }) {
          mails.push({ subject: message.subject, to: message.to });
          return { messageId: `mail-${mails.length}` };
        },
      },
      COLLECT_QUEUE: {
        async send(body: CollectMessage) {
          queued.push(body);
        },
        async sendBatch(messages: Iterable<{ body: CollectMessage }>) {
          for (const message of messages) queued.push(message.body);
        },
      },
    } as unknown as Env;

    await finalizeOverdue(env, now);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toContain("部分批次未完成");
    expect(mails[0]?.to).toEqual(["ops@example.com"]);
    const afterFirst = sqlite.prepare(
      "SELECT status, email_status, email_sent_at, finalize_enqueued_at FROM runs WHERE id = ?",
    ).get("run-scheduled") as {
      status: string;
      email_status: string;
      email_sent_at: string | null;
      finalize_enqueued_at: string | null;
    };
    expect(afterFirst.status).toBe("incomplete");
    expect(afterFirst.email_status).toBe("sent");
    expect(afterFirst.email_sent_at).toBeTruthy();
    expect(afterFirst.finalize_enqueued_at).toBeTruthy();

    const batchAfterDeadline = sqlite.prepare("SELECT status, error FROM batches WHERE id = ?").get("batch-x") as {
      status: string;
      error: string;
    };
    expect(batchAfterDeadline).toEqual({ status: "cancelled", error: "已过截止时间" });

    await requeueStuckBatches(env, { now, minAgeMs: STUCK_BATCH_GRACE_MS });
    await requeueStuckBatches(env, { now, force: true, runId: "run-scheduled" });
    const reopened = sqlite.prepare("SELECT status, finished_at, email_status FROM runs WHERE id = ?").get("run-scheduled") as {
      status: string;
      finished_at: string | null;
      email_status: string;
    };
    expect(reopened.status).toBe("incomplete");
    expect(reopened.finished_at).toBeTruthy();
    expect(reopened.email_status).toBe("sent");
    const finalizeMessages = () => queued.filter((message) => message.type === "finalize");
    expect(finalizeMessages()).toHaveLength(0);
    await maybeEnqueueFinalize(env, "run-scheduled");
    expect(finalizeMessages()).toHaveLength(0);

    await finalizeOverdue(env, new Date(now.getTime() + 60 * 60 * 1000));
    expect(mails).toHaveLength(1);
    expect(sqlite.prepare("SELECT status FROM runs WHERE id = ?").get("run-scheduled")).toEqual({ status: "incomplete" });
    const logged = sqlite.prepare(
      "SELECT kind, status, message_id, attachment_mode, recipients FROM email_log",
    ).all() as Array<{ kind: string; status: string; message_id: string; attachment_mode: string; recipients: string }>;
    expect(logged).toEqual([{
      kind: "daily",
      status: "sent",
      message_id: "mail-1",
      attachment_mode: "none",
      recipients: "ops@example.com",
    }]);
  });

  it("发送失败可以再发一次，成功之后不再发", async () => {
    const sqlite = openDatabase();
    const now = new Date("2026-10-15T06:00:00.000Z");
    setSetting(sqlite, "email_enabled", "1");
    setSetting(sqlite, "email_provider", "cloudflare");
    setSetting(sqlite, "email_from", "news@example.com");
    sqlite.prepare(
      "INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)",
    ).run("rec-ops", "ops@example.com", now.toISOString());
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES (?, ?, 'manual', 'running', ?, ?, ?, ?)`,
    ).run(
      "run-manual",
      "manual-run-manual",
      "2026-10-14T05:53:00.000Z",
      "2026-10-15T05:53:00.000Z",
      "2026-10-14T05:53:00.000Z",
      "2026-10-14T06:53:00.000Z",
    );

    let fail = true;
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: { async put() {} },
      EMAIL: {
        async send() {
          if (fail) {
            fail = false;
            throw new Error("quota");
          }
          return { messageId: "mail-ok" };
        },
      },
      COLLECT_QUEUE: { async send() {}, async sendBatch() {} },
    } as unknown as Env;

    await finalizeOverdue(env, now);
    const failed = sqlite.prepare(
      "SELECT status, email_status, email_sent_at FROM runs WHERE id = ?",
    ).get("run-manual") as { status: string; email_status: string; email_sent_at: string | null };
    expect(failed).toEqual({ status: "incomplete", email_status: "failed", email_sent_at: null });

    await finalizeOverdue(env, new Date(now.getTime() + 60 * 60 * 1000));
    const sent = sqlite.prepare(
      "SELECT email_status, email_sent_at FROM runs WHERE id = ?",
    ).get("run-manual") as { email_status: string; email_sent_at: string | null };
    expect(sent.email_status).toBe("sent");
    expect(sent.email_sent_at).toBeTruthy();

    await finalizeOverdue(env, new Date(now.getTime() + 2 * 60 * 60 * 1000));
    const log = sqlite.prepare(
      "SELECT status, error, message_id FROM email_log ORDER BY created_at, id",
    ).all() as Array<{ status: string; error: string | null; message_id: string | null }>;
    expect(log.map((row) => row.status)).toEqual(["failed", "sent"]);
    expect(log[0]?.error).toBe("quota");
    expect(log[1]?.message_id).toBe("mail-ok");
  });

  it("还有未完成批次时不入队收尾，空闲后只入队一次", async () => {
    const sqlite = openDatabase();
    const now = "2026-10-15T02:00:00.000Z";
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES (?, ?, 'schedule', 'running', ?, ?, ?, ?)`,
    ).run("run-open", "slot-open", now, now, now, now);
    sqlite.prepare(
      `INSERT INTO batches (
        id, run_id, country_id, source, batch_index, target_ids, status, created_at
      ) VALUES (?, ?, '', 'gdelt', 0, '[]', 'queued', ?)`,
    ).run("batch-open", "run-open", now);
    const queued: CollectMessage[] = [];
    const env = {
      DB: asD1(sqlite),
      COLLECT_QUEUE: {
        async send(body: CollectMessage) {
          queued.push(body);
        },
        async sendBatch(messages: Iterable<{ body: CollectMessage }>) {
          for (const message of messages) queued.push(message.body);
        },
      },
    } as unknown as Env;

    await maybeEnqueueFinalize(env, "run-open");
    expect(queued).toHaveLength(0);

    sqlite.prepare("UPDATE batches SET status = 'done' WHERE id = ?").run("batch-open");
    await maybeEnqueueFinalize(env, "run-open");
    await maybeEnqueueFinalize(env, "run-open");
    expect(queued).toEqual([{ type: "finalize", runId: "run-open", reason: "complete" }]);

    sqlite.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run("run-open");
    await maybeEnqueueFinalize(env, "run-open");
    expect(queued).toHaveLength(1);
  });

  it("发信记录按页返回，时间可按配置时区显示", async () => {
    const sqlite = openDatabase();
    const db = asD1(sqlite);
    for (let index = 0; index < 25; index += 1) {
      await recordEmailLog(db, {
        runId: index === 24 ? "run-newest" : null,
        kind: index % 2 === 0 ? "daily" : "test",
        recipients: ["ops@example.com"],
        subject: `信 ${index}`,
        status: "sent",
        error: null,
        messageId: `id-${index}`,
        attachmentMode: "none",
        attachmentBytes: 0,
        createdAt: new Date(Date.parse("2026-10-15T03:00:00.000Z") + index * 1000).toISOString(),
      });
    }
    const env = {
      ENVIRONMENT: "development",
      DB: db,
    } as unknown as Env;
    const ctx = {
      access: { async getIdentity() { return { email: "dev@example.com" }; } },
    } as unknown as ExecutionContext;
    const response = await createApp().request("/api/email-log?page=2&pageSize=20", { method: "GET" }, env, ctx);
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      total: number;
      page: number;
      pageSize: number;
      timeZone: string;
      entries: Array<{ subject: string; created_at: string }>;
    };
    expect(payload.total).toBe(25);
    expect(payload.page).toBe(2);
    expect(payload.pageSize).toBe(20);
    expect(payload.timeZone).toBe("Asia/Shanghai");
    expect(payload.entries).toHaveLength(5);
    expect(payload.entries[0]?.subject).toBe("信 4");
    expect(formatTime("2026-10-15T03:00:00.000Z", payload.timeZone)).toBe("2026-10-15 11:00");
    expect(formatTime(payload.entries[4]?.created_at, payload.timeZone)).toBe("2026-10-15 11:00");
  });
});
