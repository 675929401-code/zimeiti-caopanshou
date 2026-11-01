import assert from 'node:assert/strict';
import { resolveStoryboardReferenceImageSettings } from '../src/lib/storyboard-reference-image-settings';
import { StoryboardReferenceImageSettingsSchema } from '../src/lib/storyboard-visual-asset-workspace';

const stored = { modelId: 'model_legacy', resolution: '2K', ratio: '16:9' as const };
const one = resolveStoryboardReferenceImageSettings(stored, { resolutionOptions: ['1K'], defaultResolution: '1K', aspectRatios: ['1:1'] });
assert.deepEqual(one, { ...stored, resolution: '1K', ratio: '1:1' });
assert.deepEqual(stored, { modelId: 'model_legacy', resolution: '2K', ratio: '16:9' });
assert.equal(resolveStoryboardReferenceImageSettings(one, { resolutionOptions: ['1K'], defaultResolution: '1K', aspectRatios: ['1:1'] }), one);
for (const resolution of ['1K', '2K', '4K']) for (const ratio of ['16:9', '9:16', '1:1'] as const) {
  const input = { ...stored, resolution, ratio };
  const resolved = resolveStoryboardReferenceImageSettings(input, { resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K', aspectRatios: ['16:9', '9:16', '1:1'] });
  assert.equal(resolved, input);
  assert.deepEqual(StoryboardReferenceImageSettingsSchema.parse(JSON.parse(JSON.stringify(resolved))), input);
}
assert.equal(resolveStoryboardReferenceImageSettings({ ...stored, resolution: '3K' }, { resolutionOptions: ['1K', '2K', '4K'], defaultResolution: '2K', aspectRatios: ['16:9', '1:1'] }).resolution, '2K');
console.log('PASS: reference settings use the same supported model, resolution and ratio for display/persistence/new submission; 1K-only legacy repair and explicit 1K/2K/4K choices. Zero network.');
