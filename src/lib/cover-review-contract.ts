import { z } from "zod";
import type { CoverContentAnalysis } from "./cover-workbench-contract";
import type { CoverCompositionPlan } from "./cover-composition";

export const COVER_REVIEW_WORKFLOW_VERSION = 3 as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const title = text(80).refine(value => value.split(/\r?\n/u).length <= 3, "标题最多三行");
export class CoverReviewTitleError extends Error {
  readonly code = "COVER_TITLE_LINE_LIMIT";
  constructor() { super("封面标题最多使用两行，请先精简标题或调整换行；原分析和已保存作品保留不变"); this.name = "CoverReviewTitleError"; }
}
function assertNewReviewTitle(value: unknown) {
  if (typeof value === "string" && value.split(/\r?\n/u).length > 2) throw new CoverReviewTitleError();
  return value;
}
const material = z.object({ assetId: z.string().uuid(), imageNumber: z.number().int().positive(),
  role: z.enum(["identity_subject", "background_canvas", "style_reference"]) }).strict();
const brief = z.object({ subject: text(500), action: z.string().trim().max(500), scene: z.string().trim().max(500), emotion: z.string().trim().max(300) }).strict();
const breakdown = z.object({ summary: text(600), keyPoints: z.array(text(600)).min(1).max(4), logic: text(600), coverFocus: text(600) }).strict();
const layout = z.object({ structure: z.enum(["single", "relationship", "comparison", "list"]), focus: z.enum(["expression", "action", "object"]) }).strict();
export const CoverReviewPlanSchema = z.object({ topic: text(500), primaryTitle: title, secondaryTitle: z.string().trim().max(120).nullable(),
  contentBreakdown: breakdown, visualBrief: brief, layoutIntent: layout, materialUsage: z.array(material).max(3).optional() }).strict();
export const CoverReviewEditsSchema = CoverReviewPlanSchema.partial().extend({ primaryTitle: z.preprocess(assertNewReviewTitle, title).optional(), contentBreakdown: breakdown.partial().optional(),
  visualBrief: brief.partial().optional(), layoutIntent: layout.partial().optional() }).strict();
export type CoverReviewPlan = z.infer<typeof CoverReviewPlanSchema>;
export type CoverReviewEdits = z.infer<typeof CoverReviewEditsSchema>;
export type CoverReviewFieldOrigins = Record<string, { source: "analysis" | "user_override"; evidenceRefs?: string[] }>;
export const CoverConfirmationRequestSchema = z.object({ operationId: z.string().uuid(),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u), expectedAnalysisHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedImageQuoteHash: z.string().regex(/^[a-f0-9]{64}$/u), edits: CoverReviewEditsSchema,
  consent: z.object({ image: z.literal(true) }).strict() }).strict();
export type CoverConfirmationRequest = z.infer<typeof CoverConfirmationRequestSchema>;
export type CoverReviewSafeTask = {
  id: string; prepareOperationId: string; title: string; subtitle: string; ratio: string; prompt: "";
  briefText: string; source: "生成"; createdAt: string; taskNo: number;
  status: "running" | "done" | "display_pending" | "failed" | "unknown" | "cancelled";
  renderPlan: CoverCompositionPlan; publicModelId?: string; modelName?: string; resolution?: string;
  imageOrigin: "original" | "generated"; assetId?: string; imageUrl?: string; exportAssetId?: string; exportUrl?: string;
  cloudStored?: boolean; historyRecordId?: string; outputWidth?: number; outputHeight?: number;
  sourceWidth?: number; sourceHeight?: number; backgroundAssetId?: string; storageKey?: string; url?: string;
  textVerification?: "unverified";
};
export type CoverReviewExecutionStatus = "confirmed" | "claimed" | "submitted" | "delivery_pending" | "completed" | "unknown" | "failed";
export type CoverReviewExecutionDto = {
  success: boolean; confirmationId: string; status: CoverReviewExecutionStatus; canPoll: boolean;
  task: CoverReviewSafeTask; activeAttempt?: { id: string; state: string; startedAt?: string; updatedAt?: string; task: CoverReviewSafeTask };
  result?: Record<string, unknown>; issue?: { code: string; message: string; action: "query_original" | "review_plan" };
};

/** User edits are a separate plan, never new model evidence or a rewritten bill. */
export function coverReviewPlanFromAnalysis(analysis: CoverContentAnalysis): CoverReviewPlan {
  const conclusion = analysis.contentBreakdown;
  return CoverReviewPlanSchema.parse({ topic: analysis.topic, primaryTitle: analysis.primaryTitle, secondaryTitle: analysis.secondaryTitle,
    visualBrief: analysis.visualBrief, contentBreakdown: conclusion ? { summary: conclusion.summary.text,
      keyPoints: conclusion.keyPoints.map(point => point.text), logic: conclusion.logic.text, coverFocus: conclusion.coverFocus.text }
      : { summary: analysis.topic, keyPoints: [analysis.topic], logic: "原分析未提供独立逻辑拆解，请确认或编辑。", coverFocus: analysis.visualBrief.action || analysis.visualBrief.subject },
    layoutIntent: { structure: analysis.layoutIntent?.structure || "single", focus: analysis.layoutIntent?.focus || "object" },
    ...(analysis.materialUsage ? { materialUsage: analysis.materialUsage.map(({ assetId, imageNumber, role }) => ({ assetId, imageNumber, role })) } : {}),
  });
}

export function applyCoverReviewEdits(original: CoverReviewPlan, rawEdits: unknown): CoverReviewPlan {
  const edits = CoverReviewEditsSchema.parse(rawEdits);
  assertNewReviewTitle(edits.primaryTitle ?? original.primaryTitle);
  return CoverReviewPlanSchema.parse({ ...original, ...edits,
    contentBreakdown: { ...original.contentBreakdown, ...edits.contentBreakdown }, visualBrief: { ...original.visualBrief, ...edits.visualBrief },
    layoutIntent: { ...original.layoutIntent, ...edits.layoutIntent } });
}
