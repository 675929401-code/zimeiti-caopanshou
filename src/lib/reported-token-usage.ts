type Row = Record<string, unknown>;
export type ReportedTokenUsage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number };
export const missingUsageReceipt = {
  error: "供应商用量回执不完整，本阶段尚未扣分，请凭原请求核对。",
  code: "LLM_BILLING_FAILED", retry_safe: false, reconciliation_required: true, done: false,
} as const;

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readChatTokenUsage(usage: Row | null | undefined): ReportedTokenUsage | undefined {
  if (!usage || !count(usage.prompt_tokens) || !count(usage.completion_tokens)) return undefined;
  const details = usage.prompt_tokens_details as Row | undefined;
  const hits = [details?.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens].filter(value => value !== undefined);
  const misses = usage.prompt_cache_miss_tokens;
  if (misses !== undefined && (!count(misses) || misses > usage.prompt_tokens)) return undefined;
  const cached = hits[0] ?? (typeof misses === "number" ? usage.prompt_tokens - misses : 0);
  if (!count(cached) || cached > usage.prompt_tokens || hits.some(value => value !== cached)
      || (typeof misses === "number" && usage.prompt_tokens - cached !== misses)) return undefined;
  return { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, cached_tokens: cached };
}

export function hasDeliveredUsage(usage: ReportedTokenUsage | undefined | null): usage is ReportedTokenUsage {
  return Boolean(usage && count(usage.prompt_tokens) && count(usage.completion_tokens) && usage.completion_tokens > 0
    && count(usage.cached_tokens) && usage.cached_tokens <= usage.prompt_tokens);
}
