import { detectSourceLang } from "./domain/lang";
import { modelText } from "./domain/relevance";

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";
const FALLBACK_MODEL = "@cf/google/gemma-3-12b-it";

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
    machineError = error instanceof Error ? error.message : String(error);
  }
  if (machine && acceptableChinese(slice, machine)) {
    return { text: machine, status: "ok", error: null, sourceLang };
  }
  let chat = "";
  let chatError = "";
  try {
    const payload = await ai.run(FALLBACK_MODEL, {
      messages: [
        { role: "system", content: "只输出简体中文译文。不要解释，不要保留原文，不要加引号。" },
        { role: "user", content: `把下面的文字翻译成简体中文。\n\n${slice}` },
      ],
      max_tokens: 800,
      temperature: 0,
    });
    chat = cleanTranslation(modelText(payload));
  } catch (error) {
    chatError = error instanceof Error ? error.message : String(error);
  }
  if (chat && acceptableChinese(slice, chat)) {
    return { text: chat, status: "ok", error: null, sourceLang };
  }
  const reason = chatError || machineError || (machine || chat ? "译文不是简体中文" : "模型没有返回译文");
  return failed(sourceLang, reason);
}
