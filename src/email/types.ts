export interface EmailAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface OutboundEmail {
  to: string[];
  from: string;
  subject: string;
  html: string;
  text: string;
  attachment?: EmailAttachment;
}

export interface EmailProvider {
  readonly id: string;
  readonly maxAttachmentBytes: number;
  send(message: OutboundEmail): Promise<{ id: string }>;
}
