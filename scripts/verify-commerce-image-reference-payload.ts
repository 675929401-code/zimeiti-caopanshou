import assert from 'node:assert/strict';
import sharp from 'sharp';
import { providerImageReferenceDataUrl } from '../src/commerce/server/image-reference-payload';
import { confirmedFailureProviderCost, isExplicitImageProviderRejection, isExplicitProviderRejection } from '../src/commerce/server/provider-failure-classification';

async function main() {
  const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#ddd' } }).png().toBuffer();
  const preserved = await providerImageReferenceDataUrl(small, 'image/png');
  assert.equal(preserved.normalized, false);
  assert.equal(preserved.type, 'image/png');
  assert.equal(preserved.width, 640);
  assert.equal(preserved.height, 480);

  const large = await sharp({ create: { width: 4096, height: 3072, channels: 3, background: '#7289a8' } }).png().toBuffer();
  const bounded = await providerImageReferenceDataUrl(large, 'image/png');
  assert.equal(bounded.normalized, true);
  assert.equal(bounded.type, 'image/webp');
  assert.ok(bounded.width <= 2048 && bounded.height <= 2048);
  assert.ok(bounded.bytes <= 1_000_000);
  assert.match(bounded.dataUrl, /^data:image\/webp;base64,/u);

  assert.equal(isExplicitImageProviderRejection('IMAGE_PROVIDER_HTTP_413'), true);
  assert.equal(isExplicitImageProviderRejection('IMAGE_PROVIDER_HTTP_500'), false);
  assert.equal(isExplicitProviderRejection(new Error('模型桥接返回 HTTP 413')), true);
  assert.equal(confirmedFailureProviderCost('IMAGE_PROVIDER_HTTP_413', 0.16), 0);
  assert.equal(confirmedFailureProviderCost('模型桥接返回 HTTP 413', 0.16), 0);
  assert.equal(confirmedFailureProviderCost('IMAGE_PROVIDER_FAILED', 0.16), 0.16);
  console.log(JSON.stringify({ passed: 16, networkCalls: 0, paidCalls: 0, checks: ['small-preserved', 'small-type', 'small-width', 'small-height', 'large-normalized', 'large-webp', 'large-bounds', 'large-byte-budget', 'large-data-url', '413-explicit', '500-unknown', 'gateway-413-explicit', '413-zero-cost', 'gateway-413-zero-cost', 'provider-failed-cost', 'no-network'] }));
}

void main();
