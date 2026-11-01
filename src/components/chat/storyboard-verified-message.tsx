"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/contexts/app-context";
import { MessageContent } from "@/components/chat/message-content";
import {
  buildHomepageStoryboardDraftDetail,
  readStoryboardIntakeSnapshotForMessage,
  resolveStoryboardHandoffContract,
  verifyStoryboardHandoffReferenceAssets,
} from "@/lib/agent-workbench-handoff";
import type { StructuredAgentOutputReadyDetail } from "@/lib/structured-agent-output";
import { readBrowserWorkbenchIdentity, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import type { Message, OutputStyle } from "@/types/coze";
import { buildHistoricalStoryboardMessageDraft } from "@/lib/storyboard-legacy-prompt-draft";
import { copyToClipboard } from "@/lib/utils";
import { officialStoryboardDirectorIdentity } from "@/lib/storyboard-director-identity";
import { storyboardPromptVisibleText } from "@/lib/storyboard-prompt-draft";
import { buildUnboundChatStoryboardPromptDraft } from "@/lib/chat-storyboard-prompt-draft";
import { isChatPromptDeliveryMessageReady } from "@/lib/chat-prompt-delivery-state";

export type StoryboardDraftMessage = Pick<Message, "id" | "role" | "content" | "isStreaming" | "streamStatus" | "error" | "agentId">;
export type StoryboardReplyReview = { content: string; errors: string[]; suggestions?: string[] };

function pushSuggestion(list: string[], suggestion: string) {
  if (!list.includes(suggestion)) list.push(suggestion);
}

/** Turn parser/contract findings into an action the user can take immediately. */
export function storyboardReplyReviewSuggestions(errors: string[], context?: { referenceMode?: string }): string[] {
  const suggestions: string[] = [];
  for (const rawError of errors) {
    const error = String(rawError || "");
    if (/performance_plan_requires_stable_package|performance_plan_required/u.test(error)) {
      pushSuggestion(suggestions, "当前导演合同要求稳定机器包：保留原分段，只补齐每段 performance_plan（动作、表情、节拍和连续性），不要重写整篇文案。");
      continue;
    }
    if (/performance_image_excerpt_missing|image_excerpt|performance_video_excerpt_missing|video_excerpt|peak_shot_id|shot_time_ranges|actor.*coverage|role.*mismatch/iu.test(error)) {
      pushSuggestion(suggestions, "表演计划引用不完整：image_excerpt 从同段图片 Prompt 复制包含动作或表情峰值的原文片段，video_excerpt 对应视频动作，peak_shot_id 必须来自本段 shot_time_ranges，角色覆盖必须匹配 cast 资产。");
      continue;
    }
    if (/机器 JSON|JSON 无效|JSON 未闭合|字段缺失|字段不完整|结构无效|planned_package_invalid|storyboard_director_output\.v1/u.test(error)) {
      pushSuggestion(suggestions, "输出格式不完整：每段保留原文案内容，并按“图片 Prompt 代码框 → 视频 Prompt 代码框”输出；机器 JSON 只保留一份且必须闭合。");
      continue;
    }
    if (/原接收卡|expected_input|input|source_not_preserved|source_narration|narration|分段|段落/u.test(error)) {
      pushSuggestion(suggestions, "接收卡与回复的分段或原文案不一致：保留接收卡原文、段落编号和顺序，只修复对应段，不要让模型自行改写原文案。");
      continue;
    }
    if (/visual.?asset|参考|三视图|character|pet|reference|资产/u.test(error)) {
      if (/普通模式|^(?:off|ordinary)$|visual_asset_mode.{0,12}(?:off|ordinary)/iu.test((context?.referenceMode || "").trim())) {
        pushSuggestion(suggestions, "当前是普通模式：将 visual_asset_mode 固定为 off，不要求人物或宠物三视图，也不要输出角色参考绑定。");
      } else {
        pushSuggestion(suggestions, "当前是角色参考模式：只为接收卡实际声明的人物或宠物生成三视图；逐项点击“使用这张”并保存归属后，再继续分镜图。");
      }
      continue;
    }
    pushSuggestion(suggestions, "只修复这条校验指出的字段，保留原接收卡和其他已合格段落；修复后再提交一次，不需要整篇重写。");
  }
  if (!suggestions.length) pushSuggestion(suggestions, "这是结构或链路校验，不是文案质量评分；保留原文案，只按具体原因修复对应字段后再提交。");
  return suggestions;
}

export function storyboardReplyReviewSuggestionCopyText(review: StoryboardReplyReview): string {
  const suggestions = review.suggestions?.length ? review.suggestions : storyboardReplyReviewSuggestions(review.errors);
  return ["【分镜回复修复要求】", "这不是文案质量评分，请保留原接收卡和已合格段落，只修复以下结构或链路问题：", ...suggestions.map(item => `- ${item}`)].join("\n");
}

export function storyboardReplyReviewCopyText(review: StoryboardReplyReview): string {
  const suggestions = review.suggestions?.length ? review.suggestions : storyboardReplyReviewSuggestions(review.errors);
  return ["【未通过校验的原回复，原文已保留】", "校验原因：", ...review.errors.map(error => `- ${error}`), "", "建议修复：", ...suggestions.map(item => `- ${item}`), "", "原回复：", review.content].join("\n");
}
const verificationCache = new Map<string, { expires: number; promise: Promise<StructuredAgentOutputReadyDetail> }>();
let verificationOwner = "";

/** Short-lived in-memory read sharing. It never survives an account/token change. */
export function verifyStoryboardMessageReferenceAssets(detail: StructuredAgentOutputReadyDetail, identity: WorkbenchIdentity) {
  const current = readBrowserWorkbenchIdentity();
  if (current?.userId !== identity.userId || current.token !== identity.token) return Promise.reject(new Error("账号已变化，请重新打开当前账号的回复。"));
  const owner = `${identity.userId}\0${identity.token}`;
  if (owner !== verificationOwner) { verificationCache.clear(); verificationOwner = owner; }
  for (const [key, entry] of verificationCache) if (entry.expires <= Date.now()) verificationCache.delete(key);
  const key = JSON.stringify([detail.message_id, detail.commit_key, detail.expected_input, detail.required_contract_version, detail.require_performance_plan, detail.reference_project_id, detail.legacy_input_compatibility]);
  const cached = verificationCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = verifyStoryboardHandoffReferenceAssets(detail, identity).catch(error => { verificationCache.delete(key); throw error; });
  verificationCache.set(key, { expires: Date.now() + 15_000, promise });
  return promise;
}

export function useVerifiedStoryboardMessage(message: StoryboardDraftMessage, conversationId?: string, ownerUserId?: string) {
  const { state } = useApp();
  const conversation = state.conversations.find(item => item.id === conversationId);
  const messages = conversation?.messages;
  const agentId = message.agentId || conversation?.agentId;
  const agent = state.agents.find(item => item.id === agentId || item.botId === agentId);
  const directorMode = (agent?.outputStyle as Record<string, unknown> | undefined)?.director_mode;
  const intake = useMemo(() => readStoryboardIntakeSnapshotForMessage(messages, message.id, directorMode), [messages, message.id, directorMode]);
  const contract = resolveStoryboardHandoffContract(messages, message.id, agent?.outputStyle);
  const preview = useMemo(() => !isChatPromptDeliveryMessageReady(message) || contract.error ? null : buildHomepageStoryboardDraftDetail(message, intake?.input, contract.requiredVersion, {
    previewAssetVerification: true, referenceProjectId: intake?.referenceProjectId, allowLegacyUnverified: contract.allowLegacyUnverified,
    requirePerformancePlan: contract.requirePerformancePlan, allowQualityWarnings: true,
  }), [message, intake, contract.error, contract.requiredVersion, contract.allowLegacyUnverified, contract.requirePerformancePlan]);
  const historicalDraft = useMemo(() => preview ? null : buildHistoricalStoryboardMessageDraft(message, messages, intake?.input,
    agent?.outputStyle, contract.allowLegacyUnverified === true), [preview, message, messages, intake?.input, agent?.outputStyle, contract.allowLegacyUnverified]);
  const manualDraft = useMemo(() => preview || historicalDraft ? null : buildUnboundChatStoryboardPromptDraft(
    agentId, agent?.outputStyle, message, Boolean(intake)), [preview, historicalDraft, agentId, agent?.outputStyle, message, intake]);
  // Rendering is independent of parsing, quality self-reports, and asset adoption.
  // Identity/current-message checks remain on the explicit handoff action.
  void ownerUserId;
  return { applies: false, visibleText: undefined, detail: preview || historicalDraft || manualDraft, preview, error: undefined,
    unavailableReason: message.isStreaming ? "回复正在生成，请等待完整提示词。" : "未识别到与原接收卡逐段对应的完整生图和视频提示词，请核对段落编号与提示词代码框。",
    verifying: false, intake, contract, review: null as StoryboardReplyReview | null, readCurrentReview: (): StoryboardReplyReview | null => null };
}

/** Review original bytes as escaped text without publishing a structured output event. */
export function StoryboardInvalidReplyReview({ review, readCurrentReview }: {
  review: StoryboardReplyReview; readCurrentReview: () => StoryboardReplyReview | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyOriginal = async () => {
    const current = readCurrentReview();
    if (!current) { toast.error("账号、会话或回复已变化，请重新打开当前回复。"); return; }
    const ok = await copyToClipboard(storyboardReplyReviewCopyText(current));
    setCopied(ok);
    if (ok) toast.success("已复制原回复（未通过校验，仅供审核）");
    else toast.error("复制失败，请展开原回复后手动复制。");
  };
  const copySuggestions = async () => {
    const current = readCurrentReview();
    if (!current) { toast.error("账号、会话或回复已变化，请重新打开当前回复。"); return; }
    const ok = await copyToClipboard(storyboardReplyReviewSuggestionCopyText(current));
    if (ok) toast.success("已复制修复要求，可回到原智能体只修复对应字段");
    else toast.error("复制失败，请展开审核卡后手动复制。");
  };
  return (
    <section className="my-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-[var(--foreground)]" data-testid="storyboard-invalid-reply-review" aria-label="未通过校验的回复审核">
      <p className="font-medium">回复暂不能直接推送，原文已保留</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">这是结构或资产链路校验，不是文案质量评分。普通模式可以继续编辑提示词；角色参考模式只需补齐已声明角色的三视图归属。</p>
      <ul className="my-2 list-disc space-y-1 break-words pl-5 text-xs" aria-label="具体校验原因">
        {review.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
      </ul>
      <p className="mt-2 text-xs font-medium">建议处理</p>
      <ol className="my-2 list-decimal space-y-1 break-words pl-5 text-xs" aria-label="具体修复建议">
        {(review.suggestions?.length ? review.suggestions : storyboardReplyReviewSuggestions(review.errors)).map((suggestion, index) => <li key={`${index}-${suggestion}`}>{suggestion}</li>)}
      </ol>
      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" className="rounded px-2 py-1 hover:bg-amber-500/15" aria-expanded={expanded} onClick={() => {
          if (expanded) { setExpanded(false); return; }
          if (readCurrentReview()) setExpanded(true);
          else toast.error("账号、会话或回复已变化，请重新打开当前回复。");
        }}>{expanded ? "收起原回复" : "查看原回复"}</button>
        <button type="button" className="rounded px-2 py-1 hover:bg-amber-500/15" onClick={copyOriginal}>{copied ? "已复制原回复" : "复制原回复"}</button>
        <button type="button" className="rounded px-2 py-1 font-medium hover:bg-amber-500/15" onClick={copySuggestions}>复制修复要求</button>
      </div>
      {expanded && <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--background)] p-3 text-xs" data-testid="storyboard-invalid-original-text">{review.content}</pre>}
    </section>
  );
}

/** Planned text is visible before generation; legacy reference boards retain owned readback. */
export function VerifiedStoryboardMessageContent({ message, conversationId, ownerUserId, text, outputStyle, fontSize, responseFormat, agentId }: {
  message: StoryboardDraftMessage; conversationId?: string; ownerUserId?: string; text: string; outputStyle?: OutputStyle;
  fontSize?: number; responseFormat?: string; agentId?: string;
}) {
  void conversationId; void ownerUserId;
  const direct = message.role === "assistant" && Boolean(officialStoryboardDirectorIdentity(agentId));
  return <MessageContent text={direct ? storyboardPromptVisibleText(message.content) : text}
    messageId={message.id} isUser={message.role === "user"} outputStyle={outputStyle} fontSize={fontSize}
    isStreaming={message.isStreaming} responseFormat={responseFormat} agentId={agentId} />;
}
