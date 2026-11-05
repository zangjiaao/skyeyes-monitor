export interface PreparedAiText {
  text: string | null;
  error: string | null;
  inputType: string;
  inputLength: number;
  inputBytes: number;
  replacements: number;
  truncated: boolean;
}

/** Prepare only the model input. Original text and matching/dedupe identities stay unchanged. */
export function prepareAiText(value: unknown, limit: number): PreparedAiText {
  const inputType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const result: PreparedAiText = {
    text: null, error: null, inputType, inputLength: typeof value === "string" ? value.length : 0,
    inputBytes: 0, replacements: 0, truncated: false,
  };
  if (typeof value !== "string") return { ...result, error: `AI 正文必须是字符串，收到 ${inputType}` };
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("AI 文本长度上限无效");
  let clean = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      clean += "\uFFFD";
      result.replacements += 1;
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      // Separate surrounding words instead of accidentally joining them.
      clean += " ";
      result.replacements += 1;
    } else {
      // Keep ZWJ/ZWNJ, accents and non-Latin scripts intact.
      clean += char;
    }
  }
  clean = clean.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!clean) return { ...result, error: "没有可翻译的正文" };
  let text = "";
  for (const char of clean) {
    if (text.length + char.length > limit) { result.truncated = true; break; }
    text += char;
  }
  if (!text) return { ...result, error: "AI 文本长度上限无法容纳首个字符" };
  return { ...result, text, inputBytes: new TextEncoder().encode(text).byteLength };
}
