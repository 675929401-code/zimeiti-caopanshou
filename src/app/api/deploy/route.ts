import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { logSecurityEvent, getClientIP as getSecIP, getUserAgent as getSecUA, trackIPSecurityEvent } from "@/lib/security";

export async function POST(request: NextRequest) {
  try {
    // ── 安全校验：仅管理员可触发部署 ──
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      // 记录未授权访问安全事件
      const secIP = getSecIP(request as unknown as Request);
      const secUA = getSecUA(request as unknown as Request);
      trackIPSecurityEvent(secIP, "critical");
      await logSecurityEvent({
        event_type: "unauthorized_access",
        risk_level: "critical",
        ip: secIP,
        user_agent: secUA,
        path: "/api/deploy",
        method: "POST",
        details: "未认证用户尝试触发生产部署",
        blocked: true,
      });
      return NextResponse.json({ error: "未授权：请先登录" }, { status: 401 });
    }

    const payload = await verifyToken(token);
    if (!payload || payload.role !== "admin") {
      const secIP = getSecIP(request as unknown as Request);
      const secUA = getSecUA(request as unknown as Request);
      trackIPSecurityEvent(secIP, "critical");
      await logSecurityEvent({
        event_type: "unauthorized_access",
        risk_level: "critical",
        ip: secIP,
        user_agent: secUA,
        path: "/api/deploy",
        method: "POST",
        details: `非管理员用户(${payload?.username || 'unknown'})尝试触发生产部署`,
        blocked: true,
        user_id: payload?.userId,
        username: payload?.username,
        display_name: payload?.displayName,
      });
      return NextResponse.json({ error: "需要管理员权限才能执行部署" }, { status: 403 });
    }

    // 生产应用不得自行拉 Git、改不可变版本元数据、在服务器构建或重启
    // 自己。所有发布必须由受审计的外部 CI/CD 制品链执行。
    return NextResponse.json({
      success: false,
      code: "IN_APP_DEPLOY_DISABLED",
      message: "应用内部署入口已停用。请使用 vNext 不可变制品发布链。",
    }, { status: 410 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "部署触发失败";
    return NextResponse.json(
      { success: false, message: msg },
      { status: 500 }
    );
  }
}
