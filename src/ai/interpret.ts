import type { AppSettings } from "../config/settings";
import { detectSourceLang } from "../domain/lang";
import { scoreRelevance } from "../domain/relevance";
import { acceptableChinese, translateToChinese } from "../translate";

export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
export const TEXT_LIMIT = 2500;
const ATTEMPTS = 3;

export interface Interpretation {
  relevant: boolean | null;
  score: number | null;
  reason: string;
  sourceLang: string;
  translation: string | null;
  translationStatus: "ok" | "translation_failed" | null;
  translationError: string | null;
  summary: string;
  eventType: string;
  mentions: string;
  provider: "deepseek" | "workers" | "";
  relevanceError: string | null;
}

export interface InterpretInput {
  ai: Ai;
  apiKey: string;
  settings: AppSettings;
  text: string;
  hintedLang?: string | null;
  targetName: string;
  terms: string[];
  description: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const EVENT_TYPES = new Set(["statement", "attack", "meeting", "other"]);

export function parseDeepseekContent(content: string): Omit<Interpretation, "provider" | "translationStatus" | "translationError" | "relevanceError"> | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/u, "").trim();
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const score = Number(record.score);
  const translation = typeof record.translation_zh === "string" ? record.translation_zh.trim() : "";
  const people = stringList(record.people);
  const places = stringList(record.places);
  const eventRaw = typeof record.event_type === "string" ? record.event_type.trim().toLowerCase() : "other";
  const mentions = [
    people.length > 0 ? `人物：${people.join("、")}` : "",
    places.length > 0 ? `地点：${places.join("、")}` : "",
  ].filter(Boolean).join("；");
  return {
    relevant: typeof record.relevant === "boolean" ? record.relevant : null,
    score: Number.isInteger(score) && score >= 0 && score <= 100 ? score : null,
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 200) : "",
    sourceLang: typeof record.source_lang === "string" ? record.source_lang.trim().slice(0, 12) : "",
    translation: translation || null,
    summary: typeof record.summary_zh === "string" ? record.summary_zh.trim().slice(0, 240) : "",
    eventType: EVENT_TYPES.has(eventRaw) ? eventRaw : "other",
    mentions: mentions.slice(0, 400),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 40))
    .slice(0, 8);
}

function emptyBase(sourceLang: string): Interpretation {
  return {
    relevant: null,
    score: null,
    reason: "",
    sourceLang,
    translation: null,
    translationStatus: null,
    translationError: null,
    summary: "",
    eventType: "",
    mentions: "",
    provider: "",
    relevanceError: null,
  };
}

function chatContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

async function pause(ms: number, sleepImpl?: (ms: number) => Promise<void>): Promise<void> {
  if (ms <= 0) return;
  if (sleepImpl) {
    await sleepImpl(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callDeepseek(input: {
  apiKey: string;
  model: string;
  text: string;
  targetName: string;
  terms: string[];
  description: string;
  fetchImpl: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<{ ok: true; parsed: NonNullable<ReturnType<typeof parseDeepseekContent>> } | { ok: false; error: string }> {
  const model = /^[A-Za-z0-9._-]{1,64}$/.test(input.model) ? input.model : "deepseek-chat";
  const body = {
    model,
    temperature: 0,
    max_tokens: 1200,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "你是监测助手。只输出一个 JSON 对象，不要 Markdown。字段：relevant（布尔，正文是否在讨论监测对象）、score（0到100的整数）、reason（简体中文短原因）、source_lang（原文语言代码，如 ar、ur、fa、en、zh）、translation_zh（全文简体中文译文，不要解释）、summary_zh（一句简体中文摘要）、event_type（statement、attack、meeting、other 之一）、people（字符串数组）、places（字符串数组）。",
      },
      {
        role: "user",
        content: [
          `监测对象：${input.targetName.slice(0, 80)}`,
          `检索词：${input.terms.slice(0, 12).join("、").slice(0, 300)}`,
          `背景：${input.description.trim().slice(0, 500) || "无"}`,
          `正文：${input.text.trim().slice(0, TEXT_LIMIT)}`,
        ].join("\n"),
      },
    ],
  };
  let lastError = "DeepSeek 没有返回解读";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await input.fetchImpl(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "DeepSeek 网络失败";
      await pause(400 * (2 ** attempt), input.sleepImpl);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : 400 * (2 ** attempt);
      lastError = `DeepSeek HTTP ${response.status}`;
      await pause(waitMs, input.sleepImpl);
      continue;
    }
    if (!response.ok) {
      lastError = `DeepSeek HTTP ${response.status}`;
      break;
    }
    const payload = await response.json() as unknown;
    const parsed = parseDeepseekContent(chatContent(payload));
    if (!parsed || parsed.score == null) {
      lastError = "DeepSeek 返回的 JSON 无法解析";
      break;
    }
    return { ok: true, parsed };
  }
  return { ok: false, error: lastError.slice(0, 200) };
}

async function workersTranslation(input: InterpretInput, hinted: string | null): Promise<Pick<Interpretation, "translation" | "translationStatus" | "translationError" | "sourceLang">> {
  if (!input.settings.translationEnabled) {
    return {
      translation: null,
      translationStatus: null,
      translationError: null,
      sourceLang: detectSourceLang(input.text, hinted, input.settings.translationSourceLang),
    };
  }
  const outcome = await translateToChinese(
    input.ai,
    input.text,
    hinted,
    input.settings.translationTargetLang,
    input.settings.translationSourceLang,
    input.settings.translationFallbackModel,
  );
  return {
    translation: outcome.text,
    translationStatus: outcome.status,
    translationError: outcome.error,
    sourceLang: outcome.sourceLang,
  };
}

export async function interpretRecord(input: InterpretInput): Promise<Interpretation> {
  const hinted = input.hintedLang ?? null;
  const detected = detectSourceLang(input.text, hinted, input.settings.translationSourceLang);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const wantDeepseek = input.settings.aiProvider === "deepseek" && input.settings.aiEnabled;
  if (wantDeepseek && input.apiKey.trim()) {
    const deep = await callDeepseek({
      apiKey: input.apiKey.trim(),
      model: input.settings.aiModel,
      text: input.text,
      targetName: input.targetName,
      terms: input.terms,
      description: input.description,
      fetchImpl,
      sleepImpl: input.sleepImpl,
    });
    if (deep.ok) {
      const sourceLang = detectSourceLang(input.text, deep.parsed.sourceLang || hinted, input.settings.translationSourceLang);
      let translation = deep.parsed.translation;
      let translationStatus: Interpretation["translationStatus"] = translation && acceptableChinese(input.text, translation) ? "ok" : "translation_failed";
      let translationError = translationStatus === "ok" ? null : "DeepSeek 没有返回简体中文译文";
      if (translationStatus !== "ok" && input.settings.translationEnabled) {
        const fallback = await workersTranslation(input, sourceLang);
        translation = fallback.translation;
        translationStatus = fallback.translationStatus;
        translationError = fallback.translationError;
      }
      return {
        ...emptyBase(sourceLang),
        ...deep.parsed,
        sourceLang,
        translation,
        translationStatus,
        translationError,
        provider: "deepseek",
        relevanceError: null,
      };
    }
    const fallback = await workersTranslation(input, hinted);
    return {
      ...emptyBase(fallback.sourceLang || detected),
      ...fallback,
      provider: "workers",
      relevanceError: deep.error,
      reason: "",
    };
  }
  const translation = await workersTranslation(input, hinted);
  const result = emptyBase(translation.sourceLang || detected);
  result.translation = translation.translation;
  result.translationStatus = translation.translationStatus;
  result.translationError = translation.translationError;
  result.provider = "workers";
  if (wantDeepseek && !input.apiKey.trim()) {
    result.relevanceError = "未配置 DEEPSEEK_API_KEY";
    return result;
  }
  if (input.settings.relevanceEnabled && input.text.trim()) {
    const scored = await scoreRelevance(input.ai, input.text, input.targetName);
    result.score = scored.score;
    result.relevant = scored.score == null ? null : scored.score >= input.settings.relevanceThreshold;
    result.relevanceError = scored.error;
  }
  return result;
}
