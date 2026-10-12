import type { QueryTarget, TimeWindow } from "./types";

export const MAX_QUERY_CHARS = 450;

export function clauseForTarget(target: QueryTarget): string {
  const raw = target.query.trim().replace(/^@/, "").replace(/"/g, "");
  if (!raw) return "";
  if (target.kind === "handle") {
    const handle = raw.replace(/[^A-Za-z0-9_]/g, "");
    return handle ? `from:${handle}` : "";
  }
  return `"${raw}"`;
}

export function batchTargets<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function batchTargetsForQuery(
  targets: QueryTarget[],
  batchSize: number,
  maxChars = MAX_QUERY_CHARS,
): QueryTarget[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: QueryTarget[][] = [];
  let current: QueryTarget[] = [];
  let currentLen = 0;

  for (const target of targets) {
    const clause = clauseForTarget(target);
    if (!clause) continue;
    const extra = current.length === 0 ? clause.length : clause.length + 4;
    if (current.length > 0 && (current.length >= size || currentLen + extra > maxChars)) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(target);
    currentLen += current.length === 1 ? clause.length : clause.length + 4;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function buildCombinedQuery(targets: QueryTarget[]): string {
  const clauses = targets.map(clauseForTarget).filter(Boolean);
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return clauses[0];
  return `(${clauses.join(" OR ")})`;
}

export function buildXQuery(
  targets: QueryTarget[],
  window: TimeWindow,
  options?: { excludeRetweets?: boolean },
): string {
  const combined = buildCombinedQuery(targets);
  if (!combined) return "";
  const since = Math.floor(window.start.getTime() / 1000);
  const until = Math.floor(window.end.getTime() / 1000);
  const retweet = options?.excludeRetweets === false ? "" : " -is:retweet";
  return `${combined} since_time:${since} until_time:${until}${retweet}`;
}

export function buildNewsQuery(targets: QueryTarget[], window: TimeWindow): string {
  const combined = buildCombinedQuery(targets);
  if (!combined) return "";
  const after = window.start.toISOString().slice(0, 10);
  const beforeDate = new Date(window.end.getTime() + 24 * 60 * 60 * 1000);
  const before = beforeDate.toISOString().slice(0, 10);
  return `${combined} after:${after} before:${before}`;
}

export function buildGdeltQuery(targets: QueryTarget[]): string {
  const clauses = targets
    .map((target) => {
      const raw = target.query.trim().replace(/^@/, "").replace(/"/g, "");
      return raw;
    })
    .filter(Boolean);
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return `"${clauses[0]}"`;
  return clauses.map((clause) => `"${clause}"`).join(" OR ");
}
