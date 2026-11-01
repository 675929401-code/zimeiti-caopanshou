import { officialStoryboardDirectorIdentity } from "./storyboard-director-identity";

/** Canonical output_style key for the storyboard prompt handoff capability. */
export const STORYBOARD_PROMPT_HANDOFF_KEY = "storyboardPromptHandoff" as const;
export type AgentPromptPushTarget = "storyboard-workbench" | "video";

// Stable IDs confirmed against the current administrator catalog. Display names
// are not routing identities; these legacy prompt agents predate this setting.
const LEGACY_STORYBOARD_PROMPT_AGENTS = new Set([
  "agent-1793171231055-r9qzu6",
  "agent-1793173660476-ci8pl8",
]);

export interface StoryboardPromptHandoffConfig {
  enabled?: boolean;
  target?: AgentPromptPushTarget;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Resolve the capability from persisted agent configuration.
 *
 * A legacy false still means ordinary video handoff. Explicit target metadata
 * otherwise wins; invalid targets have no destination and must not be routed.
 */
export function resolveAgentPromptPushTarget(agentId: unknown, outputStyle: unknown): AgentPromptPushTarget | undefined {
  const style = record(outputStyle);
  const configured = record(style?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  if (configured && Object.hasOwn(configured, "target") && !isAgentPromptPushTarget(configured.target)) return undefined;
  if (configured?.enabled === false) return "video";
  if (configured && Object.hasOwn(configured, "target")) {
    return isAgentPromptPushTarget(configured.target) ? configured.target : undefined;
  }
  if (configured?.enabled === true) return "storyboard-workbench";
  return officialStoryboardDirectorIdentity(agentId) !== undefined
    || (typeof agentId === "string" && LEGACY_STORYBOARD_PROMPT_AGENTS.has(agentId))
    ? "storyboard-workbench" : "video";
}

export function isAgentPromptPushTarget(value: unknown): value is AgentPromptPushTarget {
  return value === "storyboard-workbench" || value === "video";
}

/** Only the new target field is validated; legacy and unrelated style data stay compatible. */
export function isAgentPromptPushTargetConfigurationValid(outputStyle: unknown): boolean {
  const configured = record(record(outputStyle)?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  return !configured || !Object.hasOwn(configured, "target") || isAgentPromptPushTarget(configured.target);
}

export function configuredAgentPromptPushTarget(outputStyle: unknown): AgentPromptPushTarget | undefined {
  const configured = record(record(outputStyle)?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  return isAgentPromptPushTarget(configured?.target) ? configured.target : undefined;
}

export function hasStoryboardPromptPushCapability(agentId: unknown, outputStyle: unknown): boolean {
  return resolveAgentPromptPushTarget(agentId, outputStyle) === "storyboard-workbench";
}

export function setAgentPromptPushTarget(outputStyle: unknown, target: AgentPromptPushTarget): Record<string, unknown> {
  if (!isAgentPromptPushTarget(target)) throw new Error("AGENT_PROMPT_PUSH_TARGET_INVALID");
  const style = record(outputStyle) || {};
  return {
    ...style,
    [STORYBOARD_PROMPT_HANDOFF_KEY]: {
      ...record(style[STORYBOARD_PROMPT_HANDOFF_KEY]),
      enabled: target === "storyboard-workbench",
      target,
    },
  };
}

/** Preserve all existing output_style keys while changing only this capability. */
export function setStoryboardPromptPushCapability(outputStyle: unknown, enabled: boolean): Record<string, unknown> {
  const style = record(outputStyle) || {};
  const configured = record(style[STORYBOARD_PROMPT_HANDOFF_KEY]);
  return {
    ...style,
    [STORYBOARD_PROMPT_HANDOFF_KEY]: {
      ...configured,
      enabled,
      ...(configured && Object.hasOwn(configured, "target") ? { target: enabled ? "storyboard-workbench" : "video" } : {}),
    },
  };
}

/** Read an explicit setting without applying the official-agent fallback. */
export function configuredStoryboardPromptPushCapability(outputStyle: unknown): boolean | undefined {
  const style = record(outputStyle);
  const configured = record(style?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  return typeof configured?.enabled === "boolean" ? configured.enabled : undefined;
}
