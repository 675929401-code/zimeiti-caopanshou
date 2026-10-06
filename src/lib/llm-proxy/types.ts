/**
 * LLM Proxy 类型定义
 * 
 * 独立于系统其他模块，变更此文件仅需关注 LLM 代理逻辑
 */

/** 代理配置 — 可通过 DEFAULT_PROXY_CONFIG 恢复默认 */
export interface ProxyConfig {
  /** 上游 API 基础地址（如 https://yunwu.ai） */
  apiBase: string;
  /** API Key */
  apiKey: string;
  /** 默认模型名 */
  defaultModel: string;
  /** 显式渠道标识；不得从域名或模型名反推 */
  provider: string;
  /** 当前模型绑定的请求协议 */
  protocol: "openai_chat" | "anthropic_messages";
  /** 当前渠道的鉴权头格式 */
  authScheme: "bearer" | "x-api-key";
  /** 协议版本（Anthropic Messages 通常为 2023-06-01） */
  protocolVersion?: string;
  /** 请求超时（秒），默认 120 */
  timeout: number;
  /** 流式模式开关 */
  stream: boolean;
  /** 是否请求 token usage（stream_options.include_usage） */
  includeUsage: boolean;
  /** 是否启用 keep-alive 连接复用 */
  keepAlive: boolean;
  /** 重试次数（上游超时/5xx 时自动重试） */
  retryCount: number;
  /** 重试间隔（毫秒） */
  retryDelay: number;
}

/** 非流式调用结果 */
export interface ProxyResult {
  content: string;
  reasoning_content?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
  };
  model: string;
  raw?: unknown;
}

/** 流式回调 */
export interface StreamCallbacks {
  /** 收到内容增量 */
  onContent?: (text: string) => void;
  /** 收到思考内容增量 */
  onReasoning?: (text: string) => void;
  /** 收到 usage 数据（通常在流末尾） */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; cached_tokens: number }) => void;
  /** 流结束 */
  onDone?: (fullContent: string, fullReasoning?: string) => void;
  /** 错误 */
  onError?: (error: Error) => void;
  /** 首字节到达（可用于 TTFB 监控） */
  onFirstByte?: (ttfbMs: number) => void;
}

/** SSE 输出 chunk — 兼容 OpenAI 原生格式（前端 data.choices[0].delta 解析） */
export interface SSEChunk {
  /** OpenAI 格式：choices[0].delta.content 或直接 content */
  choices?: Array<{ delta: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }>;
  /** 简化格式（仅 content/reasoning_content 在 choices 外时作为 fallback） */
  content?: string;
  reasoning_content?: string;
  /** 流结束信号 */
  done?: boolean;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number };
}

/** 构建请求体的输入参数 */
export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown[] }>;
  max_tokens?: number;
  temperature?: number;
  enable_thinking?: boolean;
  response_format?: { type: string } | undefined;
  tools?: unknown[];
  stream_options?: { include_usage: boolean };
  [key: string]: unknown;
}
