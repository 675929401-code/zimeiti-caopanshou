import { createHash } from "node:crypto";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../story-director-overtime-gate";
import { resolveLlmProviderBinding } from "../llm-provider-contract";
import type { AnthropicThinkingProfile } from "../llm-proxy/types";

export const STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256 = "5010ed7ff52d8928ee016353e4f2eceade0ed6a3c2241a1beac9c23c368916a7";
export const STORYBOARD_HIGH_ENERGY_B_V8_PROMPT_SHA256 = "409daf8561f4bf67e3991e414ce1e0efbad49de4bd86499e0cc512731c01c482";
export const STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256 = "41189ec0b43f00fcf8c7a4471cd61c514dba0c31a82293898feb8fc59c1d7e11";
export const STORYBOARD_HIGH_ENERGY_UNIFIED_PROMPT_SHA256 = "eef9e2920edb938a8f1400d9eecddaa0db914d5daac6da03ba71eeca8080ed6f";
export const STORYBOARD_NARRATIVE_UNIFIED_PROMPT_SHA256 = "8fbf3d29e6840041128790daee1ef9a62df852b73d2cf352ac628b2a4917d01a";

/** Text-only authority is independent of provider thinking defaults. */
export function resolveStoryboardDirectorTextOnly(input: { agentId: unknown; serverPrompt: unknown }): boolean {
  if (typeof input.serverPrompt !== "string") return false;
  const digest = createHash("sha256").update(input.serverPrompt.trim(), "utf8").digest("hex");
  if (input.agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID) {
    return [STORYBOARD_HIGH_ENERGY_ULTRA_PROMPT_SHA256, STORYBOARD_HIGH_ENERGY_UNIFIED_PROMPT_SHA256].includes(digest);
  }
  return input.agentId === STORY_DIRECTOR_MOVIE_AGENT_ID && digest === STORYBOARD_NARRATIVE_UNIFIED_PROMPT_SHA256;
}
export const STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID = "3af4f2e6-a51f-44f6-ad17-9e6412147c81";
const ADAPTIVE_LOW_PROFILE: AnthropicThinkingProfile = Object.freeze({
  id: "storyboard-high-energy-b-v6-adaptive-low-v1",
  thinkingMode: "adaptive",
  effort: "low",
});
const B_V8_ADAPTIVE_LOW_PROFILE: AnthropicThinkingProfile = Object.freeze({
  id: "storyboard-high-energy-b-v8-adaptive-low-v1", thinkingMode: "adaptive", effort: "low",
});

type ModelSource = {
  id?: unknown;
  model_name?: unknown;
  api_endpoint?: unknown;
  proxy_url?: unknown;
  provider?: unknown;
  protocol_type?: unknown;
  api_protocol_config?: unknown;
};

/**
 * Apply only to a server-owned agent row and its authoritative persisted prompt.
 * Opus 5.5 requires adaptive thinking. This exact model/compiler binding uses
 * low effort without disabling reasoning or changing its billing semantics.
 * Unknown identities, prompt revisions, models and transports retain defaults.
 */
export function resolveStoryboardDirectorAnthropicProfile(input: {
  agentId: unknown;
  serverPrompt: unknown;
  model: ModelSource;
}): AnthropicThinkingProfile | undefined {
  const { agentId, serverPrompt, model } = input;
  if (agentId !== STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID || typeof serverPrompt !== "string"
    || model.id !== STORYBOARD_HIGH_ENERGY_B_V6_MODEL_ID || model.model_name !== "claude-opus-5-5") return undefined;
  const promptDigest = createHash("sha256").update(serverPrompt.trim(), "utf8").digest("hex");
  const profile = promptDigest === STORYBOARD_HIGH_ENERGY_B_V6_PROMPT_SHA256 ? ADAPTIVE_LOW_PROFILE
    : promptDigest === STORYBOARD_HIGH_ENERGY_B_V8_PROMPT_SHA256 ? B_V8_ADAPTIVE_LOW_PROFILE : undefined;
  if (!profile) return undefined;
  const apiBase = typeof model.api_endpoint === "string" && model.api_endpoint.trim()
    ? model.api_endpoint.trim() : typeof model.proxy_url === "string" ? model.proxy_url.trim() : "";
  try {
    const url = new URL(apiBase);
    if (url.origin !== "https://n.lconai.com" || url.username || url.password) return undefined;
    if (resolveLlmProviderBinding(model).protocol !== "anthropic_messages") return undefined;
  } catch { return undefined; }
  return profile;
}
