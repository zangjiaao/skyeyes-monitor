import { logError } from "../log";

export type EmailKind = "daily" | "test";
export type EmailLogStatus = "sent" | "failed";
export type AttachmentMode = "attached" | "link" | "none";

export function attachmentMode(attached: boolean, downloadUrl: string | null): AttachmentMode {
  if (attached) return "attached";
  if (downloadUrl) return "link";
  return "none";
}

export async function recordEmailLog(db: D1Database, input: {
  runId: string | null;
  kind: EmailKind;
  recipients: string[];
  subject: string;
  status: EmailLogStatus;
  error: string | null;
  messageId: string | null;
  attachmentMode: AttachmentMode;
  attachmentBytes: number;
  createdAt?: string;
}): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO email_log (
        id, run_id, kind, recipients, subject, status, error, message_id,
        attachment_mode, attachment_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      input.runId,
      input.kind,
      input.recipients.join(", "),
      input.subject.slice(0, 300),
      input.status,
      input.error ? input.error.slice(0, 500) : null,
      input.messageId,
      input.attachmentMode,
      Math.max(0, Math.floor(input.attachmentBytes)),
      input.createdAt ?? new Date().toISOString(),
    ).run();
  } catch (error) {
    logError("email log failed", error, { kind: input.kind, runId: input.runId });
  }
}
