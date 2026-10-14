import { detectSourceLang } from "./domain/lang";
import { modelText } from "./domain/relevance";

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";
export const DEFAULT_TRANSLATION_FALLBACK_MODEL = "@cf/zai-org/glm-4.7-flash";
export const RETIRED_TRANSLATION_FALLBACK_MODEL = "@cf/google/gemma-3-12b-it";

const MODEL_ID = /^@(cf|hf)\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export function assertTranslationFallbackModel(model: string): void {
  if (!MODEL_ID.test(model)) {
    throw new Error("翻译备用模型必须是 Workers AI 模型名，例如 @cf/zai-org/glm-4.7-flash");
  }
  if (model === RETIRED_TRANSLATION_FALLBACK_MODEL) {
    throw new Error("模型不可用：5018 model deprecated。@cf/google/gemma-3-12b-it 已于 2026-05-30 停用，请改用 @cf/zai-org/glm-4.7-flash");
  }
}

function rawAiError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";
  const record = error as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    return [nested.code, nested.message].filter((part) => part != null && part !== "").join(" ");
  }
  if (Array.isArray(record.errors) && record.errors[0] && typeof record.errors[0] === "object") {
    const item = record.errors[0] as Record<string, unknown>;
    return [item.code, item.message].filter((part) => part != null && part !== "").join(" ");
  }
  return "";
}

export function explainWorkersAiError(error: unknown, model: string): string | null {
  const raw = rawAiError(error).replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (raw.startsWith("模型不可用：")) return raw.slice(0, 200);
  if (/\b5018\b/.test(raw) || /deprecat/i.test(raw) || /not found|unknown model|no such model|does not exist|invalid model/i.test(raw)) {
    return `模型不可用：${raw}（${model}）`.slice(0, 200);
  }
  return null;
}

export async function probeTranslationFallbackModel(ai: Ai, model: string): Promise<void> {
  assertTranslationFallbackModel(model);
  try {
    const payload = await ai.run(model, {
      messages: [{ role: "user", content: "把 hi 译成简体中文，只输出译文。" }],
      max_tokens: 16,
      chat_template_kwargs: { enable_thinking: false },
    });
    const embedded = explainWorkersAiError(payload, model);
    if (embedded) throw new Error(embedded);
  } catch (error) {
    const explained = explainWorkersAiError(error, model);
    if (explained) throw new Error(explained);
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(`无法确认翻译备用模型 ${model}：${raw}`.slice(0, 200));
  }
}

export interface TranslationOutcome {
  text: string | null;
  status: "ok" | "translation_failed";
  error: string | null;
  sourceLang: string;
}

export function isMostlyChinese(text: string): boolean {
  const chars = Array.from(text).filter((char) => /\S/u.test(char));
  if (chars.length === 0) return true;
  const han = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return han / chars.length >= 0.3;
}

export function translationCell(
  text: string | null | undefined,
  status: string | null | undefined,
  error: string | null | undefined,
): string {
  if (text?.trim()) return text;
  if (status === "translation_failed") {
    return error?.trim() ? `翻译失败：${error.trim()}` : "翻译失败";
  }
  return "";
}

function compact(text: string): string {
  return text.replace(/\s+/gu, "").trim();
}

export function acceptableChinese(source: string, output: string): boolean {
  const text = output.trim();
  if (!text) return false;
  if (compact(text) === compact(source)) return false;
  if (isMostlyChinese(text)) return true;
  const han = Array.from(text).filter((char) => /\p{Script=Han}/u.test(char)).length;
  return han >= 4;
}

function cleanTranslation(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  text = text.replace(/^```[a-z]*\n?/iu, "").replace(/```$/u, "").trim();
  text = text.replace(/^(译文|翻译|简体中文|中文译文)\s*[:：]\s*/u, "").trim();
  const pairs: Array<[string, string]> = [["「", "」"], ["\"", "\""], ["“", "”"]];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
      text = text.slice(open.length, -close.length).trim();
    }
  }
  return text;
}

function m2mText(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const translated = (payload as Record<string, unknown>).translated_text;
    if (typeof translated === "string") return translated;
  }
  return modelText(payload);
}

function failed(sourceLang: string, error: string): TranslationOutcome {
  return { text: null, status: "translation_failed", error: error.slice(0, 200), sourceLang };
}

export async function translateToChinese(
  ai: Ai,
  text: string,
  sourceLangOrHint: string | null = "en",
  targetLang = "zh",
  configuredLang = "en",
  fallbackModel = DEFAULT_TRANSLATION_FALLBACK_MODEL,
): Promise<TranslationOutcome> {
  const trimmed = text.trim();
  const sourceLang = detectSourceLang(trimmed, sourceLangOrHint, configuredLang);
  if (!trimmed) return failed(sourceLang, "没有可翻译的正文");
  if (sourceLang === "zh" || isMostlyChinese(trimmed)) {
    return { text: trimmed, status: "ok", error: null, sourceLang: "zh" };
  }
  const target = targetLang?.trim() || "zh";
  const slice = trimmed.slice(0, 1200);
  let machine = "";
  let machineError = "";
  try {
    const payload = await ai.run(TRANSLATION_MODEL, {
      text: slice,
      source_lang: sourceLang,
      target_lang: target,
    });
    machine = cleanTranslation(m2mText(payload));
  } catch (error) {
    machineError = explainWorkersAiError(error, TRANSLATION_MODEL) ?? (error instanceof Error ? error.message : String(error));
  }
  if (machine && acceptableChinese(slice, machine)) {
    return { text: machine, status: "ok", error: null, sourceLang };
  }
  const chatModel = fallbackModel.trim() || DEFAULT_TRANSLATION_FALLBACK_MODEL;
  let chat = "";
  let chatError = "";
  try {
    assertTranslationFallbackModel(chatModel);
    const payload = await ai.run(chatModel, {
      messages: [
        { role: "system", content: "只输出简体中文译文。不要解释，不要保留原文，不要加引号。" },
        { role: "user", content: `把下面的文字翻译成简体中文。\n\n${slice}` },
      ],
      max_tokens: 800,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
    const embedded = explainWorkersAiError(payload, chatModel);
    if (embedded) throw new Error(embedded);
    chat = cleanTranslation(modelText(payload));
  } catch (error) {
    chatError = explainWorkersAiError(error, chatModel) ?? (error instanceof Error ? error.message : String(error));
  }
  if (chat && acceptableChinese(slice, chat)) {
    return { text: chat, status: "ok", error: null, sourceLang };
  }
  const unavailable = [chatError, machineError].find((item) => item.includes("模型不可用") || item.includes("5018"));
  const reason = unavailable || chatError || machineError || (machine || chat ? "译文不是简体中文" : "模型没有返回译文");
  return failed(sourceLang, reason);
}
