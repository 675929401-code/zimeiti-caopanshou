/**
 * 诊断日志管理 API（管理员）
 *
 * GET:    查询诊断日志列表（分页+筛选+统计摘要）
 * DELETE: 清理指定天数前的诊断日志
 */
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const problemTypes = new Set([
  "chat_timeout", "send_failed", "stream_interrupted", "api_error",
  "payment_create_failed", "payment_callback_missing", "balance_not_updated", "payment_timeout",
  "video_submit_failed", "video_poll_timeout", "video_billing_error", "video_all_channels_down",
  "cover_generate_failed", "cover_workflow_timeout", "cover_billing_error",
  "auth_login_failed", "auth_token_expired", "auth_register_code_failed",
  "network_error", "page_crash", "slow_response", "render_error", "manual_report",
]);
const severities = new Set(["low", "medium", "high", "critical"]);
const statuses = new Set(["pending", "processing", "resolved", "ignored"]);

async function authorize(request: Request) {
  const header = request.headers.get("authorization");
  return authorizeAdminToken(header?.startsWith("Bearer ") ? header.slice(7) : null);
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export async function GET(request: Request) {
  try {
    const authorization = await authorize(request);
    if (!authorization.ok) return Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });

    const url = new URL(request.url);
    const page = Math.max(1, Math.min(100_000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
    const pageSize = Math.max(10, Math.min(100, Number.parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));
    const problemType = url.searchParams.get("problemType");
    const severity = url.searchParams.get("severity");
    const status = url.searchParams.get("status");
    const searchUser = url.searchParams.get("searchUser")?.trim() || null;
    const startDate = parseDate(url.searchParams.get("startDate"));
    const endDate = parseDate(url.searchParams.get("endDate"));
    if (problemType && !problemTypes.has(problemType)) return Response.json({ error: "问题类型无效" }, { status: 400 });
    if (severity && !severities.has(severity)) return Response.json({ error: "严重级别无效" }, { status: 400 });
    if (status && !statuses.has(status)) return Response.json({ error: "处理状态无效" }, { status: 400 });
    if (searchUser && (!/^[A-Za-z0-9@._\-\u3400-\u9FFF]{1,80}$/u.test(searchUser))) return Response.json({ error: "用户检索条件无效" }, { status: 400 });

    const client = getSupabaseClient();

    // 构建查询
    let query = client
      .from("diagnostic_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (problemType) query = query.eq("problem_type", problemType);
    if (severity) query = query.eq("severity", severity);
    if (status) query = query.eq("status", status);
    if (searchUser) query = query.or(`username.ilike.%${searchUser}%,display_name.ilike.%${searchUser}%`);
    if (startDate) query = query.gte("created_at", startDate);
    if (endDate) query = query.lte("created_at", endDate);

    const { data, count, error } = await query;

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    // 统计摘要
    const { data: typeStats } = await client
      .from("diagnostic_logs")
      .select("problem_type");

    const byType: Record<string, number> = {};
    typeStats?.forEach((s: { problem_type: string }) => {
      byType[s.problem_type] = (byType[s.problem_type] || 0) + 1;
    });

    const { data: severityStats } = await client
      .from("diagnostic_logs")
      .select("severity");

    const bySeverity: Record<string, number> = {};
    severityStats?.forEach((s: { severity: string }) => {
      bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
    });

    // 今日新增
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayCount } = await client
      .from("diagnostic_logs")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    // 待处理
    const { count: pendingCount } = await client
      .from("diagnostic_logs")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");

    return new Response(
      JSON.stringify({
        data,
        total: count,
        page,
        pageSize,
        summary: {
          total: count,
          today: todayCount,
          pending: pendingCount,
          byType,
          bySeverity,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[admin/diagnostic-logs] 查询异常:", err);
    return new Response(JSON.stringify({ error: "服务器异常" }), { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const authorization = await authorize(request);
    if (!authorization.ok) return Response.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });

    const body = await request.json();
    const days = Number(body.days || 30);
    const ids = body.ids; // 批量删除指定ID

    if (!Number.isInteger(days) || days < 30 || days > 3650) {
      return Response.json({ error: "清理天数必须为 30 至 3650 天" }, { status: 400 });
    }
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id)))) {
      return Response.json({ error: "日志 ID 列表无效" }, { status: 400 });
    }

    const client = getSupabaseClient();

    if (ids && Array.isArray(ids) && ids.length > 0) {
      // 按ID批量删除
      const { error } = await client
        .from("diagnostic_logs")
        .delete()
        .in("id", ids);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      return new Response(
        JSON.stringify({ success: true, deleted: ids.length }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // 按天数清理
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { error } = await client
      .from("diagnostic_logs")
      .delete()
      .lt("created_at", cutoff.toISOString());

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }

    return new Response(
      JSON.stringify({ success: true, message: `已清理 ${days} 天前的诊断日志` }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[admin/diagnostic-logs] 删除异常:", err);
    return new Response(JSON.stringify({ error: "服务器异常" }), { status: 500 });
  }
}
