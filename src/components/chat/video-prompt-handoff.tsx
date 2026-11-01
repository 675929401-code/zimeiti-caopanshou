"use client";

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Film } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/contexts/app-context';
import { readBrowserWorkbenchIdentity } from '@/lib/workbench-user-storage';
import { resolveAgentPromptPushTarget } from '@/lib/storyboard-prompt-push-capability';
import { buildChatVideoPromptTransfer } from '@/lib/chat-video-prompt-transfer';
import { dispatchVideoTaskTransfer } from '@/lib/video-task-transfer';
import { isChatPromptDeliveryMessageReady } from '@/lib/chat-prompt-delivery-state';
import type { Message } from '@/types/coze';

export interface VideoPromptHandoffHandle { send(codeBlockIndex?: number, expectedCodeText?: string): void }
type DraftMessage = Pick<Message, 'id' | 'role' | 'content' | 'isStreaming' | 'error' | 'streamStatus'>;

export const VideoPromptHandoff = forwardRef<VideoPromptHandoffHandle, {
  message: DraftMessage; conversationId?: string; ownerUserId?: string;
}>(function VideoPromptHandoff({ message, conversationId, ownerUserId }, ref) {
  const { state } = useApp();
  const latest = useRef(state); latest.current = state;
  const dispatched = useRef(false);
  const send = (codeBlockIndex?: number, expectedCodeText?: string) => {
    if (dispatched.current) return;
    const currentState = latest.current;
    const identity = readBrowserWorkbenchIdentity();
    const conversation = currentState.conversations.find(item => item.id === conversationId);
    const current = conversation?.messages.find(item => item.id === message.id);
    const agentId = current?.agentId || conversation?.agentId;
    const agent = currentState.agents.find(item => item.id === agentId || item.botId === agentId);
    if (!ownerUserId || !conversationId || !identity || identity.userId !== ownerUserId
      || !currentState.auth.isAuthenticated || currentState.auth.user?.id !== ownerUserId
      || currentState.activeConversationId !== conversationId || !current || current.role !== 'assistant'
      || !isChatPromptDeliveryMessageReady(current) || current.content !== message.content) {
      toast.error('账号、会话或回复已变化，请重新打开当前完整回复后推送。'); return;
    }
    if (!agent || resolveAgentPromptPushTarget(agentId, agent.outputStyle) !== 'video') {
      toast.error('智能体推送目标已变化，请刷新当前回复后操作。'); return;
    }
    try {
      const payload = buildChatVideoPromptTransfer(current.content, codeBlockIndex, expectedCodeText);
      if (!payload) { toast.info('没有识别到当前选中范围的视频提示词，请核对视频提示词标题。'); return; }
      if (!dispatchVideoTaskTransfer({ ...payload, ownerUserId })) {
        toast.error('草稿交接未能写入，未跳转，请稍后重试。'); return;
      }
      dispatched.current = true;
      toast.success(`已推送 ${payload.items.length} 条视频提示词草稿`);
      window.location.assign('/video');
    } catch (error) { toast.error(error instanceof Error ? error.message : '推送失败，请手动复制提示词。'); }
  };
  useImperativeHandle(ref, () => ({ send }));
  return <button type="button" onClick={() => send()}
    className="chat-message-action inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
    title="将当前回复的视频提示词作为草稿推送至视频创作" aria-label="推送回复至视频创作">
    <Film className="h-3.5 w-3.5" /><span className="text-[11px]">视频创作</span>
  </button>;
});
