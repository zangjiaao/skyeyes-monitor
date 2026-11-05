import type { SearchDiagnosticContext, SearchRequest } from "../domain/types";

/** Log query context, never request headers, API keys, response bodies or cursors. */
export async function fetchSearchPage(
  request: SearchRequest,
  context: SearchDiagnosticContext,
  url: URL,
  init?: RequestInit,
): Promise<Response> {
  if (request.beforeRequest) await request.beforeRequest();
  request.onDiagnostic?.({ ...context, event: "request" });
  const started = Date.now();
  try {
    const response = await request.fetchImpl(url, init);
    request.onDiagnostic?.({
      ...context, event: "response", status: response.status, elapsedMs: Date.now() - started,
    });
    return response;
  } catch (error) {
    request.onDiagnostic?.({
      ...context, event: "error", elapsedMs: Date.now() - started,
      // Fetch errors can contain URLs or headers; retain only the error type.
      error: error instanceof Error ? error.name : "FetchError",
    });
    throw error;
  }
}

export function reportSearchResult(
  request: SearchRequest,
  context: SearchDiagnosticContext,
  rawItems: number,
  matchedItems: number,
): void {
  request.onDiagnostic?.({
    ...context, event: "result", rawItems, matchedItems, rejectedItems: rawItems - matchedItems,
  });
}
