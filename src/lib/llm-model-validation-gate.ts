import { createHash } from "node:crypto";
import { PENDING_TEXT_USER_ACCESS } from "./model-activation-gate";

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

/** Saving configuration is never an alternate activation endpoint. */
export function pendingLlmConfigurationUpdate(
  current: LlmModelValidationBinding & { is_active?: unknown; user_access?: unknown; is_hidden?: unknown },
  patch: Record<string, unknown>,
) {
  const next = { ...current, ...patch };
  const changed = llmModelValidationConfigurationHash(current, text(current.api_key))
    !== llmModelValidationConfigurationHash(next, text(next.api_key));
  const alreadyActive = current.is_active === true && current.user_access === "available";
  if ((patch.is_active === true || (patch.user_access === "available" && current.user_access !== "available")) && !alreadyActive) {
    throw new LlmModelValidationError("TEXT_MODEL_ACTIVATION_ENDPOINT_REQUIRED", "请先保存并发布配置，完成真实通路验证后再点击激活；普通保存不能激活模型");
  }
  return {
    ...patch,
    is_active: changed || !alreadyActive ? false : patch.is_active ?? current.is_active,
    user_access: changed || !alreadyActive ? PENDING_TEXT_USER_ACCESS : current.user_access,
    // Configuration changes invalidate generation, never catalogue visibility.
    is_hidden: patch.is_hidden ?? current.is_hidden ?? false,
  };
}

/** Never carry a persisted credential into a different supplier origin. */
export function assertLlmEndpointCredentialReplacement(
  current: LlmModelValidationBinding,
  patch: Record<string, unknown>,
  replacementKey: string | undefined,
) {
  const merged = { ...current, ...patch };
  const previousEndpoint = text(current.api_endpoint) || text(current.proxy_url);
  const nextEndpoint = text(merged.api_endpoint) || text(merged.proxy_url);
  let sameOrigin = false;
  try {
    sameOrigin = new URL(previousEndpoint).origin === new URL(nextEndpoint).origin;
  } catch {
    throw new LlmModelValidationError("TEXT_MODEL_ENDPOINT_INVALID", "对话模型接口地址无效，请填写完整 API 地址", 400);
  }
  if (!sameOrigin && (!replacementKey || replacementKey === text(current.api_key))) {
    throw new LlmModelValidationError("TEXT_MODEL_NEW_ORIGIN_CREDENTIAL_REQUIRED", "接入站点已改变，请填写新站点的密钥或新的凭据引用；不能沿用原站点密钥", 400);
  }
}

const SAVED_PROBE_FIELDS = new Set(["scope", "model_id", "agent_id", "model_type"]);

export function llmDiagnosticScope(body: Record<string, unknown>): "saved" | "draft" {
  if (body.scope !== undefined && body.scope !== "saved" && body.scope !== "draft") {
    throw new LlmModelValidationError("TEXT_MODEL_TEST_SCOPE_INVALID", "验证范围必须为 saved 或 draft", 400);
  }
  const overrides = Object.keys(body).some((key) => !SAVED_PROBE_FIELDS.has(key));
  const scope = body.scope === "draft" ? "draft" : body.scope === "saved" ? "saved"
    : (body.model_id || body.agent_id) && !overrides ? "saved" : "draft";
  if (scope === "saved" && (overrides || (!body.model_id && !body.agent_id))) {
    throw new LlmModelValidationError("TEXT_MODEL_SAVED_TEST_OVERRIDE_REJECTED", "已保存模型验证仅接受模型 ID；请先保存草稿再验证", 400);
  }
  return scope;
}

export function assertLlmValidationConfigurationUnchanged(
  before: LlmModelValidationBinding & { updated_at?: unknown },
  after: (LlmModelValidationBinding & { updated_at?: unknown }) | null | undefined,
  originalHash: string,
  currentSecret: string,
) {
  if (!after || text(before.updated_at) !== text(after.updated_at)
    || llmModelValidationConfigurationHash(after, currentSecret) !== originalHash) {
    throw new LlmModelValidationError("VALIDATION_CONFIGURATION_CHANGED", "验证期间模型配置发生变化，未记录激活证据，请刷新后重新确认");
  }
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
