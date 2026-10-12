import { verifyToken } from "./auth";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createDownloadSignature(secret: string, objectKey: string, exp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${exp}.${objectKey}`));
  return toHex(signed);
}

export async function verifyDownloadSignature(
  secret: string,
  objectKey: string,
  exp: number,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (secret.length === 0) return false;
  if (!Number.isSafeInteger(exp) || exp < nowSeconds) return false;
  if (!/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = await createDownloadSignature(secret, objectKey, exp);
  return verifyToken(signature.toLowerCase(), expected.toLowerCase());
}

export function downloadUrl(baseUrl: string, objectKey: string, exp: number, signature: string): string {
  const path = `/download/${encodeURIComponent(objectKey)}`;
  return `${baseUrl}${path}?exp=${exp}&sig=${signature}`;
}
