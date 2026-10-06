/**
 * 安全事件管理 API — 管理员查看综合安全事件
 *
 * GET: 查询安全事件列表（分页+筛选+统计摘要）
 * DELETE: 清理指定天数前的安全事件
 */
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  maskSecurityIp,
  maskSecurityPhone,
  maskSecurityUserId,
  normalizeSecurityEventDisplayText,
  redactSecurityListText,
} from "@/lib/security-event-display";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const SUMMARY_ROW_LIMIT = 10_000;

type SecurityEventRow = {
  id: string;
  event_type: string;
  risk_level: string;
  ip_address?: string | null;
  user_id?: string | null;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  source?: string | null;
  user_agent?: string | null;
  path?: string | null;
  method?: string | null;
  details?: string | null;
  blocked?: boolean | null;
  created_at: string;
};

type CurrentUserRow = {
  id: string;
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  status?: string | null;
};

function boundedInteger(raw: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  try {
    // 验证管理员权限
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "未登录", code: "ADMIN_AUTH_REQUIRED" }, 401);
    }
    const payload = await verifyAdminToken(authHeader.slice(7));
    if (!payload || payload.role !== "admin") {
      return json({ error: "无权限", code: "ADMIN_PERMISSION_REQUIRED" }, 403);
    }

    const url = new URL(request.url);
    const page = boundedInteger(url.searchParams.get("page"), 1, 1, 100_000);
    const pageSize = boundedInteger(url.searchParams.get("pageSize"), 20, 10, 100);
    const eventType = url.searchParams.get("eventType");
    const riskLevel = url.searchParams.get("riskLevel");
    const userId = url.searchParams.get("userId");
    const source = url.searchParams.get("source");             // 来源入口筛选
    const searchPhone = url.searchParams.get("phone");         // 手机号筛选
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");

    const client = getSupabaseClient();

    // 构建查询
    let query = client
      .from("security_events")
      .select("id,event_type,risk_level,ip_address,user_id,username,display_name,phone,source,user_agent,path,method,details,blocked,created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (eventType) query = query.eq("event_type", eventType);
    if (riskLevel) query = query.eq("risk_level", riskLevel);
    if (userId) query = query.eq("user_id", userId);
    if (source) query = query.eq("source", source);
    if (searchPhone) query = query.eq("phone", searchPhone);
    if (startDate) query = query.gte("created_at", startDate);
    if (endDate) query = query.lte("created_at", endDate);

    const { data, count, error } = await query;

    if (error) {
      console.error("[SecurityEvents] list query failed", error);
      return json({ error: "安全事件暂时不可用", code: "SECURITY_EVENTS_UNAVAILABLE" }, 503);
    }

    // One bounded read replaces three unbounded full-table scans. When the cap
    // is reached the response says so explicitly; sampled values are never
    // presented as exact totals.
    const summaryResult = await client
      .from("security_events")
      .select("event_type,risk_level,source,created_at,user_id,username,display_name,phone,details", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(SUMMARY_ROW_LIMIT);
    if (summaryResult.error) {
      console.error("[SecurityEvents] summary query failed", summaryResult.error);
      return json({ error: "安全摘要暂时不可用", code: "SECURITY_SUMMARY_UNAVAILABLE" }, 503);
    }
    const summaryRows = (summaryResult.data || []) as SecurityEventRow[];
    const summaryTotal = summaryResult.count || 0;
    const summaryCapped = summaryTotal > summaryRows.length;

    const byType: Record<string, number> = {};
    const byRisk: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const row of summaryRows) {
      const typeKey = normalizeSecurityEventDisplayText(row.event_type, { fallback: "unknown", maxLength: 80 });
      const riskKey = normalizeSecurityEventDisplayText(row.risk_level, { fallback: "unknown", maxLength: 32 });
      byType[typeKey] = (byType[typeKey] || 0) + 1;
      byRisk[riskKey] = (byRisk[riskKey] || 0) + 1;
      const sourceKey = redactSecurityListText(row.source, { fallback: "anonymous", maxLength: 80 });
      bySource[sourceKey] = (bySource[sourceKey] || 0) + 1;
    }

    // 今日事件数
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { count: todayCount } = await client
      .from("security_events")
      .select("id", { count: "exact", head: true })
      .gte("created_at", today.toISOString());

    // The ranking title says high risk, so only high/critical events belong in
    // its numerator. Historical labels remain evidence; current accounts are
    // read separately and used only as the present-day display label.
    const userCounts: Record<string, { count: number; username: string; display_name: string; phone: string; sources: string[] }> = {};
    for (const row of summaryRows) {
      if (!row.user_id || !["high", "critical"].includes(row.risk_level)) continue;
      if (!userCounts[row.user_id]) {
        userCounts[row.user_id] = {
          count: 0,
          username: row.username || "",
          display_name: row.display_name || "",
          phone: row.phone || "",
          sources: [],
        };
      }
      userCounts[row.user_id].count += 1;
      const safeSource = redactSecurityListText(row.source, { fallback: "unknown", maxLength: 80 });
      if (row.source && !userCounts[row.user_id].sources.includes(safeSource)) {
        userCounts[row.user_id].sources.push(safeSource);
      }
    }
    const rankedUsers = Object.entries(userCounts)
      .map(([id, info]) => ({ user_id: id, ...info }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const eventRows = (data || []) as SecurityEventRow[];
    const accountIds = [...new Set([
      ...eventRows.map((row) => row.user_id).filter((value) => Boolean(value) && value !== "unknown"),
      ...rankedUsers.map((row) => row.user_id),
    ])] as string[];
    const currentUsers = new Map<string, CurrentUserRow>();
    if (accountIds.length > 0) {
      const userResult = await client
        .from("users")
        .select("id,username,display_name,phone,status")
        .in("id", accountIds.slice(0, 100));
      if (userResult.error) {
        console.warn("[SecurityEvents] current account labels unavailable", userResult.error.code);
      } else {
        for (const user of (userResult.data || []) as CurrentUserRow[]) currentUsers.set(user.id, user);
      }
    }

    const normalizedEvents = eventRows.map((row) => {
      const current = row.user_id ? currentUsers.get(row.user_id) : undefined;
      const observedLabel = normalizeSecurityEventDisplayText(row.display_name || row.username, { fallback: "" });
      const currentLabel = normalizeSecurityEventDisplayText(current?.display_name || current?.username, { fallback: "" });
      return {
        ...row,
        event_type: normalizeSecurityEventDisplayText(row.event_type, { fallback: "unknown", maxLength: 80 }),
        risk_level: normalizeSecurityEventDisplayText(row.risk_level, { fallback: "unknown", maxLength: 32 }),
        user_id: row.user_id && row.user_id !== "unknown" ? maskSecurityUserId(row.user_id) : "",
        display_name: redactSecurityListText(currentLabel || observedLabel, { fallback: "", maxLength: 80 }),
        username: maskSecurityUserId(
          normalizeSecurityEventDisplayText(current?.username || row.username, { fallback: "" }),
        ),
        phone: maskSecurityPhone(current?.phone || row.phone),
        ip_address: row.ip_address && !["unknown", "api"].includes(row.ip_address) ? maskSecurityIp(row.ip_address) : "",
        source: redactSecurityListText(row.source, { fallback: "unknown", maxLength: 80 }),
        method: normalizeSecurityEventDisplayText(row.method, { fallback: "", maxLength: 16 }),
        path: redactSecurityListText(row.path, { fallback: "", maxLength: 240 }),
        user_agent: redactSecurityListText(row.user_agent, { fallback: "", maxLength: 240 }),
        details: redactSecurityListText(
          normalizeSecurityEventDisplayText(row.details, { fallback: "历史记录无可读说明", maxLength: 500 }),
          { maxLength: 500 },
        ),
        identity_status: current ? current.status || "current_account" : row.user_id ? "historical_or_deleted" : "anonymous",
        label_source: currentLabel ? "current_account" : observedLabel ? "historical_snapshot" : "anonymous",
      };
    });

    const topRiskyUsers = rankedUsers.map((row) => {
      const current = currentUsers.get(row.user_id);
      return {
        ...row,
        user_id: maskSecurityUserId(row.user_id),
        display_name: redactSecurityListText(
          normalizeSecurityEventDisplayText(current?.display_name || current?.username || row.display_name || row.username, { fallback: "历史用户" }),
          { fallback: "历史用户", maxLength: 80 },
        ),
        username: maskSecurityUserId(
          normalizeSecurityEventDisplayText(current?.username || row.username, { fallback: "" }),
        ),
        phone: maskSecurityPhone(current?.phone || row.phone),
        label_source: current ? "current_account" : "historical_snapshot",
      };
    });

    // 24小时内事件趋势（按小时）
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEvents } = await client
      .from("security_events")
      .select("created_at")
      .gte("created_at", yesterday);

    const hourlyTrend: Record<number, number> = {};
    recentEvents?.forEach((e: { created_at: string }) => {
      const hour = new Date(e.created_at).getHours();
      hourlyTrend[hour] = (hourlyTrend[hour] || 0) + 1;
    });

    const repairCandidates = summaryRows.flatMap((row) => [row.display_name, row.username, row.details]).filter(Boolean) as string[];
    const repairedFieldCount = repairCandidates.filter((value) => normalizeSecurityEventDisplayText(value, { fallback: "" }) !== value).length;
    return json({
      events: normalizedEvents,
      total: count || 0,
      page,
      pageSize,
      summary: {
        total: summaryTotal,
        todayCount: todayCount || 0,
        byType,
        byRisk,
        bySource,
        topRiskyUsers,
        hourlyTrend,
        asOf: new Date().toISOString(),
        observedAt: summaryRows[0]?.created_at || null,
        dataQuality: {
          summaryCapped,
          sampledRows: summaryRows.length,
          totalRows: summaryTotal,
          repairedFieldCount,
          sensitiveFields: "masked",
          historicalValuesPreserved: true,
        },
      },
    });
  } catch (error: unknown) {
    console.error("[SecurityEvents] unexpected read failure", error);
    return json({ error: "安全事件暂时不可用", code: "SECURITY_EVENTS_READ_FAILED" }, 500);
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Allow: "GET",
    },
  });
}
