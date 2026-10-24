import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageProviderType } from "@/storage/object/types";

export const OWNED_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const OWNED_REFERENCE_TIMEOUT_MS = 20_000;

type ReferenceStorage = {
  getSignedUrl(key: string, options: { expireTime: number }, provider: StorageProviderType): Promise<string>;
  readBounded(key: string, maxBytes: number, timeoutMs: number, provider: StorageProviderType): Promise<Buffer>;
};

// Only authentication parameters may vary between two signatures. Image
// processing/download overrides must never silently resolve to original bytes.
const COS_SIGNATURE_PARAMETERS = new Set([
  "q-sign-algorithm", "q-ak", "q-sign-time", "q-key-time", "q-header-list",
  "q-url-param-list", "q-signature", "x-cos-security-token",
]);

function parseObjectUrl(value: string): { url: URL; key: string } | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  // URL normalizes dot paths and backslashes; reject those instead of allowing
  // normalization to select a different owner object.
  const rawPath = value.match(/^https:\/\/[^/?#]+([^?#]*)/u)?.[1] || "/";
  if (rawPath !== url.pathname || /%(?:2f|5c)/iu.test(rawPath)) return null;
  let key: string;
  try { key = decodeURIComponent(rawPath.slice(1)); } catch { return null; }
  if (!key || key.length > 2048 || /[\u0000-\u0020\u007f\\%?#]/u.test(key)
    || key.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { url, key };
}

/**
 * Authenticated owner/key authority, not an SSRF host allowlist. A URL is only
 * a lookup hint; the configured provider independently proves origin/path and
 * reads its own bucket/key. All non-owned URLs retain the caller's safeFetch.
 */
export async function readOwnedImageReference(input: {
  db: SupabaseClient;
  userId: string;
  url: string;
  storage: ReferenceStorage;
}): Promise<{ buffer: Buffer; contentType: string } | null> {
  const parsed = parseObjectUrl(input.url);
  if (!parsed || !input.userId) return null;
  const result = await input.db.from("user_files")
    .select("id,user_id,storage_key,storage_provider,file_category,file_size,content_type")
    .eq("user_id", input.userId).eq("storage_key", parsed.key).eq("file_category", "image").limit(2);
  if (result.error) throw new Error("OWNED_REFERENCE_LOOKUP_UNAVAILABLE");
  const assets = result.data || [];
  if (!assets.length) return null;
  if (assets.length !== 1) throw new Error("OWNED_REFERENCE_AMBIGUOUS");
  const asset = assets[0];
  if (asset.user_id !== input.userId || asset.storage_key !== parsed.key || asset.file_category !== "image") {
    throw new Error("OWNED_REFERENCE_AUTHORITY_MISMATCH");
  }
  // Other providers do not currently implement the bounded read contract.
  if (asset.storage_provider !== "tencent_cos") return null;
  const signed = parseObjectUrl(await input.storage.getSignedUrl(parsed.key, { expireTime: 120 }, "tencent_cos"));
  if (!signed || signed.key !== parsed.key || signed.url.origin !== parsed.url.origin
    || signed.url.pathname !== parsed.url.pathname) return null;
  const seen = new Set<string>();
  for (const [name] of parsed.url.searchParams) {
    if (!COS_SIGNATURE_PARAMETERS.has(name) || seen.has(name)) throw new Error("OWNED_REFERENCE_URL_TRANSFORM_UNSUPPORTED");
    seen.add(name);
  }
  if (Number(asset.file_size) > OWNED_REFERENCE_MAX_BYTES) throw new Error("OWNED_REFERENCE_TOO_LARGE");
  const buffer = await input.storage.readBounded(parsed.key, OWNED_REFERENCE_MAX_BYTES, OWNED_REFERENCE_TIMEOUT_MS, "tencent_cos");
  if (!buffer.length || buffer.length > OWNED_REFERENCE_MAX_BYTES) throw new Error("OWNED_REFERENCE_TOO_LARGE");
  return { buffer, contentType: String(asset.content_type || "application/octet-stream") };
}
