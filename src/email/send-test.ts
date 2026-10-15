import { loadSettings, type AppSettings } from "../config/settings";
import { MISSING_SITE_URL_LINE } from "./compose";
import { attachmentMode, recordEmailLog } from "./log";
import { runWindowDownloadPath, runWindowFilename, runWindowObjectKey } from "../export/run-file";
import { storeRunWindowExcel } from "../pipeline/run";
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

interface LatestRun {
  id: string;
  window_start: string;
  window_end: string;
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

function downloadLine(downloadUrl: string | null): string {
  return downloadUrl ? `本轮新增请下载: ${downloadUrl}` : MISSING_SITE_URL_LINE;
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

  const latest = await env.DB.prepare(
    `SELECT id, window_start, window_end
     FROM runs
     WHERE finished_at IS NOT NULL AND status IN ('completed', 'incomplete')
     ORDER BY finished_at DESC
     LIMIT 1`,
  ).first<LatestRun>();

  let bytes: Uint8Array | null = null;
  let filename = "skyeyes.xlsx";
  let generated = false;
  let excelError: string | null = null;
  let empty = !latest;
  if (latest) {
    const excelKey = settings.excelKey || env.EXCEL_FILENAME || "skyeyes.xlsx";
    filename = runWindowFilename(excelKey, latest.window_end, settings.timeZone);
    const key = runWindowObjectKey(latest.id);
    const existing = await env.EXPORTS.get(key);
    if (existing) {
      bytes = new Uint8Array(await existing.arrayBuffer());
      empty = false;
    } else {
      try {
        const stored = await storeRunWindowExcel(env, settings, {
          id: latest.id,
          windowStart: latest.window_start,
          windowEnd: latest.window_end,
        });
        bytes = stored.bytes;
        filename = stored.filename;
        generated = stored.count > 0;
        empty = stored.count === 0;
      } catch (error) {
        excelError = errorMessage(error);
        empty = false;
      }
    }
  }

  const tooLarge = Boolean(bytes && bytes.byteLength > ATTACHMENT_LIMIT_BYTES);
  const attached = Boolean(bytes && !tooLarge);
  const downloadUrl = latest && settings.appBaseUrl
    ? `${settings.appBaseUrl}${runWindowDownloadPath(latest.id)}`
    : null;
  const mode = attachmentMode(attached, tooLarge ? downloadUrl : null);
  const attachmentBytes = bytes?.byteLength ?? 0;
  const lines = [
    "这是一封 SkyEyes 测试邮件，用来确认发件人、邮件服务和收件人。",
    "每日邮件可以保持关闭，这封信仍然会发出。",
  ];
  if (attached) {
    lines.push("最近一次运行的新增在附件 Excel 里。");
  } else if (tooLarge) {
    lines.push(downloadLine(downloadUrl));
  } else if (excelError) {
    lines.push(`没有附上 Excel：${excelError}`);
  } else if (!latest) {
    lines.push("还没有已完成的运行，因此没有新增附件。");
  } else if (empty) {
    lines.push("最近一次运行的时间窗口内没有新增，因此没有附件。");
  } else {
    lines.push("还没有可附上的新增 Excel。");
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
          filename,
          content: bytes,
          contentType: EXCEL_TYPE,
        }
      : undefined,
  };

  const logBase = {
    runId: latest?.id ?? null,
    kind: "test" as const,
    recipients: to,
    subject: message.subject,
    attachmentMode: mode,
    attachmentBytes,
  };
  try {
    let messageId: string | null = null;
    if (settings.emailProvider === "cloudflare") {
      messageId = (await sendWithCloudflare(env.EMAIL, message)).id || null;
    } else if (!env.RESEND_API_KEY) {
      await recordEmailLog(env.DB, {
        ...logBase,
        status: "failed",
        error: "未配置 RESEND_API_KEY",
        messageId: null,
      });
      throw new Error("未配置 RESEND_API_KEY");
    } else {
      messageId = (await sendWithResend(env.RESEND_API_KEY, message)).id || null;
    }
    await recordEmailLog(env.DB, {
      ...logBase,
      status: "sent",
      error: null,
      messageId,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "未配置 RESEND_API_KEY") {
      await recordEmailLog(env.DB, {
        ...logBase,
        status: "failed",
        error: error instanceof Error ? error.message : "请求失败",
        messageId: null,
      });
    }
    throw error;
  }
  return { to, attached, generated, excelError, provider: settings.emailProvider };
}
