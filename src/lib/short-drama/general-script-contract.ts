export const GENERAL_SCRIPT_PROFILE_ID = "general-script";
export const DRAMA_SCRIPT_PROFILE_ID = "drama-script";
export const PET_SILENT_NARRATION_PROFILE_ID = "pet-silent-narration";
export const GENERAL_SCRIPT_PROFILE_VERSION = "1.0.0";
export const GENERAL_SCRIPT_CONTRACT_VERSION = "general-script-contract.v1";
export const GENERAL_SCRIPT_RESULT_SCHEMA_VERSION = "general-script-result.v1";

export const GENERAL_SCRIPT_PROFILE_IDS = [
  GENERAL_SCRIPT_PROFILE_ID,
  DRAMA_SCRIPT_PROFILE_ID,
  PET_SILENT_NARRATION_PROFILE_ID,
] as const;
export const GENERAL_SCRIPT_OPERATIONS = ["generate", "continue", "rewrite"] as const;
export const GENERAL_SCRIPT_CREATION_MODES = ["original", "adaptation"] as const;
export const GENERAL_SCRIPT_AUDIENCES = ["all_ages", "children", "teen", "adult"] as const;
export const GENERAL_SCRIPT_VIDEO_SIZES = ["9:16", "16:9", "1:1", "4:3"] as const;
export const GENERAL_SCRIPT_PERFORMANCE_MODES = ["dialogue", "silent_narration"] as const;
export const GENERAL_SCRIPT_TONES = [
  "emotional",
  "suspense",
  "comedy",
  "inspiring",
  "warm",
  "serious",
  "custom",
] as const;

export type GeneralScriptOperation = (typeof GENERAL_SCRIPT_OPERATIONS)[number];
export type GeneralScriptProfileId = (typeof GENERAL_SCRIPT_PROFILE_IDS)[number];
export type GeneralScriptCreationMode = (typeof GENERAL_SCRIPT_CREATION_MODES)[number];
export type GeneralScriptAudience = (typeof GENERAL_SCRIPT_AUDIENCES)[number];
export type GeneralScriptTone = (typeof GENERAL_SCRIPT_TONES)[number];
export type GeneralScriptVideoSize = (typeof GENERAL_SCRIPT_VIDEO_SIZES)[number];
export type GeneralScriptPerformanceMode = (typeof GENERAL_SCRIPT_PERFORMANCE_MODES)[number];

export interface GeneralScriptSettings {
  creationMode: GeneralScriptCreationMode;
  targetAudience: GeneralScriptAudience;
  tone: GeneralScriptTone;
  customTone: string;
  genre: string;
  animationStyle: string;
  videoSize: GeneralScriptVideoSize;
  episodesToGenerate: number;
  totalEpisodes: number | null;
  isFinale: boolean;
}

export interface GeneralScriptContentInput {
  title: string;
  brief: string;
  sourceMaterial: string;
  requirements: string;
}

export interface GeneralScriptSummary {
  title: string;
  protagonist: string;
  oneSentence: string;
  synopsis: string;
  genre: string;
  creationMode: GeneralScriptCreationMode;
  targetAudience: GeneralScriptAudience;
  tone: string;
  background: string;
  setting: string;
  animationStyle: string;
  videoSize: GeneralScriptVideoSize;
  performanceMode: GeneralScriptPerformanceMode;
  totalEpisodes: number | null;
  isFinale: boolean;
}

export interface GeneralScriptEpisode {
  episodeNumber: number;
  title: string;
  logline: string;
  content: string;
  endingHook: string;
  estimatedDurationSeconds: number;
  characterNames: string[];
  sceneNames: string[];
  propNames: string[];
}

export interface GeneralScriptCharacter {
  id: string;
  name: string;
  role: string;
  profile: string;
  personality: string;
  appearance: string;
  voiceDirection: string;
}

export interface GeneralScriptScene {
  id: string;
  name: string;
  description: string;
  time: string;
  atmosphere: string;
  episodeNumbers: number[];
}

export interface GeneralScriptProp {
  id: string;
  name: string;
  category: string;
  description: string;
  episodeNumbers: number[];
}

export interface GeneralScriptResult {
  schemaVersion: typeof GENERAL_SCRIPT_RESULT_SCHEMA_VERSION;
  profileId: GeneralScriptProfileId;
  operation: GeneralScriptOperation;
  summary: GeneralScriptSummary;
  episodes: GeneralScriptEpisode[];
  characters: GeneralScriptCharacter[];
  scenes: GeneralScriptScene[];
  props: GeneralScriptProp[];
}

export interface GeneralScriptRequest {
  profile: {
    id: GeneralScriptProfileId;
    version: typeof GENERAL_SCRIPT_PROFILE_VERSION;
  };
  operation: GeneralScriptOperation;
  settings: GeneralScriptSettings;
  content: GeneralScriptContentInput;
  existingResult?: GeneralScriptResult;
  rewriteEpisodeNumbers: number[];
  rewriteInstruction: string;
}

export interface GeneralScriptApiSuccess {
  ok: true;
  executionMode: "fixture" | "real";
  profile: {
    id: GeneralScriptProfileId;
    version: typeof GENERAL_SCRIPT_PROFILE_VERSION;
  };
  contractVersion: typeof GENERAL_SCRIPT_CONTRACT_VERSION;
  result: GeneralScriptResult;
}

export interface GeneralScriptApiError {
  ok: false;
  error: string;
  code: string;
}

export class GeneralScriptContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneralScriptContractError";
  }
}

const MAX_BRIEF_CHARS = 100_000;
const MAX_SOURCE_CHARS = 100_000;
const MAX_REQUIREMENTS_CHARS = 10_000;
const MAX_EPISODES_PER_REQUEST = 20;
const MAX_TOTAL_EPISODES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GeneralScriptContractError(path + " 必须是对象");
  }
  return value;
}

function expectString(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new GeneralScriptContractError(path + " 必须是字符串");
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw new GeneralScriptContractError(path + " 不能为空");
  }
  if (normalized.length > maxLength) {
    throw new GeneralScriptContractError(path + " 超过最大长度 " + maxLength);
  }
  return normalized;
}

function optionalString(value: unknown, path: string, maxLength: number): string {
  if (value === undefined || value === null || value === "") return "";
  return expectString(value, path, maxLength, true);
}

function expectInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new GeneralScriptContractError(
      path + " 必须是 " + minimum + " 到 " + maximum + " 之间的整数",
    );
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new GeneralScriptContractError(path + " 必须是布尔值");
  }
  return value;
}

function expectEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new GeneralScriptContractError(path + " 不是受支持的值");
  }
  return value as T[number];
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new GeneralScriptContractError(path + " 必须是字符串数组");
  }
  return value.map((item, index) => expectString(item, path + "[" + index + "]", 200));
}

function expectEpisodeNumberArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    throw new GeneralScriptContractError(path + " 必须是集数数组");
  }
  const numbers = value.map((item, index) =>
    expectInteger(item, path + "[" + index + "]", 1, MAX_TOTAL_EPISODES),
  );
  return Array.from(new Set(numbers)).sort((a, b) => a - b);
}

function parseSummary(value: unknown): GeneralScriptSummary {
  const input = expectRecord(value, "result.summary");
  const totalEpisodes = input.totalEpisodes === null
    ? null
    : expectInteger(input.totalEpisodes, "result.summary.totalEpisodes", 1, MAX_TOTAL_EPISODES);
  return {
    title: expectString(input.title, "result.summary.title", 200),
    protagonist: expectString(input.protagonist, "result.summary.protagonist", 500),
    oneSentence: expectString(input.oneSentence, "result.summary.oneSentence", 1_000),
    synopsis: expectString(input.synopsis, "result.summary.synopsis", 10_000),
    genre: expectString(input.genre, "result.summary.genre", 100),
    creationMode: expectEnum(
      input.creationMode,
      GENERAL_SCRIPT_CREATION_MODES,
      "result.summary.creationMode",
    ),
    targetAudience: expectEnum(
      input.targetAudience,
      GENERAL_SCRIPT_AUDIENCES,
      "result.summary.targetAudience",
    ),
    tone: expectString(input.tone, "result.summary.tone", 100),
    background: expectString(input.background, "result.summary.background", 2_000),
    setting: expectString(input.setting, "result.summary.setting", 2_000),
    animationStyle: expectString(input.animationStyle, "result.summary.animationStyle", 200),
    videoSize: expectEnum(
      input.videoSize,
      GENERAL_SCRIPT_VIDEO_SIZES,
      "result.summary.videoSize",
    ),
    performanceMode: expectEnum(
      input.performanceMode,
      GENERAL_SCRIPT_PERFORMANCE_MODES,
      "result.summary.performanceMode",
    ),
    totalEpisodes,
    isFinale: expectBoolean(input.isFinale, "result.summary.isFinale"),
  };
}

function parseEpisode(value: unknown, index: number): GeneralScriptEpisode {
  const path = "result.episodes[" + index + "]";
  const input = expectRecord(value, path);
  return {
    episodeNumber: expectInteger(input.episodeNumber, path + ".episodeNumber", 1, MAX_TOTAL_EPISODES),
    title: expectString(input.title, path + ".title", 200),
    logline: expectString(input.logline, path + ".logline", 1_000),
    content: expectString(input.content, path + ".content", 100_000),
    endingHook: expectString(input.endingHook, path + ".endingHook", 1_000, true),
    estimatedDurationSeconds: expectInteger(
      input.estimatedDurationSeconds,
      path + ".estimatedDurationSeconds",
      1,
      7_200,
    ),
    characterNames: expectStringArray(input.characterNames, path + ".characterNames"),
    sceneNames: expectStringArray(input.sceneNames, path + ".sceneNames"),
    propNames: expectStringArray(input.propNames, path + ".propNames"),
  };
}

function parseCharacter(value: unknown, index: number): GeneralScriptCharacter {
  const path = "result.characters[" + index + "]";
  const input = expectRecord(value, path);
  return {
    id: expectString(input.id, path + ".id", 100),
    name: expectString(input.name, path + ".name", 100),
    role: expectString(input.role, path + ".role", 100),
    profile: expectString(input.profile, path + ".profile", 2_000),
    personality: expectString(input.personality, path + ".personality", 1_000),
    appearance: expectString(input.appearance, path + ".appearance", 1_000),
    voiceDirection: expectString(input.voiceDirection, path + ".voiceDirection", 1_000),
  };
}

function parseScene(value: unknown, index: number): GeneralScriptScene {
  const path = "result.scenes[" + index + "]";
  const input = expectRecord(value, path);
  return {
    id: expectString(input.id, path + ".id", 100),
    name: expectString(input.name, path + ".name", 100),
    description: expectString(input.description, path + ".description", 2_000),
    time: expectString(input.time, path + ".time", 100),
    atmosphere: expectString(input.atmosphere, path + ".atmosphere", 500),
    episodeNumbers: expectEpisodeNumberArray(input.episodeNumbers, path + ".episodeNumbers"),
  };
}

function parseProp(value: unknown, index: number): GeneralScriptProp {
  const path = "result.props[" + index + "]";
  const input = expectRecord(value, path);
  return {
    id: expectString(input.id, path + ".id", 100),
    name: expectString(input.name, path + ".name", 100),
    category: expectString(input.category, path + ".category", 100),
    description: expectString(input.description, path + ".description", 1_000),
    episodeNumbers: expectEpisodeNumberArray(input.episodeNumbers, path + ".episodeNumbers"),
  };
}

export function parseGeneralScriptResult(value: unknown): GeneralScriptResult {
  const input = expectRecord(value, "result");
  if (input.schemaVersion !== GENERAL_SCRIPT_RESULT_SCHEMA_VERSION) {
    throw new GeneralScriptContractError(
      "result.schemaVersion 必须为 " + GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    );
  }
  if (!Array.isArray(input.episodes) || input.episodes.length === 0) {
    throw new GeneralScriptContractError("result.episodes 至少包含一集");
  }
  if (input.episodes.length > MAX_TOTAL_EPISODES) {
    throw new GeneralScriptContractError("result.episodes 超过最大集数");
  }
  if (!Array.isArray(input.characters) || !Array.isArray(input.scenes) || !Array.isArray(input.props)) {
    throw new GeneralScriptContractError("result 的 characters、scenes、props 必须是数组");
  }

  const episodes = input.episodes.map(parseEpisode);
  const episodeNumbers = new Set<number>();
  for (const episode of episodes) {
    if (episodeNumbers.has(episode.episodeNumber)) {
      throw new GeneralScriptContractError("result.episodes 存在重复集数");
    }
    episodeNumbers.add(episode.episodeNumber);
  }

  return {
    schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
    profileId: expectEnum(input.profileId, GENERAL_SCRIPT_PROFILE_IDS, "result.profileId"),
    operation: expectEnum(input.operation, GENERAL_SCRIPT_OPERATIONS, "result.operation"),
    summary: parseSummary(input.summary),
    episodes: episodes.sort((a, b) => a.episodeNumber - b.episodeNumber),
    characters: input.characters.map(parseCharacter),
    scenes: input.scenes.map(parseScene),
    props: input.props.map(parseProp),
  };
}

export function parseGeneralScriptRequest(value: unknown): GeneralScriptRequest {
  const input = expectRecord(value, "request");
  const profile = expectRecord(input.profile, "request.profile");
  if (
    profile.version !== GENERAL_SCRIPT_PROFILE_VERSION
  ) {
    throw new GeneralScriptContractError(
      "仅支持提示词配置版本 " + GENERAL_SCRIPT_PROFILE_VERSION,
    );
  }
  const profileId = expectEnum(profile.id, GENERAL_SCRIPT_PROFILE_IDS, "request.profile.id");

  const operation = expectEnum(input.operation, GENERAL_SCRIPT_OPERATIONS, "request.operation");
  const settingsInput = expectRecord(input.settings, "request.settings");
  const contentInput = expectRecord(input.content, "request.content");
  const totalEpisodes = settingsInput.totalEpisodes === null
    || settingsInput.totalEpisodes === undefined
    || settingsInput.totalEpisodes === ""
    ? null
    : expectInteger(
      settingsInput.totalEpisodes,
      "request.settings.totalEpisodes",
      1,
      MAX_TOTAL_EPISODES,
    );

  const settings: GeneralScriptSettings = {
    creationMode: expectEnum(
      settingsInput.creationMode,
      GENERAL_SCRIPT_CREATION_MODES,
      "request.settings.creationMode",
    ),
    targetAudience: expectEnum(
      settingsInput.targetAudience,
      GENERAL_SCRIPT_AUDIENCES,
      "request.settings.targetAudience",
    ),
    tone: expectEnum(settingsInput.tone, GENERAL_SCRIPT_TONES, "request.settings.tone"),
    customTone: optionalString(settingsInput.customTone, "request.settings.customTone", 100),
    genre: expectString(settingsInput.genre, "request.settings.genre", 100),
    animationStyle: expectString(
      settingsInput.animationStyle,
      "request.settings.animationStyle",
      200,
    ),
    videoSize: expectEnum(
      settingsInput.videoSize,
      GENERAL_SCRIPT_VIDEO_SIZES,
      "request.settings.videoSize",
    ),
    episodesToGenerate: expectInteger(
      settingsInput.episodesToGenerate,
      "request.settings.episodesToGenerate",
      1,
      MAX_EPISODES_PER_REQUEST,
    ),
    totalEpisodes,
    isFinale: expectBoolean(settingsInput.isFinale, "request.settings.isFinale"),
  };

  if (settings.tone === "custom" && !settings.customTone) {
    throw new GeneralScriptContractError("自定义基调不能为空");
  }

  const content: GeneralScriptContentInput = {
    title: optionalString(contentInput.title, "request.content.title", 200),
    brief: optionalString(contentInput.brief, "request.content.brief", MAX_BRIEF_CHARS),
    sourceMaterial: optionalString(
      contentInput.sourceMaterial,
      "request.content.sourceMaterial",
      MAX_SOURCE_CHARS,
    ),
    requirements: optionalString(
      contentInput.requirements,
      "request.content.requirements",
      MAX_REQUIREMENTS_CHARS,
    ),
  };

  if (!content.brief && !content.sourceMaterial) {
    throw new GeneralScriptContractError("故事需求或改编素材至少填写一项");
  }
  if (settings.creationMode === "adaptation" && !content.sourceMaterial) {
    throw new GeneralScriptContractError("素材改编模式必须提供改编素材");
  }

  const existingResult = input.existingResult === undefined || input.existingResult === null
    ? undefined
    : parseGeneralScriptResult(input.existingResult);
  const rewriteEpisodeNumbers = input.rewriteEpisodeNumbers === undefined
    ? []
    : expectEpisodeNumberArray(input.rewriteEpisodeNumbers, "request.rewriteEpisodeNumbers");
  const rewriteInstruction = optionalString(
    input.rewriteInstruction,
    "request.rewriteInstruction",
    MAX_REQUIREMENTS_CHARS,
  );

  if ((operation === "continue" || operation === "rewrite") && !existingResult) {
    throw new GeneralScriptContractError("续写或重写必须提供已有完整项目 JSON");
  }
  if (existingResult && existingResult.profileId !== profileId) {
    throw new GeneralScriptContractError("已有项目的 Prompt Profile 与当前项目类型不一致");
  }
  if (operation === "rewrite" && rewriteEpisodeNumbers.length === 0) {
    throw new GeneralScriptContractError("重写必须指定至少一集");
  }
  if (operation === "rewrite" && !rewriteInstruction) {
    throw new GeneralScriptContractError("重写要求不能为空");
  }

  const currentMax = existingResult
    ? Math.max(...existingResult.episodes.map((episode) => episode.episodeNumber))
    : 0;
  const projectedMax = operation === "rewrite"
    ? currentMax
    : currentMax + settings.episodesToGenerate;
  if (totalEpisodes !== null && totalEpisodes < currentMax) {
    throw new GeneralScriptContractError("总集数不能小于已有项目的最大集数");
  }
  if (operation !== "rewrite" && totalEpisodes !== null && projectedMax > totalEpisodes) {
    throw new GeneralScriptContractError("本次生成会超过设定总集数");
  }
  if (
    operation !== "rewrite"
    && settings.isFinale
    && totalEpisodes !== null
    && projectedMax !== totalEpisodes
  ) {
    throw new GeneralScriptContractError("标记本次完结时，本次最后一集必须等于总集数");
  }
  if (
    operation === "rewrite"
    && rewriteEpisodeNumbers.some((number) => !existingResult?.episodes.some(
      (episode) => episode.episodeNumber === number,
    ))
  ) {
    throw new GeneralScriptContractError("重写集数必须存在于已有项目中");
  }

  return {
    profile: {
      id: profileId,
      version: GENERAL_SCRIPT_PROFILE_VERSION,
    },
    operation,
    settings,
    content,
    existingResult,
    rewriteEpisodeNumbers,
    rewriteInstruction,
  };
}

export function validateGeneralScriptResultForRequest(
  request: GeneralScriptRequest,
  result: GeneralScriptResult,
): GeneralScriptResult {
  if (result.profileId !== request.profile.id) {
    throw new GeneralScriptContractError("result.profileId 与本次 Prompt Profile 不一致");
  }
  if (result.operation !== request.operation) {
    throw new GeneralScriptContractError("result.operation 与本次任务不一致");
  }
  if (result.summary.creationMode !== request.settings.creationMode) {
    throw new GeneralScriptContractError("summary.creationMode 与请求不一致");
  }
  if (result.summary.targetAudience !== request.settings.targetAudience) {
    throw new GeneralScriptContractError("summary.targetAudience 与请求不一致");
  }
  if (result.summary.animationStyle !== request.settings.animationStyle) {
    throw new GeneralScriptContractError("summary.animationStyle 与请求不一致");
  }
  if (result.summary.videoSize !== request.settings.videoSize) {
    throw new GeneralScriptContractError("summary.videoSize 与请求不一致");
  }
  if (result.summary.genre !== request.settings.genre) {
    throw new GeneralScriptContractError("summary.genre 与请求不一致");
  }
  if (result.summary.totalEpisodes !== request.settings.totalEpisodes) {
    throw new GeneralScriptContractError("summary.totalEpisodes 与请求不一致");
  }
  if (result.summary.isFinale !== request.settings.isFinale) {
    throw new GeneralScriptContractError("summary.isFinale 与请求不一致");
  }

  const expectedPerformanceMode = request.profile.id === PET_SILENT_NARRATION_PROFILE_ID
    ? "silent_narration"
    : "dialogue";
  if (result.summary.performanceMode !== expectedPerformanceMode) {
    throw new GeneralScriptContractError("summary.performanceMode 与项目类型不一致");
  }

  const resultNumbers = result.episodes.map((episode) => episode.episodeNumber);
  const resultNumberSet = new Set(resultNumbers);
  if (request.operation === "generate") {
    const expected = Array.from(
      { length: request.settings.episodesToGenerate },
      (_, index) => index + 1,
    );
    if (
      resultNumbers.length !== expected.length
      || expected.some((number) => !resultNumberSet.has(number))
    ) {
      throw new GeneralScriptContractError("初次生成的剧集数量或编号不符合请求");
    }
  }

  if (request.operation === "continue" && request.existingResult) {
    const existingNumbers = request.existingResult.episodes.map(
      (episode) => episode.episodeNumber,
    );
    const currentMax = Math.max(...existingNumbers);
    const expectedNew = Array.from(
      { length: request.settings.episodesToGenerate },
      (_, index) => currentMax + index + 1,
    );
    if (
      existingNumbers.some((number) => !resultNumberSet.has(number))
      || expectedNew.some((number) => !resultNumberSet.has(number))
      || resultNumbers.length !== existingNumbers.length + expectedNew.length
    ) {
      throw new GeneralScriptContractError("续写结果没有完整保留旧集或新增集数不正确");
    }
  }

  if (request.operation === "rewrite" && request.existingResult) {
    const existingNumbers = request.existingResult.episodes.map(
      (episode) => episode.episodeNumber,
    );
    if (
      resultNumbers.length !== existingNumbers.length
      || existingNumbers.some((number) => !resultNumberSet.has(number))
    ) {
      throw new GeneralScriptContractError("重写结果必须保留原项目的完整集数集合");
    }
  }

  if (
    request.settings.totalEpisodes !== null
    && resultNumbers.some((number) => number > request.settings.totalEpisodes!)
  ) {
    throw new GeneralScriptContractError("结果包含超过总集数的剧集");
  }

  const characterNames = new Set(result.characters.map((item) => item.name));
  const sceneMap = new Map(result.scenes.map((item) => [item.name, item]));
  const propMap = new Map(result.props.map((item) => [item.name, item]));
  for (const episode of result.episodes) {
    if (episode.characterNames.some((name) => !characterNames.has(name))) {
      throw new GeneralScriptContractError("剧集引用了不存在的角色");
    }
    for (const name of episode.sceneNames) {
      const scene = sceneMap.get(name);
      if (!scene || !scene.episodeNumbers.includes(episode.episodeNumber)) {
        throw new GeneralScriptContractError("剧集与场景的双向引用不一致");
      }
    }
    for (const name of episode.propNames) {
      const prop = propMap.get(name);
      if (!prop || !prop.episodeNumbers.includes(episode.episodeNumber)) {
        throw new GeneralScriptContractError("剧集与道具的双向引用不一致");
      }
    }
  }

  if (request.profile.id === PET_SILENT_NARRATION_PROFILE_ID) {
    for (const character of result.characters) {
      const direction = character.voiceDirection;
      if (!direction.includes("不") || !direction.includes("口型") || !direction.includes("旁白")) {
        throw new GeneralScriptContractError(
          "宠物无口型项目的角色 voiceDirection 必须明确无口型与后期旁白",
        );
      }
    }
    for (const episode of result.episodes) {
      if (!episode.content.includes("【后期旁白】")) {
        throw new GeneralScriptContractError("宠物无口型项目的每集必须包含后期旁白标记");
      }
      for (const name of episode.characterNames) {
        const escapedName = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
        if (new RegExp("(^|\\n)\\s*" + escapedName + "\\s*[：:]", "m").test(episode.content)) {
          throw new GeneralScriptContractError("宠物无口型项目不得包含角色对白行");
        }
      }
    }
  }

  return result;
}
