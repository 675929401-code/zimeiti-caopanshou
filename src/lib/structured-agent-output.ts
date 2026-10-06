import {
  STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
  STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
  estimateNarrationDuration,
  parseStoryboardDirectorPackage,
  type StoryboardActualShotCount,
  type StoryboardContinuityLink,
  type StoryboardDirectorPackage,
  type StoryboardShotTimeRange,
  type StoryboardTargetDurationSeconds,
} from "@/lib/storyboard-director-protocol";
import {
  AGENT_PROMPT_PACKAGE_VERSION,
  parseAgentPromptPackage,
  type AgentPromptPackage,
} from "@/lib/agent-engineer-protocol";
import {
  MANJU_SKILL_OUTPUT_ARTIFACT_TYPE,
  MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
  parseManjuSkillOutput,
  type ManjuSkillOutput,
} from "@/lib/manju-skill-output-protocol";

export const STRUCTURED_AGENT_OUTPUT_READY_EVENT = "agent-structured-output-ready";

export interface StoryboardWorkbenchSegmentDTO {
  segment_id: string;
  narration: string;
  image_prompt: string;
  video_prompt: string;
  target_duration_seconds: StoryboardTargetDurationSeconds;
  estimated_narration_duration: number;
  panel_count: 4 | 5;
  layout: "two_by_two" | "four_plus_panorama";
  pacing_mode: "slow" | "medium" | "fast";
  actual_shot_count: StoryboardActualShotCount;
  shot_time_ranges: StoryboardShotTimeRange[];
  panoramic_anchor_role: string | null;
  continuity_links: StoryboardContinuityLink[];
}

export interface StructuredAgentOutputReadyDetail {
  message_id: string;
  commit_key: string;
  schema_version: string;
  source: "stable_json" | "legacy_text_blocks";
  segments: StoryboardWorkbenchSegmentDTO[];
  machine_payload: StoryboardDirectorPackage | AgentPromptPackage | ManjuSkillOutput | null;
}

export type StructuredAgentOutputResult =
  | {
      status: "valid";
      kind: "storyboard_director" | "agent_prompt_package" | "manju_skill_output";
      schema_version: string;
      source: "stable_json" | "legacy_text_blocks";
      segments: StoryboardWorkbenchSegmentDTO[];
      machine_payload: StoryboardDirectorPackage | AgentPromptPackage | ManjuSkillOutput | null;
      machine_json: string | null;
      visible_text: string;
      warnings: string[];
    }
  | {
      status: "invalid" | "incomplete" | "none";
      visible_text: string;
      errors: string[];
    };

type UnknownRecord = Record<string, unknown>;

interface JsonCandidate {
  value: unknown;
  raw: string;
  start: number;
  end: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function extractJsonCandidates(text: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = [];
  const trimmed = text.trim();
  const direct = safeParseJson(trimmed);
  if (direct != null) {
    const start = text.indexOf(trimmed);
    candidates.push({ value: direct, raw: trimmed, start, end: start + trimmed.length });
  }

  for (const match of text.matchAll(/(`{3,})json\s*\n?([\s\S]*?)\n?\1/gi)) {
    const parsed = safeParseJson(match[2]);
    if (parsed == null || match.index == null) continue;
    candidates.push({ value: parsed, raw: match[2].trim(), start: match.index, end: match.index + match[0].length });
  }

  for (const match of text.matchAll(/<!--\s*(?:storyboard_director_output|agent_prompt_package|manju_skill_output):v1\s*([\s\S]*?)-->/gi)) {
    const parsed = safeParseJson(match[1]);
    if (parsed == null || match.index == null) continue;
    candidates.push({ value: parsed, raw: match[1].trim(), start: match.index, end: match.index + match[0].length });
  }
  return candidates;
}

function unwrapCandidate(value: unknown): UnknownRecord | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.package)) return value.package;
  if (isRecord(value.final_package)) return value.final_package;
  if (isRecord(value.state) && isRecord(value.state.final_package)) return value.state.final_package;
  return value;
}

function storyboardDtos(pkg: StoryboardDirectorPackage): StoryboardWorkbenchSegmentDTO[] {
  return pkg.segments.map((segment) => ({
    segment_id: segment.segment_id,
    narration: segment.narration,
    image_prompt: segment.storyboard_image_prompt,
    video_prompt: segment.image_to_video_prompt,
    target_duration_seconds: segment.target_duration_seconds,
    estimated_narration_duration: segment.estimated_narration_duration,
    panel_count: segment.panel_count,
    layout: segment.layout,
    pacing_mode: segment.pacing_mode,
    actual_shot_count: segment.actual_shot_count,
    shot_time_ranges: segment.shot_time_ranges,
    panoramic_anchor_role: segment.panoramic_anchor_role,
    continuity_links: segment.continuity_links,
  }));
}

function removeCandidate(text: string, candidate: JsonCandidate): string {
  const prefix = text.slice(0, candidate.start);
  const title = prefix.match(/(?:^|\n)\s*\*\*(?:机器\s*JSON\s*包|Machine\s*JSON)\*\*\s*$/i);
  const start = title?.index != null ? title.index : candidate.start;
  return `${text.slice(0, start)}${text.slice(candidate.end)}`
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function strictStableResult(text: string): StructuredAgentOutputResult | null {
  for (const candidate of extractJsonCandidates(text)) {
    const source = unwrapCandidate(candidate.value);
    if (!source) continue;

    if (source.schema_version === STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION
      && source.artifact_type === STORYBOARD_DIRECTOR_ARTIFACT_TYPE) {
      const parsed = parseStoryboardDirectorPackage(JSON.stringify(source));
      if (!parsed) {
        return { status: "invalid", visible_text: text, errors: ["storyboard_director_output.v1 字段缺失或类型不合法"] };
      }
      return {
        status: "valid",
        kind: "storyboard_director",
        schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
        source: "stable_json",
        segments: storyboardDtos(parsed),
        machine_payload: parsed,
        machine_json: JSON.stringify(parsed, null, 2),
        visible_text: removeCandidate(text, candidate),
        warnings: [],
      };
    }

    if (source.schema_version === AGENT_PROMPT_PACKAGE_VERSION
      && source.artifact_type === "agent_prompt_package") {
      const parsed = parseAgentPromptPackage(JSON.stringify(source));
      if (!parsed) {
        return { status: "invalid", visible_text: text, errors: ["agent_prompt_package.v1 字段缺失或类型不合法"] };
      }
      return {
        status: "valid",
        kind: "agent_prompt_package",
        schema_version: AGENT_PROMPT_PACKAGE_VERSION,
        source: "stable_json",
        segments: [],
        machine_payload: parsed,
        machine_json: JSON.stringify(parsed, null, 2),
        visible_text: removeCandidate(text, candidate),
        warnings: [],
      };
    }

    if (source.schema_version === MANJU_SKILL_OUTPUT_SCHEMA_VERSION
      && source.artifact_type === MANJU_SKILL_OUTPUT_ARTIFACT_TYPE) {
      const parsed = parseManjuSkillOutput(source);
      if (!parsed) {
        return { status: "invalid", visible_text: text, errors: ["manju_skill_output.v1 字段缺失或类型不合法"] };
      }
      return {
        status: "valid",
        kind: "manju_skill_output",
        schema_version: MANJU_SKILL_OUTPUT_SCHEMA_VERSION,
        source: "stable_json",
        segments: [],
        machine_payload: parsed,
        machine_json: JSON.stringify(parsed, null, 2),
        visible_text: removeCandidate(text, candidate),
        warnings: [],
      };
    }
  }
  return null;
}

interface LegacyTextBlock {
  text: string;
  start: number;
  end: number;
}

function extractLegacyTextBlocks(text: string): LegacyTextBlock[] {
  const blocks: LegacyTextBlock[] = [];
  for (const match of text.matchAll(/(^|\n)(`{3,})(?:text|txt|prompt)?[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/gi)) {
    if (match.index == null) continue;
    const start = match.index + match[1].length;
    blocks.push({ text: match[3].trim(), start, end: match.index + match[0].length });
  }
  return blocks;
}

function legacyNarration(text: string, before: number, index: number): string {
  const prefix = text.slice(0, before);
  const matches = [...prefix.matchAll(/\*\*段落\s*(\d+)\*\*\s*[：:]\s*([^\n]+)/g)];
  return matches.at(-1)?.[2]?.trim() || `旧版段落 ${index + 1}`;
}

function legacyStoryboardResult(text: string): StructuredAgentOutputResult | null {
  const blocks = extractLegacyTextBlocks(text);
  if (blocks.length < 2 || blocks.length % 2 !== 0) return null;

  const segments: StoryboardWorkbenchSegmentDTO[] = [];
  for (let index = 0; index < blocks.length; index += 2) {
    const image = blocks[index];
    const video = blocks[index + 1];
    const panelCount: 4 | 5 = /(?:Frame\s*5|第\s*5\s*格|5\s*格)/i.test(image.text) ? 5 : 4;
    const narration = legacyNarration(text, image.start, index / 2);
    segments.push({
      segment_id: `segment_${String(index / 2 + 1).padStart(3, "0")}`,
      narration,
      image_prompt: image.text,
      video_prompt: video.text,
      target_duration_seconds: 10,
      estimated_narration_duration: estimateNarrationDuration(narration),
      panel_count: panelCount,
      layout: panelCount === 5 ? "four_plus_panorama" : "two_by_two",
      pacing_mode: "medium",
      actual_shot_count: 3,
      shot_time_ranges: [
        { shot_id: "shot_01", start_seconds: 0, end_seconds: 3.3, action_beat: "兼容旧输出：动作建立" },
        { shot_id: "shot_02", start_seconds: 3.3, end_seconds: 6.7, action_beat: "兼容旧输出：动作发展" },
        { shot_id: "shot_03", start_seconds: 6.7, end_seconds: 10, action_beat: "兼容旧输出：动作收束" },
      ],
      panoramic_anchor_role: panelCount === 5 ? "legacy_unspecified" : null,
      continuity_links: [
        { from_shot: "shot_01", to_shot: "shot_02", link_type: "legacy_continuity", description: "沿主体动作方向衔接" },
        { from_shot: "shot_02", to_shot: "shot_03", link_type: "legacy_continuity", description: "沿视线与声响衔接" },
      ],
    });
  }

  return {
    status: "valid",
    kind: "storyboard_director",
    schema_version: "legacy_two_text_blocks.v1",
    source: "legacy_text_blocks",
    segments,
    machine_payload: null,
    machine_json: null,
    visible_text: text,
    warnings: ["旧版双代码框已兼容读取；建议重新生成稳定机器 JSON 以避免默认值。"],
  };
}

export function parseStructuredAgentOutput(text: string, finalized = true): StructuredAgentOutputResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const mentionsStableSchema = normalized.includes(STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION)
    || normalized.includes(AGENT_PROMPT_PACKAGE_VERSION)
    || normalized.includes(MANJU_SKILL_OUTPUT_SCHEMA_VERSION)
    || /<!--\s*(?:storyboard_director_output|agent_prompt_package|manju_skill_output):v1/i.test(normalized);

  if (!finalized) {
    return mentionsStableSchema
      ? { status: "incomplete", visible_text: normalized, errors: ["流尚未结束，结构暂不提交"] }
      : { status: "none", visible_text: normalized, errors: [] };
  }

  const stable = strictStableResult(normalized);
  if (stable) return stable;
  if (mentionsStableSchema) {
    return { status: "invalid", visible_text: normalized, errors: ["检测到稳定协议标识，但机器 JSON 未闭合或校验失败"] };
  }

  return legacyStoryboardResult(normalized)
    ?? { status: "none", visible_text: normalized, errors: [] };
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const publishedCommits = new Set<string>();

export function buildStructuredAgentOutputReadyDetail(
  messageId: string,
  result: StructuredAgentOutputResult,
): StructuredAgentOutputReadyDetail | null {
  if (result.status !== "valid") return null;
  const commitKey = `${messageId}:${fnv1a(JSON.stringify({
    schema: result.schema_version,
    segments: result.segments,
    payload: result.machine_payload,
  }))}`;
  return {
    message_id: messageId,
    commit_key: commitKey,
    schema_version: result.schema_version,
    source: result.source,
    segments: result.segments,
    machine_payload: result.machine_payload,
  };
}

export function publishStructuredAgentOutputOnce(
  messageId: string,
  result: StructuredAgentOutputResult,
): StructuredAgentOutputReadyDetail | null {
  const detail = buildStructuredAgentOutputReadyDetail(messageId, result);
  if (!detail || publishedCommits.has(detail.commit_key)) return null;
  publishedCommits.add(detail.commit_key);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STRUCTURED_AGENT_OUTPUT_READY_EVENT, { detail }));
  }
  return detail;
}

export class IncrementalStructuredOutputSession {
  private readableText = "";
  private finalized = false;

  append(chunk: string): string {
    if (this.finalized) throw new Error("structured output session already finalized");
    this.readableText += chunk;
    return this.readableText;
  }

  snapshot(): StructuredAgentOutputResult {
    return parseStructuredAgentOutput(this.readableText, false);
  }

  finish(): StructuredAgentOutputResult {
    this.finalized = true;
    return parseStructuredAgentOutput(this.readableText, true);
  }
}
