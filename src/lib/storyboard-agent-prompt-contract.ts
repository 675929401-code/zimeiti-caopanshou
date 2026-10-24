import { z } from "zod";

export const STORYBOARD_AGENT_PROMPT_MIN_LENGTH = 100;
// Keep the full director rules saveable while retaining a bounded request contract.
export const STORYBOARD_AGENT_PROMPT_MAX_LENGTH = 50_000;

export const StoryboardAgentPromptUpdateSchema = z.object({
  prompt: z.string({ error: "提示词必须是文本" }).trim()
    .min(STORYBOARD_AGENT_PROMPT_MIN_LENGTH, { message: `提示词至少需要 ${STORYBOARD_AGENT_PROMPT_MIN_LENGTH} 个字符` })
    .max(STORYBOARD_AGENT_PROMPT_MAX_LENGTH, { message: `提示词最多支持 ${STORYBOARD_AGENT_PROMPT_MAX_LENGTH} 个字符，请精简后再保存` }),
});
