import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

type Scope = { ownerId: string; localSessionId: string; providerSessionId: string; environment?: "domestic" | "international" };
const aad = (scope: Scope) => Buffer.from(JSON.stringify([scope.ownerId, scope.localSessionId, scope.providerSessionId, scope.environment ?? "domestic"]));
const key = (apiKey: string, scope: Scope) => Buffer.from(hkdfSync("sha256", apiKey, `publishing-auth-continuation-v1:${scope.environment ?? "domestic"}`, "aitoearn-owner-bound-session", 32));
const restart = () => new Error("AUTH_RESTART_REQUIRED");
export function publishingAuthCookieName(localSessionId: string) { if (!/^[a-f0-9-]{36}$/i.test(localSessionId)) throw restart(); return `pub_auth_${localSessionId}`; }
/** Raw provider continuation exists only in server memory and an encrypted HttpOnly cookie. */
export function sealPublishingAuthContinuation(input: Scope & { expiresAt: string; cookie: string }, apiKey: string): string {
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(expires) || expires <= Date.now() || !/^_cas=[^;\r\n]{1,2048}$/.test(input.cookie)) throw restart();
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(apiKey, input), nonce); cipher.setAAD(aad(input));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ cookie: input.cookie, expires: Math.min(expires, Date.now() + 30 * 60000) })), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function openPublishingAuthContinuation(value: string, scope: Scope, apiKey: string): string {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw restart();
    const data = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", key(apiKey, scope), data.subarray(0, 12));
    decipher.setAAD(aad(scope)); decipher.setAuthTag(data.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
    if (typeof payload.expires !== "number" || payload.expires <= Date.now() || !/^_cas=[^;\r\n]{1,2048}$/.test(payload.cookie)) throw restart();
    return payload.cookie;
  } catch { throw restart(); }
}
