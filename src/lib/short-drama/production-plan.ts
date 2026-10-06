import type { ShortDramaProject } from "./contracts";
import {
  GENERAL_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  type GeneralScriptResult,
  type GeneralScriptVideoSize,
} from "./general-script-contract";
import { bridgeGeneralScriptToStoryboard } from "./general-script-storyboard-bridge";
import {
  ProductionPlanSegmentSchema,
  type ProductionPlanSegment,
} from "./production-contracts";

const GENERAL_SCRIPT_KEYS = [
  "schemaVersion",
  "profileId",
  "operation",
  "summary",
  "episodes",
  "characters",
  "scenes",
  "props",
] as const;

const GENERAL_SCRIPT_VIDEO_SIZES = new Set<GeneralScriptVideoSize>([
  "9:16",
  "16:9",
  "1:1",
  "4:3",
]);

export class ProductionPlanError extends Error {
  constructor(
    readonly code: "PRODUCTION_PLAN_SOURCE_MISSING" | "PRODUCTION_PLAN_SOURCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProductionPlanError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? value[key] as Record<string, unknown> : null;
}

function arrayAt(value: unknown, key: string): unknown[] | null {
  if (!isRecord(value)) return null;
  return Array.isArray(value[key]) ? value[key] as unknown[] : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function sourceTextOrFallback(
  record: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
  fallbackMaxLength: number,
): string {
  const sourceValue = firstString(record, keys);
  if (sourceValue) return sourceValue;
  return fallback.trim().slice(0, fallbackMaxLength);
}

function episodeStringArray(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProductionPlanError("PRODUCTION_PLAN_SOURCE_INVALID", `${path} 必须是字符串数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ProductionPlanError(
        "PRODUCTION_PLAN_SOURCE_INVALID",
        `${path}[${index}] 必须是非空字符串`,
      );
    }
    return item.trim();
  });
}

function bridgeVideoSize(aspectRatio: unknown): GeneralScriptVideoSize {
  if (
    typeof aspectRatio === "string"
    && GENERAL_SCRIPT_VIDEO_SIZES.has(aspectRatio as GeneralScriptVideoSize)
  ) {
    return aspectRatio as GeneralScriptVideoSize;
  }
  return aspectRatio === "21:9" ? "16:9" : "9:16";
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function findDirectSegments(source: Record<string, unknown>): unknown[] | null {
  const direct = arrayAt(source, "segments");
  if (direct) return direct;

  const animationPackage = recordAt(source, "animationReversePackage")
    || recordAt(recordAt(source, "handoffMetadata"), "animationReversePackage");
  const animationSegments = arrayAt(animationPackage, "segments");
  if (animationSegments) return animationSegments;

  const storyboard = recordAt(source, "storyboard") || recordAt(source, "workbenchImport");
  return arrayAt(storyboard, "segments");
}

function deriveGeneralScriptSegments(source: Record<string, unknown>): unknown[] | null {
  if (!GENERAL_SCRIPT_KEYS.every((key) => key in source)) return null;
  const strictResult = Object.fromEntries(
    GENERAL_SCRIPT_KEYS.map((key) => [key, source[key]]),
  );
  try {
    return bridgeGeneralScriptToStoryboard(strictResult)
      .handoffMetadata.animationReversePackage.segments;
  } catch (error) {
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_INVALID",
      error instanceof Error ? error.message : "项目剧本无法转换为生产镜头",
    );
  }
}

function deriveEditableEpisodeSegments(
  source: Record<string, unknown>,
  project: ShortDramaProject,
): unknown[] | null {
  const rawEpisodes = arrayAt(source, "episodes");
  if (!rawEpisodes || rawEpisodes.length === 0) return null;

  try {
    const projectSettings = project.settings as Record<string, unknown>;
    const summary = recordAt(source, "summary") || {};
    const defaultDuration = Math.round(
      firstNumber(projectSettings, ["defaultShotDurationSeconds"]) ?? 5,
    );
    const episodes: GeneralScriptResult["episodes"] = rawEpisodes.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new ProductionPlanError(
          "PRODUCTION_PLAN_SOURCE_INVALID",
          `第 ${index + 1} 集不是有效对象`,
        );
      }
      const episodeNumber = firstNumber(raw, ["episodeNumber"]) ?? index + 1;
      const content = firstString(raw, ["content"]);
      const title = firstString(raw, ["title"]) || `第 ${episodeNumber} 集`;
      return {
        episodeNumber,
        title,
        logline: firstString(raw, ["logline"])
          || content.slice(0, 180)
          || title,
        content,
        endingHook: firstString(raw, ["endingHook"]),
        estimatedDurationSeconds: Math.round(
          firstNumber(raw, ["estimatedDurationSeconds"]) ?? defaultDuration,
        ),
        characterNames: episodeStringArray(raw.characterNames, `第 ${index + 1} 集 characterNames`),
        sceneNames: episodeStringArray(raw.sceneNames, `第 ${index + 1} 集 sceneNames`),
        propNames: episodeStringArray(raw.propNames, `第 ${index + 1} 集 propNames`),
      };
    });
    const firstEpisode = episodes[0];
    const projectAspectRatio = firstString(projectSettings, ["aspectRatio"]) || "9:16";
    const normalizedVideoSize = bridgeVideoSize(projectAspectRatio);
    const result: GeneralScriptResult = {
      schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
      profileId: GENERAL_SCRIPT_PROFILE_ID,
      operation: "generate",
      summary: {
        title: sourceTextOrFallback(summary, ["title"], project.title, 200),
        protagonist: sourceTextOrFallback(summary, ["protagonist"], "主要角色", 500),
        oneSentence: sourceTextOrFallback(
          summary,
          ["oneSentence"],
          firstEpisode.logline || firstEpisode.content,
          1_000,
        ),
        synopsis: sourceTextOrFallback(
          summary,
          ["synopsis"],
          project.description || firstEpisode.content,
          10_000,
        ),
        genre: sourceTextOrFallback(summary, ["genre"], "动画短剧", 100),
        creationMode: firstString(summary, ["creationMode"]) === "adaptation"
          ? "adaptation"
          : "original",
        targetAudience: ["all_ages", "children", "teen", "adult"].includes(
          firstString(summary, ["targetAudience"]),
        )
          ? firstString(summary, ["targetAudience"]) as GeneralScriptResult["summary"]["targetAudience"]
          : "all_ages",
        tone: sourceTextOrFallback(summary, ["tone"], "warm", 100),
        background: sourceTextOrFallback(
          summary,
          ["background"],
          "依据当前项目已保存的分集剧本进行生产",
          2_000,
        ),
        setting: sourceTextOrFallback(
          summary,
          ["setting"],
          "按分集剧本中的场景、动作和叙事顺序推进",
          2_000,
        ),
        animationStyle: sourceTextOrFallback(
          summary,
          ["animationStyle"],
          firstString(projectSettings, ["animationStyle"]) || "商业级动画",
          200,
        ),
        videoSize: normalizedVideoSize,
        performanceMode: projectSettings.noCharacterSpeech === false
          ? "dialogue"
          : "silent_narration",
        totalEpisodes: episodes.length,
        isFinale: summary.isFinale === true,
      },
      episodes,
      characters: [],
      scenes: [],
      props: [],
    };
    const segments = bridgeGeneralScriptToStoryboard(result)
      .handoffMetadata.animationReversePackage.segments;
    if (projectAspectRatio === normalizedVideoSize) return segments;
    return segments.map((segment) => ({
      ...segment,
      aspect_ratio: projectAspectRatio,
      image_prompt: segment.image_prompt.replaceAll(normalizedVideoSize, projectAspectRatio),
      video_prompt: segment.video_prompt.replaceAll(normalizedVideoSize, projectAspectRatio),
    }));
  } catch (error) {
    if (error instanceof ProductionPlanError) throw error;
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_INVALID",
      error instanceof Error ? error.message : "项目分集无法转换为生产镜头",
    );
  }
}

function normalizeSegment(
  raw: unknown,
  index: number,
  project: ShortDramaProject,
): ProductionPlanSegment {
  if (!isRecord(raw)) {
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_INVALID",
      `第 ${index + 1} 个生产段不是有效对象`,
    );
  }

  const sequence = index + 1;
  const narration = firstString(raw, ["narration", "voiceover", "content"]);
  const semanticDescription = firstString(raw, [
    "visualDescription",
    "visual_description",
    "semantic_job",
    "description",
  ]);
  const duration = firstNumber(raw, [
    "durationSeconds",
    "duration_seconds",
    "target_duration_seconds",
    "duration",
  ]) ?? project.settings.defaultShotDurationSeconds;
  const sourceAspectRatio = firstString(raw, ["aspectRatio", "aspect_ratio"]);
  const candidate = {
    segmentId: firstString(raw, ["segmentId", "segment_id", "id"])
      || `segment-${String(sequence).padStart(3, "0")}`,
    title: firstString(raw, ["title", "semantic_job"])
      || `镜头 ${sequence}`,
    narration,
    visualDescription: semanticDescription || narration,
    imagePrompt: firstString(raw, ["imagePrompt", "image_prompt"]),
    videoPrompt: firstString(raw, ["videoPrompt", "video_prompt"]),
    negativePrompt: firstString(raw, ["negativePrompt", "negative_prompt"]),
    durationSeconds: duration,
    aspectRatio: sourceAspectRatio || project.settings.aspectRatio,
    metadata: {
      sourceSegmentId: firstString(raw, ["segmentId", "segment_id", "id"]),
      storyBeat: firstString(raw, ["storyBeat", "story_beat"]),
      panelCount: firstNumber(raw, ["panelCount", "panel_count"]),
      layout: firstString(raw, ["layout"]),
      actualShotCount: firstNumber(raw, ["actualShotCount", "actual_shot_count"]),
      packaging: jsonSafe(raw.packaging),
      validation: jsonSafe(raw.validation),
      source: "project_source_payload",
    },
  };

  const parsed = ProductionPlanSegmentSchema.safeParse(candidate);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("；");
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_INVALID",
      `第 ${sequence} 个生产段不符合生产要求：${reason}`,
    );
  }
  return parsed.data;
}

export function deriveProductionPlan(project: ShortDramaProject): ProductionPlanSegment[] {
  const source = project.sourcePayload as Record<string, unknown>;
  const rawSegments = findDirectSegments(source)
    || deriveGeneralScriptSegments(source)
    || deriveEditableEpisodeSegments(source, project);
  if (!rawSegments || rawSegments.length === 0) {
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_MISSING",
      "项目中没有可用于生产的分镜段，请先完成剧本导入与分镜规划",
    );
  }
  if (rawSegments.length > 200) {
    throw new ProductionPlanError(
      "PRODUCTION_PLAN_SOURCE_INVALID",
      "单个项目最多创建 200 个生产镜头，请拆分项目后重试",
    );
  }
  return rawSegments.map((segment, index) => normalizeSegment(segment, index, project));
}
