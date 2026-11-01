"use client";

import type { ModelCandidateReceipt } from "./model-candidate-receipt";

export interface ModelCandidateNoticeState {
  kind: "staged" | "unknown" | "rejected";
  message: string;
  receipt?: ModelCandidateReceipt;
}

export default function ModelCandidateNotice({ state, onReview, onAcknowledge }: {
  state: ModelCandidateNoticeState | null;
  onReview: () => void;
  onAcknowledge: () => void;
}) {
  return <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3" data-testid="model-onboarding-progress">
    <details open={Boolean(state)} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--primary)]">
        <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m7 4 6 6-6 6" /></svg>
        <h4 className="text-sm font-semibold">模型接入顺序</h4>
        <span className="ml-auto text-xs text-[var(--muted-foreground)]">发布、真实验收与工作台分配</span>
      </summary>
      <p className="mt-2 text-xs leading-6 text-[var(--muted-foreground)]">保存候选 → 校验与差异预览 → 发布模型池 → 真实验证与启用 → 工作台分配及普通用户使用验证</p>
      <p className="text-xs leading-5 text-[var(--muted-foreground)]">保存不会直接对用户开放。每个候选独立保存，请核对本次变更，不要直接发布其他待审候选。</p>
    </details>
    {state && <div className={`mt-3 rounded-lg border p-3 text-sm ${state.kind === "staged" ? "border-emerald-500/25 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`} role={state.kind === "staged" ? "status" : "alert"} data-testid="model-candidate-save-result" data-result={state.kind}>
      <p className="font-medium">{state.message}</p>
      {state.receipt && <p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">本次候选：{state.receipt.version ? `v${state.receipt.version} · ` : ""}{state.receipt.id}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onReview} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--accent)]">{state.receipt ? "查看本次候选" : "刷新候选列表"}</button>
        {state.kind === "unknown" && <button type="button" onClick={onAcknowledge} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--accent)]">已核对结果，继续编辑</button>}
      </div>
    </div>}
  </section>;
}
