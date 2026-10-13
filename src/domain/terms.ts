import type { QueryTarget } from "./types";

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

export function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

export function splitLines(value: string | null | undefined): string[] {
  if (!value) return [];
  return uniqueTerms(value.split(/\r?\n/));
}

export function splitImportTerms(value: string | null | undefined): string[] {
  if (!value) return [];
  return uniqueTerms(value.split(/\r?\n|\|/));
}

export function termsOf(target: { query?: string | null; terms?: string[] | null }): string[] {
  const listed = uniqueTerms(target.terms ?? []);
  if (listed.length > 0) return listed;
  return splitLines(target.query);
}

export function containsCjk(value: string): boolean {
  return CJK.test(value);
}

export function isShortAcronym(term: string): boolean {
  return /^[A-Za-z]{2,5}$/.test(term);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function termMatches(text: string, term: string, caseSensitive: boolean): boolean {
  const needle = term.trim();
  if (!needle || !text) return false;
  if (containsCjk(needle)) return text.includes(needle);
  const sensitive = caseSensitive || isShortAcronym(needle);
  const flags = sensitive ? "" : "i";
  const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, flags);
  return pattern.test(text);
}

export interface HitVerdict {
  ok: boolean;
  term: string | null;
}

export function verifyHit(input: {
  text: string;
  authorHandle: string;
  target: QueryTarget;
  queriedTerm: string;
}): HitVerdict {
  const sensitive = Boolean(input.target.caseSensitive);
  const excludes = input.target.excludeTerms ?? [];
  if (excludes.some((term) => termMatches(input.text, term, sensitive))) {
    return { ok: false, term: null };
  }
  const handle = input.authorHandle.trim().replace(/^@/, "");
  const terms = termsOf(input.target);
  if (input.target.kind === "handle" && handle) {
    const authored = terms.find((term) => term.trim().replace(/^@/, "").toLowerCase() === handle.toLowerCase());
    if (authored) return { ok: true, term: authored.trim().replace(/^@/, "") };
  }
  if (termMatches(input.text, input.queriedTerm, sensitive)) {
    return { ok: true, term: input.queriedTerm };
  }
  const others = terms
    .filter((term) => term !== input.queriedTerm && termMatches(input.text, term, sensitive))
    .sort((left, right) => right.length - left.length);
  if (others.length === 0) return { ok: false, term: null };
  return { ok: true, term: others[0] };
}

export function assertTermList(terms: string[], label: string, allowEmpty = false): string[] {
  if (!allowEmpty && terms.length === 0) throw new Error(`${label}不能为空`);
  if (terms.length > 30) throw new Error(`${label}最多 30 个`);
  for (const term of terms) {
    if (term.length > 200) throw new Error(`${label}每一项不能超过 200 字`);
  }
  return terms;
}

export function cleanText(value: string): string {
  return value.replace(/\u0000/g, "");
}

export function joinTerms(terms: string[]): string {
  return uniqueTerms(terms).join("\n");
}

export function termsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueTerms(value.map((item) => String(item ?? "")));
  if (typeof value === "string") return splitImportTerms(value);
  return [];
}

export function flagEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["1", "true", "yes", "y"].includes(value.trim().toLowerCase());
  return false;
}
