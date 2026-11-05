import { packGdeltQueries, searchPlan } from "../domain/batch";
import type { QueryTarget, SourceId } from "../domain/types";
import { parseGoogleNewsEditions } from "../sources/google-news";

export function queryCount(source: SourceId, targets: QueryTarget[], editions: string): number {
  if (source === "gdelt") return targets.reduce((sum, target) => sum + packGdeltQueries(target).length, 0);
  const terms = searchPlan(targets).length;
  return source === "google_news" ? terms * parseGoogleNewsEditions(editions).editions.length : terms;
}
