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

const SOURCE_SUMMARY_LIMIT = 80;

function sourceSuffix(bySource: Record<string, number>): string {
  const parts = Object.entries(bySource)
    .map(([source, count]) => `${SOURCE_LABEL[source] ?? source} ${count}`)
    .join("，");
  if (!parts || parts.length > SOURCE_SUMMARY_LIMIT) return "";
  return `（${parts}）`;
}

export const MISSING_SITE_URL_LINE =
  "本轮新增未放入附件。请打开配置页，填写「站点地址」并保存。文件仍在 R2。";

function excelLine(input: DigestInput): string {
  const total = input.countries.reduce((sum, country) => sum + country.added, 0);
  if (total === 0) return "本轮时间窗口内没有新增，因此没有附件。";
  if (input.attached) return "本轮新增在附件 Excel 里。";
  if (input.downloadUrl) return `本轮新增请下载: ${input.downloadUrl}`;
  return MISSING_SITE_URL_LINE;
}

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
    ...input.countries.map((country) => `- ${country.name}: 新增 ${country.added}${sourceSuffix(country.bySource)}`),
    "",
    `失败批次: ${input.failedBatches}`,
    input.incomplete ? "本轮在截止时间前仍有批次未完成。" : "本轮批次已全部结束。",
    excelLine(input),
  ];
  if (input.notes) lines.push("", input.notes);
  const text = lines.join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.5">${lines
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("")}</div>`;
  return { subject, text, html };
}
