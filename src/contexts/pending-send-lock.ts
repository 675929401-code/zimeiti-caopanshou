export function tryAcquireConversationSend(lock: Set<string>, conversationId: string): boolean {
  if (lock.has(conversationId)) return false;
  lock.add(conversationId);
  return true;
}

export function releaseConversationSend(lock: Set<string>, conversationId: string): void {
  lock.delete(conversationId);
}
