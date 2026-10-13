export function normalizeUrl(url: string): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim().replace(/\u0000/g, "");
  const article = trimmed.match(/https?:\/\/news\.google\.com\/(?:rss\/)?articles\/([^/?#\s]+)/i);
  if (article?.[1]) return `https://news.google.com/rss/articles/${article[1]}`;
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
  const id = typeof externalId === "string" ? externalId.trim() : "";
  if (id) return `${source}:id:${id}`;
  return `${source}:url:${normalizeUrl(url)}`;
}

export function dedupeRecords<T extends {
  dedupeKey: string;
  url?: string | null;
  source: string;
  matchedTerm?: string | null;
}>(records: T[]): T[] {
  const unique: T[] = [];
  const indexByKey = new Map<string, number>();
  for (const record of records) {
    if (!record || typeof record.url !== "string" || !record.url.trim() || typeof record.dedupeKey !== "string") {
      continue;
    }
    let canonical = "";
    try {
      canonical = `${record.source}:url:${normalizeUrl(record.url)}`;
    } catch {
      continue;
    }
    const keys = [record.dedupeKey, canonical];
    const existingIndex = keys.map((key) => indexByKey.get(key)).find((index) => index !== undefined);
    if (existingIndex === undefined) {
      const index = unique.length;
      unique.push(record);
      for (const key of keys) indexByKey.set(key, index);
      continue;
    }
    const current = unique[existingIndex];
    if ((record.matchedTerm?.length ?? 0) > (current.matchedTerm?.length ?? 0)) {
      unique[existingIndex] = record;
    }
    for (const key of keys) indexByKey.set(key, existingIndex);
  }
  return unique;
}
