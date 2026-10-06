import type { Agent } from "@/types/coze";
import {
  FREE_CHAT_AGENT_ID,
  MANGA_WORKBENCH_AGENT_ID,
} from "@/lib/virtual-agent-policy";

export { FREE_CHAT_AGENT_ID, MANGA_WORKBENCH_AGENT_ID };

export function createVirtualChatAgent(agentId: string): Agent | null {
  if (agentId === FREE_CHAT_AGENT_ID) {
    return {
      id: FREE_CHAT_AGENT_ID,
      name: "AI对话",
      description: "GPT-5.6 深度思考自由对话",
      iconUrl: "",
      category: "",
      botId: null,
      source: "llm",
      model: undefined,
      is_active: true,
      systemPrompt: "",
    };
  }

  if (agentId === MANGA_WORKBENCH_AGENT_ID) {
    return {
      id: MANGA_WORKBENCH_AGENT_ID,
      name: "创作 Agent",
      description: "有彩视界独立创作总控与 Skill 调度器",
      iconUrl: "",
      category: "漫剧工作台",
      botId: null,
      source: "llm",
      model: undefined,
      is_active: true,
      // The authoritative prompt is server-only and is assembled by the LLM route.
      systemPrompt: "",
    };
  }

  return null;
}

export function isVirtualChatAgentId(agentId: string | null | undefined): boolean {
  return agentId === FREE_CHAT_AGENT_ID || agentId === MANGA_WORKBENCH_AGENT_ID;
}
