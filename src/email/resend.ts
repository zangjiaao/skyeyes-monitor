import { toBase64, type EmailSendResult, type OutboundEmail } from "./types";

export async function sendWithResend(
  apiKey: string,
  message: OutboundEmail,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<EmailSendResult> {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${message.fromName} <${message.from}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachment
        ? [{
            filename: message.attachment.filename,
            content: toBase64(message.attachment.content),
          }]
        : undefined,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok) {
    throw new Error(payload.message || `Resend ${response.status}`);
  }
  return { id: payload.id || "resend" };
}
