import { describe, expect, it } from "vitest";
import { createApp } from "../src/http/app";

const ARABIC = "أعلنت الجماعة عن هجوم جديد في المنطقة الشمالية";
const CHINESE = "武装组织宣布在北部地区发动新的袭击。";

interface StoredRecord {
  id: string;
  original_text: string;
  source_lang: string | null;
  translation_zh: string | null;
  translation_status: string | null;
  translation_error: string | null;
  deleted_at: string | null;
  collected_at: string;
}

function row(id: string, extra: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    original_text: ARABIC,
    source_lang: null,
    translation_zh: null,
    translation_status: null,
    translation_error: null,
    deleted_at: null,
    collected_at: "2026-10-12T07:00:00.000Z",
    ...extra,
  };
}

function createHarness(initial: StoredRecord[], reply: (model: string) => unknown) {
  const rows = initial.map((item) => ({ ...item }));
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      const execute = (binds: unknown[]) => {
        if (sql.includes("FROM settings")) return { results: [], first: null, changes: 0 };
        if (sql.includes("UPDATE records") && sql.includes("translation_zh = ?")) {
          const found = rows.find((item) => item.id === String(binds[2]));
          if (found) {
            found.translation_zh = String(binds[0]);
            found.translation_status = "ok";
            found.translation_error = null;
            found.source_lang = String(binds[1]);
          }
          return { changes: found ? 1 : 0 };
        }
        if (sql.includes("UPDATE records") && sql.includes("translation_status = 'translation_failed'")) {
          const found = rows.find((item) => item.id === String(binds[2]));
          if (found) {
            found.translation_zh = null;
            found.translation_status = "translation_failed";
            found.translation_error = String(binds[0]);
            found.source_lang = String(binds[1]);
          }
          return { changes: found ? 1 : 0 };
        }
        if (sql.includes("COUNT(*)")) {
          const n = rows.filter((item) => needsTranslation(item)).length;
          return { results: [{ n }], first: { n }, changes: 0 };
        }
        if (sql.includes("FROM records")) {
          let matched = rows.filter((item) => item.deleted_at == null);
          if (sql.includes("id IN")) {
            const ids = binds.map(String);
            matched = matched.filter((item) => ids.includes(item.id));
          }
          if (sql.includes("translation_status = 'translation_failed'")) {
            matched = matched.filter((item) => needsTranslation(item));
          }
          if (sql.includes("ORDER BY collected_at DESC")) {
            matched = [...matched].sort((left, right) => right.collected_at.localeCompare(left.collected_at));
          }
          if (sql.includes("LIMIT")) matched = matched.slice(0, Number(binds[binds.length - 1]));
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
      async run(model: string, input: { text?: string; messages?: Array<{ content?: string }> }) {
        const text = input.text ?? input.messages?.map((message) => message.content ?? "").join("\n") ?? "";
        calls.push(text);
        const next = reply(model);
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

function needsTranslation(item: StoredRecord): boolean {
  if (item.deleted_at) return false;
  if (item.translation_status === "translation_failed") return true;
  return !item.translation_zh?.trim();
}

async function post(harness: ReturnType<typeof createHarness>, body: unknown) {
  const response = await harness.app.request("/api/records/retranslate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, harness.env, harness.ctx);
  const payload = await response.json() as {
    error?: string;
    translated?: number;
    failed?: number;
    attempted?: number;
    remaining?: number;
  };
  return { status: response.status, payload };
}

describe("补译已有记录", () => {
  it("失败或空白模式翻译阿拉伯文，并跳过已有中文的记录", async () => {
    const harness = createHarness([
      row("arabic"),
      row("done", { original_text: "English report", translation_zh: "英文报道", translation_status: "ok" }),
      row("hidden", { deleted_at: "2026-10-01T00:00:00.000Z" }),
    ], () => ({ translated_text: CHINESE }));
    const result = await post(harness, { mode: "failed" });
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ translated: 1, failed: 0, attempted: 1, remaining: 0 });
    expect(harness.rows.find((item) => item.id === "arabic")).toMatchObject({
      translation_zh: CHINESE,
      translation_status: "ok",
      translation_error: null,
      source_lang: "ar",
    });
    expect(harness.rows.find((item) => item.id === "done")?.translation_zh).toBe("英文报道");
    expect(harness.calls[0]).toContain("أعلنت");
  });

  it("模型没有中文时写入 translation_failed 和原因", async () => {
    const harness = createHarness([
      row("arabic", { translation_zh: "", translation_status: null }),
    ], () => ({ translated_text: "" }));
    const result = await post(harness, { mode: "failed" });
    expect(result.payload).toMatchObject({ translated: 0, failed: 1, attempted: 1 });
    expect(harness.rows[0]).toMatchObject({
      translation_zh: null,
      translation_status: "translation_failed",
      source_lang: "ar",
    });
    expect(harness.rows[0]?.translation_error).toBeTruthy();
  });

  it("所选模式只重译指定记录", async () => {
    const harness = createHarness([
      row("pick", { translation_status: "translation_failed", translation_error: "模型没有返回译文" }),
      row("other"),
    ], () => ({ response: CHINESE }));
    const result = await post(harness, { mode: "selected", ids: ["pick"] });
    expect(result.payload).toMatchObject({ translated: 1, failed: 0, attempted: 1, remaining: 0 });
    expect(harness.rows.find((item) => item.id === "pick")?.translation_zh).toBe(CHINESE);
    expect(harness.rows.find((item) => item.id === "other")?.translation_zh).toBeNull();
  });

  it("DeepSeek 译成中文后直接保存，不再调用 Workers AI", async () => {
    const harness = createHarness([row("arabic")], () => {
      throw new Error("不应调用 Workers AI");
    });
    (harness.env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY = "test-key";
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        relevant: true,
        score: 80,
        reason: "讨论袭击",
        source_lang: "ar",
        translation_zh: CHINESE,
        summary_zh: "宣布袭击",
        event_type: "attack",
        people: [],
        places: [],
      }) } }],
    }), { status: 200 });
    try {
      const result = await post(harness, { mode: "failed" });
      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({ translated: 1, failed: 0 });
      expect(harness.calls).toHaveLength(0);
      expect(harness.rows[0]).toMatchObject({ translation_zh: CHINESE, translation_status: "ok", source_lang: "ar" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("备用模型返回 5018 时把停用原因写入失败记录", async () => {
    const harness = createHarness([row("arabic")], (model) => {
      if (model.includes("m2m100")) return { translated_text: "" };
      throw new Error("5018: model deprecated");
    });
    const result = await post(harness, { mode: "failed" });
    expect(result.payload).toMatchObject({ translated: 0, failed: 1 });
    expect(harness.rows[0]?.translation_error).toMatch(/模型不可用/);
    expect(harness.rows[0]?.translation_error).toMatch(/5018/);
  });

  it("缺少 mode 时返回 400", async () => {
    const harness = createHarness([row("arabic")], () => ({ translated_text: CHINESE }));
    const result = await post(harness, {});
    expect(result.status).toBe(400);
    expect(result.payload.error).toMatch(/mode/);
    expect(harness.calls).toHaveLength(0);
  });
});
