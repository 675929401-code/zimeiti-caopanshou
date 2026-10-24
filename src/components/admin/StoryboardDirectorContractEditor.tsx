"use client";

import { useState } from "react";
import type { OutputStyle } from "@/types/coze";
import { canActivateStoryboardDirectorContracts, canRollbackStoryboardDirectorContracts, createStoryboardDirectorContractDraft, hasActivatedStoryboardDirectorContract, STORYBOARD_DIRECTOR_CONTRACT_FIELDS } from "@/lib/storyboard-director-contract-activation";
import { hasStoryboardNarrativeRuntimeContract, officialStoryboardDirectorIdentity } from "@/lib/storyboard-director-identity";

export interface StoryboardDirectorContractEditorProps {
  agentId: string;
  prompt: string;
  value: OutputStyle;
  disabled?: boolean;
  onChange: (value: OutputStyle) => void;
  onRollback?: () => void;
}

const labels: Record<typeof STORYBOARD_DIRECTOR_CONTRACT_FIELDS[number], string> = {
  production_contract_version: "制作合同版本",
  production_contract_activated_at: "制作合同激活时间",
  performance_contract: "表演合同版本",
  performance_contract_activated_at: "表演合同激活时间",
};

function contractSignature(value: unknown): string {
  const style = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return JSON.stringify(STORYBOARD_DIRECTOR_CONTRACT_FIELDS.map(key => style[key] ?? null));
}

/** The editor only creates an explicit draft. The parent form owns its normal save action. */
export default function StoryboardDirectorContractEditor({ agentId, prompt, value, disabled, onChange, onRollback }: StoryboardDirectorContractEditorProps) {
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [error, setError] = useState("");
  const supportsActivation = canActivateStoryboardDirectorContracts(agentId, prompt);
  const activated = hasActivatedStoryboardDirectorContract(value);
  if (!officialStoryboardDirectorIdentity(agentId) || (!supportsActivation && !activated)) return null;
  const style = value as Record<string, unknown>;
  const enabled = hasStoryboardNarrativeRuntimeContract(value);
  const pending = enabled && pendingSignature === `${agentId}\0${contractSignature(value)}`;
  const supportsRollback = canRollbackStoryboardDirectorContracts(agentId, prompt);
  const activate = () => {
    if (disabled || enabled || !supportsActivation) return;
    try {
      const next = createStoryboardDirectorContractDraft({ agentId, prompt, value });
      setPendingSignature(`${agentId}\0${contractSignature(next)}`);
      setError("");
      onChange(next as OutputStyle);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "制作合同暂时无法启用。");
    }
  };
  const rollback = () => {
    if (disabled || !activated || !supportsRollback || !onRollback) return;
    const next = { ...style };
    for (const key of STORYBOARD_DIRECTOR_CONTRACT_FIELDS) delete next[key];
    setPendingSignature(null);
    setError("");
    onChange(next as OutputStyle);
    onRollback();
  };
  return (
    <section className="rounded-xl border border-border bg-muted/30 p-4 space-y-3" aria-label="导演制作合同">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">导演制作合同</h3>
          <p className="mt-1 text-xs text-muted-foreground">显式启用完整制作计划与表演检查；点击后随本页保存生效。</p>
        </div>
        <span className="shrink-0 text-xs font-medium text-muted-foreground" role="status">{pending ? "已启用 · 待保存" : enabled ? "已启用" : activated ? "部分启用" : "未启用"}</span>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-xs lg:grid-cols-2">
        {STORYBOARD_DIRECTOR_CONTRACT_FIELDS.map(key => (
          <div key={key} className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
            <dt className="text-muted-foreground">{labels[key]}</dt>
            <dd className="mt-1 break-words font-mono text-foreground">{typeof style[key] === "string" ? style[key] as string : "未启用"}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">已有激活时间保持不变；首次启用的时间以服务端实际保存时间为准。历史消息仍按各自的合同激活时间判断。</p>
      <button type="button" onClick={activate} disabled={disabled || enabled || !supportsActivation} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
        {enabled ? pending ? "待保存生效" : "制作与表演合同已启用" : "启用制作与表演合同"}
      </button>
      {activated && onRollback ? (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs leading-relaxed text-muted-foreground">恢复旧版时，先将上方提示词替换为原旧稿，再点击此按钮。保存会同时恢复旧提示词并移除四项新合同字段。</p>
          <button type="button" onClick={rollback} disabled={disabled || !supportsRollback} className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50">恢复旧版合同</button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </section>
  );
}
