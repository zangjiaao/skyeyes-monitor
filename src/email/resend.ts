import { ProviderError } from "../errors";
import { bytesToBase64 } from "./encode";
import type { EmailProvider, OutboundEmail } from "./types";

/** Resend HTTPS API. https://resend.com/docs/api-reference/emails/send-email */
export class ResendEmailProvider implements EmailProvider {
  readonly id = "resend";
  readonly maxAttachmentBytes = 15 * 1024 * 1024;

  constructor(private readonly apiKey: string) {}

  async send(message: OutboundEmail): Promise<{ id: string }> {
    if (this.apiKey.length === 0 || this.apiKey === "unused") {
      throw new ProviderError("missing_api_key", false);
    }
    const payload: Record<string, unknown> = {
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.attachment) {
      payload.attachments = [
        {
          filename: message.attachment.filename,
          content: bytesToBase64(message.attachment.bytes),
          content_type: message.attachment.contentType,
        },
      ];
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new ProviderError(`http_${response.status}`, response.status === 429 || response.status >= 500);
    }
    const body = (await response.json()) as { id?: unknown };
    return { id: typeof body.id === "string" ? body.id : "" };
  }
}
