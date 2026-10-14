import { loadSettings, type AppSettings } from "../config/settings";
import { storeExcel } from "../pipeline/run";
import { sendWithCloudflare } from "./cloudflare";
import { sendWithResend } from "./resend";
import { ATTACHMENT_LIMIT_BYTES, type OutboundEmail } from "./types";

const EXCEL_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TestEmailResult {
  to: string[];
  attached: boolean;
  generated: boolean;
  excelError: string | null;
  provider: AppSettings["emailProvider"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendTestEmail(env: Env, input: { to?: string | null } = {}): Promise<TestEmailResult> {
  const settings = await loadSettings(env.DB);
  const single = input.to?.trim().toLowerCase() ?? "";
  let to: string[];
  if (single) {
    if (!EMAIL_PATTERN.test(single)) throw new Error("邮箱格式不正确");
    to = [single];
  } else {
    const recipients = await env.DB.prepare(
      "SELECT email FROM recipients WHERE enabled = 1 ORDER BY email",
    ).all<{ email: string }>();
    to = recipients.results.map((row) => row.email);
    if (to.length === 0) throw new Error("没有启用的收件人");
  }
  if (!settings.emailFrom.trim()) throw new Error("未配置发件人");

  const key = settings.excelKey || env.EXCEL_FILENAME || "skyeyes.xlsx";
  let bytes: Uint8Array | null = null;
  let generated = false;
  let excelError: string | null = null;
  const existing = await env.EXPORTS.get(key);
  if (existing) {
    bytes = new Uint8Array(await existing.arrayBuffer());
  } else {
    try {
      const stored = await storeExcel(env, settings);
      bytes = stored.bytes;
      generated = true;
    } catch (error) {
      excelError = errorMessage(error);
    }
  }

  const tooLarge = Boolean(bytes && bytes.byteLength > ATTACHMENT_LIMIT_BYTES);
  const attached = Boolean(bytes && !tooLarge);
  const downloadUrl = settings.appBaseUrl ? `${settings.appBaseUrl}/api/export/excel` : null;
  const lines = [
    "这是一封 SkyEyes 测试邮件，用来确认发件人、邮件服务和收件人。",
    "每日邮件可以保持关闭，这封信仍然会发出。",
  ];
  if (attached) {
    lines.push("完整内容在附件 Excel 里。");
  } else if (tooLarge) {
    lines.push(downloadUrl
      ? `完整内容请下载: ${downloadUrl}`
      : "完整内容未放入附件。未配置站点地址，正文里没有下载链接。文件仍在 R2。");
  } else {
    lines.push(excelError ? `没有附上 Excel：${excelError}` : "还没有可附上的 Excel。");
  }
  const text = lines.join("\n");
  const message: OutboundEmail = {
    from: settings.emailFrom,
    fromName: settings.emailFromName || "SkyEyes",
    to,
    subject: "SkyEyes 测试邮件",
    text,
    html: `<div style="font-family:sans-serif;line-height:1.5">${lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("")}</div>`,
    attachment: attached && bytes
      ? {
          filename: key.split("/").pop() || "skyeyes.xlsx",
          content: bytes,
          contentType: EXCEL_TYPE,
        }
      : undefined,
  };

  if (settings.emailProvider === "cloudflare") {
    await sendWithCloudflare(env.EMAIL, message);
  } else if (!env.RESEND_API_KEY) {
    throw new Error("未配置 RESEND_API_KEY");
  } else {
    await sendWithResend(env.RESEND_API_KEY, message);
  }
  return { to, attached, generated, excelError, provider: settings.emailProvider };
}
