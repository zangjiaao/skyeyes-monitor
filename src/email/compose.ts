import { calendarKey, formatInZone, utcOffsetLabel } from "../domain/time";

export interface DigestCountry {
  name: string;
  added: number;
  bySource: Record<string, number>;
}

export interface DigestInput {
  incomplete: boolean;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  countries: DigestCountry[];
  failedBatches: number;
  downloadUrl: string | null;
  attached: boolean;
  notes: string;
  highlights?: Array<{ target: string; summary: string; translation: string; score: string }>;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const SOURCE_LABEL: Record<string, string> = {
  x: "X",
  google_news: "Google News",
  gdelt: "GDELT",
};

function formatWindowInstant(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatInZone(date, timeZone);
}

export function buildDigest(input: DigestInput): { subject: string; text: string; html: string } {
  const total = input.countries.reduce((sum, country) => sum + country.added, 0);
  const end = new Date(input.windowEnd);
  const day = Number.isNaN(end.getTime()) ? input.windowEnd.slice(0, 10) : calendarKey(end, input.timeZone);
  const zoneLabel = Number.isNaN(end.getTime())
    ? input.timeZone
    : `${input.timeZone}, ${utcOffsetLabel(end, input.timeZone)}`;
  const subject = input.incomplete
    ? `SkyEyes 每日监测 ${day}（部分批次未完成）`
    : `SkyEyes 每日监测 ${day}`;
  const lines = [
    `SkyEyes 每日监测`,
    `时区: ${input.timeZone}`,
    `窗口: ${formatWindowInstant(input.windowStart, input.timeZone)} 至 ${formatWindowInstant(input.windowEnd, input.timeZone)}（${zoneLabel}）`,
    `窗口内实际发布且通过过滤: ${total}`,
    "",
    ...input.countries.map((country) => {
      const parts = Object.entries(country.bySource)
        .map(([source, count]) => `${SOURCE_LABEL[source] ?? source} ${count}`)
        .join("，");
      return `- ${country.name}: 新增 ${country.added}${parts ? `（${parts}）` : ""}`;
    }),
    "",
    `失败批次: ${input.failedBatches}`,
    input.incomplete ? "本轮在截止时间前仍有批次未完成，邮件里是目前已经入库的内容。" : "本轮批次已全部结束。",
    input.attached
      ? "附件 skyeyes.xlsx 会覆盖更新。分组表是已通过时间校验的历史；「今日」「昨日」只按发布时间落入计划窗口的条目，不含缺时间、窗口外、旧文重发、规则过滤或低相关度的内容。"
      : "Excel 较大，未放入附件。",
  ];
  const highlights = (input.highlights ?? []).slice(0, 12);
  if (highlights.length > 0) {
    lines.push("", "本轮条目（摘要 / 译文 / 相关度）:");
    for (const item of highlights) {
      const summary = item.summary || item.translation || "无摘要";
      lines.push(`- ${item.target}: ${summary}（译文：${item.translation || "无"}；相关度 ${item.score || "—"}）`);
    }
  }
  if (input.downloadUrl) lines.push(`下载: ${input.downloadUrl}`);
  if (input.notes) lines.push("", input.notes);
  const text = lines.join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.5">${lines
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("")}</div>`;
  return { subject, text, html };
}
