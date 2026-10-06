import { NextResponse } from "next/server";
import { getPublicSiteConfig, PublicCatalogContractError } from "@/lib/youcai-public-catalog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Expires: "0",
  Pragma: "no-cache",
  Vary: "Accept-Encoding",
} as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function GET() {
  try {
    return json({ success: true, data: getPublicSiteConfig() });
  } catch (error) {
    if (error instanceof PublicCatalogContractError) {
      return json({
        success: false,
        error: { code: "PUBLIC_SITE_CONFIG_INVALID", message: "公共站点配置未通过完整性校验" },
      }, 503);
    }
    return json({
      success: false,
      error: { code: "PUBLIC_SITE_CONFIG_UNAVAILABLE", message: "公共站点配置暂时不可用" },
    }, 500);
  }
}
