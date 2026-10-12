export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface OutboundEmail {
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachment?: EmailAttachment;
}

export interface EmailSendResult {
  id: string;
}

export const ATTACHMENT_LIMIT_BYTES = 4_000_000;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
