import { NextRequest, NextResponse } from "next/server";

import { AGENT_NAVIGATION_OPTIONS, normalizeAllowedAgentNavigationKeys } from "@/lib/agent-category-access";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  MEMBER_FEATURE_PERMISSION_OPTIONS,
  normalizeFeatureNavigationKeys,
  normalizeMemberAgentNavigationKeys,
} from "@/lib/member-permissions";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const actor = await verifyAdminToken(token);
  return actor?.role === "admin" ? actor : null;
}

function currentResourceRows() {
  const now = new Date().toISOString();
  return [
    ...MEMBER_FEATURE_PERMISSION_OPTIONS.map((item, index) => ({
      resource_type: "feature",
      resource_key: item.key,
      label: item.label,
      route: item.route,
      description: item.description,
      sort_order: (index + 1) * 10,
      last_seen_at: now,
    })),
    ...AGENT_NAVIGATION_OPTIONS.map((item, index) => ({
      resource_type: "agent",
      resource_key: item.key,
      label: item.label,
      route: null,
      description: "智能体分类访问权限",
      sort_order: (index + 1) * 10,
      last_seen_at: now,
    })),
  ];
}

// GET /api/admin/member-packages — template catalog plus the current dynamic
// permission surface. New product keys are discovered, never auto-granted.
export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const database = getSupabaseAdminClient();
    const syncResult = await database
      .from("member_permission_resources")
      .upsert(currentResourceRows(), { onConflict: "resource_type,resource_key" });
    if (syncResult.error) {
      return NextResponse.json({
        error: "会员套餐资源目录尚未就绪",
        code: "MEMBER_PACKAGE_MIGRATION_NOT_READY",
      }, { status: 503 });
    }

    const { data: profiles, error } = await database
      .from("member_permission_profiles")
      .select("profile_key,version,name,description,feature_navigation_keys,agent_navigation_keys,membership_status,duration_days,credits,cash_amount,sort_order,updated_at")
      .eq("is_active", true)
      .eq("is_selectable", true)
      .order("sort_order", { ascending: true })
      .order("profile_key", { ascending: true });
    if (error) throw error;

    const userId = new URL(request.url).searchParams.get("user_id")?.trim() || "";
    const permission = userId ? await readMemberPermissionSnapshot(userId) : null;
    if (permission?.authorityStatus === "unavailable") {
      return NextResponse.json({ error: "会员权限数据暂不可用" }, { status: 503 });
    }

    return NextResponse.json({
      templates: (profiles || []).map((profile: Record<string, unknown>) => ({
        key: String(profile.profile_key || ""),
        version: Number(profile.version || 0),
        name: String(profile.name || ""),
        description: String(profile.description || ""),
        membershipStatus: String(profile.membership_status || "trial"),
        durationDays: Number(profile.duration_days || 0),
        credits: Number(profile.credits || 0),
        cashAmount: Number(profile.cash_amount || 0),
        featureNavigationKeys: normalizeFeatureNavigationKeys(profile.feature_navigation_keys),
        agentNavigationKeys: normalizeMemberAgentNavigationKeys(profile.agent_navigation_keys),
        updatedAt: profile.updated_at || null,
      })),
      resources: {
        features: MEMBER_FEATURE_PERMISSION_OPTIONS,
        agents: AGENT_NAVIGATION_OPTIONS,
      },
      permission,
      policy: {
        newResourcesDefaultClosed: true,
        existingAssignmentsImmutableOnRelease: true,
        templateChangesCreateNewVersion: true,
      },
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Admin member package read failed:", error);
    return NextResponse.json({ error: "会员套餐数据暂不可用" }, { status: 503 });
  }
}

// PUT /api/admin/member-packages — save a new immutable version of a template.
export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const body = await request.json();
    const profileKey = String(body.profileKey || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const membershipStatus = String(body.membershipStatus || "").trim();
    const durationDays = Number(body.durationDays || 0);
    const credits = Number(body.credits || 0);
    const cashAmount = Number(body.cashAmount || 0);
    const rawFeatures = body.featureNavigationKeys;
    const rawAgents = body.agentNavigationKeys;
    if (!/^[a-z][a-z0-9_]{2,63}$/u.test(profileKey) || !name
      || !["trial", "active"].includes(membershipStatus)
      || !Number.isInteger(durationDays) || durationDays < 0 || durationDays > 36_500
      || (membershipStatus === "trial" && durationDays <= 0)
      || !Number.isFinite(credits) || credits < 0 || credits > 1_000_000_000
      || !Number.isFinite(cashAmount) || cashAmount < 0 || cashAmount > 100_000_000
      || !Array.isArray(rawFeatures) || !Array.isArray(rawAgents)) {
      return NextResponse.json({ error: "套餐模板参数无效" }, { status: 400 });
    }
    const featureNavigationKeys = normalizeFeatureNavigationKeys(rawFeatures);
    const agentNavigationKeys = normalizeAllowedAgentNavigationKeys(rawAgents);
    if (featureNavigationKeys.length !== new Set(rawFeatures.map(String)).size
      || agentNavigationKeys.length !== new Set(rawAgents.map(String)).size) {
      return NextResponse.json({ error: "套餐包含未知或重复权限，请刷新后重试" }, { status: 400 });
    }
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "缺少有效的模板操作编号" }, { status: 400 });
    }
    const database = getSupabaseAdminClient();
    const { data, error } = await database.rpc("create_member_package_profile_version_atomic", {
      p_admin_id: admin.userId,
      p_profile_key: profileKey,
      p_name: name,
      p_description: String(body.description || "").trim().slice(0, 1000),
      p_membership_status: membershipStatus,
      p_duration_days: durationDays,
      p_credits: credits,
      p_cash_amount: cashAmount,
      p_feature_navigation_keys: featureNavigationKeys,
      p_agent_navigation_keys: agentNavigationKeys,
      p_request_key: requestKey,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01", "42703"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "会员套餐迁移尚未就绪" : "套餐模板保存失败，本次未生效",
        code: missing ? "MEMBER_PACKAGE_MIGRATION_NOT_READY" : "MEMBER_PACKAGE_TEMPLATE_SAVE_FAILED",
      }, { status: 503 });
    }
    const receipt = (data || {}) as Record<string, unknown>;
    if (receipt.success !== true) {
      return NextResponse.json({ error: "套餐模板未通过业务校验", code: receipt.code }, { status: 400 });
    }
    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    console.error("Admin member package template save failed:", error);
    return NextResponse.json({ error: "套餐模板保存失败，本次未生效" }, { status: 500 });
  }
}
