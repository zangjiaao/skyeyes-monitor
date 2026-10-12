import type { SourceId, SourceProvider } from "../domain/types";
import { gdeltProvider } from "./gdelt";
import { googleNewsProvider } from "./google-news";
import { xProvider } from "./x";

export const PROVIDERS: Record<SourceId, SourceProvider> = {
  x: xProvider,
  google_news: googleNewsProvider,
  gdelt: gdeltProvider,
};

export function getProvider(id: SourceId): SourceProvider {
  return PROVIDERS[id];
}
