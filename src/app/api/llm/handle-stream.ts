/**
 * LLM Route — 流式/非流式响应处理器
 *
 * 从 route.ts 提取的独立模块：构造 SSE 流、扣费触发、消息持久化、错误降级。
 * 分离原因：流式响应构造（~260行）与配置解析无关，独立更清晰。
 */

import type { ChatRequest, LLMProxy } from "@/lib/llm-proxy";
import { SseEventStreamDecoder, type DecodedSseEvent } from "@/lib/sse-stream-decoder";
import { LlmResponseStartError, LlmStreamError, upstreamStreamError, responseStartError, sanitizeLlmSafeDiagnostics } from "@/lib/llm-proxy/stream-error";
import {
  settleLlmUsage,
  type SelectedModelBillingSnapshot,
} from "@/lib/llm-billing";
import { zhipuChatStream, zhipuChat } from "@/lib/llm-proxy/zhipu-proxy";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { releaseLlmStreamCredits, type LlmStreamReservation } from "@/lib/llm-credit-reservation";
import type { ChatMessage } from "@/lib/llm-context";
import { bipStep } from "@/lib/business-ip/catalog";
import { containsPromptLeak, messageText } from "@/lib/business-ip/guard";
import { BipStreamPromptLeakError, createBipGuardedStream } from "@/lib/server/bip-guarded-stream";
import { requireAssistantPersistence } from "@/lib/server/agent-chat-prompt-authority";
import {
  recordModelSuccess,
  recordModelFailure,
} from "@/lib/llm-fallback";

export interface StreamHandlerContext {
  // Auth
  verifiedUserId: string;
  userRole: string;

  // Agent
  agentId?: string;
  agentName?: string;
  conversationId?: string;

  // Model & API
  useModel: string;
  useApiKey: string;
  apiBase: string;
  isZhipuAI: boolean;
  agentTimeout: number;

  // Config
  agentDeepThinkingType: number;
  agentDeductDeepThink: number;
  agentMaxReplyTokens: number;
  clientRequestId: string;
  selectedModelBillingSnapshot: SelectedModelBillingSnapshot;
  allowLiveStreamDelivery?: boolean;
  streamDeliveryReason?: string;
  reservation?: LlmStreamReservation;

  // Messages
  messages: ChatMessage[];
  userMessageSaved: { value: boolean };
}

// ── 流式响应 ──

export function handleStreamResponse(
  ctx: StreamHandlerContext,
  chatRequest: ChatRequest,
  proxy: LLMProxy | null,
): Response {
  let fullContent = "";
  let reasoningContent = "";
  let usageData: { prompt_tokens: number; completion_tokens: number; cached_tokens: number } | null = null;
  const encoder = new TextEncoder();
  const protectPrompt = Boolean(bipStep(ctx.agentId));
  const protectedPrompt = ctx.messages.filter(m=>m.role==='system').map(m=>messageText(m.content)).join('\n');

  const settleCompletedUsage = async () => {
    const measured = usageData && (usageData.prompt_tokens > 0 || usageData.completion_tokens > 0)
      ? usageData
      : {
          prompt_tokens: Math.ceil(JSON.stringify(chatRequest.messages).length / 2),
          completion_tokens: Math.ceil((fullContent.length + reasoningContent.length) / 2),
          cached_tokens: 0,
        };
    const completionTokens = ctx.agentDeepThinkingType === 2
      ? Math.ceil(measured.completion_tokens * ctx.agentDeductDeepThink)
      : measured.completion_tokens;
    return settleLlmUsage(
      ctx.verifiedUserId,
      ctx.agentName || "unknown",
      ctx.useModel,
      measured.prompt_tokens,
      completionTokens,
      measured.cached_tokens,
      ctx.agentId,
      {
        isAdmin: ctx.userRole === "admin",
        clientRequestId: ctx.clientRequestId,
        phase: "response",
        billingSnapshot: ctx.selectedModelBillingSnapshot,
        isDeepThinking: ctx.agentDeepThinkingType === 2,
        reservation: ctx.reservation,
      },
    );
  };

  const __wrapStart = Date.now();
  const wrappedStream = new ReadableStream({
    async start(controller) {
      let outerClosed = false;
      // The caller enables live delivery only for a zero-charge quote or an
      // atomically held bounded reservation. BIP additionally retains a reviewed
      // normalized suffix; short answers remain held until terminal settlement.
      const liveDelivery = ctx.allowLiveStreamDelivery === true;
      const protectedDelivery = protectPrompt && liveDelivery ? createBipGuardedStream(protectedPrompt) : null;
      const bufferedResponseChunks: Uint8Array[] = [];
      const deliveryDecoder = new SseEventStreamDecoder();
      let lastProgressAt = 0;
      let lastProgressChars = 0;
      let reservationNeedsReconciliation = false;
      let liveContentDelivered = false;
      let upstreamError: LlmStreamError | null = null;
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (outerClosed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          outerClosed = true;
          return false;
        }
      };
      const safeClose = () => {
        if (outerClosed) return;
        try { controller.close(); } catch { /* already closed */ }
        outerClosed = true;
      };
      const deliverEvent = (event: DecodedSseEvent) => {
        if (event.data.trim() === "[DONE]" || upstreamError) return;
        let payload;
        try { payload = JSON.parse(event.data); } catch {
          if (event.event === "error") upstreamError = upstreamStreamError({});
          return;
        }
        if (payload?.error || event.event === "error") {
          upstreamError = upstreamStreamError(payload);
          return;
        }
        const chunk = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
        if (protectedDelivery) {
          const delta = protectedDelivery.update(fullContent);
          if (delta && safeEnqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] })}\n\n`))) liveContentDelivered = true;
        }
        else if (liveDelivery) {
          if (safeEnqueue(chunk)) {
            const delta = payload?.choices?.[0]?.delta;
            if ([delta?.content, delta?.reasoning_content, delta?.reasoning].some(value => typeof value === "string" && value.length > 0)) liveContentDelivered = true;
          }
        }
        else if (!protectPrompt) {
          bufferedResponseChunks.push(chunk);
          const receivedChars = fullContent.length + reasoningContent.length;
          const now = Date.now();
          if (receivedChars > 0 && (lastProgressAt === 0 || now - lastProgressAt >= 800 || receivedChars - lastProgressChars >= 240)) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({
              type: "generation_progress",
              phase: "generating",
              received_chars: receivedChars,
            })}\n\n`));
            lastProgressAt = now;
            lastProgressChars = receivedChars;
          }
        }
      };

      let proxyStream: ReadableStream<Uint8Array>;
      // One explicit send authorizes one provider invocation, including when
      // the relay rejects its concurrency queue. Retrying is a user decision.

      // ── 周期性心跳定时器（在 try 外声明，确保 catch 可清理） ──
      let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

      try {
        // ── 立即发送 SSE 心跳 ──
        if (!safeEnqueue(encoder.encode(": heartbeat\n\n"))) return;
        if (!safeEnqueue(encoder.encode(`data: ${JSON.stringify({
          type: "stream_delivery",
          stream_delivery: liveDelivery ? "live" : "buffered",
          stream_delivery_reason: protectPrompt
            ? (liveDelivery ? "prompt_guarded_live_withheld_suffix" : "prompt_output_review")
            : ctx.streamDeliveryReason || (liveDelivery ? "live_delivery_allowed" : "buffer_until_atomic_settlement"),
        })}\n\n`))) return;

        // ── 周期性心跳：在等待上游首字节期间保持连接活跃 ──
        // 每 5 秒发一次心跳，防止 Nginx（proxy_read_timeout 60s）或 CDN 断连
        // SSE 注释行（: 开头）前端会自动跳过，不影响渲染
        const startHeartbeat = () => {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          heartbeatInterval = setInterval(() => {
            if (!safeEnqueue(encoder.encode(": heartbeat\n\n"))) {
              if (heartbeatInterval) clearInterval(heartbeatInterval);
            }
          }, 5_000);
        };
        startHeartbeat();

        // ── 响应交付：允许真流式时立即透传；否则结算成功前只缓冲正文 ──
        const pipeResponse = (stream: ReadableStream<Uint8Array>) => stream.pipeTo(new WritableStream({
          write(chunk) {
            for (const event of deliveryDecoder.push(chunk)) deliverEvent(event);
          },
          async close() {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            for (const event of deliveryDecoder.finish()) deliverEvent(event);
            // A provider error after partial text must never settle as success.
            if (upstreamError) throw upstreamError;
            // ★ 空内容安全网
            if (!fullContent && (!reasoningContent || protectPrompt)) {
              const emptyErr = `模型 ${ctx.useModel} 未返回任何内容，请重试或切换模型`;
              console.error(`[LLM Route] ⚠️ 流完成但内容为空: model=${ctx.useModel}, agent=${ctx.agentName}`);
              recordModelFailure(ctx.useModel, "empty_response");
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({ error: emptyErr, code: "LLM_EMPTY_RESPONSE", done: false })}\n\n`));
              safeClose();
              return;
            }
            if (protectPrompt && containsPromptLeak(fullContent, protectedPrompt)) {
              throw new LlmStreamError('回复未通过内部信息保护检查，本次未交付，请换一种业务提问。', 'PROMPT_OUTPUT_BLOCKED');
            }
            try {
              const settlement = await settleCompletedUsage();
              if (protectPrompt) {
                // Full terminal review remains mandatory. Release the withheld tail only after settlement.
                reasoningContent = '';
                const delta = protectedDelivery ? protectedDelivery.finish(fullContent, true) : fullContent;
                if (delta) safeEnqueue(encoder.encode(`data: ${JSON.stringify({choices:[{delta:{content:delta},finish_reason:null}]})}\n\n`));
              }
              if (!liveDelivery) {
                for (const chunk of bufferedResponseChunks) {
                  if (!safeEnqueue(chunk)) break;
                }
              }
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                billing_complete: true,
                stream_delivery: liveDelivery ? "live" : "buffered",
                stream_delivery_reason: protectPrompt ? (liveDelivery ? 'prompt_guarded_live_withheld_suffix' : 'prompt_output_review') : ctx.streamDeliveryReason || (liveDelivery ? "live_delivery_allowed" : "buffer_until_atomic_settlement"),
                operation_id: settlement.operationId,
                credits_charged: settlement.billing?.creditsCharged || 0,
                balance_after: settlement.balanceAfter,
                already_fulfilled: settlement.alreadyFulfilled === true,
              })}\n\n`));
            } catch {
              console.error("[Billing] LLM response settlement failed", { code: "LLM_BILLING_FAILED" });
              recordModelFailure(ctx.useModel, "billing_failed");
              reservationNeedsReconciliation = Boolean(ctx.reservation && liveDelivery);
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                error: liveDelivery ? "共享钱包结算失败，请联系管理员核对本次输出流水" : "共享钱包结算失败，本次未交付模型输出",
                code: "LLM_BILLING_FAILED",
                reconciliation_required: reservationNeedsReconciliation,
                done: false,
              })}\n\n`));
              safeClose();
              return;
            }
            // A resolved Supabase error is not persistence. Never report DONE
            // until the delivered, settled answer has a confirmed history row.
            if (ctx.conversationId && ctx.verifiedUserId && fullContent) {
              const saveClient = getSupabaseClient();
              const persistedMessageId = crypto.randomUUID();
              try { await requireAssistantPersistence(saveClient.from("conversation_messages").insert({
                id: persistedMessageId, conversation_id: ctx.conversationId, user_id: ctx.verifiedUserId,
                agent_id: ctx.agentId || "llm", role: "assistant", content: fullContent,
                reasoning_content: reasoningContent || "",
                created_at: new Date(Date.now() + 1).toISOString(),
              })); } catch {
                console.error("[LLM] assistant persistence requires recovery", { code: "LLM_ASSISTANT_PERSISTENCE_FAILED", clientRequestId: ctx.clientRequestId });
                safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                  error: "回复已生成并结算，聊天记录保存状态待恢复。请保留当前回复并刷新历史核对，勿重复发送。",
                  code: "LLM_ASSISTANT_PERSISTENCE_FAILED", reconciliation_required: true, done: false,
                })}\n\n`));
                safeClose();
                return;
              }
              safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                type: "message_persisted", role: "assistant", conversation_id: ctx.conversationId,
                message_id: persistedMessageId,
              })}\n\n`));
            }
            recordModelSuccess(ctx.useModel);
            safeEnqueue(encoder.encode("data: [DONE]\n\n"));
            console.log(`[LLM Route] pipe完成: model=${ctx.useModel}, agent=${ctx.agentName}, 内容=${fullContent.length}字符, 推理=${reasoningContent.length}字符, delivery=${liveDelivery ? "live" : "buffered"}, reason=${ctx.streamDeliveryReason || "unknown"}`);
            safeClose();
          },
          abort(reason) {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            if (reason?.message !== "CLIENT_DISCONNECTED" && reason?.message !== "STREAM_CLOSED") {
              console.warn(`[LLM Route] pipe中断: model=${ctx.useModel}, reason=${reason}`);
            }
            safeClose();
          },
        }), { preventAbort: true, preventCancel: true });

        // Connect exactly once. Queue rejection, network failure and partial
        // output all flow to the same visible terminal failure below.
        if (ctx.isZhipuAI) {
          proxyStream = await zhipuChatStream(chatRequest, {
            apiBase: ctx.apiBase,
            apiKey: ctx.useApiKey,
            timeout: Math.min(ctx.agentTimeout, 300),
            onContent: (text) => { fullContent += text; },
            onReasoning: (text) => { reasoningContent += text; },
            onUsage: (usage) => {
              usageData = usage;
            },
            onFirstByte: (ttfb) => {
              console.log(`[PERF] ZhipuAI TTFB: ${ttfb}ms (model=${ctx.useModel}), 路由总耗时=${Date.now() - __wrapStart}ms`);
            },
          });
        } else {
          proxyStream = await proxy!.chatStream(chatRequest, {
            onContent: (text) => { fullContent += text; },
            onReasoning: (text) => { reasoningContent += text; },
            onUsage: (usage) => {
              usageData = usage;
            },
            onFirstByte: (ttfb) => {
              console.log(`[PERF] LLM Proxy TTFB: ${ttfb}ms (model=${ctx.useModel}), 路由总耗时=${Date.now() - __wrapStart}ms`);
            },
          });
        }
        await pipeResponse(proxyStream);
      } catch (e) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg === "STREAM_CLOSED") {
          safeClose();
          return;
        }
        if (errMsg === "CLIENT_DISCONNECTED") {
          safeClose();
          return;
        }

        // Fetch/HTTP failures used to emit an untyped error. The durable wrapper
        // then replaced the reason with TERMINAL_UNKNOWN. Always emit a safe code;
        // transport ambiguity remains unknown, while explicit rejection is retained.
        const failure = e instanceof BipStreamPromptLeakError
          ? new LlmStreamError(e.message, e.code) : responseStartError(e);
        if (failure.code === "LLM_UPSTREAM_RESULT_UNKNOWN" && liveContentDelivered && ctx.reservation) {
          reservationNeedsReconciliation = true;
        }
        if (e instanceof LlmResponseStartError) {
          console.error(JSON.stringify({
            kind: "LLM_RESPONSE_START_FAILURE",
            requestId: ctx.clientRequestId,
            code: e.code,
            diagnostics: e.diagnostics,
          }));
        }
        recordModelFailure(ctx.useModel, failure.code);
        console.error(`[LLM Route] wrappedStream异常: model=${ctx.useModel}, 内容=${fullContent.length}字符, code=${failure.code}`);
        if (!outerClosed) {
          const diagnostics = sanitizeLlmSafeDiagnostics(failure.diagnostics);
          const errorPayload: Record<string, unknown> = {
            error: failure.message, code: failure.code, done: false,
            ...(diagnostics ? { diagnostics } : {}),
            ...(failure.code === "LLM_UPSTREAM_RESULT_UNKNOWN" ? { retry_safe: false, reconciliation_required: reservationNeedsReconciliation } : {}),
          };
          safeEnqueue(new TextEncoder().encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
        }
        safeClose();
      } finally {
        if (ctx.reservation && !reservationNeedsReconciliation) {
          // Settled reservations are a no-op; failed streams release the hold.
          await releaseLlmStreamCredits(ctx.reservation, "stream_finished").catch(() => {
            console.error("[Billing] LLM reservation release needs reconciliation", ctx.clientRequestId);
          });
        } else if (reservationNeedsReconciliation) {
          // Content has already been delivered under the hold. Keep the hold
          // for the durable reconciliation path instead of silently releasing
          // it and turning a settlement outage into free completed output.
          console.error("[Billing] LLM live reservation retained for reconciliation", ctx.clientRequestId);
        }
      }
    },
  });

  return new Response(wrappedStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Stream-Delivery": ctx.allowLiveStreamDelivery === true ? "live" : "buffered",
      "X-Stream-Delivery-Reason": protectPrompt
        ? (ctx.allowLiveStreamDelivery === true ? "prompt_guarded_live_withheld_suffix" : "prompt_output_review")
        : ctx.streamDeliveryReason || (ctx.allowLiveStreamDelivery === true ? "live_delivery_allowed" : "buffer_until_atomic_settlement"),
      ...(ctx.reservation ? { "X-LLM-Continue-After-Disconnect": "true" } : {}),
    },
  });
}

// ── 非流式响应 ──

export async function handleNonStreamResponse(
  ctx: StreamHandlerContext,
  chatRequest: ChatRequest,
  proxy: LLMProxy | null,
): Promise<Response> {
  const result = ctx.isZhipuAI
    ? await zhipuChat(chatRequest, {
        apiBase: ctx.apiBase,
        apiKey: ctx.useApiKey,
        timeout: Math.min(ctx.agentTimeout, 300),
      })
    : await proxy!.chat(chatRequest);

  const tokenUsage = result.usage || {
    prompt_tokens: Math.ceil(ctx.messages.reduce((acc: number, m) => acc + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) * 0.8),
    completion_tokens: Math.ceil(result.content.length * 1.2),
    cached_tokens: 0,
  };
  const protectPrompt = Boolean(bipStep(ctx.agentId));
  if (protectPrompt && !result.content.trim()) {
    return new Response(JSON.stringify({error:'模型未返回正文，本次未交付。',code:'LLM_EMPTY_RESPONSE',retryable:false,stream_delivery:'buffered',stream_delivery_reason:'non_stream_requested'}),{status:422,headers:{'Content-Type':'application/json','X-Stream-Delivery':'buffered','X-Stream-Delivery-Reason':'non_stream_requested'}});
  }
  if (protectPrompt && containsPromptLeak(result.content, ctx.messages.filter(m=>m.role==='system').map(m=>messageText(m.content)).join('\n'))) {
    return new Response(JSON.stringify({error:'回复未通过内部信息保护检查，本次未交付。',code:'PROMPT_OUTPUT_BLOCKED',retryable:false,stream_delivery:'buffered',stream_delivery_reason:'non_stream_requested'}),{status:422,headers:{'Content-Type':'application/json','X-Stream-Delivery':'buffered','X-Stream-Delivery-Reason':'non_stream_requested'}});
  }
  try {
    const settlement = await settleLlmUsage(
      ctx.verifiedUserId, ctx.agentName || "unknown", ctx.useModel,
      tokenUsage.prompt_tokens, tokenUsage.completion_tokens, tokenUsage.cached_tokens,
      ctx.agentId,
      {
        isAdmin: ctx.userRole === "admin",
        clientRequestId: ctx.clientRequestId,
        phase: "response",
        billingSnapshot: ctx.selectedModelBillingSnapshot,
      },
    );
    let persistenceWarning: { status: string; code: string; message: string } | undefined;
    if (ctx.conversationId && ctx.verifiedUserId && result.content) {
      try {
        await requireAssistantPersistence(getSupabaseClient().from("conversation_messages").insert({
          id: crypto.randomUUID(), conversation_id: ctx.conversationId, user_id: ctx.verifiedUserId,
          agent_id: ctx.agentId || "llm", role: "assistant", content: result.content,
          reasoning_content: protectPrompt ? "" : result.reasoning_content || "",
          created_at: new Date(Date.now() + 1).toISOString(),
        }));
      } catch {
        persistenceWarning = { status: "recovery_required", code: "LLM_ASSISTANT_PERSISTENCE_FAILED",
          message: "回复已生成并结算，聊天记录保存状态待恢复。请保留当前回复并刷新历史核对，勿重复发送。" };
        console.error("[LLM] non-stream assistant persistence requires recovery", { code: persistenceWarning.code, clientRequestId: ctx.clientRequestId });
      }
    }
    return new Response(JSON.stringify({
      ...(protectPrompt ? {choices:[{message:{role:'assistant',content:result.content},finish_reason:'stop'}]} : result.raw as Record<string, unknown>),
      stream_delivery: "buffered",
      stream_delivery_reason: "non_stream_requested",
      // Preserve this exact paid response in the durable replay store even if
      // the separate history insert failed. Same-key replay must not re-charge.
      ...(persistenceWarning ? { _persistence: persistenceWarning, warning: persistenceWarning.message, reconciliation_required: true } : {}),
      _billing: {
        operation_id: settlement.operationId,
        credits_charged: settlement.billing?.creditsCharged || 0,
        remaining: settlement.balanceAfter,
        already_fulfilled: settlement.alreadyFulfilled === true,
        token_usage: tokenUsage,
      },
    }), { headers: { "Content-Type": "application/json", "X-Stream-Delivery": "buffered", "X-Stream-Delivery-Reason": "non_stream_requested" } });
  } catch {
    console.error("[Billing] Non-stream LLM settlement failed", { code: "LLM_BILLING_FAILED" });
    return new Response(JSON.stringify({
      error: "模型已返回，但共享钱包结算失败，本次不会交付完成结果",
      code: "LLM_BILLING_FAILED",
      retryable: false,
      stream_delivery: "buffered",
      stream_delivery_reason: "non_stream_requested",
    }), {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Stream-Delivery": "buffered", "X-Stream-Delivery-Reason": "non_stream_requested" },
    });
  }

}
