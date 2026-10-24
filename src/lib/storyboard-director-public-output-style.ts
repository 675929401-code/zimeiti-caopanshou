import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID } from "./story-director-overtime-gate";
import { STORYBOARD_PERFORMANCE_CONTRACT_VERSION, storyboardPerformanceActivationTime } from "./storyboard-director-performance";
import { STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } from "./storyboard-director-protocol";
import { officialStoryboardDirectorIdentity } from "./storyboard-director-identity";
import { STORYBOARD_PROMPT_HANDOFF_KEY } from "./storyboard-prompt-push-capability";

/** Publish only quality-contract scalars, never private prompt/style configuration. */
export function publicStoryboardDirectorOutputStyle(agentId: unknown, value: unknown): Record<string, unknown> | undefined {
  const identity = officialStoryboardDirectorIdentity(agentId);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return identity?.mode === "high_energy" ? { performance_contract: "invalid" } : undefined;
  const source = value as Record<string, unknown>;
  const configuredHandoff = source[STORYBOARD_PROMPT_HANDOFF_KEY];
  const output: Record<string, unknown> = {};
  if (configuredHandoff && typeof configuredHandoff === "object" && !Array.isArray(configuredHandoff)
    && typeof (configuredHandoff as Record<string, unknown>).enabled === "boolean") {
    output[STORYBOARD_PROMPT_HANDOFF_KEY] = { enabled: (configuredHandoff as Record<string, unknown>).enabled };
  }
  if (!identity) return Object.keys(output).length > 0 ? output : undefined;
  if (agentId !== STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID
    && source.production_contract_version === undefined && source.performance_contract === undefined) {
    return Object.keys(output).length > 0 ? output : undefined;
  }
  for (const [key, expected] of [["production_contract_version", STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION], ["performance_contract", STORYBOARD_PERFORMANCE_CONTRACT_VERSION]] as const) {
    if (Object.hasOwn(source, key)) output[key] = source[key] === expected ? expected : "invalid";
  }
  for (const key of ["production_contract_activated_at", "performance_contract_activated_at"] as const) {
    if (Object.hasOwn(source, key)) output[key] = storyboardPerformanceActivationTime(source[key]) !== undefined ? source[key] as string : "invalid";
  }
  if (identity.mode === "cinematic") {
    for (const key of ["production_contract_version", "production_contract_activated_at", "performance_contract", "performance_contract_activated_at"]) {
      if (!Object.hasOwn(output, key)) output[key] = "invalid";
    }
  }
  return output;
}
