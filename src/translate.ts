const LANGUAGE_NAMES: Record<string, string> = {
  en: "english",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
  fr: "french",
  de: "german",
  es: "spanish",
  pt: "portuguese",
  ru: "russian",
  ar: "arabic",
  hi: "hindi",
  id: "indonesian",
  vi: "vietnamese",
  th: "thai",
  tr: "turkish",
  it: "italian",
  nl: "dutch",
  pl: "polish",
  uk: "ukrainian",
  fa: "persian",
  he: "hebrew",
};

export interface TranslationModels {
  primary: string;
  fallback: string;
}

export interface TranslationRunner {
  run(model: string, input: { text: string; source_lang: string; target_lang: string }): Promise<unknown>;
}

export function sourceLanguageName(lang: string | null): string {
  if (!lang) return "english";
  const normalized = lang.trim().toLowerCase().replace("_", "-");
  const primary = normalized.split("-")[0] ?? "";
  return LANGUAGE_NAMES[primary] ?? "english";
}

export function isMostlyChinese(text: string, lang: string | null): boolean {
  if (lang && /^(zh|chinese)/i.test(lang.trim())) return true;
  const cjk = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters > 0 && cjk / letters >= 0.3;
}

function readTranslation(result: unknown): string | null {
  if (typeof result === "string" && result.trim()) return result.trim();
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  const text = record.translated_text ?? record.translation ?? record.result;
  if (typeof text === "string" && text.trim()) return text.trim();
  return null;
}

async function runModel(runner: TranslationRunner, model: string, text: string, sourceLang: string): Promise<string | null> {
  const result = await runner.run(model, {
    text,
    source_lang: sourceLang,
    target_lang: "chinese",
  });
  return readTranslation(result);
}

/**
 * Translate into Chinese with the configured Workers AI model.
 * Returns the original text when it is already Chinese, or null when every model fails.
 */
export async function translateToChinese(
  runner: TranslationRunner,
  text: string,
  lang: string | null,
  models: TranslationModels,
): Promise<string | null> {
  const clipped = text.trim().slice(0, 1000);
  if (clipped.length === 0) return "";
  if (isMostlyChinese(clipped, lang)) return clipped;
  const sourceLang = sourceLanguageName(lang);
  try {
    const primary = await runModel(runner, models.primary, clipped, sourceLang);
    if (primary) return primary;
  } catch {
    // Fall through to the optional backup model.
  }
  if (models.fallback.length === 0 || models.fallback === models.primary) return null;
  try {
    return await runModel(runner, models.fallback, clipped, sourceLang);
  } catch {
    return null;
  }
}

export function aiRunner(ai: Ai): TranslationRunner {
  return {
    run(model, input) {
      if (model === "@cf/meta/m2m100-1.2b") {
        return ai.run("@cf/meta/m2m100-1.2b", input);
      }
      // Owner-configured fallback ids are not all in the generated model catalog.
      return ai.run(model as "owner-configured-translation-model", input);
    },
  };
}
