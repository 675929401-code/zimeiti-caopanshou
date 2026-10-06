import type { StoryboardAgentOutputSegment } from "../storyboard-agent-output";
import {
  GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
  parseGeneralScriptResult,
  type GeneralScriptCharacter,
  type GeneralScriptEpisode,
  type GeneralScriptProp,
  type GeneralScriptResult,
  type GeneralScriptScene,
  type GeneralScriptVideoSize,
} from "./general-script-contract";
import { resolveVideoStylePrompt } from "./video-style-presets";

export const GENERAL_SCRIPT_STORYBOARD_BRIDGE_VERSION = "general-script-storyboard-bridge.v1";
export const GENERAL_SCRIPT_HANDOFF_STORAGE_KEY = "short_drama_general_script_handoff_v1";
export const GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY = "short_drama_general_script_handoff_consumed_v1";
export const GENERAL_SCRIPT_HANDOFF_RECEIPT_VERSION = "short-drama-storyboard-handoff-receipt.v1";
export const GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS = 2 * 60 * 1_000;

const GENERAL_SCRIPT_HANDOFF_SOURCE = "/tools/text/general-script";
const MAX_WORKBENCH_SEGMENTS = 20;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const WORKBENCH_RATIOS = ["16:9", "9:16", "1:1"] as const;

export type StoryboardWorkbenchRatio = (typeof WORKBENCH_RATIOS)[number];
export type AnimationReverseStoryBeat = "hook" | "trigger" | "escalation" | "cliffhanger" | "resolution";

export interface AnimationReversePackageSegmentV1 {
  segment_id: string;
  narration: string;
  semantic_job: string;
  story_beat: AnimationReverseStoryBeat;
  semantic_beat_count: number;
  panel_count: 4 | 5;
  layout: "two_by_two" | "two_by_two_plus_full_width";
  target_duration_seconds: 8 | 10 | 15;
  actual_shot_count: 2 | 3 | 4;
  image_prompt: string;
  video_prompt: string;
  packaging: {
    semantic_core: string;
    carrier: string;
    visual_action: string;
    effect_lifecycle: ["appear", "amplify", "collide", "resolve"];
  };
  validation: {
    source_episode_number: number;
    source_segment_index: number;
    source_segment_count: number;
    source_estimated_duration_seconds: number;
    image_prompt_visible_only: true;
    video_prompt_motion_only: true;
    panel_shot_decoupled: true;
    no_mouth_hard_constraint: "pass" | "not_applicable";
    human_review_required: true;
  };
}

export interface AnimationReversePackageV1 {
  schema_version: "1.0";
  artifact_type: "animation_reverse_package.v1";
  project_id: string;
  evidence: {
    sample_count: 0;
    coverage: [];
    limitations: string[];
  };
  production_grammar: {
    stable_grammar: string[];
    semantic_router: string[];
    one_off_device: [];
  };
  segments: AnimationReversePackageSegmentV1[];
  validation: {
    source_contract_gate: "pass";
    prompt_gate: "structural_pass";
    image_gate: "pending";
    video_gate: "locked";
    no_paid_execution: true;
    rollback_id: "";
  };
}

export interface GeneralScriptStoryboardBridge {
  schemaVersion: typeof GENERAL_SCRIPT_STORYBOARD_BRIDGE_VERSION;
  source: {
    schemaVersion: typeof GENERAL_SCRIPT_RESULT_SCHEMA_VERSION;
    profileId: GeneralScriptResult["profileId"];
  };
  preview: {
    title: string;
    episodeCount: number;
    segmentCount: number;
    aspectRatio: GeneralScriptVideoSize;
    animationStyle: string;
    performanceMode: GeneralScriptResult["summary"]["performanceMode"];
    silentNarration: boolean;
  };
  workbenchImport: {
    title: string;
    sourceAspectRatio: GeneralScriptVideoSize;
    workbenchRatio: StoryboardWorkbenchRatio | null;
    animationStyle: string;
    silentNarration: boolean;
    segments: StoryboardAgentOutputSegment[];
  };
  handoffMetadata: {
    animationReversePackage: AnimationReversePackageV1;
  };
}

export interface GeneralScriptHandoffReceipt {
  schemaVersion: typeof GENERAL_SCRIPT_HANDOFF_RECEIPT_VERSION;
  handoffId: string;
  packageProjectId: string;
  consumedAt: string;
}

export interface ParsedGeneralScriptStoryboardHandoff {
  handoffId: string;
  source: typeof GENERAL_SCRIPT_HANDOFF_SOURCE;
  savedAt: string;
  bridge: GeneralScriptStoryboardBridge;
}

export type GeneralScriptHandoffErrorCode =
  | "missing"
  | "malformed"
  | "expired"
  | "already_consumed";

export type GeneralScriptHandoffParseResult =
  | { ok: true; value: ParsedGeneralScriptStoryboardHandoff }
  | { ok: false; code: GeneralScriptHandoffErrorCode; error: string };

export class GeneralScriptStoryboardBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneralScriptStoryboardBridgeError";
  }
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
const CHARACTER_KEYS = ["id", "name", "role", "profile", "personality", "appearance", "voiceDirection"] as const;
const SCENE_KEYS = ["id", "name", "description", "time", "atmosphere", "episodeNumbers"] as const;
const PROP_KEYS = ["id", "name", "category", "description", "episodeNumbers"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: unknown, path: string, expectedKeys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new GeneralScriptStoryboardBridgeError(`${path} 必须是对象`);
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || extra.length) {
    const detail = [
      missing.length ? `缺少字段：${missing.join("、")}` : "",
      extra.length ? `包含未知字段：${extra.join("、")}` : "",
    ].filter(Boolean).join("；");
    throw new GeneralScriptStoryboardBridgeError(`${path} 不符合严格合同（${detail}）`);
  }
}

function assertStrictGeneralScriptResultShape(value: unknown): void {
  assertExactKeys(value, "result", RESULT_KEYS);
  assertExactKeys(value.summary, "result.summary", SUMMARY_KEYS);
  const collections = [
    { value: value.episodes, path: "result.episodes", keys: EPISODE_KEYS },
    { value: value.characters, path: "result.characters", keys: CHARACTER_KEYS },
    { value: value.scenes, path: "result.scenes", keys: SCENE_KEYS },
    { value: value.props, path: "result.props", keys: PROP_KEYS },
  ];
  for (const collection of collections) {
    if (!Array.isArray(collection.value)) {
      throw new GeneralScriptStoryboardBridgeError(`${collection.path} 必须是数组`);
    }
    collection.value.forEach((entry, index) => assertExactKeys(entry, `${collection.path}[${index}]`, collection.keys));
  }
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableLocalId(prefix: string, value: string): string {
  return `${prefix}-${fnv1a32(value)}${fnv1a32(Array.from(value).reverse().join(""))}`;
}

function compactText(value: string, maximum = 220): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trim()}…`;
}

function visiblePromptText(value: string): string {
  return compactText(value, 260)
    .replace(/[“"][^”"]*[”"]/gu, "角色以表情、动作和视线完成回应")
    .replace(/\d+(?:\.\d+)?\s*秒/gu, "短暂动作")
    .replace(/旁白|配音|对白|台词|音乐|音效|声音/gu, "可见叙事反馈")
    .replace(/开口(?:说话)?|说(?:道)?|喊(?:道)?|交谈|对话/gu, "以表情和动作表达")
    .replace(/\s+/gu, " ")
    .trim();
}

function partitionText(values: string[], count: number): string[] {
  const source = values.filter(Boolean);
  if (!source.length) return Array.from({ length: count }, () => "角色与场景形成清楚的可见动作关系");
  if (source.length < count) {
    return Array.from({ length: count }, (_, index) => source[Math.min(index, source.length - 1)]);
  }
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * source.length / count);
    const end = Math.floor((index + 1) * source.length / count);
    return source.slice(start, Math.max(start + 1, end)).join("，随后");
  });
}

function semanticNarrationSegments(content: string, segmentCount: number): string[] {
  const source = content.trim();
  if (segmentCount <= 1) return [source];
  if (source.length < segmentCount) {
    throw new GeneralScriptStoryboardBridgeError("单集文本过短，无法按时长拆成互不重复的生产段");
  }

  const cuts: number[] = [];
  let previous = 0;
  const sentenceBoundary = /[。！？!?；;]/u;
  const phraseBoundary = /[，,、：:\n]/u;
  for (let index = 1; index < segmentCount; index += 1) {
    const ideal = Math.round(source.length * index / segmentCount);
    const minimum = previous + 1;
    const maximum = source.length - (segmentCount - index);
    let best = Math.min(maximum, Math.max(minimum, ideal));
    let bestScore = Number.POSITIVE_INFINITY;
    const radius = Math.min(160, maximum - minimum);
    for (let offset = -radius; offset <= radius; offset += 1) {
      const candidate = ideal + offset;
      if (candidate < minimum || candidate > maximum) continue;
      const previousCharacter = source[candidate - 1] || "";
      const boundaryPenalty = sentenceBoundary.test(previousCharacter)
        ? 0
        : phraseBoundary.test(previousCharacter)
          ? 24
          : 80;
      const score = Math.abs(offset) + boundaryPenalty;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    cuts.push(best);
    previous = best;
  }

  const boundaries = [0, ...cuts, source.length];
  const segments = boundaries.slice(0, -1).map((start, index) => source.slice(start, boundaries[index + 1]).trim());
  if (segments.some((segment) => !segment)) {
    throw new GeneralScriptStoryboardBridgeError("单集文本无法形成非空的语义生产段");
  }
  return segments;
}

function productionSegmentCount(episode: GeneralScriptEpisode): number {
  return Math.min(6, Math.max(1, Math.ceil(episode.estimatedDurationSeconds / 15)));
}

function episodeSemanticBeats(
  episode: GeneralScriptEpisode,
  narration: string,
  segmentIndex: number,
  segmentCount: number,
): string[] {
  const fragments = [
    segmentIndex === 0 ? episode.logline : "",
    ...narration.split(/[\n。！？!?；;]+/u),
    segmentIndex === segmentCount - 1 ? episode.endingHook : "",
  ]
    .map(visiblePromptText)
    .filter(Boolean);
  return fragments.length ? fragments : [visiblePromptText(episode.title)];
}

function relevantCharacters(result: GeneralScriptResult, episode: GeneralScriptEpisode): GeneralScriptCharacter[] {
  const names = new Set(episode.characterNames);
  const matched = result.characters.filter((item) => names.has(item.name));
  return matched.length ? matched : result.characters;
}

function relevantScenes(result: GeneralScriptResult, episode: GeneralScriptEpisode): GeneralScriptScene[] {
  const names = new Set(episode.sceneNames);
  const matched = result.scenes.filter((item) => names.has(item.name) || item.episodeNumbers.includes(episode.episodeNumber));
  return matched.length ? matched : result.scenes;
}

function relevantProps(result: GeneralScriptResult, episode: GeneralScriptEpisode): GeneralScriptProp[] {
  const names = new Set(episode.propNames);
  const matched = result.props.filter((item) => names.has(item.name) || item.episodeNumbers.includes(episode.episodeNumber));
  return matched.length ? matched : result.props;
}

function characterBible(characters: GeneralScriptCharacter[]): string {
  if (!characters.length) return "角色外观、服装和身份跨格连续";
  return characters.map((item) => `${item.name}（${visiblePromptText(item.appearance)}；${visiblePromptText(item.personality)}）`).join("；");
}

function sceneBible(scenes: GeneralScriptScene[]): string {
  if (!scenes.length) return "场景空间关系与光线方向跨格连续";
  return scenes.map((item) => `${item.name}（${visiblePromptText(item.time)}，${visiblePromptText(item.description)}，${visiblePromptText(item.atmosphere)}）`).join("；");
}

function propBible(props: GeneralScriptProp[]): string {
  if (!props.length) return "使用当前故事中真实存在并有来路的核心道具";
  return props.map((item) => `${item.name}（${visiblePromptText(item.description)}）`).join("；");
}

function targetDuration(episode: GeneralScriptEpisode, segmentCount: number): 8 | 10 | 15 {
  const averageSegmentDuration = episode.estimatedDurationSeconds / segmentCount;
  if (averageSegmentDuration <= 8) return 8;
  if (averageSegmentDuration <= 10) return 10;
  return 15;
}

function actualShotCount(duration: 8 | 10 | 15): 2 | 3 | 4 {
  if (duration === 8) return 2;
  if (duration === 10) return 3;
  return 4;
}

function panelCountFor(
  result: GeneralScriptResult,
  episodeIndex: number,
  segmentIndex: number,
  segmentCount: number,
): 4 | 5 {
  const isLastEpisode = episodeIndex === result.episodes.length - 1;
  const isLastSegment = segmentIndex === segmentCount - 1;
  return result.summary.isFinale && isLastEpisode && isLastSegment ? 5 : 4;
}

function storyBeatFor(
  result: GeneralScriptResult,
  episodeIndex: number,
  segmentIndex: number,
  segmentCount: number,
): AnimationReverseStoryBeat {
  const isFirst = episodeIndex === 0 && segmentIndex === 0;
  const isLast = episodeIndex === result.episodes.length - 1 && segmentIndex === segmentCount - 1;
  if (isFirst && !isLast) return "hook";
  if (isLast) return result.summary.isFinale ? "resolution" : "cliffhanger";
  if (episodeIndex === 0 && segmentIndex === 1) return "trigger";
  return "escalation";
}

function imagePromptFor(
  result: GeneralScriptResult,
  episode: GeneralScriptEpisode,
  panelCount: 4 | 5,
  panelBeats: string[],
  silentNarration: boolean,
): string {
  const layout = panelCount === 4 ? "清楚的2×2布局" : "上方2×2四格加底部全宽第五格";
  const cameraPlans = ["中远景建立", "近中景触发", "侧向中景升级", "近景反应与收束", "全宽关系落点"];
  const panelLines = panelBeats.map((beat, index) => (
    `第${index + 1}格：${cameraPlans[index]}，定格一个动作峰值；${beat}。主体、关键表情、手势、道具与接触点完整可见，给下一动作保留方向和空间。`
  ));
  const silentLine = silentNarration
    ? "人物与宠物嘴部自然闭合，以表情、动作、视线和语义道具推进叙事。"
    : "角色表情、动作和视线关系清楚可读。";
  return [
    `画幅${result.summary.videoSize}，一张完整${panelCount}格动画故事板，${layout}，分隔线干净，面板边角清楚。`,
    `统一美术：${visiblePromptText(resolveVideoStylePrompt(result.summary.animationStyle))}。`,
    `统一角色资产：${characterBible(relevantCharacters(result, episode))}。`,
    `统一场景资产：${sceneBible(relevantScenes(result, episode))}。`,
    `语义道具：${propBible(relevantProps(result, episode))}。道具从场景或角色持有位置自然出现，接触关系清楚。`,
    ...panelLines,
    `${silentLine}全图保持角色、场景、道具、色彩和材质连续；每格只冻结一个可见瞬间。`,
  ].join("\n");
}

function videoPromptFor(
  result: GeneralScriptResult,
  episode: GeneralScriptEpisode,
  duration: 8 | 10 | 15,
  shotCount: 2 | 3 | 4,
  panelBeats: string[],
  silentNarration: boolean,
): string {
  const shotBeats = partitionText(panelBeats, shotCount);
  const cameraMoves = ["缓慢推近", "横向跟拍", "低机位短移后稳定", "轻微拉远并落幅"];
  const shotLines = shotBeats.map((beat, index) => {
    const start = (index * duration / shotCount).toFixed(1);
    const end = ((index + 1) * duration / shotCount).toFixed(1);
    const ending = index === shotCount - 1
      ? "动作减速，角色、核心道具和结果同框，稳定停留。"
      : "让视线、道具运动或环境反馈延续到下一镜。";
    return `${start}-${end}秒，镜头${index + 1}：${shotBeats[index]}；主体完成一个主动作，镜头${cameraMoves[index]}，道具发生明确接触并给出物理反馈，${ending}`;
  });
  const soundAndPerformance = silentNarration
    ? "人物与宠物嘴部自然闭合，以表情、动作、视线和语义道具推进；声轨只保留环境声和动作接触声，成片为后期旁白预留清楚空间。"
    : "角色动作与表情连续；声轨使用环境声、动作声和道具接触声。";
  return [
    `建议时长${duration}秒，画幅${result.summary.videoSize}，使用${shotCount}个真实镜头。以当前故事板为唯一视觉参考，沿用其中已有的统一美术、角色、场景、道具、材质、光影、综合色彩和动作方向，不另起美术设定。`,
    "实际镜头按动作因果组织，不按故事板面板逐格硬切；首镜从第一动作状态直接进入全屏场景。",
    ...shotLines,
    `${soundAndPerformance}结尾保留可见收束，不把分格线、说明条或故事板网格带入成片。`,
  ].join("\n");
}

function semanticJob(
  episode: GeneralScriptEpisode,
  narration: string,
  segmentIndex: number,
  segmentCount: number,
): string {
  if (segmentIndex === 0) return compactText(episode.logline || narration, 180);
  if (segmentIndex === segmentCount - 1) return compactText(episode.endingHook || narration, 180);
  return compactText(narration, 180);
}

function mapProductionSegment(
  result: GeneralScriptResult,
  episode: GeneralScriptEpisode,
  episodeIndex: number,
  narration: string,
  segmentIndex: number,
  segmentCount: number,
  sourceNumber: number,
  silentNarration: boolean,
): { agentSegment: StoryboardAgentOutputSegment; machineSegment: AnimationReversePackageSegmentV1 } {
  const rawBeats = episodeSemanticBeats(episode, narration, segmentIndex, segmentCount);
  const panelCount = panelCountFor(result, episodeIndex, segmentIndex, segmentCount);
  const panelBeats = partitionText(rawBeats, panelCount);
  const duration = targetDuration(episode, segmentCount);
  const shotCount = actualShotCount(duration);
  const imagePrompt = imagePromptFor(result, episode, panelCount, panelBeats, silentNarration);
  const videoPrompt = videoPromptFor(result, episode, duration, shotCount, panelBeats, silentNarration);
  const props = relevantProps(result, episode);
  const carrier = props[0]?.name || episode.sceneNames[0] || "角色视线与场景中的核心物件";

  return {
    agentSegment: {
      sourceNumber,
      narration,
      imagePrompt,
      videoPrompt,
    },
    machineSegment: {
      segment_id: `episode-${String(episode.episodeNumber).padStart(3, "0")}-segment-${String(segmentIndex + 1).padStart(2, "0")}`,
      narration,
      semantic_job: semanticJob(episode, narration, segmentIndex, segmentCount),
      story_beat: storyBeatFor(result, episodeIndex, segmentIndex, segmentCount),
      semantic_beat_count: rawBeats.length,
      panel_count: panelCount,
      layout: panelCount === 4 ? "two_by_two" : "two_by_two_plus_full_width",
      target_duration_seconds: duration,
      actual_shot_count: shotCount,
      image_prompt: imagePrompt,
      video_prompt: videoPrompt,
      packaging: {
        semantic_core: compactText(narration, 160),
        carrier,
        visual_action: "从可见来源进入画面，参与角色动作，在接触点形成反馈并于结尾收束",
        effect_lifecycle: ["appear", "amplify", "collide", "resolve"],
      },
      validation: {
        source_episode_number: episode.episodeNumber,
        source_segment_index: segmentIndex + 1,
        source_segment_count: segmentCount,
        source_estimated_duration_seconds: episode.estimatedDurationSeconds,
        image_prompt_visible_only: true,
        video_prompt_motion_only: true,
        panel_shot_decoupled: true,
        no_mouth_hard_constraint: silentNarration ? "pass" : "not_applicable",
        human_review_required: true,
      },
    },
  };
}

function isWorkbenchRatio(value: GeneralScriptVideoSize): value is StoryboardWorkbenchRatio {
  return (WORKBENCH_RATIOS as readonly string[]).includes(value);
}

export function bridgeGeneralScriptToStoryboard(value: unknown): GeneralScriptStoryboardBridge {
  assertStrictGeneralScriptResultShape(value);
  let result: GeneralScriptResult;
  try {
    result = parseGeneralScriptResult(value);
  } catch (error) {
    throw new GeneralScriptStoryboardBridgeError(error instanceof Error ? error.message : "通用短剧结果解析失败");
  }
  const plannedSegmentCount = result.episodes.reduce(
    (total, episode) => total + productionSegmentCount(episode),
    0,
  );
  if (plannedSegmentCount > MAX_WORKBENCH_SEGMENTS) {
    throw new GeneralScriptStoryboardBridgeError(
      `分镜工作台一次最多导入${MAX_WORKBENCH_SEGMENTS}个生产段；当前${result.episodes.length}集按时长需拆成${plannedSegmentCount}段，请按集分批发送，未进行截断`,
    );
  }

  const silentNarration = result.summary.performanceMode === "silent_narration";
  const mapped: Array<{
    agentSegment: StoryboardAgentOutputSegment;
    machineSegment: AnimationReversePackageSegmentV1;
  }> = [];
  let sourceNumber = 1;
  result.episodes.forEach((episode, episodeIndex) => {
    const segmentCount = productionSegmentCount(episode);
    const narrations = semanticNarrationSegments(episode.content, segmentCount);
    if (new Set(narrations).size !== narrations.length) {
      throw new GeneralScriptStoryboardBridgeError(
        `第${episode.episodeNumber}集拆分后出现重复生产段，请调整原文案后重试`,
      );
    }
    narrations.forEach((narration, segmentIndex) => {
      mapped.push(mapProductionSegment(
        result,
        episode,
        episodeIndex,
        narration,
        segmentIndex,
        segmentCount,
        sourceNumber,
        silentNarration,
      ));
      sourceNumber += 1;
    });
  });
  const projectSeed = JSON.stringify({
    schemaVersion: result.schemaVersion,
    profileId: result.profileId,
    title: result.summary.title,
    episodes: result.episodes,
  });
  const animationReversePackage: AnimationReversePackageV1 = {
    schema_version: "1.0",
    artifact_type: "animation_reverse_package.v1",
    project_id: stableLocalId("general-script", projectSeed),
    evidence: {
      sample_count: 0,
      coverage: [],
      limitations: ["本包由通用短剧结构确定性转换，尚未执行真实图片或视频审美验收"],
    },
    production_grammar: {
      stable_grammar: [
        "按单集预计时长与语义边界拆成独立生产段，每段保留不重复的原文案",
        "语义节拍、参考图面板和实际视频镜头数量相互独立",
        "生图提示词只描述可见画面，视频提示词只描述参考图如何动起来",
        "角色、场景和关键道具跨面板与镜头保持连续",
      ],
      semantic_router: [
        "按每集文本选择角色、场景、语义道具、动作峰值和收束状态",
        "语义道具必须有来源、接触点、物理反馈和结尾状态",
      ],
      one_off_device: [],
    },
    segments: mapped.map((entry) => entry.machineSegment),
    validation: {
      source_contract_gate: "pass",
      prompt_gate: "structural_pass",
      image_gate: "pending",
      video_gate: "locked",
      no_paid_execution: true,
      rollback_id: "",
    },
  };

  return {
    schemaVersion: GENERAL_SCRIPT_STORYBOARD_BRIDGE_VERSION,
    source: {
      schemaVersion: GENERAL_SCRIPT_RESULT_SCHEMA_VERSION,
      profileId: result.profileId,
    },
    preview: {
      title: result.summary.title,
      episodeCount: result.episodes.length,
      segmentCount: mapped.length,
      aspectRatio: result.summary.videoSize,
      animationStyle: result.summary.animationStyle,
      performanceMode: result.summary.performanceMode,
      silentNarration,
    },
    workbenchImport: {
      title: `通用短剧导入 · ${result.summary.title}`,
      sourceAspectRatio: result.summary.videoSize,
      workbenchRatio: isWorkbenchRatio(result.summary.videoSize) ? result.summary.videoSize : null,
      animationStyle: result.summary.animationStyle,
      silentNarration,
      segments: mapped.map((entry) => entry.agentSegment),
    },
    handoffMetadata: { animationReversePackage },
  };
}

function receiptFromRaw(raw: string | null | undefined): GeneralScriptHandoffReceipt | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    assertExactKeys(parsed, "receipt", ["schemaVersion", "handoffId", "packageProjectId", "consumedAt"]);
    if (
      parsed.schemaVersion !== GENERAL_SCRIPT_HANDOFF_RECEIPT_VERSION
      || typeof parsed.handoffId !== "string"
      || typeof parsed.packageProjectId !== "string"
      || typeof parsed.consumedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.consumedAt))
    ) return null;
    return parsed as unknown as GeneralScriptHandoffReceipt;
  } catch {
    return null;
  }
}

export function createGeneralScriptHandoffReceipt(
  handoff: ParsedGeneralScriptStoryboardHandoff,
  nowMs = Date.now(),
): GeneralScriptHandoffReceipt {
  return {
    schemaVersion: GENERAL_SCRIPT_HANDOFF_RECEIPT_VERSION,
    handoffId: handoff.handoffId,
    packageProjectId: handoff.bridge.handoffMetadata.animationReversePackage.project_id,
    consumedAt: new Date(nowMs).toISOString(),
  };
}

export function parseGeneralScriptStoryboardHandoff(
  raw: string | null | undefined,
  options: {
    nowMs?: number;
    maxAgeMs?: number;
    consumedReceiptRaw?: string | null;
  } = {},
): GeneralScriptHandoffParseResult {
  if (!raw) return { ok: false, code: "missing", error: "没有找到通用短剧交接数据，请返回通用短剧页面重新发送" };
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS;
  try {
    const envelope: unknown = JSON.parse(raw);
    assertExactKeys(envelope, "handoff", ["schemaVersion", "source", "savedAt", "result"]);
    if (envelope.schemaVersion !== GENERAL_SCRIPT_RESULT_SCHEMA_VERSION) {
      throw new GeneralScriptStoryboardBridgeError(`handoff.schemaVersion 必须为 ${GENERAL_SCRIPT_RESULT_SCHEMA_VERSION}`);
    }
    if (envelope.source !== GENERAL_SCRIPT_HANDOFF_SOURCE) {
      throw new GeneralScriptStoryboardBridgeError(`handoff.source 必须为 ${GENERAL_SCRIPT_HANDOFF_SOURCE}`);
    }
    if (typeof envelope.savedAt !== "string") {
      throw new GeneralScriptStoryboardBridgeError("handoff.savedAt 必须是 ISO 时间字符串");
    }
    const savedAtMs = Date.parse(envelope.savedAt);
    if (!Number.isFinite(savedAtMs) || new Date(savedAtMs).toISOString() !== envelope.savedAt) {
      throw new GeneralScriptStoryboardBridgeError("handoff.savedAt 不是有效的标准 ISO 时间");
    }
    if (savedAtMs - nowMs > FUTURE_CLOCK_SKEW_MS) {
      throw new GeneralScriptStoryboardBridgeError("handoff.savedAt 超出允许的本机时钟偏差");
    }
    if (nowMs - savedAtMs > maxAgeMs) {
      return { ok: false, code: "expired", error: "通用短剧交接已过期，请返回通用短剧页面重新确认发送" };
    }

    const bridge = bridgeGeneralScriptToStoryboard(envelope.result);
    const handoffId = stableLocalId("handoff", JSON.stringify({ savedAt: envelope.savedAt, result: envelope.result }));
    const receipt = receiptFromRaw(options.consumedReceiptRaw);
    if (receipt?.handoffId === handoffId) {
      return { ok: false, code: "already_consumed", error: "这份通用短剧结果已经确认导入过，未再次覆盖当前工作台" };
    }
    return {
      ok: true,
      value: {
        handoffId,
        source: GENERAL_SCRIPT_HANDOFF_SOURCE,
        savedAt: envelope.savedAt,
        bridge,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: "malformed",
      error: error instanceof Error ? `通用短剧交接数据损坏：${error.message}` : "通用短剧交接数据损坏",
    };
  }
}
