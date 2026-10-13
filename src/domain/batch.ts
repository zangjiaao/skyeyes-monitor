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

export function buildGdeltTermQuery(target: QueryTarget, term: string): string {
  const raw = term.trim().replace(/^@/, "").replace(/"/g, "");
  if (!raw) return "";
  const excludes = (target.excludeTerms ?? [])
    .map((item) => item.trim().replace(/"/g, ""))
    .filter(Boolean)
    .map((item) => `NOT "${item}"`);
  return [`"${raw}"`, ...excludes].join(" ");
}
