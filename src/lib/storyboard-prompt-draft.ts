import { normalizeStoryboardDirectorInput, parseSegmentedScript, STORYBOARD_DIRECTOR_MODE_LABELS, type StoryboardDirectorInput } from './storyboard-director-protocol';
import { STORYBOARD_PROMPT_DRAFT_SCHEMA, STORYBOARD_PROMPT_DRAFT_ARTIFACT } from './storyboard-legacy-prompt-draft';
import type { StructuredAgentOutputReadyDetail } from './structured-agent-output';
import type { StoryboardCanvasImportPlan } from './storyboard-canvas-bridge';
import { StoryboardVisualAssetPlanSchema, type StoryboardVisualAssetPlan } from './storyboard-workbench';
import { storyboardExecutionModeFromIntake } from './storyboard-creation-mode';

type PromptSegment = { source_index: number; narration: string; image_prompt: string; video_prompt: string; asset_ids?: string[] };
export interface StoryboardTextPromptDraft {
  schema_version: typeof STORYBOARD_PROMPT_DRAFT_SCHEMA;
  artifact_type: typeof STORYBOARD_PROMPT_DRAFT_ARTIFACT;
  draft_kind: 'prompt_text';
  input: StoryboardDirectorInput;
  original_text: string;
  segments: PromptSegment[];
  visual_asset_plan: StoryboardVisualAssetPlan;
  import_warnings?: string[];
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function digest(text: string): string { let hash = 2166136261; for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash.toString(16); }
function mode(input: StoryboardDirectorInput): 'off' | 'selected' | undefined {
  const execution = storyboardExecutionModeFromIntake(input);
  return execution === 'reference' ? 'selected' : execution ? 'off' : undefined;
}
function machine(value: unknown): Record<string, unknown> | undefined {
  const source = record(value) && record(value.package) ? value.package : value;
  if (!record(source)) return undefined;
  const artifacts: Record<string, string> = { 'storyboard_director_output.v1': 'storyboard_director_package', 'storyboard_director_assets.v1': 'storyboard_director_assets', 'storyboard_director_plan.v1': 'storyboard_director_plan' };
  const artifact = artifacts[String(source.schema_version)];
  return artifact && artifact === source.artifact_type ? source : undefined;
}
function transport(text: string): { body: string; source?: Record<string, unknown> } {
  const direct = text.trim();
  if (direct.startsWith('{')) { try { const source = machine(JSON.parse(direct)); if (source) return { body: '', source }; } catch { /* streaming JSON */ } }
  let source: Record<string, unknown> | undefined;
  const body = text.replace(/<!--\s*storyboard_director_(?:output|assets|plan):v1\b([\s\S]*?)(?:-->|$)/giu, (_all, json: string) => {
    try { source ||= machine(JSON.parse(json)); } catch { /* text remains independently readable */ }
    return '';
  }).replace(/(^|\n)(`{3,})(?:json|machine_json|stable_json)[ \t]*\n([\s\S]*?)(?:\n\2(?=\n|$)|$)/giu, (all, _line, _fence, json: string) => {
    try { const parsed = machine(JSON.parse(json)); if (parsed) { source ||= parsed; return ''; } } catch { /* incomplete transport */ }
    return /storyboard_director_(?:output|assets|plan)\.v1/u.test(json) ? '' : all;
  });
  return { body: body.replace(/\n?\s*\*\*(?:机器\s*JSON\s*包|Machine\s*JSON)\*\*\s*$/iu, '').trim(), source };
}

/** Presentation reads prompt bytes only. Neither parser verdicts nor adopted media control it. */
export function storyboardPromptVisibleText(text: string): string {
  const { body, source } = transport(text);
  if (body && !text.trimStart().startsWith('{')) return body;
  if (source) {
    const sections: string[] = [];
    if (record(source.visual_asset_plan) && Array.isArray(source.visual_asset_plan.assets)) for (const asset of source.visual_asset_plan.assets) {
      if (!record(asset)) continue;
      if (Array.isArray(asset.reference_prompts)) for (const reference of asset.reference_prompts) if (record(reference) && typeof reference.prompt === 'string') {
        sections.push(`**视觉资产：${String(asset.name || '')}**\n\n${fenced(reference.prompt)}`);
      }
    }
    if (Array.isArray(source.segments)) for (const segment of source.segments) {
      if (!record(segment)) continue;
      const image = segment.storyboard_image_prompt ?? segment.image_prompt;
      const video = segment.image_to_video_prompt ?? segment.video_prompt;
      sections.push([`**段落 ${String(segment.source_index || '')}**：${String(segment.narration || '')}`,
        typeof image === 'string' ? `**生图 Prompt**\n${fenced(image)}` : '',
        typeof video === 'string' ? `**图生视频 Prompt**\n${fenced(video)}` : ''].filter(Boolean).join('\n\n'));
    }
    return sections.join('\n\n') || body;
  }
  if (text.trimStart().startsWith('{') && /storyboard_director_(?:output|assets|plan)/u.test(text)) {
    // Old replies may stream JSON first. Read only arrived string characters;
    // no artificial typing or quality verdict is involved.
    const labels: Record<string, string> = { narration: '原文', storyboard_image_prompt: '生图 Prompt', image_prompt: '生图 Prompt', image_to_video_prompt: '视频 Prompt', video_prompt: '视频 Prompt', prompt: '视觉资产 Prompt' };
    const sections: string[] = [];
    for (const match of text.matchAll(/"(narration|storyboard_image_prompt|image_prompt|image_to_video_prompt|video_prompt|prompt)"\s*:\s*"/gu)) {
      let value = ''; let escaped = false;
      for (let index = match.index! + match[0].length; index < text.length; index++) {
        const char = text[index];
        if (!escaped && char === '"') break;
        if (!escaped && char === '\\') { escaped = true; continue; }
        if (escaped) {
          if (char === 'u') { const hex = text.slice(index + 1, index + 5); if (!/^[\da-f]{4}$/iu.test(hex)) break; value += String.fromCharCode(parseInt(hex, 16)); index += 4; }
          else value += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[char] ?? char;
          escaped = false;
        } else value += char;
      }
      if (value) sections.push(`**${labels[match[1]]}**\n${match[1] === 'narration' ? value : fenced(value)}`);
    }
    return sections.join('\n\n');
  }
  return body;
}
function fenced(text: string): string { const size = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)); const fence = '`'.repeat(size); return `${fence}text\n${text}\n${fence}`; }
function visualPlan(selected: 'off' | 'selected', assets: StoryboardVisualAssetPlan['assets']): StoryboardVisualAssetPlan {
  return { mode: selected, assets, generationPolicy: { maxInitialImages: assets.length, initialRequiredAssetIds: assets.map(asset => asset.id), initialDeferredAssetIds: [], environmentAnchorPolicy: 'none' } };
}
function assetFromPrompt(index: number, name: string, role: 'character' | 'pet', prompt: string, identity?: string): StoryboardVisualAssetPlan['assets'][number] {
  return { id: `prompt_${role}_${index}`, role, name: name.trim(), identityLock: identity?.trim() || prompt.trim(), allowedChanges: [], referencePrompts: [{ kind: 'turnaround', purpose: '角色参考提示词', prompt: prompt.trim() }] };
}
function sameInput(a: unknown, b: StoryboardDirectorInput): boolean {
  if (!record(a)) return false;
  return JSON.stringify(normalizeStoryboardDirectorInput(a)) === JSON.stringify(normalizeStoryboardDirectorInput(b));
}

function readDraft(text: string, input: StoryboardDirectorInput): { segments: PromptSegment[]; visualAssetPlan: StoryboardVisualAssetPlan; importWarnings?: string[] } | null {
  const selected = mode(input); if (!selected) return null;
  // Some cards display numbered quoted paragraphs without a punctuation mark.
  // Adapt just that delimiter for reading; keep the original card bytes intact.
  const originals = parseSegmentedScript(input.segmented_script.replace(/(^|\n)([ \t]*\d+)[ \t]+(?=【)/gu, '$1$2.'));
  if (!originals.length || originals.length > 100 || originals.some((item, index) => item.source_index !== index + 1)) return null;
  const { body, source } = transport(text);
  // An echoed machine card cannot replace or contradict the original user card.
  if (source && !sameInput(source.input, input)) return null;
  const assets: StoryboardVisualAssetPlan['assets'] = [];
  const segments: PromptSegment[] = [];
  const importWarnings: string[] = [];
  if (source && !/(?:^|\n)`{3,}(?:text|txt|prompt)?[ \t]*\n/u.test(body)) {
    if (!Array.isArray(source.segments) || source.segments.length !== originals.length) return null;
    const rawPlan = record(source.visual_asset_plan) ? source.visual_asset_plan : undefined;
    if (rawPlan && rawPlan.mode !== selected) return null;
    if (selected === 'selected' && rawPlan) {
      if (!Array.isArray(rawPlan.assets) || rawPlan.assets.length > 16) return null;
      for (const item of rawPlan.assets) {
        if (!record(item) || !['character', 'pet'].includes(String(item.role)) || typeof item.name !== 'string' || !Array.isArray(item.reference_prompts)) return null;
        const reference = item.reference_prompts.find(value => record(value) && value.kind === 'turnaround');
        if (!record(reference) || typeof reference.prompt !== 'string') return null;
        const asset = assetFromPrompt(assets.length + 1, item.name, item.role as 'character' | 'pet', reference.prompt, typeof item.identity_lock === 'string' ? item.identity_lock : undefined);
        if (typeof item.id === 'string' && /^[a-z][a-z0-9_-]{2,63}$/u.test(item.id)) asset.id = item.id;
        assets.push(asset); // sources, URLs and model adoption claims are deliberately not copied.
      }
    }
    for (const [index, item] of source.segments.entries()) {
      if (!record(item) || item.source_index !== index + 1 || item.narration !== originals[index].narration) return null;
      const image = item.storyboard_image_prompt ?? item.image_prompt; const video = item.image_to_video_prompt ?? item.video_prompt;
      if (typeof image !== 'string' || !image.trim() || typeof video !== 'string' || !video.trim() || image.length > 50000 || video.length > 50000) return null;
      const refs = Array.isArray(item.visual_asset_refs) ? item.visual_asset_refs : [];
      if (refs.some(ref => !record(ref) || !assets.some(asset => asset.id === ref.asset_id && asset.role === ref.role))) return null;
      segments.push({ source_index: index + 1, narration: originals[index].narration, image_prompt: image, video_prompt: video,
        asset_ids: refs.map(ref => String((ref as Record<string, unknown>).asset_id)) });
    }
  } else {
    const declaredMode = body.match(/(?:^|\n)\s*(?:\*\*)?模式(?:\*\*)?\s*[:：]\s*(普通模式|角色参考模式|串联模式)/u)?.[1];
    if (declaredMode && storyboardExecutionModeFromIntake({ visual_asset_mode: declaredMode }) !== storyboardExecutionModeFromIntake(input)) {
      const originalMode = { ordinary: '普通模式', reference: '角色参考模式', chained: '串联模式' }[storyboardExecutionModeFromIntake(input) || 'ordinary'];
      importWarnings.push(`原接收卡为${originalMode}，回复文字标为${declaredMode}。已按原接收卡保留模式和分段，请核对提示词中的模式说明。`);
    }
    const blocks = [...body.matchAll(/(^|\n)(`{3,})(?:text|txt|prompt)?[ \t]*\n([\s\S]*?)\n\2(?=\n|$)/giu)];
    let previousEnd = 0;
    let pending: { index: number; narration: string; image: string } | undefined;
    for (const block of blocks) {
      const heading = body.slice(previousEnd, block.index).replace(/\*\*/g, '').trim();
      const prompt = block[3].trim(); if (!prompt || prompt.length > 50000) return null;
      const assetHeader = heading.match(/视觉资产(?:\s*\d+)?\s*[:：]\s*([^\n]+)/u);
      if (assetHeader && /(?:三视图生图|视觉资产)\s*(?:Prompt|提示词)\s*[:：]?\s*$/iu.test(heading)) {
        if (selected !== 'selected' || pending || segments.length || assets.length >= 16) return null;
        const title = assetHeader[1].trim();
        const sourceAssets = source && record(source.visual_asset_plan) && Array.isArray(source.visual_asset_plan.assets) ? source.visual_asset_plan.assets : [];
        const sourceAsset = sourceAssets.find(value => record(value) && value.name === title && Array.isArray(value.reference_prompts)
          && value.reference_prompts.some(reference => record(reference) && reference.kind === 'turnaround' && reference.prompt === prompt));
        const role = /人物|人类|character/iu.test(title) ? 'character' : /宠物|动物|pet/iu.test(title) ? 'pet'
          : record(sourceAsset) && (sourceAsset.role === 'character' || sourceAsset.role === 'pet') ? sourceAsset.role : undefined;
        if (!role) return null;
        const name = title.replace(/^(?:人物|人类|宠物|动物)\s*[·:：-]\s*/u, '').replace(/[（(](?:人物|人类|宠物|动物|其他实际动物)[）)]\s*$/u, '').trim();
        const identity = heading.match(/身份与衣着\s*[:：]\s*([^\n]+)/u)?.[1];
        assets.push(assetFromPrompt(assets.length + 1, name, role, prompt, identity));
      } else if (/(?:生图|图片|图像|image)[^\n]{0,30}(?:Prompt|提示词)\s*[:：]?\s*$/iu.test(heading)) {
        if (pending) return null;
        const match = [...heading.matchAll(/(?:分镜段|原文案内容段落|原文案段落|段落|分段)\s*(\d+)\s*(?:段)?[^\n]*/gu)].at(-1);
        const numbered = [...heading.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(\d+)\s*\\?[.、]\s*【([^\n]*)】/gu)].at(-1);
        const index = Number(match?.[1] ?? numbered?.[1]);
        if (index !== segments.length + 1 || !originals[index - 1]) return null;
        let narration = numbered?.[2];
        if (!narration && match) {
          const after = heading.slice(match.index! + match[0].indexOf(match[1]) + match[1].length);
          narration = after.replace(/^\s*(?:段)?\s*[:：]?\s*/u, '').split(/\n\s*(?:#{1,6}\s*)?(?:故事板布局|风格锁|场景锁|演绎重点|主峰|生图|图片|图像|image)/iu)[0].trim();
          narration = narration.replace(/^(?:原文|原文案)\s*[:：]\s*/u, '').replace(/^\d+\s*\\?[.、]\s*/u, '');
        }
        const originalNarration = originals[index - 1].narration;
        if (narration === `【${originalNarration}】`) narration = originalNarration;
        if (narration !== originalNarration) return null;
        pending = { index, narration, image: prompt };
      } else if (/(?:视频|video)[^\n]{0,30}(?:Prompt|提示词)\s*[:：]?\s*$/iu.test(heading)) {
        if (!pending) return null;
        segments.push({ source_index: pending.index, narration: pending.narration, image_prompt: pending.image, video_prompt: prompt }); pending = undefined;
      } else return null;
      previousEnd = block.index! + block[0].length;
    }
    if (pending || segments.length !== originals.length || /```|<!--/u.test(body.slice(previousEnd))) return null;
  }
  const plan = StoryboardVisualAssetPlanSchema.safeParse(visualPlan(selected, assets));
  return plan.success ? { segments, visualAssetPlan: plan.data, ...(importWarnings.length ? { importWarnings } : {}) } : null;
}

/** A prompt import is a text operation, not a quality or generated-media approval. */
export function buildStoryboardPromptDraftDetail(message: { id: string; role: string; content: string; isStreaming?: boolean; error?: string; streamStatus?: string }, input?: StoryboardDirectorInput): StructuredAgentOutputReadyDetail | null {
  if (!input || !message.id.trim() || message.role !== 'assistant' || message.isStreaming || message.error || message.content.length > 500000
    || /error|failed|aborted|unknown|stopped|已停止|已终止|失败|中断/iu.test(message.streamStatus || '')) return null;
  const parsed = readDraft(message.content, input); if (!parsed) return null;
  const payload: StoryboardTextPromptDraft = { schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifact_type: STORYBOARD_PROMPT_DRAFT_ARTIFACT,
    draft_kind: 'prompt_text', input, original_text: message.content, segments: parsed.segments, visual_asset_plan: parsed.visualAssetPlan,
    ...(parsed.importWarnings?.length ? { import_warnings: parsed.importWarnings } : {}) };
  return { message_id: message.id, commit_key: `prompt-draft:${digest(JSON.stringify(payload))}`, schema_version: STORYBOARD_PROMPT_DRAFT_SCHEMA,
    source: 'legacy_text_blocks', phase: payload.visual_asset_plan.mode === 'selected' && payload.visual_asset_plan.assets.length ? 'planned' : 'draft', expected_input: input, segments: [], machine_payload: payload };
}

/** Re-read source bytes at every storage boundary; never trust derived prompts or media metadata. */
export function parseStoryboardPromptDraftImport(value: unknown): StoryboardCanvasImportPlan | null {
  if (!record(value) || value.schema_version !== STORYBOARD_PROMPT_DRAFT_SCHEMA || value.source !== 'legacy_text_blocks'
    || !record(value.machine_payload) || value.machine_payload.draft_kind !== 'prompt_text' || !record(value.expected_input)
    || typeof value.message_id !== 'string' || typeof value.machine_payload.original_text !== 'string'
    || value.verified_asset_bindings !== undefined || value.reference_project_id !== undefined
    || value.required_contract_version !== undefined || value.require_performance_plan !== undefined) return null;
  const input = normalizeStoryboardDirectorInput(value.expected_input);
  const rebuilt = buildStoryboardPromptDraftDetail({ id: value.message_id, role: 'assistant', content: value.machine_payload.original_text }, input);
  if (!rebuilt || rebuilt.commit_key !== value.commit_key || rebuilt.phase !== value.phase || JSON.stringify(rebuilt.machine_payload) !== JSON.stringify(value.machine_payload)) return null;
  const draft = rebuilt.machine_payload as StoryboardTextPromptDraft;
  return { schemaVersion: STORYBOARD_PROMPT_DRAFT_SCHEMA, artifactType: STORYBOARD_PROMPT_DRAFT_ARTIFACT, phase: rebuilt.phase as 'planned' | 'draft', promptDraft: true,
    commitKey: rebuilt.commit_key, messageId: value.message_id, sourceScript: input.segmented_script, originalInput: input, intakeVerified: true,
    executionMode: storyboardExecutionModeFromIntake(input),
    ...(draft.import_warnings?.length ? { importWarnings: [...draft.import_warnings] } : {}),
    settings: { directorMode: input.director_mode, directorLabel: STORYBOARD_DIRECTOR_MODE_LABELS[input.director_mode], targetDurationSeconds: input.target_duration_seconds, animationStyle: input.animation_style, aspectRatio: input.aspect_ratio },
    visualAssetPlan: draft.visual_asset_plan,
    segments: draft.segments.map(segment => ({ segmentId: `prompt_${segment.source_index}`, sourceIndex: segment.source_index, narration: segment.narration,
      imagePrompt: segment.image_prompt, videoPrompt: segment.video_prompt, panelCount: 4, layout: 'two_by_two', pacingMode: 'medium', actualShotCount: 0,
      shotTimeRanges: [], panoramicAnchorRole: null, continuityLinks: [], characterAssets: [], semanticVisualizations: [],
      ...(segment.asset_ids ? { visualAssetRefs: segment.asset_ids.map(id => ({ assetId: id, role: draft.visual_asset_plan.assets.find(asset => asset.id === id)!.role, referenceKinds: ['turnaround' as const] })) } : {}) })) };
}
