/**
 * 智谱AI (ZhipuAI / BigModel) 流式代理模块
 *
 * 架构对齐 proxy.ts（2026-06-22 push-based streaming 修复后锁定）：
 * - start() 模式：持续推流，消除 pull() 逐 chunk 往返延迟
 * - nativeFetch：零框架开销直连，绕过 Next.js fetch 拦截
 * - 快速透传：raw chunk 直接转发前端，并行解析仅用于计费回调
 * - 流读取超时：60s 无数据则优雅关闭（防止永久挂起）
 * - 客户端断连检测：desiredSize === null 时立即停止
 * - 优雅错误处理：错误 chunk + close，不使用 controller.error()
 */

import type { ChatRequest, ProxyResult, StreamCallbacks } from "./types";
import { SseEventStreamDecoder, type DecodedSseEvent } from "../sse-stream-decoder";
import { LlmStreamError, upstreamContentRejection, upstreamStreamError } from "./stream-error";
import { nativeFetch } from "./native-fetch";

// GLM 4.5+ uses thinking.type; omitting false leaves provider thinking enabled.
export function zhipuThinkingOptions(request: Pick<ChatRequest, "model" | "enable_thinking">) {
  if (!/^glm-(?:5|4\.[5-9])(?:[.v-]|$)/iu.test(request.model) || typeof request.enable_thinking !== "boolean") return {};
  return { thinking: { type: request.enable_thinking ? "enabled" : "disabled" } };
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════
/** 流读取超时：上游停止发送数据后多久判定断流（毫秒） */
/** 推理模型（GLM-5/DeepSeek-R/V4-Pro/GPT-5.4-Pro）TTFB 可达 30~199s，需更长容忍窗口 */
const STREAM_READ_TIMEOUT = 120_000;

// ═══════════════════════════════════════════════════════════
// 流式调用 — start() 模式 + nativeFetch + 快速透传
// ═══════════════════════════════════════════════════════════
/**
 * 智谱AI SSE 流式调用
 *
 * 与 proxy.chatStream() 架构完全对齐：
 * 1. ReadableStream 使用 start() 模式（push-based streaming）
 * 2. 使用 nativeFetch() 绕过 Next.js fetch 拦截
 * 3. 原始 chunk 直接透传前端（快速透传），并行解析仅用于计费回调
 * 4. 流读取超时 60s、客户端断连检测、优雅错误处理
 *
 * @param request  - OpenAI 兼容格式请求体
 * @param options  - apiBase / apiKey / timeout / 回调
 * @returns ReadableStream<Uint8Array>  — 可直接 pipeTo() 到前端
 */
export async function zhipuChatStream(
  request: ChatRequest,
  options: {
    apiBase: string;
    apiKey: string;
    timeout?: number;
    onContent?: StreamCallbacks["onContent"];
    onReasoning?: StreamCallbacks["onReasoning"];
    onUsage?: StreamCallbacks["onUsage"];
    onFirstByte?: StreamCallbacks["onFirstByte"];
  },
): Promise<ReadableStream<Uint8Array>> {
  const {
    apiBase,
    apiKey,
    timeout = 120,
    onContent,
    onReasoning,
    onUsage,
    onFirstByte,
  } = options;

  // ── URL 构建（智谱 API 路径已含版本号，如 /api/paas/v4） ──
  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  // ── 请求体（补齐 proxy.ts 已有的字段） ──
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: true,
    ...(request.max_tokens && request.max_tokens > 0
      ? { max_tokens: request.max_tokens }
      : {}),
    ...(request.temperature !== undefined && request.temperature !== null
      ? { temperature: request.temperature }
      : {}),
    ...zhipuThinkingOptions(request),
    ...(request.response_format
      ? { response_format: request.response_format }
      : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.stream_options
      ? { stream_options: request.stream_options }
      : {}),
  });

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // ═══════════════════════════════════════════════════════════
  // 核心：ReadableStream + start() 模式
  // ═══════════════════════════════════════════════════════════
  const requestStart = Date.now();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // ── 心跳：立即发送，告诉前端连接已建立 ──
      controller.enqueue(encoder.encode(": heartbeat\n\n"));

      let firstByteReceived = false;
      const events = new SseEventStreamDecoder();
      let upstreamCompleted = false;
      let finalEventReceived = false;
      let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const deliver = (event: DecodedSseEvent) => {
        if (event.data.trim() === "[DONE]") { upstreamCompleted = true; finalEventReceived = true; return; }
        let parsed;
        try { parsed = JSON.parse(event.data); } catch {
          if (event.event === "error") throw upstreamStreamError({});
          return;
        }
        if (parsed?.error || event.event === "error") throw upstreamStreamError(parsed);
        const contentRejection = upstreamContentRejection(parsed);
        if (contentRejection) throw contentRejection;
        const choice = parsed?.choices?.[0];
        if (choice?.finish_reason != null) upstreamCompleted = true;
        const delta = choice?.delta;
        if (typeof delta?.content === "string") onContent?.(delta.content);
        const reasoning = delta?.reasoning_content || delta?.reasoning;
        if (typeof reasoning === "string") onReasoning?.(reasoning);
        if (parsed?.usage) onUsage?.({
          prompt_tokens: parsed.usage.prompt_tokens || 0,
          completion_tokens: parsed.usage.completion_tokens || 0,
          cached_tokens: parsed.usage.cached_tokens || 0,
        });
        if (!streamClosed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
      };
      let streamReadTimer: ReturnType<typeof setTimeout> | null = null;
      let streamClosed = false;

      // ── 工具函数 ──
      function resetStreamReadTimeout() {
        if (streamReadTimer) clearTimeout(streamReadTimer);
        streamReadTimer = setTimeout(() => {
          if (streamClosed) return;
          console.warn(
            `[ZhipuProxy] 流读取超时 (${STREAM_READ_TIMEOUT / 1000}s)，优雅关闭`,
          );
          gracefulClose("上游响应超时，请重试");
        }, STREAM_READ_TIMEOUT);
      }

      function gracefulClose(errorMsg?: string, code?: string) {
        if (streamClosed) return;
        streamClosed = true;
        void upstreamReader?.cancel().catch(() => {});
        if (streamReadTimer) clearTimeout(streamReadTimer);
        try {
          if (errorMsg) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: errorMsg, code, done: false })}\n\n`,
              ),
            );
          }
          // 不发 [DONE] — 由 wrappedStream 的 pipeTo close() 回调兜底发送
          controller.close();
        } catch {
          // controller 可能已关闭
        }
      }

      // ── 启动流读取超时 ──
      resetStreamReadTimeout();

      try {
        // ── 连接上游（nativeFetch 零框架开销） ──
        const nativeRes = await nativeFetch(url, {
          method: "POST",
          headers: requestHeaders,
          body,
          timeout, // 连接超时（秒）
        });

        // ── 处理非 200 响应 ──
        if (!nativeRes.ok) {
          let errMsg = `智谱AI API 错误 (${nativeRes.status})`;
          try {
            const errChunks: Uint8Array[] = [];
            const errReader = nativeRes.body.getReader();
            while (true) {
              const { done, value } = await errReader.read();
              if (done) break;
              errChunks.push(value);
            }
            const errText = decoder.decode(
              Buffer.concat(errChunks),
              { stream: false },
            );
            const errJson = JSON.parse(errText);
            errMsg =
              errJson.error?.message || errJson.message || errMsg;
          } catch {
            /* 解析失败就用默认消息 */
          }

          // 429 精确识别：智谱AI用429同时表示限流和余额不足，必须区分
          if (nativeRes.status === 429) {
            const errLower = errMsg.toLowerCase();
            if (/余额不足|无可用资源包|insufficient|balance|quota/i.test(errLower)) {
              // 余额不足/资源包耗尽：不可恢复，重试无意义，标记让上层降级
              errMsg = `ZHIPU_BALANCE_EXHAUSTED: ${errMsg}`;
            } else {
              // 真正的限流：临时性的，可重试
              errMsg = "上游服务暂时繁忙(429)，请稍后重试";
            }
          }

          console.error(
            `[ZhipuProxy] API 错误: ${nativeRes.status} ${errMsg}`,
          );
          const upstreamError = upstreamStreamError({
            error: { code: String(nativeRes.status), message: errMsg },
          });
          gracefulClose(upstreamError.message, upstreamError.code);
          return;
        }

        // ── 读取上游 SSE 流 ──
        const reader = nativeRes.body.getReader();
        upstreamReader = reader;
        if (streamClosed) { await reader.cancel(); return; }

        // ★ 主循环：start() 模式，持续读取并推流
        while (true) {
          // ★ 客户端断连检测
          if (streamClosed || controller.desiredSize === null) {
            console.log("[ZhipuProxy] 客户端已断连，停止读取");
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          // ── TTFB 测量（首次读到数据的时间点） ──
          if (!firstByteReceived) {
            firstByteReceived = true;
            const ttfb = Date.now() - requestStart;
            onFirstByte?.(ttfb);
            console.log(
              `[PERF] ZhipuAI TTFB: ${ttfb}ms (model=${request.model})`,
            );
          }

          // ── 重置流读取超时 ──
          resetStreamReadTimeout();

          for (const event of events.push(value)) deliver(event);
          if (finalEventReceived) break;
        }
        if (streamClosed) return;
        for (const event of events.finish()) deliver(event);
        if (!upstreamCompleted) throw new LlmStreamError("该模型回复中断，未收到完整结果，请稍后重试", "LLM_STREAM_INTERRUPTED");

        // ── 正常流结束 ──
        console.log(
          `[ZhipuProxy] 流完成: model=${request.model}, 耗时=${Date.now() - requestStart}ms`,
        );
        gracefulClose();
      } catch (err) {
        if (err instanceof LlmStreamError) { gracefulClose(err.message, err.code); return; }
        // ── 异常处理：优雅关闭，发送错误 chunk ──
        const errMsg =
          err instanceof Error ? err.message : String(err);

        // 区分超时、网络错误和其他异常
        let userMsg = `流式传输异常: ${errMsg}`;
        if (errMsg.includes("timeout") || errMsg.includes("Timeout")) {
          userMsg = "上游响应超时，请重试";
        } else if (
          errMsg.includes("ECONNREFUSED") ||
          errMsg.includes("ENOTFOUND") ||
          errMsg.includes("ECONNRESET")
        ) {
          userMsg = "上游连接失败，请稍后重试";
        }

        console.error(
          `[ZhipuProxy] 流异常: model=${request.model}, 错误=${errMsg}`,
        );
        const upstreamError = upstreamStreamError({ error: userMsg });
        gracefulClose(upstreamError.message, upstreamError.code);
      }
    },
  });
}

// ═══════════════════════════════════════════════════════════
// 非流式调用
// ═══════════════════════════════════════════════════════════
/**
 * 智谱AI非流式对话 — 返回标准化 ProxyResult
 * 同样使用 nativeFetch，对齐 proxy.chat() 架构
 */
export async function zhipuChat(
  request: ChatRequest,
  options: { apiBase: string; apiKey: string; timeout?: number },
): Promise<ProxyResult> {
  const { apiBase, apiKey, timeout = 120 } = options;
  const url = `${apiBase.replace(/\/+$/, "")}/chat/completions`;

  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: false,
    ...(request.max_tokens && request.max_tokens > 0
      ? { max_tokens: request.max_tokens }
      : {}),
    ...(request.temperature !== undefined && request.temperature !== null
      ? { temperature: request.temperature }
      : {}),
    ...zhipuThinkingOptions(request),
  });

  const nativeRes = await nativeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeout,
  });

  if (!nativeRes.ok) {
    const errText = await nativeRes.text();
    throw new Error(`智谱AI API ${nativeRes.status}: ${errText}`);
  }

  const data = await nativeRes.json();
  const contentRejection = upstreamContentRejection(data);
  if (contentRejection) throw contentRejection;

  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";
  const usage = {
    prompt_tokens: data.usage?.prompt_tokens || 0,
    completion_tokens: data.usage?.completion_tokens || 0,
    cached_tokens: data.usage?.cached_tokens || 0,
  };

  return {
    content,
    reasoning_content: reasoning,
    usage,
    model: data.model || request.model,
    raw: data,
  };
}

// ═══════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════
/** 检测是否为智谱AI API */
export function isZhipuApi(apiBase: string): boolean {
  return apiBase.includes("bigmodel.cn");
}
