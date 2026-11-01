import type { Message } from "@/types/coze";
import { storyboardPromptVisibleText } from "./storyboard-prompt-draft";

const PERSISTED_MESSAGE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const INTERRUPTED_REPLY = /(?:\[已终止\]|\[已停止接收；[^\]]*\]|\n---\n\*?[^\n]*(?:输出中断|网络中断|连接中断)[^\n]*\*?)\s*$/u;

/** Local rendering IDs are never database branch anchors. */
export function persistedChatMessageId(message?: Pick<Message, "id" | "serverMessageId">): string | undefined {
  if (!message) return undefined;
  const candidate = message.serverMessageId || message.id;
  return PERSISTED_MESSAGE_ID.test(candidate) ? candidate : undefined;
}

/** Slice only the request context. The visible and persisted attempts stay intact. */
export function chatBranchContext<T extends Pick<Message, "id" | "role">>(messages: T[], messageId?: string): T[] {
  if (!messageId) return messages;
  const index = messages.findIndex(message => message.id === messageId);
  if (index < 0) return messages;
  // Earlier attempts for the same user turn remain visible, but must not be
  // replayed as extra assistant turns when regenerating a later attempt.
  if (messages[index].role === "assistant") {
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (messages[cursor].role === "user") return messages.slice(0, cursor + 1);
    }
  }
  return messages.slice(0, index);
}

/** Restore only recorded failure evidence; historical rows otherwise remain unchanged. */
export function restoreChatHistoryAttemptStatus(messages: Message[], input: unknown): Message[] {
  if (!Array.isArray(input)) return messages;
  return messages.map((message, index) => {
    const row = input[index] as Record<string, unknown> | null;
    if (!row || message.role !== "assistant") return message;
    const error = [row.error, row.error_message, row.errorMessage].find(value => typeof value === "string" && value.trim());
    const incomplete = row.isStreaming === true || row.is_streaming === true
      || /^(?:failed|error|cancelled|canceled|aborted|interrupted|incomplete|pending|in_progress|result_unknown)$/iu.test(String(row.status || ""));
    return error || incomplete ? { ...message, error: typeof error === "string" ? error : "上次回复未完成" } : message;
  });
}

function requestVisibleText(content: string): string {
  const outsideCode = content.replace(/(?:^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1(?=\n|$)/gu, "");
  if (/^\s*<!--\s*storyboard_director_(?:output|assets|plan):v1\b/imu.test(outsideCode)) return storyboardPromptVisibleText(content);
  const candidates = [content.trim(), ...[...content.matchAll(/(?:^|\n)(`{3,})(?:json|machine_json|stable_json)[ \t]*\n([\s\S]*?)\n\1(?=\n|$)/giu)].map(match => match[2])];
  const knownTransport = candidates.some(raw => {
    try {
      const parsed = JSON.parse(raw);
      const value = parsed?.package ?? parsed;
      const kind = /^storyboard_director_(output|assets|plan)\.v1$/u.exec(String(value?.schema_version));
      return !!kind && value.artifact_type === `storyboard_director_${kind[1] === "output" ? "package" : kind[1]}`;
    } catch { return false; }
  });
  return knownTransport ? storyboardPromptVisibleText(content) : content;
}

/** The user explicitly chose this partial reply as continuation input. */
export function chatContinuationText(content: string): string {
  return requestVisibleText(content.replace(INTERRUPTED_REPLY, "").trimEnd());
}

/** Select request candidates only; never mutate the visible or durable attempt history. */
export function projectChatRequestHistory(messages: readonly Message[], fallbackAgentId?: string): Message[] {
  const selected: Message[] = [];
  const seen = new Set<string>();
  // Older Continue actions did not save a user turn. Keep those ambiguous
  // partial + continuation chains instead of treating them as regenerations.
  const legacyChain = new Set<number>();
  const partials = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role === "user") { partials.clear(); return; }
    const agentId = message.agentId || fallbackAgentId || "";
    if (!message.error && !message.isStreaming && INTERRUPTED_REPLY.test(message.content) && chatContinuationText(message.content).trim()) {
      partials.set(agentId, [...(partials.get(agentId) || []), index]);
    } else if (!message.error && !message.isStreaming && message.content.trim() && message.content.trim() !== "（无回复内容）" && partials.has(agentId)) {
      partials.get(agentId)!.forEach(partial => legacyChain.add(partial));
      legacyChain.add(index);
    }
  });
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") { selected.push(message); seen.clear(); continue; }
    const agentId = message.agentId || fallbackAgentId || "";
    if (!legacyChain.has(index) && (seen.has(agentId) || message.isStreaming || message.error || !message.content.trim()
      || INTERRUPTED_REPLY.test(message.content) || message.content.trim() === "（无回复内容）")) continue;
    const content = legacyChain.has(index) ? chatContinuationText(message.content) : requestVisibleText(message.content);
    if (!content.trim()) continue;
    seen.add(agentId);
    selected.push(content === message.content ? message : { ...message, content });
  }
  return selected.reverse();
}

export function readPersistedAssistantMessageId(event: unknown, conversationId: string): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  return value.type === "message_persisted" && value.role === "assistant"
    && value.conversation_id === conversationId && typeof value.message_id === "string"
    && PERSISTED_MESSAGE_ID.test(value.message_id) ? value.message_id : undefined;
}
