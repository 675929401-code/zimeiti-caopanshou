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
import { canUseOwnerInternalAgent } from "@/lib/server/internal-agent-catalog-access";
import { hasCurrentSelfUseGrant, isUnboundCatalogAgent, isViewOnlyAgentAccess, requiresOwnerAgentAccess, uniqueAgentCategory } from "@/lib/agent-catalog-lifecycle";
import { createOperationPerformanceTrace, type OperationPerformanceTrace } from "@/lib/operation-performance-trace";
import { recordServerOperationPerformanceEventBestEffort } from "@/lib/operation-flight-recorder";
import { ensureConversationOwnership } from "@/lib/conversation-ownership";

// ⚡ 流式路由强制动态渲染 — 防止 Next.js 静态优化缓冲 SSE
export const dynamic = 'force-dynamic';

const cozeRequestAttemptStore = new DatabaseLlmRequestAttemptStore();

type CozeAgentRow = {
  id: string;
  name?: string | null;
  bot_id: string;
  source?: string | null;
  model?: string | null;
  model_id?: string | null;
  base_fee?: number | string | null;
  user_access?: string | null;
  category?: string | null;
  is_active?: boolean | null;
};

type CozeUsage = { input_tokens: number; output_tokens: number };

const MAX_COZE_IMAGE_KEYS = 10;

function isSafeCozeImageKey(value: string): boolean {
  return value.length > 0
    && value.length <= 1024
    && !value.startsWith("/")
    && !value.includes("://")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !/[?#\u0000-\u001f]/u.test(value);
}

async function validateOwnedCozeImageKeys(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  rawImages: unknown,
): Promise<{ ok: true; keys: string[] } | { ok: false; response: Response }> {
  if (rawImages === undefined || rawImages === null) return { ok: true, keys: [] };
  if (!Array.isArray(rawImages) || rawImages.length > MAX_COZE_IMAGE_KEYS) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "图片附件数量无效", code: "COZE_IMAGE_INPUT_INVALID" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  const keys = [...new Set(rawImages.map((value) => typeof value === "string" ? value.trim() : ""))];
  if (keys.length !== rawImages.length || keys.some((key) => !isSafeCozeImageKey(key))) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "图片附件标识无效", code: "COZE_IMAGE_INPUT_INVALID" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  // An empty attachment list is valid; avoid issuing an empty PostgREST `in()`
  // filter, which some deployments reject as malformed SQL.
  if (keys.length === 0) return { ok: true, keys: [] };
  const owned = await supabase
    .from("user_files")
    .select("storage_key")
    .eq("user_id", userId)
    .eq("file_category", "image")
    .in("storage_key", keys);
  if (owned.error) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "图片归属暂时无法确认，本次未调用模型", code: "COZE_IMAGE_OWNERSHIP_UNAVAILABLE", retryable: true }),
        { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      ),
    };
  }
  const ownedKeys = new Set((owned.data || []).map((row: { storage_key?: unknown }) => String(row.storage_key || "")));
  if (ownedKeys.size !== keys.length) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "图片不存在或不属于当前用户，本次未调用模型", code: "COZE_IMAGE_OWNERSHIP_FAILED", retryable: false }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      ),
    };
  }
  return { ok: true, keys };
}

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
  if (!dbConversationId) throw new Error("COZE_CONVERSATION_ID_MISSING");
  const supabase = getSupabaseClient();
  const needsMigration = Boolean(
    input.cozeConversationId
      && input.conversationId
      && input.cozeConversationId !== input.conversationId,
  );
  const now = new Date().toISOString();
  const ownershipStore = {
    async getOwner(conversationId: string): Promise<string | null> {
      const result = await supabase.from("conversations").select("user_id").eq("id", conversationId).maybeSingle();
      if (result.error) throw result.error;
      return result.data?.user_id ? String(result.data.user_id) : null;
    },
    async create(conversationId: string, ownerId: string): Promise<"created" | "conflict"> {
      const result = await supabase.from("conversations").insert({
        id: conversationId,
        user_id: ownerId,
        agent_id: input.agentId,
        title: input.message.trim().slice(0, 50),
        source: "coze",
        updated_at: now,
      });
      if (!result.error) return "created";
      if (result.error.code === "23505") return "conflict";
      throw result.error;
    },
  };
  // Never upsert by provider conversation ID: a provider ID must not be able
  // to overwrite another user's local conversation row.
  await ensureConversationOwnership(ownershipStore, dbConversationId, input.userId);
  const conversationUpdate = await supabase.from("conversations")
    .update({ agent_id: input.agentId, source: "coze", updated_at: now })
    .eq("id", dbConversationId)
    .eq("user_id", input.userId)
    .select("id")
    .maybeSingle();
  if (conversationUpdate.error || !conversationUpdate.data) throw new Error("会话记录保存失败");
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

  // A provider may replace the client-side conversation ID. Clean up the old
  // owned row only after the new row and both messages are durable; never
  // delete first and risk losing the only local copy.
  if (needsMigration && input.conversationId) {
    const oldMessages = await supabase.from("conversation_messages")
      .delete().eq("conversation_id", input.conversationId).eq("user_id", input.userId);
    const oldConversation = await supabase.from("conversations")
      .delete().eq("id", input.conversationId).eq("user_id", input.userId);
    if (oldMessages.error || oldConversation.error) {
      console.warn("[Chat] 新会话已保存，但旧会话清理未完成", {
        messageError: oldMessages.error?.message,
        conversationError: oldConversation.error?.message,
      });
    }
  }
}

type CozeBufferedDeliveryOptions = {
  openUpstream: () => Promise<Response>;
  fallbackUsage: CozeUsage;
  settle: (input: { usage: CozeUsage; fullContent: string }) => Promise<{
    operationId?: string;
    alreadyFulfilled?: boolean;
    billing?: { creditsCharged?: number };
    balanceAfter?: number;
  }>;
  persist: (input: { cozeConversationId: string; fullContent: string }) => Promise<void>;
  publicModelId: string;
  performanceTrace: OperationPerformanceTrace;
};

/**
 * Coze has no bounded atomic pre-authorization in this route, so provider text
 * stays server-side until settlement succeeds. The outer SSE is still returned
 * immediately: heartbeat/metadata/progress make the real delivery mode explicit.
 */
function createBufferedCozeDeliveryStream(options: CozeBufferedDeliveryOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let performanceTerminalRecorded = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* already closed */ }
      };

      // This must precede configuration lookup, durable provider-start marking,
      // and the provider POST. It proves the outer response is not waiting on Coze.
      safeEnqueue(encoder.encode(": heartbeat\n\n"));
      safeEnqueue(encoder.encode(`data: ${JSON.stringify({
        type: "stream_delivery",
        stream_delivery: "buffered",
        stream_delivery_reason: "coze_unbounded_usage_requires_atomic_settlement",
      })}\n\n`));
      heartbeatTimer = setInterval(() => {
        safeEnqueue(encoder.encode(": heartbeat\n\n"));
      }, 5_000);

      const decoder = new TextDecoder();
      let buffer = "";
      let chatUsage: CozeUsage | null = null;
      let fullContent = "";
      let cozeConversationId = "";
      let upstreamCompleted = false;
      let upstreamFailed = false;
      let upstreamFailureMessage = "Coze 上游未完成对话";
      let hasDoneFrame = false;
      let lastProgressAt = 0;
      let lastProgressChars = 0;
      let firstContentObserved = false;
      const bufferedFrames: string[] = [];
      const terminalFrames: string[] = [];

      const recordTerminal = (
        outcome: "success" | "error" | "cancelled",
        errorCode: string | null = null,
        httpStatus: number | null = null,
      ) => {
        if (performanceTerminalRecorded) return;
        options.performanceTrace.checkpoint("response.terminal", { outcome, errorCode, httpStatus });
        performanceTerminalRecorded = true;
      };

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
          if (!firstContentObserved) {
            options.performanceTrace.checkpoint("response.first_byte");
            firstContentObserved = true;
          }
          if (parsed.eventType === "conversation.message.completed") fullContent = payloadContent;
          else if (parsed.eventType === "conversation.message.delta") fullContent += payloadContent;
        }
        const usage = readCozeUsage(payload);
        if (usage) chatUsage = usage;

        const isFailureTerminal = parsed.eventType.includes("failed") || parsed.eventType.includes("error");
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
        else bufferedFrames.push(frame);

        const now = Date.now();
        if (fullContent.length > 0 && (lastProgressAt === 0 || now - lastProgressAt >= 800 || fullContent.length - lastProgressChars >= 240)) {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({
            type: "generation_progress",
            phase: "coze-answer",
            received_chars: fullContent.length,
            stream_delivery: "buffered",
          })}\n\n`));
          lastProgressAt = now;
          lastProgressChars = fullContent.length;
        }
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
        const response = await options.openUpstream();
        options.performanceTrace.checkpoint("upstream.wait", { httpStatus: response.status });
        if (!response.ok) {
          const errorText = await response.text();
          safeEnqueue(encodeSseError("COZE_API_ERROR", `Coze API error: ${errorText.slice(0, 500)}`));
          recordTerminal("error", "COZE_API_ERROR", response.status);
          safeClose();
          return;
        }
        if (!response.body) {
          safeEnqueue(encodeSseError("COZE_STREAM_MISSING", "No stream from Coze API"));
          recordTerminal("error", "COZE_STREAM_MISSING", response.status);
          safeClose();
          return;
        }
        upstreamReader = response.body.getReader();
        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          drainFrames();
        }
        buffer += decoder.decode();
        drainFrames();
        if (buffer.trim()) processFrame(buffer);

        if (upstreamFailed || !upstreamCompleted || !fullContent.trim()) {
          safeEnqueue(encodeSseError("COZE_UPSTREAM_INCOMPLETE", upstreamFailureMessage));
          recordTerminal("error", "COZE_UPSTREAM_INCOMPLETE", response.status);
          safeClose();
          return;
        }

        let settlement;
        try {
          settlement = await options.settle({ usage: chatUsage ?? options.fallbackUsage, fullContent });
        } catch (error) {
          console.error("[Coze Billing] 原子钱包结算失败:", error);
          safeEnqueue(encodeSseError(
            "LLM_BILLING_FAILED",
            "对话已由上游完成，但共享钱包结算失败，本次未交付模型输出",
          ));
          recordTerminal("error", "LLM_BILLING_FAILED", response.status);
          safeClose();
          return;
        }

        try {
          await options.persist({ cozeConversationId, fullContent });
          options.performanceTrace.checkpoint("result.persistence");
        } catch (error) {
          console.error("[Chat] Coze 对话结算成功但历史持久化失败:", error);
          options.performanceTrace.checkpoint("result.persistence", {
            outcome: "warning",
            errorCode: "COZE_HISTORY_PERSIST_FAILED",
          });
          safeEnqueue(encodeSseError(
            "COZE_HISTORY_PERSIST_FAILED",
            "对话已由上游完成并结算，但历史保存未确认；本次不发送成功终态，请稍后查看记录。",
          ));
          recordTerminal("error", "COZE_HISTORY_PERSIST_FAILED", response.status);
          safeClose();
          return;
        }

        for (const frame of bufferedFrames) {
          if (!safeEnqueue(encoder.encode(frame))) break;
        }
        safeEnqueue(encoder.encode(
          `event: billing.completed\ndata: ${JSON.stringify({
            billing_complete: true,
            stream_delivery: "buffered",
            stream_delivery_reason: "coze_unbounded_usage_requires_atomic_settlement",
            operation_id: settlement.operationId,
            already_fulfilled: settlement.alreadyFulfilled === true,
            credits_charged: settlement.billing?.creditsCharged ?? 0,
            balance_after: settlement.balanceAfter,
            public_model_id: options.publicModelId,
          })}\n\n`,
        ));
        for (const terminalFrame of terminalFrames) safeEnqueue(encoder.encode(terminalFrame));
        if (!hasDoneFrame) safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        recordTerminal("success", null, response.status);
        safeClose();
      } catch (error) {
        console.error("[Chat] Coze 流读取失败:", error);
        safeEnqueue(encodeSseError(
          "COZE_STREAM_FAILED",
          "Coze 流式响应中断，本次不结算也不保存成功记录",
        ));
        recordTerminal("error", "COZE_STREAM_FAILED");
        safeClose();
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    },
    async cancel(reason) {
      if (!performanceTerminalRecorded) {
        options.performanceTrace.checkpoint("response.terminal", {
          outcome: "cancelled",
          errorCode: "COZE_STREAM_CANCELLED",
        });
        performanceTerminalRecorded = true;
      }
      await upstreamReader?.cancel(reason).catch(() => undefined);
    },
  });
}

export async function POST(request: Request) {
  let activeCozeAttempt: LlmRequestAttemptExecution | null = null;
  let cozeProviderCallStarted = false;
  let performanceTrace: OperationPerformanceTrace | null = null;
  try {
    const body = await request.json();
    const {
      botId,
      message,
      conversationId,
      images,
      persistUserMessage: persistUserMessageRaw,
      truncateFromMessageId: truncateFromMessageIdRaw,
      appendUserMessage: appendUserMessageRaw,
    } = body;
    performanceTrace = createOperationPerformanceTrace({
      domain: "chat",
      operation: "chat.coze_request",
      route: "/api/chat",
      requestId: request.headers.get("idempotency-key") || body.client_request_id || request.headers.get("x-client-trace-id"),
      traceId: request.headers.get("x-client-trace-id") || request.headers.get("idempotency-key") || body.client_request_id,
      agentId: botId,
    }, (event) => { void recordServerOperationPerformanceEventBestEffort(event); });
    performanceTrace.checkpoint("request.received", { outcome: "in_progress" });
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
    if (conversationId !== undefined && conversationId !== null && typeof conversationId !== "string") {
      return new Response(
        JSON.stringify({ error: "会话标识无效", code: "CONVERSATION_ID_INVALID" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const safeConversationId = typeof conversationId === "string" ? conversationId.trim() : "";

    // The client sends these branch controls for regenerate/edit/retry.  The
    // Coze transport cannot delete or replay a provider-side branch by local
    // message ID, so silently ignoring them would persist duplicate user
    // messages and show a transcript that differs from the provider context.
    // Parse them explicitly and fail closed until a provider-native branch
    // contract exists.  Normal sends use the default true/true/empty values.
    if (persistUserMessageRaw !== undefined && typeof persistUserMessageRaw !== "boolean") {
      return new Response(
        JSON.stringify({ error: "Coze 消息持久化标记无效", code: "COZE_BRANCH_CONTRACT_INVALID", retryable: false }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (appendUserMessageRaw !== undefined && typeof appendUserMessageRaw !== "boolean") {
      return new Response(
        JSON.stringify({ error: "Coze 消息追加标记无效", code: "COZE_BRANCH_CONTRACT_INVALID", retryable: false }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (truncateFromMessageIdRaw !== undefined && typeof truncateFromMessageIdRaw !== "string") {
      return new Response(
        JSON.stringify({ error: "Coze 截断消息标识无效", code: "COZE_BRANCH_CONTRACT_INVALID", retryable: false }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const persistUserMessage = persistUserMessageRaw !== false;
    const appendUserMessage = appendUserMessageRaw !== false;
    const truncateFromMessageId = typeof truncateFromMessageIdRaw === "string"
      ? truncateFromMessageIdRaw.trim()
      : "";
    if (truncateFromMessageId.length > 200 || /[\u0000-\u001f]/u.test(truncateFromMessageId)) {
      return new Response(
        JSON.stringify({ error: "Coze 截断消息标识无效", code: "COZE_BRANCH_CONTRACT_INVALID", retryable: false }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const cozeBranchRequested = !persistUserMessage || !appendUserMessage || Boolean(truncateFromMessageId);

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
    performanceTrace.enrichIdentity({ userId: verifiedUserId, accountId: verifiedUserId, agentId: botId });
    performanceTrace.checkpoint("auth.permission");

    if (cozeBranchRequested) {
      return new Response(
        JSON.stringify({
          error: "Coze 通道暂不支持按本地消息分支重试或改写，请保留原消息后重新发送",
          code: "COZE_BRANCH_UNSUPPORTED",
          retryable: false,
          provider_call_started: false,
          charged: false,
        }),
        { status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
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
      const deliveryEvent = `data: ${JSON.stringify({ type: "stream_delivery", stream_delivery: "buffered", stream_delivery_reason: "server_guard_response" })}\n\n`;
      const blockEvent = `${deliveryEvent}event: conversation.message.delta\ndata: ${JSON.stringify({ type: "answer", content: blockMsg, content_type: "text" })}\n\n`;
      return new Response(blockEvent, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Stream-Delivery": "buffered",
          "X-Stream-Delivery-Reason": "server_guard_response",
        },
      });
    }

    // ── Coze智能体消息：保持纯净，不注入额外内容 ──
    const securedMessage = message;

    // ── 服务端计费绑定：botId → agent.model_id → 已发布公共模型 → 不可变价格快照 ──
    // 客户端传入的 agentId/agentName/baseFee 均不得参与授权或定价。
    const dataClient = getSupabaseClient();
    const agentResult = await dataClient.from("agents")
      .select("id, name, source, model, bot_id, model_id, base_fee, user_access, category, is_active")
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

    const allCatsResult = await dataClient.from("categories").select("id,name,visibility,is_active");
    const dispatchCategory = uniqueAgentCategory(allCatsResult.data as {name:string;visibility?:string}[] | null,serverAgent.category);
    if (allCatsResult.error || !dispatchCategory) {
      return new Response(JSON.stringify({ error: "无法核实智能体所属分类", code: "AGENT_CATEGORY_AUTHORITY_UNAVAILABLE", retryable: true }),
        { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    const ownerScopeRequired = requiresOwnerAgentAccess(serverAgent, dispatchCategory);
    const ownerScopeVerified = ownerScopeRequired && await canUseOwnerInternalAgent(request);
    if (ownerScopeRequired && !ownerScopeVerified) {
      return new Response(
        JSON.stringify({ error: "该智能体仅限所有者使用", code: "OWNER_INTERNAL_AGENT_REQUIRED", retryable: false }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    if (isUnboundCatalogAgent(serverAgent)) {
      return new Response(JSON.stringify({ error: "该智能体尚未配置可用模型", code: "AGENT_MODEL_NOT_CONFIGURED", retryable: false }),
        { status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (isViewOnlyAgentAccess(serverAgent, dispatchCategory, ownerScopeVerified)) {
      return new Response(JSON.stringify({ error: "该智能体仅供展示", code: "AGENT_VIEW_ONLY", retryable: false }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }

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
    if (!permissionNavigationKey || !permission.agentNavigationKeys.includes(permissionNavigationKey) || (serverAgent.category === "自用" && !hasCurrentSelfUseGrant(permission))) {
      return new Response(
        JSON.stringify({
          error: "当前账号未开通该智能体分类",
          code: "CATEGORY_ACCESS_DENIED",
          retryable: false,
        }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    const ownedImageResult = await validateOwnedCozeImageKeys(dataClient, verifiedUserId, images);
    if (!ownedImageResult.ok) return ownedImageResult.response;
    const imageKeys = ownedImageResult.keys;
    if (safeConversationId) {
      const conversationOwner = await dataClient
        .from("conversations")
        .select("user_id")
        .eq("id", safeConversationId)
        .maybeSingle();
      if (conversationOwner.error) {
        return new Response(
          JSON.stringify({ error: "会话归属暂时无法确认，本次未调用模型", code: "CONVERSATION_OWNERSHIP_UNAVAILABLE", retryable: true }),
          { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
        );
      }
      if (conversationOwner.data?.user_id && String(conversationOwner.data.user_id) !== verifiedUserId) {
        return new Response(
          JSON.stringify({ error: "会话不存在或无权限，本次未调用模型", code: "CONVERSATION_NOT_FOUND" }),
          { status: 404, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
        );
      }
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
      const creditsResult = await (async () => { try { return await client.from("users").select("credits, member_status, member_expires_at, status, allowed_categories").eq("id", verifiedUserId).single(); } catch { return { data: null }; } })();

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
        if (!agentCat || agentCat.is_active === false) {
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
          conversationId: safeConversationId,
          message,
          images: imageKeys,
        }),
        leaseOwner: createLlmAttemptLeaseOwner(),
      });
      if (claim.action !== "execute") return responseForLlmAttemptClaim(claim);
      activeCozeAttempt = claim.execution;
      performanceTrace.enrichIdentity({
        taskId: activeCozeAttempt.record.recordId,
        agentId: serverAgent.id,
      });
      performanceTrace.checkpoint("database.read");
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

    // ── 外层 SSE 先返回；上游配置、provider-start 标记和 POST 均在 start 内执行 ──
    if (!activeCozeAttempt) throw new Error("COZE_ATTEMPT_NOT_CLAIMED");
    const claimedCozeAttempt = activeCozeAttempt;
    const billingStream = createBufferedCozeDeliveryStream({
      openUpstream: async () => {
        const cozeConfig = await cozeConfigPromise;
        activeCozeAttempt = await cozeRequestAttemptStore.markProviderCallStarted(claimedCozeAttempt);
        cozeProviderCallStarted = true;
        return streamChat(botId, verifiedUserId, securedMessage, safeConversationId || undefined, cozeConfig, imageKeys);
      },
      fallbackUsage: {
        input_tokens: Math.ceil(message.length * 1.2),
        output_tokens: 0,
      },
      settle: async ({ usage, fullContent }) => settleLlmUsage(
        verifiedUserId,
        serverAgentName,
        selectedModelBillingSnapshot.modelName,
        usage.input_tokens,
        usage.output_tokens || Math.ceil(fullContent.length * 1.2),
        0,
        serverAgent.id,
        {
          isAdmin: userRole === "admin",
          clientRequestId,
          phase: "coze-response",
          billingSnapshot: selectedModelBillingSnapshot,
          baseFeeCredits,
        },
      ),
      persist: async ({ cozeConversationId, fullContent }) => persistCompletedCozeConversation({
        conversationId: safeConversationId || undefined,
        cozeConversationId,
        userId: verifiedUserId,
        agentId: serverAgent.id,
        message,
        answer: fullContent,
      }),
      publicModelId: selectedModelBillingSnapshot.publicModelId,
      performanceTrace,
    });

    return await completeLlmAttemptResponse(cozeRequestAttemptStore, claimedCozeAttempt, new Response(billingStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Stream-Delivery": "buffered",
        "X-Stream-Delivery-Reason": "coze_unbounded_usage_requires_atomic_settlement",
      },
    }));
  } catch (error: unknown) {
    performanceTrace?.checkpoint("response.terminal", {
      outcome: "error",
      errorCode: "COZE_ROUTE_FAILED",
    });
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
