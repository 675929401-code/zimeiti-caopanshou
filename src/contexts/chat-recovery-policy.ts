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

export const CHAT_STREAM_RESULT_UNKNOWN_MESSAGE = '回复连接已结束，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。';

/** Progress is cumulative output evidence; heartbeats never advance it. */
export function advanceChatGenerationProgress(previous: number, received: unknown): number {
  return typeof received === 'number' && Number.isFinite(received) && received >= 0 && received > previous
    ? received : previous;
}

/** Freeze the outcome before transport cleanup can change the abort signal. */
export function classifyChatStreamFailure(input: {
  sseStarted: boolean; userStopped: boolean; watchdogAborted: boolean; signalAborted: boolean; abortLike: boolean;
}): 'user_stopped' | 'result_unknown' | 'aborted' | 'failed' {
  if (input.userStopped) return 'user_stopped';
  if (input.sseStarted) return 'result_unknown';
  return input.watchdogAborted || input.signalAborted || input.abortLike ? 'aborted' : 'failed';
}

/** Bound a pending read by byte inactivity and its own controller only. */
export async function readChatStreamChunk<TTimer>(
  reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal, timeoutMs: number,
  timers: { setTimeout: (callback: () => void, milliseconds: number) => TTimer; clearTimeout: (timer: TTimer) => void },
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  let timeout: TTimer | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        timeout = timers.setTimeout(() => reject(new Error(`SSE读取超时(${timeoutMs / 1000}秒无数据)`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** A broken transport must not keep finalization waiting for reader.cancel(). */
export function closeChatStreamReader(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  controller: AbortController,
  abortTransport: boolean,
): void {
  try { void reader?.cancel().catch(() => undefined); } catch { /* Ignore cleanup failures. */ }
  if (abortTransport && !controller.signal.aborted) controller.abort();
}
