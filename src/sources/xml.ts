function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u0000/g, "")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

export function stripTags(value: string): string {
  return decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 链接元素里经常跟着查询参数或多余文字，只取第一条 http(s) 地址。 */
export function firstHttpUrl(value: string): string {
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return match[0].replace(/[),.;]+$/, "");
}

export interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  source: string;
}

export function parseRssItems(xml: string): RssItem[] {
  return xml
    .split(/<item\b[^>]*>/i)
    .slice(1)
    .map((chunk) => {
      const body = chunk.split(/<\/item>/i)[0] ?? "";
      return {
        title: stripTags(tag(body, "title")),
        link: firstHttpUrl(tag(body, "link") || tag(body, "guid")),
        pubDate: tag(body, "pubDate"),
        description: stripTags(tag(body, "description")),
        source: stripTags(tag(body, "source")),
      };
    })
    .filter((item) => item.link);
}
