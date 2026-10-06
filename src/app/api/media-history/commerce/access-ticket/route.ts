import { NextRequest, NextResponse } from "next/server";

import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import {
  createCommerceMediaHistoryTicket,
  findCommerceMediaHistoryAsset,
  MEDIA_HISTORY_COMMERCE_TICKET_TTL_SECONDS,
} from "@/lib/media-history-commerce";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;
  const assetId = String(request.nextUrl.searchParams.get("assetId") || "").trim();
  const rawScope = String(request.nextUrl.searchParams.get("scope") || "playback");
  if (rawScope !== "playback" && rawScope !== "download") {
    return NextResponse.json({ error: "媒体访问范围无效" }, { status: 400 });
  }
  const scope = rawScope;
  const asset = findCommerceMediaHistoryAsset(user.userId, user.role, assetId);
  if (!asset || !asset.type.startsWith("video/")) {
    return NextResponse.json({ error: "视频资产不存在或无权访问" }, { status: 404 });
  }

  const mediaTicket = await createCommerceMediaHistoryTicket({
    userId: user.userId,
    role: user.role,
    owner: asset.owner,
    assetId: asset.id,
    scope,
  });
  const parameters = new URLSearchParams({ media_ticket: mediaTicket });
  if (scope === "download") parameters.set("download", "1");
  return NextResponse.json({
    url: `/api/media-history/commerce/content/${encodeURIComponent(asset.id)}?${parameters.toString()}`,
    expiresIn: MEDIA_HISTORY_COMMERCE_TICKET_TTL_SECONDS,
    scope,
  }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
