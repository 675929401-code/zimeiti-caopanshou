import type { AgentPresetField } from "@/lib/agent-preset-schema";

export const STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION = "storyboard_director_input.v1" as const;
export const STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION = "storyboard_director_output.v1" as const;
export const STORYBOARD_DIRECTOR_ARTIFACT_TYPE = "storyboard_director_package" as const;

export const STORYBOARD_DIRECTOR_MODES = [
  "high_energy",
  "cinematic",
  "lyrical",
] as const;

export type StoryboardDirectorMode = typeof STORYBOARD_DIRECTOR_MODES[number];

export const STORYBOARD_DIRECTOR_MODE_LABELS: Record<StoryboardDirectorMode, string> = {
  high_energy: "高能夸张",
  cinematic: "电影叙事",
  lyrical: "抒情情感",
};

export const STORYBOARD_LAYOUTS = [
  "two_by_two",
  "four_plus_panorama",
] as const;

export const STORYBOARD_PACING_MODES = [
  "slow",
  "medium",
  "fast",
] as const;

export const STORYBOARD_TARGET_DURATIONS = [8, 10, 15] as const;

export type StoryboardLayout = typeof STORYBOARD_LAYOUTS[number];
export type StoryboardPacingMode = typeof STORYBOARD_PACING_MODES[number];
export type StoryboardTargetDurationSeconds = typeof STORYBOARD_TARGET_DURATIONS[number];
export type StoryboardActualShotCount = 1 | 2 | 3 | 4 | 5;

export const STORYBOARD_3D_STYLES = [
  "电影级高能3D动画喜剧",
  "童话奇幻3D动画",
  "欧美反差3D动画喜剧",
  "高饱和萌宠3D动画喜剧",
  "温暖家庭3D动画电影",
  "电影级风格化半写实3D",
  "手工黏土定格3D动画",
  "Q版收藏玩具3D动画",
  "东方国潮3D动画电影",
  "未来科技3D动画",
] as const;

export const STORYBOARD_DIRECTOR_PRESET_FIELDS: AgentPresetField[] = [
  {
    id: "segmented_script",
    label: "已分段口播文案",
    type: "textarea",
    placeholder: "例如：1.【第一段……】\n2.【第二段……】",
    required: true,
    options: [],
    order: 0,
    sendLabel: true,
    sendText: "segmented_script",
    description: "保留段落编号、边界、顺序和原字，不重新拆段。",
  },
  {
    id: "director_mode",
    label: "故事版导演",
    type: "select",
    placeholder: "选择导演版本",
    required: true,
    options: STORYBOARD_DIRECTOR_MODES.map((mode) => STORYBOARD_DIRECTOR_MODE_LABELS[mode]),
    order: 1,
    defaultValue: STORYBOARD_DIRECTOR_MODE_LABELS.high_energy,
    sendLabel: true,
    sendText: "director_mode",
    description: "高能夸张、电影叙事、抒情情感共用稳定结构协议，只改变表演、镜头和节奏取舍。",
  },
  {
    id: "animation_style",
    label: "3D动画风格",
    type: "select",
    placeholder: "选择全片统一的3D动画风格",
    required: true,
    options: [...STORYBOARD_3D_STYLES],
    order: 2,
    sendLabel: true,
    sendText: "animation_style",
  },
  {
    id: "aspect_ratio",
    label: "画面尺寸",
    type: "select",
    placeholder: "选择横屏或竖屏",
    required: true,
    options: ["16:9", "9:16"],
    order: 3,
    sendLabel: true,
    sendText: "aspect_ratio",
  },
  {
    id: "target_duration_seconds",
    label: "目标视频时长",
    type: "select",
    placeholder: "选择 8、10 或 15 秒",
    required: true,
    options: ["8", "10", "15"],
    order: 4,
    defaultValue: "10",
    sendLabel: true,
    sendText: "target_duration_seconds",
    description: "默认 10 秒；8秒更短更冲，10秒标准高能，15秒增加升级爆点；时长影响表演容量和镜头节奏，不机械决定镜头数。",
  },
  {
    id: "special_notes",
    label: "特殊备注",
    type: "textarea",
    placeholder: "选填：角色品种、年龄、毛色、服装、真实产品参考、禁用内容等。",
    required: false,
    options: [],
    order: 5,
    sendLabel: true,
    sendText: "special_notes",
    description: "只有这里明确要求时才绑定外部角色或产品参考资产。",
  },
];

export interface StoryboardDirectorInput {
  schema_version: typeof STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION;
  segmented_script: string;
  director_mode: StoryboardDirectorMode;
  animation_style: string;
  aspect_ratio: "16:9" | "9:16";
  target_duration_seconds: StoryboardTargetDurationSeconds;
  special_notes: string;
}

export interface StoryboardScriptSegment {
  segment_id: string;
  source_index: number;
  narration: string;
}

export interface StoryboardSemanticVisualization {
  trigger: string;
  visual_form: string;
  interaction: string;
}

export interface StoryboardShotTimeRange {
  shot_id: string;
  start_seconds: number;
  end_seconds: number;
  action_beat: string;
}

export interface StoryboardContinuityLink {
  from_shot: string;
  to_shot: string;
  link_type: string;
  description: string;
}

export type StoryboardVisualAssetRefRole = "character" | "pet" | "environment" | "prop";
export type StoryboardVisualAssetReferenceKind = "turnaround" | "identity" | "environment-wide" | "environment-angle" | "detail" | "prop";

/**
 * Stable JSON form of a visual-asset binding.  The canvas converts this
 * snake_case transport shape to the workbench's camelCase persistence shape.
 * It is optional so older v1 packages remain fully compatible.
 */
export interface StoryboardDirectorVisualAssetRef {
  asset_id: string;
  role: StoryboardVisualAssetRefRole;
  reference_kinds: StoryboardVisualAssetReferenceKind[];
}

export interface StoryboardDirectorSegmentOutput extends StoryboardScriptSegment {
  target_duration_seconds: StoryboardTargetDurationSeconds;
  estimated_narration_duration: number;
  panel_count: 4 | 5;
  layout: StoryboardLayout;
  pacing_mode: StoryboardPacingMode;
  actual_shot_count: StoryboardActualShotCount;
  shot_time_ranges: StoryboardShotTimeRange[];
  panoramic_anchor_role: string | null;
  continuity_links: StoryboardContinuityLink[];
  character_assets: string[];
  visual_asset_refs?: StoryboardDirectorVisualAssetRef[];
  semantic_visualizations: StoryboardSemanticVisualization[];
  storyboard_image_prompt: string;
  image_to_video_prompt: string;
}

export interface StoryboardDirectorPackage {
  schema_version: typeof STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION;
  artifact_type: typeof STORYBOARD_DIRECTOR_ARTIFACT_TYPE;
  director_mode: StoryboardDirectorMode;
  input: StoryboardDirectorInput;
  segments: StoryboardDirectorSegmentOutput[];
}

type UnknownRecord = Record<string, unknown>;

const VISUAL_ASSET_REF_ROLES = new Set<StoryboardVisualAssetRefRole>(["character", "pet", "environment", "prop"]);
const VISUAL_ASSET_REFERENCE_KINDS = new Set<StoryboardVisualAssetReferenceKind>([
  "turnaround",
  "identity",
  "environment-wide",
  "environment-angle",
  "detail",
  "prop",
]);

function normalizeVisualAssetRefs(value: unknown): StoryboardDirectorVisualAssetRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const refs = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const assetId = String(item.asset_id ?? "").trim();
    const role = String(item.role ?? "").trim() as StoryboardVisualAssetRefRole;
    const referenceKinds = Array.isArray(item.reference_kinds)
      ? item.reference_kinds.map((kind) => String(kind).trim() as StoryboardVisualAssetReferenceKind)
      : [];
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(assetId)
      || !VISUAL_ASSET_REF_ROLES.has(role)
      || referenceKinds.length < 1
      || referenceKinds.length > 4
      || referenceKinds.some((kind) => !VISUAL_ASSET_REFERENCE_KINDS.has(kind))) {
      return [];
    }
    return [{ asset_id: assetId, role, reference_kinds: referenceKinds }];
  });
  return refs.length === value.length ? refs : [];
}

const INPUT_ALIASES = {
  segmented_script: ["segmented_script", "storyboard_segmented_copy", "segmented_copy", "分段文案"],
  director_mode: ["director_mode", "storyboard_director_mode", "导演版本", "故事版导演"],
  animation_style: ["animation_style", "storyboard_visual_style", "visual_style", "动画风格", "画面风格"],
  aspect_ratio: ["aspect_ratio", "storyboard_aspect_ratio", "ratio", "画面尺寸", "生图比例"],
  target_duration_seconds: ["target_duration_seconds", "storyboard_target_duration_seconds", "target_duration", "duration_seconds", "目标视频时长", "视频时长", "时长"],
  special_notes: ["special_notes", "storyboard_special_requirements", "special_requirements", "特殊备注", "特殊要求"],
  legacy_character: ["storyboard_character_setting", "character_setting", "角色设定"],
} as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(source: UnknownRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeRatio(value: string): "16:9" | "9:16" {
  return value.includes("9:16") ? "9:16" : "16:9";
}

function normalizeTargetDuration(value: unknown): StoryboardTargetDurationSeconds {
  const parsed = Number(String(value ?? "").match(/\d+/)?.[0]);
  return (STORYBOARD_TARGET_DURATIONS as readonly number[]).includes(parsed)
    ? parsed as StoryboardTargetDurationSeconds
    : 10;
}

function normalizeDirectorMode(value: unknown): StoryboardDirectorMode {
  const normalized = String(value ?? "").trim();
  if ((STORYBOARD_DIRECTOR_MODES as readonly string[]).includes(normalized)) {
    return normalized as StoryboardDirectorMode;
  }
  const entry = (Object.entries(STORYBOARD_DIRECTOR_MODE_LABELS) as Array<[StoryboardDirectorMode, string]>)
    .find(([, label]) => label === normalized);
  return entry?.[0] ?? "high_energy";
}

/** Accepts stable v1 IDs, legacy storyboard IDs, and common Chinese labels. */
export function normalizeStoryboardDirectorInput(input: unknown): StoryboardDirectorInput {
  const source = isRecord(input) ? input : {};
  const specialNotes = firstString(source, INPUT_ALIASES.special_notes);
  const legacyCharacter = firstString(source, INPUT_ALIASES.legacy_character);
  return {
    schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
    segmented_script: firstString(source, INPUT_ALIASES.segmented_script),
    director_mode: normalizeDirectorMode(firstValue(source, INPUT_ALIASES.director_mode)),
    animation_style: firstString(source, INPUT_ALIASES.animation_style) || STORYBOARD_3D_STYLES[0],
    aspect_ratio: normalizeRatio(firstString(source, INPUT_ALIASES.aspect_ratio)),
    target_duration_seconds: normalizeTargetDuration(firstValue(source, INPUT_ALIASES.target_duration_seconds)),
    special_notes: [legacyCharacter, specialNotes].filter(Boolean).join("；"),
  };
}

export function estimateNarrationDuration(narration: string): number {
  const compact = narration.replace(/\s+/g, "");
  const spokenCharacters = [...compact.replace(/[，。！？；：、,.!?;:“”‘’'"（）()【】\[\]]/g, "")].length;
  const pauseMarks = (compact.match(/[。！？!?；;]/g) ?? []).length;
  const pauseSeconds = Math.min(0.8, 0.3 + Math.max(0, pauseMarks - 1) * 0.1);
  return Math.round((spokenCharacters / 6 + pauseSeconds) * 10) / 10;
}

export function narrationExceedsGenerationUnit(
  narration: string,
  duration: StoryboardTargetDurationSeconds,
): boolean {
  return estimateNarrationDuration(narration) > duration + 0.8;
}

const SHOT_COUNT_RULES: Record<StoryboardTargetDurationSeconds, Record<StoryboardDirectorMode, readonly [number, number, StoryboardActualShotCount]>> = {
  8: {
    high_energy: [2, 3, 3],
    cinematic: [2, 3, 2],
    lyrical: [1, 2, 1],
  },
  10: {
    high_energy: [3, 4, 4],
    cinematic: [2, 3, 3],
    lyrical: [1, 2, 2],
  },
  15: {
    high_energy: [4, 5, 5],
    cinematic: [3, 4, 4],
    lyrical: [2, 3, 3],
  },
};

export function storyboardShotCountRule(
  duration: StoryboardTargetDurationSeconds,
  mode: StoryboardDirectorMode,
): { min: number; max: number; defaultCount: StoryboardActualShotCount } {
  const [min, max, defaultCount] = SHOT_COUNT_RULES[duration][mode];
  return { min, max, defaultCount };
}

export function parseSegmentedScript(text: string): StoryboardScriptSegment[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const starts = [...normalized.matchAll(/(?:^|\n)\s*(\d+)\s*[.、]\s*/g)];
  if (starts.length === 0) {
    return [{ segment_id: "segment_001", source_index: 1, narration: normalized }];
  }

  return starts.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? normalized.length;
    const narration = normalized
      .slice(start, end)
      .trim()
      .replace(/^【/, "")
      .replace(/】\s*$/, "")
      .trim();
    if (!narration) return [];
    const sourceIndex = Number(match[1]);
    return [{
      segment_id: `segment_${String(sourceIndex).padStart(3, "0")}`,
      source_index: sourceIndex,
      narration,
    }];
  });
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function findMachinePayload(text: string): unknown | null {
  const direct = parseJson(text);
  if (direct) return direct;

  const marker = text.match(/<!--\s*storyboard_director_output:v1\s*([\s\S]*?)-->/i);
  if (marker) {
    const parsed = parseJson(marker[1]);
    if (parsed) return parsed;
  }

  for (const match of text.matchAll(/(`{3,})json\s*\n?([\s\S]*?)\n?\1/gi)) {
    const parsed = parseJson(match[2]);
    if (parsed) return parsed;
  }
  return null;
}

function isDirectorMode(value: unknown): value is StoryboardDirectorMode {
  return typeof value === "string"
    && (STORYBOARD_DIRECTOR_MODES as readonly string[]).includes(value);
}

function isStoryboardLayout(value: unknown): value is StoryboardLayout {
  return typeof value === "string"
    && (STORYBOARD_LAYOUTS as readonly string[]).includes(value);
}

function isPacingMode(value: unknown): value is StoryboardPacingMode {
  return typeof value === "string"
    && (STORYBOARD_PACING_MODES as readonly string[]).includes(value);
}

function defaultPacingMode(mode: StoryboardDirectorMode): StoryboardPacingMode {
  if (mode === "high_energy") return "fast";
  if (mode === "lyrical") return "slow";
  return "medium";
}

function normalizeSemanticVisualizations(value: unknown): StoryboardSemanticVisualization[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const trigger = String(item.trigger ?? "").trim();
    const visualForm = String(item.visual_form ?? item.visualForm ?? "").trim();
    const interaction = String(item.interaction ?? "").trim();
    return trigger && visualForm && interaction
      ? [{ trigger, visual_form: visualForm, interaction }]
      : [];
  });
}

function roundedTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function fallbackShotTimeRanges(
  count: StoryboardActualShotCount,
  duration: StoryboardTargetDurationSeconds,
): StoryboardShotTimeRange[] {
  return Array.from({ length: count }, (_, index) => ({
    shot_id: `shot_${String(index + 1).padStart(2, "0")}`,
    start_seconds: roundedTenth(index * duration / count),
    end_seconds: roundedTenth((index + 1) * duration / count),
    action_beat: `兼容旧输出：第${index + 1}镜动作节拍未单列`,
  }));
}

function normalizeShotTimeRanges(
  value: unknown,
  count: StoryboardActualShotCount,
  duration: StoryboardTargetDurationSeconds,
): StoryboardShotTimeRange[] {
  if (!Array.isArray(value) || value.length !== count) {
    return fallbackShotTimeRanges(count, duration);
  }
  const parsed = value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const start = Number(item.start_seconds ?? item.start);
    const end = Number(item.end_seconds ?? item.end);
    const actionBeat = String(item.action_beat ?? item.beat ?? item.action ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !actionBeat) return [];
    return [{
      shot_id: String(item.shot_id ?? item.id ?? `shot_${String(index + 1).padStart(2, "0")}`),
      start_seconds: roundedTenth(start),
      end_seconds: roundedTenth(end),
      action_beat: actionBeat,
    }];
  });
  return parsed.length === count ? parsed : fallbackShotTimeRanges(count, duration);
}

function fallbackContinuityLinks(count: StoryboardActualShotCount): StoryboardContinuityLink[] {
  return Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    from_shot: `shot_${String(index + 1).padStart(2, "0")}`,
    to_shot: `shot_${String(index + 2).padStart(2, "0")}`,
    link_type: "legacy_continuity",
    description: "兼容旧输出：沿主体运动方向与视线连续衔接",
  }));
}

function normalizeContinuityLinks(
  value: unknown,
  count: StoryboardActualShotCount,
): StoryboardContinuityLink[] {
  if (!Array.isArray(value)) return fallbackContinuityLinks(count);
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const fromShot = String(item.from_shot ?? item.from ?? "").trim();
    const toShot = String(item.to_shot ?? item.to ?? "").trim();
    const linkType = String(item.link_type ?? item.type ?? "").trim();
    const description = String(item.description ?? item.link ?? "").trim();
    return fromShot && toShot && linkType && description
      ? [{ from_shot: fromShot, to_shot: toShot, link_type: linkType, description }]
      : [];
  });
}

export function parseStoryboardDirectorPackage(text: string): StoryboardDirectorPackage | null {
  const parsed = findMachinePayload(text);
  if (!isRecord(parsed)) return null;
  const source = isRecord(parsed.package) ? parsed.package : parsed;
  if (source.schema_version !== STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION
    || source.artifact_type !== STORYBOARD_DIRECTOR_ARTIFACT_TYPE
    || !isDirectorMode(source.director_mode)
    || !Array.isArray(source.segments)) {
    return null;
  }

  const input = normalizeStoryboardDirectorInput(source.input);
  const directorMode = source.director_mode;
  input.director_mode = directorMode;
  const segments = source.segments.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const narration = String(item.narration ?? "").trim();
    const imagePrompt = String(item.storyboard_image_prompt ?? "").trim();
    const videoPrompt = String(item.image_to_video_prompt ?? "").trim();
    const panelCount = Number(item.panel_count ?? item.frame_count);
    if (!narration || !imagePrompt || !videoPrompt || (panelCount !== 4 && panelCount !== 5)) {
      return [];
    }
    const layout = isStoryboardLayout(item.layout)
      ? item.layout
      : panelCount === 5 ? "four_plus_panorama" : "two_by_two";
    const pacingMode = isPacingMode(item.pacing_mode)
      ? item.pacing_mode
      : defaultPacingMode(directorMode);
    const targetDuration = normalizeTargetDuration(item.target_duration_seconds ?? input.target_duration_seconds);
    const shotRule = storyboardShotCountRule(targetDuration, directorMode);
    const requestedShotCount = Number(item.actual_shot_count);
    const actualShotCount = requestedShotCount >= 1 && requestedShotCount <= 5
      ? requestedShotCount as StoryboardActualShotCount
      : shotRule.defaultCount;
    const sourceIndex = Number(item.source_index) || index + 1;
    const estimatedNarrationDuration = Number(item.estimated_narration_duration);
    if (item.visual_asset_refs !== undefined && !Array.isArray(item.visual_asset_refs)) return [];
    const visualAssetRefs = normalizeVisualAssetRefs(item.visual_asset_refs);
    if (Array.isArray(item.visual_asset_refs) && visualAssetRefs?.length !== item.visual_asset_refs.length) return [];
    return [{
      segment_id: String(item.segment_id ?? `segment_${String(sourceIndex).padStart(3, "0")}`),
      source_index: sourceIndex,
      narration,
      target_duration_seconds: targetDuration,
      estimated_narration_duration: Number.isFinite(estimatedNarrationDuration) && estimatedNarrationDuration > 0
        ? roundedTenth(estimatedNarrationDuration)
        : estimateNarrationDuration(narration),
      panel_count: panelCount as 4 | 5,
      layout,
      pacing_mode: pacingMode,
      actual_shot_count: actualShotCount,
      shot_time_ranges: normalizeShotTimeRanges(item.shot_time_ranges, actualShotCount, targetDuration),
      panoramic_anchor_role: panelCount === 4
        ? null
        : String(item.panoramic_anchor_role ?? "legacy_unspecified").trim() || "legacy_unspecified",
      continuity_links: normalizeContinuityLinks(item.continuity_links, actualShotCount),
      character_assets: Array.isArray(item.character_assets)
        ? item.character_assets.map(String).map((value) => value.trim()).filter(Boolean)
        : [],
      ...(visualAssetRefs ? { visual_asset_refs: visualAssetRefs } : {}),
      semantic_visualizations: normalizeSemanticVisualizations(item.semantic_visualizations),
      storyboard_image_prompt: imagePrompt,
      image_to_video_prompt: videoPrompt,
    }];
  });

  if (segments.length !== source.segments.length) return null;
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: directorMode,
    input,
    segments,
  };
}

export function renderStoryboardDirectorPackage(pkg: StoryboardDirectorPackage): string {
  const fenced = (language: "text" | "json", value: string) => {
    const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}${language}\n${value}\n${fence}`;
  };
  const sections = pkg.segments.map((segment) => [
    `**段落 ${segment.source_index}**：${segment.narration}`,
    "",
    `**生图 Prompt（${segment.panel_count}格故事板）**`,
    fenced("text", segment.storyboard_image_prompt),
    "",
    `**图生视频 Prompt（${segment.target_duration_seconds}秒 / ${segment.actual_shot_count}镜）**`,
    fenced("text", segment.image_to_video_prompt),
  ].join("\n"));

  const machineJson = JSON.stringify(pkg, null, 2);
  return [
    ...sections,
    "",
    "**机器 JSON 包**",
    fenced("json", machineJson),
  ].join("\n\n");
}

export function validateStoryboardDirectorPackage(
  pkg: StoryboardDirectorPackage,
  expectedInput?: StoryboardDirectorInput,
): string[] {
  const issues: string[] = [];
  const expectedSegments = expectedInput ? parseSegmentedScript(expectedInput.segmented_script) : [];
  if (expectedInput && pkg.input.target_duration_seconds !== expectedInput.target_duration_seconds) {
    issues.push("input_target_duration_mismatch");
  }
  if (pkg.input.director_mode !== pkg.director_mode) {
    issues.push("input_director_mode_mismatch");
  }
  if (expectedSegments.length && expectedSegments.length !== pkg.segments.length) {
    issues.push("segment_count_mismatch");
  }

  for (const [index, segment] of pkg.segments.entries()) {
    const expected = expectedSegments[index];
    if (expected && (segment.source_index !== expected.source_index || segment.narration !== expected.narration)) {
      issues.push(`${segment.segment_id}:source_not_preserved`);
    }
    if (segment.target_duration_seconds !== pkg.input.target_duration_seconds) {
      issues.push(`${segment.segment_id}:target_duration_mismatch`);
    }
    const expectedNarrationDuration = estimateNarrationDuration(segment.narration);
    if (!Number.isFinite(segment.estimated_narration_duration)
      || segment.estimated_narration_duration <= 0
      || segment.estimated_narration_duration > segment.target_duration_seconds + 1) {
      issues.push(`${segment.segment_id}:invalid_narration_duration_estimate`);
    }
    if (segment.panel_count !== 4 && segment.panel_count !== 5) {
      issues.push(`${segment.segment_id}:invalid_panel_count`);
    }
    const expectedLayout = segment.panel_count === 5 ? "four_plus_panorama" : "two_by_two";
    if (segment.layout !== expectedLayout) {
      issues.push(`${segment.segment_id}:layout_panel_count_mismatch`);
    }
    if (segment.panel_count === 4 && segment.panoramic_anchor_role !== null) {
      issues.push(`${segment.segment_id}:unexpected_panorama_role`);
    }
    if (segment.panel_count === 5
      && (!segment.panoramic_anchor_role || segment.panoramic_anchor_role === "legacy_unspecified")) {
      issues.push(`${segment.segment_id}:missing_panorama_role`);
    }
    // Layout is authoritative in the machine fields; prompt prose may be localized.
    const assertedLayoutText = segment.storyboard_image_prompt
      .split(/\r?\n/)
      .filter((line) => !/(?:禁止|不得|严禁|do not|avoid)/i.test(line))
      .join("\n");
    if (/(?:上|top)\s*2\s*(?:下|bottom)\s*3|2\s*\+\s*3|(?:五|5)格等宽|five equal(?:-width)? panels/i.test(assertedLayoutText)) {
      issues.push(`${segment.segment_id}:forbidden_two_plus_three_layout`);
    }
    const shotRule = storyboardShotCountRule(segment.target_duration_seconds, pkg.director_mode);
    if (segment.actual_shot_count < shotRule.min || segment.actual_shot_count > shotRule.max) {
      issues.push(`${segment.segment_id}:invalid_actual_shot_count_for_duration_and_mode`);
    }
    // The machine package carries the authoritative shot count and precise
    // ranges. Human-facing prompts may use a terse style, so do not reject a
    // valid structured package merely because prose does not repeat metadata.
    if (/Frame\s*1\s*(?:至|到|-)\s*Frame\s*[45].{0,24}(?:依次|连续|逐格)|(?:四|五|4|5)格每格.{0,12}秒/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:video_prompt_forces_panel_cuts`);
    }
    if (segment.shot_time_ranges.length !== segment.actual_shot_count) {
      issues.push(`${segment.segment_id}:shot_time_range_count_mismatch`);
    } else {
      const firstRange = segment.shot_time_ranges[0];
      const lastRange = segment.shot_time_ranges.at(-1);
      if (!firstRange || Math.abs(firstRange.start_seconds) > 0.11
        || !lastRange || Math.abs(lastRange.end_seconds - segment.target_duration_seconds) > 0.11) {
        issues.push(`${segment.segment_id}:shot_time_ranges_do_not_cover_duration`);
      }
      for (const [rangeIndex, range] of segment.shot_time_ranges.entries()) {
        if (range.end_seconds <= range.start_seconds || !range.action_beat.trim()) {
          issues.push(`${segment.segment_id}:invalid_shot_time_range`);
        }
        const next = segment.shot_time_ranges[rangeIndex + 1];
        if (next && Math.abs(range.end_seconds - next.start_seconds) > 0.11) {
          issues.push(`${segment.segment_id}:shot_time_ranges_not_contiguous`);
        }
      }
    }
    if (segment.continuity_links.length !== Math.max(0, segment.actual_shot_count - 1)) {
      issues.push(`${segment.segment_id}:continuity_link_count_mismatch`);
    }
    if (narrationExceedsGenerationUnit(segment.narration, segment.target_duration_seconds)
      && !/(?:建议|需要|应当)?.{0,8}(?:拆分|拆为).{0,12}(?:下一|后续)?(?:生成)?单元/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:overload_without_split_recommendation`);
    }
    if (segment.character_assets.length === 0) {
      issues.push(`${segment.segment_id}:missing_character_assets`);
    }
    if (segment.semantic_visualizations.length === 0) {
      issues.push(`${segment.segment_id}:missing_semantic_visualization`);
    }
    const combined = [
      ...segment.character_assets,
      segment.storyboard_image_prompt,
      segment.image_to_video_prompt,
    ].join("\n");
    if (/同一只(?:狗|猫)|同一个人|那个(?:女人|男人|主人)/.test(combined)) {
      issues.push(`${segment.segment_id}:vague_character_identity`);
    }
    if (!/(先|随后|接着|猛地|缓慢|抬|冲|转|缩|停|落|发现|追逐|收束|移动|变化|完成|等待|稳定|收起|趴下|回头)/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:video_prompt_not_actionable`);
    }
    if (!/(声|无对白|不说话)/.test(`${segment.image_to_video_prompt}\n${pkg.input.special_notes}`)) {
      issues.push(`${segment.segment_id}:missing_audio_boundary`);
    }
  }
  return [...new Set(issues)];
}
