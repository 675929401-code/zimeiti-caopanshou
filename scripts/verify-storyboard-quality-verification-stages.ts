import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseStoryboardDirectorPackage, validateStoryboardDirectorPackage, type StoryboardDirectorPackage } from '../src/lib/storyboard-director-protocol';
import { parseStoryboardCanvasImport } from '../src/lib/storyboard-canvas-bridge';
import { parseStructuredAgentOutput, buildStructuredAgentOutputReadyDetail } from '../src/lib/structured-agent-output';
import { createAgentWorkbenchHandoff } from '../src/lib/agent-workbench-handoff';
import { StoryboardQualityCheckSchema } from '../src/lib/storyboard-workbench';
import { StoryboardProjectDocument } from '../src/lib/storyboard-project-contract';
import { createStoryboardPersistenceSnapshot } from '../src/lib/storyboard-local-persistence';
import { prepareSelectedCardSourceUpdate } from '../src/lib/storyboard-visual-asset-selection';
import { refreshStoryboardVisualAssetReferences } from '../src/lib/storyboard-visual-asset-submission';

const checks: string[] = [];
const test = (name: string, run: () => void) => { run(); checks.push(name); };
const narration = '女孩抬手，金毛回头等待。';
const assetIds = ['character_main', 'pet_main'];
const verification = { kind: 'visual_asset_binding' as const, asset_ids: assetIds };
const base: StoryboardDirectorPackage = {
  schema_version: 'storyboard_director_output.v1', artifact_type: 'storyboard_director_package', director_mode: 'cinematic',
  input: { schema_version: 'storyboard_director_input.v1', segmented_script: `1.【${narration}】`, director_mode: 'cinematic',
    animation_style: '温暖家庭3D动画电影', aspect_ratio: '16:9', target_duration_seconds: 10, special_notes: '无对白' },
  visual_asset_plan: { mode: 'selected', generation_policy: { max_initial_images: 2, initial_required_asset_ids: assetIds,
    initial_deferred_asset_ids: [], environment_anchor_policy: 'per-scene-when-required' },
    assets: assetIds.map((id, index) => ({ id, role: index ? 'pet' : 'character', name: index ? '金毛宠物' : '主角女孩',
      identity_lock: '保持角色固定外观和所有身份识别特征不变', allowed_changes: ['姿态'],
      reference_prompts: [{ kind: 'identity', purpose: '固定身份参考', prompt: '保持同一身份和所有固定外观特征，使用中性站姿与干净背景。' }] })) },
  segments: [{ segment_id: 'segment_001', source_index: 1, narration, target_duration_seconds: 10, estimated_narration_duration: 2,
    panel_count: 4, layout: 'two_by_two', pacing_mode: 'medium', actual_shot_count: 2,
    shot_time_ranges: [{ shot_id: 'shot_01', start_seconds: 0, end_seconds: 5, action_beat: '女孩抬手' }, { shot_id: 'shot_02', start_seconds: 5, end_seconds: 10, action_beat: '金毛回头等待' }],
    continuity_links: [{ from_shot: 'shot_01', to_shot: 'shot_02', link_type: 'action_bridge', description: '动作与视线连续衔接' }],
    panoramic_anchor_role: null, character_assets: ['短黑发米色针织衫女孩', '蜂蜜金色金毛红色项圈'],
    semantic_visualizations: [{ trigger: '等待', visual_form: '耳侧轻抖线', interaction: '跟随回头动作减弱' }],
    storyboard_image_prompt: '严格四格2x2故事板，女孩抬手，蜂蜜金色金毛回头等待。',
    image_to_video_prompt: '先抬手，随后金毛回头等待；10秒两个连续镜头，衣服和项圈保持一致，无对白。',
    visual_asset_refs: assetIds.map((asset_id, index) => ({ asset_id, role: index ? 'pet' : 'character', reference_kinds: ['identity'] })),
    quality_checks: [{ check_id: 'binding_prerequisite', status: 'unknown', detail: '人物与宠物素材尚未绑定', verification }] }],
};
const clone = () => structuredClone(base);
const planningIssues = (pkg: StoryboardDirectorPackage) => validateStoryboardDirectorPackage(pkg, pkg.input, { stage: 'planning' });

test('explicit audio equivalents accept real V11 boundaries without requiring the character 声', () => {
  for (const boundary of [
    '只留室内底噪、衣料和自然呼吸，不生成如厕音效、口播、对白、音乐或字幕',
    '只留衣料和自然呼吸，不添加快门音、口播、对白、音乐或字幕',
    '只留衣料、触屏轻响与呼吸，不生成口播、对白、音乐或字幕',
    '只有自然呼吸', '仅保留室内底噪', '只留衣料摩擦声',
    '不生成口播、对白、音乐', '不添加对白', '禁止加入背景音乐',
    '无对白', '角色不说话', '声音边界：静音', '保留脚步声和环境声',
  ]) {
    const pkg = clone(); pkg.input.special_notes = '';
    pkg.segments[0].image_to_video_prompt = `先抬手，随后金毛回头等待；${boundary}。`;
    assert.deepEqual(planningIssues(pkg), [], boundary);
    pkg.input.special_notes = boundary;
    pkg.segments[0].image_to_video_prompt = '先抬手，随后金毛回头等待。';
    assert.deepEqual(planningIssues(pkg), [], `special_notes: ${boundary}`);
  }
});
test('missing audio, bare labels, visible breathing and written sound words do not satisfy the boundary', () => {
  for (const description of [
    '', '口播、对白、音乐', '可以生成对白', '加入音乐',
    '画面呈现自然呼吸动作', '只留衣料纹理', '只有自然呼吸动作',
    '写下声音二字', '书写“无对白”字样', '字幕显示音乐二字',
    '声音边界检查通过',
  ]) {
    const pkg = clone(); pkg.input.special_notes = '';
    pkg.segments[0].image_to_video_prompt = `先抬手，随后金毛回头等待；${description}。`;
    pkg.segments[0].quality_checks!.push({ check_id: 'sound_boundary', status: 'pass', detail: '模型自报通过' });
    assert.ok(planningIssues(pkg).includes('segment_001:missing_audio_boundary'), description);
  }
});
const nativeFileIndex = process.argv.indexOf('--native-assistant');
if (nativeFileIndex >= 0) {
  test('SHA-pinned original native 13-segment response passes planning without rewriting output', () => {
    const digestIndex = process.argv.indexOf('--native-sha256');
    assert.ok(digestIndex >= 0);
    const bytes = readFileSync(process.argv[nativeFileIndex + 1]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), process.argv[digestIndex + 1]);
    const pkg = parseStoryboardDirectorPackage(bytes.toString('utf8'));
    assert.ok(pkg); assert.equal(pkg.segments.length, 13);
    assert.deepEqual(planningIssues(pkg), []);
    // The three former failures must actually be present in this immutable native sample.
    for (const id of ['segment_004', 'segment_008', 'segment_011']) {
      const segment = pkg.segments.find(item => item.segment_id === id);
      assert.ok(segment);
      assert.match(segment.image_to_video_prompt, /只留/u);
      assert.doesNotMatch(`${segment.image_to_video_prompt}\n${pkg.input.special_notes}`, /(声|无对白|不说话)/u);
    }
  });
}

test('default strict rejects typed unknown; explicit planning accepts only a valid binding prerequisite', () => {
  assert.ok(validateStoryboardDirectorPackage(base, base.input).includes('segment_001:quality_check_unknown'));
  assert.deepEqual(planningIssues(base), []);
  for (const status of ['unknown', 'fail'] as const) {
    const pkg = clone(); pkg.segments[0].quality_checks = [{ check_id: 'semantic_check', status, detail: '语义质量待修正' }];
    assert.ok(planningIssues(pkg).includes(`segment_001:quality_check_${status}`));
    assert.ok(validateStoryboardDirectorPackage(pkg).length);
  }
  const failed = clone(); failed.segments[0].quality_checks![0].status = 'fail';
  assert.ok(planningIssues(failed).includes('segment_001:quality_check_fail'));
  const oldPass = clone(); oldPass.segments[0].quality_checks = [{ check_id: 'old_check', status: 'pass', detail: '既有检查通过' }];
  assert.deepEqual(validateStoryboardDirectorPackage(oldPass), []);
});
test('malformed verification cannot be dropped by parser or accepted by direct validation or project quality schema', () => {
  const invalid = [{ kind: 'other', asset_ids: assetIds }, { kind: 'visual_asset_binding', asset_ids: [] },
    { kind: 'visual_asset_binding', asset_ids: ['character_main', 'character_main'] },
    { kind: 'visual_asset_binding', asset_ids: [123] }, { kind: 'visual_asset_binding', asset_ids: assetIds, allowMissing: true }, null];
  for (const value of invalid) {
    const pkg = clone(); Object.assign(pkg.segments[0].quality_checks![0], { verification: value });
    assert.equal(parseStoryboardDirectorPackage(JSON.stringify(pkg)), null);
    assert.ok(planningIssues(pkg).length);
    assert.equal(StoryboardQualityCheckSchema.safeParse({ checkId: 'binding', status: 'unknown', detail: '尚待绑定', verification: value }).success, false);
  }
});
test('unknown assets, missing/extra refs, duplicate refs, off mode and role mismatch cannot become pending', () => {
  const variants: Array<(pkg: StoryboardDirectorPackage) => void> = [
    pkg => { pkg.segments[0].quality_checks![0].verification!.asset_ids = ['character_main', 'unknown_asset']; },
    pkg => { pkg.segments[0].quality_checks![0].verification!.asset_ids = ['character_main']; },
    pkg => { pkg.segments[0].visual_asset_refs!.pop(); },
    pkg => { pkg.segments[0].visual_asset_refs!.push(pkg.segments[0].visual_asset_refs![0]); },
    pkg => { pkg.visual_asset_plan!.mode = 'off'; },
    pkg => { pkg.segments[0].visual_asset_refs![0].role = 'pet'; },
  ];
  for (const mutate of variants) {
    const pkg = clone(); mutate(pkg); assert.ok(planningIssues(pkg).length);
    assert.equal(parseStoryboardCanvasImport({ source: 'stable_json', schema_version: base.schema_version, machine_payload: pkg }), null);
  }
});

const structured = parseStructuredAgentOutput(JSON.stringify(base));
const detail = buildStructuredAgentOutputReadyDetail('verification-stage-fixture', structured);
assert.ok(detail);
const imported = parseStoryboardCanvasImport(detail);
assert.ok(imported);
assert.ok(imported.visualAssetPlan);
test('structured output, official handoff, bridge and persistence preserve original unknown and verification', () => {
  assert.equal(structured.status, 'valid');
  assert.ok(createAgentWorkbenchHandoff(detail, 'storyboard-workbench'));
  assert.deepEqual(imported.pendingRuntimePrerequisites, [{ segmentId: 'segment_001', checkId: 'binding_prerequisite', verification }]);
  const check = StoryboardQualityCheckSchema.parse(imported.segments[0].qualityChecks![0]);
  assert.deepEqual(check.verification, verification); assert.equal(check.status, 'unknown');
  assert.equal(check.detail, base.segments[0].quality_checks![0].detail);
  const saved = createStoryboardPersistenceSnapshot({ id: 'verification_fixture', title: '阶段检查', createdAt: 1, updatedAt: 2,
    ratio: '16:9', imageResolution: '2K', videoResolution: '720p', videoDuration: 10, imageModelId: 'fixture', videoModelId: 'fixture',
    visualAssetPlan: imported.visualAssetPlan, cards: [{ ...imported.segments[0], id: 'card_001', order: 1, referenceImageUrls: [], imageStatus: 'idle', videoStatus: 'idle' }] });
  const project = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(project.cards[0].qualityChecks, [check]);
});
test('missing quality checks remain absent; malformed quality arrays reject persistence without silently becoming pass', () => {
  const minimal = { cards: [{ referenceImageUrls: [] as string[] }] };
  assert.equal('qualityChecks' in createStoryboardPersistenceSnapshot(minimal).cards[0], false);
  for (const qualityChecks of [null, {}, ['pass'], [{ checkId: 'binding', status: 'unknown', detail: '待绑定', verification: { kind: 'unsupported', asset_ids: assetIds } }]]) {
    assert.throws(() => createStoryboardPersistenceSnapshot({ cards: [{ referenceImageUrls: [], qualityChecks }] }));
  }
});

async function main() {
  assert.ok(imported);
  const card = { ...imported.segments[0], id: 'card_001', referenceImageUrls: [] as string[], visualAssetRefsMode: 'explicit' as const };
  const plan = imported.visualAssetPlan!;
  const sourced = { ...plan, assets: plan.assets.map((asset, index) => ({ ...asset, source: { kind: 'uploaded-image' as const, assetId: `owned_${index}` } })) };
  const urls = sourced.assets.map((asset, index) => ({ assetId: asset.source.assetId, previewUrl: `https://fixture.invalid/${index}.png` }));
  const partial = prepareSelectedCardSourceUpdate({ card, previousPlan: plan, plan: sourced, urls: urls.slice(0, 1), limit: 2 });
  assert.deepEqual(partial.missingIds, ['pet_main']);
  await assert.rejects(refreshStoryboardVisualAssetReferences({ card: partial.card, plan: sourced, limit: 2, resolve: async () => urls.slice(0, 1) }), /尚未落实或已失效/u);
  // A model's self-reported pass never replaces the resolver's current evidence.
  const fakePass = { ...card, qualityChecks: card.qualityChecks!.map(check => ({ ...check, status: 'pass' as const })) };
  await assert.rejects(refreshStoryboardVisualAssetReferences({ card: fakePass, plan: sourced, limit: 2, resolve: async () => [] }), /尚未落实或已失效/u);
  const complete = await refreshStoryboardVisualAssetReferences({ card: partial.card, plan: sourced, limit: 2, resolve: async () => urls });
  assert.deepEqual(complete.referenceImageUrls, urls.map(item => item.previewUrl));
  assert.equal(complete.qualityChecks![0].status, 'unknown');
  checks.push('partial source and fake pass still fail generation; both resolved sources permit binding without rewriting model observations');
  console.log(JSON.stringify({ passed: true, checks, checkCount: checks.length, providerCalls: 0, persistenceWrites: 0, runtimeVerified: false }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
