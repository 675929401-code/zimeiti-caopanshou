import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getManjuPublicAssetByIdSync } from "@/lib/server/manju-public-asset-registry";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ASSET_ID_PATTERN = /^manju-[a-z0-9][a-z0-9_-]{8,120}$/u;
const MAX_PROXY_BYTES = 250 * 1024 * 1024;

function publicHeaders(contentType: string, etag: string, size?: number): Headers {
  const headers = new Headers({
    "Cache-Control": "public, no-cache, must-revalidate",
    ETag: etag,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (Number.isSafeInteger(size) && Number(size) >= 0) headers.set("Content-Length", String(size));
  return headers;
}

function safeContentType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  if (normalized.startsWith("image/") || normalized.startsWith("video/") || normalized.startsWith("audio/")) {
    return normalized;
  }
  return "application/octet-stream";
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await context.params;
  if (!ASSET_ID_PATTERN.test(assetId)) {
    return NextResponse.json({ error: "素材编号无效" }, { status: 400 });
  }

  const asset = getManjuPublicAssetByIdSync(assetId);
  if (!asset || !asset.enabled || asset.deletedAt) {
    return NextResponse.json({ error: "素材不存在或已下线" }, { status: 404 });
  }
  if (asset.size > MAX_PROXY_BYTES) {
    return NextResponse.json({ error: "素材超过公开代理读取上限" }, { status: 413 });
  }

  const contentType = safeContentType(asset.contentType);
  const etag = `"${createHash("sha256").update(JSON.stringify([asset.id, asset.updatedAt, asset.storageProvider, asset.storageKey, asset.size])).digest("hex")}"`;
  if (request.headers.get("if-none-match")?.split(",").map((value) => value.trim()).some((value) => value === etag || value === `W/${etag}` || value === "*")) {
    return new NextResponse(null, { status: 304, headers: publicHeaders(contentType, etag) });
  }
  try {
    const signedUrl = await storageManager.getSignedUrl(
      asset.storageKey,
      { expireTime: 300 },
      asset.storageProvider,
    );
    if (/^https?:\/\//iu.test(signedUrl)) {
      const range = request.headers.get("range");
      const upstreamHeaders = new Headers();
      if (range && (!request.headers.get("if-range") || request.headers.get("if-range") === etag) && /^bytes=(?:\d+-\d*|-\d+)$/iu.test(range)) upstreamHeaders.set("Range", range);
      const upstream = await fetch(signedUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
        cache: "no-store",
      });
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: "素材暂时不可读取" }, { status: upstream.status === 404 ? 404 : 502 });
      }
      const headers = publicHeaders(upstream.headers.get("content-type") || contentType, etag);
      const contentLength = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      if (contentLength && /^\d+$/u.test(contentLength)) headers.set("Content-Length", contentLength);
      if (contentRange && /^bytes \d+-\d+\/\d+$/iu.test(contentRange)) headers.set("Content-Range", contentRange);
      if (contentRange) headers.set("Accept-Ranges", "bytes");
      return new NextResponse(upstream.body, { status: upstream.status, headers });
    }

    const bytes = await storageManager.read(asset.storageKey, asset.storageProvider);
    return new NextResponse(bytes, {
      status: 200,
      headers: publicHeaders(contentType, etag, bytes.byteLength),
    });
  } catch {
    return NextResponse.json({ error: "素材暂时不可读取" }, { status: 502 });
  }
}
