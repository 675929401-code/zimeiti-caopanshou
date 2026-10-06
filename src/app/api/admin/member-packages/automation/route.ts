import { NextRequest, NextResponse } from "next/server";

import { verifyAdminToken } from "@/lib/admin-auth";
import { getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const actor = await verifyAdminToken(token);
  return actor?.role === "admin" ? actor : null;
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const database = getSupabaseAdminClient();
    const [settingResult, templateResult, runsResult] = await Promise.all([
      database
        .from("member_package_automation_settings")
        .select("automation_key,enabled,profile_key,revision,configured_by,updated_at")
        .eq("automation_key", "invited_registration_welcome")
        .maybeSingle(),
      database
        .from("member_permission_profiles")
        .select("profile_key,version,name,description,membership_status,duration_days,credits,cash_amount,feature_navigation_keys,agent_navigation_keys")
        .eq("profile_key", "trial_member")
        .eq("is_active", true)
        .eq("is_selectable", true)
        .maybeSingle(),
      database
        .from("member_package_automation_runs")
        .select("id,status", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (settingResult.error || templateResult.error || runsResult.error) {
      return NextResponse.json({
        error: "新人体验包自动派发配置尚未就绪",
        code: "PACKAGE_AUTOMATION_MIGRATION_NOT_READY",
      }, { status: 503 });
    }
    const setting = settingResult.data;
    const template = templateResult.data;
    if (!setting || !template || template.membership_status !== "trial") {
      return NextResponse.json({
        error: "新人体验包模板不可用，自动派发已保持关闭",
        code: "PACKAGE_AUTOMATION_TEMPLATE_INVALID",
      }, { status: 503 });
    }
    const runs = Array.isArray(runsResult.data)
      ? runsResult.data as Array<{ id?: string; status?: string }>
      : [];
    return NextResponse.json({
      automation: {
        enabled: setting.enabled === true,
        revision: Number(setting.revision || 0),
        configuredBy: setting.configured_by || null,
        updatedAt: setting.updated_at || null,
        profileKey: String(template.profile_key || "trial_member"),
        profileVersion: Number(template.version || 0),
        packageName: String(template.name || "新人注册体验包"),
        durationDays: Number(template.duration_days || 0),
        credits: Number(template.credits || 0),
        cashAmount: Number(template.cash_amount || 0),
        featureCount: Array.isArray(template.feature_navigation_keys) ? template.feature_navigation_keys.length : 0,
        agentCount: Array.isArray(template.agent_navigation_keys) ? template.agent_navigation_keys.length : 0,
      },
      recentRuns: {
        total: Number(runsResult.count || 0),
        sent: runs.filter((item) => item.status === "sent").length,
        failed: runs.filter((item) => item.status === "failed").length,
      },
      policy: {
        futureInvitedRegistrationsOnly: true,
        inviterRewardsRemainManual: true,
        formalAndVipRemainManual: true,
        followsLatestActiveTrialTemplate: true,
        failuresRemainManuallyAssignable: true,
      },
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Member package automation read failed:", error);
    return NextResponse.json({ error: "新人体验包自动派发配置读取失败" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const body = await request.json();
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "自动派发开关参数无效" }, { status: 400 });
    }
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "缺少有效的自动派发操作编号" }, { status: 400 });
    }
    const database = getSupabaseAdminClient();
    const { data, error } = await database.rpc("set_invited_registration_package_automation_atomic", {
      p_admin_id: admin.userId,
      p_enabled: body.enabled,
      p_request_key: requestKey,
    });
    if (error) {
      const missing = ["PGRST202", "42883", "42P01", "42703"].includes(String(error.code || ""));
      return NextResponse.json({
        error: missing ? "自动派发数据库迁移尚未就绪" : "自动派发开关保存失败，本次未生效",
        code: missing ? "PACKAGE_AUTOMATION_MIGRATION_NOT_READY" : "PACKAGE_AUTOMATION_SAVE_FAILED",
      }, { status: 503 });
    }
    const receipt = (data || {}) as Record<string, unknown>;
    if (receipt.success !== true) {
      return NextResponse.json({
        error: receipt.code === "PACKAGE_AUTOMATION_TRIAL_TEMPLATE_INVALID"
          ? "请先修复新人注册体验包模板"
          : "自动派发开关未通过业务校验",
        code: receipt.code || "PACKAGE_AUTOMATION_SAVE_FAILED",
      }, { status: 400 });
    }
    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    console.error("Member package automation save failed:", error);
    return NextResponse.json({ error: "自动派发开关保存失败，本次未生效" }, { status: 500 });
  }
}
