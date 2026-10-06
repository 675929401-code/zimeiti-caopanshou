import { NextRequest, NextResponse } from "next/server";

import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
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

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  const userId = new URL(request.url).searchParams.get("user_id")?.trim() || "";
  if (!userId) return NextResponse.json({ error: "用户ID不能为空" }, { status: 400 });
  try {
    const database = getSupabaseAdminClient();
    const [userResult, snapshot, profilesResult, eventsResult] = await Promise.all([
      database.from("users").select("id,username,display_name,role,status,is_active").eq("id", userId).maybeSingle(),
      readMemberPermissionSnapshot(userId),
      database
        .from("member_permission_profiles")
        .select("profile_key,version,name,description,feature_navigation_keys,agent_navigation_keys")
        .eq("is_active", true)
        .order("profile_key", { ascending: true })
        .order("version", { ascending: false }),
      database
        .from("member_permission_events")
        .select("id,actor_id,revision,source,reason,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (userResult.error) throw userResult.error;
    if (!userResult.data) return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    if (profilesResult.error || eventsResult.error || snapshot.authorityStatus === "unavailable") {
      return NextResponse.json({
        error: "会员权限数据暂不可用",
        code: "MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE",
      }, { status: 503 });
    }
    return NextResponse.json({
      user: userResult.data,
      permission: snapshot,
      profiles: (profilesResult.data || []).map((profile: Record<string, unknown>) => ({
        key: profile.profile_key,
        version: profile.version,
        name: profile.name,
        description: profile.description,
        featureNavigationKeys: normalizeFeatureNavigationKeys(profile.feature_navigation_keys),
        agentNavigationKeys: normalizeMemberAgentNavigationKeys(profile.agent_navigation_keys),
      })),
      events: eventsResult.data || [],
    }, { headers: { "Cache-Control": "private, no-store, max-age=0" } });
  } catch (error) {
    console.error("Admin member permission read failed:", error);
    return NextResponse.json({ error: "会员权限数据暂不可用" }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "无管理员权限" }, { status: 403 });
  try {
    const body = await request.json();
    const userId = String(body.userId || "").trim();
    const rawFeatures = body.featureNavigationKeys;
    const rawAgents = body.agentNavigationKeys;
    if (!userId || !Array.isArray(rawFeatures) || !Array.isArray(rawAgents)) {
      return NextResponse.json({ error: "会员与权限清单不能为空" }, { status: 400 });
    }
    const featureNavigationKeys = normalizeFeatureNavigationKeys(rawFeatures);
    const agentNavigationKeys = normalizeMemberAgentNavigationKeys(rawAgents);
    if (featureNavigationKeys.length !== new Set(rawFeatures.map(String)).size
      || agentNavigationKeys.length !== new Set(rawAgents.map(String)).size) {
      return NextResponse.json({ error: "权限清单包含未知或重复项目" }, { status: 400 });
    }
    const expectedRevision = Number(body.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return NextResponse.json({ error: "权限版本无效，请重新打开窗口" }, { status: 400 });
    }
    const requestKey = String(request.headers.get("idempotency-key") || body.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,179}$/u.test(requestKey)) {
      return NextResponse.json({ error: "缺少有效的权限操作编号" }, { status: 400 });
    }
    const profileKey = body.sourceProfileKey == null || body.sourceProfileKey === "" ? null : String(body.sourceProfileKey);
    const profileVersion = profileKey === null ? null : Number(body.sourceProfileVersion);
    if (profileKey !== null && (!Number.isInteger(profileVersion) || Number(profileVersion) <= 0)) {
      return NextResponse.json({ error: "权限模板版本无效" }, { status: 400 });
    }
    const database = getSupabaseAdminClient();
    const { data, error } = await database.rpc("set_member_permissions_atomic", {
      p_admin_id: admin.userId,
      p_user_id: userId,
      p_feature_navigation_keys: featureNavigationKeys,
      p_agent_navigation_keys: agentNavigationKeys,
      p_expected_revision: expectedRevision,
      p_request_key: requestKey,
      p_reason: String(body.reason || "管理员调整会员功能权限").trim().slice(0, 500),
      p_source_profile_key: profileKey,
      p_source_profile_version: profileVersion,
    });
    if (error) {
      const migrationMissing = ["PGRST202", "42883", "42P01", "42703"].includes(String(error.code || ""));
      return NextResponse.json({
        error: migrationMissing ? "会员权限迁移尚未就绪，本次未修改" : "会员权限保存失败，本次未修改",
        code: migrationMissing ? "MEMBER_PERMISSION_MIGRATION_NOT_READY" : "MEMBER_PERMISSION_SAVE_FAILED",
      }, { status: 503 });
    }
    const receipt = (data || {}) as Record<string, unknown>;
    if (receipt.success !== true) {
      const code = String(receipt.code || "MEMBER_PERMISSION_SAVE_FAILED");
      const status = code.includes("REVISION_CONFLICT") || code.includes("IDEMPOTENCY_CONFLICT") ? 409
        : code.includes("NOT_FOUND") ? 404
          : code.includes("INTEGRITY") ? 503
            : 400;
      return NextResponse.json({
        error: code.includes("REVISION_CONFLICT")
          ? "该学员权限已在其他窗口更新，请重新载入后再保存"
          : code.includes("INTEGRITY")
            ? "权限快照完整性校验失败，本次未修改"
            : "会员权限未通过业务校验",
        code,
        currentRevision: receipt.current_revision,
      }, { status });
    }
    return NextResponse.json({ success: true, receipt });
  } catch (error) {
    console.error("Admin member permission save failed:", error);
    return NextResponse.json({ error: "会员权限保存失败，本次未修改" }, { status: 500 });
  }
}

