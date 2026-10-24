/**
 * 🔒 核心底层代码 — 锁定保护
 * 
 * 本文件是 LLM Proxy 核心引擎，属于系统核心底层架构。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "核心底层代码保护规则" 章节。
 * 
 * 锁定范围：整个文件
 * 锁定原因：流式透传性能关键路径 + 计费数据提取
 * 
 * ⚠️ 经用户同意修改（2026-06-14）：
 * - 从 https.request + Agent 架构迁移到 fetch() 架构
 * - 原因：Agent timeout 参数与 Node.js socket 管理冲突，导致 139 秒连接阻塞
 * - fetch() 轻量稳定，与 ZhipuAI Proxy 架构一致，对齐对标平台 AIWeb
 * - 所有业务逻辑（重试、计费提取、快速透传）保持不变
 *
 * ⚠️ 经用户同意修改（2026-06-22）：
 * - 从 pull() 模式迁移到 start() 模式（push-based streaming）
 * - 原因：pull() 模式每个 chunk 需要消费者请求→读取→入队的往返延迟
 *   导致流式输出"憋着然后爆发"的卡顿体验
 * - start() 模式持续 while 循环读取+入队，消除逐 chunk 延迟
 * - 所有业务逻辑（计费提取、首字节监控、快速透传）保持不变
 *
 * ⚠️ 经用户同意修改（2026-06-23）：
 * - 修复4xx错误被意外重试的bug（429不应重试，浪费时间）
 * - 修复TTFB测量基准错误（__t0从重试循环后→请求发起前，日志现在显示真实TTFB）
 * - 添加客户端断连检测（controller.desiredSize===null时停止写入，修复Controller is already closed）
 * - 用 safeEnqueue 包裹所有 controller.enqueue 调用，彻底消除竞态窗口
 */

/**
 * LLM Proxy 核心引擎 (v2 — fetch 架构)
 * 
 * ⚠️ 独立模块 — 与系统其他代码隔离
 * 出问题时：恢复 DEFAULT_PROXY_CONFIG 即可回到今天的状态
 * 
 * 对标 AIWeb 的关键点：
 * 1. 统一 OpenAI 格式输出，不管上游模型是什么
 * 2. 先发流再异步扣费（不阻塞 TTFB）
 * 3. fetch() 轻量调用（无 Agent 开销，无 TLS 管理负担，自动连接复用）
 * 4. 自动重试上游超时/5xx
 * 5. 干净的错误隔离：代理层错误不影响系统
 */

import { createHash } from "node:crypto";
import type { ProxyConfig, ProxyResult, StreamCallbacks, ChatRequest } from "./types";
import { SseEventStreamDecoder, type DecodedSseEvent } from "../sse-stream-decoder";
import { LlmResponseStartError, LlmStreamError, LlmStreamReadError, upstreamStreamError, buildLlmSafeDiagnostics, sanitizeLlmSafeDiagnostics, summarizeLlmProviderFailure, type LlmSafeDiagnostics } from "./stream-error";
import { buildOpenAIEndpoint } from "../api-endpoints";
import { ensureServerRuntimeEnvLoaded } from "@/lib/server-runtime-env";

type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
};
const ANTHROPIC_STOP_REASONS = new Set([
  "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded",
]);
const ANTHROPIC_USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

// ═══════════════════════════════════════════════════════════════
// 默认固定模板 — 出问题时恢复此配置即可
// ═══════════════════════════════════════════════════════════════
ensureServerRuntimeEnvLoaded();

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  apiBase: process.env.LLM_API_BASE_URL || "https://yunwu.ai",
  apiKey: process.env.LLM_API_KEY || "",
  defaultModel: process.env.LLM_DEFAULT_MODEL || "deepseek-v4-flash",
  provider: "environment",
  protocol: "openai_chat",
  authScheme: "bearer",
  timeout: 120,
  stream: true,
  includeUsage: true,
  keepAlive: true,
  retryCount: 0, // ★ 对齐AIWeb：不重试5xx，快速失败让用户决定
  retryDelay: 500,
};

// ═══════════════════════════════════════════════════════════════
// 核心类
// ═══════════════════════════════════════════════════════════════
export class LLMProxy {
  private config: ProxyConfig;

  constructor(config?: Partial<ProxyConfig>) {
    this.config = { ...DEFAULT_PROXY_CONFIG, ...config };
  }

  /** 更新配置（热更新，无需重启） */
  updateConfig(patch: Partial<ProxyConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 恢复默认配置 */
  resetToDefault(): void {
    this.config = { ...DEFAULT_PROXY_CONFIG };
  }

  /** 获取当前配置（只读） */
  getConfig(): Readonly<ProxyConfig> {
    return { ...this.config };
  }

  // ─────────────────────────────────────────────────────────
  // 流式调用 — 返回 ReadableStream（SSE 格式）
  // ─────────────────────────────────────────────────────────
  async chatStream(
    request: ChatRequest,
    callbacks?: StreamCallbacks,
  ): Promise<ReadableStream<Uint8Array>> {
    const { apiBase, timeout, retryCount, retryDelay, includeUsage, protocol } = this.config;
    const model = request.model || this.config.defaultModel;
    const useClaudeMessages = protocol === "anthropic_messages";
    const url = buildOpenAIEndpoint(apiBase, useClaudeMessages ? "messages" : "chat/completions");

    // 构建请求体（统一 OpenAI 格式）
    const body: Record<string, unknown> = useClaudeMessages
      ? buildClaudeMessagesBody(request, apiBase, model, true, this.config.thinkingStrategy)
      : buildOpenAiBody(request, apiBase, model, true, includeUsage, this.config.outputTokenField);

    const headers = providerHeaders(this.config, useClaudeMessages);
    const serializedBody = JSON.stringify(body);

    const encoder = new TextEncoder();

    // ★ TTFB 测量基准：从请求发起时开始计时（而非重试循环之后）
    const __requestStart = Date.now();

    // 带重试的 fetch 请求
    let response: Response | null = null;
    let lastError: Error | null = null;
    let httpDiagnostics: Readonly<LlmSafeDiagnostics> | undefined;
    const readErrorBody = async (upstream: Response): Promise<string> => {
      const text = await upstream.text().catch(() => "");
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { payload = {}; }
      httpDiagnostics = buildLlmSafeDiagnostics(payload, {
        phase: "response_headers", transportStatus: upstream.status,
        elapsedMs: Date.now() - __requestStart, receivedChars: text.length,
      });
      return text;
    };

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        httpDiagnostics = undefined;
        if (attempt > 0) {
          console.log(`[LLMProxy] 重试第 ${attempt} 次，等待 ${retryDelay}ms...`);
          await new Promise(r => setTimeout(r, retryDelay));
        }

        const abortController = new AbortController();
        const fetchStartedAt = Date.now();
        const timeoutMs = timeout * 1000;
        let timeoutFired = false;
        const timeoutId = setTimeout(() => {
          timeoutFired = true;
          abortController.abort();
        }, timeoutMs);

        let fetchResponse: Response;
        try {
          fetchResponse = await fetch(url, {
            method: "POST",
            headers,
            body: serializedBody,
            cache: "no-store",
            signal: abortController.signal,
          });
        } catch {
          throw new LlmResponseStartError(
            timeoutFired ? "deadline_exceeded" : "transport_error",
            Date.now() - fetchStartedAt,
            timeoutMs,
          );
        } finally {
          clearTimeout(timeoutId);
        }

        response = fetchResponse;

        if (response.ok) break; // 成功

        // 429 (Too Many Requests) 快速失败：不重试
        // 原因：上游已过载，重试只会加剧负载导致更多429，对标 AIWeb 也是快速失败策略
        // 让用户看到明确错误后手动重试，而非系统盲目重试消耗配额
        if (response.status === 429) {
          const errText = await readErrorBody(response);
          // 区分真正的限流 vs 模型配置错误 vs 余额不足（某些上游用429返回非限流错误）
          const isNotChatModel = errText.includes("not a chat model") || errText.includes("not supported in the v1/chat/completions");
          if (isNotChatModel) {
            throw new Error(`LLM API 配置错误: 该模型不支持对话接口，请联系管理员检查模型配置。原始错误: ${errText.slice(0, 200)}`);
          }
          const isBalanceExhausted = /余额不足|无可用资源包|insufficient.*balance|quota.*exceeded/i.test(errText);
          if (isBalanceExhausted) {
            throw new Error(`UPSTREAM_BALANCE_EXHAUSTED: 上游账户余额不足 (${response.status}): ${errText.slice(0, 200)}`);
          }
          throw new Error(`LLM API 429: ${errText}`);
        }

        // 503 渠道不可用：快速失败，不重试（上游无可用渠道，重试无意义）
        if (response.status === 503) {
          const errText = await readErrorBody(response);
          const isChannelUnavailable = errText.includes("无可用渠道") || errText.includes("distributor") || errText.includes("no available channel");
          if (isChannelUnavailable) {
            throw new Error(`上游渠道暂不可用: 该模型当前无可用渠道，请稍后重试或切换其他模型`);
          }
          throw new Error(`LLM API 503: ${errText}`);
        }

        // 524 Cloudflare 超时：快速失败，不重试
        // 原因：524 = 上游服务器处理超时，通常因为推理模型 TTFB 过长
        // 重试只会浪费用户等待时间，不如直接告知用户切换模型
        if (response.status === 524) {
          const errText = await readErrorBody(response);
          throw new Error(`LLM API 524: ${errText}`);
        }

        // 5xx 重试（排除 524 已处理、503 已处理）
        if (response.status >= 500 && attempt < retryCount) {
          console.warn(`[LLMProxy] 上游返回 ${response.status}，准备重试`);
          lastError = new Error(`Upstream ${response.status}`);
          // 消费掉响应体
          await response.text().catch(() => {});
          response = null;
          continue;
        }

        // 403 渠道欠费（new_api: insufficient_user_quota）：快速失败，不重试
        // 上游账户余额不足是确定性问题，重试无意义；给用户可读、可行动的错误
        if (response.status === 403) {
          const errText = await readErrorBody(response);
          const isQuotaExhausted = /insufficient_user_quota|预扣费额度失败|余额不足/i.test(errText);
          if (isQuotaExhausted) {
            throw new Error(`UPSTREAM_QUOTA_EXHAUSTED: 该模型渠道账户余额不足，本次未调用成功也未扣费。请切换其他模型，或联系管理员为该渠道充值。`);
          }
          throw new Error(`LLM API 403: ${errText}`);
        }

        // 4xx 或最后一次重试仍然失败 — 不重试，直接抛出
        const errText = await readErrorBody(response);
        throw new Error(`LLM API ${response.status}: ${errText}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (httpDiagnostics) Object.assign(lastError, { diagnostics: httpDiagnostics });
        // ★ 4xx 与渠道欠费/余额类错误不重试（确定性失败，重试无意义）
        if (lastError.message.startsWith("LLM API 4") || lastError.message.startsWith("UPSTREAM_")) {
          throw lastError;
        }
        if (attempt >= retryCount) {
          throw lastError;
        }
        console.warn(`[LLMProxy] 请求失败: ${lastError.message}，准备重试`);
      }
    }

    if (!response) throw lastError || new Error("No response");
    if (!response.body) throw new Error("LLM API 返回空响应");

    // Complete SSE events preserve split UTF-8 and final frames without buffering the response.
    const upstreamReader = response.body.getReader();
    const events = new SseEventStreamDecoder();
    let receivedChars = 0;
    const receivedText = new TextDecoder();
    const streamDiagnostics = (): LlmSafeDiagnostics => ({
      phase: "sse_event", transportStatus: response!.status,
      elapsedMs: Date.now() - __requestStart, receivedChars,
    });
    const rejectProviderEvent = (payload: unknown, raw: string) => {
      const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
      const diagnostics = streamDiagnostics();
      // Internal console receives fixed enums, lengths and hashes only. The
      // public SSE contract remains the existing allowlisted safe diagnostics.
      console.error(JSON.stringify({
        kind: "LLM_PROVIDER_STREAM_REJECTION",
        requestSha256: fingerprint(serializedBody), payloadSha256: fingerprint(raw),
        protocol, endpointHost: new URL(url).hostname,
        requestShape: {
          model, messageCount: request.messages.length,
          messageRoles: request.messages.map(message => message.role),
          messageChars: request.messages.map(message => typeof message.content === "string" ? message.content.length : null),
          max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
          temperature: body.temperature, responseFormat: request.response_format?.type,
          includeUsage: !!(body.stream_options as { include_usage?: boolean } | undefined)?.include_usage,
          hasTools: Array.isArray(body.tools) && body.tools.length > 0,
          hasEnableThinking: Object.hasOwn(body, "enable_thinking"),
        },
        diagnostics, providerFailure: summarizeLlmProviderFailure(payload, fingerprint),
      }));
      return upstreamStreamError(payload, diagnostics);
    };
    let fullContent = "";
    let fullReasoning = "";
    let firstChunkReceived = false;
    let upstreamCompleted = false;
    let finalEventReceived = false;
    let claudeUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
    let nativeStopReason: string | null = null;
    let nativeTerminalSource: "native_message_stop" | "relay_done" | null = null;
    let nativeUsageObserved = false;
    let nativeTerminalEmitted = false;
    const nativeUsageFieldsPresent = new Set<string>();
    const STREAM_READ_TIMEOUT = 60_000;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let controllerClosed = false;
        const enqueue = (chunk: Uint8Array) => {
          if (controllerClosed) return;
          try { controller.enqueue(chunk); } catch { controllerClosed = true; }
        };
        const close = () => {
          if (controllerClosed) return;
          try { controller.close(); } catch { /* consumer disconnected */ }
          controllerClosed = true;
        };
        const emitNativeTerminal = () => {
          if (!useClaudeMessages || nativeTerminalEmitted) return;
          nativeTerminalEmitted = true;
          // Preserve only observed, allowlisted evidence. Missing native usage
          // fields still normalize to zero, so list their actual presence rather
          // than claiming the provider reported a complete usage breakdown.
          enqueue(encoder.encode(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: nativeStopReason }],
            ...(nativeUsageObserved ? { usage: claudeUsage } : {}),
            provider_terminal: { protocol: "anthropic_messages", source: nativeTerminalSource,
              stop_reason: nativeStopReason, usage_source: nativeUsageObserved ? "normalized_reported" : "not_reported",
              usage_fields_present: ANTHROPIC_USAGE_FIELDS.filter(field => nativeUsageFieldsPresent.has(field)) },
          })}\n\n`));
        };
        const deliver = (event: DecodedSseEvent) => {
          if (event.data.trim() === "[DONE]") {
            upstreamCompleted = true; finalEventReceived = true;
            if (useClaudeMessages && nativeTerminalSource !== "native_message_stop") nativeTerminalSource = "relay_done";
            return;
          }
          let parsed;
          try { parsed = JSON.parse(event.data); } catch {
            if (event.event === "error") throw rejectProviderEvent({}, event.data);
            return;
          }
          if (parsed?.error || event.event === "error") throw rejectProviderEvent(parsed, event.data);
          if (!parsed || typeof parsed !== "object") return;
          if (useClaudeMessages) {
            if (parsed.type === "message_stop") {
              upstreamCompleted = true; finalEventReceived = true; nativeTerminalSource = "native_message_stop";
            }
            if (parsed.type === "message_delta" && parsed.delta?.stop_reason != null) {
              nativeStopReason = typeof parsed.delta.stop_reason === "string" && ANTHROPIC_STOP_REASONS.has(parsed.delta.stop_reason)
                ? parsed.delta.stop_reason : null;
            }
            const converted = convertClaudeStreamEvent(parsed);
            if (converted.content) {
              fullContent += converted.content;
              callbacks?.onContent?.(converted.content);
              enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: converted.content }, finish_reason: null }] })}\n\n`));
            }
            if (converted.usage) {
              const reported = parsed.usage || parsed.message?.usage;
              if (reported && typeof reported === "object" && !Array.isArray(reported)) {
                nativeUsageObserved = true;
                for (const field of ANTHROPIC_USAGE_FIELDS) if (Object.hasOwn(reported, field)) nativeUsageFieldsPresent.add(field);
              }
              // Anthropic splits input/cache usage into message_start and the
              // cumulative output usage into message_delta. Preserve both
              // fragments so the settlement callback always receives totals.
              claudeUsage = mergeTokenUsage(claudeUsage, converted.usage);
              callbacks?.onUsage?.(claudeUsage);
            }
            return;
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason != null) upstreamCompleted = true;
          const delta = choice?.delta;
          if (typeof delta?.content === "string") {
            fullContent += delta.content;
            callbacks?.onContent?.(delta.content);
          }
          const reasoning = delta?.reasoning_content || delta?.reasoning;
          if (typeof reasoning === "string") {
            fullReasoning += reasoning;
            callbacks?.onReasoning?.(reasoning);
          }
          if (parsed.usage) callbacks?.onUsage?.(extractTokenUsage(parsed));
          enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
        };
        enqueue(encoder.encode(": heartbeat\n\n"));
        try {
          while (!controllerClosed) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
              upstreamReader.read(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new LlmStreamReadError("idle_deadline_exceeded")), STREAM_READ_TIMEOUT);
              }),
            ]).finally(() => { if (timer) clearTimeout(timer); });
            if (result.done) {
              receivedChars += receivedText.decode().length;
              for (const event of events.finish()) deliver(event);
              if (!upstreamCompleted) throw new LlmStreamReadError("incomplete_eof");
              callbacks?.onDone?.(fullContent, fullReasoning || undefined);
              emitNativeTerminal();
              enqueue(encoder.encode("data: [DONE]\n\n"));
              close();
              return;
            }
            if (!firstChunkReceived) {
              firstChunkReceived = true;
              callbacks?.onFirstByte?.(Date.now() - __requestStart);
            }
            receivedChars += receivedText.decode(result.value, { stream: true }).length;
            for (const event of events.push(result.value)) deliver(event);
            if (finalEventReceived) {
              callbacks?.onDone?.(fullContent, fullReasoning || undefined);
              emitNativeTerminal();
              enqueue(encoder.encode("data: [DONE]\n\n"));
              close();
              return;
            }
          }
        } catch (cause) {
          const error = cause instanceof LlmStreamError ? cause : new LlmStreamReadError("transport_error");
          if (error instanceof LlmStreamReadError) {
            console.error(JSON.stringify({ kind: "LLM_STREAM_READ_FAILURE", code: error.code, diagnostics: error.diagnostics }));
          }
          callbacks?.onError?.(error);
          console.error(`[LLMProxy] Stream失败: model=${model}, code=${error.code}, 内容=${fullContent.length}, 耗时=${Date.now() - __requestStart}ms`);
          const diagnostics = sanitizeLlmSafeDiagnostics(error.diagnostics);
          enqueue(encoder.encode(`data: ${JSON.stringify({ error: error.message, code: error.code, done: false, ...(diagnostics ? { diagnostics } : {}) })}\n\n`));
          close();
        } finally {
          // Release sockets after upstream errors and read timeouts as well.
          await upstreamReader.cancel().catch(() => {});
        }
      },
      cancel() { return upstreamReader.cancel().catch(() => {}); },
    });

    return stream;
  }

  // ─────────────────────────────────────────────────────────
  // 非流式调用 — 返回完整结果
  // ─────────────────────────────────────────────────────────
  async chat(request: ChatRequest): Promise<ProxyResult> {
    const { apiBase, timeout, retryCount, retryDelay, protocol } = this.config;
    const model = request.model || this.config.defaultModel;
    const useClaudeMessages = protocol === "anthropic_messages";
    const url = buildOpenAIEndpoint(apiBase, useClaudeMessages ? "messages" : "chat/completions");

    const body: Record<string, unknown> = useClaudeMessages
      ? buildClaudeMessagesBody(request, apiBase, model, false, this.config.thinkingStrategy)
      : buildOpenAiBody(request, apiBase, model, false, false, this.config.outputTokenField);

    const headers = providerHeaders(this.config, useClaudeMessages);

    let response: Response | null = null;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let successfulResponse = false;
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, retryDelay));
        }

        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          successfulResponse = true;
          // Fetch resolves at headers. Keep the same abort deadline active
          // until the body is fully consumed, including a stalled JSON body.
          const data = await response.json();
          if (useClaudeMessages) return normalizeClaudeMessageResponse(data, model);
          const usage = data.usage ? extractTokenUsage(data) : undefined;
          const content = data.choices?.[0]?.message?.content || "";
          const reasoning = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || undefined;
          return { content, reasoning_content: reasoning, usage, model, raw: data };
        }
        if (response.status >= 500 && attempt < retryCount) {
          lastError = new Error(`Upstream ${response.status}`);
          await response.text().catch(() => {});
          response = null;
          continue;
        }
        const errText = await response.text().catch(() => "");
        throw new Error(`LLM API ${response.status}: ${errText}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Previously body decoding happened after the retry loop. Preserve
        // its no-retry contract when headers already accepted the request.
        if (successfulResponse || attempt >= retryCount) throw lastError;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    throw lastError || new Error("No response");
  }

  // ─────────────────────────────────────────────────────────
  // 创建 SSE Response（直接返回给前端）
  // ─────────────────────────────────────────────────────────
  async chatStreamResponse(
    request: ChatRequest,
    callbacks?: StreamCallbacks,
  ): Promise<Response> {
    const stream = await this.chatStream(request, callbacks);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/** 从 API 响应中提取 token usage（含 cached_tokens） */
function extractTokenUsage(data: {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}): { prompt_tokens: number; completion_tokens: number; cached_tokens: number } {
  const usage = data.usage;
  return {
    prompt_tokens: usage?.prompt_tokens || 0,
    completion_tokens: usage?.completion_tokens || 0,
    cached_tokens: usage?.prompt_tokens_details?.cached_tokens || 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// 全局单例（系统内共享，减少配置开销）
// ═══════════════════════════════════════════════════════════════
export function openAIThinkingOptions(request: Pick<ChatRequest, "enable_thinking">, apiBase: string, model: string) {
  let nativeDeepSeek = false;
  let lconaiOpenAiModel = false;
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    nativeDeepSeek = host === "api.deepseek.com";
    lconaiOpenAiModel = (host === "n.lconai.com" || host === "s.lconai.com") && /^gpt-/iu.test(model);
  } catch { /* Non-URL configuration is validated by the caller. */ }
  if (nativeDeepSeek && /^deepseek-v4-/iu.test(model) && typeof request.enable_thinking === "boolean") {
    return { thinking: { type: request.enable_thinking ? "enabled" : "disabled" } };
  }
  // LConAI's OpenAI Chat Completions contract documents `reasoning_effort`
  // only for o-series models. `enable_thinking` is not part of that contract,
  // so GPT aliases such as gpt-6.1-sol must use the provider default instead
  // of receiving a relay-specific, undocumented boolean.
  if (lconaiOpenAiModel) return {};
  return request.enable_thinking ? { enable_thinking: true } : {};
}

function openAIOutputTokenOptions(request: Pick<ChatRequest, "max_tokens">, model: string, configuredField?: ProxyConfig["outputTokenField"]): Record<string, number> {
  if (!request.max_tokens || request.max_tokens <= 0) return {};
  if (configuredField) return { [configuredField]: request.max_tokens };
  // Modern OpenAI reasoning families use max_completion_tokens. This restores
  // the existing GPT-5 behaviour and extends it to the documented GPT-6 alias.
  const useMaxCompletionTokens = /^gpt-(?:chat-latest|[5-9](?:[.\-]|$))/iu.test(model);
  return useMaxCompletionTokens
    ? { max_completion_tokens: request.max_tokens }
    : { max_tokens: request.max_tokens };
}

function providerHeaders(config: ProxyConfig, useClaudeMessages: boolean): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.authScheme === "x-api-key") headers["x-api-key"] = config.apiKey;
  else headers.Authorization = `Bearer ${config.apiKey}`;
  if (useClaudeMessages) headers["anthropic-version"] = config.protocolVersion || "2023-06-01";
  return headers;
}

function shouldOmitTemperature(apiBase: string, model: string): boolean {
  return /claude|anthropic|opus/i.test(`${apiBase} ${model}`);
}

function shouldSendTemperature(request: ChatRequest, apiBase: string, model: string): boolean {
  return request.temperature !== undefined
    && request.temperature !== null
    && !shouldOmitTemperature(apiBase, model);
}

function normalizeContentForClaude(content: string | unknown[]): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const item = part as Record<string, unknown>;
      if (item.type === "text") {
        return { type: "text", text: String(item.text || "") };
      }
      if (item.type === "image_url") {
        const imageUrl = item.image_url as { url?: string } | undefined;
        const url = imageUrl?.url || "";
        const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
        if (url) {
          return {
            type: "image",
            source: { type: "url", url },
          };
        }
      }
      return null;
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
}

function claudeThinkingOptions(
  request: Pick<ChatRequest, "enable_thinking" | "anthropic_thinking_profile">,
  apiBase: string,
  model: string,
  strategy?: ProxyConfig["thinkingStrategy"],
): Record<string, unknown> {
  const profile = request.anthropic_thinking_profile;
  if ((profile?.id === "storyboard-high-energy-b-v6-adaptive-low-v1" || profile?.id === "storyboard-high-energy-b-v8-adaptive-low-v1")
    && profile.thinkingMode === "adaptive" && profile.effort === "low" && model === "claude-opus-5-5") {
    try {
      const url = new URL(apiBase);
      if (url.origin === "https://n.lconai.com" && !url.username && !url.password) {
        return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
      }
    } catch { /* Non-URL configuration is validated by the caller. */ }
  }
  if (strategy === "provider_default") return {};
  if (strategy === "adaptive_low") return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
  if (request.enable_thinking !== false) return {};
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    // LConAI advertises both native Anthropic and OpenAI transports for this
    // alias, but its native Sonnet 5.5 channel rejects the optional
    // `thinking: {type:"disabled"}` field with HTTP 400. Omitting the field is
    // the provider-compatible way to request its default behaviour.
    if ((host === "n.lconai.com" || host === "s.lconai.com") && /^claude-(?:sonnet|opus)-5-5$/iu.test(model)) {
      return {};
    }
  } catch { /* The caller validates configured URLs before dispatch. */ }
  return { thinking: { type: "disabled" } };
}

function buildClaudeMessagesBody(request: ChatRequest, apiBase: string, model: string, stream: boolean, thinkingStrategy?: ProxyConfig["thinkingStrategy"]): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages = request.messages
    .map((message) => {
      if (message.role === "system") {
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        systemParts.push(content);
        return null;
      }
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: normalizeContentForClaude(message.content),
      };
    })
    .filter(Boolean);

  return {
    model,
    messages,
    max_tokens: request.max_tokens && request.max_tokens > 0 ? request.max_tokens : 4096,
    stream,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    // Anthropic Messages uses a structured thinking control. The admin
    // validation route explicitly disables thinking so its small output budget
    // validates the visible answer instead of being consumed by thinking
    // blocks. When thinking is enabled we keep the provider default because an
    // explicit budget must be chosen together with the caller's output limit.
    ...claudeThinkingOptions(request, apiBase, model, thinkingStrategy),
    ...(shouldSendTemperature(request, "", model) ? { temperature: request.temperature } : {}),
  };
}

/** OpenAI Chat Completions keeps system/developer instructions in messages. */
function buildOpenAiBody(
  request: ChatRequest,
  apiBase: string,
  model: string,
  stream: boolean,
  includeUsage = false,
  outputTokenField?: ProxyConfig["outputTokenField"],
): Record<string, unknown> {
  return {
    model,
    messages: request.messages,
    stream,
    ...openAIOutputTokenOptions(request, model, outputTokenField),
    ...(shouldSendTemperature(request, apiBase, model) ? { temperature: request.temperature } : {}),
    ...openAIThinkingOptions(request, apiBase, model),
    ...(request.response_format ? { response_format: request.response_format } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.tool_choice !== undefined ? { tool_choice: request.tool_choice } : {}),
    ...(stream && (request.stream_options || includeUsage)
      ? { stream_options: request.stream_options || { include_usage: true } } : {}),
  };
}

function finiteTokenCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeClaudeUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const uncachedInput = finiteTokenCount(usage.input_tokens);
  const cacheRead = finiteTokenCount(usage.cache_read_input_tokens);
  const cacheCreation = finiteTokenCount(usage.cache_creation_input_tokens);
  return {
    // The billing contract requires prompt_tokens to include both cache-hit
    // and cache-write tokens; cached_tokens identifies the discounted subset.
    prompt_tokens: uncachedInput + cacheRead + cacheCreation,
    completion_tokens: finiteTokenCount(usage.output_tokens),
    cached_tokens: cacheRead,
  };
}

function mergeTokenUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  // Anthropic usage fragments are cumulative by field, not additive events.
  // max() prevents double counting if the relay repeats message_delta frames.
  return {
    prompt_tokens: Math.max(current.prompt_tokens, next.prompt_tokens),
    completion_tokens: Math.max(current.completion_tokens, next.completion_tokens),
    cached_tokens: Math.max(current.cached_tokens, next.cached_tokens),
  };
}

function convertClaudeStreamEvent(data: Record<string, unknown>): {
  content?: string;
  usage?: TokenUsage;
} {
  const delta = data.delta as Record<string, unknown> | undefined;
  const message = data.message as Record<string, unknown> | undefined;
  const usage = normalizeClaudeUsage(
    (data.usage || message?.usage) as Record<string, unknown> | undefined,
  );
  const converted: { content?: string; usage?: TokenUsage } = {};
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    converted.content = delta.text;
  }
  if (usage) {
    converted.usage = usage;
  }
  return converted;
}

function normalizeClaudeMessageResponse(data: Record<string, unknown>, model: string): ProxyResult {
  const contentItems = Array.isArray(data.content) ? data.content : [];
  const content = contentItems
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const part = item as Record<string, unknown>;
      return part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
  const usage = normalizeClaudeUsage(data.usage as Record<string, unknown> | undefined);
  const raw = {
    id: data.id || `msg_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(data.model || model),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: data.stop_reason || "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.prompt_tokens + usage.completion_tokens,
          prompt_tokens_details: { cached_tokens: usage.cached_tokens },
        }
      : undefined,
  };

  return { content, usage, model: String(data.model || model), raw };
}

export function getLLMProxy(config?: Partial<ProxyConfig>): LLMProxy {
  // A request-scoped instance is mandatory. A mutable singleton lets request B
  // overwrite request A's endpoint/key/protocol while A is still streaming.
  return new LLMProxy(config);
}

/** 兼容旧调用；代理已改为请求级实例，不再持有全局可变状态。 */
export function resetLLMProxy(): void {
  // no-op
}
