import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "./story-director-overtime-gate";
import { STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION, STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } from "./storyboard-director-protocol";
import { STORYBOARD_PERFORMANCE_CONTRACT_VERSION, storyboardPerformanceActivationTime } from "./storyboard-director-performance";

export type OfficialStoryboardDirectorIdentity = { agentId: string; mode: "high_energy" | "cinematic" };

/** Stable official identities are not inferred from display names or model output. */
export function officialStoryboardDirectorIdentity(agentId: unknown): OfficialStoryboardDirectorIdentity | undefined {
  if (agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID) return { agentId, mode: "high_energy" };
  if (agentId === STORY_DIRECTOR_MOVIE_AGENT_ID) return { agentId, mode: "cinematic" };
  return undefined;
}

export function hasStoryboardNarrativeRuntimeContract(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const style = value as Record<string, unknown>;
  return style.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    && style.performance_contract === STORYBOARD_PERFORMANCE_CONTRACT_VERSION
    && storyboardPerformanceActivationTime(style.production_contract_activated_at) !== undefined
    && storyboardPerformanceActivationTime(style.performance_contract_activated_at) !== undefined;
}

/** Old cinematic rows keep their prior behavior until the new server contract is activated. */
export function serverStoryboardDirectorIdentity(input: {
  agentId: unknown;
  agentRow: { id?: unknown; system_prompt?: unknown; output_style?: unknown } | null | undefined;
}): OfficialStoryboardDirectorIdentity | undefined {
  const identity = officialStoryboardDirectorIdentity(input.agentId);
  if (!identity || input.agentRow?.id !== identity.agentId || typeof input.agentRow.system_prompt !== "string") return undefined;
  if (identity.mode === "high_energy") return identity;
  if (!hasStoryboardNarrativeRuntimeContract(input.agentRow.output_style)) return undefined;
  const prompt = input.agentRow.system_prompt;
  return [STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION, STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION, STORYBOARD_PERFORMANCE_CONTRACT_VERSION]
    .every(marker => prompt.includes(marker)) ? identity : undefined;
}
