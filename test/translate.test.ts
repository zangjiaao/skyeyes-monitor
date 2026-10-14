import { describe, expect, it } from "vitest";
import { detectSourceLang } from "../src/domain/lang";
import type { QueryTarget, SearchRequest } from "../src/domain/types";
import { tweetsToRecords } from "../src/sources/x";
import {
  acceptableChinese,
  assertTranslationFallbackModel,
  DEFAULT_TRANSLATION_FALLBACK_MODEL,
  probeTranslationFallbackModel,
  translateToChinese,
  translationCell,
} from "../src/translate";

const ARABIC = "أعلنت الجماعة عن هجوم جديد في المنطقة الشمالية";
const URDU = "بلوچستان میں نیا حملہ ہوا ہے";
const PERSIAN = "گروه تازه‌ای حمله را اعلام کرد";
const CHINESE = "武装组织宣布在北部地区发动新的袭击。";

function fakeAi(handler: (model: string, input: { source_lang?: string; text?: string }) => unknown): Ai {
  return {
    async run(model: string, input: { source_lang?: string; text?: string }) {
      const next = handler(model, input);
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Ai;
}

describe("语种识别", () => {
  it("阿拉伯文、乌尔都语和波斯语按字形区分，不落回英文", () => {
    expect(detectSourceLang(ARABIC, null, "en")).toBe("ar");
    expect(detectSourceLang(URDU, null, "en")).toBe("ur");
    expect(detectSourceLang(PERSIAN, null, "en")).toBe("fa");
  });

  it("X 的 lang 在同一文字内优先，和文字冲突时不用它", () => {
    expect(detectSourceLang(URDU, "ur", "en")).toBe("ur");
    expect(detectSourceLang(ARABIC, "en", "en")).toBe("ar");
    expect(detectSourceLang("The group announced a new attack", "fr", "en")).toBe("fr");
    expect(detectSourceLang("The group announced a new attack", null, "en")).toBe("en");
  });

  it("采集 X 时保留推文的 lang", () => {
    const records = tweetsToRecords(
      [{ id: "9", text: ARABIC, lang: "ar", url: "https://x.com/a/status/9" }],
      { countryName: "巴基斯坦" } as SearchRequest,
      { id: "t", kind: "organization", name: "目标", query: "BLA" } satisfies QueryTarget,
      "BLA",
    );
    expect(records[0]?.sourceLang).toBe("ar");
    expect(records[0]?.text).toBe(ARABIC);
  });
});

describe("翻译到简体中文", () => {
  it("阿拉伯文用 ar 调用 m2m100，译文是中文时不再调用大模型", async () => {
    const models: string[] = [];
    const ai = fakeAi((model, input) => {
      models.push(model);
      expect(input.source_lang).toBe("ar");
      expect(input.text).toContain("أعلنت");
      return { translated_text: CHINESE };
    });
    const outcome = await translateToChinese(ai, ARABIC, null, "zh", "en");
    expect(outcome).toEqual({ text: CHINESE, status: "ok", error: null, sourceLang: "ar" });
    expect(models).toEqual(["@cf/meta/m2m100-1.2b"]);
  });

  it("m2m 返回空或原文时，用配置的对话模型只译成简体中文", async () => {
    for (const machine of ["", ARABIC]) {
      const models: string[] = [];
      const ai = fakeAi((model) => {
        models.push(model);
        if (model.includes("m2m100")) return { translated_text: machine };
        return { response: CHINESE };
      });
      const outcome = await translateToChinese(ai, ARABIC, "ar", "zh", "en");
      expect(outcome.status).toBe("ok");
      expect(outcome.text).toBe(CHINESE);
      expect(outcome.sourceLang).toBe("ar");
      expect(models[1]).toBe(DEFAULT_TRANSLATION_FALLBACK_MODEL);
      expect(models[1]).toBe("@cf/zai-org/glm-4.7-flash");
    }
  });

  it("调用配置里的备用模型，而不是写死的默认值", async () => {
    const models: string[] = [];
    const ai = fakeAi((model) => {
      models.push(model);
      if (model.includes("m2m100")) return { translated_text: "" };
      return { response: CHINESE };
    });
    const outcome = await translateToChinese(ai, ARABIC, "ar", "zh", "en", "@cf/example/other-chat");
    expect(outcome.text).toBe(CHINESE);
    expect(models).toEqual(["@cf/meta/m2m100-1.2b", "@cf/example/other-chat"]);
  });

  it("备用模型返回 5018 时把停用原因写进翻译失败", async () => {
    const ai = fakeAi((model) => {
      if (model.includes("m2m100")) return { translated_text: "" };
      throw new Error("5018: model deprecated");
    });
    const outcome = await translateToChinese(ai, ARABIC, null, "zh", "en");
    expect(outcome.status).toBe("translation_failed");
    expect(outcome.error).toMatch(/模型不可用/);
    expect(outcome.error).toMatch(/5018/);
    expect(outcome.error).toMatch(/deprecat/i);
    expect(outcome.error).toContain("@cf/zai-org/glm-4.7-flash");
    expect(translationCell(outcome.text, outcome.status, outcome.error)).toContain("翻译失败：模型不可用");
  });

  it("两步都失败时记下 translation_failed 和原因", async () => {
    const ai = fakeAi((model) => {
      if (model.includes("m2m100")) return { translated_text: "" };
      throw new Error("Workers AI 远程调用失败");
    });
    const outcome = await translateToChinese(ai, ARABIC, null, "zh", "en");
    expect(outcome.status).toBe("translation_failed");
    expect(outcome.text).toBeNull();
    expect(outcome.error).toBe("Workers AI 远程调用失败");
    expect(outcome.sourceLang).toBe("ar");
    expect(translationCell(outcome.text, outcome.status, outcome.error)).toBe("翻译失败：Workers AI 远程调用失败");
  });

  it("已经是中文时不调用模型", async () => {
    let called = false;
    const ai = fakeAi(() => {
      called = true;
      return { translated_text: "" };
    });
    const outcome = await translateToChinese(ai, "这是一条中文通报。", "en", "zh", "en");
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ status: "ok", sourceLang: "zh" });
    expect(acceptableChinese(ARABIC, CHINESE)).toBe(true);
    expect(acceptableChinese(ARABIC, ARABIC)).toBe(false);
  });
});

describe("翻译备用模型", () => {
  it("拒绝已停用的 Gemma 和不合规的模型名", () => {
    expect(() => assertTranslationFallbackModel("@cf/google/gemma-3-12b-it")).toThrow(/5018/);
    expect(() => assertTranslationFallbackModel("@cf/google/gemma-3-12b-it")).toThrow(/2026-05-30/);
    expect(() => assertTranslationFallbackModel("gemma")).toThrow(/Workers AI 模型名/);
    expect(() => assertTranslationFallbackModel(DEFAULT_TRANSLATION_FALLBACK_MODEL)).not.toThrow();
  });

  it("试跑成功则通过，5018 则拒绝", async () => {
    await expect(probeTranslationFallbackModel({
      async run() {
        return { response: "你好" };
      },
    } as unknown as Ai, "@cf/example/other-chat")).resolves.toBeUndefined();

    await expect(probeTranslationFallbackModel({
      async run() {
        throw new Error("5018: model deprecated");
      },
    } as unknown as Ai, "@cf/example/other-chat")).rejects.toThrow(/模型不可用：5018/);
  });
});
