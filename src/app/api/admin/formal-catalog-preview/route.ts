import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { formalCatalogPreviewEnabled, readFormalCatalogPreview } from "@/lib/server/formal-catalog-preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization, Cookie" };

function failure(status: number, code: string, error: string) {
  return NextResponse.json({ ok: false, code, error }, { status, headers });
}

export async function GET(request: NextRequest) {
  if (request.method !== "GET") return failure(405, "FORMAL_CATALOG_METHOD_REJECTED", "目录对账只支持 GET。");
  if (!formalCatalogPreviewEnabled()) return failure(403, "FORMAL_CATALOG_LOCAL_ONLY", "此视图仅在 5000 本地验收环境开放。");
  const authorization = await authorizeAdminCapability(request, "agents.view", { operation: "formal_public_catalog_preview" });
  if (!authorization.ok) {
    const denied = await authorization.response.json();
    return failure(authorization.response.status, denied.code, denied.error);
  }
  const { access } = authorization;
  if (access.adminLevel !== "super_admin" || !access.profileActive || !Number.isSafeInteger(access.revision) || access.revision < 1
    || !access.checksum || access.checksum === "legacy-schema-absent") {
    return failure(403, "FORMAL_CATALOG_OWNER_REQUIRED", "此视图仅对已核验的本地所有者开放。");
  }
  if (request.nextUrl.search) return failure(400, "FORMAL_CATALOG_QUERY_REJECTED", "目录对账只接受固定的公开读取范围。");
  try {
    return NextResponse.json(await readFormalCatalogPreview(), { headers });
  } catch (error) {
    if (error instanceof Error && error.message === "FORMAL_CATALOG_RESPONSE_STALE") {
      return failure(503, error.message, "目录响应已过期，本次未生成对账结果。");
    }
    return failure(503, "FORMAL_CATALOG_PREVIEW_UNAVAILABLE", "读取本地或正式公开目录失败，或目录未通过完整性校验。请重新核对。");
  }
}
