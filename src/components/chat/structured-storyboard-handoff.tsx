"use client";

import { useRef, useState } from "react";

import { LayoutGrid } from "lucide-react";
import { useApp } from "@/contexts/app-context";
import {
  buildHomepageStoryboardDraftDetail,
  readStoryboardIntakeSnapshotForMessage,
  resolveStoryboardHandoffContract,
  saveAgentWorkbenchHandoffForNewWindow,
} from "@/lib/agent-workbench-handoff";
import { readBrowserWorkbenchIdentity } from "@/lib/workbench-user-storage";
import type { Message } from "@/types/coze";
import { buildHistoricalStoryboardMessageDraft } from "@/lib/storyboard-legacy-prompt-draft";
import { useVerifiedStoryboardMessage, verifyStoryboardMessageReferenceAssets } from "./storyboard-verified-message";
import styles from "./structured-storyboard-handoff.module.css";

type DraftMessage = Pick<Message, "id" | "role" | "content" | "isStreaming" | "streamStatus" | "error">;

export function StructuredStoryboardHandoff({ message, conversationId, ownerUserId, required = false, variant = "button" }: {
  message: DraftMessage;
  conversationId?: string;
  ownerUserId?: string;
  required?: boolean;
  variant?: "button" | "icon";
}) {
  const { state } = useApp();

  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stateRef = useRef(state); stateRef.current = state;
  const verified = useVerifiedStoryboardMessage(message, conversationId, ownerUserId);
  const detail = verified.detail;
  const unavailable = message.isStreaming
    ? "回复正在生成，请等待完整分镜包。"
    : busy ? "正在核对三视图并交接。" : verified.error ? verified.error : verified.verifying ? "正在核对已采用的三视图。" : !detail
      ? verified.unavailableReason
      : !conversationId || !ownerUserId || !state.auth.isAuthenticated || state.auth.user?.id !== ownerUserId
        ? "账号或会话未就绪，请重新打开当前账号的回复。"
        : "";
  if (!required && unavailable) return null;

  const handleImport = async () => {
    if (busyRef.current || unavailable || !detail || !ownerUserId || !conversationId) {
      setNotice(unavailable || "当前分镜包不可用。");
      return;
    }
    // Re-read current original bytes and owner on click; rendered eligibility is not authority.
    const identity = readBrowserWorkbenchIdentity();
    const conversation = state.conversations.find(item => item.id === conversationId);
    const current = conversation?.messages.find(item => item.id === message.id);
    const agent = state.agents.find(item => item.id === conversation?.agentId || item.botId === conversation?.agentId);
    const directorMode = (agent?.outputStyle as Record<string, unknown> | undefined)?.director_mode;
    if (!state.auth.isAuthenticated || state.auth.user?.id !== ownerUserId
      || identity?.userId !== ownerUserId || state.activeConversationId !== conversationId) {
      setNotice("账号或会话已变化，请重新打开当前账号的回复后操作。");
      return;
    }
    const currentContract = resolveStoryboardHandoffContract(conversation?.messages, message.id, agent?.outputStyle);
    const intake = readStoryboardIntakeSnapshotForMessage(conversation?.messages, message.id, directorMode);
    const currentDetail = current && !currentContract.error && (buildHomepageStoryboardDraftDetail(current, intake?.input, currentContract.requiredVersion,
      { previewAssetVerification: true, referenceProjectId: intake?.referenceProjectId, allowLegacyUnverified: currentContract.allowLegacyUnverified, requirePerformancePlan: currentContract.requirePerformancePlan })
      || buildHistoricalStoryboardMessageDraft(current, conversation?.messages, intake?.input, agent?.outputStyle,
        currentContract.allowLegacyUnverified === true && !currentContract.requirePerformancePlan));
    if (!currentDetail || currentDetail.commit_key !== detail.commit_key || current?.content !== message.content) {
      setNotice("回复内容或状态已变化，请重新检查当前消息的完整分镜包。");
      return;
    }
    // noopener in the feature string returns null even when a tab opens.
    // Open a same-origin blank first, sever its opener, then navigate so actual
    // popup blocking can be distinguished without reporting false failures.
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
      setNotice("浏览器拦截了新窗口，请允许弹出窗口后重试。");
      return;
    }
    opened.opener = null;
    busyRef.current = true; setBusy(true);
    try {
      const ready = await verifyStoryboardMessageReferenceAssets(currentDetail, identity);
      const latest = stateRef.current;
      const latestMessage = latest.conversations.find(item => item.id === conversationId)?.messages.find(item => item.id === message.id);
      if (latest.activeConversationId !== conversationId || latest.auth.user?.id !== ownerUserId || latestMessage?.content !== current.content
        || readBrowserWorkbenchIdentity()?.token !== identity.token) throw new Error("账号、会话或回复已变化，请重新确认后操作。");
      const handoff = saveAgentWorkbenchHandoffForNewWindow(ready, "storyboard-workbench", "/");
      if (!handoff) throw new Error("草稿交接未能写入浏览器会话，已停止跳转。未生成、未扣费。");
      opened.location.replace(`/storyboard-workbench?entry=agent&handoff=storyboard&autoImport=1&handoffId=${encodeURIComponent(handoff.handoff_id)}`);
    } catch (error) {
      opened.close();
      setNotice(error instanceof Error ? error.message : "三视图核验或交接失败，请稍后重试。");
    } finally { busyRef.current = false; setBusy(false); }
  };

  if (variant === "icon") return (
    <span className="inline-flex items-center gap-1" data-testid="chat-storyboard-film-handoff">
      <button type="button" onClick={handleImport} disabled={Boolean(unavailable)}
        className="chat-message-action p-1 rounded-md text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title={unavailable || (detail?.phase === "draft" ? "作为历史草稿推送；请在工作台核对原备注与分段" : "推送至分镜工作台")} aria-label={detail?.phase === "draft" ? "作为历史草稿推送" : "推送至分镜工作台"}>
        <LayoutGrid className="w-3.5 h-3.5" />
      </button>
      {notice && <span className={styles.notice} role="status">{notice}</span>}
    </span>
  );

  return (
    <div className={styles.handoff} data-testid="chat-storyboard-draft-handoff">
      <button type="button" className={styles.action} onClick={handleImport} disabled={Boolean(unavailable)} title={unavailable || undefined}>{detail?.phase === "draft" ? "作为历史草稿推送" : "推送至分镜工作台"}</button>
      <p className={styles.notice}>{unavailable || (detail?.phase === "draft" ? "旧回复未通过当前导演合同。可将完整双提示词作为草稿导入，保留原接收卡和备注；核对后逐项生成。" : detail?.phase === "planned" ? "一次导入角色与全部分镜提示词；在工作台确认角色图片后继续制作。导入不生成、不扣费。" : "将当前消息的完整分镜包导入工作台，不生成、不扣费。")}</p>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </div>
  );
}
