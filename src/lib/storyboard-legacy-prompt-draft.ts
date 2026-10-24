import { normalizeStoryboardDirectorInput, parseSegmentedScript, STORYBOARD_DIRECTOR_MODE_LABELS, type StoryboardDirectorInput } from './storyboard-director-protocol';
import type { StructuredAgentOutputReadyDetail } from './structured-agent-output';
import type { StoryboardCanvasImportPlan } from './storyboard-canvas-bridge';

export const STORYBOARD_PROMPT_DRAFT_SCHEMA = 'storyboard_prompt_draft.v1';
export const STORYBOARD_PROMPT_DRAFT_ARTIFACT = 'storyboard_prompt_draft';
const WARNING = '历史提示词草稿：已保留原接收卡与双提示词，尚未通过当前导演合同。请核对原备注、分段与画面后逐项生成。';
const FAILED = /(?:最终结果|结果|终态).{0,12}(?:暂未确认|不明)|RECONCILIATION_REQUIRED|RESULT_UNKNOWN|\[已终止\]|\[已停止接收[^\]]*\]|输出中断|网络中断|连接中断|^发送失败：/iu;

export interface StoryboardPromptDraft {
  schema_version: typeof STORYBOARD_PROMPT_DRAFT_SCHEMA;
  artifact_type: typeof STORYBOARD_PROMPT_DRAFT_ARTIFACT;
  input: StoryboardDirectorInput;
  original_text: string;
  submitted_at: number;
  legacy_cutoff: number;
  warning: string;
  segments: Array<{ source_index: number; narration: string; image_prompt: string; video_prompt: string }>;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function digest(text: string) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16);
}

function typedMachine(value: unknown): boolean {
  if (!record(value)) return false;
  const source = record(value.package) ? value.package : value;
  if (!record(source.input)) return false;
  return source.schema_version === 'storyboard_director_output.v1' && source.artifact_type === 'storyboard_director_package' && Array.isArray(source.segments)
    || source.schema_version === 'storyboard_director_assets.v1' && source.artifact_type === 'storyboard_director_assets' && record(source.visual_asset_plan)
    || source.schema_version === 'storyboard_director_plan.v1' && source.artifact_type === 'storyboard_director_plan' && Array.isArray(source.segments);
}

/** Discard only one complete, positively typed machine transport at the end. */
function visibleDraftText(text: string): string | null {
  const comment = text.match(/<!--\s*storyboard_director_(?:output|assets|plan):v1\s*([\s\S]*?)-->\s*$/iu);
  if (comment) {
    try { return typedMachine(JSON.parse(comment[1])) ? text.slice(0, comment.index) : null; }
    catch { return null; }
  }
  const fence = text.match(/(?:^|\n)(`{3,})(?:json|machine_json|stable_json)[ \t]*\n([\s\S]*?)\n\1[ \t]*\s*$/iu);
  if (fence) {
    try { return typedMachine(JSON.parse(fence[2])) ? text.slice(0, fence.index) : null; }
    catch { return null; }
  }
  return text;
}

/** Match visible labelled pairs only; never convert a model's rejected machine input. */
function extractDraft(text: string, input: StoryboardDirectorInput): StoryboardPromptDraft['segments'] | null {
  if ((input.visual_asset_mode !== undefined && !['普通模式', 'off', 'ordinary'].includes(input.visual_asset_mode)) || !input.segmented_script.trim()) return null;
  const originals = parseSegmentedScript(input.segmented_script);
  if (!originals.length || originals.length > 100 || originals.some((segment, index) => segment.source_index !== index + 1)) return null;
  const visible = visibleDraftText(text);
  if (visible === null) return null;
  const blocks = [...visible.matchAll(/(^|\n)(`{3,})(?:text|txt|prompt)?[ \t]*\n([\s\S]*?)\n\2(?=\n|$)/giu)];
  if (blocks.length !== originals.length * 2) return null;
  const segments: StoryboardPromptDraft['segments'] = [];
  let previousEnd = 0;
  for (let index = 0; index < originals.length; index++) {
    const image = blocks[index * 2]; const video = blocks[index * 2 + 1];
    const beforeImage = visible.slice(previousEnd, image.index);
    const beforeVideo = visible.slice(image.index! + image[0].length, video.index);
    if (!/(?:生图|图片|图像|image)[^\n]{0,30}(?:提示词|prompt)[^\n]*[:：]?\s*$/iu.test(beforeImage)
      || !/(?:视频|video)[^\n]{0,30}(?:提示词|prompt)[^\n]*[:：]?\s*$/iu.test(beforeVideo)) return null;
    const numbered = [...beforeImage.matchAll(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?\*{0,2}(\d+)[ \t]*(?:\\?\.|、)[ \t]*【([^\n]*)】\*{0,2}[ \t]*(?=\n|$)/gu)].at(-1);
    const headings = [...beforeImage.matchAll(/(?:原文案内容段落|原文案段落|段落|分段|第)\s*(\d+)\s*(?:段)?/gu)];
    if (numbered) {
      if (Number(numbered[1]) !== index + 1 || numbered[2] !== originals[index].narration) return null;
    } else if (!headings.length || Number(headings.at(-1)![1]) !== index + 1) return null;
    const quoted = beforeImage.match(/(?:原文案内容段落|原文案段落)\s*\d+[^\n]*\n([\s\S]*?)\n\s*\*{0,2}(?:生图|图片|图像)/u);
    if (quoted) {
      const body = quoted[1].trim().replace(/^\d+\s*\\?[.、]\s*/u, '');
      if (body !== originals[index].narration) return null;
    }
    const imagePrompt = image[3].trim(); const videoPrompt = video[3].trim();
    if (!imagePrompt || !videoPrompt || imagePrompt.length > 50000 || videoPrompt.length > 50000) return null;
    segments.push({source_index: index + 1, narration: originals[index].narration, image_prompt: imagePrompt, video_prompt: videoPrompt});
    previousEnd = video.index! + video[0].length;
  }
  // An unclosed extra fence is not a completed reply.
  if (/```|<!--|(?:生图|图片|图像|视频|image|video)[^\n]{0,30}(?:提示词|prompt)/iu.test(visible.slice(previousEnd))) return null;
  return segments;
}

export function buildLegacyStoryboardDraftDetail(message: {id: string; role: string; content: string; isStreaming?: boolean; error?: string; streamStatus?: string},
  input: StoryboardDirectorInput | undefined, options: {allowLegacy?: boolean; submittedAt?: number; cutoff?: number}): StructuredAgentOutputReadyDetail | null {
  if (!options.allowLegacy || !input || message.role !== 'assistant' || message.isStreaming || message.error || !message.id
    || /error|failed|aborted|unknown|stopped|已停止|已终止|失败|中断/iu.test(message.streamStatus || '') || FAILED.test(message.content)
    || !Number.isFinite(options.submittedAt) || !Number.isFinite(options.cutoff) || options.submittedAt! <= 0 || options.submittedAt! >= options.cutoff!
    || message.content.length > 500000) return null;
  const segments = extractDraft(message.content, input); if (!segments) return null;
  const payload: StoryboardPromptDraft = {schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifact_type: STORYBOARD_PROMPT_DRAFT_ARTIFACT,
    input, original_text: message.content, submitted_at: options.submittedAt!, legacy_cutoff: options.cutoff!,
    warning: input.visual_asset_mode === undefined ? `${WARNING}旧接收卡未记录视觉资产模式，请先核对角色、参考设置与全部提示词；未推断任何图片已生成或采用。` : WARNING, segments};
  return {message_id: message.id, commit_key: `legacy-draft:${digest(JSON.stringify(payload))}`, schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA,
    source: 'legacy_text_blocks', phase: 'draft', expected_input: input, segments: [], machine_payload: payload};
}

export function buildHistoricalStoryboardMessageDraft(message: Parameters<typeof buildLegacyStoryboardDraftDetail>[0],
  messages: ReadonlyArray<{id: string; role: string; timestamp?: number}> | undefined, input: StoryboardDirectorInput | undefined,
  outputStyle: unknown, allowLegacy: boolean): StructuredAgentOutputReadyDetail | null {
  if (!record(outputStyle) || typeof outputStyle.production_contract_activated_at !== 'string') return null;
  const index = messages?.findIndex(item => item.id === message.id) ?? -1;
  if (!messages || index < 0) return null;
  const submittedAt = messages.slice(0, index).findLast(item => item.role === 'user')?.timestamp;
  return buildLegacyStoryboardDraftDetail(message, input, {allowLegacy, submittedAt, cutoff: Date.parse(outputStyle.production_contract_activated_at)});
}

/** Rebuild from original bytes at every storage boundary, rejecting forged derived fields. */
export function parseLegacyStoryboardDraftImport(value: unknown): StoryboardCanvasImportPlan | null {
  if (!record(value) || value.schema_version !== STORYBOARD_PROMPT_DRAFT_SCHEMA || value.source !== 'legacy_text_blocks'
    || value.phase !== 'draft' || !record(value.machine_payload) || !record(value.expected_input)) return null;
  const payload = value.machine_payload;
  if (typeof payload.original_text !== 'string' || typeof value.message_id !== 'string'
    || payload.artifact_type !== STORYBOARD_PROMPT_DRAFT_ARTIFACT || payload.schema_version !== STORYBOARD_PROMPT_DRAFT_SCHEMA
    || typeof payload.submitted_at !== 'number' || typeof payload.legacy_cutoff !== 'number'
    || value.required_contract_version !== undefined || value.require_performance_plan === true) return null;
  const input = normalizeStoryboardDirectorInput(value.expected_input);
  const rebuilt = buildLegacyStoryboardDraftDetail({id: value.message_id, role: 'assistant', content: payload.original_text}, input,
    {allowLegacy: true, submittedAt: payload.submitted_at, cutoff: payload.legacy_cutoff});
  if (!rebuilt || rebuilt.commit_key !== value.commit_key || JSON.stringify(rebuilt.machine_payload) !== JSON.stringify(payload)) return null;
  const draft = rebuilt.machine_payload as StoryboardPromptDraft;
  return {schemaVersion: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifactType: STORYBOARD_PROMPT_DRAFT_ARTIFACT, phase: 'draft',
    commitKey: rebuilt.commit_key, messageId: value.message_id, sourceScript: input.segmented_script, originalInput: input,
    intakeVerified: false, legacyDraftWarning: draft.warning,
    settings: {directorMode: input.director_mode, directorLabel: STORYBOARD_DIRECTOR_MODE_LABELS[input.director_mode], targetDurationSeconds: input.target_duration_seconds,
      animationStyle: input.animation_style, aspectRatio: input.aspect_ratio},
    segments: draft.segments.map(segment => ({segmentId: `draft_${segment.source_index}`, sourceIndex: segment.source_index, narration: segment.narration,
      imagePrompt: segment.image_prompt, videoPrompt: segment.video_prompt, panelCount: 4, layout: 'two_by_two', pacingMode: 'medium',
      actualShotCount: 0, shotTimeRanges: [], panoramicAnchorRole: null, continuityLinks: [], characterAssets: [], semanticVisualizations: []}))};
}
