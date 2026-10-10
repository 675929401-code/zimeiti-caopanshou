/**
 * LLM Route — 深度思考模式 type=1 处理器
 *
 * 从 route.ts 提取的独立模块：推理模型先思考，再交给对话模型回答。
 * 分离原因：type=1 是独立的两阶段流程（~220行），与普通流式/非流式完全不同。
 *
 * 返回 Response = 深度思考流程已处理，route.ts 直接返回
 * 返回 null = 非 type=1，route.ts 继续走普通流程
 */

import { getLLMProxy } from "@/lib/llm-proxy";
import type { ChatRequest } from "@/lib/llm-proxy";
import { llmProxyBindingConfig, type LlmProviderBinding } from "@/lib/llm-provider-contract";
import {
  settleLlmUsage,
  type SelectedModelBillingSnapshot,
} from "@/lib/llm-billing";
import { zhipuChatStream } from "@/lib/llm-proxy/zhipu-proxy";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { ChatMessage } from "@/lib/llm-context";

export interface DeepThinkingContext {
  verifiedUserId: string;
  userRole: string;
  agentId?: string;
  agentName?: string;
  conversationId?: string;
  useModel: string;
  useApiKey: string;
  apiBase: string;
  llmProviderBinding: LlmProviderBinding;
  isZhipuAI: boolean;
  agentTimeout: number;
  agentDeepThinkingType: number;
  agentDeductDeepThink: number;
  agentMaxReplyTokens: number;
  clientRequestId: string;
  selectedModelBillingSnapshot: SelectedModelBillingSnapshot;
  agentEnableWebSearch: boolean;
  modelSupportsNativeSearch: boolean;
  searchInjectedMessages: ChatMessage[];
  messages: ChatMessage[];
  userMessageSaved?: { value: boolean };
}

export async function handleDeepThinkingType1(
  ctx: DeepThinkingContext,
): Promise<Response | null> {
  if (ctx.agentDeepThinkingType !== 1) return null;

  const THINKING_MAX_TOKENS = ctx.agentMaxReplyTokens > 0
    ? Math.max(1024, Math.min(4096, Math.floor(ctx.agentMaxReplyTokens * 0.5)))
    : 8192;

  try {
    // 两阶段都使用用户明确选择的公共模型。不可暗中切换到一条没有
    // 独立价格快照的固定推理模型，否则会产生模型与扣费价格漂移。
    const actualThinkingModel = ctx.useModel;
    const thinkRequest: ChatRequest = {
      model: actualThinkingModel,
      messages: ctx.searchInjectedMessages,
      max_tokens: THINKING_MAX_TOKENS,
      stream_options: { include_usage: true },
    };

    let thinkingContent = "";
    let reasoningContent = "";
    let thinkingUsage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
    const encoder = new TextEncoder();

    const mergedStream = new ReadableStream({
      async start(controller) {
        let mergedClosed = false;
        const bufferedThinkingChunks: Uint8Array[] = [];
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        let lastProgressAt = 0;
        let lastProgressChars = 0;
        const safeEnqueue = (chunk: Uint8Array): boolean => {
          if (mergedClosed) return false;
          try {
            controller.enqueue(chunk);
            return true;
          } catch {
            mergedClosed = true;
            return false;
          }
        };
        const safeClose = () => {
          if (mergedClosed) return;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          try { controller.close(); } catch { /* already closed */ }
          mergedClosed = true;
        };
        const emitProgress = (phase: "thinking" | "answer", receivedChars: number) => {
          const now = Date.now();
          if (receivedChars < 1 || (lastProgressAt !== 0 && now - lastProgressAt < 800 && receivedChars - lastProgressChars < 240)) return;
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({
            type: "generation_progress",
            phase,
            received_chars: receivedChars,
            stream_delivery: "buffered",
          })}\n\n`));
          lastProgressAt = now;
          lastProgressChars = receivedChars;
        };

        try {
          safeEnqueue(encoder.encode(": heartbeat\n\n"));
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({
            type: "stream_delivery",
            stream_delivery: "buffered",
            stream_delivery_reason: "deep_thinking_multi_stage_atomic_budget_unavailable",
          })}\n\n`));
          heartbeatTimer = setInterval(() => {
            safeEnqueue(encoder.encode(": heartbeat\n\n"));
          }, 5_000);

          // 上游连接必须在外层 SSE 建立并交付首包后才开始。
          let proxyStream: ReadableStream<Uint8Array>;
          if (ctx.isZhipuAI) {
            proxyStream = await zhipuChatStream(thinkRequest, {
              apiBase: ctx.apiBase,
              apiKey: ctx.useApiKey,
              timeout: Math.min(Math.floor(ctx.agentTimeout / 2), 120),
              onContent: (text) => { thinkingContent += text; emitProgress("thinking", thinkingContent.length + reasoningContent.length); },
              onReasoning: (text) => { reasoningContent += text; emitProgress("thinking", thinkingContent.length + reasoningContent.length); },
              onUsage: (usage) => { thinkingUsage = usage; },
            });
          } else {
            const thinkProxy = getLLMProxy({
              apiBase: ctx.apiBase,
              apiKey: ctx.useApiKey,
              defaultModel: actualThinkingModel,
              timeout: Math.min(Math.floor(ctx.agentTimeout / 2), 120),
              ...llmProxyBindingConfig(ctx.llmProviderBinding),
            });
            proxyStream = await thinkProxy.chatStream(thinkRequest, {
              onContent: (text) => { thinkingContent += text; emitProgress("thinking", thinkingContent.length + reasoningContent.length); },
              onReasoning: (text) => { reasoningContent += text; emitProgress("thinking", thinkingContent.length + reasoningContent.length); },
              onUsage: (usage) => { thinkingUsage = usage; },
            });
          }

          // 思考内容先在服务端缓冲；只有该阶段原子结算成功后才交付。
          await proxyStream.pipeTo(new WritableStream({
            write(chunk) {
              bufferedThinkingChunks.push(chunk.slice());
            },
            close() { /* 思考阶段结束，继续后续流程 */ },
            abort() { throw new Error("THINK_STREAM_ABORTED"); },
          }), { preventAbort: true, preventCancel: true });

          // 思考阶段原子结算；只有结算成功才允许进入回答阶段。
          const thinkBlock = reasoningContent || thinkingContent;
          if (!thinkBlock) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify({
              error: "思考模型未返回内容",
              code: "LLM_EMPTY_RESPONSE",
              done: false,
            })}\n\n`));
            safeClose();
            return;
          }
          const measuredThinking = thinkingUsage.prompt_tokens > 0 || thinkingUsage.completion_tokens > 0
            ? thinkingUsage
            : {
                prompt_tokens: Math.ceil(JSON.stringify(thinkRequest.messages).length / 2),
                completion_tokens: Math.ceil(thinkBlock.length / 2),
                cached_tokens: 0,
              };
          const thinkCompletionTokens = Math.ceil(measuredThinking.completion_tokens * (ctx.agentDeductDeepThink || 1));
          await settleLlmUsage(
            ctx.verifiedUserId, `${ctx.agentName || "unknown"}(思考)`, actualThinkingModel,
            measuredThinking.prompt_tokens, thinkCompletionTokens, measuredThinking.cached_tokens,
            ctx.agentId,
            {
              isAdmin: ctx.userRole === "admin",
              clientRequestId: ctx.clientRequestId,
              phase: "thinking",
              billingSnapshot: ctx.selectedModelBillingSnapshot,
              isDeepThinking: true,
            },
          );
          for (const chunk of bufferedThinkingChunks) {
            if (!safeEnqueue(chunk)) break;
          }

          // 阶段2：链式调用对话模型
          if (thinkBlock) {
            safeEnqueue(encoder.encode(
              `data: ${JSON.stringify({
                thinking_complete: true,
                stream_delivery: "buffered",
                stream_delivery_reason: "deep_thinking_phase_settled_before_replay",
              })}\n\n`,
            ));
            lastProgressAt = 0;
            lastProgressChars = 0;

            const enrichedMessages = [
              ...ctx.searchInjectedMessages,
              {
                role: "assistant" as const,
                content: `[深度思考结果]\n${thinkBlock}\n\n[请基于以上思考，给出专业、全面的回答]`,
              },
            ];

            const effectiveEnableWebSearch = ctx.agentEnableWebSearch && ctx.modelSupportsNativeSearch;

            const chatRequest: ChatRequest = {
              model: ctx.useModel,
              messages: enrichedMessages,
              max_tokens: ctx.agentMaxReplyTokens > 0 ? ctx.agentMaxReplyTokens : undefined,
              stream_options: { include_usage: true },
              ...(effectiveEnableWebSearch ? { tools: [{ type: "web_search", web_search: {} }] } : {}),
            };

            let fullContent = "";
            let finalUsage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
            const bufferedAnswerChunks: Uint8Array[] = [];
            let chatStream: ReadableStream<Uint8Array>;

            if (ctx.isZhipuAI) {
              chatStream = await zhipuChatStream(chatRequest, {
                apiBase: ctx.apiBase,
                apiKey: ctx.useApiKey,
                timeout: Math.min(ctx.agentTimeout, 300),
                onContent: (text) => { fullContent += text; emitProgress("answer", fullContent.length); },
                onUsage: (usage) => { finalUsage = usage; },
              });
            } else {
              const chatProxy = getLLMProxy({
                apiBase: ctx.apiBase,
                apiKey: ctx.useApiKey,
                defaultModel: ctx.useModel,
                timeout: Math.min(ctx.agentTimeout, 300),
                ...llmProxyBindingConfig(ctx.llmProviderBinding),
              });
              chatStream = await chatProxy.chatStream(chatRequest, {
                onContent: (text) => { fullContent += text; emitProgress("answer", fullContent.length); },
                onUsage: (usage) => { finalUsage = usage; },
              });
            }

            // 最终回答同样先缓冲，结算成功后再交付。
            await chatStream.pipeTo(new WritableStream({
              write(chunk) {
                bufferedAnswerChunks.push(chunk.slice());
              },
              async close() {
                // ★ 空内容安全网
                if (!fullContent) {
                  const emptyErr = `模型 ${ctx.useModel} 未返回任何内容，请重试或切换模型`;
                  console.error(`[LLM Route] ⚠️ deep_thinking_type=1 流完成但内容为空: model=${ctx.useModel}, agent=${ctx.agentName}`);
                  safeEnqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: emptyErr, code: "LLM_EMPTY_RESPONSE", done: false })}\n\n`));
                  safeClose();
                  return;
                }
                const measuredFinal = finalUsage.prompt_tokens > 0 || finalUsage.completion_tokens > 0
                  ? finalUsage
                  : {
                      prompt_tokens: Math.ceil(JSON.stringify(chatRequest.messages).length / 2),
                      completion_tokens: Math.ceil(fullContent.length / 2),
                      cached_tokens: 0,
                    };
                try {
                  const settlement = await settleLlmUsage(
                    ctx.verifiedUserId, ctx.agentName || "unknown", ctx.useModel,
                    measuredFinal.prompt_tokens, measuredFinal.completion_tokens, measuredFinal.cached_tokens,
                    ctx.agentId,
                    {
                      isAdmin: ctx.userRole === "admin",
                      clientRequestId: ctx.clientRequestId,
                      phase: "answer",
                      billingSnapshot: ctx.selectedModelBillingSnapshot,
                    },
                  );
                  for (const chunk of bufferedAnswerChunks) {
                    if (!safeEnqueue(chunk)) break;
                  }
                  safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                    billing_complete: true,
                    phase: "answer",
                    stream_delivery: "buffered",
                    stream_delivery_reason: "deep_thinking_multi_stage_atomic_budget_unavailable",
                    operation_id: settlement.operationId,
                    credits_charged: settlement.billing?.creditsCharged || 0,
                    balance_after: settlement.balanceAfter,
                    already_fulfilled: settlement.alreadyFulfilled === true,
                  })}\n\n`));
                } catch (billingError) {
                  console.error("[DeepThinking] Answer settlement failed:", billingError);
                  safeEnqueue(encoder.encode(`data: ${JSON.stringify({
                    error: "共享钱包结算失败，本次未交付最终回答",
                    code: "LLM_BILLING_FAILED",
                    done: false,
                  })}\n\n`));
                  safeClose();
                  return;
                }
                // 保存消息（fire-and-forget）
                // 注意：用户消息已在 llm/route.ts 入口处保存，此处不再重复保存
                if (ctx.conversationId && ctx.verifiedUserId && fullContent) {
                  const supabase = getSupabaseClient();
                  const now = new Date().toISOString();
                  supabase.from("conversations").upsert({
                    id: ctx.conversationId, user_id: ctx.verifiedUserId, agent_id: ctx.agentId || "llm",
                    title: ctx.messages[ctx.messages.length - 1]?.content?.slice(0, 50) || "新对话",
                    source: "llm", updated_at: now,
                  }, { onConflict: "id" }).then(() => {
                    supabase.from("conversation_messages").insert({
                      id: crypto.randomUUID(), conversation_id: ctx.conversationId, user_id: ctx.verifiedUserId,
                      agent_id: ctx.agentId || "llm", role: "assistant", content: fullContent,
                      reasoning_content: reasoningContent || "",
                      created_at: new Date(Date.now() + 1).toISOString(),
                    }).then(() => {}).catch(() => {});
                  }).catch(() => {});
                }
                safeEnqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                safeClose();
              },
              abort() { /* incomplete phase is not charged or marked complete */ },
            }), { preventAbort: true, preventCancel: true });
          } else {
            safeClose();
          }
        } catch (err: unknown) {
          console.error("[DeepThinking] Stream error:", err);
          safeEnqueue(encoder.encode(
            `data: ${JSON.stringify({ error: "思考流中断" })}\n\n`,
          ));
          safeClose();
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      },
    });

    return new Response(mergedStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Stream-Delivery": "buffered",
        "X-Stream-Delivery-Reason": "deep_thinking_multi_stage_atomic_budget_unavailable",
      },
    });
  } catch (thinkErr) {
    console.warn("[DeepThinking] Thinking model failed; automatic paid fallback is disabled:", thinkErr);
    return new Response(
      JSON.stringify({
        error: "深度思考请求失败，本次未自动切换或再次调用其他模型；请检查配置后手动重试或手动选择模型。",
        code: "DEEP_THINKING_FAILED",
        retryable: false,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
