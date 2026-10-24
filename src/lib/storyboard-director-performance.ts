import { z } from "zod";

export const STORYBOARD_PERFORMANCE_CONTRACT_VERSION = "storyboard_performance.v1" as const;
export const STORYBOARD_PERFORMANCE_MODES = ["action_peak", "reaction_peak", "reveal_peak", "tension_hold"] as const;
export const STORYBOARD_PERFORMANCE_MODE_LABELS: Record<typeof STORYBOARD_PERFORMANCE_MODES[number], string> = {
  action_peak: "动作峰值", reaction_peak: "反应峰值", reveal_peak: "揭示峰值", tension_hold: "悬念停留",
};

export function storyboardPerformanceActivationTime(value: unknown): number | undefined {
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  if (!parsed.success) return undefined;
  const time = Date.parse(parsed.data);
  return Number.isFinite(time) ? time : undefined;
}

const labels = new Set(["setup", "drive", "contact", "feedback", "settle", "trigger", "before", "peak", "release", "endstate",
  "同上", "待补充", "未填写", "未提供", "无", "不适用", "na", "动作", "表情", "起点", "终点"]);
const comparable = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const clause = z.string().trim().min(4).max(360).refine(value => {
  const core = comparable(value);
  return core.length >= 2 && new Set(core).size > 1 && !labels.has(core);
}, "需要具体可见的短句，不能使用空白或字段标签占位");
const actorId = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u);

/** A declared performance plan is structure evidence, never an artistic score. */
export const StoryboardPerformancePlanSchema = z.object({
  schema_version: z.literal(STORYBOARD_PERFORMANCE_CONTRACT_VERSION),
  mode: z.enum(STORYBOARD_PERFORMANCE_MODES),
  peak_shot_id: z.string().trim().min(1).max(80),
  semantic_event: clause,
  action_chain: z.object({ setup: clause, drive: clause, contact: clause, feedback: clause, settle: clause }).strict(),
  expressions: z.array(z.object({
    actor_asset_id: actorId,
    actor_role: z.enum(["character", "pet"]),
    trigger: clause,
    before: clause,
    peak: clause,
    release: clause,
  }).strict()).min(1).max(24),
  image_excerpt: z.string().trim().min(20).max(6000),
  video_excerpt: z.string().trim().min(40).max(12000),
  end_state: clause,
}).strict().superRefine((plan, context) => {
  if (new Set(Object.values(plan.action_chain).map(comparable)).size === 1) {
    context.addIssue({ code: "custom", path: ["action_chain"], message: "动作链不能重复同一句占位" });
  }
  const actorIds = plan.expressions.map(expression => expression.actor_asset_id);
  if (new Set(actorIds).size !== actorIds.length) context.addIssue({ code: "custom", path: ["expressions"], message: "每个角色只能有一条主峰表情机制" });
  for (const [index, expression] of plan.expressions.entries()) {
    if (new Set([expression.before, expression.peak, expression.release].map(comparable)).size === 1) {
      context.addIssue({ code: "custom", path: ["expressions", index], message: "表情变化不能重复同一句占位" });
    }
    if (!plan.image_excerpt.includes(expression.peak)) context.addIssue({ code: "custom", path: ["image_excerpt"], message: "图片节选须包含每个角色的表情峰值" });
    if ([expression.trigger, expression.before, expression.peak, expression.release].some(value => !plan.video_excerpt.includes(value))) {
      context.addIssue({ code: "custom", path: ["video_excerpt"], message: "视频节选须包含完整表情触发、起点、峰值与回落" });
    }
  }
  if (Object.values(plan.action_chain).some(value => !plan.video_excerpt.includes(value))) {
    context.addIssue({ code: "custom", path: ["video_excerpt"], message: "视频节选须包含完整动作链" });
  }
  if (!plan.video_excerpt.includes(plan.end_state)) context.addIssue({ code: "custom", path: ["end_state"], message: "结束状态须锚定在视频节选中" });
});

export type StoryboardPerformancePlan = z.infer<typeof StoryboardPerformancePlanSchema>;
export type StoryboardPerformanceContext = {
  shotIds: readonly string[];
  actorIds: readonly string[];
  /** Only an independently declared reference plan supplies mechanically checkable roles. */
  referenceRoles?: ReadonlyMap<string, string>;
  imagePrompt?: string;
  videoPrompt: string;
};

/** Checks references and exact authored text only; it does not judge acting quality. */
export function validateStoryboardPerformancePlan(value: unknown, context: StoryboardPerformanceContext): string[] {
  const parsed = StoryboardPerformancePlanSchema.safeParse(value);
  if (!parsed.success) return ["performance_plan_invalid"];
  const plan = parsed.data;
  const issues: string[] = [];
  if (!context.shotIds.includes(plan.peak_shot_id)) issues.push("performance_peak_shot_unknown");
  const expressionIds = plan.expressions.map(expression => expression.actor_asset_id);
  if (new Set(context.actorIds).size !== context.actorIds.length || expressionIds.length !== context.actorIds.length
    || expressionIds.some(id => !context.actorIds.includes(id)) || context.actorIds.some(id => !expressionIds.includes(id))) {
    issues.push("performance_expression_actor_coverage_mismatch");
  }
  if (context.referenceRoles && plan.expressions.some(expression => context.referenceRoles!.get(expression.actor_asset_id) !== expression.actor_role)) {
    issues.push("performance_expression_role_mismatch");
  }
  if (context.imagePrompt !== undefined && !context.imagePrompt.includes(plan.image_excerpt)) issues.push("performance_image_excerpt_missing");
  if (!context.videoPrompt.includes(plan.video_excerpt)) issues.push("performance_video_excerpt_missing");
  return issues;
}
