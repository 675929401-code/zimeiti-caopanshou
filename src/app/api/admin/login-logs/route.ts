/**
 * 登录日志管理 API — 管理员查看登录日志
 */
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { beijingCalendarDayWindowStart } from "@/lib/beijing-history-window";
import {
  maskSecurityIp,
  maskSecurityUserId,
  normalizeSecurityEventDisplayText,
  redactSecurityListText,
} from "@/lib/security-event-display";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const LOGIN_LOG_COLUMNS = "id,user_id,username,display_name,ip_address,user_agent,login_method,status,fail_reason,created_at";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function GET(request: Request) {
  try {
    // 验证管理员权限
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "未登录", code: "AUTH_REQUIRED" }, 401);
    }
    const payload = await verifyAdminToken(authHeader.slice(7));
    if (!payload || payload.role !== "admin") {
      return jsonResponse({ error: "无权限", code: "ADMIN_REQUIRED" }, 403);
    }

    const url = new URL(request.url);
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize"), 20, 1, 100);
    const userId = url.searchParams.get("userId");
    const status = url.searchParams.get("status"); // success/failed
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    if (status && !new Set(["success", "failed"]).has(status)) {
      return jsonResponse({ error: "登录状态筛选值无效", code: "INVALID_STATUS" }, 400);
    }

    const client = getSupabaseClient();

    // 构建查询
    let query = client
      .from("login_logs")
      .select(LOGIN_LOG_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (userId) query = query.eq("user_id", userId);
    if (status) query = query.eq("status", status);
    if (startDate) query = query.gte("created_at", startDate);
    if (endDate) query = query.lte("created_at", endDate);

    const { data, count, error } = await query;

    if (error) {
      console.error("[admin/login-logs] list query failed", error);
      return jsonResponse({ error: "登录日志暂时不可用", code: "LOGIN_LOGS_UNAVAILABLE" }, 503);
    }

    // 统计摘要
    let statsQuery = client
      .from("login_logs")
      .select("status, login_method");
    if (userId) statsQuery = statsQuery.eq("user_id", userId);
    const { data: stats, error: statsError } = await statsQuery;
    if (statsError) {
      console.error("[admin/login-logs] summary query failed", statsError);
      return jsonResponse({ error: "登录日志统计暂时不可用", code: "LOGIN_LOGS_SUMMARY_UNAVAILABLE" }, 503);
    }

    const summary = {
      total: stats?.length || 0,
      success: stats?.filter((s: { status: string }) => s.status === "success").length || 0,
      failed: stats?.filter((s: { status: string }) => s.status === "failed").length || 0,
      today: 0,
    };

    // 今日统计
    const todayStart = beijingCalendarDayWindowStart(new Date(), 1);
    let todayQuery = client
      .from("login_logs")
      .select("id", { count: "exact", head: true })
      .gte("created_at", todayStart)
      .eq("status", "success");
    if (userId) todayQuery = todayQuery.eq("user_id", userId);
    const { count: todayCount, error: todayError } = await todayQuery;
    if (todayError) {
      console.error("[admin/login-logs] today query failed", todayError);
      return jsonResponse({ error: "今日登录统计暂时不可用", code: "LOGIN_LOGS_TODAY_UNAVAILABLE" }, 503);
    }
    summary.today = todayCount || 0;

    const logs = (data || []).map((row: Record<string, unknown>) => ({
      id: String(row.id ?? ""),
      user_id: maskSecurityUserId(row.user_id),
      username: maskSecurityUserId(row.username),
      display_name: redactSecurityListText(
        normalizeSecurityEventDisplayText(row.display_name, { fallback: "未知用户", maxLength: 80 }),
        { fallback: "未知用户", maxLength: 80 },
      ),
      ip_address: maskSecurityIp(row.ip_address),
      user_agent: redactSecurityListText(row.user_agent, { fallback: "unknown", maxLength: 240 }),
      login_method: normalizeSecurityEventDisplayText(row.login_method, { fallback: "unknown", maxLength: 40 }),
      status: normalizeSecurityEventDisplayText(row.status, { fallback: "unknown", maxLength: 20 }),
      fail_reason: row.fail_reason
        ? redactSecurityListText(row.fail_reason, { fallback: "失败原因无法识别", maxLength: 160 })
        : "",
      created_at: String(row.created_at ?? ""),
    }));

    return jsonResponse({
        logs,
        total: count || 0,
        page,
        pageSize,
        summary,
      });
  } catch (error: unknown) {
    console.error("[admin/login-logs] unexpected failure", error);
    return jsonResponse({ error: "登录日志服务暂时不可用", code: "LOGIN_LOGS_INTERNAL_ERROR" }, 500);
  }
}

/** Audit evidence is retired only by the separately controlled retention job. */
export async function DELETE() {
  return new Response(JSON.stringify({
    success: false,
    error: "审计证据由受控保留策略管理，不能从该列表直接销毁",
    code: "AUDIT_EVIDENCE_RETENTION_MANAGED",
    managedRetention: true,
  }), {
    status: 405,
    headers: { ...JSON_HEADERS, Allow: "GET" },
  });
}
