import { ProviderError } from "../errors";

const MAX_BODY_CHARS = 2_000_000;

export async function fetchBounded(url: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", "SkyEyesMonitor/0.1");
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (body.length > MAX_BODY_CHARS) throw new ProviderError("response_too_large", false);
  return { status: response.status, body };
}

export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const { status, body } = await fetchBounded(url, init);
  if (status < 200 || status >= 300) {
    throw new ProviderError(`http_${status}`, retryableStatus(status));
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderError("invalid_json", false);
  }
}
