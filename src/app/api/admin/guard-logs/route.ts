/**
 * 防护日志管理 API — 管理员查看提示词拦截统计
 */
import { verifyAdminToken } from "@/lib/admin-auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { AGENT_NAVIGATION_OPTIONS } from "@/lib/agent-category-access";
import {
  maskSecurityUserId,
  normalizeSecurityEventDisplayText,
  redactSecurityListText,
} from "@/lib/security-event-display";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
const GUARD_LOG_COLUMNS = "id,user_id,user_display_name,agent_name,agent_source,message_preview,risk_level,reason,matched_patterns,blocked_at";

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
    const source = url.searchParams.get("source"); // llm/coze/coding
    const riskLevel = url.searchParams.get("riskLevel"); // medium/high

    if (source && !new Set(["llm", "coze", "coding"]).has(source)) {
      return jsonResponse({ error: "来源筛选值无效", code: "INVALID_SOURCE" }, 400);
    }
    if (riskLevel && !new Set(["medium", "high"]).has(riskLevel)) {
      return jsonResponse({ error: "风险等级筛选值无效", code: "INVALID_RISK_LEVEL" }, 400);
    }

    const client = getSupabaseClient();

    // 构建查询
    let query = client
      .from("prompt_guard_logs")
      .select(GUARD_LOG_COLUMNS, { count: "exact" })
      .order("blocked_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (source) query = query.eq("agent_source", source);
    if (riskLevel) query = query.eq("risk_level", riskLevel);

    const { data, count, error } = await query;

    if (error) {
      console.error("[admin/guard-logs] list query failed", error);
      return jsonResponse({ error: "防护日志暂时不可用", code: "GUARD_LOGS_UNAVAILABLE" }, 503);
    }

    // 统计摘要
    const { data: stats, error: statsError } = await client
      .from("prompt_guard_logs")
      .select("agent_source, risk_level");
    if (statsError) {
      console.error("[admin/guard-logs] summary query failed", statsError);
      return jsonResponse({ error: "防护日志统计暂时不可用", code: "GUARD_LOGS_SUMMARY_UNAVAILABLE" }, 503);
    }

    // ── 关联用户学院信息 ──
    // 收集所有日志中的 user_id，从 users 表查 allowed_categories，再映射到分类名称
    const userIds = [...new Set((data || []).map((l: { user_id: string }) => l.user_id).filter(Boolean))];
    const userAcademyMap: Record<string, string> = {}; // user_id → 学院名称
    const userDisplayNameMap: Record<string, string> = {}; // user_id / username → 当前权威展示名

    if (userIds.length > 0) {
      try {
        // 按用户ID（可能是UUID）和用户名两种方式查找
        const { data: usersById } = await client
          .from("users")
          .select("id, username, display_name, allowed_categories")
          .in("id", userIds);
        const { data: usersByName } = await client
          .from("users")
          .select("id, username, display_name, allowed_categories")
          .in("username", userIds);

        // 合并去重
        type UserLookup = { display_name: string | null; allowed_categories: string[] | null };
        const userMap = new Map<string, UserLookup>();
        for (const u of (usersById || []) as Array<{ id: string; username: string; display_name: string | null; allowed_categories: string[] | null }>) {
          const lookup = { display_name: u.display_name, allowed_categories: u.allowed_categories };
          userMap.set(u.id, lookup);
          if (u.username) userMap.set(u.username, lookup);
        }
        for (const u of (usersByName || []) as Array<{ id: string; username: string; display_name: string | null; allowed_categories: string[] | null }>) {
          const lookup = { display_name: u.display_name, allowed_categories: u.allowed_categories };
          userMap.set(u.id, lookup);
          if (u.username) userMap.set(u.username, lookup);
        }

        // 获取所有分类
        const { data: categories } = await client
          .from("categories")
          .select("id, name");

        const catNameMap: Record<string, string> = {};
        for (const c of (categories || []) as Array<{ id: string; name: string }>) {
          catNameMap[c.id] = c.name;
        }
        for (const navigation of AGENT_NAVIGATION_OPTIONS) {
          catNameMap[navigation.key] = navigation.label;
        }

        // 为每个 user_id 映射学院名称
        for (const uid of userIds as string[]) {
          const userInfo = userMap.get(uid);
          if (userInfo?.display_name) {
            userDisplayNameMap[uid] = normalizeSecurityEventDisplayText(userInfo.display_name, {
              fallback: "未知用户",
              maxLength: 80,
            });
          }
          if (userInfo?.allowed_categories && Array.isArray(userInfo.allowed_categories) && userInfo.allowed_categories.length > 0) {
            const names = userInfo.allowed_categories
              .map((cid: string) => catNameMap[cid])
              .filter(Boolean);
            userAcademyMap[uid] = names.join("、") || "无智能体权限";
          } else {
            userAcademyMap[uid] = "无智能体权限";
          }
        }
      } catch (e) {
        console.error("[GuardLogs] Failed to fetch user academy info:", e);
      }
    }

    // 为每条日志注入 user_academy 字段
    const logsWithAcademy = (data || []).map((log: Record<string, unknown>) => {
      const rawUserId = String(log.user_id ?? "");
      const matchedPatterns = Array.isArray(log.matched_patterns)
        ? log.matched_patterns
            .map((pattern) => redactSecurityListText(pattern, { fallback: "", maxLength: 60 }))
            .filter(Boolean)
            .slice(0, 5)
        : [];
      return {
        id: String(log.id ?? ""),
        user_id: maskSecurityUserId(rawUserId),
        user_display_name: redactSecurityListText(
          userDisplayNameMap[rawUserId]
            || normalizeSecurityEventDisplayText(log.user_display_name, { fallback: "未知用户", maxLength: 80 }),
          { fallback: "未知用户", maxLength: 80 },
        ),
        user_academy: normalizeSecurityEventDisplayText(userAcademyMap[rawUserId], { fallback: "未配置", maxLength: 120 }),
        agent_name: redactSecurityListText(log.agent_name, { fallback: "未知智能体", maxLength: 120 }),
        agent_source: normalizeSecurityEventDisplayText(log.agent_source, { fallback: "unknown", maxLength: 40 }),
        message_preview: redactSecurityListText(log.message_preview, { fallback: "内容已隐藏", maxLength: 200 }),
        risk_level: normalizeSecurityEventDisplayText(log.risk_level, { fallback: "medium", maxLength: 20 }),
        reason: redactSecurityListText(log.reason, { fallback: "风险规则命中", maxLength: 160 }),
        matched_patterns: matchedPatterns,
        blocked_at: String(log.blocked_at ?? ""),
      };
    });

    const summary = {
      total: stats?.length || 0,
      bySource: {
        llm: stats?.filter((s: { agent_source: string }) => s.agent_source === "llm").length || 0,
        coze: stats?.filter((s: { agent_source: string }) => s.agent_source === "coze").length || 0,
        coding: stats?.filter((s: { agent_source: string }) => s.agent_source === "coding").length || 0,
      },
      byRisk: {
        high: stats?.filter((s: { risk_level: string }) => s.risk_level === "high").length || 0,
        medium: stats?.filter((s: { risk_level: string }) => s.risk_level === "medium").length || 0,
      },
    };

    return jsonResponse({
        logs: logsWithAcademy,
        total: count || 0,
        page,
        pageSize,
        summary,
      });
  } catch (error: unknown) {
    console.error("[admin/guard-logs] unexpected failure", error);
    return jsonResponse({ error: "防护日志服务暂时不可用", code: "GUARD_LOGS_INTERNAL_ERROR" }, 500);
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
