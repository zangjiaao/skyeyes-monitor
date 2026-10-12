/** Hash both sides so a length mismatch cannot short-circuit the comparison. */
export async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  if (expectedToken.length === 0) return false;
  const provided = readBearer(request.headers.get("Authorization"));
  if (!provided) return false;
  return verifyToken(provided, expectedToken);
}
