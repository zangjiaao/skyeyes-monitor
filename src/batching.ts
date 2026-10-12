export interface BatchOptions {
  maxTerms: number;
  maxQueryChars: number;
}

export interface BatchableTarget {
  id: number;
  query: string;
}

export interface ProviderPlan {
  id: string;
  source: "x" | "web";
}

export interface PlannedBatch {
  id: string;
  countryId: number;
  source: "x" | "web";
  providerId: string;
  targetIds: number[];
}

const SIMPLE_TERM = /^[^\s"()]+$/;

/**
 * A target query is one phrase. Tokens without spaces stay bare so values like
 * `from:example` keep operator syntax; everything else is quoted.
 */
export function quoteSearchTerm(term: string): string {
  const trimmed = term.trim();
  if (trimmed.length === 0) return '""';
  if (SIMPLE_TERM.test(trimmed) && !/^(OR|AND)$/i.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/"/g, " ")}"`;
}

export function buildOrQuery(terms: readonly string[]): string {
  return terms.map((term) => quoteSearchTerm(term)).join(" OR ");
}

export function batchTargets<T extends BatchableTarget>(targets: readonly T[], options: BatchOptions): T[][] {
  if (!Number.isInteger(options.maxTerms) || options.maxTerms < 1) {
    throw new Error("maxTerms must be a positive integer");
  }
  if (!Number.isInteger(options.maxQueryChars) || options.maxQueryChars < 1) {
    throw new Error("maxQueryChars must be a positive integer");
  }
  const batches: T[][] = [];
  let current: T[] = [];
  for (const target of targets) {
    const candidate = [...current, target];
    const chars = buildOrQuery(candidate.map((item) => item.query)).length;
    const overflows = current.length > 0 && (candidate.length > options.maxTerms || chars > options.maxQueryChars);
    if (overflows) {
      batches.push(current);
      current = [target];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function planCountryBatches(
  countries: readonly { id: number; targets: readonly BatchableTarget[] }[],
  providers: readonly ProviderPlan[],
  options: BatchOptions,
  idFactory: () => string,
): PlannedBatch[] {
  const planned: PlannedBatch[] = [];
  for (const country of countries) {
    const usable = country.targets.filter((target) => target.query.trim().length > 0);
    if (usable.length === 0) continue;
    const groups = batchTargets(usable, options);
    for (const provider of providers) {
      for (const group of groups) {
        planned.push({
          id: idFactory(),
          countryId: country.id,
          source: provider.source,
          providerId: provider.id,
          targetIds: group.map((target) => target.id),
        });
      }
    }
  }
  return planned;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Attribute a hit to the targets whose name or query appears in the text.
 * When nothing matches precisely, keep every target in the batch so the row
 * still records why it was collected.
 */
export function matchTargetNames(text: string, targets: readonly { name: string; query: string }[]): string {
  const haystack = text.toLowerCase();
  const precise = targets.filter((target) => {
    const query = target.query.trim().toLowerCase().replace(/^@/, "");
    const name = target.name.trim().toLowerCase();
    if (query.length >= 2 && haystack.includes(query)) return true;
    if (name.length >= 2 && name !== query && haystack.includes(name)) return true;
    return false;
  });
  const chosen = precise.length > 0 ? precise : targets;
  return chosen
    .map((target) => target.name.trim())
    .filter((name) => name.length > 0)
    .join(" | ");
}
