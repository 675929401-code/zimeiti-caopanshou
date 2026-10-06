/**
 * 聊天管道模块 — 消息发送链路的隔离层
 *
 * 设计原则（对标 Vercel AI Chatbot + AionUi）：
 * 1. 纯函数，无状态，无副作用 — 容易测试和推理
 * 2. 单一职责 — 每个函数只做一件事
 * 3. 错误分类 — 不同错误不同处理策略，不再一刀切
 * 4. 协同标注 — 多智能体共享对话时的身份识别
 *
 * 此模块由 app-context.tsx 调用，不依赖任何 React 状态
 */

// ── 错误分类系统 ──

/** 错误类别 — 决定后续恢复策略 */
export type ChatErrorClass =
  | "network"        // 网络级错误（fetch 失败、DNS 解析失败、连接中断）
  | "server"         // 上游服务错误（502/503/504 网关错误）
  | "rate_limit"     // 限流（429）
  | "auth"           // 认证失败（401/403）
  | "billing"        // 积分/现金不足（402）
  | "bad_request"    // 请求格式错误（400）
  | "message_too_long" // 对话上下文过长（虽然已截断，保留分类用于兜底提示）
  | "upstream"       // 上游 API 错误（非网关类 5xx）
  | "abort"          // 用户主动取消
  | "unknown";       // 未知错误

/** 错误分类结果 — 包含类别、是否可重试、友好提示 */
export interface ClassifiedError {
  class: ChatErrorClass;
  retryable: boolean;
  userMessage: string;
  /** 是否应该清理失败消息（不持久化到缓存） */
  shouldCleanup: boolean;
}

/**
 * 对错误进行分类
 *
 * 核心思路：不同错误需要不同的处理策略
 * - network → POST 结果未知，禁止自动或一键重发
 * - server → 仅在服务端明确拒绝且未调用上游时才可由调用方决定重试
 * - rate_limit → 不重试（会加重负载）
 * - auth/billing/bad_request → 不重试（重试无意义）
 * - abort → 不重试（用户主动行为）
 */
export function classifyError(error: unknown): ClassifiedError {
  // 用户主动取消
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return {
      class: "abort",
      retryable: false,
      userMessage: "[已终止]",
      shouldCleanup: false, // 用户取消保留已有内容
    };
  }

  // 网络级错误：fetch 本身失败。对 POST 对话请求而言，浏览器无法判断
  // 请求究竟没有到达服务端，还是服务端已开始调用上游后连接才中断。
  // 因此必须按“结果未知”处理，禁止直接重发造成重复调用或重复计费。
  if (error instanceof TypeError) {
    return {
      class: "network",
      retryable: false,
      userMessage: "请求已提交，但连接中断，最终结果暂未确认。原请求已保留，请勿重复发送；请刷新后查看聊天记录。",
      shouldCleanup: false,
    };
  }

  // HTTP 状态码错误（从 error message 中提取）
  const msg = error instanceof Error ? error.message : String(error);

  if (msg.includes("429") || msg.includes("Too Many Requests") || msg.includes("rate_limit")) {
    return {
      class: "rate_limit",
      retryable: false,
      userMessage: "发送失败：请求过于频繁，请稍后重试",
      shouldCleanup: false, // 不删除消息，保留用户输入以便稍后重试
    };
  }

  if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("403") || msg.includes("Forbidden")) {
    return {
      class: "auth",
      retryable: false,
      userMessage: "发送失败：认证已过期，请重新登录",
      shouldCleanup: false, // 不删除消息，让用户看到错误原因
    };
  }

  if (msg.includes("402") || msg.includes("Insufficient") || msg.includes("积分不足") || msg.includes("余额不足")) {
    return {
      class: "billing",
      retryable: false,
      userMessage: "发送失败：积分不足，请充值后重试",
      shouldCleanup: true,
    };
  }

  if (msg.includes("MESSAGE_TOO_LONG") || msg.includes("消息总长度超出限制")) {
    return {
      class: "message_too_long",
      retryable: false,
      userMessage: "对话历史过长，请开启新对话继续聊天",
      shouldCleanup: false, // 不删除消息，保留用户输入
    };
  }

  if (msg.includes("400") || msg.includes("Bad Request")) {
    return {
      class: "bad_request",
      retryable: false,
      userMessage: "发送失败：请求格式错误",
      shouldCleanup: false, // 不删除消息，让用户看到错误原因
    };
  }

  if (msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("Bad Gateway") || msg.includes("Service Unavailable") || msg.includes("Gateway Timeout")) {
    return {
      class: "server",
      retryable: true,   // ★ 网关错误可重试1次
      userMessage: "发送失败：服务暂时不可用，请稍后重试",
      shouldCleanup: false, // 不删除消息，保留用户输入以便重试
    };
  }

  if (msg.includes("500") || msg.includes("Internal Server Error")) {
    return {
      class: "upstream",
      retryable: false,  // 上游内部错误，重试可能加重问题
      userMessage: "发送失败：服务器内部错误",
      shouldCleanup: false, // 不删除消息，保留用户输入
    };
  }

  return {
    class: "unknown",
    retryable: false,
    userMessage: "发送失败：当前智能体暂时无法完成回复，请稍后重试",
    shouldCleanup: true,
  };
}

// ── 重试策略 ──

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

/** 默认重试配置：1次重试，1秒延迟 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 1,
  baseDelayMs: 1000,
};

/**
 * 判断是否应该重试
 * 通用助手不再把网络级 POST 故障当作安全重试；仅保留服务端明确失败的旧兼容判断。
 */
export function shouldRetry(error: unknown, attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  if (attempt >= config.maxRetries) return false;
  const classified = classifyError(error);
  return classified.retryable;
}

/**
 * 计算重试延迟（线性退避，不是指数退避——因为只重试1次）
 */
export function getRetryDelay(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  return config.baseDelayMs * (attempt + 1);
}

// ── 失败消息清理 ──

/**
 * 判断是否应该清理失败消息
 * 当发送完全失败（未收到任何内容）时，删除用户消息和助手占位消息
 * 防止"关闭重开→再发→消息重叠"问题
 */
export function shouldCleanupFailedMessage(
  fullContent: string,
  reasoningContent: string,
  isUserAborted: boolean
): boolean {
  // 用户主动取消 → 保留已有内容，不清理
  if (isUserAborted) return false;
  // 收到了部分内容 → 保留（有价值），不清理
  if (fullContent.trim() || (reasoningContent && reasoningContent.trim())) return false;
  // 完全没收到内容 → 清理，不持久化到缓存
  return true;
}

/**
 * 从对话消息列表中删除指定的用户消息和助手占位消息
 * 返回新的消息数组（不可变操作）
 */
export function removeFailedMessagePair(
  messages: Array<{ id: string; role: string; content: string }>,
  userMsgId: string,
  assistantMsgId: string
): Array<{ id: string; role: string; content: string }> {
  const idsToRemove = new Set([userMsgId, assistantMsgId]);
  return messages.filter(m => !idsToRemove.has(m.id));
}

// ── 缓存恢复过滤 ──

/**
 * 过滤缓存恢复时的孤立失败消息
 * 规则：如果一条助手消息以"发送失败"开头，且前一条不是用户消息，则删除
 * 这处理了旧版本遗留的失败消息在缓存中的情况
 */
export function filterOrphanFailedMessages<T extends { role: string; content: string }>(
  messages: T[]
): T[] {
  return messages.filter((msg, index) => {
    // 只检查助手消息
    if (msg.role !== "assistant") return true;
    // 不以"发送失败"开头的保留
    if (!msg.content.startsWith("发送失败")) return true;
    // 前一条是用户消息的保留（配对完整）
    if (index > 0 && messages[index - 1].role === "user") return true;
    // 孤立的失败消息 → 删除
    return false;
  });
}

// ── 协同消息标注 ──

/**
 * 为多智能体协作的消息添加身份标注
 *
 * 当对话中存在多个智能体的消息时，非当前智能体的助手消息
 * 需要标注来源，让 LLM 知道这是哪个智能体的回复
 *
 * 设计思路（对标 AIWeb）：
 * - 不使用 OpenAI 的 name 字段（LLM 无法理解 UUID 格式）
 * - 在 content 前添加 [来自「智能体名」的回复] 前缀
 * - 注入协作提示到 system prompt，告知 LLM 如何理解标注
 */
export function annotateCollabMessages(
  messages: Array<{
    role: string;
    content: string;
    name?: string;
    agentId?: string;
    agentName?: string;
  }>,
  currentAgentId: string
): Array<{ role: string; content: string; name?: string }> {
  return messages.map(msg => {
    // 只标注助手消息，且来自其他智能体
    if (msg.role !== "assistant") return msg;
    if (!msg.agentId || msg.agentId === currentAgentId) return msg;

    const agentLabel = msg.agentName || "协作者";
    // 如果内容已经包含标注前缀，不重复添加
    if (msg.content.startsWith(`[来自「${agentLabel}」的回复]`)) return msg;

    return {
      role: msg.role,
      content: `[来自「${agentLabel}」的回复]\n${msg.content}`,
      name: agentLabel, // 用名称替代 UUID，LLM 更容易理解
    };
  });
}

/** 协作系统提示词 — 告知 LLM 如何理解多智能体对话 */
export const COLLAB_SYSTEM_PROMPT = `\n\n[协作提示] 本对话中有其他智能体的参与。其他智能体的回复会以「[来自「名称」的回复]」格式标注。请参考其意见完成用户的要求。如果用户提到"根据XXX的意见修改"，请查找标注为[来自「XXX」的回复]的内容作为参考。`;

/**
 * 判断对话是否需要协作提示
 * 当对话中有多个不同智能体的助手消息时返回 true
 */
export function needsCollabPrompt(
  messages: Array<{ role: string; agentId?: string }>,
  currentAgentId: string
): boolean {
  return messages.some(
    m => m.role === "assistant" && m.agentId && m.agentId !== currentAgentId
  );
}

// ── 发送防抖 ──

/** 最小发送间隔（毫秒） */
export const MIN_SEND_INTERVAL_MS = 500;

/**
 * 检查是否允许发送（防抖）
 * 返回 true 表示允许发送
 */
export function canSend(lastSendTime: number): boolean {
  return Date.now() - lastSendTime >= MIN_SEND_INTERVAL_MS;
}
