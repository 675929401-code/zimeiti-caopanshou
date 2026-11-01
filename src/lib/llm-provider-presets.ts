import type { LlmAuthScheme, LlmRequestProtocol } from "./llm-provider-contract";

/** Non-secret connection templates. A template is not route acceptance evidence. */
export type LlmProviderPreset = {
  value: string;
  label: string;
  endpoint: string;
  provider: string;
  protocol: LlmRequestProtocol;
  authScheme: LlmAuthScheme;
  verification: "requires_validation";
};

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  { value: "secure_skill", label: "Secure Skill · OpenAI 兼容", endpoint: "https://token.secure-skill.com/v1", provider: "secure_skill", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "lc_openai", label: "LConAI · OpenAI 兼容（备用节点）", endpoint: "https://s.lconai.com/v1", provider: "lconai", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "lc_openai_primary", label: "LConAI · OpenAI 兼容", endpoint: "https://n.lconai.com/v1", provider: "lconai", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "lc_anthropic", label: "LConAI · Anthropic 兼容", endpoint: "https://n.lconai.com/v1", provider: "lconai", protocol: "anthropic_messages", authScheme: "bearer", verification: "requires_validation" },
  { value: "gaorui", label: "高瑞 · OpenAI 兼容", endpoint: "https://gaorui.cc/v1", provider: "gaorui", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "deepseek_official", label: "DeepSeek · 官方直连", endpoint: "https://api.deepseek.com/v1", provider: "deepseek", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "openai_official", label: "OpenAI · 官方直连", endpoint: "https://api.openai.com/v1", provider: "openai", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
  { value: "anthropic_official", label: "Anthropic · 官方直连", endpoint: "https://api.anthropic.com/v1", provider: "anthropic", protocol: "anthropic_messages", authScheme: "x-api-key", verification: "requires_validation" },
  { value: "custom", label: "自定义接口", endpoint: "", provider: "custom", protocol: "openai_chat", authScheme: "bearer", verification: "requires_validation" },
];

export function getLlmProviderPreset(value: string): LlmProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.value === value);
}
