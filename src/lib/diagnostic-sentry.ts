/**
 * 前端健康哨兵 — 全链路自动检测异常 + 循环日志缓冲区 + 上报
 *
 * 覆盖模块：对话 / 充值 / 视频 / 封面 / 认证 / 通用
 * 设计原则：
 * - 有界开销：健康日志使用内存循环缓冲区；白名单产品事件由独立限流链异步上报
 * - 自动检测：监听 fetch 错误、超时、流式中断、JS 运行时错误
 * - 按模块节流：同类型问题10秒内不重复上报
 * - 数据脱敏：不上报对话内容正文，只记录时序、状态、错误信息
 */

import { recordProductUsageEvent } from "@/lib/product-usage-client";
import type { ProductUsageFeatureKey } from "@/lib/product-usage-contract";

// ── 类型定义 ──

interface LogEntry {
  timestamp: number;
  type: "api" | "stream" | "error" | "user_action" | "navigation" | "payment" | "video" | "image" | "voice" | "extract" | "auth" | "system";
  action: string;
  traceId?: string;
  detail?: string;
  duration?: number;
  status?: number;
  error?: string;
}

interface DiagnosticReport {
  problem_type: string;
  severity: string;
  description: string;
  context: {
    logs: LogEntry[];
    browser: Record<string, string>;
    network: string;
    timestamp: string;
    [key: string]: unknown;
  };
  conversation_id?: string;
  agent_id?: string;
  agent_name?: string;
  page_url?: string;
}

// ── 问题类型清单 ──
// 对话类
// chat_timeout / send_failed / stream_interrupted / api_error
// 充值类
// payment_create_failed / payment_callback_missing / balance_not_updated / payment_timeout
// 视频类
// video_submit_failed / video_poll_timeout / video_billing_error / video_all_channels_down
// 封面类
// cover_generate_failed / cover_workflow_timeout / cover_billing_error
// 认证类
// auth_login_failed / auth_token_expired / auth_register_code_failed
// 通用类
// network_error / page_crash / slow_response / render_error / manual_report

// ── 循环日志缓冲区 ──

const MAX_LOG_ENTRIES = 150;
const logBuffer: LogEntry[] = [];

function pushLog(entry: LogEntry) {
  if (logBuffer.length >= MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
  logBuffer.push(entry);
}

function getLogSnapshot(): LogEntry[] {
  return [...logBuffer];
}

// ── 浏览器信息收集 ──

function collectBrowserInfo(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    cookieEnabled: String(navigator.cookieEnabled),
    onLine: String(navigator.onLine),
  };
}

// ── 自动监测 ──

let monitoringActive = false;
let pageLifecycleEnding = false;

type OperationDomain = "chat" | "image" | "video" | "voice" | "extract" | "payment" | "auth" | "storage" | "admin" | "system" | "other";

interface OperationDescriptor {
  domain: OperationDomain;
  operation: string;
}

const TRACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const FLIGHT_ENDPOINT = "/api/operation-events";

function normalizePath(value: string): string {
  try {
    return new URL(value, window.location.origin).pathname.replace(/\/{2,}/gu, "/");
  } catch {
    return value.split(/[?#]/u, 1)[0] || "/";
  }
}

function operationDescriptor(path: string): OperationDescriptor | null {
  if (path === FLIGHT_ENDPOINT || path.startsWith("/api/admin/operation-events") || path === "/api/diagnostic-logs") return null;
  if (path.startsWith("/api/llm") || path.startsWith("/api/chat") || path.startsWith("/api/conversations")) return { domain: "chat", operation: "chat.request" };
  if (path.startsWith("/api/image") || path.startsWith("/api/cover")) return { domain: "image", operation: "image.request" };
  if (path.startsWith("/api/video")) return { domain: "video", operation: "video.request" };
  if (path.startsWith("/api/voice")) return { domain: "voice", operation: "voice.request" };
  if (path.startsWith("/api/extract") || path.startsWith("/api/segmenter")) return { domain: "extract", operation: "extract.request" };
  if (path.startsWith("/api/payment") || path.startsWith("/api/credits") || path.startsWith("/api/cash") || path.startsWith("/api/cami")) return { domain: "payment", operation: "payment.request" };
  if (path.startsWith("/api/auth")) return { domain: "auth", operation: "auth.request" };
  if (path.startsWith("/api/storage") || path.startsWith("/api/media-history")) return { domain: "storage", operation: "storage.request" };
  if (path.startsWith("/api/admin")) return { domain: "admin", operation: "admin.request" };
  return null;
}

function productUsageFeatureForApi(path: string): ProductUsageFeatureKey | null {
  if (path.startsWith("/api/llm") || path.startsWith("/api/chat") || path.startsWith("/api/conversations")) return "agent_chat";
  return null;
}

function productUsageJourneyId(): string | null {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method || (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

function requestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  return init?.signal || (input instanceof Request ? input.signal : null);
}

function isPageRequestObsolete(signal: AbortSignal | null, startedPageUrl: string): boolean {
  return signal?.aborted === true
    || pageLifecycleEnding
    || window.location.href !== startedPageUrl;
}

function isObsoleteNavigationRequest(
  error: unknown,
  signal: AbortSignal | null,
  startedPageUrl: string,
): boolean {
  const errorName = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  return errorName === "AbortError" || isPageRequestObsolete(signal, startedPageUrl);
}

function traceFromBody(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string" || body.length > 1_000_000) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["client_request_id", "client_trace_id", "client_idempotency_key", "request_id"]) {
      const candidate = parsed[key];
      if (typeof candidate === "string" && TRACE_PATTERN.test(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function makeTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function prepareTrace(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { traceId: string; args: [RequestInfo | URL, RequestInit?] } {
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  const existing = headers.get("x-client-trace-id") || headers.get("idempotency-key") || traceFromBody(init?.body);
  const traceId = existing && TRACE_PATTERN.test(existing) ? existing : makeTraceId();
  if (!headers.has("x-client-trace-id")) headers.set("x-client-trace-id", traceId);
  return { traceId, args: [input, { ...init, headers }] };
}

function responseKind(response: Response): "json" | "stream" | "media" | "empty" | "unknown" {
  if (response.status === 204 || response.status === 304) return "empty";
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) return "stream";
  if (contentType.includes("json")) return "json";
  if (/^(?:image|video|audio)\//u.test(contentType)) return "media";
  return "unknown";
}

function submitFlightEvent(payload: Record<string, unknown>): void {
  try {
    const token = localStorage.getItem("auth_token");
    if (!token) return;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", FLIGHT_ENDPOINT);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.timeout = 5_000;
    xhr.send(JSON.stringify(payload));
  } catch {
    // The recorder is best-effort and can never block a user operation.
  }
}

/** 启动健康哨兵（全局调用一次） */
export function startDiagnosticMonitoring() {
  if (monitoringActive || typeof window === "undefined") return;
  monitoringActive = true;
  window.addEventListener("beforeunload", () => { pageLifecycleEnding = true; });
  window.addEventListener("pagehide", () => { pageLifecycleEnding = true; });

  // 1. 监听 JS 运行时错误
  window.addEventListener("error", (event) => {
    pushLog({
      timestamp: Date.now(),
      type: "error",
      action: "runtime_error",
      error: `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    });
    // 页面崩溃级别错误自动上报（忽略 ResizeObserver 等无害错误）
    if (event.message && !event.message.includes("ResizeObserver") && !event.message.includes("Non-Error promise rejection")) {
      autoReport("page_crash", "high", `JS运行时错误: ${event.message}`);
    }
  });

  // 2. 监听未捕获的 Promise 异常
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    pushLog({
      timestamp: Date.now(),
      type: "error",
      action: "unhandled_rejection",
      error: reason,
    });
  });

  // 3. 拦截 fetch 请求，监测关键 API 调用。每个请求独立跟踪；不使用全局
  // in-flight 锁，否则任意一个长流式请求都会让同期请求绕过监控。
  const originalFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const url = typeof args[0] === "string" ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]);
    try {
      if (new URL(url, window.location.origin).origin !== window.location.origin) return originalFetch.apply(this, args);
    } catch {
      return originalFetch.apply(this, args);
    }
    const path = normalizePath(url);
    const descriptor = operationDescriptor(path);
    if (!descriptor) return originalFetch.apply(this, args);
    const method = requestMethod(args[0], args[1]);
    const signal = requestSignal(args[0], args[1]);
    const prepared = prepareTrace(args[0], args[1]);
    const startTime = Date.now();
    const startedPageUrl = window.location.href;
    const productFeature = method !== "GET" && method !== "HEAD" ? productUsageFeatureForApi(path) : null;
    const productJourney = productFeature ? productUsageJourneyId() : null;
    if (productFeature && productJourney) {
      void recordProductUsageEvent({
        eventType: "workflow_started",
        featureKey: productFeature,
        journeyId: productJourney,
        entryPoint: "direct",
      });
    }

    try {
      const response = await originalFetch.apply(this, prepared.args as Parameters<typeof fetch>);
      if (isPageRequestObsolete(signal, startedPageUrl)) return response;
      const duration = Date.now() - startTime;

      pushLog({
        timestamp: startTime,
        type: categorizeApiType(path),
        action: path,
        traceId: prepared.traceId,
        duration,
        status: response.status,
      });

      if ((method !== "GET" && method !== "HEAD") || !response.ok || duration > 5_000) {
        submitFlightEvent({
          id: makeTraceId(),
          trace_id: prepared.traceId,
          domain: descriptor.domain,
          operation: descriptor.operation,
          phase: method === "GET" || method === "HEAD" ? "read_response" : "response",
          outcome: response.ok ? (duration > 10_000 ? "warning" : "success") : "error",
          duration_ms: duration,
          http_status: response.status,
          route: path,
          error_code: response.ok ? null : `HTTP_${response.status}`,
          summary: response.ok ? null : "关键业务请求返回错误状态",
          metadata: {
            method,
            transport: "fetch",
            response_kind: responseKind(response),
            page_path: window.location.pathname,
            client_started_at: new Date(startTime).toISOString(),
          },
          occurred_at: new Date().toISOString(),
        });
      }

      if (productFeature && productJourney && !response.ok) {
        void recordProductUsageEvent({
          eventType: "workflow_failed",
          featureKey: productFeature,
          journeyId: productJourney,
          outcomeReasonCode: `HTTP_${response.status}`,
          durationMs: duration,
          entryPoint: "direct",
        });
      } else if (productFeature && productJourney && response.ok && response.status !== 202 && responseKind(response) !== "stream") {
        void recordProductUsageEvent({
          eventType: "workflow_completed",
          featureKey: productFeature,
          journeyId: productJourney,
          durationMs: duration,
          entryPoint: "direct",
        });
      }

      // API 返回错误状态码 → 自动上报
      if (!response.ok && response.status >= 400) {
        const problemType = mapApiToProblemType(path);
        if (problemType) {
          autoReport(
            problemType,
            response.status >= 500 ? "high" : "medium",
            `API错误: ${path} → ${response.status} (${duration}ms)`,
            { api_url: path, status: response.status, duration, trace_id: prepared.traceId }
          );
      }
      }

      // 响应慢（>10s）
      if (duration > 10000 && !path.includes("/api/diagnostic-logs")) {
        autoReport(
          "slow_response",
          "low",
          `响应慢: ${path} → ${duration}ms`,
          { api_url: path, duration, trace_id: prepared.traceId }
        );
      }

      return response;
    } catch (err) {
      // Route changes routinely cancel obsolete reads. They are neither an
      // outage nor a failed user operation, so keep them out of durable
      // diagnostics while preserving the original fetch rejection.
      if (isObsoleteNavigationRequest(err, signal, startedPageUrl)) throw err;
      const duration = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      pushLog({
        timestamp: startTime,
        type: categorizeApiType(path),
        action: path,
        traceId: prepared.traceId,
        duration,
        error: errorMsg,
      });

      submitFlightEvent({
        id: makeTraceId(),
        trace_id: prepared.traceId,
        domain: descriptor.domain,
        operation: descriptor.operation,
        phase: "transport_error",
        outcome: "error",
        duration_ms: duration,
        route: path,
        error_code: "FETCH_NETWORK_ERROR",
        summary: "浏览器未收到关键业务请求响应",
        metadata: {
          method,
          transport: "fetch",
          response_kind: "unknown",
          page_path: window.location.pathname,
          client_started_at: new Date(startTime).toISOString(),
        },
        occurred_at: new Date().toISOString(),
      });

      if (productFeature && productJourney) {
        void recordProductUsageEvent({
          eventType: "workflow_failed",
          featureKey: productFeature,
          journeyId: productJourney,
          outcomeReasonCode: "NETWORK_UNAVAILABLE",
          durationMs: duration,
          entryPoint: "direct",
        });
      }

      // 网络错误自动上报（关键路径）
      const problemType = mapApiToProblemType(path);
      if (problemType) {
        autoReport(
          "network_error",
          "high",
          `网络错误: ${path} → ${errorMsg}`,
          { api_url: path, error: errorMsg, duration, trace_id: prepared.traceId }
        );
      }

      throw err;
    }
  };

  // 4. 监听网络状态
  window.addEventListener("offline", () => {
    pushLog({ timestamp: Date.now(), type: "error", action: "network_offline", error: "网络断开" });
  });

  window.addEventListener("online", () => {
    pushLog({ timestamp: Date.now(), type: "user_action", action: "network_online" });
  });
}

/** 根据 API 路径分类日志类型 */
function categorizeApiType(path: string): LogEntry["type"] {
  if (path.includes("/api/payment")) return "payment";
  if (path.includes("/api/video")) return "video";
  if (path.includes("/api/image") || path.includes("/api/cover")) return "image";
  if (path.includes("/api/voice")) return "voice";
  if (path.includes("/api/extract") || path.includes("/api/segmenter")) return "extract";
  if (path.includes("/api/llm") || path.includes("/api/chat")) return "stream";
  if (path.includes("/api/auth")) return "auth";
  return "api";
}

/** 根据 API 路径映射问题类型（只关注关键路径） */
function mapApiToProblemType(path: string): string | null {
  if (path.includes("/api/llm") || path.includes("/api/chat")) return "api_error";
  if (path.includes("/api/payment/create")) return "payment_create_failed";
  if (path.includes("/api/payment/notify")) return "payment_callback_missing";
  if (path.includes("/api/video/generate")) return "video_submit_failed";
  if (path.includes("/api/video/poll") || path.includes("/api/video/status")) return "video_poll_timeout";
  if (path.includes("/api/image/generate")) return "cover_generate_failed";
  if (path.includes("/api/auth/login") || path.includes("/api/auth/login-email")) return "auth_login_failed";
  if (path.includes("/api/auth/register")) return "auth_register_code_failed";
  if (path.includes("/api/credits")) return "api_error";
  return null;
}

// ── 对话超时检测 ──

const chatTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; startTime: number; agentId?: string; agentName?: string; conversationId?: string }>();

const CHAT_TIMEOUT_MS = 30000;

export function startChatTimeoutWatch(
  messageId: string,
  agentId?: string,
  agentName?: string,
  conversationId?: string
) {
  const timer = setTimeout(() => {
    autoReport(
      "chat_timeout",
      "high",
      `对话超时(30s无响应): ${agentName || agentId || "未知智能体"}`,
      { agent_id: agentId, agent_name: agentName, conversation_id: conversationId, timeout_ms: CHAT_TIMEOUT_MS }
    );
    chatTimers.delete(messageId);
  }, CHAT_TIMEOUT_MS);

  chatTimers.set(messageId, { timer, startTime: Date.now(), agentId, agentName, conversationId });
}

export function clearChatTimeoutWatch(messageId: string) {
  const entry = chatTimers.get(messageId);
  if (entry) {
    clearTimeout(entry.timer);
    const duration = Date.now() - entry.startTime;
    pushLog({
      timestamp: entry.startTime,
      type: "stream",
      action: "chat_first_token",
      duration,
    });
    chatTimers.delete(messageId);
  }
}

export function reportStreamInterrupted(
  messageId: string,
  agentId?: string,
  agentName?: string,
  conversationId?: string
) {
  clearChatTimeoutWatch(messageId);
  autoReport(
    "stream_interrupted",
    "medium",
    `流式中断: ${agentName || agentId || "未知智能体"}`,
    { agent_id: agentId, agent_name: agentName, conversation_id: conversationId }
  );
}

// ── 充值链路监测 ──

/**
 * 支付创建失败上报
 */
export function reportPaymentCreateFailed(orderType: string, error: string) {
  autoReport(
    "payment_create_failed",
    "high",
    `支付创建失败(${orderType}): ${error}`,
    { order_type: orderType, error }
  );
}

/**
 * 支付回调未到账上报（前端轮询超时）
 */
export function reportPaymentCallbackMissing(orderId: string, orderType: string) {
  autoReport(
    "payment_callback_missing",
    "high",
    `支付回调未到账(${orderType}): 订单${orderId}，前端轮询60次未检测到支付成功`,
    { order_id: orderId, order_type: orderType }
  );
}

/**
 * 余额未刷新上报
 */
export function reportBalanceNotUpdated(target: "credits" | "cash", expected: number, actual: number) {
  autoReport(
    "balance_not_updated",
    "medium",
    `余额未刷新(${target}): 期望${expected}, 实际${actual}`,
    { target, expected, actual }
  );
}

/**
 * 支付二维码超时
 */
export function reportPaymentTimeout(orderId: string, orderType: string) {
  autoReport(
    "payment_timeout",
    "medium",
    `支付二维码超时(${orderType}): 订单${orderId}`,
    { order_id: orderId, order_type: orderType }
  );
}

// ── 视频链路监测 ──

/**
 * 视频提交失败
 */
export function reportVideoSubmitFailed(model: string, error: string) {
  autoReport(
    "video_submit_failed",
    "high",
    `视频提交失败(${model}): ${error}`,
    { model, error }
  );
}

/**
 * 视频轮询超时
 */
export function reportVideoPollTimeout(taskId: string, model: string) {
  autoReport(
    "video_poll_timeout",
    "medium",
    `视频轮询超时(${model}): 任务${taskId}`,
    { task_id: taskId, model }
  );
}

/**
 * 视频扣费异常
 */
export function reportVideoBillingError(taskId: string, error: string) {
  autoReport(
    "video_billing_error",
    "high",
    `视频扣费异常: 任务${taskId}, ${error}`,
    { task_id: taskId, error }
  );
}

/**
 * 所有视频通道不可用
 */
export function reportVideoAllChannelsDown(model: string) {
  autoReport(
    "video_all_channels_down",
    "critical",
    `视频全部通道不可用(${model})`,
    { model }
  );
}

// ── 封面链路监测 ──

/**
 * 封面生成失败
 */
export function reportCoverGenerateFailed(mode: string, error: string) {
  autoReport(
    "cover_generate_failed",
    "high",
    `封面生成失败(${mode}): ${error}`,
    { mode, error }
  );
}

/**
 * 封面工作流超时
 */
export function reportCoverWorkflowTimeout(workflowId: string) {
  autoReport(
    "cover_workflow_timeout",
    "medium",
    `封面工作流超时: ${workflowId}`,
    { workflow_id: workflowId }
  );
}

/**
 * 封面扣费异常
 */
export function reportCoverBillingError(error: string) {
  autoReport(
    "cover_billing_error",
    "high",
    `封面扣费异常: ${error}`,
    { error }
  );
}

// ── 认证链路监测 ──

/**
 * 登录失败
 */
export function reportAuthLoginFailed(method: string, error: string) {
  autoReport(
    "auth_login_failed",
    "medium",
    `登录失败(${method}): ${error}`,
    { method, error }
  );
}

/**
 * Token 过期
 */
export function reportAuthTokenExpired() {
  autoReport(
    "auth_token_expired",
    "low",
    "Token过期，需要重新登录",
    {}
  );
}

/**
 * 注册验证码发送失败
 */
export function reportAuthRegisterCodeFailed(email: string, error: string) {
  autoReport(
    "auth_register_code_failed",
    "medium",
    `注册验证码发送失败(${email}): ${error}`,
    { email_hint: email.replace(/(.{2}).+(@.+)/, "$1***$2"), error }
  );
}

// ── 用户手动反馈 ──

export async function reportProblem(
  description: string,
  extra?: {
    problem_type?: string;
    agent_id?: string;
    agent_name?: string;
    conversation_id?: string;
  }
): Promise<{ success: boolean; id?: string }> {
  const report: DiagnosticReport = {
    problem_type: extra?.problem_type || "manual_report",
    severity: "medium",
    description,
    context: {
      logs: getLogSnapshot(),
      browser: collectBrowserInfo(),
      network: navigator.onLine ? "online" : "offline",
      timestamp: new Date().toISOString(),
      ...extra,
    },
    agent_id: extra?.agent_id,
    agent_name: extra?.agent_name,
    conversation_id: extra?.conversation_id,
    page_url: typeof window !== "undefined" ? window.location.href : undefined,
  };

  return submitReport(report);
}

// ── 自动上报（内部，按类型节流） ──

const throttleMap = new Map<string, number>();
const THROTTLE_MS = 10000; // 同类型10秒内不重复上报

async function autoReport(
  problemType: string,
  severity: string,
  description: string,
  extraContext?: Record<string, unknown>
) {
  // 按问题类型节流（不同类型互不影响）
  const now = Date.now();
  const lastReport = throttleMap.get(problemType) || 0;
  if (now - lastReport < THROTTLE_MS) return;
  throttleMap.set(problemType, now);

  const report: DiagnosticReport = {
    problem_type: problemType,
    severity,
    description,
    context: {
      logs: getLogSnapshot(),
      browser: collectBrowserInfo(),
      network: typeof navigator !== "undefined" ? (navigator.onLine ? "online" : "offline") : "unknown",
      timestamp: new Date().toISOString(),
      ...extraContext,
    },
    page_url: typeof window !== "undefined" ? window.location.href : undefined,
  };

  // 自动上报不阻塞，fire-and-forget
  submitReport(report).catch(() => {});
}

async function submitReport(report: DiagnosticReport): Promise<{ success: boolean; id?: string }> {
  try {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth_token") : null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // 使用 XMLHttpRequest 发送诊断日志，绕过 fetch 拦截器，彻底避免递归风险
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/diagnostic-logs");
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve({ success: true, id: data.id });
          } catch {
            resolve({ success: true });
          }
        } else {
          resolve({ success: false });
        }
      };
      xhr.onerror = () => resolve({ success: false });
      xhr.ontimeout = () => resolve({ success: false });
      xhr.timeout = 5000;
      xhr.send(JSON.stringify(report));
    });
  } catch {
    return { success: false };
  }
}

// ── 通用日志记录（供外部调用） ──

export function logUserAction(action: string, detail?: string) {
  pushLog({ timestamp: Date.now(), type: "user_action", action, detail });
}

export function logNavigation(from: string, to: string) {
  pushLog({ timestamp: Date.now(), type: "navigation", action: `navigate: ${from} → ${to}` });
}
