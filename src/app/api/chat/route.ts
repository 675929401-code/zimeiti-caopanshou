/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是 Coze 对话后端路由，SSE 代理 + 积分扣费 + usage 提取。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #8 Coze 对话链路"。
 *
 * 锁定范围：整个文件
 * 锁定原因：SSE 透传稳定性 + 积分扣费准确性 + 流式输出一致性
 *
 * Coze Chat API 代理路由 — 含积分扣费
 *
 * 流程：
 * 1. 验证用户身份 + 积分余额检查
 * 2. 代理 Coze /v3/chat SSE 流
 * 3. 拦截流中的 usage 信息（token 用量）
 * 4. 流结束后按计费引擎扣费
 *
 * Coze v3/chat SSE 事件格式：
 * - event: conversation.chat.created
 * - event: conversation.message.delta  → 增量内容
 * - event: conversation.message.completed → 完整消息
 * - event: conversation.chat.completed → 对话结束，含 usage
 */

import { streamChat, getCozeConfig } from "@/lib/coze-api";
import { calculateCredits } from "@/lib/billing";
import { verifyToken } from "@/lib/auth";
import {
  getSelectedModelBillingSnapshot,
  settleLlmUsage,
  type SelectedModelBillingSnapshot,
} from "@/lib/llm-billing";
import {
  completeLlmAttemptResponse,
  createLlmAttemptLeaseOwner,
  DatabaseLlmRequestAttemptStore,
  finalizeLlmAttemptFromThrownError,
  fingerprintLlmRequest,
  LlmRequestIdempotencyError,
  responseForLlmAttemptClaim,
  type LlmRequestAttemptExecution,
  validateLlmClientRequestId,
} from "@/lib/llm-request-idempotency";

import { detectSuspiciousBody, trackAgentSwitch, detectApiAbuse, trackIPSecurityEvent, logSecurityEvent, getClientIP as getSecIP, getUserAgent as getSecUA } from "@/lib/security";

import { getSupabaseClient } from "@/storage/database/supabase-client";
import { checkPromptInjectionAsync, logGuardBlock, getBlockMessage } from "@/lib/prompt-guard";
import { toPublicModelId } from "@/lib/public-model-dto";
import {
  getAgentNavigationKey,
  normalizeAllowedAgentCategoryIds,
  resolveAllowedAgentNavigationKeys,
} from "@/lib/agent-category-access";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";

// ⚡ 流式路由强制动态渲染 — 防止 Next.js 静态优化缓冲 SSE
export const dynamic = 'force-dynamic';

const cozeRequestAttemptStore = new DatabaseLlmRequestAttemptStore();

type CozeAgentRow = {
  id: string;
  name?: string | null;
  bot_id: string;
  model_id?: string | null;
  base_fee?: number | string | null;
  user_access?: string | null;
  category?: string | null;
  is_active?: boolean | null;
};

type CozeUsage = { input_tokens: number; output_tokens: number };

function finiteNonNegative(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function parseSseFrame(frame: string): {
  eventType: string;
  data: string;
  payload: Record<string, unknown> | null;
} {
  let eventType = "";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data || data === "[DONE]") return { eventType, data, payload: null };
  try {
    const parsed: unknown = JSON.parse(data);
    return {
      eventType,
      data,
      payload: parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null,
    };
  } catch {
    return { eventType, data, payload: null };
  }
}

function readCozeUsage(payload: Record<string, unknown> | null): CozeUsage | null {
  const raw = payload?.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const input = finiteNonNegative(usage.input_count);
  const output = finiteNonNegative(usage.output_count);
  const total = finiteNonNegative(usage.token_count);
  const prompt = finiteNonNegative(usage.prompt_token_count);
  const completion = finiteNonNegative(usage.completion_token_count)
    ?? finiteNonNegative(usage.output_token_count);
  if (input !== null && output !== null) return { input_tokens: input, output_tokens: output };
  if (total !== null && output !== null) {
    return { input_tokens: Math.max(0, total - output), output_tokens: output };
  }
  if (total !== null) return { input_tokens: 0, output_tokens: total };
  if (prompt !== null) return { input_tokens: prompt, output_tokens: completion ?? 0 };
  return null;
}

function encodeSseError(code: string, message: string): Uint8Array {
  return new TextEncoder().encode(
    `event: error\ndata: ${JSON.stringify({ error: message, code, retryable: false })}\n\n`,
  );
}

async function persistCompletedCozeConversation(input: {
  conversationId?: string;
  cozeConversationId: string;
  userId: string;
  agentId: string;
  message: string;
  answer: string;
}): Promise<void> {
  const dbConversationId = input.cozeConversationId || input.conversationId;
  if (!dbConversationId) return;
  const supabase = getSupabaseClient();
  const needsMigration = Boolean(
    input.cozeConversationId
      && input.conversationId
      && input.cozeConversationId !== input.conversationId,
  );
  if (needsMigration && input.conversationId) {
    const oldMessages = await supabase.from("conversation_messages")
      .delete().eq("conversation_id", input.conversationId);
    if (oldMessages.error) throw new Error("旧会话消息迁移失败");
    const oldConversation = await supabase.from("conversations")
      .delete().eq("id", input.conversationId);
    if (oldConversation.error) throw new Error("旧会话迁移失败");
  }
  const now = new Date().toISOString();
  const conversation = await supabase.from("conversations").upsert({
    id: dbConversationId,
    user_id: input.userId,
    agent_id: input.agentId,
    title: input.message.slice(0, 50),
    source: "coze",
    updated_at: now,
  }, { onConflict: "id" });
  if (conversation.error) throw new Error("会话记录保存失败");
  const messages = await supabase.from("conversation_messages").insert([
    {
      id: crypto.randomUUID(),
      conversation_id: dbConversationId,
      user_id: input.userId,
      agent_id: input.agentId,
      role: "user",
      content: input.message,
      created_at: now,
    },
    {
      id: crypto.randomUUID(),
      conversation_id: dbConversationId,
      user_id: input.userId,
      agent_id: input.agentId,
      role: "assistant",
      content: input.answer,
      created_at: new Date(Date.now() + 1).toISOString(),
    },
  ]);
  if (messages.error) throw new Error("会话消息保存失败");
}

export async function POST(request: Request) {
  let activeCozeAttempt: LlmRequestAttemptExecution | null = null;
  let cozeProviderCallStarted = false;
  try {
    const body = await request.json();
    const { botId, message, conversationId, images } = body;
    const headerClientRequestId = request.headers.get("idempotency-key")?.trim() || "";
    const bodyClientRequestId = typeof body.client_request_id === "string" ? body.client_request_id.trim() : "";
    if (headerClientRequestId && bodyClientRequestId && headerClientRequestId !== bodyClientRequestId) {
      return new Response(
        JSON.stringify({ error: "对话请求标识不一致", code: "LLM_IDEMPOTENCY_KEY_MISMATCH" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const clientRequestId = headerClientRequestId || bodyClientRequestId;
    if (!clientRequestId) {
      return new Response(
        JSON.stringify({ error: "缺少稳定的对话请求标识", code: "LLM_IDEMPOTENCY_KEY_REQUIRED", retryable: false }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    try {
      validateLlmClientRequestId(clientRequestId);
    } catch (error) {
      if (error instanceof LlmRequestIdempotencyError) {
        return new Response(
          JSON.stringify({ error: error.message, code: error.code, retryable: false }),
          { status: error.status, headers: { "Content-Type": "application/json" } },
        );
      }
      throw error;
    }

    if (typeof botId !== "string" || !botId.trim() || typeof message !== "string" || !message.trim()) {
      return new Response(
        JSON.stringify({ error: "botId and message are required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── ⚡ 性能优化：Token 只验证一次，全局复用 ──
    // 之前代码在 5 个分支中各自调用 verifyToken，造成 ~5x JWT 解析开销
    const authHeader = request.headers.get("authorization");
    const tokenPayload = authHeader?.startsWith("Bearer ")
      ? await verifyToken(authHeader.slice(7)).catch(() => null)
      : null;

    // ⚠️ 安全修复：不再从 body 获取 userId，仅从 JWT 提取（防止冒用他人积分）
    const verifiedUserId = tokenPayload?.userId;
    const userRole = tokenPayload?.role;

    // ── 强制认证检查：无有效 JWT 时直接拒绝（提前到安全检查之前） ──
    if (!verifiedUserId) {
      return new Response(
        JSON.stringify({ error: "请先登录", code: "UNAUTHORIZED" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const secIP = getSecIP(request);
    const secUA = getSecUA(request);

    // ── 安全防护1：POST请求体注入检测（SQL注入/XSS/路径遍历） ──
    const bodySuspicious = detectSuspiciousBody(body, ["agentName", "botId"]);
    if (bodySuspicious.suspicious) {
      const riskLevel = bodySuspicious.threatType === "sql_injection" ? "critical" as const : "high" as const;
      trackIPSecurityEvent(secIP, riskLevel);

      const eventType = bodySuspicious.threatType === "sql_injection" ? "sql_injection"
        : bodySuspicious.threatType === "xss" ? "xss_attempt"
        : "path_traversal";
      // ⚡ 日志异步不阻塞响应
      logSecurityEvent({
        event_type: eventType,
        risk_level: riskLevel,
        ip: secIP,
        user_agent: secUA,
        path: "/api/chat",
        method: "POST",
        details: bodySuspicious.details,
        blocked: true,
        user_id: verifiedUserId,
        username: tokenPayload?.username,
        display_name: tokenPayload?.displayName,
      }).catch(() => {});

      return new Response(
        JSON.stringify({ error: "请求包含非法内容", code: "SUSPICIOUS_BODY" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 安全防护2：可疑行为检测（频繁切换智能体） ──
    const agentSwitchResult = trackAgentSwitch(secIP, verifiedUserId, botId);
    if (agentSwitchResult.suspicious) {
      // ⚡ 日志异步不阻塞响应
      logSecurityEvent({
        event_type: "suspicious_behavior",
        risk_level: "medium",
        ip: secIP,
        user_agent: secUA,
        path: "/api/chat",
        method: "POST",
        details: agentSwitchResult.reason || `频繁切换智能体: ${agentSwitchResult.switchCount}次/${agentSwitchResult.uniqueAgents}个`,
        blocked: true,
        user_id: verifiedUserId,
        username: tokenPayload?.username,
        display_name: tokenPayload?.displayName,
      }).catch(() => {});

      return new Response(
        JSON.stringify({ error: "操作过于频繁，请稍后再试", code: "SUSPICIOUS_BEHAVIOR" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 安全防护3：API滥用检测（短时间大量聊天请求） ──
    const abuseResult = detectApiAbuse(secIP, "POST", "/api/chat", verifiedUserId);
    if (abuseResult.abuse) {
      trackIPSecurityEvent(secIP, abuseResult.riskLevel);
      // ⚡ 日志异步不阻塞响应
      logSecurityEvent({
        event_type: "api_abuse",
        risk_level: abuseResult.riskLevel,
        ip: secIP,
        user_agent: secUA,
        path: "/api/chat",
        method: "POST",
        details: `5分钟内${abuseResult.count}次聊天请求（阈值${abuseResult.limit}次）`,
        blocked: true,
        user_id: verifiedUserId,
        username: tokenPayload?.username,
        display_name: tokenPayload?.displayName,
      }).catch(() => {});

      return new Response(
        JSON.stringify({ error: "请求次数过多，请稍后再试", code: "API_ABUSE" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    // ── 提示词注入检测（内置规则 + 管理员自定义关键词） ──
    const cozeConfigPromise = getCozeConfig();
    const guardResult = await checkPromptInjectionAsync(message, { isAdmin: false });
    if (guardResult.blocked) {
      // 记录拦截日志（异步不阻塞）
      logGuardBlock({
        user_id: verifiedUserId || "pending_verify",
        agent_name: botId,
        agent_source: "coze",
        message_preview: message,
        risk_level: guardResult.riskLevel as "medium" | "high",
        reason: guardResult.reason || "提示词注入拦截",
        matched_patterns: guardResult.matchedPatterns,
        blocked_at: new Date().toISOString(),
      }).catch(() => {});

      // 返回拦截响应（使用 SSE 格式，让前端正常处理）
      const blockMsg = getBlockMessage(guardResult.reason);
      const blockEvent = `event: conversation.message.delta\ndata: ${JSON.stringify({ type: "answer", content: blockMsg, content_type: "text" })}\n\n`;
      return new Response(blockEvent, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // ── Coze智能体消息：保持纯净，不注入额外内容 ──
    const securedMessage = message;

    // ── 服务端计费绑定：botId → agent.model_id → 已发布公共模型 → 不可变价格快照 ──
    // 客户端传入的 agentId/agentName/baseFee 均不得参与授权或定价。
    const dataClient = getSupabaseClient();
    const agentResult = await dataClient.from("agents")
      .select("id, name, bot_id, model_id, base_fee, user_access, category, is_active")
      .eq("bot_id", botId)
      .is("deleted_at", null)
      .single();
    if (agentResult.error || !agentResult.data) {
      return new Response(
        JSON.stringify({ error: "该智能体没有可核验的服务端配置", code: "COZE_AGENT_NOT_AVAILABLE" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    const serverAgent = agentResult.data as CozeAgentRow;

    // The management role and product entitlements are intentionally separate.
    // Every account, including an administrator, must pass the same durable
    // Agent-navigation snapshot before a provider/model lookup or charge can
    // begin.  A missing/corrupt authority fails closed.
    const permission = await readMemberPermissionSnapshot(verifiedUserId, { knownRole: userRole });
    if (permission.authorityStatus !== "ready" || !permission.integrityValid) {
      return new Response(
        JSON.stringify({
          error: "会员权限校验暂不可用，本次未调用模型",
          code: permission.authorityStatus === "invalid"
            ? "MEMBER_PERMISSION_INTEGRITY_INVALID"
            : "MEMBER_PERMISSION_AUTHORITY_UNAVAILABLE",
          retryable: true,
        }),
        { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    const permissionNavigationKey = getAgentNavigationKey({
      id: String(serverAgent.id || ""),
      name: String(serverAgent.name || ""),
      category: serverAgent.category,
    });
    if (!permissionNavigationKey || !permission.agentNavigationKeys.includes(permissionNavigationKey)) {
      return new Response(
        JSON.stringify({
          error: "当前账号未开通该智能体分类",
          code: "CATEGORY_ACCESS_DENIED",
          retryable: false,
        }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    const internalModelId = String(serverAgent.model_id || "").trim();
    if (!internalModelId) {
      return new Response(
        JSON.stringify({
          error: "该智能体未绑定可核验的计费模型，已阻止上游调用",
          code: "COZE_MODEL_BINDING_REQUIRED",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const modelResult = await dataClient.from("llm_models")
      .select("*")
      .eq("id", internalModelId)
      .eq("is_active", true)
      .neq("is_hidden", true)
      .neq("user_access", "hidden")
      .single();
    const modelRow = modelResult.data as Record<string, unknown> | null;
    if (modelResult.error || !modelRow) {
      return new Response(
        JSON.stringify({
          error: "该智能体绑定的模型未发布或不可用，已阻止上游调用",
          code: "COZE_PUBLIC_MODEL_NOT_AVAILABLE",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const publicModelId = toPublicModelId("llm", internalModelId);
    const rawBillingSnapshot = await getSelectedModelBillingSnapshot(publicModelId, modelRow);
    if (!rawBillingSnapshot) {
      return new Response(
        JSON.stringify({
          error: "该智能体绑定模型的 Token 计费配置未就绪，已阻止上游调用",
          code: "COZE_MODEL_TOKEN_PRICING_NOT_READY",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const baseFeeRmb = finiteNonNegative(serverAgent.base_fee);
    if (baseFeeRmb === null) {
      return new Response(
        JSON.stringify({ error: "该智能体基础费用配置无效", code: "COZE_BASE_FEE_INVALID" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    const baseFeeCredits = Math.ceil(baseFeeRmb * rawBillingSnapshot.config.creditsPerYuan);
    const selectedModelBillingSnapshot: SelectedModelBillingSnapshot = {
      ...rawBillingSnapshot,
      priceSnapshot: {
        ...rawBillingSnapshot.priceSnapshot,
        billingSource: "coze_bound_public_model",
        agentId: serverAgent.id,
        botId,
        baseFeeRmb,
        baseFeeCredits,
      },
    };
    const serverAgentName = String(serverAgent.name || `Coze:${botId}`).trim() || `Coze:${botId}`;

    // ── 预热Coze配置缓存（后续 await 时已是缓存值）──
    // ── 并行化：积分预检 + 智能体权限 + 分类权限 ──
    // 管理岗位不自动获得产品侧免费、隐藏内容或会员限制豁免。
    if (verifiedUserId) {
      const client = getSupabaseClient();
      const [creditsResult, allCatsResult] = await Promise.all([
        // 积分查询（含会员状态 + 用户状态 + allowed_categories）— 一次查询拿到所有用户字段
        (async () => { try { return await client.from("users").select("credits, member_status, member_expires_at, status, allowed_categories").eq("id", verifiedUserId).single(); } catch { return { data: null }; } })(),
        // ⚡ 分类查询并行化（之前是串行，节省一次 RTT）
        (async () => { try { return await client.from("categories").select("id, name, visibility, is_active"); } catch { return { data: null }; } })(),
      ]);

      // ── 最高优先级：检查用户是否被拉黑（blocked）──
      const userRow = creditsResult?.data as { credits: number; member_status?: string; member_expires_at?: string; status?: string; allowed_categories?: string[] | null } | null;
      if (userRow?.status === "blocked") {
        return new Response(
          JSON.stringify({ error: "您的账户已被管理员拉黑，消息无法发送", code: "USER_BLOCKED" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // ── 优先检查智能体用户权限（403 优先于 402） ──
      const agentRow = serverAgent;
      // ── 1. 检查智能体是否已下架（is_active=false，最高优先级） ──
      if (agentRow && agentRow.is_active === false) {
        return new Response(
          JSON.stringify({ error: "该智能体已下架，暂不可使用", code: "AGENT_INACTIVE" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      // ── 2. 检查智能体用户权限（hidden） ──
      if (agentRow && agentRow.user_access === "hidden") {
        return new Response(
          JSON.stringify({ error: "该智能体当前不可使用", code: "AGENT_ACCESS_DENIED" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      // ── 3. 检查分类状态和智能体导航栏权限 ──
      if (!agentRow?.category) {
        return new Response(
          JSON.stringify({ error: "该智能体尚未配置可用导航栏", code: "AGENT_ACCESS_DENIED" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      if (agentRow?.category) {
        const allCats = (allCatsResult?.data || []) as { id: string; name: string; visibility?: string; is_active?: boolean }[];
        const agentCat = allCats.find((c) => c.name === agentRow.category);
        if (!agentCat || agentCat.is_active === false || agentCat.visibility === "private") {
          return new Response(
            JSON.stringify({ error: "该智能体当前不可使用", code: "AGENT_ACCESS_DENIED" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
        const allowedNavigationKeys = resolveAllowedAgentNavigationKeys(
          normalizeAllowedAgentCategoryIds(userRow?.allowed_categories),
          allCats,
          [{ id: String(agentRow.id || ""), name: String(agentRow.name || ""), category: agentRow.category }],
        );
        const navigationKey = getAgentNavigationKey({
          id: String(agentRow.id || ""),
          name: String(agentRow.name || ""),
          category: agentRow.category,
        });
        if (!navigationKey || !allowedNavigationKeys.includes(navigationKey)) {
          return new Response(
            JSON.stringify({ error: "您暂无该智能体导航栏的使用权限，请联系管理员开通", code: "CATEGORY_ACCESS_DENIED" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // ── 权限通过后，再检查会员状态和积分 ──
      // 会员状态拦截（inactive/expired 用户禁止使用智能体）
      let ms = userRow?.member_status;
      // 会员过期自动检测：active + 过期时间已过 → expired
      if (ms === "active" && userRow?.member_expires_at && new Date(userRow.member_expires_at) < new Date()) {
        ms = "expired";
      }
      if (ms === "inactive" || ms === "expired") {
        return new Response(
          JSON.stringify({ error: ms === "inactive" ? "您的会员尚未激活，请联系管理员或使用卡密兑换激活" : "您的会员已过期，请联系管理员续费或使用卡密兑换", code: "MEMBERSHIP_REQUIRED" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      // 积分预检：只使用服务端已绑定公共模型的价格快照与基础费用。
      const user = userRow;
      const estimate = calculateCredits(
        selectedModelBillingSnapshot.config,
        200,
        100,
        0,
        baseFeeCredits,
      );
      const minRequired = Math.max(1, Math.ceil(estimate.creditsCharged));
      if (!user || user.credits < minRequired) {
        return new Response(
          JSON.stringify({
            error: `积分不足，至少需要 ${minRequired} 积分才能发起对话，当前余额 ${Math.floor(user?.credits ?? 0)} 积分`,
            code: "INSUFFICIENT_CREDITS",
            min_required: minRequired,
            current_credits: Math.floor(user?.credits ?? 0),
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // ── durable exactly-once 提交门禁：与 /api/llm 共用数据库状态机 ──
    try {
      const claim = await cozeRequestAttemptStore.claim({
        userId: verifiedUserId,
        clientRequestId,
        payloadFingerprint: fingerprintLlmRequest({
          source: "coze",
          botId,
          agentId: serverAgent.id,
          publicModelId: selectedModelBillingSnapshot.publicModelId,
          baseFeeCredits,
          conversationId: conversationId || "",
          message,
          images: Array.isArray(images) ? images : [],
        }),
        leaseOwner: createLlmAttemptLeaseOwner(),
      });
      if (claim.action !== "execute") return responseForLlmAttemptClaim(claim);
      activeCozeAttempt = claim.execution;
    } catch (error) {
      if (error instanceof LlmRequestIdempotencyError) {
        return new Response(
          JSON.stringify({ error: error.message, code: error.code, retryable: false }),
          { status: error.status, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          error: "无法确认对话请求是否已提交。为避免重复调用和扣费，本次未调用模型。",
          code: "LLM_IDEMPOTENCY_STORE_UNAVAILABLE",
          retryable: false,
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── 调用 Coze API（使用追加安全前缀的消息）──
    const cozeConfig = await cozeConfigPromise;
    if (!activeCozeAttempt) throw new Error("COZE_ATTEMPT_NOT_CLAIMED");
    activeCozeAttempt = await cozeRequestAttemptStore.markProviderCallStarted(activeCozeAttempt);
    cozeProviderCallStarted = true;
    const response = await streamChat(botId, verifiedUserId, securedMessage, conversationId, cozeConfig, images);

    if (!response.ok) {
      const errorText = await response.text();
      return await completeLlmAttemptResponse(cozeRequestAttemptStore, activeCozeAttempt, new Response(
        JSON.stringify({ error: `Coze API error: ${errorText}` }),
        { status: response.status, headers: { "Content-Type": "application/json" } }
      ));
    }

    const stream = response.body;
    if (!stream) {
      return await completeLlmAttemptResponse(cozeRequestAttemptStore, activeCozeAttempt, new Response(
        JSON.stringify({ error: "No stream from Coze API" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      ));
    }

    // ── SSE 代理：增量可流式展示，所有成功终态必须等原子钱包结算成功后再释放 ──
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let chatUsage: CozeUsage | null = null;
    let fullContent = "";
    let cozeConversationId = "";
    let upstreamCompleted = false;
    let upstreamFailed = false;
    let upstreamFailureMessage = "Coze 上游未完成对话";
    let hasDoneFrame = false;
    const terminalFrames: string[] = [];

    const billingStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const processFrame = (rawFrame: string): void => {
          if (!rawFrame.trim()) return;
          const frame = `${rawFrame}\n\n`;
          const parsed = parseSseFrame(rawFrame);
          const payload = parsed.payload;
          const payloadConversationId = typeof payload?.conversation_id === "string"
            ? payload.conversation_id.trim()
            : "";
          if (payloadConversationId && !cozeConversationId) cozeConversationId = payloadConversationId;

          const payloadType = typeof payload?.type === "string" ? payload.type : "";
          const payloadContent = typeof payload?.content === "string" ? payload.content : "";
          if (payloadType === "answer" && payloadContent) {
            if (parsed.eventType === "conversation.message.completed") fullContent = payloadContent;
            else if (parsed.eventType === "conversation.message.delta") fullContent += payloadContent;
          }
          const usage = readCozeUsage(payload);
          if (usage) chatUsage = usage;

          const isFailureTerminal = parsed.eventType.includes("failed")
            || parsed.eventType.includes("error");
          if (isFailureTerminal) {
            upstreamFailed = true;
            upstreamFailureMessage = typeof payload?.msg === "string"
              ? payload.msg
              : typeof payload?.message === "string"
                ? payload.message
                : "Coze 上游返回失败终态";
            return;
          }

          if (parsed.eventType === "conversation.chat.completed") upstreamCompleted = true;
          if (parsed.data === "[DONE]" || parsed.eventType === "done") hasDoneFrame = true;
          const isSuccessTerminal = parsed.eventType === "conversation.message.completed"
            || parsed.eventType === "conversation.chat.completed"
            || parsed.eventType === "done"
            || parsed.data === "[DONE]";
          if (isSuccessTerminal) terminalFrames.push(frame);
          else controller.enqueue(encoder.encode(frame));
        };

        const drainFrames = (): void => {
          while (true) {
            const boundary = /\r?\n\r?\n/u.exec(buffer);
            if (!boundary || boundary.index === undefined) return;
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            processFrame(frame);
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            drainFrames();
          }
          buffer += decoder.decode();
          drainFrames();
          if (buffer.trim()) {
            processFrame(buffer);
            buffer = "";
          }

          if (upstreamFailed || !upstreamCompleted || !fullContent.trim()) {
            controller.enqueue(encodeSseError("COZE_UPSTREAM_INCOMPLETE", upstreamFailureMessage));
            controller.close();
            return;
          }

          const usage = chatUsage ?? {
            input_tokens: Math.ceil(message.length * 1.2),
            output_tokens: Math.ceil(fullContent.length * 1.2),
          };
          let settlement;
          try {
            settlement = await settleLlmUsage(
              verifiedUserId,
              serverAgentName,
              selectedModelBillingSnapshot.modelName,
              usage.input_tokens,
              usage.output_tokens,
              0,
              serverAgent.id,
              {
                isAdmin: false,
                clientRequestId,
                phase: "coze-response",
                billingSnapshot: selectedModelBillingSnapshot,
                baseFeeCredits,
              },
            );
          } catch (error) {
            console.error("[Coze Billing] 原子钱包结算失败:", error);
            controller.enqueue(encodeSseError(
              "COZE_BILLING_FAILED",
              "对话已由上游完成，但共享钱包结算失败，本次不交付完成态",
            ));
            controller.close();
            return;
          }

          try {
            await persistCompletedCozeConversation({
              conversationId: typeof conversationId === "string" ? conversationId : undefined,
              cozeConversationId,
              userId: verifiedUserId,
              agentId: serverAgent.id,
              message,
              answer: fullContent,
            });
          } catch (error) {
            console.error("[Chat] Coze 对话结算成功但历史持久化失败:", error);
          }

          controller.enqueue(encoder.encode(
            `event: billing.completed\ndata: ${JSON.stringify({
              billing_complete: true,
              operation_id: settlement.operationId,
              already_fulfilled: settlement.alreadyFulfilled === true,
              credits_charged: settlement.billing?.creditsCharged ?? 0,
              balance_after: settlement.balanceAfter,
              public_model_id: selectedModelBillingSnapshot.publicModelId,
            })}\n\n`,
          ));
          for (const terminalFrame of terminalFrames) controller.enqueue(encoder.encode(terminalFrame));
          if (!hasDoneFrame) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          console.error("[Chat] Coze 流读取失败:", error);
          controller.enqueue(encodeSseError(
            "COZE_STREAM_FAILED",
            "Coze 流式响应中断，本次不结算也不保存成功记录",
          ));
          controller.close();
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } catch {
          // ignore downstream abort cleanup failures
        }
      },
    });

    return await completeLlmAttemptResponse(cozeRequestAttemptStore, activeCozeAttempt, new Response(billingStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Tell Nginx to not buffer this response (critical for SSE/typewriter effect)
      },
    }));
  } catch (error: unknown) {
    if (activeCozeAttempt) {
      try {
        await finalizeLlmAttemptFromThrownError(
          cozeRequestAttemptStore,
          activeCozeAttempt,
          cozeProviderCallStarted,
          error,
        );
      } catch {
        return new Response(JSON.stringify({
          error: "这次对话中断，最终结果暂未确认。原请求已保留。",
          code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED",
          retryable: false,
          retry_safe: false,
          attempt_id: activeCozeAttempt.record.recordId,
        }), {
          status: 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
    }
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
