"use client";

import type { OutputStyle } from "@/types/coze";
import {
  configuredAgentPromptPushTarget,
  isAgentPromptPushTarget,
  isAgentPromptPushTargetConfigurationValid,
  resolveAgentPromptPushTarget,
  setAgentPromptPushTarget,
} from "@/lib/storyboard-prompt-push-capability";

export interface StoryboardPromptPushCapabilityToggleProps {
  agentId: string;
  value: OutputStyle;
  disabled?: boolean;
  onChange: (value: OutputStyle) => void;
}

/** Keep the existing editor props; persist the selected destination in output_style. */
export default function StoryboardPromptPushCapabilityToggle({ agentId, value, disabled, onChange }: StoryboardPromptPushCapabilityToggleProps) {
  const valid = isAgentPromptPushTargetConfigurationValid(value);
  const target = valid ? resolveAgentPromptPushTarget(agentId, value) : undefined;
  const inherited = valid && configuredAgentPromptPushTarget(value) === undefined;

  return (
    <section className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" aria-label="提示词推送设置">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--foreground)]">提示词推送目标</p>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
            选择聊天回复和代码块提示词要发送到的工作台。推送只导入待确认内容，不会自动生成或扣费。
          </p>
          {inherited ? <p className="mt-1 text-[10px] text-[var(--primary)]">当前沿用既有设置；选择目标并保存后，按本次选择推送。</p> : null}
        </div>
        <select
          aria-label="提示词推送目标"
          value={target || ""}
          disabled={disabled}
          onChange={(event) => {
            if (isAgentPromptPushTarget(event.target.value)) onChange(setAgentPromptPushTarget(value, event.target.value) as OutputStyle);
          }}
          className="h-9 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-xs text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {!target && <option value="" disabled>请选择有效的推送目标</option>}
          <option value="storyboard-workbench">分镜编排</option>
          <option value="video">视频创作</option>
        </select>
      </div>
      <div className={`text-[10px] ${target ? "text-[var(--muted-foreground)]" : "text-amber-700"}`} role={target ? "status" : "alert"}>
        {target === "storyboard-workbench" ? "推送至分镜编排，导入前会校验提示词内容。" : target === "video" ? "推送至视频创作，填入视频任务草稿。" : "当前推送目标无效，请重新选择后保存；系统不会自动改用其他工作台。"}
      </div>
    </section>
  );
}
