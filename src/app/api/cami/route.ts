import { NextRequest, NextResponse } from "next/server";
import { AGENT_NAVIGATION_OPTIONS, normalizeAllowedAgentNavigationKeys } from "@/lib/agent-category-access";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function errorCopy(code: string) {
  const messages: Record<string, string> = {
    CAMI_REDEEM_CARD_NOT_FOUND: "卡密无效",
    CAMI_REDEEM_CARD_USED: "卡密已被其他学员使用",
    CAMI_REDEEM_NOT_ASSIGNED_TO_USER: "该卡密已绑定其他学员，无法兑换",
    CAMI_REDEEM_CARD_EXPIRED: "卡密已过期",
    CAMI_REDEEM_USER_INVALID: "当前账号不可兑换卡密",
    CAMI_REDEEM_DURATION_INVALID: "卡密会员期限配置无效",
    CAMI_REDEEM_CODE_INVALID: "卡密格式不正确",
    CAMI_REDEEM_KEY_INVALID: "兑换操作编号无效",
    CAMI_REDEEM_PROFILE_SNAPSHOT_INVALID: "激活卡套餐快照不完整，请联系管理员核对",
    CAMI_REDEEM_PROFILE_SNAPSHOT_MISMATCH: "激活卡套餐快照校验失败，本次未改变账号",
    CAMI_REDEEM_ACTOR_INVALID: "激活卡签发管理员状态无效，请联系平台处理",
    CAMI_REDEEM_PACKAGE_ALREADY_ACTIVE: "当前账号已经开通同一套餐，无需重复兑换",
  };
  return messages[code] || "卡密兑换未通过业务校验";
}

// POST /api/cami - atomically redeem a membership card. Invitation rewards
// remain a separate manual admin decision even when redemption activates the
// invited learner.
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) return NextResponse.json({ error: "请先登录" }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload?.userId) return NextResponse.json({ error: "登录已过期" }, { status: 401 });

    const body = await request.json() as Record<string, unknown>;
    const headerKey = request.headers.get("idempotency-key")?.trim() || "";
    const bodyKey = typeof body.client_request_id === "string" ? body.client_request_id.trim() : "";
    if (headerKey && bodyKey && headerKey !== bodyKey) {
      return NextResponse.json({ error: "幂等请求标识冲突" }, { status: 409 });
    }
    const clientRequestId = headerKey || bodyKey;
    if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
      return NextResponse.json({ error: "缺少有效的 client_request_id 或 Idempotency-Key，本次未兑换" }, { status: 400 });
    }
    const database = getSupabaseAdminClient();
    const notificationId = typeof body.notificationId === "string" ? body.notificationId.trim() : "";
    let code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code && notificationId) {
      const { data: notification, error: notificationError } = await database
        .from("user_notifications")
        .select("id,user_id,type,cami_code")
        .eq("id", notificationId)
        .eq("user_id", payload.userId)
        .eq("type", "membership_card")
        .maybeSingle();
      if (notificationError) {
        return NextResponse.json({ error: "激活凭证状态暂时无法确认" }, { status: 503 });
      }
      code = typeof notification?.cami_code === "string" ? notification.cami_code.trim() : "";
      if (!code) {
        return NextResponse.json({ error: "该通知没有可用的激活凭证" }, { status: 404 });
      }
    }
    if (!code) return NextResponse.json({ error: "请输入卡密或从账号通知一键激活" }, { status: 400 });

    const { data, error } = await database.rpc("redeem_cami_membership_atomic", {
      p_user_id: payload.userId,
      p_code: code,
      p_idempotency_key: clientRequestId,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01", "42703"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "卡密原子兑换迁移尚未就绪，本次未兑换" : "兑换结果尚未确认，请使用同一卡密核对，系统不会重复入账",
        code: missing ? "CAMI_REDEEM_MIGRATION_NOT_READY" : "CAMI_REDEEM_OUTCOME_UNKNOWN",
      }, { status: 503 });
    }
    const receipt = data as Record<string, unknown> | null;
    if (receipt?.success !== true) {
      const codeValue = typeof receipt?.code === "string" ? receipt.code : "CAMI_REDEEM_FAILED";
      const status = codeValue.includes("USED") || codeValue.includes("ASSIGNED") ? 409 : 400;
      return NextResponse.json({ error: errorCopy(codeValue), code: codeValue }, { status });
    }

    const navigationKeys = normalizeAllowedAgentNavigationKeys(receipt.allowed_categories);
    const nameMap = new Map<string, string>(AGENT_NAVIGATION_OPTIONS.map((option) => [option.key, option.label]));
    return NextResponse.json({
      success: true,
      alreadyRedeemed: receipt.already_redeemed === true,
      message: receipt.already_redeemed === true ? "该激活凭证已由当前账号使用，无需重复操作" : "会员激活成功",
      credits: Number(receipt.credits || 0),
      cash_balance: Number(receipt.cash_balance || 0),
      duration_days: Number(receipt.duration_days || 0),
      plan_name: typeof receipt.plan_name === "string" ? receipt.plan_name : "",
      allowed_categories: navigationKeys,
      allowed_category_names: navigationKeys.map((key) => nameMap.get(key)).filter(Boolean),
      feature_navigation_keys: Array.isArray(receipt.feature_navigation_keys) ? receipt.feature_navigation_keys : [],
      profile_key: typeof receipt.profile_key === "string" ? receipt.profile_key : null,
      profile_version: Number(receipt.profile_version || 0) || null,
      package_assignment_id: typeof receipt.package_assignment_id === "string" ? receipt.package_assignment_id : null,
      invitationActivationReady: typeof receipt.invitation_record_id === "string",
      client_request_id: clientRequestId,
    });
  } catch (error) {
    console.error("[CAMI] Atomic redeem error:", error instanceof Error ? error.message : "unknown");
    return NextResponse.json({ error: "兑换失败，请使用同一卡密核对后重试" }, { status: 500 });
  }
}
