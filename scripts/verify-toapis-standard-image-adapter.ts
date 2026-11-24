import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildToApisStandardImagePayload, TOAPIS_STANDARD_IMAGE_CONTRACT } from '../src/lib/secure-skill-async-image-adapter';

// Zero-network contract for the ToAPIs standard GPT Image 2.6 backup channel:
// fixed high quality, aspect + K tier submission, at most 10 public reference URLs.
function main() {
  const payload = buildToApisStandardImagePayload({
    modelName: 'gpt-image-2.6-sunburst', prompt: '牛仔夹克白底图', resolution: '1K', aspectRatio: '5:4',
    pixelSize: '1144x912', referenceImageUrls: ['https://example.com/a.png'],
  } as Parameters<typeof buildToApisStandardImagePayload>[0]);
  assert.equal(payload.model, 'gpt-image-2.6-sunburst');
  assert.equal(payload.quality, 'high');
  assert.equal(payload.size, '5:4');
  assert.equal(payload.resolution, '1K');
  assert.equal(payload.n, 1);
  assert.deepEqual(payload.reference_images, ['https://example.com/a.png']);
  assert.ok(!('pixelSize' in payload) && !('image_size' in payload) && !('aspect_ratio' in payload));

  const noRefs = buildToApisStandardImagePayload({
    modelName: 'gpt-image-2.6-sunburst', prompt: 'p', resolution: '2K', aspectRatio: '1:1', pixelSize: '2048x2048',
  } as Parameters<typeof buildToApisStandardImagePayload>[0]);
  assert.ok(!('reference_images' in noRefs));

  const ten = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`);
  assert.equal((buildToApisStandardImagePayload({
    modelName: 'm', prompt: 'p', resolution: '2K', aspectRatio: '1:1', pixelSize: '2048x2048', referenceImageUrls: ten,
  } as Parameters<typeof buildToApisStandardImagePayload>[0]).reference_images as string[]).length, 10);
  assert.throws(() => buildToApisStandardImagePayload({
    modelName: 'm', prompt: 'p', resolution: '2K', aspectRatio: '1:1', pixelSize: '2048x2048', referenceImageUrls: [...ten, 'https://example.com/x.png'],
  } as Parameters<typeof buildToApisStandardImagePayload>[0]), /INVALID_TOAPIS_IMAGE_REFERENCES/);
  assert.throws(() => buildToApisStandardImagePayload({
    modelName: 'm', prompt: 'p', resolution: '2K', aspectRatio: '1:1', pixelSize: '2048x2048', referenceImageUrls: ['data:image/png;base64,xx'],
  } as Parameters<typeof buildToApisStandardImagePayload>[0]), /INVALID_TOAPIS_IMAGE_REFERENCES/);

  const report = {
    passed: 12, networkCalls: 0, paidCalls: 0,
    checks: ['model-passthrough', 'fixed-quality-high', 'size-is-aspect', 'resolution-tier', 'single-image', 'reference-images-array',
      'no-generic-pixel-fields', 'refs-omitted-when-empty', 'max-10-refs', 'over-10-rejected', 'inline-data-url-rejected', 'contract-constant'],
    contract: TOAPIS_STANDARD_IMAGE_CONTRACT,
    bindings: ['src/lib/secure-skill-async-image-adapter.ts', 'src/lib/toapis-image-contract.ts']
      .map((file) => ({ file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') })),
  };
  assert.equal(TOAPIS_STANDARD_IMAGE_CONTRACT, 'toapis_gpt_image_2_6_standard.v1');
  console.log(JSON.stringify(report));
}

main();
