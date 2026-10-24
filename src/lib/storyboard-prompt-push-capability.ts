import { officialStoryboardDirectorIdentity } from "./storyboard-director-identity";

/** Canonical output_style key for the storyboard prompt handoff capability. */
export const STORYBOARD_PROMPT_HANDOFF_KEY = "storyboardPromptHandoff" as const;

export interface StoryboardPromptHandoffConfig {
  enabled?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Resolve the capability from persisted agent configuration.
 *
 * The two official storyboard directors keep their historical behaviour when
 * the new field is absent. An explicit boolean always wins, so administrators
 * can turn the icon off for an official director or on for another agent.
 */
export function hasStoryboardPromptPushCapability(agentId: unknown, outputStyle: unknown): boolean {
  const style = record(outputStyle);
  const configured = record(style?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  if (typeof configured?.enabled === "boolean") return configured.enabled;
  return officialStoryboardDirectorIdentity(agentId) !== undefined;
}

/** Preserve all existing output_style keys while changing only this capability. */
export function setStoryboardPromptPushCapability(outputStyle: unknown, enabled: boolean): Record<string, unknown> {
  const style = record(outputStyle) || {};
  return {
    ...style,
    [STORYBOARD_PROMPT_HANDOFF_KEY]: { enabled },
  };
}

/** Read an explicit setting without applying the official-agent fallback. */
export function configuredStoryboardPromptPushCapability(outputStyle: unknown): boolean | undefined {
  const style = record(outputStyle);
  const configured = record(style?.[STORYBOARD_PROMPT_HANDOFF_KEY]);
  return typeof configured?.enabled === "boolean" ? configured.enabled : undefined;
}
