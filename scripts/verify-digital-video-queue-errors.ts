import assert from 'node:assert/strict';
import { localVideoTaskFailureMessage, classifyVideoProviderError } from '../src/lib/video-error-policy';
assert.match(localVideoTaskFailureMessage('INSUFFICIENT_CASH_BALANCE')!, /本站钱包余额不足/);
assert.match(localVideoTaskFailureMessage('MEMBERSHIP_REQUIRED')!, /会员状态/);
assert.equal(localVideoTaskFailureMessage('CHANNEL_QUOTA_UNAVAILABLE'), undefined);
assert.equal(localVideoTaskFailureMessage('__proto__'), undefined);
assert.equal(classifyVideoProviderError('insufficient quota').code, 'CHANNEL_QUOTA_UNAVAILABLE');
assert.equal(classifyVideoProviderError('invalid api key').code, 'CHANNEL_AUTH_INVALID');
assert.equal(classifyVideoProviderError('Arrearage: account balance is insufficient').code, 'CHANNEL_QUOTA_UNAVAILABLE');
assert.equal(classifyVideoProviderError('[InvalidAccessKeyId]: credential rejected').code, 'CHANNEL_AUTH_INVALID');
assert.equal(classifyVideoProviderError('[InvalidParameter]: audio_url is invalid').code, 'VIDEO_INPUT_INVALID');
assert.equal(classifyVideoProviderError('[DataInspectionFailed]: sensitive content').code, 'VIDEO_CONTENT_REJECTED');
assert.equal(classifyVideoProviderError('[Throttling]: request limit exceeded').code, 'CHANNEL_RATE_LIMITED');
const audioFiltered = classifyVideoProviderError('视频生成失败: PUBLIC_ERROR_AUDIO_FILTERED，请重试', 'VEO 3.1 图生视频 Lite');
assert.equal(audioFiltered.category, 'content_policy');
assert.equal(audioFiltered.code, 'VIDEO_AUDIO_CONTENT_REJECTED');
assert.equal(audioFiltered.retryable, false);
assert.match(audioFiltered.publicMessage, /^VEO 3.1 图生视频 Lite.*音频未通过审核/);
assert.doesNotMatch(audioFiltered.publicMessage, /充值|密钥|认证|人工对账|PUBLIC_ERROR|未扣费|退款/);
assert.equal(classifyVideoProviderError(audioFiltered.publicMessage, 'VEO 3.1 图生视频 Lite').code, audioFiltered.code, 'History reclassification must preserve the audio-review error');
for (const message of ['PUBLIC_ERROR_VIDEO_FILTERED', 'PUBLIC_ERROR_IMAGE_FILTERED', 'content_filter']) {
  assert.equal(classifyVideoProviderError(message, '所选模型').code, 'VIDEO_CONTENT_REJECTED');
}
assert.equal(classifyVideoProviderError('当前 VEO 首尾帧模型需要首帧和尾帧两张图片。').code, 'VIDEO_FRAMES_REQUIRED');
assert.equal(classifyVideoProviderError('模型需要提供首帧和尾帧。').code, 'VIDEO_FRAMES_REQUIRED');
assert.equal(classifyVideoProviderError('PUBLIC_ERROR_INTERNAL_GENERATION').code, 'VIDEO_GENERATION_FAILED');
console.log('Digital queue errors: site wallet, membership, provider quota and credentials stay distinct. PASS');

assert.equal(classifyVideoProviderError('算力橙视频提交失败（HTTP 403）：预扣费额度失败, 用户剩余额度: ¥1.000071, 需要预扣费额度: ¥1.899986').code, 'CHANNEL_QUOTA_UNAVAILABLE');
