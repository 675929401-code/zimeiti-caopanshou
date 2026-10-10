import { NextRequest, NextResponse } from "next/server";
import {
  BrandAssetIntegrityError,
  fetchBrandAssetUpstream,
  readVerifiedBrandAssetUpstream,
  verifyBrandAssetBytes,
} from "@/lib/server/brand-asset-upstream";
import { parseImageRenditionWidth, renderWebpRendition } from "@/lib/server/image-rendition";
import {
  displayBrandCacheKey,
  readResolvedPublishedAsset,
  resolveDisplayBrand,
} from "@/lib/server/white-label-runtime";
import { WhiteLabelHostError } from "@/lib/white-label-host";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 5 * 1024 * 1024;

function assetError(message: string, status: number, code?: string): NextResponse {
  return NextResponse.json(
    { error: message, ...(code ? { code } : {}) },
    { status, headers: { "Cache-Control": "private, no-store", Vary: "Host" } },
  );
}

function assetHeaders(asset: {
  id: string;
  sha256: string;
  mimeType: string;
  bytes: number;
}, cacheIdentity: string, revisionPinned: boolean): Headers {
  return new Headers({
    "Cache-Control": revisionPinned
      ? "public, max-age=31536000, immutable"
      : "public, max-age=60, stale-while-revalidate=300",
    "Content-Disposition": `inline; filename="brand-${asset.id}"`,
    "Content-Length": String(asset.bytes),
    "Content-Security-Policy": "sandbox",
    "Content-Type": asset.mimeType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: `"brand-${cacheIdentity}-sha256-${asset.sha256}"`,
    Vary: "Host, Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await context.params;
  const id = rawId.toLowerCase();
  if (!UUID.test(id)) {
    return assetError("品牌资产编号无效", 400, "BRAND_ASSET_ID_INVALID");
  }
  let renditionWidth: number | null;
  try {
    renditionWidth = parseImageRenditionWidth(request.nextUrl.searchParams.get("w"));
  } catch {
    return assetError("品牌资产尺寸无效", 400, "BRAND_ASSET_RENDITION_INVALID");
  }

  try {
    // Host is a display-brand selector only; it is never forwarded to any
    // business-data authorization path. X-Forwarded-Host is not consulted.
    const resolution = await resolveDisplayBrand(request.headers.get("host"));
    const requestedRevision = request.nextUrl.searchParams.get("revision");
    if (requestedRevision && requestedRevision !== resolution.revisionToken) {
      return assetError("品牌资产修订已失效", 404, "BRAND_ASSET_REVISION_MISMATCH");
    }
    const revisionPinned = requestedRevision === resolution.revisionToken;
    const cacheIdentity = displayBrandCacheKey(resolution);
    // readResolvedPublishedAsset delegates the platform scope to
    // readPublishedPlatformBrandAsset and enforces Host+revision membership
    // for a white-label scope.
    const asset = await readResolvedPublishedAsset(resolution, id);
    if (!asset) return assetError("品牌资产不存在", 404, "BRAND_ASSET_NOT_FOUND");
    if (asset.bytes < 1 || asset.bytes > MAX_BYTES) {
      return assetError("品牌资产大小无效", 502, "BRAND_ASSET_SIZE_INVALID");
    }
    // LocalProvider exposes an absolute /uploads URL in development, but a
    // file uploaded after the active Next build is not guaranteed to be
    // discoverable through the build's public-file serving path. The storage
    // key is authoritative, so local assets must be read from the provider
    // directly instead of being self-fetched over HTTP.
    const signedUrl = asset.storageProvider === "local"
      ? null
      : await storageManager.getSignedUrl(
        asset.storageKey,
        { expireTime: 120, responseContentType: asset.mimeType },
        asset.storageProvider,
      );
    if (signedUrl && /^https?:\/\//iu.test(signedUrl)) {
      const upstream = await fetchBrandAssetUpstream(signedUrl);
      if (!upstream.ok || !upstream.body) {
        return assetError("品牌资产暂时不可读取", upstream.status === 404 ? 404 : 502, "BRAND_ASSET_UPSTREAM_UNAVAILABLE");
      }
      // Remote originals are never streamed through unchecked. Buffer at most
      // 5 MiB and verify both the published byte count and SHA-256 first.
      const source = await readVerifiedBrandAssetUpstream(upstream, asset.bytes, asset.sha256, MAX_BYTES);
      if (renditionWidth) {
        const rendition = await renderWebpRendition(source, {
          cacheKey: `brand:${cacheIdentity}:${asset.sha256}`,
          width: renditionWidth,
          lossless: true,
        });
        const headers = assetHeaders({
          id: asset.id,
          sha256: rendition.sha256,
          mimeType: "image/webp",
          bytes: rendition.bytes.byteLength,
        }, cacheIdentity, revisionPinned);
        if (request.headers.get("if-none-match") === headers.get("etag")) {
          headers.delete("Content-Length");
          return new NextResponse(null, { status: 304, headers });
        }
        return new NextResponse(rendition.bytes, { status: 200, headers });
      }
      const headers = assetHeaders(asset, cacheIdentity, revisionPinned);
      if (request.headers.get("if-none-match") === headers.get("etag")) {
        headers.delete("Content-Length");
        return new NextResponse(null, { status: 304, headers });
      }
      return new NextResponse(source, { status: 200, headers });
    }

    const bytes = verifyBrandAssetBytes(
      await storageManager.read(asset.storageKey, asset.storageProvider),
      asset.bytes,
      asset.sha256,
    );
    if (renditionWidth) {
      const rendition = await renderWebpRendition(bytes, {
        cacheKey: `brand:${cacheIdentity}:${asset.sha256}`,
        width: renditionWidth,
        lossless: true,
      });
      const headers = assetHeaders({
        id: asset.id,
        sha256: rendition.sha256,
        mimeType: "image/webp",
        bytes: rendition.bytes.byteLength,
      }, cacheIdentity, revisionPinned);
      if (request.headers.get("if-none-match") === headers.get("etag")) {
        headers.delete("Content-Length");
        return new NextResponse(null, { status: 304, headers });
      }
      return new NextResponse(rendition.bytes, { status: 200, headers });
    }
    const headers = assetHeaders(asset, cacheIdentity, revisionPinned);
    if (request.headers.get("if-none-match") === headers.get("etag")) {
      headers.delete("Content-Length");
      return new NextResponse(null, { status: 304, headers });
    }
    return new NextResponse(bytes, { status: 200, headers });
  } catch (error) {
    console.error("[branding] public asset read failed", error instanceof Error ? error.message : error);
    if (error instanceof WhiteLabelHostError) {
      return assetError(
        error.status === 421 ? "该域名未登记或尚未发布" : "品牌资产暂时不可读取",
        error.status,
        error.code,
      );
    }
    return assetError(
      error instanceof BrandAssetIntegrityError ? "品牌资产完整性校验失败" : "品牌资产暂时不可读取",
      502,
      error instanceof BrandAssetIntegrityError ? "BRAND_ASSET_INTEGRITY_MISMATCH" : "BRAND_ASSET_READ_FAILED",
    );
  }
}
