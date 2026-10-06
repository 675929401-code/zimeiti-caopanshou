import { z } from "zod";

export const STUDIO_SCHEMA_VERSION = 1 as const;

export const AspectRatioSchema = z.enum(["16:9", "9:16", "4:3", "3:4", "1:1"]);
export const CardStatusSchema = z.enum(["draft", "queued", "generating", "success", "failed"]);
export const TaskStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const GenerationRouteSchema = z.enum(["text-to-image", "keyframe-img2img"]);
export const ReferenceStrategySchema = z.enum(["single", "first-last"]);

export const StoryboardCardSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().positive(),
  title: z.string().min(1),
  imagePrompt: z.string(),
  videoPrompt: z.string(),
  narration: z.string().default(""),
  startSeconds: z.number().nonnegative().default(0),
  endSeconds: z.number().positive().default(1),
  imageRoute: GenerationRouteSchema.default("text-to-image"),
  referenceStrategy: ReferenceStrategySchema.default("single"),
  keyframePrompt: z.string().default(""),
  endFramePrompt: z.string().default(""),
  refinementPrompt: z.string().default(""),
  status: CardStatusSchema,
  selectedImageAssetId: z.string().optional(),
  selectedEndFrameAssetId: z.string().optional(),
  selectedVideoAssetId: z.string().optional(),
  error: z.string().optional(),
  modelId: z.string().optional(),
  videoModelId: z.string().optional(),
  aspectRatio: AspectRatioSchema.optional(),
  durationSeconds: z.number().positive().optional(),
  resolution: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StudioAssetSchema = z.object({
  id: z.string().min(1),
  storyboardId: z.string().min(1),
  kind: z.enum(["reference-image", "generated-image", "end-frame-image", "generated-video"]),
  source: z.enum(["upload", "generation"]),
  url: z.string().min(1),
  taskId: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  createdAt: z.string().datetime(),
});

export const GenerationTaskSchema = z.object({
  id: z.string().min(1),
  storyboardId: z.string().min(1),
  kind: z.enum(["image", "video"]),
  status: TaskStatusSchema,
  modelId: z.string().min(1),
  providerJobId: z.string().optional(),
  providerContentUrl: z.string().optional(),
  requestFingerprint: z.string().optional(),
  cost: z.number().nonnegative().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StudioEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  entityType: z.enum(["project", "storyboard", "asset", "task"]),
  entityId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const StudioSettingsSchema = z.object({
  aspectRatio: AspectRatioSchema,
  defaultImageModelId: z.string(),
  defaultVideoModelId: z.string(),
  defaultChatModelId: z.string().default(""),
  globalReferenceAssetId: z.string().default(""),
  defaultImageRoute: GenerationRouteSchema.default("text-to-image"),
  defaultReferenceStrategy: ReferenceStrategySchema.default("first-last"),
  charsPerSecond: z.number().positive().default(6),
  shotSeconds: z.number().positive().default(5),
});

export const StudioProjectSchema = z.object({
  schemaVersion: z.literal(STUDIO_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["draft", "active", "archived"]),
  settings: StudioSettingsSchema,
  storyboards: z.array(StoryboardCardSchema),
  assets: z.array(StudioAssetSchema),
  tasks: z.array(GenerationTaskSchema),
  events: z.array(StudioEventSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export type CardStatus = z.infer<typeof CardStatusSchema>;
export type GenerationRoute = z.infer<typeof GenerationRouteSchema>;
export type ReferenceStrategy = z.infer<typeof ReferenceStrategySchema>;
export type StoryboardCard = z.infer<typeof StoryboardCardSchema>;
export type StudioAsset = z.infer<typeof StudioAssetSchema>;
export type GenerationTask = z.infer<typeof GenerationTaskSchema>;
export type StudioEvent = z.infer<typeof StudioEventSchema>;
export type StudioProject = z.infer<typeof StudioProjectSchema>;
