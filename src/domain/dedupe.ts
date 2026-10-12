export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.hostname !== "news.google.com") {
      const kept = new URLSearchParams();
      for (const [key, value] of parsed.searchParams) {
        if (!key.toLowerCase().startsWith("utm_")) kept.append(key, value);
      }
      const query = kept.toString();
      parsed.search = query ? `?${query}` : "";
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return trimmed;
  }
}

export function makeDedupeKey(
  source: string,
  externalId: string | null | undefined,
  url: string,
): string {
  const id = externalId?.trim();
  if (id) return `${source}:id:${id}`;
  return `${source}:url:${normalizeUrl(url)}`;
}

export function dedupeRecords<T extends { dedupeKey: string; url: string; source: string }>(
  records: T[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const record of records) {
    const urlKey = `${record.source}:url:${normalizeUrl(record.url)}`;
    if (seen.has(record.dedupeKey) || seen.has(urlKey)) continue;
    seen.add(record.dedupeKey);
    seen.add(urlKey);
    unique.push(record);
  }
  return unique;
}
