import { bytesToBase64 } from "./encode";
import type { EmailProvider, OutboundEmail } from "./types";

/** Cloudflare Email Service binding. Message size limit is 5 MiB including the attachment. */
export class CloudflareEmailProvider implements EmailProvider {
  readonly id = "cloudflare";
  readonly maxAttachmentBytes = 4 * 1024 * 1024;

  constructor(private readonly email: SendEmail) {}

  async send(message: OutboundEmail): Promise<{ id: string }> {
    const attachment = message.attachment
      ? [
          {
            content: bytesToBase64(message.attachment.bytes),
            filename: message.attachment.filename,
            type: message.attachment.contentType,
            disposition: "attachment" as const,
          },
        ]
      : undefined;
    const result = await this.email.send({
      to: message.to,
      from: message.from,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: attachment,
    });
    const messageId = result && typeof result === "object" && "messageId" in result ? String(result.messageId) : "";
    return { id: messageId };
  }
}
