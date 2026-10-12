export interface AppConfig {
  xProvider: string;
  webProviders: string[];
  emailProvider: "cloudflare" | "resend";
  emailFrom: string;
  publicBaseUrl: string;
  translationModel: string;
  translationFallbackModel: string;
  excelObjectKey: string;
  batchMaxTerms: number;
  batchMaxQueryChars: number;
  maxSearchPages: number;
  maxWebResults: number;
  xQuerySuffix: string;
  xMaxQueryChars: number;
  newsHl: string;
  newsGl: string;
  newsCeid: string;
  downloadTtlSeconds: number;
  finalizeDelaySeconds: number;
  deadlineMinAgeSeconds: number;
  finalizeLeaseSeconds: number;
  maxTranslationsPerBatch: number;
  maxTranslationsOnFinalize: number;
  maxExcelRows: number;
}

/** Widen Wrangler's literal var types so operators stay valid if the owner edits wrangler.jsonc. */
function setting(value: string): string {
  return value;
}

function emailProviderOf(value: string): "cloudflare" | "resend" {
  if (value === "cloudflare" || value === "resend") return value;
  throw new Error("invalid_email_provider");
}

function intVar(raw: string, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readConfig(env: Env): AppConfig {
  const web = setting(env.WEB_PROVIDER);
  let webProviders: string[];
  if (web === "both") webProviders = ["google_news", "gdelt"];
  else if (web === "google_news" || web === "gdelt") webProviders = [web];
  else throw new Error("invalid_web_provider");

  const emailProvider = emailProviderOf(setting(env.EMAIL_PROVIDER));

  const excelObjectKey = env.EXCEL_OBJECT_KEY.trim() || "skyeyes.xlsx";
  if (!/^[A-Za-z0-9._-]+$/.test(excelObjectKey)) {
    throw new Error("invalid_excel_object_key");
  }

  return {
    xProvider: env.X_PROVIDER.trim() || "twitterapi_io",
    webProviders,
    emailProvider,
    emailFrom: env.EMAIL_FROM.trim(),
    publicBaseUrl: env.PUBLIC_BASE_URL.trim().replace(/\/+$/, ""),
    translationModel: env.TRANSLATION_MODEL.trim() || "@cf/meta/m2m100-1.2b",
    translationFallbackModel: env.TRANSLATION_FALLBACK_MODEL.trim(),
    excelObjectKey,
    batchMaxTerms: intVar(env.BATCH_MAX_TERMS, 12, 1, 50),
    batchMaxQueryChars: intVar(env.BATCH_MAX_QUERY_CHARS, 400, 32, 2000),
    maxSearchPages: intVar(env.MAX_SEARCH_PAGES, 5, 1, 20),
    maxWebResults: intVar(env.MAX_WEB_RESULTS, 50, 1, 250),
    xQuerySuffix: env.X_QUERY_SUFFIX.trim(),
    xMaxQueryChars: intVar(env.X_MAX_QUERY_CHARS, 900, 64, 2000),
    newsHl: env.NEWS_HL.trim() || "en-US",
    newsGl: env.NEWS_GL.trim() || "US",
    newsCeid: env.NEWS_CEID.trim() || "US:en",
    downloadTtlSeconds: intVar(env.DOWNLOAD_TTL_SECONDS, 604800, 300, 2_592_000),
    finalizeDelaySeconds: intVar(env.FINALIZE_DELAY_SECONDS, 3600, 60, 86_400),
    deadlineMinAgeSeconds: intVar(env.DEADLINE_MIN_AGE_SECONDS, 3000, 0, 86_400),
    finalizeLeaseSeconds: intVar(env.FINALIZE_LEASE_SECONDS, 180, 30, 3600),
    maxTranslationsPerBatch: intVar(env.MAX_TRANSLATIONS_PER_BATCH, 25, 0, 100),
    maxTranslationsOnFinalize: intVar(env.MAX_TRANSLATIONS_ON_FINALIZE, 80, 0, 300),
    maxExcelRows: intVar(env.MAX_EXCEL_ROWS, 20_000, 100, 50_000),
  };
}

export function providerPlans(config: AppConfig): { id: string; source: "x" | "web" }[] {
  return [
    { id: config.xProvider, source: "x" },
    ...config.webProviders.map((id) => ({ id, source: "web" as const })),
  ];
}
