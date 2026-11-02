import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "./story-director-overtime-gate";
import { FREE_CHAT_AGENT_ID, MANGA_WORKBENCH_AGENT_ID, isAllowedVirtualAgentId } from "./virtual-agent-policy";

/** Public IDs are opaque HMAC-derived catalog identities, never upstream model names. */
export function isValidPublicChatModelId(value: unknown): value is string {
  return typeof value === "string" && /^pm_[A-Za-z0-9_-]{24}$/u.test(value);
}

/** The server must pass its loaded Agent row; client eligibility only controls presentation. */
export function canSelectPublicChatModel(
  agentId: unknown,
  agent: { source?: unknown } | null | undefined,
): boolean {
  // The existing official manga route has its own downstream prompt/Skill gates.
  if (agentId === FREE_CHAT_AGENT_ID || agentId === MANGA_WORKBENCH_AGENT_ID) return true;
  if (isAllowedVirtualAgentId(agentId)) return false;
  if (agentId === STORY_DIRECTOR_MOVIE_AGENT_ID || agentId === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID) return false;
  return typeof agentId === "string" && agentId.length > 0 && agent?.source === "llm";
}
