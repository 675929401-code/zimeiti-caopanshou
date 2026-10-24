"use client";

import type { OutputStyle } from "@/types/coze";
import {
  configuredStoryboardPromptPushCapability,
  hasStoryboardPromptPushCapability,
  setStoryboardPromptPushCapability,
} from "@/lib/storyboard-prompt-push-capability";

export interface StoryboardPromptPushCapabilityToggleProps {
  agentId: string;
  value: OutputStyle;
  disabled?: boolean;
  onChange: (value: OutputStyle) => void;
}

/** Admin control for the capability that drives automatic storyboard handoff discovery. */
export default function StoryboardPromptPushCapabilityToggle({ agentId, value, disabled, onChange }: StoryboardPromptPushCapabilityToggleProps) {
  const configured = configuredStoryboardPromptPushCapability(value);
  const enabled = hasStoryboardPromptPushCapability(agentId, value);
  const defaultEnabled = configured === undefined && enabled;

  return (
    <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" aria-label="推送分镜提示词能力">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--foreground)]">推送分镜提示词</p>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
            开启后，系统会自动识别该智能体回复中的稳定分镜协议，并在聊天操作栏显示“推送至分镜工作台”图标。未开启的智能体不会显示该入口。
          </p>
          {defaultEnabled ? <p className="mt-1 text-[10px] text-[var(--primary)]">当前沿用官方故事版导演的默认开启状态。</p> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="推送分镜提示词"
          disabled={disabled}
          onClick={() => onChange(setStoryboardPromptPushCapability(value, !enabled) as OutputStyle)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-[var(--primary)]" : "bg-[var(--border)]"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>
      <div className="text-[10px] text-[var(--muted-foreground)]" role="status">
        {enabled ? "已启用：符合协议的回复会自动显示分镜推送入口。" : "未启用：当前智能体只保留普通回复操作。"}
      </div>
    </section>
  );
}
