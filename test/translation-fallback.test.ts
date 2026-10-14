import { describe, expect, it } from "vitest";
import { parseSettings, validateSettingsPatch } from "../src/config/settings";
import { DEFAULT_TRANSLATION_FALLBACK_MODEL } from "../src/translate";
import { createApp } from "../src/http/app";

function createHarness(run: (model: string) => unknown) {
  const settings = new Map<string, string>();
  const calls: string[] = [];
  const execute = (sql: string, binds: unknown[]) => {
    if (sql.includes("INSERT INTO settings")) {
      settings.set(String(binds[0]), String(binds[1]));
      return { results: [] as unknown[], first: null, changes: 1 };
    }
    if (sql.includes("FROM settings")) {
      const results = [...settings.entries()].map(([key, value]) => ({ key, value }));
      return { results, first: results[0] ?? null, changes: 0 };
    }
    return { results: [], first: null, changes: 0 };
  };
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
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
  const env = {
    ENVIRONMENT: "development",
    DB: db,
    AI: {
      async run(model: string) {
        calls.push(model);
        const next = run(model);
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
  return { app: createApp(), env, ctx, settings, calls };
}

async function putModel(harness: ReturnType<typeof createHarness>, model: string) {
  const response = await harness.app.request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ translation_fallback_model: model }),
  }, harness.env, harness.ctx);
  const payload = await response.json() as { error?: string };
  return { status: response.status, payload };
}

describe("保存翻译备用模型", () => {
  it("未写入时使用当前可用的默认对话模型", () => {
    expect(parseSettings({}).translationFallbackModel).toBe(DEFAULT_TRANSLATION_FALLBACK_MODEL);
    expect(validateSettingsPatch({ translation_fallback_model: "" }).translation_fallback_model).toBe(DEFAULT_TRANSLATION_FALLBACK_MODEL);
  });

  it("已停用的 Gemma 和非法名字在保存前拒绝，不调用模型", async () => {
    expect(() => validateSettingsPatch({ translation_fallback_model: "@cf/google/gemma-3-12b-it" })).toThrow(/5018/);
    expect(() => validateSettingsPatch({ translation_fallback_model: "@cf/google/gemma-3-12b-it" })).toThrow(/model deprecated/);
    expect(() => validateSettingsPatch({ translation_fallback_model: "gemma" })).toThrow(/Workers AI 模型名/);

    const harness = createHarness(() => {
      throw new Error("不应试跑");
    });
    const retired = await putModel(harness, "@cf/google/gemma-3-12b-it");
    expect(retired.status).toBe(400);
    expect(retired.payload.error).toMatch(/5018/);
    expect(retired.payload.error).toMatch(/model deprecated/);
    expect(harness.calls).toHaveLength(0);
    expect(harness.settings.has("translation_fallback_model")).toBe(false);
  });

  it("改成别的模型时试跑，5018 拒绝保存，成功则写入", async () => {
    const failing = createHarness(() => new Error("5018: model deprecated"));
    const denied = await putModel(failing, "@cf/example/other-chat");
    expect(denied.status).toBe(400);
    expect(denied.payload.error).toMatch(/模型不可用/);
    expect(denied.payload.error).toMatch(/5018/);
    expect(failing.calls).toEqual(["@cf/example/other-chat"]);
    expect(failing.settings.has("translation_fallback_model")).toBe(false);

    const ok = createHarness(() => ({ response: "你好" }));
    const saved = await putModel(ok, "@cf/example/other-chat");
    expect(saved.status).toBe(200);
    expect(ok.settings.get("translation_fallback_model")).toBe("@cf/example/other-chat");

    ok.calls.length = 0;
    const again = await putModel(ok, "@cf/example/other-chat");
    expect(again.status).toBe(200);
    expect(ok.calls).toHaveLength(0);
  });

  it("库里没有这项时保存默认值，不试跑", async () => {
    const harness = createHarness(() => {
      throw new Error("不应试跑");
    });
    const saved = await putModel(harness, DEFAULT_TRANSLATION_FALLBACK_MODEL);
    expect(saved.status).toBe(200);
    expect(harness.calls).toHaveLength(0);
    expect(harness.settings.get("translation_fallback_model")).toBe(DEFAULT_TRANSLATION_FALLBACK_MODEL);
  });
});
