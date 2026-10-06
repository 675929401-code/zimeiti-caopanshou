import assert from 'node:assert/strict';
import { videoProgressStatus, videoProgressLabel } from '../src/lib/video-task-progress';

for (const stage of ['confirming_submission', 'submission_unknown']) {
  assert.equal(videoProgressStatus({ status: 'pending', processingStage: stage }), 'pending');
  assert.equal(videoProgressLabel({ processingStage: stage }), '正在确认原任务');
}
for (const stage of ['waiting_power', 'waiting_ready', 'retry_wait']) {
  assert.equal(videoProgressStatus({ status: 'queued', processingStage: stage }), 'queued');
}
for (const stage of ['dispatching', 'recovery_required', 'running']) {
  assert.equal(videoProgressStatus({ processingStage: stage }), 'processing');
}
for (const stage of ['result_staging', 'persisting', 'finalizing', 'billing']) {
  assert.equal(videoProgressStatus({ status: 'processing', processingStage: stage }), 'finalizing');
}
assert.equal(videoProgressStatus({ status: 'queued', processingStage: 'provider_wait' }), 'queued');
assert.equal(videoProgressStatus({ status: 'processing' }), 'processing');
assert.equal(videoProgressLabel({ status: 'processing' }), '生成中');
console.log('PASS: submission confirmation, resource preparation, generation and result delivery remain distinct');
