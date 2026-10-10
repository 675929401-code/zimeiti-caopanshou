import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { CONVERSATION_CONTENT_RETENTION_DAYS } from "@/lib/media-retention-policy";

const ADMIN_USER_SEARCH_COLUMNS = ["display_name", "username", "phone", "email"] as const;
const ADMIN_CONVERSATION_STATS_BATCH_SIZE = 1000;
const ADMIN_MESSAGE_COUNT_CONVERSATION_BATCH_SIZE = 100;

/**
 * Escape a literal value for a PostgreSQL ILIKE pattern embedded in a
 * PostgREST logical filter. Backslash is both PostgreSQL's default LIKE escape
 * character and PostgREST's quoted-value escape character, so it must be
 * escaped first.
 */
function escapeAdminUserSearchLiteral(value: string): string {
  return value
    .replace(/\\/gu, "\\\\\\\\")
    .replace(/"/gu, '\\"')
    .replace(/[%_]/gu, "\\\\$&");
}

/**
 * PostgREST treats commas and parentheses as logical-filter grammar unless the
 * value is quoted. Keep the outer % signs as contains wildcards while escaping
 * user-supplied % and _ so the search itself remains literal.
 */
function buildAdminUserSearchFilter(value: string): string {
  const pattern = `"%${escapeAdminUserSearchLiteral(value)}%"`;
  return ADMIN_USER_SEARCH_COLUMNS
    .map((column) => `${column}.ilike.${pattern}`)
    .join(",");
}

type AdminConversationScopeQuery = {
  in: (column: string, values: readonly string[]) => AdminConversationScopeQuery;
  eq: (column: string, value: string) => AdminConversationScopeQuery;
  gt: (column: string, value: string) => AdminConversationScopeQuery;
};

function adminChatRetentionCutoff(now = Date.now()) {
  return new Date(now - CONVERSATION_CONTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Apply the same user and agent scope to list and aggregate queries. */
function applyAdminConversationScope<T extends AdminConversationScopeQuery>(
  query: T,
  userIds: readonly string[],
  agentId: string,
  retentionCutoff: string,
): T {
  let scopedQuery = query.in("user_id", userIds).gt("updated_at", retentionCutoff) as T;
  if (agentId) {
    scopedQuery = scopedQuery.eq("agent_id", agentId) as T;
  }
  return scopedQuery;
}

type AdminConversationUsageRow = {
  id: string;
  agent_id: string | null;
  updated_at: string | null;
};

type AdminAgentUsageBucket = {
  agentId: string;
  agentName: string;
  conversationCount: number;
  messageCount: number;
  lastUsed: string;
  conversationIds: string[];
};

type AdminAgentUsageDto = Omit<AdminAgentUsageBucket, "conversationIds">;

function createAdminAgentUsageBuckets(
  conversations: readonly AdminConversationUsageRow[],
  agentNameMap: Readonly<Record<string, string>>,
): Record<string, AdminAgentUsageBucket> {
  const buckets: Record<string, AdminAgentUsageBucket> = {};
  conversations.forEach((conversation) => {
    const agentId = conversation.agent_id;
    if (!agentId) return;

    const updatedAt = conversation.updated_at || "";
    const bucket = buckets[agentId] || {
      agentId,
      agentName: agentNameMap[agentId] || "未知智能体",
      conversationCount: 0,
      messageCount: 0,
      lastUsed: updatedAt,
      conversationIds: [],
    };
    bucket.conversationCount += 1;
    bucket.conversationIds.push(conversation.id);
    if (updatedAt > bucket.lastUsed) {
      bucket.lastUsed = updatedAt;
    }
    buckets[agentId] = bucket;
  });
  return buckets;
}

function finalizeAdminAgentUsage(
  buckets: Readonly<Record<string, AdminAgentUsageBucket>>,
  messageCountMap: Readonly<Record<string, number>>,
): AdminAgentUsageDto[] {
  return Object.values(buckets)
    .map((bucket) => ({
      agentId: bucket.agentId,
      agentName: bucket.agentName,
      conversationCount: bucket.conversationCount,
      messageCount: messageCountMap[bucket.agentId] || 0,
      lastUsed: bucket.lastUsed,
    }))
    .sort((left, right) =>
      right.conversationCount - left.conversationCount
      || right.messageCount - left.messageCount
      || left.agentName.localeCompare(right.agentName, "zh-CN"),
    );
}

/** 管理员查看学员聊天记录
 * GET /api/admin/user-chats?user_id=xxx&agent_id=xxx&conversation_id=xxx&page=1&pageSize=20
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseClient();
    // 验证管理员权限
    const authHeader = req.headers.get("authorization");
    const cookieToken = req.cookies.get("auth_token")?.value;
    const token = authHeader?.replace("Bearer ", "") || cookieToken;

    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }

    const { verifyAdminToken } = await import("@/lib/admin-auth");
    const payload = await verifyAdminToken(token);
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "无权限" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("user_id");
    const agentId = searchParams.get("agent_id");
    const conversationId = searchParams.get("conversation_id");
    const page = parseInt(searchParams.get("page") || "1");
    const pageSize = parseInt(searchParams.get("pageSize") || "20");
    const retentionCutoff = adminChatRetentionCutoff();

    // 模式0：列出所有学员的会话（管理员全局视图）
    if (!userId && !conversationId) {
      const userName = searchParams.get("user_name") || "";
      const agentFilter = searchParams.get("agent_id") || "";

      // 先获取非管理员用户列表（支持按名称搜索）
      let userQuery = supabase
        .from("users")
        .select("id, display_name, username, phone, email, role")
        .neq("role", "admin")
        .limit(500);

      if (userName) {
        userQuery = userQuery.or(buildAdminUserSearchFilter(userName));
      }

      const { data: userList, error: userErr } = await userQuery;
      if (userErr) {
        return NextResponse.json({ error: userErr.message }, { status: 500 });
      }

      const scopedUserIds = (userList || []).map((u: any) => u.id as string);

      // 获取当前学员、搜索和智能体范围内的会话
      const convQuery = applyAdminConversationScope(
        supabase
          .from("conversations")
          .select("id, user_id, agent_id, source, created_at, updated_at", { count: "exact" }),
        scopedUserIds,
        agentFilter,
        retentionCutoff,
      )
        .order("updated_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      const { data: convData, count: convCount, error: convErr } = await convQuery;
      if (convErr) {
        return NextResponse.json({ error: convErr.message }, { status: 500 });
      }

      // 分批读取同范围内的全部会话，避免 PostgREST 行数上限截断统计。
      const allAgentStats: AdminConversationUsageRow[] = [];
      let statsOffset = 0;
      let statsTotal: number | null = null;
      while (true) {
        const statsQuery = applyAdminConversationScope(
          supabase
            .from("conversations")
            .select("id, agent_id, updated_at", { count: "exact" }),
          scopedUserIds,
          agentFilter,
          retentionCutoff,
        )
          .not("agent_id", "is", null)
          .order("id", { ascending: true })
          .range(statsOffset, statsOffset + ADMIN_CONVERSATION_STATS_BATCH_SIZE - 1);
        const { data: statsBatch, count: statsCount, error: statsError } = await statsQuery;
        if (statsError) {
          return NextResponse.json({ error: statsError.message }, { status: 500 });
        }

        const normalizedBatch = (statsBatch || []) as AdminConversationUsageRow[];
        if (statsTotal === null && typeof statsCount === "number") {
          statsTotal = statsCount;
        }
        allAgentStats.push(...normalizedBatch);
        if (
          normalizedBatch.length === 0
          || (statsTotal !== null && allAgentStats.length >= statsTotal)
          || (statsTotal === null && normalizedBatch.length < ADMIN_CONVERSATION_STATS_BATCH_SIZE)
        ) break;
        statsOffset += normalizedBatch.length;
      }

      // 名称映射同时覆盖当前页和统计范围内的全部智能体。
      const agentIds = [...new Set([
        ...(convData || []).map((conversation: any) => conversation.agent_id),
        ...allAgentStats.map((conversation) => conversation.agent_id),
      ].filter((agentId): agentId is string => typeof agentId === "string" && agentId.length > 0))];
      const agentNameMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: agents, error: agentsError } = await supabase
          .from("agents")
          .select("id, name")
          .in("id", agentIds);
        if (agentsError) {
          return NextResponse.json({ error: agentsError.message }, { status: 500 });
        }
        (agents || []).forEach((a: any) => { agentNameMap[a.id] = a.name; });
      }

      // 用户ID→名称映射
      const userNameMap: Record<string, string> = {};
      (userList || []).forEach((u: any) => {
        userNameMap[u.id] = u.display_name || u.username || u.phone || u.email || "未知";
      });

      // 批量获取消息数和最后消息（通过单次查询优化）
      const convIds = (convData || []).map((c: any) => c.id);
      const msgCountMap: Record<string, number> = {};
      const lastMsgMap: Record<string, string> = {};

      if (convIds.length > 0) {
        // 消息计数
        const { data: msgCounts } = await supabase
          .from("conversation_messages")
          .select("conversation_id")
          .in("conversation_id", convIds)
          .gt("created_at", retentionCutoff);
        (msgCounts || []).forEach((m: any) => {
          msgCountMap[m.conversation_id] = (msgCountMap[m.conversation_id] || 0) + 1;
        });

        // 每个会话最后一条用户消息
        const { data: lastMsgs } = await supabase
          .from("conversation_messages")
          .select("conversation_id, content")
          .in("conversation_id", convIds)
          .eq("role", "user")
          .gt("created_at", retentionCutoff)
          .order("created_at", { ascending: false });
        (lastMsgs || []).forEach((m: any) => {
          if (!lastMsgMap[m.conversation_id] && m.content) {
            lastMsgMap[m.conversation_id] = typeof m.content === "string" ? m.content.slice(0, 60) : "";
          }
        });
      }

      const conversations = (convData || []).map((conv: any) => ({
        id: conv.id,
        userId: conv.user_id,
        userName: userNameMap[conv.user_id] || "未知",
        agentName: agentNameMap[conv.agent_id] || "未知智能体",
        agentId: conv.agent_id || "",
        source: conv.source || "llm",
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        messageCount: msgCountMap[conv.id] || 0,
        lastMessage: lastMsgMap[conv.id] || "",
      }));

      // 智能体使用统计（与列表同范围，但不受分页影响）
      const agentUsageBuckets = createAdminAgentUsageBuckets(allAgentStats, agentNameMap);
      const messageCountResults = await Promise.all(
        Object.values(agentUsageBuckets).map(async (bucket) => {
          let messageCount = 0;
          for (
            let offset = 0;
            offset < bucket.conversationIds.length;
            offset += ADMIN_MESSAGE_COUNT_CONVERSATION_BATCH_SIZE
          ) {
            const conversationIdBatch = bucket.conversationIds.slice(
              offset,
              offset + ADMIN_MESSAGE_COUNT_CONVERSATION_BATCH_SIZE,
            );
            const { count, error } = await supabase
              .from("conversation_messages")
              .select("id", { count: "exact", head: true })
              .in("conversation_id", conversationIdBatch)
              .gt("created_at", retentionCutoff);
            if (error) {
              return { agentId: bucket.agentId, messageCount: 0, error };
            }
            messageCount += count || 0;
          }
          return { agentId: bucket.agentId, messageCount, error: null };
        }),
      );
      const messageCountError = messageCountResults.find((result) => result.error)?.error;
      if (messageCountError) {
        return NextResponse.json({ error: messageCountError.message }, { status: 500 });
      }
      const agentMessageCountMap = Object.fromEntries(
        messageCountResults.map((result) => [result.agentId, result.messageCount]),
      );
      const agentUsage = finalizeAdminAgentUsage(agentUsageBuckets, agentMessageCountMap);

      return NextResponse.json({
        conversations,
        total: convCount || 0,
        page,
        pageSize,
        agentUsage,
      });
    }

    // 模式1：查看学员的会话列表
    if (userId && !conversationId) {
      let query = supabase
        .from("conversations")
        .select("id, agent_id, source, created_at, updated_at", { count: "exact" })
        .eq("user_id", userId)
        .gt("updated_at", retentionCutoff)
        .order("updated_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);

      if (agentId) {
        query = query.eq("agent_id", agentId);
      }

      const { data, count, error } = await query;
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Get agent names and message info for each conversation
      const conversations = await Promise.all((data || []).map(async (conv: any) => {
        // Get agent name
        let agentName = "";
        if (conv.agent_id) {
          const { data: agent } = await supabase
            .from("agents")
            .select("name")
            .eq("id", conv.agent_id)
            .single();
          agentName = agent?.name || "";
        }

        // Get message count
        const { count: msgCount } = await supabase
          .from("conversation_messages")
          .select("*", { count: "exact", head: true })
          .eq("conversation_id", conv.id)
          .gt("created_at", retentionCutoff);

        // Get last user message
        const { data: lastMsg } = await supabase
          .from("conversation_messages")
          .select("content")
          .eq("conversation_id", conv.id)
          .eq("role", "user")
          .gt("created_at", retentionCutoff)
          .order("created_at", { ascending: false })
          .limit(1);

        const lastContent = lastMsg?.[0]?.content || "";
        const truncatedLast = typeof lastContent === "string" ? lastContent.slice(0, 60) : "";

        return {
          id: conv.id,
          agentName,
          agentId: conv.agent_id || "",
          source: conv.source || "llm",
          createdAt: conv.created_at,
          updatedAt: conv.updated_at,
          messageCount: msgCount || 0,
          lastMessage: truncatedLast,
        };
      }));

      return NextResponse.json({
        conversations,
        total: count || 0,
        page,
        pageSize,
      });
    }

    // 模式2：查看某个会话的消息内容
    if (conversationId) {
      const { data: messages, error } = await supabase
        .from("conversation_messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .gt("created_at", retentionCutoff)
        .order("created_at", { ascending: true });

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        messages: messages || [],
      });
    }

    return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  } catch (err) {
    console.error("[admin/user-chats] Error:", err);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
