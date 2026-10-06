import { z } from "zod";
import {
  GeneralScriptContractError,
  parseGeneralScriptResult,
  type GeneralScriptCharacter,
  type GeneralScriptEpisode,
  type GeneralScriptProp,
  type GeneralScriptResult,
  type GeneralScriptScene,
  type GeneralScriptSummary,
} from "./general-script-contract";
import {
  ShortDramaClientRequestIdSchema,
  type CreateShortDramaProjectRequest,
  type JsonValue,
  type ShortDramaProjectType,
} from "./contracts";

export const GENERAL_SCRIPT_PROJECT_IMPORT_VERSION = "general-script-project-import.v1";

export const GeneralScriptProjectImportEnvelopeSchema = z
  .object({
    clientRequestId: ShortDramaClientRequestIdSchema,
    title: z.string().trim().min(1).max(120),
    result: z.unknown(),
  })
  .strict();

export interface GeneralScriptProjectImportRequest {
  clientRequestId: string;
  title: string;
  result: GeneralScriptResult;
}

export interface GeneralScriptPromptAgentPayload {
  schemaVersion: GeneralScriptResult["schemaVersion"];
  profileId: GeneralScriptResult["profileId"];
  operation: GeneralScriptResult["operation"];
  summary: GeneralScriptSummary;
  episodes: GeneralScriptEpisode[];
  characters: GeneralScriptCharacter[];
  scenes: GeneralScriptScene[];
  props: GeneralScriptProp[];
}

export interface GeneralScriptProjectMapping {
  createRequest: CreateShortDramaProjectRequest;
  promptAgentPayload: GeneralScriptPromptAgentPayload;
}

const RESULT_KEYS = [
  "schemaVersion",
  "profileId",
  "operation",
  "summary",
  "episodes",
  "characters",
  "scenes",
  "props",
] as const;
const SUMMARY_KEYS = [
  "title",
  "protagonist",
  "oneSentence",
  "synopsis",
  "genre",
  "creationMode",
  "targetAudience",
  "tone",
  "background",
  "setting",
  "animationStyle",
  "videoSize",
  "performanceMode",
  "totalEpisodes",
  "isFinale",
] as const;
const EPISODE_KEYS = [
  "episodeNumber",
  "title",
  "logline",
  "content",
  "endingHook",
  "estimatedDurationSeconds",
  "characterNames",
  "sceneNames",
  "propNames",
] as const;
const CHARACTER_KEYS = [
  "id",
  "name",
  "role",
  "profile",
  "personality",
  "appearance",
  "voiceDirection",
] as const;
const SCENE_KEYS = ["id", "name", "description", "time", "atmosphere", "episodeNumbers"] as const;
const PROP_KEYS = ["id", "name", "category", "description", "episodeNumbers"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: unknown, path: string, keys: readonly string[]): void {
  if (!isRecord(value)) {
    throw new GeneralScriptContractError(`${path} 必须是对象`);
  }
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !(key in value));
  const extra = actual.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `缺少字段: ${missing.join(", ")}` : "",
      extra.length > 0 ? `包含未知字段: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("；");
    throw new GeneralScriptContractError(`${path} 字段不符合 general-script-result.v1（${details}）`);
  }
}

function assertStrictGeneralScriptShape(value: unknown): void {
  assertExactKeys(value, "result", RESULT_KEYS);
  const result = value as Record<string, unknown>;
  assertExactKeys(result.summary, "result.summary", SUMMARY_KEYS);

  const collections: Array<{
    value: unknown;
    path: string;
    keys: readonly string[];
  }> = [
    { value: result.episodes, path: "result.episodes", keys: EPISODE_KEYS },
    { value: result.characters, path: "result.characters", keys: CHARACTER_KEYS },
    { value: result.scenes, path: "result.scenes", keys: SCENE_KEYS },
    { value: result.props, path: "result.props", keys: PROP_KEYS },
  ];

  for (const collection of collections) {
    if (!Array.isArray(collection.value)) {
      throw new GeneralScriptContractError(`${collection.path} 必须是数组`);
    }
    collection.value.forEach((entry, index) => {
      assertExactKeys(entry, `${collection.path}[${index}]`, collection.keys);
    });
  }
}

export function parseStrictGeneralScriptResult(value: unknown): GeneralScriptResult {
  assertStrictGeneralScriptShape(value);
  return parseGeneralScriptResult(value);
}

export function parseGeneralScriptProjectImport(value: unknown): GeneralScriptProjectImportRequest {
  const envelope = GeneralScriptProjectImportEnvelopeSchema.parse(value);
  return {
    clientRequestId: envelope.clientRequestId,
    title: envelope.title,
    result: parseStrictGeneralScriptResult(envelope.result),
  };
}

function cloneSummary(summary: GeneralScriptSummary): GeneralScriptSummary {
  return { ...summary };
}

function cloneEpisodes(episodes: GeneralScriptEpisode[]): GeneralScriptEpisode[] {
  return episodes.map((episode) => ({
    ...episode,
    characterNames: [...episode.characterNames],
    sceneNames: [...episode.sceneNames],
    propNames: [...episode.propNames],
  }));
}

function cloneCharacters(characters: GeneralScriptCharacter[]): GeneralScriptCharacter[] {
  return characters.map((character) => ({ ...character }));
}

function cloneScenes(scenes: GeneralScriptScene[]): GeneralScriptScene[] {
  return scenes.map((scene) => ({ ...scene, episodeNumbers: [...scene.episodeNumbers] }));
}

function cloneProps(props: GeneralScriptProp[]): GeneralScriptProp[] {
  return props.map((prop) => ({ ...prop, episodeNumbers: [...prop.episodeNumbers] }));
}

function projectTypeForResult(result: GeneralScriptResult): ShortDramaProjectType {
  if (result.profileId === "pet-silent-narration") return "pet_story";
  if (result.summary.performanceMode === "silent_narration") return "narrated_animation";
  return "short_drama";
}

export function mapGeneralScriptResultToProject(
  request: GeneralScriptProjectImportRequest,
): GeneralScriptProjectMapping {
  const promptAgentPayload: GeneralScriptPromptAgentPayload = {
    schemaVersion: request.result.schemaVersion,
    profileId: request.result.profileId,
    operation: request.result.operation,
    summary: cloneSummary(request.result.summary),
    episodes: cloneEpisodes(request.result.episodes),
    characters: cloneCharacters(request.result.characters),
    scenes: cloneScenes(request.result.scenes),
    props: cloneProps(request.result.props),
  };

  const sourcePayload: Record<string, JsonValue> = {
    schemaVersion: promptAgentPayload.schemaVersion,
    profileId: promptAgentPayload.profileId,
    operation: promptAgentPayload.operation,
    summary: promptAgentPayload.summary as unknown as Record<string, JsonValue>,
    episodes: promptAgentPayload.episodes as unknown as JsonValue[],
    characters: promptAgentPayload.characters as unknown as JsonValue[],
    scenes: promptAgentPayload.scenes as unknown as JsonValue[],
    props: promptAgentPayload.props as unknown as JsonValue[],
    episodeCount: promptAgentPayload.episodes.length,
    currentStage: "剧本",
    progress: 0,
    importContractVersion: GENERAL_SCRIPT_PROJECT_IMPORT_VERSION,
  };

  return {
    createRequest: {
      clientRequestId: request.clientRequestId,
      title: request.title,
      description: request.result.summary.oneSentence,
      projectType: projectTypeForResult(request.result),
      sourcePayload,
      settings: {
        aspectRatio: request.result.summary.videoSize,
        outputLanguage: "zh-CN",
        animationStyle: request.result.summary.animationStyle,
        noCharacterSpeech: request.result.summary.performanceMode === "silent_narration",
        defaultShotDurationSeconds: 5,
      },
    },
    promptAgentPayload,
  };
}

