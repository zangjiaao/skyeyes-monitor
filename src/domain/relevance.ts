const MODEL = "@cf/meta/llama-3.2-3b-instruct";

export interface RelevanceOutcome {
  score: number | null;
  error: string | null;
}

export function modelText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const nested = record.result;
  if (nested && typeof nested === "object") {
    const response = (nested as Record<string, unknown>).response;
    if (typeof response === "string") return response;
  }
  const choices = record.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
      return (part as Record<string, unknown>).text as string;
    }
    return "";
  }).join("");
}

export function parseRelevanceScore(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const json = trimmed.match(/"score"\s*:\s*(\d{1,3})/i);
  if (json?.[1]) {
    const value = Number(json[1]);
    if (value >= 0 && value <= 100) return value;
  }
  const numbers = [...trimmed.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value >= 0 && value <= 100);
  if (numbers.length === 0) return null;
  return numbers[numbers.length - 1];
}

export async function scoreRelevance(ai: Ai, text: string, target: string): Promise<RelevanceOutcome> {
  const prompt = [
    "给正文和监测对象的相关度打分。",
    "只输出一个 0 到 100 的整数。",
    "100 表示正文明确在讨论监测对象，0 表示无关、旧闻或广告。",
    `监测对象：${target.slice(0, 80)}`,
    `正文：${text.trim().slice(0, 800)}`,
  ].join("\n");
  let payload: unknown;
  try {
    payload = await ai.run(MODEL, {
      messages: [
        { role: "system", content: "只输出一个 0 到 100 的整数。" },
        { role: "user", content: prompt },
      ],
      max_tokens: 24,
      temperature: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { score: null, error: message.slice(0, 200) || "Workers AI 调用失败" };
  }
  const raw = modelText(payload).trim();
  if (!raw) return { score: null, error: "模型没有返回评分" };
  const score = parseRelevanceScore(raw);
  if (score == null) return { score: null, error: `无法解析评分：${raw.slice(0, 80)}` };
  return { score, error: null };
}
