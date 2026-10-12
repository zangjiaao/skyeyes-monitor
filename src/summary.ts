export interface CountrySummaryLine {
  countryName: string;
  xCount: number;
  webCount: number;
}

export interface SummaryInput {
  collectedDate: string;
  windowLabel: string;
  partial: boolean;
  incompleteBatches: number;
  newRecords: number;
  untranslated: number;
  countries: CountrySummaryLine[];
  downloadUrl: string | null;
  attached: boolean;
  excelName: string;
  notes: string[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderDailySummary(input: SummaryInput): { subject: string; text: string; html: string } {
  const subject = `SkyEyes 监测日报 ${input.collectedDate}`;
  const status = input.partial ? "部分完成（有批次未完成，见下方说明）" : "已完成";
  const lines = [
    `收集日：${input.collectedDate}（北京时间）`,
    `监测窗口：${input.windowLabel}`,
    `状态：${status}`,
    `本窗口新增记录：${input.newRecords}`,
    `其中尚未译成中文：${input.untranslated}`,
    `未完成批次：${input.incompleteBatches}`,
    "",
    "按国家（本窗口新增）：",
  ];
  if (input.countries.length === 0) {
    lines.push("（没有国家配置）");
  } else {
    for (const country of input.countries) {
      const total = country.xCount + country.webCount;
      lines.push(`- ${country.countryName}：合计 ${total}（X ${country.xCount}，网页 ${country.webCount}）`);
    }
  }
  lines.push("");
  if (input.attached) {
    lines.push(`Excel「${input.excelName}」已作为附件发送。文件按固定名字覆盖，内容是截至本次的全部历史（受导出行数上限约束）。`);
  } else {
    lines.push(`本次邮件没有附上 Excel「${input.excelName}」。`);
  }
  if (input.downloadUrl) lines.push(`下载链接（到期前有效）：${input.downloadUrl}`);
  else lines.push("未配置 PUBLIC_BASE_URL，邮件中没有下载链接。文件仍写入了 R2。");
  for (const note of input.notes) lines.push(note);

  const text = lines.join("\n");
  const html = [
    "<div>",
    ...lines.map((line) => (line.length === 0 ? "<br>" : `<p>${escapeHtml(line)}</p>`)),
    "</div>",
  ].join("");
  return { subject, text, html };
}
