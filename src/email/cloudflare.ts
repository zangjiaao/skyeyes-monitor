import type { EmailSendResult, OutboundEmail } from "./types";

export async function sendWithCloudflare(
  binding: SendEmail,
  message: OutboundEmail,
): Promise<EmailSendResult> {
  const result = await binding.send({
    to: message.to,
    from: { email: message.from, name: message.fromName },
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: message.attachment
      ? [{
          filename: message.attachment.filename,
          content: message.attachment.content,
          type: message.attachment.contentType,
          disposition: "attachment",
        }]
      : undefined,
  });
  return { id: result.messageId };
}
