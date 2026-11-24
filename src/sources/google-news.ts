import { fetchSearchPage, reportSearchResult } from "./diagnostics";
import { buildNewsTermQuery, searchPlan } from "../domain/batch";
import { dedupeRecords, makeDedupeKey } from "../domain/dedupe";
import { normalizeTitle } from "../domain/gate";
import { cleanText, verifyHit } from "../domain/terms";
import type { BatchResume, CollectedRecord, QueryTarget, SearchDiagnosticContext, SearchRequest, SearchResult, SourceProvider } from "../domain/types";
import { RateLimitError } from "./x";
import { parseRetryAfter, rateAttemptIndex, retryDelaySeconds } from "./x-rate";
import { parseRssItems, type RssItem } from "./xml";

export const DEFAULT_GOOGLE_NEWS_EDITIONS = "en-US,zh-CN";
export const GOOGLE_NEWS_EDITION_LIMIT = 8;

export interface GoogleNewsEdition {
  id: string;
  hl: string;
  gl: string;
  ceid: string;
  lang: string;
}

const LANGUAGE_ONLY: Record<string, GoogleNewsEdition> = {
  ar: { id: "ar", hl: "ar", gl: "SA", ceid: "SA:ar", lang: "ar" },
  en: { id: "en-US", hl: "en-US", gl: "US", ceid: "US:en", lang: "en" },
  zh: { id: "zh-CN", hl: "zh-CN", gl: "CN", ceid: "CN:zh-Hans", lang: "zh" },
};

export function parseGoogleNewsEditions(value: string | undefined): { editions: GoogleNewsEdition[]; invalid: string[] } {
  const raw = (value ?? "").trim();
  if (!raw) return { editions: parseGoogleNewsEditions(DEFAULT_GOOGLE_NEWS_EDITIONS).editions, invalid: [] };
  const editions: GoogleNewsEdition[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,;，]+/)) {
    const token = part.trim();
    if (!token) continue;
    const edition = editionFromToken(token);
    if (!edition) {
      invalid.push(token);
      continue;
    }
    if (seen.has(edition.ceid)) continue;
    seen.add(edition.ceid);
    editions.push(edition);
    if (editions.length >= GOOGLE_NEWS_EDITION_LIMIT) break;
  }
  return { editions, invalid };
}

export function canonicalGoogleNewsEditions(value: string | undefined): string {
  const parsed = parseGoogleNewsEditions(value);
  if (parsed.editions.length === 0) return DEFAULT_GOOGLE_NEWS_EDITIONS;
  return parsed.editions.map((edition) => edition.id).join(",");
}

function editionFromToken(token: string): GoogleNewsEdition | null {
  const cleaned = token.trim().replaceAll("_", "-");
  const ceid = cleaned.match(/^([A-Za-z]{2}):([A-Za-z]{2,8}(?:-[A-Za-z0-9]+)?)$/);
  if (ceid) return fromCeid(ceid[1].toUpperCase(), ceid[2]);
  const pair = cleaned.match(/^([A-Za-z]{2,3})-([A-Za-z]{2})$/);
  if (pair) return fromLangRegion(pair[1].toLowerCase(), pair[2].toUpperCase());
  const language = cleaned.match(/^([A-Za-z]{2,3})$/);
  if (language) return LANGUAGE_ONLY[language[1].toLowerCase()] ?? null;
  return null;
}

function fromLangRegion(language: string, country: string): GoogleNewsEdition {
  if (language === "zh") {
    const traditional = country === "TW" || country === "HK" || country === "MO";
    return {
      id: `zh-${country}`,
      hl: `zh-${country}`,
      gl: country,
      ceid: `${country}:${traditional ? "zh-Hant" : "zh-Hans"}`,
      lang: "zh",
    };
  }
  return {
    id: `${language}-${country}`,
    hl: language === "ar" ? "ar" : `${language}-${country}`,
    gl: country,
    ceid: `${country}:${language}`,
    lang: language,
  };
}

function fromCeid(country: string, ceidLang: string): GoogleNewsEdition {
  if (ceidLang.toLowerCase() === "zh-hans" || (ceidLang.toLowerCase() === "zh" && country === "CN")) {
    return fromLangRegion("zh", country === "CN" ? "CN" : country);
  }
  if (ceidLang.toLowerCase() === "zh-hant") {
    const region = country === "HK" || country === "MO" ? country : "TW";
    return fromLangRegion("zh", region);
  }
  const language = ceidLang.split("-")[0]?.toLowerCase() ?? ceidLang.toLowerCase();
  return fromLangRegion(language, country);
}

export function rssItemsToRecords(
  items: RssItem[],
  request: SearchRequest,
  attribution?: { target: QueryTarget; term: string; edition?: GoogleNewsEdition },
): CollectedRecord[] {
  return items.flatMap((item) => {
    const text = cleanText([item.title, item.description].filter(Boolean).join("\n"));
    if (!item.link || !text) return [];
    const published = item.pubDate ? new Date(item.pubDate) : null;
    const publishedAt = published && !Number.isNaN(published.getTime()) ? published.toISOString() : null;
    return [{
      dedupeKey: makeDedupeKey("google_news", null, item.link),
      source: "google_news" as const,
      externalId: null,
      url: item.link,
      countryName: request.countryName,
      matchedTargetId: attribution?.target.id ?? null,
      matchedTarget: attribution?.target.name ?? "批次未精确命中",
      matchedTerm: attribution?.term ?? null,
      authorHandle: "",
      authorName: item.source,
      authorUrl: "",
      text,
      publishedAt,
      sourceLang: attribution?.edition?.lang ?? null,
      newsEdition: attribution?.edition?.id ?? null,
    }];
  });
}

export function mergeNewsRecords(records: CollectedRecord[]): CollectedRecord[] {
  const merged: CollectedRecord[] = [];
  const titleIndex = new Map<string, number>();
  for (const record of dedupeRecords(records)) {
    const title = normalizeTitle(record.text);
    if (title.length >= 8) {
      const existing = titleIndex.get(title);
      if (existing !== undefined) {
        const current = merged[existing];
        if ((record.matchedTerm?.length ?? 0) > (current.matchedTerm?.length ?? 0)) merged[existing] = record;
        continue;
      }
      titleIndex.set(title, merged.length);
    }
    merged.push(record);
  }
  return merged;
}

/** 同一条连续失败这么多次后，先试下一条，确认是不是只有这一条卡住。 */
const NEWS_STICKY_FAILURES = 3;

function newsResume(step: number, parkedSteps: number[]): BatchResume {
  const parked = [...new Set(parkedSteps.filter((item) => item !== step))];
  return {
    source: "google_news",
    step,
    page: 0,
    cursor: "",
    ...(parked.length > 0 ? { parkedSteps: parked } : {}),
  };
}

export const googleNewsProvider: SourceProvider = {
  id: "google_news",
  async search(request: SearchRequest): Promise<SearchResult> {
    const editions = parseGoogleNewsEditions(request.googleNewsEditions).editions;
    const records: CollectedRecord[] = [];
    let calls = 0;
    let filtered = 0;
    const plan = searchPlan(request.targets).flatMap((step) => editions.map((edition) => ({ step, edition })));
    const resume = request.resume?.source === "google_news" ? request.resume : null;
    let stepIndex = resume?.step ?? 0;
    let parked = (resume?.parkedSteps ?? []).filter((step) => Number.isInteger(step) && step >= 0 && step < plan.length);
    let rateHold = resume?.rateHold === true;
    let consecutive = rateAttemptIndex(request.rateAttempt ?? resume?.rateAttempts);

    const queryFor = (index: number) => {
      const item = plan[index];
      if (!item) return "";
      return buildNewsTermQuery(item.step.target, item.step.term, request.window);
    };
    const nextQueryable = (from: number) => {
      for (let index = from; index < plan.length; index += 1) {
        if (queryFor(index)) return index;
      }
      return null;
    };

    async function pull(index: number): Promise<
      | { status: "ok"; records: CollectedRecord[]; raw: number; diagnostic: SearchDiagnosticContext }
      | { status: "limited"; httpStatus: number; retryAfterSeconds: number | null; diagnostic: SearchDiagnosticContext }
    > {
      const { step, edition } = plan[index];
      const query = queryFor(index);
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", query);
      url.searchParams.set("hl", edition.hl);
      url.searchParams.set("gl", edition.gl);
      url.searchParams.set("ceid", edition.ceid);
      const diagnostic: SearchDiagnosticContext = {
        matchMode: step.target.matchMode ?? "phrase",
        targetId: step.target.id,
        terms: [step.term],
        query,
        step: index,
        page: 0,
        edition: edition.id,
      };
      const response = await fetchSearchPage(request, diagnostic, url);
      calls += 1;
      if (response.status === 429 || response.status === 503) {
        return {
          status: "limited",
          httpStatus: response.status,
          retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After"), Date.now()),
          diagnostic,
        };
      }
      if (!response.ok) throw new Error(`Google News RSS ${response.status}`);
      const xml = await response.text();
      const pageRecords: CollectedRecord[] = [];
      const items = parseRssItems(xml);
      for (const item of items) {
        let converted: CollectedRecord[] = [];
        try {
          converted = rssItemsToRecords([item], request, { target: step.target, term: step.term, edition });
        } catch {
          filtered += 1;
          continue;
        }
        for (const record of converted) {
          const verdict = verifyHit({
            text: record.text,
            authorHandle: record.authorHandle,
            target: step.target,
            queriedTerm: step.term,
          });
          if (!verdict.ok || !verdict.term) {
            filtered += 1;
            continue;
          }
          pageRecords.push({ ...record, matchedTerm: verdict.term });
        }
      }
      await reportSearchResult(request, diagnostic, items.length, pageRecords.length);
      return { status: "ok", records: pageRecords, raw: items.length, diagnostic };
    }

    async function publish(index: number, pageRecords: CollectedRecord[], diagnostic: SearchDiagnosticContext, nextStep: number) {
      const repeatResume = newsResume(index, parked);
      const nextResume = newsResume(nextStep, parked);
      if (request.onPage) {
        await request.onPage({ diagnostic, records: pageRecords, resume: nextResume, repeatResume, calls, filtered });
      } else {
        records.push(...pageRecords);
      }
    }

    function hold(httpStatus: number, retryAfterSeconds: number | null, rateHoldNext: boolean): never {
      throw new RateLimitError(`Google News RSS 限流 ${httpStatus}`, {
        delaySeconds: retryDelaySeconds({ attempt: Math.max(0, consecutive - 1), retryAfterSeconds }),
        retryAfterSeconds,
        rateAttempts: consecutive,
        rateHold: rateHoldNext,
      });
    }

    for (; stepIndex < plan.length; stepIndex += 1) {
      if (!queryFor(stepIndex)) continue;
      const outcome = await pull(stepIndex);
      if (outcome.status === "limited") {
        consecutive += 1;
        const probeAt = !rateHold && outcome.retryAfterSeconds == null && consecutive >= NEWS_STICKY_FAILURES
          ? nextQueryable(stepIndex + 1)
          : null;
        if (probeAt != null) {
          const probe = await pull(probeAt);
          if (probe.status === "ok") {
            parked = [...new Set([...parked, stepIndex])];
            consecutive = 0;
            rateHold = false;
            await publish(probeAt, probe.records, probe.diagnostic, probeAt + 1);
            stepIndex = probeAt;
            continue;
          }
          rateHold = true;
          hold(outcome.httpStatus, outcome.retryAfterSeconds, true);
        }
        hold(outcome.httpStatus, outcome.retryAfterSeconds, rateHold);
      }
      consecutive = 0;
      rateHold = false;
      await publish(stepIndex, outcome.records, outcome.diagnostic, stepIndex + 1);
    }

    for (const parkedStep of [...parked]) {
      if (!queryFor(parkedStep)) continue;
      const outcome = await pull(parkedStep);
      parked = parked.filter((step) => step !== parkedStep);
      if (outcome.status === "ok") {
        await publish(parkedStep, outcome.records, outcome.diagnostic, plan.length);
        continue;
      }
      await request.onDiagnostic?.({
        ...outcome.diagnostic,
        event: "skipped",
        status: outcome.httpStatus,
        reason: "这条检索连续失败，其余检索已完成，本轮先跳过",
      });
      if (request.onPage) {
        await publish(parkedStep, [], outcome.diagnostic, plan.length);
      }
    }
    return { records: mergeNewsRecords(records), calls, filtered };
  },
};
