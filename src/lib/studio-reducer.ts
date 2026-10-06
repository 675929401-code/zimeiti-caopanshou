import type { PromptImportItem, PromptImportResult } from "@/lib/studio-canvas-types";
import type { GenerationTask, StoryboardCard, StudioAsset, StudioProject } from "@/lib/studio-schema";
import { STUDIO_SCHEMA_VERSION } from "@/lib/studio-schema";
import { countSpokenCharacters, type BrainPlan } from "@/lib/script-planner";

type ActionMeta = {
  id: string;
  occurredAt: string;
};

export type StudioAction = ActionMeta & (
  | {
      type: "prompt_batch.imported";
      payload: {
        storyboards: StoryboardCard[];
        mode: PromptImportResult["mode"];
        warnings: string[];
      };
    }
  | { type: "storyboard.updated"; payload: { id: string; patch: Partial<StoryboardCard> } }
  | { type: "storyboard.removed"; payload: { id: string } }
  | { type: "storyboards.reordered"; payload: { orderedIds: string[] } }
  | { type: "asset.registered"; payload: { asset: StudioAsset; select: boolean; slot?: "primary" | "end-frame" } }
  | { type: "task.upserted"; payload: { task: GenerationTask } }
  | { type: "project.settings_updated"; payload: Partial<StudioProject["settings"]> }
  | { type: "project.cleared"; payload: Record<string, never> }
);

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function now(): string {
  return new Date().toISOString();
}

export function createInitialProject(name = "未命名创作项目"): StudioProject {
  const createdAt = now();
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: makeId(),
    name,
    status: "draft",
    settings: {
      aspectRatio: "9:16",
      defaultImageModelId: "",
      defaultVideoModelId: "",
      defaultChatModelId: "",
      globalReferenceAssetId: "",
      defaultImageRoute: "text-to-image",
      defaultReferenceStrategy: "first-last",
      charsPerSecond: 6,
      shotSeconds: 5,
    },
    storyboards: [],
    assets: [],
    tasks: [],
    events: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createStoryboardCards(
  items: PromptImportItem[],
  startOrder: number,
  occurredAt = now(),
): StoryboardCard[] {
  return items.map((item, index) => {
    const order = startOrder + index;
    return {
      id: makeId(),
      order,
      title: `分镜 ${String(order).padStart(2, "0")}`,
      imagePrompt: item.imagePrompt,
      videoPrompt: item.videoPrompt,
      narration: "",
      startSeconds: 0,
      endSeconds: 1,
      imageRoute: "text-to-image",
      referenceStrategy: "single",
      keyframePrompt: "",
      endFramePrompt: "",
      refinementPrompt: "",
      status: "draft",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
  });
}

export function createStoryboardCardsFromPlan(
  plan: BrainPlan,
  startOrder: number,
  occurredAt = now(),
): StoryboardCard[] {
  let cursor = 0;
  return plan.scenes.map((scene, index) => {
    const order = startOrder + index;
    const speechDuration = scene.durationSeconds || Math.max(1, Math.ceil((countSpokenCharacters(scene.narration) / plan.charsPerSecond) * 10) / 10);
    const startSeconds = cursor;
    const endSeconds = Math.round((cursor + speechDuration) * 10) / 10;
    cursor = endSeconds;
    return {
      id: makeId(),
      order,
      title: `分镜 ${String(order).padStart(2, "0")}`,
      narration: scene.narration,
      startSeconds,
      endSeconds,
      durationSeconds: speechDuration,
      imageRoute: plan.route,
      referenceStrategy: plan.referenceStrategy,
      imagePrompt: scene.imagePrompt,
      keyframePrompt: scene.startFramePrompt || scene.keyframePrompt,
      endFramePrompt: scene.endFramePrompt,
      refinementPrompt: scene.refinementPrompt,
      videoPrompt: scene.videoPrompt,
      status: "draft",
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
  });
}

export function createStudioAction<T extends StudioAction["type"]>(
  type: T,
  payload: Extract<StudioAction, { type: T }>["payload"],
): Extract<StudioAction, { type: T }> {
  return { id: makeId(), occurredAt: now(), type, payload } as Extract<StudioAction, { type: T }>;
}

function reindex(storyboards: StoryboardCard[], occurredAt: string): StoryboardCard[] {
  return storyboards.map((storyboard, index) => {
    const order = index + 1;
    return {
      ...storyboard,
      order,
      title: `分镜 ${String(order).padStart(2, "0")}`,
      updatedAt: occurredAt,
    };
  });
}

export function applyStudioAction(project: StudioProject, action: StudioAction): StudioProject {
  let next = project;
  let entityType: "project" | "storyboard" | "asset" | "task" = "project";
  let entityId: string | undefined;

  switch (action.type) {
    case "prompt_batch.imported":
      next = {
        ...project,
        status: "active",
        storyboards: [...project.storyboards, ...action.payload.storyboards],
      };
      break;
    case "storyboard.updated":
      entityType = "storyboard";
      entityId = action.payload.id;
      next = {
        ...project,
        storyboards: project.storyboards.map((storyboard) =>
          storyboard.id === action.payload.id
            ? { ...storyboard, ...action.payload.patch, id: storyboard.id, updatedAt: action.occurredAt }
            : storyboard,
        ),
      };
      break;
    case "storyboard.removed": {
      entityType = "storyboard";
      entityId = action.payload.id;
      const taskIds = new Set(project.tasks.filter((task) => task.storyboardId === action.payload.id).map((task) => task.id));
      next = {
        ...project,
        storyboards: reindex(project.storyboards.filter((storyboard) => storyboard.id !== action.payload.id), action.occurredAt),
        assets: project.assets.filter((asset) => asset.storyboardId !== action.payload.id),
        tasks: project.tasks.filter((task) => task.storyboardId !== action.payload.id),
        events: project.events.filter((event) => !taskIds.has(event.entityId ?? "")),
      };
      break;
    }
    case "storyboards.reordered": {
      const positions = new Map(action.payload.orderedIds.map((id, index) => [id, index]));
      const ordered = [...project.storyboards].sort(
        (left, right) => (positions.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
      next = { ...project, storyboards: reindex(ordered, action.occurredAt) };
      break;
    }
    case "asset.registered":
      entityType = "asset";
      entityId = action.payload.asset.id;
      next = {
        ...project,
        assets: [...project.assets.filter((asset) => asset.id !== action.payload.asset.id), action.payload.asset],
        storyboards: action.payload.select
          ? project.storyboards.map((storyboard) =>
              storyboard.id === action.payload.asset.storyboardId
                ? {
                    ...storyboard,
                    selectedImageAssetId: action.payload.asset.kind !== "generated-video" && action.payload.slot !== "end-frame" ? action.payload.asset.id : storyboard.selectedImageAssetId,
                    selectedEndFrameAssetId: action.payload.slot === "end-frame" || action.payload.asset.kind === "end-frame-image" ? action.payload.asset.id : storyboard.selectedEndFrameAssetId,
                    selectedVideoAssetId: action.payload.asset.kind === "generated-video" ? action.payload.asset.id : storyboard.selectedVideoAssetId,
                    status: "success" as const,
                    error: undefined,
                    updatedAt: action.occurredAt,
                  }
                : storyboard,
            )
          : project.storyboards,
      };
      break;
    case "task.upserted":
      entityType = "task";
      entityId = action.payload.task.id;
      next = {
        ...project,
        tasks: [...project.tasks.filter((task) => task.id !== action.payload.task.id), action.payload.task],
      };
      break;
    case "project.settings_updated":
      next = { ...project, settings: { ...project.settings, ...action.payload } };
      break;
    case "project.cleared":
      next = { ...project, status: "draft", storyboards: [], assets: [], tasks: [] };
      break;
  }

  return {
    ...next,
    updatedAt: action.occurredAt,
    events: [
      ...next.events,
      {
        id: action.id,
        type: action.type,
        entityType,
        entityId,
        payload: action.payload,
        createdAt: action.occurredAt,
      },
    ].slice(-200),
  };
}
