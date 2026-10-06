import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import { enqueueUserNotificationOnce } from "@/lib/user-notification-server";

type NotificationAuthorization = Extract<AdminCapabilityResult, { ok: true }>;

async function auditManualNotification(
  request: NextRequest,
  authorization: NotificationAuthorization,
  result: "success" | "failure",
  reasonCode: string,
  params: {
    targetUserId?: string;
    requestKey?: string;
    type?: string;
    alreadyExisted?: boolean;
  } = {},
) {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    targetUserId: params.targetUserId || null,
    permissionKey: "announcements.manage",
    action: "manual_account_notification_send",
    result,
    reasonCode,
    resource: "user_notifications",
    request,
    requestKey: params.requestKey || null,
    metadata: {
      notificationType: params.type || "",
      ...(params.alreadyExisted === undefined ? {} : { alreadyExisted: params.alreadyExisted }),
    },
  });
}

// POST /api/admin/notifications/send — 管理员向用户发送幂等账号通知。
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "announcements.manage", {
    operation: "manual_account_notification_send",
    requireStepUp: true,
  });
  if (!authorization.ok) return authorization.response;

  let userId = "";
  let type = "reward";
  let requestKey = "";
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || Array.isArray(body)) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_REQUEST_INVALID");
      return NextResponse.json({ error: "请求内容无效" }, { status: 400 });
    }
    userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content : "";
    type = typeof body.type === "string" ? body.type.trim().toLowerCase() : "reward";
    const camiCode = typeof body.cami_code === "string" ? body.cami_code.trim() : "";
    const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : {};

    if (!userId || userId.length > 160) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_TARGET_INVALID", { targetUserId: userId, type });
      return NextResponse.json({ error: "用户 ID 无效" }, { status: 400 });
    }
    if (!title || title.length > 240) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_TITLE_INVALID", { targetUserId: userId, type });
      return NextResponse.json({ error: "通知标题无效" }, { status: 400 });
    }
    if (content.length > 10_000 || !/^[a-z][a-z0-9_-]{0,63}$/u.test(type)) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_CONTENT_INVALID", { targetUserId: userId, type });
      return NextResponse.json({ error: "通知内容或类型无效" }, { status: 400 });
    }
    if (JSON.stringify(metadata).length > 16_384) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_METADATA_TOO_LARGE", { targetUserId: userId, type });
      return NextResponse.json({ error: "通知附加信息过大" }, { status: 400 });
    }
    if (camiCode) {
      await auditManualNotification(request, authorization, "failure", "BOUND_CAMI_FLOW_REQUIRED", { targetUserId: userId, type });
      return NextResponse.json({ error: "卡密必须从“会员管理 → 卡密管理”绑定学员后推送，禁止发送未绑定卡密" }, { status: 409 });
    }
    if (type === "invitation_reward") {
      await auditManualNotification(request, authorization, "failure", "INVITATION_REWARD_FLOW_REQUIRED", { targetUserId: userId, type });
      return NextResponse.json({ error: "邀请礼包必须从“会员管理 → 邀请关系”保存额度并确认推送" }, { status: 409 });
    }

    requestKey = String(
      request.headers.get("idempotency-key")
      || body.idempotencyKey
      || metadata.dedupe_key
      || randomUUID(),
    ).trim();
    if (!requestKey || requestKey.length > 180) {
      await auditManualNotification(request, authorization, "failure", "NOTIFICATION_REQUEST_KEY_INVALID", { targetUserId: userId, type });
      return NextResponse.json({ error: "通知操作编号无效" }, { status: 400 });
    }

    const delivery = await enqueueUserNotificationOnce({
      userId,
      type,
      title,
      content,
      camiCode: null,
      dedupeKey: `admin-notification:${authorization.actor.userId}:${requestKey}`,
      metadata: {
        ...metadata,
        source: "admin_manual",
        admin_user_id: authorization.actor.userId,
      },
    });
    if (!delivery.ok) {
      await auditManualNotification(request, authorization, "failure", delivery.code || "NOTIFICATION_ENQUEUE_FAILED", {
        targetUserId: userId,
        requestKey,
        type,
      });
      return NextResponse.json({ error: "发送通知失败，请使用原操作编号重试", code: delivery.code }, { status: 503 });
    }

    await auditManualNotification(request, authorization, "success", "MANUAL_NOTIFICATION_ENQUEUED", {
      targetUserId: userId,
      requestKey,
      type,
      alreadyExisted: delivery.alreadyExisted,
    });
    return NextResponse.json({
      success: true,
      idempotencyKey: requestKey,
      notification: {
        id: delivery.notificationId,
        title,
        created_at: delivery.createdAt,
        alreadyExisted: delivery.alreadyExisted,
      },
    });
  } catch (error) {
    await auditManualNotification(request, authorization, "failure", "MANUAL_NOTIFICATION_SEND_FAILED", {
      targetUserId: userId,
      requestKey,
      type,
    });
    console.error("[Admin Notifications] Send error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "发送通知失败" }, { status: 500 });
  }
}
