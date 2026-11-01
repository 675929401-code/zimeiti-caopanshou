import { z } from "zod";
import type { StoryboardCanvasImportPlan, StoryboardCanvasImportSegment } from "./storyboard-canvas-bridge";
import { StoryboardPerformancePlanSchema, validateStoryboardPerformancePlan } from "./storyboard-director-performance";

/** Director decisions travel with the card; they are not generated-media approval. */
export const StoryboardDirectorExecutionSchema = z.object({
  schemaVersion: z.literal("storyboard_director_execution.v1"),
  sourceMessageId: z.string().max(200),
  sourceCommitKey: z.string().max(300),
  segmentId: z.string().min(1).max(80),
  sourceIndex: z.number().int().positive(),
  targetDurationSeconds: z.union([z.literal(8), z.literal(10), z.literal(15)]),
  panelCount: z.union([z.literal(4), z.literal(5)]),
  layout: z.enum(["two_by_two", "four_plus_panorama"]),
  pacingMode: z.enum(["slow", "medium", "fast"]),
  actualShotCount: z.number().int().min(1).max(5),
  shotTimeRanges: z.array(z.object({
    shot_id: z.string().min(1).max(80),
    start_seconds: z.number().finite().nonnegative(),
    end_seconds: z.number().finite().positive(),
    action_beat: z.string().min(1).max(2000),
  }).strict()).min(1).max(5),
  continuityLinks: z.array(z.object({
    from_shot: z.string().min(1).max(80),
    to_shot: z.string().min(1).max(80),
    link_type: z.string().min(1).max(120),
    description: z.string().min(1).max(2000),
  }).strict()).max(12),
  semanticVisualizations: z.array(z.object({
    trigger: z.string().max(2000),
    visual_form: z.string().max(2000),
    interaction: z.string().max(2000),
  }).strict()).max(16),
  characterAssets: z.array(z.string().max(4000)).max(24),
  characterAssetIds: z.array(z.string().min(1).max(80)).max(24).optional(),
  sourceVideoPrompt: z.string().max(50000),
  performancePlan: StoryboardPerformancePlanSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.performancePlan?.cast_presence === "none"
    && (value.characterAssets.length !== 0 || !Array.isArray(value.characterAssetIds) || value.characterAssetIds.length !== 0)) {
    context.addIssue({ code: "custom", path: ["characterAssets"], message: "明确无角色的执行计划必须同时保存空身份文字与空身份ID数组" });
  }
  if (value.performancePlan) {
    for (const issue of validateStoryboardPerformancePlan(value.performancePlan, {
      shotIds: value.shotTimeRanges.map(shot => shot.shot_id), actorIds: value.characterAssetIds || [], videoPrompt: value.sourceVideoPrompt,
    })) context.addIssue({ code: "custom", path: ["performancePlan"], message: issue });
  }
  if (value.shotTimeRanges.length !== value.actualShotCount) {
    context.addIssue({ code: "custom", path: ["shotTimeRanges"], message: "镜头数量与时间线不一致" });
  }
  let end = 0;
  for (const [index, shot] of value.shotTimeRanges.entries()) {
    if (Math.abs(shot.start_seconds - end) > 0.11 || shot.end_seconds <= shot.start_seconds) {
      context.addIssue({ code: "custom", path: ["shotTimeRanges", index], message: "镜头时间线需要连续且递增" });
    }
    end = shot.end_seconds;
  }
  if (Math.abs(end - value.targetDurationSeconds) > 0.11) {
    context.addIssue({ code: "custom", path: ["targetDurationSeconds"], message: "镜头时间线未覆盖目标时长" });
  }
});

export type StoryboardDirectorExecution = z.infer<typeof StoryboardDirectorExecutionSchema>;

export function buildStoryboardDirectorExecution(plan: StoryboardCanvasImportPlan, segment: StoryboardCanvasImportSegment): StoryboardDirectorExecution {
  return StoryboardDirectorExecutionSchema.parse({
    schemaVersion: "storyboard_director_execution.v1",
    sourceMessageId: plan.messageId,
    sourceCommitKey: plan.commitKey,
    segmentId: segment.segmentId,
    sourceIndex: segment.sourceIndex,
    targetDurationSeconds: plan.settings.targetDurationSeconds,
    panelCount: segment.panelCount,
    layout: segment.layout,
    pacingMode: segment.pacingMode,
    actualShotCount: segment.actualShotCount,
    shotTimeRanges: segment.shotTimeRanges,
    continuityLinks: segment.continuityLinks,
    semanticVisualizations: segment.semanticVisualizations,
    characterAssets: segment.characterAssets,
    characterAssetIds: segment.characterAssetIds,
    sourceVideoPrompt: segment.videoPrompt,
    ...(segment.performancePlan ? { performancePlan: segment.performancePlan } : {}),
  });
}

/** Fill only an omitted execution timeline; keep an explicitly edited prompt authoritative. */
export function compileStoryboardDirectorVideoPrompt(prompt: string, execution?: StoryboardDirectorExecution): string {
  const text = prompt.trim();
  if (!execution || prompt !== execution.sourceVideoPrompt) return text;
  const hasTimeline = /\d+(?:\.\d+)?\s*(?:秒|s)?\s*(?:至|到|[-–—])\s*\d+(?:\.\d+)?\s*(?:秒|s)/iu.test(text);
  if (hasTimeline) return text;
  const timeline = execution.shotTimeRanges.map(shot => `${shot.start_seconds}-${shot.end_seconds}秒：${shot.action_beat}`).join("\n");
  const links = execution.continuityLinks.map(link => `${link.from_shot} → ${link.to_shot}：${link.description}`).join("\n");
  return [text, `实际${execution.actualShotCount}个镜头，按以下动作顺序执行：`, timeline, links ? `镜头衔接：\n${links}` : ""].filter(Boolean).join("\n");
}
