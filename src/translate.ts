export function isMostlyChinese(text: string): boolean {
  const chars = Array.from(text).filter((char) => /\S/u.test(char));
  if (chars.length === 0) return true;
  const han = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  return han / chars.length >= 0.3;
}

function translatedText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return typeof record.translated_text === "string" ? record.translated_text : "";
}

export async function translateToChinese(
  ai: Ai,
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (isMostlyChinese(trimmed)) return trimmed;
  const payload = await ai.run("@cf/meta/m2m100-1.2b", {
    text: trimmed.slice(0, 1200),
    source_lang: sourceLang || "en",
    target_lang: targetLang || "zh",
  });
  return translatedText(payload).trim();
}
