import { NextRequest, NextResponse } from "next/server";

import { normalizeAllowedAgentNavigationKeys } from "@/lib/agent-category-access";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { normalizeFeatureNavigationKeys } from "@/lib/member-permissions";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const actor = await verifyAdminToken(token);
  return actor?.role === "admin" ? actor : null;
}

// POST /api/admin/member-packages/assign — one transaction for membership,
// permissions, wallet benefits, invitation welcome node and user notification.
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const body = await request.json();
    const userId = String(body.userId || "").trim();
    const invitationRecordId = String(body.invitationRecordId || "").trim() || null;
    const profileKey = String(body.profileKey || "").trim() || null;
    const profileVersion = profileKey ? Number(body.profileVersion) : null;
    const packageName = String(body.packageName || "").trim();
    const membershipStatus = String(body.membershipStatus || "").trim();
    const durationDays = Number(body.durationDays || 0);
    const credits = Number(body.credits || 0);
    const cashAmount = Number(body.cashAmount || 0);
    const expectedPermissionRevision = Number(body.expectedPermissionRevision);
    const rawFeatures = body.featureNavigationKeys;
    const rawAgents = body.agentNavigationKeys;
    if (!userId || !packageName || packageName.length > 120
      || !["trial", "active"].includes(membershipStatus)
      || !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 36_500
      || (membershipStatus === "trial" && durationDays <= 0)
      || !Number.isFinite(credits) || credits < 0 || credits > 1_000_000_000
      || !Number.isFinite(cashAmount) || cashAmount < 0 || cashAmount > 100_000_000
      || !Number.isInteger(expectedPermissionRevision) || expectedPermissionRevision < 0
      || !Array.isArray(rawFeatures) || !Array.isArray(rawAgents)
      || (profileKey && (!Number.isInteger(profileVersion) || Number(profileVersion) <= 0))) {
      return NextResponse.json({ error: "套餐开通参数无效" }, { status: 400 });
    }
    const featureNavigationKeys = normalizeFeatureNavigationKeys(rawFeatures);
    const agentNavigationKeys = normalizeAllowedAgentNavigationKeys(rawAgents);
    if (featureNavigationKeys.length !== new Set(rawFeatures.map(String)).size
      || agentNavigationKeys.length !== new Set(rawAgents.map(String)).size) {
      return NextResponse.json({ error: "套餐包含未知或重复权限，请刷新后重试" }, { status: 400 });
    }
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "缺少有效的套餐开通操作编号" }, { status: 400 });
    }

    const database = getSupabaseAdminClient();
    if (membershipStatus === "trial" && invitationRecordId) {
      const { data: riskRecord, error: riskError } = await database
        .from("invitation_records")
        .select("risk_status, automatic_trial_eligible")
        .eq("id", invitationRecordId)
        .eq("invitee_id", userId)
        .maybeSingle();
      if (riskError) {
        const missing = ["PGRST205", "42P01", "42703"].includes(String(riskError.code || ""));
        return NextResponse.json({
          error: missing ? "邀请码风控迁移尚未就绪，本次未开通" : "邀请风险状态读取失败，本次未开通",
          code: missing ? "INVITATION_SECURITY_MIGRATION_NOT_READY" : "INVITATION_RISK_READ_FAILED",
        }, { status: 503 });
      }
      const riskStatus = String(riskRecord?.risk_status || "clear");
      if (riskStatus === "blocked") {
        return NextResponse.json({
          error: "该邀请关系已确认为异常，不能派发新人体验包",
          code: "INVITATION_TRIAL_BLOCKED",
        }, { status: 409 });
      }
      if (riskStatus === "review" || riskRecord?.automatic_trial_eligible === false) {
        return NextResponse.json({
          error: "该注册命中同 IP、同设备或短时集中邀请信号，请先在邀请关系中人工复核；系统不会仅凭 IP 自动封号",
          code: "INVITATION_RISK_REVIEW_REQUIRED",
        }, { status: 409 });
      }
    }
    const { data, error } = await database.rpc("assign_member_package_atomic", {
      p_admin_id: admin.userId,
      p_user_id: userId,
      p_invitation_record_id: invitationRecordId,
      p_profile_key: profileKey,
      p_profile_version: profileVersion,
      p_package_name: packageName,
      p_membership_status: membershipStatus,
      p_duration_days: durationDays,
      p_credits: credits,
      p_cash_amount: cashAmount,
      p_feature_navigation_keys: featureNavigationKeys,
      p_agent_navigation_keys: agentNavigationKeys,
      p_expected_permission_revision: expectedPermissionRevision,
      p_request_key: requestKey,
      p_note: String(body.note || "").trim().slice(0, 2000),
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01", "42703"].includes(String(error.code || ""));
      const message = String(error.message || "");
      const conflict = message.includes("REVISION_CONFLICT");
      return NextResponse.json({
        error: missing
          ? "会员套餐迁移尚未就绪，本次未开通"
          : conflict
            ? "该学员权限已在其他窗口更新，请刷新后重新选择套餐"
            : "套餐未完整开通，数据库已回滚本次操作",
        code: missing ? "MEMBER_PACKAGE_MIGRATION_NOT_READY" : conflict ? "MEMBER_PACKAGE_REVISION_CONFLICT" : "MEMBER_PACKAGE_ASSIGN_FAILED",
      }, { status: conflict ? 409 : 503 });
    }
    const receipt = (data || {}) as Record<string, unknown>;
    if (receipt.success !== true) {
      const code = String(receipt.code || "MEMBER_PACKAGE_ASSIGN_FAILED");
      const status = code.includes("ALREADY_ASSIGNED") || code.includes("MISMATCH") ? 409
        : code.includes("USER_INVALID") ? 404
          : 400;
      const errorCopy = code.includes("ALREADY_ASSIGNED")
        ? "该新人套餐已经开通过，请查看回执；升级套餐请到会员管理操作"
        : code.includes("PROFILE_MISMATCH")
          ? "模板刚刚更新，请重新选择最新模板"
          : code.includes("INVITATION_MISMATCH")
            ? "邀请关系与学员不匹配，本次未开通"
            : "套餐未通过业务校验，本次未开通";
      return NextResponse.json({ error: errorCopy, code }, { status });
    }
    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    console.error("Admin member package assignment failed:", error);
    return NextResponse.json({ error: "套餐未完整开通，本次未生效" }, { status: 500 });
  }
}
