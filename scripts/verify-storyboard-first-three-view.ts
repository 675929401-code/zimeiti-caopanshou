import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStoryboardThreeViewPrompt, petThreeViewNeedsState, storyboardFirstThreeViewInput } from '../src/lib/storyboard-visual-asset-three-view';
import { storyboardReferenceImageSettings } from '../src/lib/storyboard-visual-asset-workspace';

const original = '  亚洲年轻女性，短黑发、蓝色开衫、白衬衣。\n保留原身份描述。  ';
const character = { role: 'character', name: '主人', planId: 'owner', prompt: original };
const first = storyboardFirstThreeViewInput(character);
assert.deepEqual(first.threeView, {});
assert.equal(first.prompt, original, 'imported identity must survive unchanged in the request input');
const prompt = buildStoryboardThreeViewPrompt('character', undefined, original, false);
assert.ok(prompt.endsWith(original));
assert.match(prompt, /直接创建同一主体/u);
assert.match(prompt, /近正面、自然侧面、近背面/u);
assert.doesNotMatch(prompt, /以实际提供的唯一参考图/u);
assert.throws(() => buildStoryboardThreeViewPrompt('character', undefined, '', false), /身份描述/u);

const pet = { role: 'pet', name: '青年老年犬', planId: 'dog', prompt: '幼年与老年，同一只蜂蜜金毛犬，绿胸背。' };
assert.equal(petThreeViewNeedsState(pet), true);
assert.deepEqual(storyboardFirstThreeViewInput(pet).threeView, {});
assert.deepEqual(storyboardFirstThreeViewInput(pet, 'current').threeView, {});
for (const state of ['young', 'senior'] as const) {
  const selected = storyboardFirstThreeViewInput(pet, state);
  assert.equal(selected.threeView?.petState, undefined, 'legacy age controls must not alter new requests');
  assert.equal(selected.threeView?.sourceAssetId, undefined);
  const compiled = buildStoryboardThreeViewPrompt('pet', state, pet.prompt, false);
  assert.ok(compiled.endsWith(pet.prompt));
  assert.equal(compiled, buildStoryboardThreeViewPrompt('pet', undefined, pet.prompt, false));
}
assert.ok(buildStoryboardThreeViewPrompt('pet', undefined, pet.prompt, false).endsWith(pet.prompt));
for (const description of ['红色鹦鹉，成年，写实风格。', '黑白幼猫，水彩风格。', '粉色章鱼玩偶，黏土质感。']) {
  const compiled = buildStoryboardThreeViewPrompt('pet', undefined, description, false);
  assert.ok(compiled.endsWith(description));
  assert.doesNotMatch(compiled, /犬类|四足|商业3D|只选取|青年状态|老年状态/u);
}
const optionalReference = storyboardFirstThreeViewInput(character, undefined, 'owned-asset-id');
assert.equal(optionalReference.threeView?.sourceAssetId, 'owned-asset-id');
assert.match(buildStoryboardThreeViewPrompt('character', undefined, original, true), /实际提供的唯一参考图/u);
const environment = { ...character, role: 'environment' };
assert.equal(storyboardFirstThreeViewInput(environment), environment, 'optional environment must retain its existing generation contract');
assert.equal([character, { ...pet, name: '成年犬', prompt: '成年蜂蜜金毛，绿胸背。' }].map(input => storyboardFirstThreeViewInput(input)).length, 2);

assert.deepEqual(storyboardReferenceImageSettings({ imageModelId: 'model', imageResolution: '1K', ratio: '9:16' }), {
  modelId: 'model', resolution: '2K', ratio: '16:9',
});
const settings = { modelId: 'selected', resolution: '4K', ratio: '16:9' as const };
assert.deepEqual(storyboardReferenceImageSettings({ imageModelId: 'model', imageResolution: '1K', ratio: '9:16',
  visualAssetWorkspace: { drafts: [], candidates: [], generationSettings: settings } }), settings);
const drawer = readFileSync('src/components/storyboard-visual-assets-drawer.tsx', 'utf8');
assert.ok(drawer.includes('props.onGenerate(storyboardFirstThreeViewInput('));
assert.ok(!drawer.includes('extendThreeView'));
assert.ok(drawer.includes('prompt: draft.prompt,'));
assert.ok(drawer.includes('使用已选图片辅助保持身份（可选）'));
console.log('PASS: first text-only character/pet turnaround, optional reference, original identity, prompt-owned species, age and style, batch input helper, independent 16:9/2K defaults and drawer entry. Zero network.');
