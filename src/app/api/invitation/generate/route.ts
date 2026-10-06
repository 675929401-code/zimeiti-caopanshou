import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

interface OneTimeCodeResult {
  ok?: boolean;
  code?: string | Record<string, unknown>;
  reused_open_code?: boolean;
  monthly_limit?: number;
  issued_this_month?: number;
  remaining_this_month?: number;
  resets_at?: string;
}

function serializeInvitationCode(row: Record<string, unknown>) {
  return {
    id: String(row.id || ""),
    user_id: String(row.user_id || ""),
    code: String(row.code || ""),
    is_used: row.is_used === true,
    is_permanent: false,
    used_by: row.used_by ? String(row.used_by) : null,
    used_at: row.used_at ? String(row.used_at) : null,
    created_at: String(row.created_at || ""),
  };
}

// POST /api/invitation/generate — 同一时间最多保留一枚未使用的一次性邀请码
export async function POST(request: Request) {
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
    const { data, error } = await database.rpc("create_one_time_invitation_code", {
      p_user_id: userId,
    });
    if (error) {
      console.error("[Invitation] Atomic one-time-code RPC error:", error.code || error.message);
      const migrationMissing = error.code === "PGRST202";
      return NextResponse.json(
        { error: migrationMissing ? "邀请码原子事务尚未部署，请联系管理员" : "邀请码生成失败，请重试" },
        { status: 503 },
      );
    }
    const result = data as OneTimeCodeResult | null;
    if (!result?.ok || !result.code || typeof result.code === "string") {
      const failureCode = typeof result?.code === "string" ? result.code : "INVITATION_GENERATION_FAILED";
      const quota = {
        monthlyLimit: Number(result?.monthly_limit || 6),
        issuedThisMonth: Number(result?.issued_this_month || 0),
        remainingThisMonth: Number(result?.remaining_this_month || 0),
        resetsAt: String(result?.resets_at || ""),
        canGenerate: false,
      };
      if (failureCode === "INVITATION_MONTHLY_LIMIT") {
        return NextResponse.json({
          error: `本月邀请码额度已用完（${quota.monthlyLimit} 枚），下月自动恢复`,
          code: failureCode,
          quota,
        }, { status: 429 });
      }
      if (failureCode === "INVITATION_OWNER_INVALID") {
        return NextResponse.json({ error: "当前账号不能生成邀请码", code: failureCode, quota }, { status: 403 });
      }
      return NextResponse.json({ error: "生成邀请码失败，请重试" }, { status: 500 });
    }

    const quota = {
      monthlyLimit: Number(result.monthly_limit || 6),
      issuedThisMonth: Number(result.issued_this_month || 0),
      remainingThisMonth: Number(result.remaining_this_month || 0),
      resetsAt: String(result.resets_at || ""),
      canGenerate: Number(result.remaining_this_month || 0) > 0 || result.reused_open_code === true,
    };

    return NextResponse.json({
      success: true,
      code: serializeInvitationCode(result.code),
      reusedOpenCode: result.reused_open_code === true,
      quota,
      message: result.reused_open_code === true
        ? "当前邀请码尚未使用，请先分享该码"
        : "一次性邀请码生成成功",
    });
  } catch (error) {
    console.error("[Invitation] Generate error:", error);
    return NextResponse.json({ error: "实时邀请码服务暂时不可用" }, { status: 503 });
  }
}
