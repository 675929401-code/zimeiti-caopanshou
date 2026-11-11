import type { CoverReviewPlan } from "./cover-review-contract";

/** Public, editable scene description shared by the review screen and image order.
 * Includes only the user's plan, never private style instructions or source IDs. */
export function coverAnimationBrief(plan: CoverReviewPlan, styleName: string, ratio: string): string {
  const { subject, action, scene, emotion } = plan.visualBrief;
  const structure = { single: "单一主体", relationship: "主体关系", comparison: "对比", list: "分组" };
  const focus = { expression: "表情", action: "动作", object: "物件" };
  const layout = plan.layoutIntent;
  return [
    `创作一张 ${ratio} 的皮克斯式原创 3D 动画封面，采用「${styleName}」风格。`,
    plan.contentBreakdown?.coverFocus && `画面切入点：${plan.contentBreakdown.coverFocus}`,
    `主体：${subject}；场景：${scene}。`,
    `定格动作：${action}。用姿态和视线传达「${emotion}」。`,
    layout && `构图：${structure[layout.structure]}，视觉重点是${focus[layout.focus]}。`,
    `标题逐字绘制：「${plan.primaryTitle}」${plan.secondaryTitle ? `，副标题「${plan.secondaryTitle}」` : ""}。`,
  ].filter(Boolean).join("\n");
}
