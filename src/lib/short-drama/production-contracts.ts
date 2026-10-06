import { z } from "zod";
import {
  ShortDramaAspectRatioSchema,
  ShortDramaClientRequestIdSchema,
} from "./contracts";

const ProductionActionSchema = z.enum([
  "create_plan",
  "generate_entity_image",
  "generate_image",
  "generate_video",
  "update_take",
  "delete_take",
  "save_timeline",
  "assemble_final",
  "poll_job",
]);

const ProductionModelIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "modelId 格式无效");

const ProductionResolutionSchema = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9._:-]+$/, "resolution 格式无效");

const ProductionShotIdSchema = z.string().uuid("shotId 必须是有效 UUID");
const ProductionAssetIdSchema = z.string().uuid("assetId 必须是有效 UUID");

export const ProductionTimelineClipSchema = z
  .object({
    id: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/, "时间线片段 id 格式无效"),
    shotId: ProductionShotIdSchema,
    assetId: ProductionAssetIdSchema,
    enabled: z.boolean().default(true),
    startSeconds: z.number().finite().min(0).max(3_600),
    endSeconds: z.number().finite().min(0.1).max(3_600),
  })
  .strict()
  .refine((value) => value.endSeconds > value.startSeconds, {
    message: "时间线片段结束时间必须晚于开始时间",
    path: ["endSeconds"],
  });

const ProductionTimelineSchema = z.array(ProductionTimelineClipSchema).max(240);

export const ProductionJobLookupIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "jobId 格式无效");

export const CreateProductionPlanRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.create_plan),
    clientRequestId: ShortDramaClientRequestIdSchema,
  })
  .strict();

export const GenerateProductionImageRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.generate_image),
    shotId: ProductionShotIdSchema,
    clientRequestId: ShortDramaClientRequestIdSchema,
    modelId: ProductionModelIdSchema,
    resolution: ProductionResolutionSchema.optional(),
  })
  .strict();

export const GenerateProductionEntityImageRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.generate_entity_image),
    entityId: z.string().uuid("entityId 必须是有效 UUID"),
    expectedEntityRevision: z.number().int().min(1),
    clientRequestId: ShortDramaClientRequestIdSchema,
    modelId: ProductionModelIdSchema,
    resolution: ProductionResolutionSchema.optional(),
    mode: z.enum(["generate", "repaint"]).default("generate"),
    layout: z.enum(["single", "three_view"]).default("single"),
  })
  .strict();

export const GenerateProductionVideoRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.generate_video),
    shotId: ProductionShotIdSchema,
    clientRequestId: ShortDramaClientRequestIdSchema,
    modelId: ProductionModelIdSchema,
    resolution: ProductionResolutionSchema.optional(),
    duration: z.number().finite().min(1).max(60),
  })
  .strict();

export const PollProductionJobRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.poll_job),
    jobId: ProductionJobLookupIdSchema,
  })
  .strict();

export const UpdateProductionTakeRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.update_take),
    shotId: ProductionShotIdSchema,
    assetId: ProductionAssetIdSchema,
    expectedShotRevision: z.number().int().min(1),
    selected: z.boolean().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine(
    (value) => value.selected !== undefined || value.rating !== undefined || value.note !== undefined,
    { message: "至少提供一个需要更新的 TAKE 字段" },
  );

export const DeleteProductionTakeRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.delete_take),
    shotId: ProductionShotIdSchema,
    assetId: ProductionAssetIdSchema,
    expectedShotRevision: z.number().int().min(1),
  })
  .strict();

export const SaveProductionTimelineRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.save_timeline),
    expectedProjectRevision: z.number().int().min(1),
    clips: ProductionTimelineSchema,
  })
  .strict();

export const AssembleProductionFinalRequestSchema = z
  .object({
    action: z.literal(ProductionActionSchema.enum.assemble_final),
    clientRequestId: ShortDramaClientRequestIdSchema,
    burnSubtitles: z.boolean().optional().default(true),
    timeline: ProductionTimelineSchema.optional(),
  })
  .strict();

export const ProductionActionRequestSchema = z.discriminatedUnion("action", [
  CreateProductionPlanRequestSchema,
  GenerateProductionEntityImageRequestSchema,
  GenerateProductionImageRequestSchema,
  GenerateProductionVideoRequestSchema,
  UpdateProductionTakeRequestSchema,
  DeleteProductionTakeRequestSchema,
  SaveProductionTimelineRequestSchema,
  AssembleProductionFinalRequestSchema,
  PollProductionJobRequestSchema,
]);

export const ProductionExportRequestSchema = z
  .object({
    jobId: ProductionJobLookupIdSchema,
    targetDurationSeconds: z.number().finite().min(0.5).max(60),
  })
  .strict();

export const ProductionPlanSegmentSchema = z
  .object({
    segmentId: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    narration: z.string().trim().max(20_000),
    visualDescription: z.string().trim().max(20_000),
    imagePrompt: z.string().trim().min(1).max(20_000),
    videoPrompt: z.string().trim().min(1).max(4_000),
    negativePrompt: z.string().trim().max(4_000),
    durationSeconds: z.number().finite().min(1).max(60),
    aspectRatio: ShortDramaAspectRatioSchema,
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ProductionActionRequest = z.infer<typeof ProductionActionRequestSchema>;
export type CreateProductionPlanRequest = z.infer<typeof CreateProductionPlanRequestSchema>;
export type GenerateProductionEntityImageRequest = z.infer<typeof GenerateProductionEntityImageRequestSchema>;
export type GenerateProductionImageRequest = z.infer<typeof GenerateProductionImageRequestSchema>;
export type GenerateProductionVideoRequest = z.infer<typeof GenerateProductionVideoRequestSchema>;
export type UpdateProductionTakeRequest = z.infer<typeof UpdateProductionTakeRequestSchema>;
export type DeleteProductionTakeRequest = z.infer<typeof DeleteProductionTakeRequestSchema>;
export type SaveProductionTimelineRequest = z.infer<typeof SaveProductionTimelineRequestSchema>;
export type AssembleProductionFinalRequest = z.infer<typeof AssembleProductionFinalRequestSchema>;
export type PollProductionJobRequest = z.infer<typeof PollProductionJobRequestSchema>;
export type ProductionExportRequest = z.infer<typeof ProductionExportRequestSchema>;
export type ProductionPlanSegment = z.infer<typeof ProductionPlanSegmentSchema>;
export type ProductionTimelineClip = z.infer<typeof ProductionTimelineClipSchema>;
