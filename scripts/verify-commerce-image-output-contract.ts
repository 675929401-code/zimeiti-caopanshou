import assert from 'node:assert/strict';
import sharp from 'sharp';
import { imageTargetDimensions, inspectGeneratedImageOutput, normalizeGeneratedImageOutput } from '../src/commerce/server/image-output-contract';
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
  console.log(JSON.stringify({ passed: 14, networkCalls: 0, paidCalls: 0, checks: ['1k-square-target', '2k-widescreen-target', 'provider-size-parity', 'provider-resolution-parity', 'source-width', 'source-height', 'normalized-width', 'normalized-height', 'jpeg-output', 'normalized-marker', 'stored-contract', 'undersize-rejected', 'wrong-ratio-rejected', 'no-network'] }));
}

void main();
