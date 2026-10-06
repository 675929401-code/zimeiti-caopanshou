/** Keep the agent's reply budget when changing providers, within the model limit. */
export function resolveChatReplyLimit(agentLimit: unknown, modelLimit: unknown): number {
  const positiveInteger = (value: unknown): number | undefined => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  };
  const agent = positiveInteger(agentLimit);
  const model = positiveInteger(modelLimit);
  // 4096 的旧兜底会把"未配置上限"的长输出任务拦腰截断（约2600字），
  // 与后台"0=不限"的语义冲突；无任何配置时放行 16384（普通长文档预算）。
  return agent && model ? Math.min(agent, model) : agent ?? model ?? 16384;
}
