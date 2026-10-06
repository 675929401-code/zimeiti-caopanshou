import { createHash } from "node:crypto";

export const LLM_MODEL_VALIDATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type LlmModelValidationBinding = {
  id?: unknown;
  model_name?: unknown;
  api_endpoint?: unknown;
  proxy_url?: unknown;
  api_key?: unknown;
  billing_mode?: unknown;
  token_billing_enabled?: unknown;
  input_cost_per_million?: unknown;
  output_cost_per_million?: unknown;
  cached_cost_per_million?: unknown;
  profit_margin?: unknown;
  max_context_rounds?: unknown;
  max_context_tokens?: unknown;
  max_reply_tokens?: unknown;
  timeout?: unknown;
  deep_thinking_type?: unknown;
  enable_web_search?: unknown;
  api_protocol_config?: unknown;
};

export type LlmModelValidationEvidence = {
  model_id?: unknown;
  configuration_hash?: unknown;
  checked_at?: unknown;
};

export class LlmModelValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "LlmModelValidationError";
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedEndpoint(binding: LlmModelValidationBinding) {
  const raw = text(binding.api_endpoint) || text(binding.proxy_url);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return raw.replace(/\/+$/u, "");
  }
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJson(child)]),
  );
}

export function llmModelValidationConfigurationHash(
  binding: LlmModelValidationBinding,
  resolvedSecret: string,
) {
  const secretHash = createHash("sha256").update(resolvedSecret).digest("hex");
  const payload = [
    ["id", text(binding.id)],
    ["modelName", text(binding.model_name)],
    ["endpoint", normalizedEndpoint(binding)],
    ["secretSha256", secretHash],
    ["billingMode", text(binding.billing_mode)],
    ["tokenBillingEnabled", binding.token_billing_enabled === true],
    ["inputCostPerMillion", finite(binding.input_cost_per_million)],
    ["outputCostPerMillion", finite(binding.output_cost_per_million)],
    ["cachedCostPerMillion", finite(binding.cached_cost_per_million)],
    ["profitMargin", finite(binding.profit_margin)],
    ["maxContextRounds", finite(binding.max_context_rounds)],
    ["maxContextTokens", finite(binding.max_context_tokens)],
    ["maxReplyTokens", finite(binding.max_reply_tokens)],
    ["timeout", finite(binding.timeout)],
    ["deepThinkingType", finite(binding.deep_thinking_type)],
    ["webSearch", binding.enable_web_search === true],
    ["protocolConfig", stableJson(binding.api_protocol_config || {})],
  ];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function assertFreshLlmModelValidationEvidence(
  binding: LlmModelValidationBinding,
  resolvedSecret: string,
  evidence: LlmModelValidationEvidence | null | undefined,
  now = Date.now(),
) {
  const expectedHash = llmModelValidationConfigurationHash(binding, resolvedSecret);
  if (!evidence || text(evidence.model_id) !== text(binding.id)
      || text(evidence.configuration_hash) !== expectedHash) {
    throw new LlmModelValidationError(
      "TEXT_MODEL_VALIDATION_EVIDENCE_REQUIRED",
      "对话模型必须先完成当前配置的真实隔离验证，才能激活",
    );
  }
  const checkedAt = Date.parse(text(evidence.checked_at));
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60_000
      || now - checkedAt > LLM_MODEL_VALIDATION_MAX_AGE_MS) {
    throw new LlmModelValidationError(
      "TEXT_MODEL_VALIDATION_EVIDENCE_EXPIRED",
      "对话模型的真实验证证据已过期，请重新验证后再激活",
    );
  }
  return { configurationHash: expectedHash, checkedAt: new Date(checkedAt).toISOString() };
}
