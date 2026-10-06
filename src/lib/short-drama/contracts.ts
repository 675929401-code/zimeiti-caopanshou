import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const ShortDramaProjectTypeSchema = z.enum([
  "short_drama",
  "narrated_animation",
  "pet_story",
  "custom",
]);

export const ShortDramaProjectStatusSchema = z.enum([
  "draft",
  "active",
  "generating",
  "completed",
  "failed",
  "archived",
]);

export const ShortDramaJobStageSchema = z.enum([
  "script_analysis",
  "entity_design",
  "scene_design",
  "shot_planning",
  "image_prompt",
  "image_generation",
  "video_prompt",
  "video_generation",
  "audio_generation",
  "final_assembly",
  "export",
]);

export const ShortDramaJobStateSchema = z.enum([
  "accepted",
  "queued",
  "running",
  "result_staging",
  "persisting",
  "finalizing",
  "succeeded",
  "retry_wait",
  "failed",
  "cancelled",
]);

export const ShortDramaEntityTypeSchema = z.enum([
  "character",
  "location",
  "prop",
  "style",
  "voice",
]);

const ShortDramaEntityKeySchema = z.string().trim().min(1).max(120);
const ShortDramaEntityNameSchema = z.string().trim().min(1).max(160);
const ShortDramaEntityDescriptionSchema = z.string().trim().max(10_000);
const ShortDramaReferenceAssetUriSchema = z.string().trim().max(2_048).nullable();

export const ListShortDramaEntitiesQuerySchema = z
  .object({
    entityType: ShortDramaEntityTypeSchema.optional(),
  })
  .strict();

export const CreateShortDramaEntityRequestSchema = z
  .object({
    entityType: ShortDramaEntityTypeSchema,
    entityKey: ShortDramaEntityKeySchema,
    name: ShortDramaEntityNameSchema,
    description: ShortDramaEntityDescriptionSchema.optional().default(""),
    attributes: JsonObjectSchema.optional().default({}),
    referenceAssetUri: ShortDramaReferenceAssetUriSchema.optional().default(null),
  })
  .strict();

const UpdateShortDramaEntityPatchSchema = z
  .object({
    entityKey: ShortDramaEntityKeySchema.optional(),
    name: ShortDramaEntityNameSchema.optional(),
    description: ShortDramaEntityDescriptionSchema.nullable().optional(),
    attributes: JsonObjectSchema.optional(),
    referenceAssetUri: ShortDramaReferenceAssetUriSchema.optional(),
  })
  .strict();

export const UpdateShortDramaEntityRequestSchema = UpdateShortDramaEntityPatchSchema.extend({
  expectedRevision: z.number().int().min(1),
}).refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  { message: "至少提供一个需要更新的实体字段" },
);

export const DeleteShortDramaEntityRequestSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
  })
  .strict();

export const ShortDramaAssetRoleSchema = z.enum([
  "source",
  "character_reference",
  "scene_reference",
  "storyboard",
  "image",
  "video",
  "audio",
  "subtitle",
  "export",
]);

export const ShortDramaAspectRatioSchema = z.enum([
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
]);

export const ShortDramaShotStatusSchema = z.enum([
  "draft",
  "ready",
  "generating",
  "completed",
  "failed",
  "cancelled",
]);

const ShortDramaShotSequenceSchema = z.number().int().min(1).max(10_000);
const ShortDramaShotSceneKeySchema = z.string().trim().max(120).nullable();
const ShortDramaShotTitleSchema = z.string().trim().min(1).max(200);
const ShortDramaShotNarrationSchema = z.string().trim().max(12_000);
const ShortDramaShotVisualDescriptionSchema = z.string().trim().max(20_000);
const ShortDramaShotPromptSchema = z.string().trim().max(30_000);
const ShortDramaShotNegativePromptSchema = z.string().trim().max(12_000);
const ShortDramaShotDurationSchema = z.number().finite().gt(0).max(120);

export const ListShortDramaShotsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const CreateShortDramaShotRequestSchema = z
  .object({
    sequence: ShortDramaShotSequenceSchema,
    sceneKey: ShortDramaShotSceneKeySchema.optional().default(null),
    title: ShortDramaShotTitleSchema,
    narration: ShortDramaShotNarrationSchema.optional().default(""),
    visualDescription: ShortDramaShotVisualDescriptionSchema.optional().default(""),
    imagePrompt: ShortDramaShotPromptSchema.optional().default(""),
    videoPrompt: ShortDramaShotPromptSchema.optional().default(""),
    negativePrompt: ShortDramaShotNegativePromptSchema.optional().default(""),
    durationSeconds: ShortDramaShotDurationSchema.optional().default(5),
    aspectRatio: ShortDramaAspectRatioSchema.optional().default("9:16"),
    metadata: JsonObjectSchema.optional().default({}),
  })
  .strict();

const UpdateShortDramaShotPatchSchema = z
  .object({
    sequence: ShortDramaShotSequenceSchema.optional(),
    sceneKey: ShortDramaShotSceneKeySchema.optional(),
    title: ShortDramaShotTitleSchema.optional(),
    narration: ShortDramaShotNarrationSchema.optional(),
    visualDescription: ShortDramaShotVisualDescriptionSchema.optional(),
    imagePrompt: ShortDramaShotPromptSchema.optional(),
    videoPrompt: ShortDramaShotPromptSchema.optional(),
    negativePrompt: ShortDramaShotNegativePromptSchema.optional(),
    durationSeconds: ShortDramaShotDurationSchema.optional(),
    aspectRatio: ShortDramaAspectRatioSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict();

export const UpdateShortDramaShotRequestSchema = UpdateShortDramaShotPatchSchema.extend({
  expectedRevision: z.number().int().min(1),
}).refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  { message: "至少提供一个需要更新的镜头字段" },
);

export const DeleteShortDramaShotRequestSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
  })
  .strict();

export const ShortDramaProjectSettingsSchema = z
  .object({
    aspectRatio: ShortDramaAspectRatioSchema.default("9:16"),
    outputLanguage: z.string().trim().min(2).max(32).default("zh-CN"),
    animationStyle: z.string().trim().max(120).default(""),
    noCharacterSpeech: z.boolean().default(true),
    defaultShotDurationSeconds: z.number().finite().min(1).max(30).default(5),
  })
  .strict();

export const ShortDramaClientRequestIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "clientRequestId 只能包含字母、数字、点、下划线、冒号和短横线",
  );

const ProjectTitleSchema = z.string().trim().min(1).max(120);
const ProjectDescriptionSchema = z.string().trim().max(2_000);

export const CreateShortDramaProjectRequestSchema = z
  .object({
    clientRequestId: ShortDramaClientRequestIdSchema,
    title: ProjectTitleSchema,
    description: ProjectDescriptionSchema.optional().default(""),
    projectType: ShortDramaProjectTypeSchema.default("short_drama"),
    sourcePayload: JsonObjectSchema.optional().default({}),
    settings: ShortDramaProjectSettingsSchema.optional().default({
      aspectRatio: "9:16",
      outputLanguage: "zh-CN",
      animationStyle: "",
      noCharacterSpeech: true,
      defaultShotDurationSeconds: 5,
    }),
  })
  .strict();

const UpdateShortDramaProjectPatchSchema = z
  .object({
    title: ProjectTitleSchema.optional(),
    description: ProjectDescriptionSchema.nullable().optional(),
    projectType: ShortDramaProjectTypeSchema.optional(),
    status: ShortDramaProjectStatusSchema.optional(),
    sourcePayload: JsonObjectSchema.optional(),
    settings: ShortDramaProjectSettingsSchema.partial().strict().optional(),
  })
  .strict();

export const UpdateShortDramaProjectRequestSchema = UpdateShortDramaProjectPatchSchema.extend({
  expectedRevision: z.number().int().min(1),
}).refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  { message: "至少提供一个需要更新的项目字段" },
);

export const DeleteShortDramaProjectRequestSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const ListShortDramaProjectsQuerySchema = z
  .object({
    status: ShortDramaProjectStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const ShortDramaProjectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const ShortDramaEntityParamsSchema = ShortDramaProjectParamsSchema.extend({
  entityId: z.string().uuid(),
});

export const ShortDramaShotParamsSchema = ShortDramaProjectParamsSchema.extend({
  shotId: z.string().uuid(),
});

export const ShortDramaProjectDbRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  client_request_id: z.string().nullable(),
  request_hash: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  project_type: ShortDramaProjectTypeSchema,
  status: ShortDramaProjectStatusSchema,
  source_payload: JsonObjectSchema,
  settings: JsonObjectSchema,
  revision: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
});

export const ShortDramaProjectSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  projectType: ShortDramaProjectTypeSchema,
  status: ShortDramaProjectStatusSchema,
  sourcePayload: JsonObjectSchema,
  settings: JsonObjectSchema,
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ShortDramaEntityDbRowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  user_id: z.string().min(1),
  entity_type: ShortDramaEntityTypeSchema,
  entity_key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  attributes: JsonObjectSchema,
  reference_asset_uri: z.string().nullable(),
  revision: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ShortDramaEntitySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  entityType: ShortDramaEntityTypeSchema,
  entityKey: z.string(),
  name: z.string(),
  description: z.string(),
  attributes: JsonObjectSchema,
  referenceAssetUri: z.string().nullable(),
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ShortDramaShotDbRowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  user_id: z.string().min(1),
  sequence: z.number().int().min(1),
  scene_key: z.string().nullable(),
  title: z.string().nullable(),
  narration: z.string().nullable(),
  visual_description: z.string().nullable(),
  image_prompt: z.string().nullable(),
  video_prompt: z.string().nullable(),
  negative_prompt: z.string().nullable(),
  duration_seconds: z.coerce.number().finite().gt(0).max(120),
  aspect_ratio: ShortDramaAspectRatioSchema,
  status: ShortDramaShotStatusSchema,
  metadata: JsonObjectSchema,
  revision: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ShortDramaShotSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sequence: z.number().int().min(1),
  sceneKey: z.string().nullable(),
  title: z.string(),
  narration: z.string(),
  visualDescription: z.string(),
  imagePrompt: z.string(),
  videoPrompt: z.string(),
  negativePrompt: z.string(),
  durationSeconds: z.number().finite().gt(0).max(120),
  aspectRatio: ShortDramaAspectRatioSchema,
  status: ShortDramaShotStatusSchema,
  metadata: JsonObjectSchema,
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ShortDramaProjectType = z.infer<typeof ShortDramaProjectTypeSchema>;
export type ShortDramaProjectStatus = z.infer<typeof ShortDramaProjectStatusSchema>;
export type ShortDramaJobStage = z.infer<typeof ShortDramaJobStageSchema>;
export type ShortDramaJobState = z.infer<typeof ShortDramaJobStateSchema>;
export type ShortDramaEntityType = z.infer<typeof ShortDramaEntityTypeSchema>;
export type ShortDramaShotStatus = z.infer<typeof ShortDramaShotStatusSchema>;
export type ShortDramaProjectSettings = z.infer<typeof ShortDramaProjectSettingsSchema>;
export type CreateShortDramaProjectRequest = z.infer<typeof CreateShortDramaProjectRequestSchema>;
export type UpdateShortDramaProjectRequest = z.infer<typeof UpdateShortDramaProjectRequestSchema>;
export type DeleteShortDramaProjectRequest = z.infer<typeof DeleteShortDramaProjectRequestSchema>;
export type ListShortDramaProjectsQuery = z.infer<typeof ListShortDramaProjectsQuerySchema>;
export type ShortDramaProjectDbRow = z.infer<typeof ShortDramaProjectDbRowSchema>;
export type ShortDramaProject = z.infer<typeof ShortDramaProjectSchema>;
export type CreateShortDramaEntityRequest = z.infer<typeof CreateShortDramaEntityRequestSchema>;
export type UpdateShortDramaEntityRequest = z.infer<typeof UpdateShortDramaEntityRequestSchema>;
export type DeleteShortDramaEntityRequest = z.infer<typeof DeleteShortDramaEntityRequestSchema>;
export type ListShortDramaEntitiesQuery = z.infer<typeof ListShortDramaEntitiesQuerySchema>;
export type ShortDramaEntityDbRow = z.infer<typeof ShortDramaEntityDbRowSchema>;
export type ShortDramaEntity = z.infer<typeof ShortDramaEntitySchema>;
export type CreateShortDramaShotRequest = z.infer<typeof CreateShortDramaShotRequestSchema>;
export type UpdateShortDramaShotRequest = z.infer<typeof UpdateShortDramaShotRequestSchema>;
export type DeleteShortDramaShotRequest = z.infer<typeof DeleteShortDramaShotRequestSchema>;
export type ListShortDramaShotsQuery = z.infer<typeof ListShortDramaShotsQuerySchema>;
export type ShortDramaShotDbRow = z.infer<typeof ShortDramaShotDbRowSchema>;
export type ShortDramaShot = z.infer<typeof ShortDramaShotSchema>;
