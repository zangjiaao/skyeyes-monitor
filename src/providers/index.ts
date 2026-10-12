import type { AppConfig } from "../config";
import { ProviderError } from "../errors";
import { GdeltProvider } from "./gdelt";
import { GoogleNewsProvider } from "./google-news";
import { TwitterApiProvider } from "./twitterapi";
import type { ContentProvider } from "./types";

/**
 * Register a new source here and select it with X_PROVIDER or WEB_PROVIDER.
 * Providers receive already-batched OR queries; they do not know the private
 * target list beyond the phrases in that query.
 */
export function createProvider(env: Env, config: AppConfig, providerId: string): ContentProvider {
  switch (providerId) {
    case "twitterapi_io":
      return new TwitterApiProvider(env.TWITTERAPI_IO_KEY, config);
    case "google_news":
      return new GoogleNewsProvider(config);
    case "gdelt":
      return new GdeltProvider(config);
    default:
      throw new ProviderError("unknown_provider", false);
  }
}
