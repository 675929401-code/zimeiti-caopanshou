export type LlmRequestProtocol = "openai_chat" | "anthropic_messages";
export type LlmAuthScheme = "bearer" | "x-api-key";
export type LlmThinkingStrategy = "provider_default" | "adaptive_low";
export type LlmOutputTokenField = "max_tokens" | "max_completion_tokens";

export type LlmProviderBinding = {
  provider: string;
  protocol: LlmRequestProtocol;
  authScheme: LlmAuthScheme;
  protocolVersion?: string;
  thinkingStrategy?: LlmThinkingStrategy;
  outputTokenField?: LlmOutputTokenField;
};

type LlmBindingSource = {
  provider?: unknown;
  protocol_type?: unknown;
  api_protocol_config?: unknown;
};

const PROTOCOL_ALIASES: Record<string, LlmRequestProtocol> = {
  openai: "openai_chat",
  openai_chat: "openai_chat",
  openai_chat_completions: "openai_chat",
  chat_completions: "openai_chat",
  anthropic: "anthropic_messages",
  anthropic_messages: "anthropic_messages",
  claude_messages: "anthropic_messages",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export class LlmProviderBindingError extends Error {
  readonly code = "LLM_PROTOCOL_BINDING_REQUIRED";

  constructor(message = "当前对话模型缺少显式渠道与接口协议绑定") {
    super(message);
    this.name = "LlmProviderBindingError";
  }
}

/**
 * Runtime protocol selection is configuration-driven only. Host names and
 * model names are deliberately not inspected here: a relay may expose several
 * incompatible protocols on the same origin.
 */
export function resolveLlmProviderBinding(source: LlmBindingSource): LlmProviderBinding {
  const config = record(source.api_protocol_config);
  const provider = configuredString(config, "provider") || String(source.provider || "").trim();
  const rawProtocol = (
    configuredString(config, "protocol", "protocol_type")
    || String(source.protocol_type || "").trim()
  ).toLowerCase();
  const protocol = PROTOCOL_ALIASES[rawProtocol];
  if (!provider || !protocol) throw new LlmProviderBindingError();

  const configuredAuth = configuredString(config, "auth_scheme").toLowerCase();
  if (configuredAuth && configuredAuth !== "bearer" && configuredAuth !== "x-api-key") {
    throw new LlmProviderBindingError("不支持的对话模型认证方式，请选择 Bearer 或 x-api-key");
  }
  const authScheme: LlmAuthScheme = configuredAuth === "x-api-key" ? "x-api-key" : "bearer";
  const protocolVersion = configuredString(config, "protocol_version")
    || (protocol === "anthropic_messages" ? "2023-06-01" : undefined);
  const strategy = configuredString(config, "thinking_strategy");
  if (strategy && strategy !== "provider_default" && strategy !== "adaptive_low") {
    throw new LlmProviderBindingError("不支持的思考策略");
  }
  if (strategy === "adaptive_low" && (protocol !== "anthropic_messages" || config.supports_adaptive_thinking !== true)) {
    throw new LlmProviderBindingError("adaptive low 需要 Anthropic 协议及已确认的自适应思考能力配置");
  }
  const outputField = configuredString(config, "output_token_field");
  if (outputField && outputField !== "max_tokens" && outputField !== "max_completion_tokens") {
    throw new LlmProviderBindingError("不支持的输出 Token 参数字段");
  }
  if (protocol === "anthropic_messages" && outputField === "max_completion_tokens") {
    throw new LlmProviderBindingError("Anthropic Messages 仅支持 max_tokens 输出参数");
  }
  return { provider, protocol, authScheme, protocolVersion, ...(strategy ? { thinkingStrategy: strategy as LlmThinkingStrategy } : {}), ...(outputField ? { outputTokenField: outputField as LlmOutputTokenField } : {}) };
}

export function canonicalLlmProtocolConfig(source: LlmBindingSource): Record<string, unknown> {
  const current = record(source.api_protocol_config);
  const binding = resolveLlmProviderBinding(source);
  return {
    ...current,
    provider: binding.provider,
    protocol: binding.protocol,
    auth_scheme: binding.authScheme,
    ...(binding.protocolVersion ? { protocol_version: binding.protocolVersion } : {}),
    ...(binding.thinkingStrategy ? { thinking_strategy: binding.thinkingStrategy } : {}),
    ...(binding.outputTokenField ? { output_token_field: binding.outputTokenField } : {}),
  };
}

export function llmProxyBindingConfig(binding: LlmProviderBinding) {
  return {
    provider: binding.provider,
    protocol: binding.protocol,
    authScheme: binding.authScheme,
    protocolVersion: binding.protocolVersion,
    thinkingStrategy: binding.thinkingStrategy,
    outputTokenField: binding.outputTokenField,
  } as const;
}
