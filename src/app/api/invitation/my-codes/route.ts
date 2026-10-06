import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

// GET /api/invitation/my-codes — 获取我的邀请码
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    const token = authHeader.replace("Bearer ", "");
    const payload = await verifyToken(token);
    if (!payload?.userId) {
      return NextResponse.json({ error: "登录已过期" }, { status: 401 });
    }
    const userId = payload.userId;

    const database = getSupabaseClient();
    const [codesResult, invitedCountResult, activatedCountResult, quotaResult] = await Promise.all([
      database
        .from("invitation_codes")
        .select("id, user_id, code, is_used, is_permanent, used_by, used_at, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false }),
      database
        .from("invitation_records")
        .select("id", { count: "exact", head: true })
        .eq("inviter_id", userId),
      database
        .from("invitation_records")
        .select("id", { count: "exact", head: true })
        .eq("inviter_id", userId)
        .eq("invitee_activated", true),
      database.rpc("get_invitation_code_quota", { p_user_id: userId }),
    ]);
    if (codesResult.error || invitedCountResult.error || activatedCountResult.error || quotaResult.error) {
      throw codesResult.error || invitedCountResult.error || activatedCountResult.error || quotaResult.error;
    }

    const codes = (codesResult.data || []).map((row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      user_id: String(row.user_id || ""),
      code: String(row.code || ""),
      is_used: row.is_used === true,
      is_permanent: false,
      used_by: row.used_by ? String(row.used_by) : null,
      used_at: row.used_at ? String(row.used_at) : null,
      created_at: String(row.created_at || ""),
    }));

    const stats = {
      totalInvited: Number(invitedCountResult.count || 0),
      activatedCount: Number(activatedCountResult.count || 0),
    };

    const quotaData = (quotaResult.data || {}) as Record<string, unknown>;
    const quota = {
      monthlyLimit: Number(quotaData.monthly_limit || 6),
      issuedThisMonth: Number(quotaData.issued_this_month || 0),
      remainingThisMonth: Number(quotaData.remaining_this_month || 0),
      resetsAt: String(quotaData.resets_at || ""),
      canGenerate: quotaData.can_generate === true,
    };

    return NextResponse.json({ success: true, codes, stats, quota });
  } catch (error) {
    console.error("[Invitation] My-codes error:", error);
    return NextResponse.json({ error: "实时邀请码数据暂时不可用" }, { status: 503 });
  }
}
