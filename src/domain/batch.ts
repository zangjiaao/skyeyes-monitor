import { termsOf } from "./terms";
import type { QueryTarget, TimeWindow } from "./types";

export const MAX_QUERY_CHARS = 450;

export interface SearchStep {
  target: QueryTarget;
  term: string;
}

export function searchPlan(targets: QueryTarget[]): SearchStep[] {
  const plan: SearchStep[] = [];
  for (const target of targets) {
    for (const term of termsOf(target)) plan.push({ target, term });
  }
  return plan;
}

export function clauseForTerm(target: QueryTarget, term: string): string {
  const raw = term.trim().replace(/^@/, "").replace(/"/g, "");
  if (!raw) return "";
  if (target.kind === "handle") {
    const handle = raw.replace(/[^A-Za-z0-9_]/g, "");
    return handle ? `from:${handle}` : "";
  }
  return `"${raw}"`;
}

export function clauseForTarget(target: QueryTarget): string {
  return clauseForTerm(target, termsOf(target)[0] ?? target.query);
}

function excludeClauses(target: QueryTarget): string[] {
  return (target.excludeTerms ?? [])
    .map((term) => term.trim().replace(/"/g, ""))
    .filter(Boolean)
    .map((term) => `-"${term}"`);
}

export function batchTargets<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function batchTargetsForQuery(targets: QueryTarget[]): QueryTarget[][] {
  return targets.filter((target) => termsOf(target).length > 0).map((target) => [target]);
}

export function buildXTermQuery(
  target: QueryTarget,
  term: string,
  window: TimeWindow,
  options?: { excludeRetweets?: boolean },
): string {
  const clause = clauseForTerm(target, term);
  if (!clause) return "";
  const since = Math.floor(window.start.getTime() / 1000);
  const until = Math.floor(window.end.getTime() / 1000);
  const parts = [clause, ...excludeClauses(target), `since_time:${since}`, `until_time:${until}`];
  if (options?.excludeRetweets !== false) parts.push("-is:retweet");
  return parts.join(" ");
}

export function buildNewsTermQuery(target: QueryTarget, term: string, window: TimeWindow): string {
  const raw = term.trim().replace(/^@/, "").replace(/"/g, "");
  if (!raw) return "";
  const after = window.start.toISOString().slice(0, 10);
  const beforeDate = new Date(window.end.getTime() + 24 * 60 * 60 * 1000);
  const before = beforeDate.toISOString().slice(0, 10);
  return [`"${raw}"`, ...excludeClauses(target), `after:${after}`, `before:${before}`].join(" ");
}

function gdeltQuote(term: string): string {
  const raw = term.trim().replace(/^@/, "").replace(/"/g, "");
  return raw ? `"${raw}"` : "";
}

function gdeltExcludes(target: QueryTarget): string[] {
  return (target.excludeTerms ?? [])
    .map((item) => item.trim().replace(/"/g, ""))
    .filter(Boolean)
    .map((item) => `NOT "${item}"`);
}

export function buildGdeltTermQuery(target: QueryTarget, term: string): string {
  const quoted = gdeltQuote(term);
  if (!quoted) return "";
  return [quoted, ...gdeltExcludes(target)].join(" ");
}

export interface GdeltQueryGroup {
  query: string;
  terms: string[];
}

export function buildGdeltOrQuery(target: QueryTarget, terms: string[]): string {
  const quoted = terms.map(gdeltQuote).filter(Boolean);
  if (quoted.length === 0) return "";
  const body = quoted.length === 1 ? quoted[0] : `(${quoted.join(" OR ")})`;
  return [body, ...gdeltExcludes(target)].join(" ");
}

export function packGdeltQueries(target: QueryTarget, maxChars = MAX_QUERY_CHARS): GdeltQueryGroup[] {
  const terms = termsOf(target).map((term) => term.trim()).filter((term) => gdeltQuote(term));
  const groups: GdeltQueryGroup[] = [];
  let current: string[] = [];
  for (const term of terms) {
    const next = [...current, term];
    const query = buildGdeltOrQuery(target, next);
    if (current.length > 0 && query.length > maxChars) {
      groups.push({ query: buildGdeltOrQuery(target, current), terms: current });
      current = [term];
      continue;
    }
    current = next;
  }
  if (current.length > 0) {
    groups.push({ query: buildGdeltOrQuery(target, current), terms: current });
  }
  return groups.filter((group) => group.query);
}
