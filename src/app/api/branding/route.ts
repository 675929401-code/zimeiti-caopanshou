import { NextRequest, NextResponse } from "next/server";
import {
  platformBrandSnapshotSha256,
} from "@/lib/server/brand-authority";
import {
  displayBrandCacheKey,
  resolveDisplayBrand,
} from "@/lib/server/white-label-runtime";
import { WhiteLabelHostError } from "@/lib/white-label-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Only the direct RFC Host field is consumed. X-Forwarded-Host is
    // intentionally ignored because the application has no trusted-proxy hop
    // contract at this boundary.
    // resolveDisplayBrand delegates platform-safe hosts to
    // readPublishedPlatformBranding and exact custom hosts to the white-label
    // published-release resolver.
    const resolution = await resolveDisplayBrand(request.headers.get("host"));
    const branding = resolution.branding;
    const etag = `"brand-${displayBrandCacheKey(resolution)}-${platformBrandSnapshotSha256(branding.brand)}"`;
    const headers = new Headers({
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      ETag: etag,
      Vary: "Host, Accept-Encoding",
    });
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({ ok: true, branding }, { headers });
  } catch (error) {
    console.error("[branding] public read failed", error instanceof Error ? error.message : error);
    const code = error instanceof WhiteLabelHostError ? error.code : "BRAND_PUBLIC_READ_FAILED";
    const status = error instanceof WhiteLabelHostError ? error.status : 503;
    return NextResponse.json(
      { ok: false, error: status === 421 ? "该域名未登记或尚未发布" : "平台品牌暂时不可读取", code },
      { status, headers: { "Cache-Control": "private, no-store", Vary: "Host" } },
    );
  }
}
