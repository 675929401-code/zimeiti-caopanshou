import { NextRequest, NextResponse } from "next/server";
import {
  PlatformBrandAuthorityError,
  platformBrandSnapshotSha256,
  readPublishedPlatformBranding,
} from "@/lib/server/brand-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const branding = await readPublishedPlatformBranding();
    const etag = `"brand-${branding.generation}-${platformBrandSnapshotSha256(branding.brand)}"`;
    const headers = new Headers({
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      ETag: etag,
      Vary: "Accept-Encoding",
    });
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({ ok: true, branding }, { headers });
  } catch (error) {
    console.error("[branding] public read failed", error instanceof Error ? error.message : error);
    const code = error instanceof PlatformBrandAuthorityError ? error.code : "BRAND_PUBLIC_READ_FAILED";
    return NextResponse.json(
      { ok: false, error: "平台品牌暂时不可读取", code },
      { status: 503, headers: { "Cache-Control": "public, max-age=5" } },
    );
  }
}

