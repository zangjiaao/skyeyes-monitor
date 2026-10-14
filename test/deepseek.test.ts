import { describe, expect, it } from "vitest";
import { callDeepseek, interpretRecord, parseDeepseekContent, TEXT_LIMIT } from "../src/ai/interpret";
import { parseSettings } from "../src/config/settings";
import { decideAdmission } from "../src/domain/gate";

const ARABIC = "أعلنت الجماعة عن هجوم جديد في المنطقة الشمالية";
const CHINESE = "武装组织宣布在北部地区发动新的袭击。";

function deepseekBody(extra: Record<string, unknown> = {}) {
  return {
    relevant: true,
    score: 82,
    reason: "正文在讨论袭击",
    source_lang: "ar",
    translation_zh: CHINESE,
    summary_zh: "武装组织宣布发动袭击。",
    event_type: "attack",
    people: ["发言人"],
    places: ["北部地区"],
    ...extra,
  };
}

function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("DeepSeek 解读", () => {
  it("解析严格 JSON，并收下人和地点", () => {
    const parsed = parseDeepseekContent(JSON.stringify(deepseekBody()));
    expect(parsed).toMatchObject({
      relevant: true,
      score: 82,
      sourceLang: "ar",
      translation: CHINESE,
      eventType: "attack",
      mentions: "人物：发言人；地点：北部地区",
    });
    expect(parseDeepseekContent("不是 JSON")).toBeNull();
    expect(parseDeepseekContent(JSON.stringify({ score: 150, relevant: true }))?.score).toBeNull();
  });

  it("阿拉伯文按 ar 送出，429 之后重试成功", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await callDeepseek({
      apiKey: "test-key",
      model: "deepseek-chat",
      text: ARABIC,
      targetName: "俾路支解放军",
      terms: ["BLA"],
      description: "关注袭击和声明",
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        expect(body.messages.some((message) => message.content.includes(ARABIC.slice(0, 12)))).toBe(true);
        expect(body.messages.some((message) => message.content.includes("关注袭击"))).toBe(true);
        if (calls === 1) return jsonResponse(429, { error: "busy" }, { "Retry-After": "1" });
        return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(deepseekBody()) } }] });
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.translation).toBe(CHINESE);
    expect(waits).toEqual([1000]);
  });

  it("没有密钥时用 Workers AI 按阿拉伯文翻译，并记下评分失败", async () => {
    const settings = parseSettings({ ai_provider: "deepseek", ai_enabled: "1", translation_enabled: "1" });
    let sourceLang = "";
    const ai = {
      async run(model: string, input: { source_lang?: string }) {
        expect(model).toContain("m2m100");
        sourceLang = input.source_lang ?? "";
        return { translated_text: CHINESE };
      },
    } as unknown as Ai;
    const outcome = await interpretRecord({
      ai,
      apiKey: "",
      settings,
      text: ARABIC,
      hintedLang: null,
      targetName: "目标",
      terms: ["BLA"],
      description: "",
      fetchImpl: async () => {
        throw new Error("不应调用 DeepSeek");
      },
    });
    expect(sourceLang).toBe("ar");
    expect(outcome.translation).toBe(CHINESE);
    expect(outcome.translationStatus).toBe("ok");
    expect(outcome.score).toBeNull();
    expect(outcome.relevanceError).toBe("未配置 DEEPSEEK_API_KEY");
    expect(outcome.provider).toBe("workers");
  });

  it("DeepSeek 译成中文后不再调用 Workers AI", async () => {
    const settings = parseSettings({ ai_provider: "deepseek", ai_enabled: "1", translation_enabled: "1" });
    let aiCalls = 0;
    const outcome = await interpretRecord({
      ai: {
        async run() {
          aiCalls += 1;
          return { translated_text: "不应使用" };
        },
      } as unknown as Ai,
      apiKey: "test-key",
      settings,
      text: ARABIC,
      targetName: "目标",
      terms: [],
      description: "",
      sleepImpl: async () => {},
      fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify(deepseekBody()) } }] }),
    });
    expect(aiCalls).toBe(0);
    expect(outcome.provider).toBe("deepseek");
    expect(outcome.translationStatus).toBe("ok");
    expect(outcome.translation).toBe(CHINESE);
    expect(outcome.translationError).toBeNull();
  });

  it("DeepSeek 译文不是中文时改走 m2m100 和备用对话模型", async () => {
    const settings = parseSettings({
      ai_provider: "deepseek",
      ai_enabled: "1",
      translation_fallback_model: "@cf/example/other-chat",
    });
    const models: string[] = [];
    const outcome = await interpretRecord({
      ai: {
        async run(model: string) {
          models.push(model);
          if (model.includes("m2m100")) return { translated_text: "" };
          return { response: CHINESE };
        },
      } as unknown as Ai,
      apiKey: "test-key",
      settings,
      text: ARABIC,
      targetName: "目标",
      terms: [],
      description: "",
      sleepImpl: async () => {},
      fetchImpl: async () => jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify(deepseekBody({ translation_zh: "not chinese" })) } }],
      }),
    });
    expect(models).toEqual(["@cf/meta/m2m100-1.2b", "@cf/example/other-chat"]);
    expect(outcome.translation).toBe(CHINESE);
    expect(outcome.translationStatus).toBe("ok");
    expect(outcome.provider).toBe("deepseek");
  });

  it("DeepSeek 和备用模型都失败时，翻译失败原因包含 5018", async () => {
    const settings = parseSettings({ ai_provider: "deepseek", ai_enabled: "1" });
    const outcome = await interpretRecord({
      ai: {
        async run(model: string) {
          if (model.includes("m2m100")) return { translated_text: "" };
          throw new Error("5018: model deprecated");
        },
      } as unknown as Ai,
      apiKey: "test-key",
      settings,
      text: ARABIC,
      targetName: "目标",
      terms: [],
      description: "",
      sleepImpl: async () => {},
      fetchImpl: async () => jsonResponse(200, {
        choices: [{ message: { content: JSON.stringify(deepseekBody({ translation_zh: "" })) } }],
      }),
    });
    expect(outcome.translationStatus).toBe("translation_failed");
    expect(outcome.translationError).toMatch(/5018/);
    expect(outcome.translationError).toMatch(/模型不可用/);
  });

  it("DeepSeek 失败时译文回退，评分原因保留", async () => {
    const settings = parseSettings({ ai_provider: "deepseek", ai_enabled: "1" });
    const ai = {
      async run() {
        return { translated_text: CHINESE };
      },
    } as unknown as Ai;
    const outcome = await interpretRecord({
      ai,
      apiKey: "test-key",
      settings,
      text: ARABIC,
      targetName: "目标",
      terms: [],
      description: "",
      sleepImpl: async () => {},
      fetchImpl: async () => jsonResponse(500, { error: "down" }),
    });
    expect(outcome.translation).toBe(CHINESE);
    expect(outcome.score).toBeNull();
    expect(outcome.relevanceError).toContain("500");
  });

  it("模型判定不相关时不进入日报，正文长度有上限", () => {
    const window = {
      start: new Date("2026-10-11T02:00:00.000Z"),
      end: new Date("2026-10-12T02:00:00.000Z"),
    };
    const blocked = decideAdmission({
      publishedAt: "2026-10-11T06:00:00.000Z",
      window,
      ruleReason: null,
      republish: false,
      relevanceEnabled: true,
      relevanceScore: 90,
      relevanceThreshold: 40,
      relevant: false,
    });
    expect(blocked).toMatchObject({ action: "store_only", excludeReason: "relevance" });
    expect(TEXT_LIMIT).toBe(2500);
  });
});
