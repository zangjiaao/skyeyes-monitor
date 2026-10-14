import { termsOf, verifyHit } from "./terms";
import type { QueryTarget } from "./types";

export function matchTarget(
  text: string,
  authorHandle: string,
  targets: QueryTarget[],
): QueryTarget | null {
  let best: { target: QueryTarget; term: string } | null = null;
  for (const target of targets) {
    for (const term of termsOf(target)) {
      const verdict = verifyHit({ text, authorHandle, target, queriedTerm: term });
      if (!verdict.ok || !verdict.term) continue;
      if (!best || verdict.term.length > best.term.length) best = { target, term: verdict.term };
    }
  }
  return best?.target ?? null;
}
