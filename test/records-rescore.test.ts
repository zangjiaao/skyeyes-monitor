import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";

interface StoredRecord {
  id: string;
  original_text: string;
  matched_target: string;
  relevance_score: number | null;
  relevance_error: string | null;
  deleted_at: string | null;
  collected_at: string;
}

function row(id: string, extra: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    original_text: `${id} 的正文`,
    matched_target: "示例目标",
    relevance_score: null,
    relevance_error: null,
    deleted_at: null,
    collected_at: `2026-10-12T07:00:0${id.length}.000Z`,
    ...extra,
  };
}

function createHarness(initial: StoredRecord[], reply: (text: string) => unknown) {
  const rows = initial.map((item) => ({ ...item }));
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      const execute = (binds: unknown[]) => {
        if (sql.includes("FROM settings")) return { results: [], first: null, changes: 0 };
        if (sql.includes("UPDATE records SET relevance_score")) {
          const id = String(binds[1]);
          const found = rows.find((item) => item.id === id);
          if (found) {
            found.relevance_score = Number(binds[0]);
            found.relevance_error = null;
          }
          return { changes: found ? 1 : 0 };
        }
        if (sql.includes("UPDATE records SET relevance_error")) {
          const id = String(binds[1]);
          const found = rows.find((item) => item.id === id && item.relevance_score == null);
          if (found) found.relevance_error = String(binds[0]);
          return { changes: found ? 1 : 0 };
        }
        if (sql.includes("COUNT(*)")) {
          const n = rows.filter((item) => (
            item.deleted_at == null && item.relevance_score == null && item.relevance_error == null
          )).length;
          return { results: [{ n }], first: { n }, changes: 0 };
        }
        if (sql.includes("FROM records")) {
          let matched = rows.filter((item) => item.deleted_at == null);
          if (sql.includes("id IN")) {
            const ids = binds.map(String);
            matched = matched.filter((item) => ids.includes(item.id));
          }
          if (sql.includes("relevance_score IS NULL AND relevance_error IS NULL")) {
            matched = matched.filter((item) => item.relevance_score == null && item.relevance_error == null);
          }
          if (sql.includes("ORDER BY collected_at DESC")) {
            matched = [...matched].sort((left, right) => right.collected_at.localeCompare(left.collected_at));
          }
          if (sql.includes("LIMIT")) {
            matched = matched.slice(0, Number(binds[binds.length - 1]));
          }
          return { results: matched, first: matched[0] ?? null, changes: 0 };
        }
        throw new Error(`未预期的 SQL：${sql}`);
      };
      const statement = (binds: unknown[]) => ({
        all: async () => ({ results: execute(binds).results ?? [] }),
        first: async <T,>() => (execute(binds).first ?? null) as T | null,
        run: async () => ({ meta: { changes: execute(binds).changes ?? 0 } }),
      });
      return {
        bind: (...binds: unknown[]) => statement(binds),
        ...statement([]),
      };
    },
  };
  const env = {
    ENVIRONMENT: "development",
    DB: db,
    AI: {
      async run(_model: string, input: { messages: Array<{ content: string }> }) {
        const text = input.messages.map((message) => message.content).join("\n");
        calls.push(text);
        const next = reply(text);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  } as unknown as Env;
  const ctx = {
    access: { async getIdentity() { return { email: "dev@example.com" }; } },
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return { app: createApp(), env, ctx, rows, calls };
}

async function post(harness: ReturnType<typeof createHarness>, body: unknown) {
  const response = await harness.app.request("/api/records/rescore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, harness.env, harness.ctx);
  const payload = await response.json() as {
    error?: string;
    scored?: number;
    failed?: number;
    attempted?: number;
    remaining?: number;
  };
  return { status: response.status, payload };
}

describe("补评已有记录", () => {
  it("未评分模式只给还没打过分的记录写分数", async () => {
    const harness = createHarness([
      row("new"),
      row("done", { relevance_score: 90, collected_at: "2026-10-12T09:00:00.000Z" }),
      row("hidden", { deleted_at: "2026-10-01T00:00:00.000Z" }),
    ], () => ({ response: "85分" }));
    const result = await post(harness, { mode: "unscored" });
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ scored: 1, failed: 0, attempted: 1, remaining: 0 });
    expect(harness.rows.find((item) => item.id === "new")?.relevance_score).toBe(85);
    expect(harness.rows.find((item) => item.id === "done")?.relevance_score).toBe(90);
    expect(harness.calls).toHaveLength(1);
  });

  it("调用失败时记下原因，并且下一次未评分不会再试这条", async () => {
    const harness = createHarness([
      row("bad"),
    ], () => {
      throw new Error("Workers AI 远程调用失败");
    });
    const first = await post(harness, { mode: "unscored" });
    expect(first.payload).toMatchObject({ scored: 0, failed: 1, attempted: 1, remaining: 0 });
    const stored = harness.rows[0];
    expect(stored?.relevance_score).toBeNull();
    expect(stored?.relevance_error).toBe("Workers AI 远程调用失败");
    const second = await post(harness, { mode: "unscored" });
    expect(second.payload).toMatchObject({ scored: 0, failed: 0, attempted: 0, remaining: 0 });
    expect(harness.calls).toHaveLength(1);
  });

  it("所选模式只重评指定记录，并覆盖旧的失败原因", async () => {
    const harness = createHarness([
      row("pick", { relevance_error: "模型没有返回评分" }),
      row("other"),
    ], () => ({ choices: [{ message: { content: "评分：80" } }] }));
    const result = await post(harness, { mode: "selected", ids: ["pick"] });
    expect(result.payload).toMatchObject({ scored: 1, failed: 0, attempted: 1, remaining: 0 });
    expect(harness.rows.find((item) => item.id === "pick")).toMatchObject({
      relevance_score: 80,
      relevance_error: null,
    });
    expect(harness.rows.find((item) => item.id === "other")?.relevance_score).toBeNull();
  });

  it("缺少 mode 时返回 400", async () => {
    const harness = createHarness([row("new")], () => ({ response: "70" }));
    const result = await post(harness, {});
    expect(result.status).toBe(400);
    expect(result.payload.error).toMatch(/mode/);
    expect(harness.calls).toHaveLength(0);
  });
});
