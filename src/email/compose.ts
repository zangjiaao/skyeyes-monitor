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

export function buildDigest(input: DigestInput): { subject: string; text: string; html: string } {
  const total = input.countries.reduce((sum, country) => sum + country.added, 0);
  const day = input.windowEnd.slice(0, 10);
  const subject = input.incomplete
    ? `SkyEyes 每日监测 ${day}（部分批次未完成）`
    : `SkyEyes 每日监测 ${day}`;
  const lines = [
    `SkyEyes 每日监测`,
    `时区: ${input.timeZone}`,
    `窗口: ${input.windowStart} 至 ${input.windowEnd}`,
    `新增合计: ${total}`,
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
    input.attached ? "完整历史见附件 skyeyes.xlsx。同一文件会在每次运行后覆盖更新。" : "Excel 较大，未放入附件。",
  ];
  if (input.downloadUrl) lines.push(`下载: ${input.downloadUrl}`);
  if (input.notes) lines.push("", input.notes);
  const text = lines.join("\n");
  const html = `<div style="font-family:sans-serif;line-height:1.5">${lines
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("")}</div>`;
  return { subject, text, html };
}
