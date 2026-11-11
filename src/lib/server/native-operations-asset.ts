import "server-only";
import type { AuthUser, getSupabase } from "@/lib/api-middleware";
import { safeFetchStream } from "@/lib/safe-fetch";
import { isPublishingSafeHttps } from "@/lib/publishing-contract";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";
import { PublishingError } from "./publishing-service";

type Database = ReturnType<typeof getSupabase>;
const maximumSize = 1024 ** 3;
const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4"]);
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
function unavailable(): never { throw new PublishingError("NATIVE_ASSET_UNAVAILABLE", "素材暂不可读取，请核对原素材记录", 409); }
export function nativeAssetRange(value: string | null, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value); if (!match || !match[1] && !match[2]) throw new Error("INVALID_RANGE");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || !match[1] && Number(match[2]) <= 0) throw new Error("INVALID_RANGE");
  return { start, end };
}

/** Owner-scoped GET only. No client URL, vendor credentials or redirects. */
export async function readNativePublishingAsset(request: Request, user: AuthUser, database: Database, assetId: string, dependencies: {
  configuration?: () => Pick<ReturnType<typeof readPublishingProviderConfiguration>, "namespace">;
  fetchAsset?: typeof safeFetchStream;
} = {}): Promise<Response> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(assetId)) unavailable();
  const configuration = (dependencies.configuration ?? readPublishingProviderConfiguration)();
  const result = await database.from("pub3_assets").select("id,public_url,size,mime,file_name,sha256").eq("id", assetId).eq("owner_id", user.id).eq("connection_id", configuration.namespace).eq("state", "ready").maybeSingle();
  if (result.error || !result.data) unavailable();
  const asset = result.data as Record<string, unknown>, url = String(asset.public_url || ""), size = Number(asset.size), mime = String(asset.mime || "");
  if (!isPublishingSafeHttps(url) || !["assets.aitoearn.cn", "assets.aitoearn.ai"].includes(new URL(url).hostname) || !allowedMime.has(mime) || !Number.isSafeInteger(size) || size <= 0 || size > maximumSize) unavailable();
  let range: ReturnType<typeof nativeAssetRange>;
  try { range = nativeAssetRange(request.headers.get("range"), size); }
  catch { return new Response(null, { status: 416, headers: { ...privateHeaders, "Content-Range": `bytes */${size}` } }); }
  const expected = range ? range.end - range.start + 1 : size;
  const { response } = await (dependencies.fetchAsset ?? safeFetchStream)(url, {
    networkPolicy: "system-dns-pinned", timeoutMs: 300000,
    signal: request.signal, headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
  });
  const cancel = async () => { await response.body?.cancel().catch(() => {}); return unavailable(); };
  if (!response.body || response.redirected || response.status !== (range ? 206 : 200)) return cancel();
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== mime) return cancel();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) return cancel();
  if (range && response.headers.get("content-range") !== `bytes ${range.start}-${range.end}/${size}`) return cancel();
  const reader = response.body.getReader(); let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { if (received !== expected) { controller.error(new Error("NATIVE_ASSET_SIZE_MISMATCH")); return; } controller.close(); return; }
        received += next.value.byteLength;
        if (received > expected) { await reader.cancel(); controller.error(new Error("NATIVE_ASSET_SIZE_MISMATCH")); return; }
        controller.enqueue(next.value);
      } catch { controller.error(new Error("NATIVE_ASSET_READ_FAILED")); }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  });
  return new Response(body, { status: range ? 206 : 200, headers: { ...privateHeaders, "Content-Type": mime, "Content-Length": String(expected), "Accept-Ranges": "bytes", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(String(asset.file_name || "asset").toWellFormed())}`, ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}) } });
}
