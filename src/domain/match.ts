import type { QueryTarget } from "./types";

export function matchTarget(
  text: string,
  authorHandle: string,
  targets: QueryTarget[],
): QueryTarget | null {
  const handle = authorHandle.replace(/^@/, "").toLowerCase();
  if (handle) {
    for (const target of targets) {
      if (target.kind !== "handle") continue;
      const query = target.query.replace(/^@/, "").toLowerCase();
      if (query && query === handle) return target;
    }
  }
  const haystack = text.toLowerCase();
  for (const target of targets) {
    const query = target.query.replace(/^@/, "").replace(/"/g, "").trim().toLowerCase();
    if (query && haystack.includes(query)) return target;
    if (target.name.trim() && haystack.includes(target.name.trim().toLowerCase())) return target;
  }
  return null;
}
