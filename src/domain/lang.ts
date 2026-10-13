const LANG_ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  "zh-cn": "zh",
  "zh-tw": "zh",
  "zh-hans": "zh",
  "zh-hant": "zh",
};

/** m2m100-1.2b 接受的常见代码。不在表里的代码不传给它。 */
const M2M_LANGS = new Set([
  "ar", "bn", "de", "el", "en", "es", "fa", "fr", "he", "hi", "id", "it", "ja", "ko",
  "nl", "pl", "ps", "pt", "ru", "sd", "sv", "th", "tr", "uk", "ur", "vi", "zh",
]);

const ARABIC_FAMILY = new Set(["ar", "fa", "ps", "sd", "ur"]);

export function normalizeLang(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase().replaceAll("_", "-");
  if (!raw || raw === "und" || raw === "zxx" || raw === "qme" || raw === "qht") return null;
  const mapped = LANG_ALIASES[raw] ?? raw.split("-")[0] ?? "";
  return M2M_LANGS.has(mapped) ? mapped : null;
}

function scriptLang(text: string): string | null {
  const letters = Array.from(text).filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) return null;
  const count = (pattern: RegExp) => letters.filter((char) => pattern.test(char)).length;
  const share = (amount: number) => amount / letters.length;
  const joined = letters.join("");
  const kana = count(/\p{Script=Hiragana}|\p{Script=Katakana}/u);
  if (kana >= 2 && share(kana) >= 0.08) return "ja";
  if (share(count(/\p{Script=Hangul}/u)) >= 0.4) return "ko";
  if (share(count(/\p{Script=Han}/u)) >= 0.3) return "zh";
  if (share(count(/\p{Script=Arabic}/u)) >= 0.4) {
    if (/[ټډړڅځښګڼېۍ]/u.test(joined)) return "ps";
    if (/[ٹڈڑںےھ]/u.test(joined)) return "ur";
    if (/[پچژگ]/u.test(joined)) return "fa";
    return "ar";
  }
  const ranked = [
    ["ru", count(/\p{Script=Cyrillic}/u)],
    ["hi", count(/\p{Script=Devanagari}/u)],
    ["he", count(/\p{Script=Hebrew}/u)],
    ["th", count(/\p{Script=Thai}/u)],
    ["el", count(/\p{Script=Greek}/u)],
    ["bn", count(/\p{Script=Bengali}/u)],
  ] as const;
  const best = ranked.reduce((top, item) => (item[1] > top[1] ? item : top));
  if (share(best[1]) >= 0.4) return best[0];
  return null;
}

function compatible(hinted: string, scripted: string): boolean {
  if (hinted === scripted) return true;
  return ARABIC_FAMILY.has(hinted) && ARABIC_FAMILY.has(scripted);
}

/** 阿拉伯文等非拉丁文字优先看字形；同一文字内有 X 的 lang 时采用它。拉丁文字用提示或配置。 */
export function detectSourceLang(text: string, hint?: string | null, fallback = "en"): string {
  const hinted = normalizeLang(hint);
  const scripted = scriptLang(text);
  if (hinted && scripted && compatible(hinted, scripted)) return hinted;
  if (scripted) return scripted;
  if (hinted) return hinted;
  return normalizeLang(fallback) ?? "en";
}
