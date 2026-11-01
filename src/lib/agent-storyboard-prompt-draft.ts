import MarkdownIt from 'markdown-it';
import { STORYBOARD_PROMPT_DRAFT_SCHEMA, STORYBOARD_PROMPT_DRAFT_ARTIFACT } from './storyboard-legacy-prompt-draft';
import { normalizeStoryboardDirectorInput, STORYBOARD_DIRECTOR_MODE_LABELS } from './storyboard-director-protocol';
import type { StructuredAgentOutputReadyDetail } from './structured-agent-output';
import type { StoryboardCanvasImportPlan } from './storyboard-canvas-bridge';

export interface AgentStoryboardPromptDraft {
  schema_version: typeof STORYBOARD_PROMPT_DRAFT_SCHEMA;
  artifact_type: typeof STORYBOARD_PROMPT_DRAFT_ARTIFACT;
  draft_kind: 'agent_prompt_text';
  original_text: string;
  warning: string;
  segments: Array<{ source_index: number; narration: string; image_prompt: string; video_prompt: string }>;
}
const WARNING = '智能体提示词预览草稿：缺少原导演接收卡，输入与分段尚未验证；比例、10秒时长、导演模式与风格仅为可编辑草稿设置，不代表原提示词采用了该导演模式或3D风格。未推断图片已生成、参考图已采用或生产合同已通过。';
const md = new MarkdownIt({ html: false });
const FAILED = /RECONCILIATION_REQUIRED|RESULT_UNKNOWN|\[已终止\]|\[已停止接收[^\]]*\]|输出中断|网络中断|连接中断|^发送失败：/imu;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function digest(text: string): string { let hash = 2166136261; for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash.toString(16); }
function label(before: string): 'image' | 'video' | undefined {
  const last = before.trim().split(/\r\n?|\n/u).at(-1)?.trim().replace(/^#{1,6}\s*/u, '').replace(/^\*\*(.*?)\*\*\s*[:：]?$/u, '$1').replace(/[:：]\s*$/u, '').trim();
  if (/^(?:生图|图片|图像|image)\s*(?:提示词|prompt)$/iu.test(last || '')) return 'image';
  if (/^(?:图生视频|视频|video)\s*(?:提示词|prompt)$/iu.test(last || '')) return 'video';
  return undefined;
}
function read(text: string): AgentStoryboardPromptDraft['segments'] | null {
  // Maps refer to original source lines. Never use rendered HTML or token.content
  // as prompt bytes: MarkdownIt normalizes CRLF and could alter literal text.
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) || [];
  const offsets = [0]; for (const line of lines) offsets.push(offsets.at(-1)! + line.length);
  const tokens = md.parse(text, {});
  if (tokens.some(token => token.type === 'code_block' || token.type === 'html_block')) return null;
  const fences = tokens.filter(token => token.type === 'fence');
  if (!fences.length || fences.length % 2 || fences.length > 200) return null;
  const segments: AgentStoryboardPromptDraft['segments'] = [];
  let end = 0;
  let pending: { prompt: string; context: string } | undefined;
  for (const fence of fences) {
    if (!fence.map || fence.level !== 0 || !['', 'text', 'txt', 'prompt'].includes(fence.info.trim().toLowerCase())) return null;
    const [startLine, endLine] = fence.map;
    const closing = lines[endLine - 1]?.replace(/[\r\n]+$/u, '');
    const marker = fence.markup[0];
    if (!closing || !new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${fence.markup.length},}[ \\t]*$`, 'u').test(closing)) return null;
    const context = text.slice(end, offsets[startLine]);
    // Asset-only introductions need the original intake/reference contract. Do
    // not discard them and import just the following image/video pairs.
    if (/三视图|视觉资产|角色参考|参考图|turnaround|reference[ _-]?asset|<!--|storyboard_director_/iu.test(context)) return null;
    const kind = label(context);
    const prompt = text.slice(offsets[startLine + 1], offsets[endLine - 1]);
    if (!prompt.trim() || prompt.length > 50000) return null;
    if (kind === 'image' && !pending) pending = { prompt, context };
    else if (kind === 'video' && pending) {
      segments.push({ source_index: segments.length + 1, narration: [pending.context.trim(), context.trim()].filter(Boolean).join('\n\n'), image_prompt: pending.prompt, video_prompt: prompt });
      pending = undefined;
    } else return null;
    end = offsets[endLine];
  }
  const tail = text.slice(end);
  if (pending || /```|~~~|<!--|三视图|视觉资产|角色参考|参考图|(?:生图|图片|图像|视频|image|video)\s*(?:提示词|prompt)/iu.test(tail)) return null;
  return segments;
}

/** Caller must independently allow only explicit, non-official storyboard agents. */
export function buildAgentStoryboardPromptDraftDetail(message: { id: string; role: string; content: string; isStreaming?: boolean; error?: string; streamStatus?: string }): StructuredAgentOutputReadyDetail | null {
  if (!message.id?.trim() || message.id.length > 256 || message.role !== 'assistant' || message.isStreaming || message.error || typeof message.content !== 'string'
    || message.content.length > 500000 || FAILED.test(message.content) || /error|failed|aborted|unknown|stopped|已停止|已终止|失败|中断/iu.test(message.streamStatus || '')) return null;
  const segments = read(message.content); if (!segments) return null;
  const payload: AgentStoryboardPromptDraft = { schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifact_type: STORYBOARD_PROMPT_DRAFT_ARTIFACT, draft_kind: 'agent_prompt_text', original_text: message.content, warning: WARNING, segments };
  return { message_id: message.id, commit_key: `agent-prompt-draft:${digest(JSON.stringify(payload))}`, schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA, source: 'legacy_text_blocks', phase: 'draft', segments: [], machine_payload: payload };
}

/** Rebuild the entire transport, rejecting all derived/media/contract injections. */
export function parseAgentStoryboardPromptDraftImport(value: unknown): StoryboardCanvasImportPlan | null {
  if (!record(value) || !record(value.machine_payload) || typeof value.message_id !== 'string' || typeof value.machine_payload.original_text !== 'string') return null;
  const rebuilt = buildAgentStoryboardPromptDraftDetail({ id: value.message_id, role: 'assistant', content: value.machine_payload.original_text });
  // Exact keys as well as values: even undefined verification fields are not
  // acceptable on this manual transport. JSON key order itself is immaterial.
  function exact(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => exact(item, b[i]));
    if (!record(a) || !record(b)) return false;
    const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && exact(a[key], b[key]));
  }
  if (!rebuilt || !exact(value, rebuilt)) return null;
  const draft = rebuilt.machine_payload as AgentStoryboardPromptDraft;
  const ratios = new Set(draft.original_text.match(/(?<!\d)(?:16:9|9:16)(?!\d)/gu));
  const input = normalizeStoryboardDirectorInput({ segmented_script: draft.segments.map(segment => `${segment.source_index}. ${segment.narration}`).join('\n\n'), aspect_ratio: ratios.size === 1 ? [...ratios][0] : '16:9', target_duration_seconds: 10, animation_style: '未指定（请核对原提示词）', visual_asset_mode: 'off', special_notes: `${WARNING}\n\n原始智能体输出（完整保留）：\n${draft.original_text}` });
  return { schemaVersion: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifactType: STORYBOARD_PROMPT_DRAFT_ARTIFACT, phase: 'draft', promptDraft: true, intakeVerified: false, executionMode: 'ordinary', commitKey: rebuilt.commit_key, messageId: value.message_id, sourceScript: input.segmented_script, originalInput: input, legacyDraftWarning: WARNING,
    settings: { directorMode: input.director_mode, directorLabel: STORYBOARD_DIRECTOR_MODE_LABELS[input.director_mode], targetDurationSeconds: 10, animationStyle: input.animation_style, aspectRatio: input.aspect_ratio },
    segments: draft.segments.map(segment => ({ segmentId: `agent_prompt_${segment.source_index}`, sourceIndex: segment.source_index, narration: segment.narration, imagePrompt: segment.image_prompt, videoPrompt: segment.video_prompt, panelCount: 4, layout: 'two_by_two', pacingMode: 'medium', actualShotCount: 0, shotTimeRanges: [], panoramicAnchorRole: null, continuityLinks: [], characterAssets: [], semanticVisualizations: [] })) };
}
