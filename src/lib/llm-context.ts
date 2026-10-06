/**
 * 🔒 核心底层代码 — 锁定保护
 * 
 * 本文件是 LLM 上下文管理模块，负责消息轮次裁剪、图片URL解析、系统提示词注入。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "核心底层代码保护规则" 章节。
 * 
 * 锁定范围：整个文件
 * 锁定原因：上下文窗口管理 + global_system_prefix 注入 + 格式强化规则
 */

// LLM 上下文管理模块 — 从 route.ts 拆分
// 负责：消息轮次裁剪、图片URL解析、系统提示词注入
// 修改上下文规则只改这个文件，不动 route.ts

/** 聊天消息格式 */
export interface ChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  /** OpenAI API 标准 name 字段，标识消息来源（如 assistant 消息的来源智能体ID） */
  name?: string;
}

/**
 * 按轮次限制裁剪上下文消息
 * - 保留所有 system 消息
 * - 非系统消息只保留最近 N 轮（1轮 = 1条user + 1条assistant = 2条）
 */
/**
 * 基于 token 估算裁剪消息
 * - maxTokens <= 0 时不裁剪（全部发送）
 * - 从旧消息开始删除，直到估算 token 数 <= maxTokens
 * - 粗略估算：中文约 1.5 字/token，英文约 4 字符/token，取保守值 2 字符/token
 */
export function trimMessagesByTokens(
  messages: ChatMessage[],
  maxTokens: number
): ChatMessage[] {
  if (maxTokens <= 0 || messages.length === 0) return messages;

  const estimateTokens = (msg: ChatMessage): number => {
    if (typeof msg.content === "string") {
      return Math.ceil(msg.content.length / 2) + 4;
    }
    if (Array.isArray(msg.content)) {
      let total = 4;
      for (const part of msg.content) {
        if (part.type === "text" && part.text) total += Math.ceil(part.text.length / 2);
        if (part.type === "image_url") total += 85;
      }
      return total;
    }
    return 10;
  };

  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateTokens(msg);
  }

  if (totalTokens <= maxTokens) return messages;

  let startIdx = 0;
  while (startIdx < messages.length && totalTokens > maxTokens) {
    if (messages[startIdx].role === "system") {
      startIdx++;
      continue;
    }
    totalTokens -= estimateTokens(messages[startIdx]);
    startIdx++;
  }

  return messages.slice(startIdx);
}

/**
 * 兼容旧调用：按轮次裁剪（maxContextRounds <= 0 时不裁剪）
 * @deprecated 使用 trimMessagesByTokens 替代
 */
export function trimMessagesByRounds(
  messages: ChatMessage[],
  maxContextRounds: number
): ChatMessage[] {
  if (maxContextRounds <= 0) return messages;

  const systemMsgs = messages.filter(m => m.role === "system");
  const nonSystemMsgs = messages.filter(m => m.role !== "system");
  const maxMsgCount = maxContextRounds * 2;
  const trimmedNonSystem = nonSystemMsgs.slice(-maxMsgCount);

  return [...systemMsgs, ...trimmedNonSystem];
}

/**
 * 解析消息中的图片URL
 * 将本地存储路径（/api/file?key=xxx）替换为签名URL
 * v2 优化：跳过纯文本消息，减少不必要的遍历和 import 开销
 */
export async function resolveImageUrls(
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  // 快速检查：是否含有图片消息（避免对纯文本对话做无意义的 import）
  const hasAnyImage = messages.some(m => typeof m.content !== "string");
  if (!hasAnyImage) return messages;

  const resolved = await Promise.all(
    messages.map(async (msg) => {
      if (typeof msg.content === "string") return msg;

      const resolvedContent = await Promise.all(
        (msg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>).map(async (part) => {
          if (part.type === "image_url" && part.image_url?.url?.startsWith("/api/file?key=")) {
            try {
              const key = decodeURIComponent(part.image_url.url.replace("/api/file?key=", ""));
              const { getSignedUrl } = await import("@/lib/storage");
              const signedUrl = await getSignedUrl(key, 3600);
              return { ...part, image_url: { url: signedUrl } };
            } catch {
              return part;
            }
          }
          return part;
        })
      );
      return { ...msg, content: resolvedContent };
    })
  );
  return resolved;
}

/**
 * 注入系统提示词
 * - 如果有自定义系统提示词，移除已有的 system 消息，插入自定义版本到最前面
 * - 全局前缀（global_system_prefix）在 route.ts 中已拼接到 systemPrompt 前面
 */
export function injectSystemPrompt(
  messages: ChatMessage[],
  systemPrompt?: string
): ChatMessage[] {
  if (!systemPrompt) return messages;

  const filtered = messages.filter(m => m.role !== "system");
  return [{ role: "system", content: systemPrompt }, ...filtered];
}

/**
 * 一站式上下文处理：裁剪 → 解析图片 → 注入提示词
 * ★ 不设上限模式：maxContextRounds=0 且 maxContextTokens=0 时，
 *   前端发多少历史就送多少，由模型自身上下文窗口做天然限制。
 * ★ 设上限模式：当配置了具体值时，系统提示词纳入 token 预算，
 *   并为历史预留至少 8K token 的最低预算。
 */
export async function prepareContext(
  messages: ChatMessage[],
  options: {
    maxContextRounds?: number;
    maxContextTokens?: number;
    systemPrompt?: string;
  }
): Promise<ChatMessage[]> {
  // 1. 轮次裁剪（0 = 不限制）
  let result = messages;
  if (options.maxContextRounds && options.maxContextRounds > 0) {
    result = trimMessagesByRounds(result, options.maxContextRounds);
  }

  // 2. Token 裁剪（0 = 不限制，由模型上下文窗口做天然限制）
  const contextTokenBudget = options.maxContextTokens ?? 0;
  if (contextTokenBudget > 0) {
    // 为系统提示词预留 token 预算
    if (options.systemPrompt) {
      const systemPromptTokens = Math.ceil(options.systemPrompt.length / 2) + 4;
      const MIN_HISTORY_BUDGET = 8192; // 8K token ≈ 4-8 条消息
      const historyBudget = Math.max(contextTokenBudget - systemPromptTokens, MIN_HISTORY_BUDGET);
      result = trimMessagesByTokens(result, historyBudget);
    } else {
      result = trimMessagesByTokens(result, contextTokenBudget);
    }
  }
  // contextTokenBudget = 0 → 不裁剪，全部发送

  // 3. 解析图片URL
  result = await resolveImageUrls(result);

  // 4. 注入系统提示词
  result = injectSystemPrompt(result, options.systemPrompt);

  return result;
}
