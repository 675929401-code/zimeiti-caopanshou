import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { fetchBrandAssetUpstream } from "@/lib/server/brand-asset-upstream";
import { readAdminPlatformBrandAsset } from "@/lib/server/brand-authority";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 5 * 1024 * 1024;

function privateAssetHeaders(asset: {
  id: string;
  mimeType: string;
  bytes: number;
}): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="brand-draft-${asset.id}"`,
    "Content-Length": String(asset.bytes),
    "Content-Security-Policy": "sandbox",
    "Content-Type": asset.mimeType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "platform_brand_asset_preview",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;

  const { id: rawId } = await context.params;
  const id = rawId.toLowerCase();
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "品牌资产编号无效" }, {
      status: 400,
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  try {
    const asset = await readAdminPlatformBrandAsset(id);
    if (!asset) {
      return NextResponse.json({ error: "品牌资产不存在" }, {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (asset.bytes < 1 || asset.bytes > MAX_BYTES) {
      return NextResponse.json({ error: "品牌资产大小无效" }, {
        status: 502,
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    const headers = privateAssetHeaders(asset);
    // LocalProvider returns an absolute /uploads URL in development. Newly
    // uploaded draft assets are authoritative in the provider directory and
    // are not guaranteed to be visible through the active build's public
    // files, so never self-fetch local previews over HTTP.
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
        return NextResponse.json({ error: "品牌资产暂时不可读取" }, {
          status: upstream.status === 404 ? 404 : 502,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      const upstreamLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(upstreamLength) && upstreamLength !== asset.bytes) {
        await upstream.body.cancel().catch(() => undefined);
        return NextResponse.json({ error: "品牌资产完整性校验失败" }, {
          status: 502,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      return new NextResponse(upstream.body, { status: 200, headers });
    }

    const bytes = await storageManager.read(asset.storageKey, asset.storageProvider);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== asset.bytes || sha256 !== asset.sha256) {
      return NextResponse.json({ error: "品牌资产完整性校验失败" }, {
        status: 502,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    return new NextResponse(bytes, { status: 200, headers });
  } catch (error) {
    console.error("[branding] admin asset preview failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "品牌资产暂时不可读取" }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
