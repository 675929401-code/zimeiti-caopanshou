export const FREE_CHAT_AGENT_ID = "__free_chat__";
export const CANVAS_STORYBOARD_COMPILER_AGENT_ID = "__canvas_storyboard_compiler__";
export const MANGA_WORKBENCH_AGENT_ID = "__manga_workbench__";

const ALLOWED_VIRTUAL_AGENT_IDS = new Set<string>([
  FREE_CHAT_AGENT_ID,
  CANVAS_STORYBOARD_COMPILER_AGENT_ID,
  MANGA_WORKBENCH_AGENT_ID,
]);

export function isAllowedVirtualAgentId(agentId: unknown): agentId is string {
  return typeof agentId === "string" && ALLOWED_VIRTUAL_AGENT_IDS.has(agentId);
}
