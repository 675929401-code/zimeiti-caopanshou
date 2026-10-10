/**
 * 技能聊天处理器 — 独立模块
 *
 * 职责：
 * 处理 LLM Function Calling 的 tool_call 循环：
 *   LLM 响应包含 tool_calls → 执行技能 → 将结果回传 LLM → LLM 整合输出
 *
 * 调用时机：
 * 仅当智能体有技能且 LLM 返回 tool_calls 时激活
 * 其余情况完全不影响现有流程
 *
 * 架构：
 * - 先建立 SSE 流返回给前端
 * - Step 1: 非流式调用 LLM（检测 tool_calls）
 * - Step 2: 有 tool_calls → 执行技能（期间持续发心跳保活）
 * - Step 3: 流式重调 LLM → 整合输出
 * - 无 tool_calls → 将第1次结果包装为流式格式输出
 *
 * 隔离原则：
 * - 独立文件，不修改任何现有模块
 * - 通过参数接收所有依赖，不引入全局状态
 */

import type { ChatRequest, LLMProxy } from "@/lib/llm-proxy";
import { executeToolCalls, type ToolCall } from "./skill-executor";
import {
  settleLlmUsage,
  type SelectedModelBillingSnapshot,
} from "./llm-billing";

// ── 类型定义 ──

export interface SkillChatContext {
  agentId: string;
  agentName?: string;
  conversationId?: string;
  verifiedUserId: string;
  userRole: string;
  proxy: LLMProxy;
  apiBase: string;
  apiKey: string;
  model: string;
  timeout: number;
  clientRequestId: string;
  selectedModelBillingSnapshot: SelectedModelBillingSnapshot;
}

// ── SSE 工具函数 ──

const encoder = new TextEncoder();

function sseData(data: string): Uint8Array {
  return encoder.encode(`data: ${data}\n\n`);
}

function sseHeartbeat(): Uint8Array {
  return encoder.encode(": heartbeat\n\n");
}

function sseDone(): Uint8Array {
  return encoder.encode("data: [DONE]\n\n");
}

// ── 核心：带技能调度的聊天流程 ──

/**
 * 处理带技能调度的聊天请求
 *
 * 返回一个 Response（SSE 流），对前端完全透明。
 * 前端不需要知道技能调度的存在，它只看到一个正常的 SSE 流。
 *
 * 关键改进：先建立 SSE 流，在技能执行期间持续发心跳包，
 * 防止前端/代理因长时间无数据而断开连接。
 */
export async function handleSkillChat(
  ctx: SkillChatContext,
  chatRequest: ChatRequest,
  onToolCallDetected?: (toolCalls: ToolCall[]) => void,
): Promise<Response> {
  const { proxy, agentId } = ctx;

  // 先建立 SSE 流，确保前端在整个过程中都能收到数据
  const stream = new ReadableStream({
    async start(controller) {
      // 心跳定时器：每 5 秒发一次心跳，防止连接被断开
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let closed = false;
      let lastProgressAt = 0;
      let lastProgressChars = 0;

      const startHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(sseHeartbeat());
            } catch {
              // controller 已关闭，停止心跳
              if (heartbeatTimer) clearInterval(heartbeatTimer);
            }
          }
        }, 5000);
      };

      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      const safeEnqueue = (data: Uint8Array): boolean => {
        if (!closed) {
          try {
            controller.enqueue(data);
          } catch {
            closed = true;
            stopHeartbeat();
          }
        }
        return !closed;
      };

      const safeClose = () => {
        if (!closed) {
          closed = true;
          stopHeartbeat();
          try { controller.close(); } catch { /* already closed */ }
        }
      };

      try {
        // 发送初始心跳
        safeEnqueue(sseHeartbeat());
        safeEnqueue(sseData(JSON.stringify({
          type: "stream_delivery",
          stream_delivery: "buffered",
          stream_delivery_reason: "skill_multi_stage_atomic_budget_unavailable",
        })));
        startHeartbeat();

        // ── Step 1: 非流式调用 LLM，检测 tool_calls ──
        console.log(`[SkillChat] 第1次调用 LLM (非流式，检测 tool_calls), agent=${agentId}`);

        const firstRequest: ChatRequest = {
          ...chatRequest,
          stream_options: undefined, // 非流式
        };

        const firstResult = await proxy.chat(firstRequest);
        const rawResponse = firstResult.raw as Record<string, unknown> | undefined;

        // 检查是否有 tool_calls
        const choices = rawResponse?.choices as Array<{ finish_reason?: string; message?: { tool_calls?: ToolCall[]; content?: string } }> | undefined;
        const firstChoice = choices?.[0];
        const toolCalls = firstChoice?.message?.tool_calls;
        const firstContent = firstChoice?.message?.content || firstResult.content || "";

        const firstUsage = firstResult.usage || {
          prompt_tokens: Math.ceil(JSON.stringify(firstRequest.messages).length / 2),
          completion_tokens: Math.ceil((firstContent.length + (firstResult.reasoning_content?.length || 0)) / 2),
          cached_tokens: 0,
        };
        const firstSettlement = await settleLlmUsage(
          ctx.verifiedUserId,
          `${ctx.agentName || "unknown"}(技能识别)`,
          ctx.model,
          firstUsage.prompt_tokens,
          firstUsage.completion_tokens,
          firstUsage.cached_tokens,
          ctx.agentId,
          {
            isAdmin: ctx.userRole === "admin",
            clientRequestId: ctx.clientRequestId,
            phase: "skill-detect",
            billingSnapshot: ctx.selectedModelBillingSnapshot,
          },
        );

        // ── Step 2: 无 tool_calls → 包装为流式输出 ──
        if (!toolCalls || toolCalls.length === 0) {
          console.log(`[SkillChat] 无 tool_calls，直接输出内容 (${firstContent.length} 字符)`);
          stopHeartbeat();

          // 发送推理内容
          if (firstResult.reasoning_content) {
            const reasoningChunk = {
              choices: [{
                delta: { reasoning_content: firstResult.reasoning_content },
                finish_reason: null,
              }],
            };
            safeEnqueue(sseData(JSON.stringify(reasoningChunk)));
          }

          // 发送内容（模拟流式，分块发送）
          const chunkSize = 100;
          for (let i = 0; i < firstContent.length; i += chunkSize) {
            const chunk = firstContent.slice(i, i + chunkSize);
            const sseChunk = {
              choices: [{
                delta: { content: chunk },
                finish_reason: null,
              }],
            };
            safeEnqueue(sseData(JSON.stringify(sseChunk)));
          }

          // 发送结束标记
          const doneChunk = {
            choices: [{ delta: {}, finish_reason: "stop" }],
            ...(firstResult.usage ? { usage: firstResult.usage } : {}),
          };
          safeEnqueue(sseData(JSON.stringify(doneChunk)));
          safeEnqueue(sseData(JSON.stringify({
            billing_complete: true,
            phase: "skill-detect",
            stream_delivery: "buffered",
            stream_delivery_reason: "skill_initial_call_requires_settlement",
            operation_id: firstSettlement.operationId,
            credits_charged: firstSettlement.billing?.creditsCharged || 0,
            balance_after: firstSettlement.balanceAfter,
            already_fulfilled: firstSettlement.alreadyFulfilled === true,
          })));
          safeEnqueue(sseDone());
          safeClose();
          return;
        }

        // ── Step 3: 有 tool_calls → 发送状态通知 → 执行技能 ──
        console.log(`[SkillChat] 检测到 ${toolCalls.length} 个 tool_calls:`, toolCalls.map((tc) => tc.function.name).join(", "));

        // 通知前端正在调用技能
        if (onToolCallDetected) onToolCallDetected(toolCalls);

        // 发送技能调用状态事件（前端可展示"正在提取文案..."等提示）
        const skillStatusEvent = {
          type: "skill_execution",
          status: "executing",
          tools: toolCalls.map((tc) => ({
            name: tc.function.name,
            status: "running",
          })),
        };
        safeEnqueue(sseData(JSON.stringify(skillStatusEvent)));

        // 执行技能（期间心跳包持续发送，保持连接）
        console.log(`[SkillChat] 开始执行技能...`);
        const toolResults = await executeToolCalls(agentId, toolCalls);
        console.log(`[SkillChat] 技能执行完成:`, toolResults.map((r) => `success=${r.success}, duration=${r.duration_ms}ms`).join("; "));

        // 发送技能执行完成事件
        const skillDoneEvent = {
          type: "skill_execution",
          status: "completed",
          tools: toolCalls.map((tc) => {
            const result = toolResults.find((r) => r.tool_call_id === tc.id);
            return {
              name: tc.function.name,
              status: result?.success ? "success" : "failed",
              duration_ms: result?.duration_ms,
            };
          }),
        };
        safeEnqueue(sseData(JSON.stringify(skillDoneEvent)));

        // ── Step 4: 构建 messages 并流式重调 LLM ──
        const secondMessages = [
          ...chatRequest.messages,
          {
            role: "assistant" as const,
            content: firstContent || "",
            tool_calls: toolCalls,
          },
          ...toolResults.map((tr) => ({
            role: "tool" as const,
            tool_call_id: tr.tool_call_id,
            content: tr.content,
          })),
        ] as ChatRequest["messages"];

        const secondRequest: ChatRequest = {
          ...chatRequest,
          messages: secondMessages,
          tools: undefined,
          stream_options: { include_usage: true },
        };

        console.log(`[SkillChat] 第2次调用 LLM (流式，整合技能结果)`);

        // 最终回答必须在结算成功前继续缓冲；心跳和进度事件负责保活。
        let secondContent = "";
        let secondUsage: { prompt_tokens: number; completion_tokens: number; cached_tokens: number } | null = null;
        const bufferedAnswerChunks: Uint8Array[] = [];
        const secondStream = await proxy.chatStream(secondRequest, {
          onContent: (text) => {
            secondContent += text;
            const now = Date.now();
            if (lastProgressAt === 0 || now - lastProgressAt >= 800 || secondContent.length - lastProgressChars >= 240) {
              safeEnqueue(sseData(JSON.stringify({
                type: "generation_progress",
                phase: "skill-answer",
                received_chars: secondContent.length,
                stream_delivery: "buffered",
              })));
              lastProgressAt = now;
              lastProgressChars = secondContent.length;
            }
          },
          onUsage: (usage) => { secondUsage = usage; },
        });

        await secondStream.pipeTo(new WritableStream({
          write(chunk) {
            // Never expose a paid skill answer before atomic settlement.
            // The server consumes the full upstream response even if the
            // browser disconnects, so disconnecting cannot waive the charge.
            bufferedAnswerChunks.push(chunk.slice());
          },
          async close() {
            if (!secondContent) {
              safeEnqueue(sseData(JSON.stringify({
                error: "技能整合模型未返回内容",
                code: "LLM_EMPTY_RESPONSE",
                done: false,
              })));
              safeClose();
              return;
            }
            const measured = secondUsage && (secondUsage.prompt_tokens > 0 || secondUsage.completion_tokens > 0)
              ? secondUsage
              : {
                  prompt_tokens: Math.ceil(JSON.stringify(secondRequest.messages).length / 2),
                  completion_tokens: Math.ceil(secondContent.length / 2),
                  cached_tokens: 0,
                };
            try {
              const settlement = await settleLlmUsage(
                ctx.verifiedUserId,
                `${ctx.agentName || "unknown"}(技能整合)`,
                ctx.model,
                measured.prompt_tokens,
                measured.completion_tokens,
                measured.cached_tokens,
                ctx.agentId,
                {
                  isAdmin: ctx.userRole === "admin",
                  clientRequestId: ctx.clientRequestId,
                  phase: "skill-answer",
                  billingSnapshot: ctx.selectedModelBillingSnapshot,
                },
              );
              for (const chunk of bufferedAnswerChunks) {
                if (!safeEnqueue(chunk)) break;
              }
              safeEnqueue(sseData(JSON.stringify({
                billing_complete: true,
                phase: "skill-answer",
                stream_delivery: "buffered",
                stream_delivery_reason: "skill_multi_stage_atomic_budget_unavailable",
                operation_id: settlement.operationId,
                credits_charged: settlement.billing?.creditsCharged || 0,
                balance_after: settlement.balanceAfter,
                already_fulfilled: settlement.alreadyFulfilled === true,
              })));
            } catch (billingError) {
              console.error("[SkillChat] 共享钱包结算失败:", billingError);
              safeEnqueue(sseData(JSON.stringify({
                error: "共享钱包结算失败，本次未交付技能回答",
                code: "LLM_BILLING_FAILED",
                done: false,
              })));
              safeClose();
              return;
            }
            safeEnqueue(sseDone());
            safeClose();
          },
          abort(reason) {
            console.warn(`[SkillChat] LLM流中断:`, reason);
            safeClose();
          },
        }), { preventAbort: true, preventCancel: true });

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg !== "CLIENT_DISCONNECTED" && errMsg !== "STREAM_CLOSED") {
          console.error(`[SkillChat] 异常:`, errMsg);
        }
        stopHeartbeat();
        // 尝试发送错误事件给前端
        if (!closed) {
          try {
            const errorEvent = {
              type: "skill_execution",
              status: "error",
              error: errMsg.slice(0, 200),
              done: false,
            };
            safeEnqueue(sseData(JSON.stringify(errorEvent)));
          } catch { /* ignore */ }
        }
        safeClose();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Stream-Delivery": "buffered",
      "X-Stream-Delivery-Reason": "skill_multi_stage_atomic_budget_unavailable",
    },
  });
}
