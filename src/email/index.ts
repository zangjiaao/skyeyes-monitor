import type { AppConfig } from "../config";
import { CloudflareEmailProvider } from "./cloudflare";
import { ResendEmailProvider } from "./resend";
import type { EmailProvider } from "./types";

export function createEmailProvider(env: Env, config: AppConfig): EmailProvider {
  if (config.emailProvider === "resend") return new ResendEmailProvider(env.RESEND_API_KEY);
  return new CloudflareEmailProvider(env.EMAIL);
}
