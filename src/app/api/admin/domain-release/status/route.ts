import { NextRequest, NextResponse } from "next/server";

import { DomainReleaseError } from "@/lib/domain-tls-brand-release-control-plane";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { readDomainTlsBrandReleaseStatus } from "@/lib/server/domain-tls-brand-release-control-plane";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Authorization, Cookie",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

// Status only. This endpoint does not resolve DNS, probe TLS/HTTPS, issue a
// certificate, change a gateway, bind a runtime Host, or publish a brand.
export async function GET(request: NextRequest) {
  const platformAccess = await authorizeAdminCapability(request, "white_label.manage", {
    operation: "domain_release_status_read",
  });
  if (!platformAccess.ok) return platformAccess.response;
  try {
    return json({ ok: true, ...(await readDomainTlsBrandReleaseStatus()) });
  } catch (error) {
    if (error instanceof DomainReleaseError) {
      return json({ ok: false, error: error.message, code: error.code }, error.status);
    }
    return json(
      {
        ok: false,
        error: "域名与贴牌发布控制平面暂不可用",
        code: "DOMAIN_RELEASE_STATUS_UNAVAILABLE",
      },
      503,
    );
  }
}
