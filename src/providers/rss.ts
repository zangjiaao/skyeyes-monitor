export function decodeXml(value: string): string {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return withoutCdata
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string | null;
  sourceName: string;
  sourceUrl: string;
}

function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match?.[1]) return "";
  return decodeXml(match[1]);
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const pattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const match of xml.matchAll(pattern)) {
    const block = match[1] ?? "";
    const source = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(block);
    const sourceUrl = source ? decodeXml(/url="([^"]*)"/i.exec(source[1] ?? "")?.[1] ?? "") : "";
    const link = tagText(block, "link") || tagText(block, "guid");
    const title = tagText(block, "title");
    if (!link || !title) continue;
    const pubRaw = tagText(block, "pubDate");
    const pubMs = pubRaw ? Date.parse(pubRaw) : Number.NaN;
    items.push({
      title,
      link,
      pubDate: Number.isNaN(pubMs) ? null : new Date(pubMs).toISOString(),
      sourceName: source ? decodeXml(source[2] ?? "") : "",
      sourceUrl,
    });
  }
  return items;
}

export function parseGdeltStamp(value: string): string | null {
  const compact = value.trim().replace(/[^0-9]/g, "");
  if (compact.length < 8) return null;
  const year = compact.slice(0, 4);
  const month = compact.slice(4, 6);
  const day = compact.slice(6, 8);
  const hours = compact.slice(8, 10) || "00";
  const minutes = compact.slice(10, 12) || "00";
  const seconds = compact.slice(12, 14) || "00";
  const iso = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`;
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
