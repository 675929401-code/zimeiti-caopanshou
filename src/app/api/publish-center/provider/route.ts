import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { readPublishingNativeStatus } from "@/lib/server/publishing-native-status";
import { PublishingError, publishingFailure } from "@/lib/server/publishing-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  try { return await withAuth(request, async (user, database) => {
    const access = await readMemberPermissionSnapshot(user.id, { knownRole: user.role });
    if (access.authorityStatus !== "ready" || !access.integrityValid || access.checksum === "legacy-schema-absent") throw new PublishingError("PUBLISH_PERMISSION_UNAVAILABLE", "会员权限暂不可确认", 503);
    if (!access.featureNavigationKeys.includes("publish_center")) throw new PublishingError("PUBLISH_ACCESS_DENIED", "当前会员未开通发布中心权限", 403);
    return NextResponse.json(await readPublishingNativeStatus(database, { ownerId: user.id, includeCounts: false }), { headers });
  }); } catch (error) { const result = publishingFailure(error); return NextResponse.json(result.body, { status: result.status, headers }); }
}
