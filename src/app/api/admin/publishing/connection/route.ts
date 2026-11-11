import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import { PublishingProvider } from "@/lib/server/publishing-provider";
import { readPublishingProviderConfiguration } from "@/lib/server/publishing-provider-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
/** Explicit administrator health check. Both provider calls are read-only. */
export async function POST(request: NextRequest) {
  const access = await authorizeAdminCapability(request, "integrations.manage", { requireStepUp: true, operation: "publishing_provider_probe", auditAllowed: true });
  if (!access.ok) return access.response;
  const configuration = readPublishingProviderConfiguration();
  if (!configuration.configured) return NextResponse.json({ ok: false, code: "PROVIDER_NOT_CONFIGURED", message: "请先通过受控流程登记对应环境的密钥" }, { status: 409, headers });
  const provider = new PublishingProvider({ ...configuration, scope: { ownerId: access.actor.userId, accountIds: new Set(), flowIds: new Set(), recordIds: new Set(), taskIds: new Set(), authSessionIds: new Set() } });
  try {
    // The platform list is public. The publish-options endpoint also verifies
    // authentication without reading another member's supplier accounts.
    const platforms = await provider.readCapabilities();
    await provider.readPublishOptions("douyin");
    return NextResponse.json({ ok: true, authenticated: true, checkedAt: new Date().toISOString(), environment: configuration.environment, platformCount: platforms.length, externalMutations: 0 }, { headers });
  } catch {
    return NextResponse.json({ ok: false, code: "PROVIDER_CHECK_FAILED", message: "官方鉴权检查未通过，请核对密钥、站点环境和官方控制台状态" }, { status: 503, headers });
  }
}
