"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useApp } from "@/contexts/app-context";
import { MessageContent } from "@/components/chat/message-content";
import {
  buildHomepageStoryboardDraftDetail,
  readStoryboardIntakeSnapshotForMessage,
  resolveStoryboardHandoffContract,
  verifyStoryboardHandoffReferenceAssets,
} from "@/lib/agent-workbench-handoff";
import { parseStructuredAgentOutput, type StructuredAgentOutputReadyDetail } from "@/lib/structured-agent-output";
import { parseStoryboardCanvasImport } from "@/lib/storyboard-canvas-bridge";
import { readBrowserWorkbenchIdentity, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import type { Message, OutputStyle } from "@/types/coze";
import { buildHistoricalStoryboardMessageDraft } from "@/lib/storyboard-legacy-prompt-draft";
import { copyToClipboard } from "@/lib/utils";
import { hasStoryboardPromptPushCapability } from "@/lib/storyboard-prompt-push-capability";

export type StoryboardDraftMessage = Pick<Message, "id" | "role" | "content" | "isStreaming" | "streamStatus" | "error">;
export type StoryboardReplyReview = { content: string; errors: string[] };

export function storyboardReplyReviewCopyText(review: StoryboardReplyReview): string {
  return ["【未通过校验的原回复，仅供审核，不可作为已通过的制作计划推送】", "校验原因：", ...review.errors.map(error => `- ${error}`), "", "原回复：", review.content].join("\n");
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
  const stateRef = useRef(state); stateRef.current = state;
  const reviewOwnerRef = useRef(ownerUserId);
  const conversation = state.conversations.find(item => item.id === conversationId);
  const messages = conversation?.messages;
  const agent = state.agents.find(item => item.id === conversation?.agentId || item.botId === conversation?.agentId);
  const directorMode = (agent?.outputStyle as Record<string, unknown> | undefined)?.director_mode;
  const intake = useMemo(() => readStoryboardIntakeSnapshotForMessage(messages, message.id, directorMode), [messages, message.id, directorMode]);
  const contract = resolveStoryboardHandoffContract(messages, message.id, agent?.outputStyle);
  const parsed = useMemo(() => message.role === "assistant" ? parseStructuredAgentOutput(message.content, !message.isStreaming,
    { expectedInput: intake?.input, requirePerformancePlan: contract.requirePerformancePlan }) : null,
    [message.content, message.isStreaming, message.role, intake?.input, contract.requirePerformancePlan]);
  const machine = parsed?.status === "valid" && parsed.kind === "storyboard_director"
    ? parsed.machine_payload as unknown as Record<string, unknown> | undefined : undefined;
  const referencePlan = machine?.visual_asset_plan as { mode?: unknown } | undefined;
  const isAssets = parsed?.status === "valid" && parsed.kind === "storyboard_director" && parsed.phase === "assets";
  const isPlanned = parsed?.status === "valid" && parsed.kind === "storyboard_director" && parsed.phase === "planned";
  const performanceUnavailable = contract.requirePerformancePlan === true && !message.isStreaming && parsed?.status === "invalid";
  const referenceApplies = message.role === "assistant" && !isAssets && !isPlanned && (
    /参考|selected|reference/iu.test(intake?.input.visual_asset_mode || "") && Boolean(contract.requiredVersion || contract.error)
    || machine?.production_contract_version === "storyboard_director_contract.v2" && referencePlan?.mode === "selected"
  );
  const applies = referenceApplies || performanceUnavailable;
  const preview = useMemo(() => contract.error ? null : buildHomepageStoryboardDraftDetail(message, intake?.input, contract.requiredVersion, {
    referenceProjectId: intake?.referenceProjectId, previewAssetVerification: true, allowLegacyUnverified: contract.allowLegacyUnverified, requirePerformancePlan: contract.requirePerformancePlan,
  }), [message.id, message.content, message.role, message.isStreaming, message.streamStatus, message.error, intake, contract.error, contract.requiredVersion, contract.allowLegacyUnverified, contract.requirePerformancePlan]);
  const previewPlan = useMemo(() => preview ? parseStoryboardCanvasImport(preview, { assetVerification: "preview" }) : null, [preview]);
  const historicalDraft = useMemo(() => preview || contract.error ? null : buildHistoricalStoryboardMessageDraft(message, messages, intake?.input,
    agent?.outputStyle, contract.allowLegacyUnverified === true && !contract.requirePerformancePlan),
  [preview, contract.error, contract.allowLegacyUnverified, contract.requirePerformancePlan, message, messages, intake?.input, agent?.outputStyle]);
  const scope = JSON.stringify([ownerUserId, state.auth.token, conversationId, message.id, preview?.commit_key, intake?.input, intake?.referenceProjectId]);
  const [verification, setVerification] = useState<{ scope: string; detail?: StructuredAgentOutputReadyDetail; error?: string } | null>(null);
  const verified = verification?.scope === scope ? verification : null;
  const authenticated = Boolean(ownerUserId && state.auth.isAuthenticated && state.auth.user?.id === ownerUserId && state.auth.token);
  const hasStoryboardPromptPush = hasStoryboardPromptPushCapability(agent?.id || agent?.botId, agent?.outputStyle);
  const currentMessage = messages?.find(item => item.id === message.id);
  const review: StoryboardReplyReview | null = !message.isStreaming && parsed?.status === "invalid" && (applies || hasStoryboardPromptPush && !preview && !historicalDraft)
    && authenticated && reviewOwnerRef.current === ownerUserId && state.activeConversationId === conversationId && currentMessage?.role === "assistant"
    && currentMessage.content === message.content && !currentMessage.isStreaming
    ? { content: message.content, errors: parsed.errors.length ? parsed.errors : ["回复未通过结构校验。"] } : null;
  const readCurrentReview = (): StoryboardReplyReview | null => {
    const latest = stateRef.current;
    const identity = readBrowserWorkbenchIdentity();
    const current = latest.conversations.find(item => item.id === conversationId)?.messages.find(item => item.id === message.id);
    if (!review || !identity || !latest.auth.isAuthenticated || latest.auth.user?.id !== ownerUserId || identity.userId !== ownerUserId
      || identity.token !== state.auth.token || latest.auth.token !== state.auth.token || latest.activeConversationId !== conversationId
      || current?.role !== "assistant" || current.content !== review.content || current.isStreaming) return null;
    return review;
  };
  useEffect(() => {
    if (!applies || !preview || !previewPlan?.pendingAssetVerification || !authenticated || !ownerUserId || !state.auth.token) return;
    let active = true;
    void verifyStoryboardMessageReferenceAssets(preview, { userId: ownerUserId, token: state.auth.token }).then(detail => {
      if (active) setVerification({ scope, detail });
    }).catch(error => {
      if (active) setVerification({ scope, error: error instanceof Error ? error.message : "三视图尚未核验完成。" });
    });
    return () => { active = false; };
  }, [applies, authenticated, ownerUserId, preview, previewPlan?.pendingAssetVerification, scope, state.auth.token]);
  const error = contract.error || (performanceUnavailable ? "动作与表情结构尚未就绪，当前不可推送；原回复和结算结果保留。" : verified?.error);
  const availableDetail = performanceUnavailable ? null : referenceApplies ? verified?.detail || null : preview || historicalDraft;
  const visibleText = performanceUnavailable ? error : !applies ? undefined : verified?.detail && authenticated
    ? parseStructuredAgentOutput(message.content, true, { hostVerifiedReferenceAssets: true, expectedInput: intake?.input, requirePerformancePlan: contract.requirePerformancePlan }).visible_text
    : error || (message.isStreaming ? "正在准备参考模式输出；人物和宠物三视图完成并采用后，才显示正式分镜提示词。" : "正在核对人物与宠物的三视图。完成并采用两项参考资产后，正式分镜提示词才会显示。请使用原项目复制的续写卡。");
  const unavailableReason = parsed?.status === "incomplete" ? "回复尚未完整输出，请等待结束。"
    : parsed?.status === "invalid" ? "分段或动作表情信息不完整，当前回复尚不能作为制作计划推送。"
      : parsed?.status === "valid" && !preview ? "原接收卡、分段或备注与回复结构不一致，请核对后再推送。"
        : "当前回复缺少完整、成对的生图与视频提示词。";
  return { applies, visibleText, detail: availableDetail, preview, error, unavailableReason, verifying: applies && !availableDetail && !error, intake, contract, review, readCurrentReview };
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
  return (
    <section className="my-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-[var(--foreground)]" data-testid="storyboard-invalid-reply-review" aria-label="未通过校验的回复审核">
      <p className="font-medium">回复未通过校验，当前不可推送</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">原回复已保留。可查看或复制供人工审核；以下内容不代表已通过制作校验。</p>
      <ul className="my-2 list-disc space-y-1 break-words pl-5 text-xs" aria-label="具体校验原因">
        {review.errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}
      </ul>
      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" className="rounded px-2 py-1 hover:bg-amber-500/15" aria-expanded={expanded} onClick={() => {
          if (expanded) { setExpanded(false); return; }
          if (readCurrentReview()) setExpanded(true);
          else toast.error("账号、会话或回复已变化，请重新打开当前回复。");
        }}>{expanded ? "收起原回复" : "查看原回复（未通过校验）"}</button>
        <button type="button" className="rounded px-2 py-1 hover:bg-amber-500/15" onClick={copyOriginal}>{copied ? "已复制原回复（未通过校验）" : "复制原回复（未通过校验）"}</button>
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
  const verified = useVerifiedStoryboardMessage(message, conversationId, ownerUserId);
  if (verified.review) return <StoryboardInvalidReplyReview key={`${ownerUserId}:${conversationId}:${message.id}`} review={verified.review} readCurrentReview={verified.readCurrentReview} />;
  return <MessageContent text={verified.applies ? verified.visibleText || "三视图尚未核验完成。" : text}
    messageId={message.id} isUser={message.role === "user"} outputStyle={outputStyle} fontSize={fontSize}
    isStreaming={verified.applies ? false : message.isStreaming} responseFormat={responseFormat} agentId={agentId} />;
}
