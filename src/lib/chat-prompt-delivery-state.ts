/** Draft handoff must not turn an interrupted or unknown reply into a ready
 * production input. This does not alter the original message or retry state. */
export function isChatPromptDeliveryMessageReady(message: {
  role?: string; content?: string; isStreaming?: boolean; error?: string; streamStatus?: string;
} | undefined): boolean {
  return Boolean(message && message.role === 'assistant' && !message.isStreaming && !message.error && message.content?.trim()
    && !/error|failed|aborted|unknown|stopped|已停止|已终止|失败|中断/iu.test(message.streamStatus || '')
    && !/(?:最终结果|结果|终态).{0,12}(?:暂未确认|不明)|避免重复发送|禁止重复提交|RECONCILIATION_REQUIRED|RESULT_UNKNOWN|\[已终止\]|\[已停止接收[^\]]*\]|输出中断|网络中断|连接中断|^发送失败：/imu.test(message.content));
}
