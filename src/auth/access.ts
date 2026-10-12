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
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email) throw new Error("Access JWT 缺少 email");
    return email;
  }
  if (env.ENVIRONMENT !== "production") {
    const identity = await ctx.access?.getIdentity();
    const email = identity?.email?.toLowerCase();
    if (email) return email;
  }
  throw new Error("缺少有效的 Cloudflare Access 凭证");
}

export async function assertAllowedEmail(env: Env, email: string): Promise<void> {
  const settings = await loadSettings(env.DB);
  if (settings.allowedAdminEmails.length === 0) return;
  if (!settings.allowedAdminEmails.includes(email.toLowerCase())) {
    throw new Error("该邮箱不在管理员名单中");
  }
}
