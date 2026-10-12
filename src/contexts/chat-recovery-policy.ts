/** A stream in B cannot suppress the metadata-only save of completed A. */
export function isConversationMetadataSyncBlocked(
  conversationId: string,
  streamingConversationIds: ReadonlySet<string>,
  pendingConversationIds: ReadonlySet<string>,
): boolean {
  return streamingConversationIds.has(conversationId) || pendingConversationIds.has(conversationId);
}

/** Paid output is preserved; a history warning is never a retryable send error. */
export function settledChatPersistenceWarning(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const persistence = record._persistence;
  if (!persistence || typeof persistence !== 'object') return null;
  const state = persistence as Record<string, unknown>;
  if (state.status !== 'recovery_required' || state.code !== 'LLM_ASSISTANT_PERSISTENCE_FAILED') return null;
  return '回复已生成并结算，聊天记录保存状态待恢复。请保留当前回复并刷新历史核对，勿重复发送。';
}
