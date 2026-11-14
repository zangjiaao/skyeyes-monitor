import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";
import { emailBuckets } from "../src/email/delivery";
import { readWorkbookSheets } from "../src/export/excel";
import { runWindowObjectKey } from "../src/export/run-file";
import { finalizeRun } from "../src/pipeline/run";
import { asD1, openDatabase } from "./helpers/d1";

describe("分组推送", () => {
  it("按收件人合并分组，没有收件人的分组不进入任何一封", () => {
    expect(emailBuckets([
      { id: "a", name: "分组甲", emails: ["e@example.com", "d@example.com"] },
      { id: "b", name: "分组乙", emails: ["d@example.com", "e@example.com"] },
      { id: "c", name: "分组丙", emails: [] },
      { id: "d", name: "分组丁", emails: ["f@example.com"] },
    ])).toEqual([
      {
        emails: ["d@example.com", "e@example.com"],
        groupIds: ["a", "b"],
        names: ["分组甲", "分组乙"],
      },
      {
        emails: ["f@example.com"],
        groupIds: ["d"],
        names: ["分组丁"],
      },
    ]);
  });

  it("可以给分组配置邮件或不发送", async () => {
    const sqlite = openDatabase();
    const env = { ENVIRONMENT: "development", DB: asD1(sqlite) } as unknown as Env;
    const ctx = {
      access: { async getIdentity() { return { email: "dev@example.com" }; } },
    } as unknown as ExecutionContext;
    const app = createApp();
    sqlite.prepare(
      "INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)",
    ).run("rec-d", "d@example.com", "2026-10-01T00:00:00.000Z");

    const created = await app.request("/api/countries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "分组丙", code: "group-c", delivery: "none", recipientIds: ["rec-d"] }),
    }, env, ctx);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };

    const listed = await app.request("/api/countries", { method: "GET" }, env, ctx);
    const payload = await listed.json() as {
      countries: Array<{ id: string; delivery: string; recipient_ids: string[] }>;
    };
    const group = payload.countries.find((country) => country.id === id);
    expect(group).toMatchObject({ delivery: "none", recipient_ids: ["rec-d"] });

    const patched = await app.request(`/api/countries/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "email", recipientIds: ["rec-d"] }),
    }, env, ctx);
    expect(patched.status).toBe(200);

    const rejected = await app.request(`/api/countries/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "agent" }),
    }, env, ctx);
    expect(rejected.status).toBe(400);

    const removed = await app.request("/api/recipients/rec-d", { method: "DELETE" }, env, ctx);
    const existing = await app.request("/api/countries/country_demo_alpha", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "none", recipientIds: [] }),
    }, env, ctx);
    expect(existing.status).toBe(200);
    const after = await app.request("/api/countries", { method: "GET" }, env, ctx);
    const updated = await after.json() as {
      countries: Array<{ id: string; delivery: string; recipient_ids: string[] }>;
    };
    expect(updated.countries.find((country) => country.id === "country_demo_alpha")).toMatchObject({
      delivery: "none",
      recipient_ids: [],
    });

    expect(removed.status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM country_recipients WHERE recipient_id = ?").get("rec-d")).toEqual({ n: 0 });
  });

  it("邮件只包含配置了的分组，不发送的分组仍留在运行文件里", async () => {
    const sqlite = openDatabase();
    const now = "2026-10-15T03:00:00.000Z";
    const windowStart = "2026-10-14T02:00:00.000Z";
    const windowEnd = "2026-10-15T02:00:00.000Z";
    for (const [key, value] of [
      ["email_enabled", "1"],
      ["email_provider", "cloudflare"],
      ["email_from", "news@example.com"],
      ["app_base_url", "https://sky.example.com"],
    ]) {
      sqlite.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    }
    for (const [id, email] of [
      ["rec-d", "d@example.com"],
      ["rec-e", "e@example.com"],
      ["rec-f", "f@example.com"],
    ]) {
      sqlite.prepare("INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)").run(id, email, now);
    }
    for (const [id, name, code, delivery] of [
      ["group-a", "分组甲", "group-a", "email"],
      ["group-b", "分组乙", "group-b", "email"],
      ["group-c", "分组丙", "group-c", "none"],
    ] as const) {
      sqlite.prepare(
        "INSERT INTO countries (id, name, code, enabled, delivery, created_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).run(id, name, code, delivery, now);
    }
    for (const countryId of ["group-a", "group-b"]) {
      for (const recipientId of ["rec-d", "rec-e", "rec-f"]) {
        sqlite.prepare("INSERT INTO country_recipients (country_id, recipient_id) VALUES (?, ?)").run(countryId, recipientId);
      }
    }
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES (?, ?, 'schedule', 'running', ?, ?, ?, ?)`,
    ).run("run-groups", "slot-groups", windowStart, windowEnd, windowStart, windowEnd);
    const insertBatch = sqlite.prepare(
      `INSERT INTO batches (
        id, run_id, country_id, source, batch_index, target_ids, status, created_at
      ) VALUES (?, 'run-groups', ?, 'x', 0, '[]', 'done', ?)`,
    );
    const insertRecord = sqlite.prepare(
      `INSERT INTO records (
        id, dedupe_key, source, url, country_id, country_name, matched_target, original_text,
        published_at, collected_at, run_id, time_status, is_spam, exclude_reason
      ) VALUES (?, ?, 'x', ?, ?, ?, '目标', ?, ?, ?, 'run-groups', 'in_window', 0, '')`,
    );
    for (const [id, name, text] of [
      ["group-a", "分组甲", "甲的报道"],
      ["group-b", "分组乙", "乙的报道"],
      ["group-c", "分组丙", "丙的报道"],
    ] as const) {
      insertBatch.run(`batch-${id}`, id, now);
      insertRecord.run(
        `record-${id}`, `dedupe-${id}`, `https://example.com/${id}`, id, name, text,
        "2026-10-14T08:00:00.000Z", now,
      );
    }

    const files = new Map<string, Uint8Array>();
    const mails: Array<{ to: string[]; text: string; attachment: Uint8Array | null }> = [];
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: {
        async put(key: string, value: Uint8Array) {
          files.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
        },
      },
      EMAIL: {
        async send(message: { to: string[]; text: string; attachments?: Array<{ content: Uint8Array }> }) {
          mails.push({ to: message.to, text: message.text, attachment: message.attachments?.[0]?.content ?? null });
          return { messageId: `mail-${mails.length}` };
        },
      },
    } as unknown as Env;

    await finalizeRun(env, "run-groups", "complete");

    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toEqual(["d@example.com", "e@example.com", "f@example.com"]);
    expect(mails[0]?.text).toContain("分组甲");
    expect(mails[0]?.text).toContain("分组乙");
    expect(mails[0]?.text).not.toContain("分组丙");
    const sheets = readWorkbookSheets(mails[0]?.attachment ?? new Uint8Array());
    expect(Object.keys(sheets).sort((left, right) => left.localeCompare(right, "zh"))).toEqual(
      ["分组甲", "分组乙"].sort((left, right) => left.localeCompare(right, "zh")),
    );
    expect(sheets["分组甲"]?.some((row) => row.includes("甲的报道"))).toBe(true);
    expect(sheets["分组乙"]?.some((row) => row.includes("乙的报道"))).toBe(true);
    const archive = readWorkbookSheets(files.get(runWindowObjectKey("run-groups")) ?? new Uint8Array());
    expect(archive["分组丙"]?.some((row) => row.includes("丙的报道"))).toBe(true);
    expect(sqlite.prepare("SELECT email_status FROM runs WHERE id = ?").get("run-groups")).toEqual({ email_status: "sent" });
  });

  it("不同收件人分开寄出，失败的一封可以单独重试", async () => {
    const sqlite = openDatabase();
    const now = "2026-10-15T03:00:00.000Z";
    const windowStart = "2026-10-14T02:00:00.000Z";
    const windowEnd = "2026-10-15T02:00:00.000Z";
    for (const [key, value] of [
      ["email_enabled", "1"],
      ["email_provider", "cloudflare"],
      ["email_from", "news@example.com"],
    ]) {
      sqlite.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    }
    for (const [id, email] of [["rec-d", "d@example.com"], ["rec-f", "f@example.com"]]) {
      sqlite.prepare("INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)").run(id, email, now);
    }
    sqlite.prepare(
      "INSERT INTO countries (id, name, code, enabled, delivery, created_at) VALUES ('group-a', '分组甲', 'group-a', 1, 'email', ?)",
    ).run(now);
    sqlite.prepare(
      "INSERT INTO countries (id, name, code, enabled, delivery, created_at) VALUES ('group-b', '分组乙', 'group-b', 1, 'email', ?)",
    ).run(now);
    sqlite.prepare("INSERT INTO country_recipients (country_id, recipient_id) VALUES ('group-a', 'rec-d')").run();
    sqlite.prepare("INSERT INTO country_recipients (country_id, recipient_id) VALUES ('group-b', 'rec-f')").run();
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at
      ) VALUES ('run-split', 'slot-split', 'schedule', 'running', ?, ?, ?, ?)`,
    ).run(windowStart, windowEnd, windowStart, windowEnd);
    sqlite.prepare(
      `INSERT INTO batches (id, run_id, country_id, source, batch_index, target_ids, status, created_at)
       VALUES ('batch-a', 'run-split', 'group-a', 'x', 0, '[]', 'done', ?)`,
    ).run(now);
    sqlite.prepare(
      `INSERT INTO batches (id, run_id, country_id, source, batch_index, target_ids, status, created_at)
       VALUES ('batch-b', 'run-split', 'group-b', 'x', 1, '[]', 'done', ?)`,
    ).run(now);

    let failF = true;
    const mails: string[][] = [];
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: { async put() {} },
      EMAIL: {
        async send(message: { to: string[] }) {
          if (failF && message.to.includes("f@example.com")) {
            failF = false;
            throw new Error("quota");
          }
          mails.push(message.to);
          return { messageId: `mail-${mails.length}` };
        },
      },
    } as unknown as Env;

    await finalizeRun(env, "run-split", "complete");
    expect(mails).toEqual([["d@example.com"]]);
    expect(sqlite.prepare("SELECT status, email_status, email_sent_at FROM runs WHERE id = 'run-split'").get()).toEqual({
      status: "incomplete",
      email_status: "failed",
      email_sent_at: null,
    });

    sqlite.prepare("UPDATE runs SET status = 'incomplete' WHERE id = 'run-split'").run();
    await finalizeRun(env, "run-split", "complete");
    expect(mails).toEqual([["d@example.com"], ["f@example.com"]]);
    expect(sqlite.prepare("SELECT email_status FROM runs WHERE id = 'run-split'").get()).toEqual({ email_status: "sent" });
  });

  it("来源批次没有分组 id 时，仍按任务范围发信", async () => {
    const sqlite = openDatabase();
    const now = "2026-10-15T03:00:00.000Z";
    const windowStart = "2026-10-14T02:00:00.000Z";
    const windowEnd = "2026-10-15T02:00:00.000Z";
    for (const [key, value] of [
      ["email_enabled", "1"],
      ["email_provider", "cloudflare"],
      ["email_from", "news@example.com"],
    ]) {
      sqlite.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(key, value);
    }
    for (const [id, email] of [
      ["rec-d", "d@example.com"],
      ["rec-e", "e@example.com"],
      ["rec-f", "f@example.com"],
    ]) {
      sqlite.prepare("INSERT INTO recipients (id, email, enabled, created_at) VALUES (?, ?, 1, ?)").run(id, email, now);
    }
    for (const [id, name, code, delivery] of [
      ["group-a", "分组甲", "group-a", "email"],
      ["group-b", "分组乙", "group-b", "email"],
      ["group-c", "分组丙", "group-c", "none"],
    ] as const) {
      sqlite.prepare(
        "INSERT INTO countries (id, name, code, enabled, delivery, created_at) VALUES (?, ?, ?, 1, ?, ?)",
      ).run(id, name, code, delivery, now);
    }
    for (const countryId of ["group-a", "group-b"]) {
      for (const recipientId of ["rec-d", "rec-e", "rec-f"]) {
        sqlite.prepare("INSERT INTO country_recipients (country_id, recipient_id) VALUES (?, ?)").run(countryId, recipientId);
      }
    }
    sqlite.prepare(
      `INSERT INTO runs (
        id, slot_key, trigger, status, window_start, window_end, started_at, deadline_at, scope_json
      ) VALUES ('run-source', 'slot-source', 'schedule', 'running', ?, ?, ?, ?, ?)`,
    ).run(windowStart, windowEnd, windowStart, windowEnd, JSON.stringify({
      mode: "all",
      countries: [
        { id: "group-a", name: "分组甲" },
        { id: "group-b", name: "分组乙" },
        { id: "group-c", name: "分组丙" },
      ],
      targetCount: 3,
    }));
    sqlite.prepare(
      `INSERT INTO batches (id, run_id, country_id, source, batch_index, target_ids, status, created_at)
       VALUES ('batch-x', 'run-source', '', 'x', 0, '[]', 'done', ?)`,
    ).run(now);
    sqlite.prepare(
      `INSERT INTO batches (id, run_id, country_id, source, batch_index, target_ids, status, created_at)
       VALUES ('batch-news', 'run-source', '', 'google_news', 1, '[]', 'done', ?)`,
    ).run(now);
    const insertRecord = sqlite.prepare(
      `INSERT INTO records (
        id, dedupe_key, source, url, country_id, country_name, matched_target, original_text,
        published_at, collected_at, run_id, time_status, is_spam, exclude_reason
      ) VALUES (?, ?, 'x', ?, ?, ?, '目标', ?, ?, ?, 'run-source', 'in_window', 0, '')`,
    );
    for (const [id, name, text] of [
      ["group-a", "分组甲", "甲的报道"],
      ["group-b", "分组乙", "乙的报道"],
      ["group-c", "分组丙", "丙的报道"],
    ] as const) {
      insertRecord.run(
        `record-${id}`, `dedupe-${id}`, `https://example.com/${id}`, id, name, text,
        "2026-10-14T08:00:00.000Z", now,
      );
    }
    const mails: Array<{ to: string[]; text: string }> = [];
    const env = {
      ENVIRONMENT: "development",
      EXCEL_FILENAME: "skyeyes.xlsx",
      DB: asD1(sqlite),
      EXPORTS: { async put() {} },
      EMAIL: {
        async send(message: { to: string[]; text: string }) {
          mails.push({ to: message.to, text: message.text });
          return { messageId: `mail-${mails.length}` };
        },
      },
    } as unknown as Env;

    await finalizeRun(env, "run-source", "complete");

    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toEqual(["d@example.com", "e@example.com", "f@example.com"]);
    expect(mails[0]?.text).toContain("分组甲");
    expect(mails[0]?.text).toContain("分组乙");
    expect(mails[0]?.text).not.toContain("分组丙");
    expect(sqlite.prepare("SELECT email_status FROM runs WHERE id = 'run-source'").get()).toEqual({ email_status: "sent" });
  });
});
