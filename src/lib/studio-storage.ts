import { z } from "zod";
import { AspectRatioSchema, StudioProjectSchema, type AspectRatio, type StoryboardCard, type StudioProject } from "@/lib/studio-schema";
import { createInitialProject } from "@/lib/studio-reducer";

export const STUDIO_STORAGE_KEY = "ai-creation-studio:v1";
export const STUDIO_STORAGE_VERSION = 2 as const;

const StudioWorkspaceSnapshotSchema = z.object({
  storageVersion: z.literal(STUDIO_STORAGE_VERSION),
  project: StudioProjectSchema,
  selectedId: z.string().nullable(),
  input: z.string(),
});

const LegacyCardSchema = z.object({
  id: z.string(),
  order: z.number(),
  title: z.string(),
  imagePrompt: z.string(),
  videoPrompt: z.string().default(""),
  status: z.enum(["draft", "queued", "generating", "success", "failed"]),
  imageUrl: z.string().optional(),
  error: z.string().optional(),
  modelId: z.string().optional(),
  videoModelId: z.string().optional(),
  aspectRatio: AspectRatioSchema.optional(),
  durationSeconds: z.number().optional(),
  resolution: z.string().optional(),
  updatedAt: z.string(),
});

const LegacySnapshotSchema = z.object({
  cards: z.array(LegacyCardSchema).default([]),
  selectedId: z.string().nullable().optional(),
  selectedModelId: z.string().default(""),
  aspectRatio: AspectRatioSchema.default("9:16"),
  input: z.string().default(""),
});

export type StudioWorkspaceSnapshot = z.infer<typeof StudioWorkspaceSnapshotSchema>;

export function createWorkspaceSnapshot(project?: StudioProject): StudioWorkspaceSnapshot {
  return {
    storageVersion: STUDIO_STORAGE_VERSION,
    project: project ?? createInitialProject(),
    selectedId: null,
    input: "",
  };
}

function migrateLegacy(raw: z.infer<typeof LegacySnapshotSchema>): StudioWorkspaceSnapshot {
  const migratedAt = new Date().toISOString();
  const project = createInitialProject();
  const assets: StudioProject["assets"] = [];
  const storyboards: StoryboardCard[] = raw.cards.map((card) => {
    const imageAssetId = card.imageUrl ? `legacy-image-${card.id}` : undefined;
    if (card.imageUrl && imageAssetId) {
      assets.push({
        id: imageAssetId,
        storyboardId: card.id,
        kind: "generated-image",
        source: "generation",
        url: card.imageUrl,
        createdAt: card.updatedAt || migratedAt,
      });
    }
    return {
      id: card.id,
      order: card.order,
      title: card.title,
      imagePrompt: card.imagePrompt,
      videoPrompt: card.videoPrompt,
      narration: "",
      startSeconds: 0,
      endSeconds: 1,
      imageRoute: "text-to-image",
      referenceStrategy: "single",
      keyframePrompt: "",
      endFramePrompt: "",
      refinementPrompt: "",
      status: card.status,
      selectedImageAssetId: imageAssetId,
      error: card.error,
      modelId: card.modelId,
      videoModelId: card.videoModelId,
      aspectRatio: card.aspectRatio,
      durationSeconds: card.durationSeconds,
      resolution: card.resolution,
      createdAt: card.updatedAt || migratedAt,
      updatedAt: card.updatedAt || migratedAt,
    };
  });

  return {
    storageVersion: STUDIO_STORAGE_VERSION,
    project: {
      ...project,
      status: storyboards.length ? "active" : "draft",
      settings: {
        ...project.settings,
        aspectRatio: raw.aspectRatio as AspectRatio,
        defaultImageModelId: raw.selectedModelId,
      },
      storyboards,
      assets,
      updatedAt: migratedAt,
    },
    selectedId: raw.selectedId ?? storyboards[0]?.id ?? null,
    input: raw.input,
  };
}

export function parseStoredWorkspace(value: string | null): StudioWorkspaceSnapshot {
  if (!value) return createWorkspaceSnapshot();
  try {
    const parsed: unknown = JSON.parse(value);
    const current = StudioWorkspaceSnapshotSchema.safeParse(parsed);
    if (current.success) return current.data;
    const legacy = LegacySnapshotSchema.safeParse(parsed);
    if (legacy.success) return migrateLegacy(legacy.data);
  } catch {
    // Invalid local data falls back to a clean project without blocking the page.
  }
  return createWorkspaceSnapshot();
}

export function serializeWorkspace(snapshot: StudioWorkspaceSnapshot): string {
  return JSON.stringify(StudioWorkspaceSnapshotSchema.parse(snapshot));
}
