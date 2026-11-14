import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadSettings } from "../config/settings";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const issuer = teamDomain.replace(/\/$/, "");
  const cached = jwksByIssuer.get(issuer);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  jwksByIssuer.set(issuer, created);
  return created;
}

export async function authenticate(
  request: Request,
  env: Env,
  ctx: { access?: { getIdentity(): Promise<{ email?: string } | undefined> } },
): Promise<string> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const teamDomain = env.TEAM_DOMAIN?.replace(/\/$/, "");
  const audience = env.POLICY_AUD;
  if (token && teamDomain && audience) {
    const { payload } = await jwtVerify(token, jwksFor(teamDomain), {
      issuer: teamDomain,
      audience,
    });
    return identityFromAccessPayload(payload);
  }
  if (env.ENVIRONMENT !== "production") {
    const identity = await ctx.access?.getIdentity();
    const email = identity?.email?.toLowerCase();
    if (email) return email;
  }
  throw new Error("缺少有效的 Cloudflare Access 凭证");
}

/** Access 已校验过的 Service Token 没有 email，用令牌名称作为身份。 */
export function identityFromAccessPayload(payload: { [key: string]: unknown }): string {
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email) return email;
  const commonName = typeof payload.common_name === "string" ? payload.common_name.trim() : "";
  if (commonName) return `service-token:${commonName}`;
  throw new Error("Access JWT 缺少 email");
}

export function isServiceTokenIdentity(identity: string): boolean {
  return identity.startsWith("service-token:");
}

export async function assertAllowedEmail(env: Env, email: string): Promise<void> {
  if (isServiceTokenIdentity(email)) return;
  const settings = await loadSettings(env.DB);
  if (settings.allowedAdminEmails.length === 0) return;
  if (!settings.allowedAdminEmails.includes(email.toLowerCase())) {
    throw new Error("该邮箱不在管理员名单中");
  }
}
