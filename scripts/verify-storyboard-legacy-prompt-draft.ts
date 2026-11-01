import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeStoryboardDirectorInput, STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } from '../src/lib/storyboard-director-protocol';
import { buildLegacyStoryboardDraftDetail, buildHistoricalStoryboardMessageDraft, parseLegacyStoryboardDraftImport } from '../src/lib/storyboard-legacy-prompt-draft';
import { parseStoryboardCanvasImport } from '../src/lib/storyboard-canvas-bridge';
import { createAgentWorkbenchHandoff } from '../src/lib/agent-workbench-handoff';

const input = normalizeStoryboardDirectorInput({segmented_script: '1\\. 小狗递球。\n2\\. 主人蹲下陪伴。', director_mode: 'high_energy', animation_style: '高能3D', aspect_ratio: '9:16', target_duration_seconds: 15,
  special_notes: '黄色外套；保留现场声。', visual_asset_mode: '普通模式'});
const pair = (index: number, narration: string) => `**原文案内容段落 ${index}**：\n${index}\\. ${narration}\n\n**生图提示词**：\n\`\`\`text\n画面${index}：黄色外套主人与小狗，4格。\n\`\`\`\n\n**视频提示词**：\n\`\`\`text\n动作${index}：人物低头，小狗摇尾。\n\`\`\``;
const text = `${pair(1, '小狗递球。')}\n\n${pair(2, '主人蹲下陪伴。')}`;
const message = {id: 'legacy-msg', role: 'assistant', content: text};
const options = {allowLegacy: true, submittedAt: 100, cutoff: 200};
let checks = 0;
function check(name: string, test: () => void) {test(); checks++; console.log(`PASS ${name}`);}
check('complete escaped-number pairs preserve prompts and original card', () => {
  const detail = buildLegacyStoryboardDraftDetail(message, input, options); assert.ok(detail);
  const plan = parseStoryboardCanvasImport(detail); assert.ok(plan); assert.equal(plan.phase, 'draft');
  assert.equal(plan.segments.length, 2); assert.equal(plan.settings.targetDurationSeconds, 15); assert.equal(plan.settings.aspectRatio, '9:16');
  assert.equal(plan.originalInput.special_notes, input.special_notes); assert.equal(plan.sourceScript, input.segmented_script);
  assert.deepEqual(plan.segments[0].shotTimeRanges, []); assert.equal(plan.segments[0].actualShotCount, 0);
  assert.equal(plan.segments[0].performancePlan, undefined); assert.equal(plan.productionContractVersion, undefined); assert.equal(plan.intakeVerified, false);
  assert.ok(plan.legacyDraftWarning); assert.ok(createAgentWorkbenchHandoff(detail, 'storyboard-workbench'));
});
for (const [name, patch] of [['streaming', {isStreaming: true}], ['failed', {error: 'failed'}], ['unknown terminal', {streamStatus: 'unknown'}], ['user message', {role: 'user'}]] as const) {
  check(name, () => assert.equal(buildLegacyStoryboardDraftDetail({...message, ...patch}, input, options), null));
}
check('new messages and unknown times cannot downgrade', () => {
  for (const submittedAt of [200, 201, NaN, 0, undefined]) assert.equal(buildLegacyStoryboardDraftDetail(message, input, {...options, submittedAt}), null);
  assert.equal(buildLegacyStoryboardDraftDetail(message, input, {...options, allowLegacy: false}), null);
});
check('missing or reference original card cannot downgrade', () => {
  assert.equal(buildLegacyStoryboardDraftDetail(message, undefined, options), null);
  assert.equal(buildLegacyStoryboardDraftDetail(message, {...input, visual_asset_mode: '角色参考模式'}, options), null);
});
check('missing pair, extra pair, wrong labels and quoted narration are rejected', () => {
  for (const content of [pair(1, '小狗递球。'), `${text}\n${pair(3, '多余段。')}`, text.replace('**生图提示词**', '**视频提示词**'), text.replace('1\\. 小狗递球。', '1\\. 改写原文。'), `${text}\n\`\`\`text\n未完成`]) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content}, input, options), null);
  }
});
check('host timestamp and frozen activation determine eligibility', () => {
  const history = [{id: 'user', role: 'user', timestamp: 100}, {id: message.id, role: 'assistant', timestamp: 900}];
  assert.ok(buildHistoricalStoryboardMessageDraft(message, history, input, {production_contract_activated_at: new Date(200).toISOString()}, true));
  assert.equal(buildHistoricalStoryboardMessageDraft(message, history, input, {}, true), null);
});
check('changed prompt, original input, injected production claim and commit are rejected', () => {
  const detail = buildLegacyStoryboardDraftDetail(message, input, options)!;
  const mutated = structuredClone(detail); (mutated.machine_payload as {segments: Array<{image_prompt: string}>}).segments[0].image_prompt = 'forged';
  assert.equal(parseLegacyStoryboardDraftImport(mutated), null);
  assert.equal(parseLegacyStoryboardDraftImport({...detail, expected_input: {...input, special_notes: 'changed'}}), null);
  assert.equal(parseLegacyStoryboardDraftImport({...detail, require_performance_plan: true}), null);
  assert.equal(parseLegacyStoryboardDraftImport({...detail, commit_key: 'forged'}), null);
});
fs.mkdirSync('.codex-evidence/director-refinement-20261023/continuous-followup', {recursive: true});
check('bridge rejects forced production contract for drafts', () => {
  const detail = buildLegacyStoryboardDraftDetail(message, input, options)!;
  assert.equal(parseStoryboardCanvasImport(detail, {requiredContractVersion: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION}), null);
});
check('bridge rejects required performance plan for drafts', () => {
  const detail = buildLegacyStoryboardDraftDetail(message, input, options)!;
  assert.equal(parseStoryboardCanvasImport(detail, {requirePerformancePlan: true}), null);
});
check('bridge preserves caller original input binding for drafts', () => {
  const detail = buildLegacyStoryboardDraftDetail(message, input, options)!;
  assert.ok(parseStoryboardCanvasImport(detail, {expectedInput: input}));
  assert.equal(parseStoryboardCanvasImport(detail, {expectedInput: {...input, special_notes: 'changed'}}), null);
});
const thirteen = Array.from({length: 13}, (_, index) => `第${index + 1}段原文，保留“可能”与原标点。`);
const oldInput = normalizeStoryboardDirectorInput({...input, segmented_script: thirteen.map((line, index) => `${index + 1}.【${line}】`).join('\n'), visual_asset_mode: undefined});
const numberedPair = (index: number, narration: string) => `## ${index}.【${narration}】\n\n### 生图提示词\n\`\`\`text\n图片原词${index}：服装、角色、构图逐字保留。\n\`\`\`\n\n### 视频提示词\n\`\`\`text\n视频原词${index}：动作顺序与声音要求逐字保留。\n\`\`\``;
const visibleThirteen = thirteen.map((line, index) => numberedPair(index + 1, line)).join('\n\n');
const partialMachine = {schema_version: 'storyboard_director_output.v1', artifact_type: 'storyboard_director_package', input: oldInput,
  segments: [{segment_id: 'segment_001', storyboard_image_prompt: '机器包仅含第一段，不能覆盖13组可见提示词。'}]};
const jsonTail = (value: unknown, language = 'json') => `\n\n\`\`\`${language}\n${JSON.stringify(value, null, 2)}\n\`\`\``;
check('old missing mode plus 13 numbered quoted headings imports all visible pairs', () => {
  const detail = buildLegacyStoryboardDraftDetail({...message, content: visibleThirteen + jsonTail(partialMachine)}, oldInput, options); assert.ok(detail);
  const plan = parseStoryboardCanvasImport(detail); assert.ok(plan); assert.equal(plan.segments.length, 13);
  assert.equal(plan.originalInput.visual_asset_mode, undefined); assert.ok(plan.legacyDraftWarning?.includes('未记录视觉资产模式'));
  for (const [index, segment] of plan.segments.entries()) {
    assert.equal(segment.narration, thirteen[index]); assert.equal(segment.imagePrompt, `图片原词${index + 1}：服装、角色、构图逐字保留。`);
    assert.equal(segment.videoPrompt, `视频原词${index + 1}：动作顺序与声音要求逐字保留。`);
    assert.equal(segment.performancePlan, undefined); assert.deepEqual(segment.shotTimeRanges, []); assert.equal(segment.actualShotCount, 0);
  }
  assert.equal(plan.visualAssetPlan, undefined); assert.equal(plan.productionContractVersion, undefined);
});
check('typed complete machine_json and stable_json fences are transport only', () => {
  for (const language of ['json', 'machine_json', 'stable_json']) assert.ok(buildLegacyStoryboardDraftDetail({...message, content: visibleThirteen + jsonTail(partialMachine, language)}, oldInput, options));
  assert.ok(buildLegacyStoryboardDraftDetail({...message, content: `${visibleThirteen}\n<!-- storyboard_director_output:v1 ${JSON.stringify(partialMachine)} -->`}, oldInput, options));
});
check('explicit reference and unknown recorded modes never use the missing-mode path', () => {
  for (const mode of ['参考图模式', '角色参考模式', 'selected', 'reference', '', 'unknown']) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content: visibleThirteen}, {...oldInput, visual_asset_mode: mode}, options), null);
  }
});
check('quoted heading number and narration must match every original segment', () => {
  for (const content of [visibleThirteen.replace('## 8.【', '## 9.【'), visibleThirteen.replace(thirteen[11], '第12段被改写。')]) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content}, oldInput, options), null);
  }
});
check('arbitrary json and mismatched protocol types are never ignored', () => {
  for (const value of [{foo: 'arbitrary JSON'}, {...partialMachine, artifact_type: 'another_artifact'}, {...partialMachine, schema_version: 'unknown.v1'}, {...partialMachine, input: undefined}]) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content: visibleThirteen + jsonTail(value)}, oldInput, options), null);
  }
});
check('extra text or prompt fences cannot masquerade as ignored machine transport', () => {
  for (const content of [visibleThirteen + jsonTail(partialMachine, 'text'), visibleThirteen + jsonTail(partialMachine, 'prompt'),
    `${visibleThirteen}\n\`\`\`text\n额外提示词\n\`\`\`` + jsonTail(partialMachine), visibleThirteen + jsonTail(partialMachine) + '\n附加文本不能被一并忽略。',
    `${visibleThirteen}\n### 视频提示词\n多出一个未加代码框的提示词` + jsonTail(partialMachine)]) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content}, oldInput, options), null);
  }
});
check('truncated malformed or multiple machine fences remain blocked', () => {
  for (const content of [visibleThirteen + jsonTail(partialMachine).slice(0, -3), visibleThirteen + '\n```json\n{"schema_version":',
    visibleThirteen + jsonTail(partialMachine) + jsonTail(partialMachine)]) {
    assert.equal(buildLegacyStoryboardDraftDetail({...message, content}, oldInput, options), null);
  }
});
check('old missing mode never downgrades a new or unknown timestamp', () => {
  for (const submittedAt of [200, 201, NaN, undefined]) assert.equal(buildLegacyStoryboardDraftDetail({...message, content: visibleThirteen}, oldInput, {...options, submittedAt}), null);
});
fs.writeFileSync('.codex-evidence/director-refinement-20261023/continuous-followup/legacy-draft-result.json', JSON.stringify({passed: true, checks, providerCalls: 0}, null, 2));
console.log(JSON.stringify({passed: true, checks}));
