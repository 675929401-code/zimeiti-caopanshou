import { NextRequest, NextResponse } from "next/server";

import { authorizeToken, getTokenFromHeaders } from "@/lib/auth";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未登录", code: "UNAUTHENTICATED" }, { status: 401 });
  const authorization = await authorizeToken(token);
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error, code: authorization.code },
      { status: authorization.status },
    );
  }
  const snapshot = await readMemberPermissionSnapshot(authorization.actor.userId, {
    knownRole: authorization.actor.role,
  });
  if (snapshot.authorityStatus === "unavailable") {
    return NextResponse.json(
      { error: "会员权限校验暂不可用，本次未放行任何受限功能", code: "MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE" },
      { status: 503 },
    );
  }
  if (snapshot.authorityStatus === "missing" || snapshot.authorityStatus === "invalid") {
    return NextResponse.json(
      { error: "会员权限快照缺失或校验失败，请联系管理员", code: "MEMBER_PERMISSION_INTEGRITY_INVALID" },
      { status: 403 },
    );
  }
  return NextResponse.json({ permission: snapshot }, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

