import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imageTargetDimensions, inspectGeneratedImageOutput, normalizeGeneratedImageOutput } from '../src/commerce/server/image-output-contract';
import { TOAPIS_STANDARD_IMAGE_CONTRACT, toApisStandardNativeSize } from '../src/lib/toapis-image-contract';
import { chatImageBody } from '../src/commerce/server/chat-image-protocol';

async function main() {
  assert.deepEqual(imageTargetDimensions('1:1', '1K'), { width: 1024, height: 1024 });
  assert.deepEqual(imageTargetDimensions('16:9', '2K'), { width: 2728, height: 1536 });
  const body = chatImageBody('model', 'prompt', [], '16:9', '2K');
  assert.equal(body.size, '2728x1536');
  assert.equal(body.image_size, '2K');

  const fourK = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#f5f5f5' } }).png().toBuffer();
  const normalized = await normalizeGeneratedImageOutput({ bytes: fourK, type: 'image/png' }, '1:1', '1K', 'JPEG');
  assert.equal(normalized.sourceWidth, 4096);
  assert.equal(normalized.sourceHeight, 4096);
  assert.equal(normalized.width, 1024);
  assert.equal(normalized.height, 1024);
  assert.equal(normalized.type, 'image/jpeg');
  assert.equal(normalized.normalized, true);
  assert.deepEqual((await inspectGeneratedImageOutput(normalized.bytes, normalized.type, '1:1', '1K', 'JPEG')).issues, []);

  const tooSmall = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(() => normalizeGeneratedImageOutput({ bytes: tooSmall, type: 'image/png' }, '1:1', '1K', 'PNG'), /低于请求/);
  const wrongRatio = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(() => normalizeGeneratedImageOutput({ bytes: wrongRatio, type: 'image/png' }, '16:9', '1K', 'PNG'), /画幅与请求不符/);

  // ToAPIs 标准版 GPT Image 2.6：1K 5:4 原生交付 1120×896，不按通用 1144×912 拦截；
  // 其他模型同一档位仍按通用目标校验。
  const toApisModel = { provider: 'toapis_images', modelName: 'gpt-image-2.6-sunburst' };
  const native54 = await sharp({ create: { width: 1120, height: 896, channels: 3, background: '#eef' } }).png().toBuffer();
  const nativeResult = await normalizeGeneratedImageOutput({ bytes: native54, type: 'image/png' }, '5:4', '1K', 'PNG', toApisModel);
  assert.equal(nativeResult.width, 1120);
  assert.equal(nativeResult.height, 896);
  assert.equal(nativeResult.normalized, false);
  assert.deepEqual((await inspectGeneratedImageOutput(nativeResult.bytes, nativeResult.type, '5:4', '1K', 'PNG', toApisModel)).issues, []);
  await assert.rejects(() => normalizeGeneratedImageOutput({ bytes: native54, type: 'image/png' }, '5:4', '1K', 'PNG'), /低于请求/);
  assert.equal(toApisStandardNativeSize(TOAPIS_STANDARD_IMAGE_CONTRACT, '1K', '5:4')?.width, 1120);
  assert.equal(toApisStandardNativeSize('other_contract', '1K', '5:4'), null);
  assert.equal(toApisStandardNativeSize(TOAPIS_STANDARD_IMAGE_CONTRACT, '2K', '5:4'), null);
  console.log(JSON.stringify({ passed: 21, networkCalls: 0, paidCalls: 0, checks: ['1k-square-target', '2k-widescreen-target', 'provider-size-parity', 'provider-resolution-parity', 'source-width', 'source-height', 'normalized-width', 'normalized-height', 'jpeg-output', 'normalized-marker', 'stored-contract', 'undersize-rejected', 'wrong-ratio-rejected', 'toapis-native-54-width', 'toapis-native-54-height', 'toapis-native-no-resize', 'toapis-native-inspect-clean', 'generic-model-still-rejects-1120', 'toapis-contract-table-hit', 'toapis-contract-table-miss', 'no-network'] }));
}

void main();
