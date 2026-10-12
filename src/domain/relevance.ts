const MODEL = "@cf/meta/llama-3.2-3b-instruct";

export function parseRelevanceScore(text: string): number | null {
  const trimmed = text.trim();
  const json = trimmed.match(/"score"\s*:\s*(\d{1,3})/i);
  const raw = json?.[1] ?? (/^\d{1,3}$/.test(trimmed) ? trimmed : "");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return value;
}

export async function scoreRelevance(ai: Ai, text: string, target: string): Promise<number | null> {
  const prompt = [
    "你是监测相关性评分器。只回复一个 0 到 100 的整数，不要解释。",
    "100 表示正文明确在讨论监测对象，0 表示无关、转载旧闻或广告。",
    `监测对象：${target.slice(0, 80)}`,
    `正文：${text.trim().slice(0, 800)}`,
  ].join("\n");
  const payload = await ai.run(MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8,
    temperature: 0,
  });
  const response = payload && typeof payload === "object" && "response" in payload && typeof payload.response === "string"
    ? payload.response
    : "";
  return parseRelevanceScore(response);
}
