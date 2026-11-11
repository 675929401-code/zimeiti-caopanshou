"use client";

import { Check, Copy, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { copyToClipboard } from "@/lib/utils";
import { coverAnimationBrief } from "@/lib/cover-animation-brief";
import type { CoverContentAnalysis } from "@/lib/cover-workbench-contract";
import { coverReviewPlanFromAnalysis, type CoverReviewPlan } from "@/lib/cover-review-contract";
import styles from "./cover-workbench.module.css";

export type CoverReviewDraft = CoverReviewPlan;
type MaterialUsage = NonNullable<CoverReviewDraft["materialUsage"]>[number];

/** Client-owned labels shared by the input summary and the editable plan. */
export const COVER_REVIEW_MATERIAL_ROLE_LABELS = {
  identity_subject: "保留主体外观", background_canvas: "场景背景", style_reference: "参考风格与排版",
} as const satisfies Record<MaterialUsage["role"], string>;

export function coverReviewMaterialRoleEditorId(assetId: string, imageNumber: number): string {
  return `cover-plan-material-role-${encodeURIComponent(assetId)}-${imageNumber}`;
}

/** Never project a plan role onto an asset using its array position or name. */
export function coverReviewedMaterialUsage(asset: { assetId?: string; imageNumber?: number }, draft: CoverReviewDraft | null | undefined): MaterialUsage | undefined {
  if (!asset.assetId || !Number.isInteger(asset.imageNumber)) return undefined;
  const matches = draft?.materialUsage?.filter(item => item.assetId === asset.assetId && item.imageNumber === asset.imageNumber);
  return matches?.length === 1 ? matches[0] : undefined;
}

export function reviewDraftFromAnalysis(analysis: CoverContentAnalysis): CoverReviewDraft {
  return coverReviewPlanFromAnalysis(analysis);
}

export function CoverPlanReview({ analysis, draft, disabled, onChange, onReset, onGenerate, canGenerate, feeText, error, generating, confirmed, editableMaterialRoles, animationBrief }: {
  analysis: CoverContentAnalysis; draft: CoverReviewDraft; disabled: boolean; onChange: (draft: CoverReviewDraft) => void;
  onReset: () => void; onGenerate: () => void; canGenerate: boolean; feeText: string; error: string; generating: boolean; confirmed: boolean; editableMaterialRoles: boolean;
  animationBrief?: { style: string; ratio: string };
}) {
  const [copyResult, setCopyResult] = useState({ text: "", ok: false });
  const brief = animationBrief ? coverAnimationBrief(draft, animationBrief.style, animationBrief.ratio) : "";
  const visual = (field: keyof CoverReviewDraft["visualBrief"], value: string) => onChange({ ...draft, visualBrief: { ...draft.visualBrief, [field]: value } });
  const breakdown = (field: "summary" | "logic" | "coverFocus", value: string) => {
    if (draft.contentBreakdown) onChange({ ...draft, contentBreakdown: { ...draft.contentBreakdown, [field]: value } });
  };
  return <section className={styles.reviewPanel} aria-label="确认封面方案">
    <div className={styles.reviewIntro}><div><strong><Check size={15} />{confirmed ? "已确认方案" : "拆解完成，请确认方案"}</strong>
      <p>{confirmed ? "这份方案已固定。生成和恢复均使用此版本。" : "可直接修改下方内容。确认生成前，不会提交图片任务。"}</p></div>
      <button type="button" disabled={disabled || confirmed} onClick={onReset}><RotateCcw size={13} />恢复拆解结果</button></div>
    <div className={styles.reviewFields}>
      <label className={styles.reviewLabel}>封面标题<textarea aria-label="方案封面标题" rows={2} maxLength={80} disabled={disabled || confirmed} value={draft.primaryTitle}
        onChange={event => onChange({ ...draft, primaryTitle: event.target.value })} /></label>
      <div className={styles.reviewCandidates} aria-label="标题候选">{analysis.titleCandidates.map(item => <button key={item.id} type="button" disabled={disabled || confirmed}
        data-workbench-control="choice" aria-pressed={draft.primaryTitle === item.text} onClick={() => onChange({ ...draft, primaryTitle: item.text })}>{item.text}</button>)}</div>
      <label className={styles.reviewLabel}>副标题（可选）<input aria-label="方案副标题" maxLength={120} disabled={disabled || confirmed} value={draft.secondaryTitle || ""}
        onChange={event => onChange({ ...draft, secondaryTitle: event.target.value || null })} /></label>
      {draft.contentBreakdown && <label className={styles.reviewLabel}>封面切入点<textarea aria-label="方案封面切入点" rows={2} maxLength={600} disabled={disabled || confirmed}
        value={draft.contentBreakdown.coverFocus} onChange={event => breakdown("coverFocus", event.target.value)} /></label>}
      {brief && <details className={styles.reviewDetails}><summary>生图提示词</summary>
        <p className={styles.sceneBrief}>{brief}</p>
        <button type="button" className={styles.textButton} onClick={async () => setCopyResult({ text: brief, ok: await copyToClipboard(brief) })}>
          <Copy size={14} />复制生图提示词
        </button>
        <span role="status" className={styles.small}>{copyResult.text === brief ? copyResult.ok ? "已复制" : "复制失败，可选中文字复制。" : ""}</span>
      </details>}
      <div className={styles.reviewGrid}>
        <label className={styles.reviewLabel}>画面主体<textarea aria-label="方案画面主体" rows={2} maxLength={500} disabled={disabled || confirmed} value={draft.visualBrief.subject} onChange={event => visual("subject", event.target.value)} /></label>
        <label className={styles.reviewLabel}>场景环境<textarea aria-label="方案场景环境" rows={2} maxLength={500} disabled={disabled || confirmed} value={draft.visualBrief.scene} onChange={event => visual("scene", event.target.value)} /></label>
      </div>
      <label className={styles.reviewLabel}>动作与画面关系<textarea aria-label="方案动作与画面关系" rows={3} maxLength={500} disabled={disabled || confirmed} value={draft.visualBrief.action} onChange={event => visual("action", event.target.value)} /></label>
      <label className={styles.reviewLabel}>情绪表达<input aria-label="方案情绪表达" maxLength={300} disabled={disabled || confirmed} value={draft.visualBrief.emotion} onChange={event => visual("emotion", event.target.value)} /></label>
      {draft.layoutIntent && <div className={styles.reviewGrid}>
        <label className={styles.reviewLabel}>构图结构<select aria-label="方案构图结构" disabled={disabled || confirmed} value={draft.layoutIntent.structure} onChange={event => onChange({ ...draft, layoutIntent: { ...draft.layoutIntent!, structure: event.target.value as NonNullable<CoverReviewDraft["layoutIntent"]>["structure"] } })}>
          <option value="single">单一主体</option><option value="relationship">主体关系</option><option value="comparison">对比呈现</option><option value="list">要点呈现</option></select></label>
        <label className={styles.reviewLabel}>视觉重点<select aria-label="方案视觉重点" disabled={disabled || confirmed} value={draft.layoutIntent.focus} onChange={event => onChange({ ...draft, layoutIntent: { ...draft.layoutIntent!, focus: event.target.value as NonNullable<CoverReviewDraft["layoutIntent"]>["focus"] } })}>
          <option value="expression">表情</option><option value="action">动作</option><option value="object">物品</option></select></label>
      </div>}
      {Boolean(draft.materialUsage?.length) && <div id="cover-plan-material-roles" role="group" aria-label="方案图片用途" className={styles.reviewGrid}>
        {draft.materialUsage!.map((item, index) => <label key={item.assetId} htmlFor={coverReviewMaterialRoleEditorId(item.assetId, item.imageNumber)} className={styles.reviewLabel}>@图{item.imageNumber} 的用途
          <select id={coverReviewMaterialRoleEditorId(item.assetId, item.imageNumber)} aria-label={`方案图${item.imageNumber}用途`} value={item.role} disabled={disabled || confirmed || !editableMaterialRoles} onChange={event => onChange({ ...draft,
            materialUsage: draft.materialUsage!.map((entry, offset) => index === offset ? { ...entry, role: event.target.value as typeof item.role } : entry) })}>
            {Object.entries(COVER_REVIEW_MATERIAL_ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
          </select></label>)}
      </div>}
      {Boolean(draft.materialUsage?.length) && !editableMaterialRoles && <p className={styles.small}>当前模式保留图片用途。如需把人物、商品和场景重新组合，请使用商品封面的智能合成模式。</p>}
      <details className={styles.reviewDetails}><summary>内容摘要、重点与原文依据</summary>
        <label className={styles.reviewLabel}>内容主题<textarea aria-label="方案内容主题" rows={2} maxLength={500} disabled={disabled || confirmed} value={draft.topic} onChange={event => onChange({ ...draft, topic: event.target.value })} /></label>
        {draft.contentBreakdown && <>
          <label className={styles.reviewLabel}>文案摘要<textarea aria-label="方案文案摘要" rows={3} maxLength={600} disabled={disabled || confirmed} value={draft.contentBreakdown.summary} onChange={event => breakdown("summary", event.target.value)} /></label>
          {draft.contentBreakdown.keyPoints.map((point, index) => <label key={index} className={styles.reviewLabel}>内容重点 {index + 1}<textarea rows={2} maxLength={600} disabled={disabled || confirmed} value={point} onChange={event => onChange({ ...draft, contentBreakdown: { ...draft.contentBreakdown!, keyPoints: draft.contentBreakdown!.keyPoints.map((entry, offset) => offset === index ? event.target.value : entry) } })} /></label>)}
          <label className={styles.reviewLabel}>内容逻辑<textarea aria-label="方案内容逻辑" rows={3} maxLength={600} disabled={disabled || confirmed} value={draft.contentBreakdown.logic} onChange={event => breakdown("logic", event.target.value)} /></label>
        </>}
        <div className={styles.reviewEvidence}><strong>原分析依据</strong>{analysis.evidence.map(item => <blockquote key={item.id}>{item.quote}</blockquote>)}<p>修改会记录为你的调整，原分析依据继续保留。</p></div>
      </details>
    </div>
    <footer className={styles.reviewFooter}><div><strong>{feeText}</strong><p>原分析不重复计费。确认后按当前方案制作并保存。</p></div>
      {error && <p className={styles.inlineError} role="status">{error}</p>}
      <button type="button" data-workbench-action="primary" className={styles.primary} disabled={!canGenerate || disabled} onClick={onGenerate}><Sparkles size={16} />{generating ? "正在制作封面…" : confirmed ? "继续已确认的生成" : "确认方案并生成封面"}</button>
    </footer>
  </section>;
}
