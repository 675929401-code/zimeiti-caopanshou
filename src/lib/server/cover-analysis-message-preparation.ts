import {
  assertAuthorizedCoverAnalysisWorkflow, CoverAnalysisAuthorityError,
  COVER_ANALYSIS_RUNTIME_FIELDS, type AuthorizedCoverAnalysisWorkflow,
} from "./cover-analysis-authority";
import type { ChatMessage } from "@/lib/llm-context";

export const COVER_ANALYSIS_MAX_CONTEXT_TOKENS = 65_536;
export const COVER_ANALYSIS_MAX_REPLY_TOKENS = COVER_ANALYSIS_RUNTIME_FIELDS.max_reply_tokens;
const MAX_TEXT_CODE_UNITS = 32_768;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 3;
const IMAGE_CONTEXT_ALLOWANCE = 8192;
const refuse = (message: string): never => { throw new CoverAnalysisAuthorityError("COVER_ANALYSIS_CONTEXT_INVALID", message, 422); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Shared admission for real dispatch and free compiler previews/publication. */
export function assertCoverAnalysisMessageBudget(textUnits: number, imageCount: number,
  modelLimits: { maxContextTokens?: number; maxReplyTokens?: number } = {}) {
  const limit = (value: number | undefined, ceiling: number) => value === undefined || value === 0 ? ceiling
    : Number.isSafeInteger(value) && value > 0 ? Math.min(value, ceiling) : refuse("封面分析模型上限无效");
  const contextLimit = limit(modelLimits.maxContextTokens, COVER_ANALYSIS_MAX_CONTEXT_TOKENS);
  const replyLimit = limit(modelLimits.maxReplyTokens, COVER_ANALYSIS_MAX_REPLY_TOKENS);
  if (!Number.isSafeInteger(textUnits) || textUnits < 0 || !Number.isSafeInteger(imageCount) || imageCount < 0
    || imageCount > MAX_IMAGES || textUnits > MAX_TEXT_CODE_UNITS
    || textUnits + imageCount * IMAGE_CONTEXT_ALLOWANCE + replyLimit > contextLimit) return refuse("封面分析材料超过固定上下文预算，请减少内容或图片");
  return { contextLimit, replyLimit };
}

/**
 * Dedicated cover compiler: one authorized system message and one server-built
 * material message. No marketplace context, skills, search, identity envelope,
 * truncation or change to the protected ordinary-chat composer.
 */
export function prepareCoverAnalysisMessages(authority: AuthorizedCoverAnalysisWorkflow, modelLimits: { maxContextTokens?: number; maxReplyTokens?: number } = {}) {
  assertAuthorizedCoverAnalysisWorkflow(authority);
  const systems = authority.messages.filter(message => message.role === "system");
  const users = authority.messages.filter(message => message.role === "user");
  if (authority.messages.length !== 2 || systems.length !== 1 || users.length !== 1 || systems[0].content !== authority.prompt) return refuse("封面分析消息不符合固定协议");
  let textUnits = authority.prompt.length, imageCount = 0;
  const normalizeUser = (): ChatMessage => {
    const user = users[0];
    if (typeof user.content === "string") { textUnits += user.content.length; return { role: "user", content: user.content }; }
    const parts = user.content.map(part => {
      const value = object(part);
      if (value.type === "text" && typeof value.text === "string") { textUnits += value.text.length; return { type: "text", text: value.text }; }
      if (value.type === "image_url") {
        const url = object(value.image_url).url;
        const image = typeof url === "string" ? /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url) : null;
        if (!image || Buffer.byteLength(image[1], "base64") <= 0 || Buffer.byteLength(image[1], "base64") > MAX_IMAGE_BYTES) return refuse("封面分析只接收服务器校验的有界图片");
        imageCount++;
        return { type: "image_url", image_url: { url: url as string } };
      }
      return refuse("封面分析包含不允许的消息片段");
    });
    return { role: "user", content: parts };
  };
  const user = normalizeUser();
  const { contextLimit, replyLimit } = assertCoverAnalysisMessageBudget(textUnits, imageCount, modelLimits);
  return {
    effectiveSystemPrompt: authority.prompt,
    skillInjection: null,
    finalMessages: [{ role: "system", content: authority.prompt }, user] as ChatMessage[],
    agentDeepThinkingType: 0,
    agentMaxContextRounds: 0,
    agentMaxContextTokens: contextLimit,
    agentMaxReplyTokens: replyLimit,
  };
}
