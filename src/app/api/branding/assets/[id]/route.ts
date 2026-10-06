import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readPublishedPlatformBrandAsset } from "@/lib/server/brand-authority";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 5 * 1024 * 1024;

function assetHeaders(asset: {
  id: string;
  sha256: string;
  mimeType: string;
  bytes: number;
}): Headers {
  return new Headers({
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Disposition": `inline; filename="brand-${asset.id}"`,
    "Content-Length": String(asset.bytes),
    "Content-Security-Policy": "sandbox",
    "Content-Type": asset.mimeType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: `"sha256-${asset.sha256}"`,
    "X-Content-Type-Options": "nosniff",
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await context.params;
  const id = rawId.toLowerCase();
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "品牌资产编号无效" }, { status: 400 });
  }

  try {
    const asset = await readPublishedPlatformBrandAsset(id);
    if (!asset) return NextResponse.json({ error: "品牌资产不存在" }, { status: 404 });
    if (asset.bytes < 1 || asset.bytes > MAX_BYTES) {
      return NextResponse.json({ error: "品牌资产大小无效" }, { status: 502 });
    }
    const headers = assetHeaders(asset);
    if (request.headers.get("if-none-match") === headers.get("etag")) {
      headers.delete("Content-Length");
      return new NextResponse(null, { status: 304, headers });
    }

    const signedUrl = await storageManager.getSignedUrl(
      asset.storageKey,
      { expireTime: 120, responseContentType: asset.mimeType },
      asset.storageProvider,
    );
    if (/^https?:\/\//iu.test(signedUrl)) {
      const upstream = await fetch(signedUrl, {
        cache: "no-store",
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: "品牌资产暂时不可读取" }, { status: upstream.status === 404 ? 404 : 502 });
      }
      const upstreamLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(upstreamLength) && upstreamLength !== asset.bytes) {
        await upstream.body.cancel().catch(() => undefined);
        return NextResponse.json({ error: "品牌资产完整性校验失败" }, { status: 502 });
      }
      return new NextResponse(upstream.body, { status: 200, headers });
    }

    const bytes = await storageManager.read(asset.storageKey, asset.storageProvider);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== asset.bytes || sha256 !== asset.sha256) {
      return NextResponse.json({ error: "品牌资产完整性校验失败" }, { status: 502 });
    }
    return new NextResponse(bytes, { status: 200, headers });
  } catch (error) {
    console.error("[branding] public asset read failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "品牌资产暂时不可读取" }, { status: 502 });
  }
}

