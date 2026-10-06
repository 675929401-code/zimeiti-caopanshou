import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';

import {
  deriveLongVideoParentPhase,
  planAliLongDigitalHumanVideo,
  quoteAliLongDigitalHumanVideo,
} from '../src/features/digital-human/long-video-segmentation';
import {
  cutLongDigitalHumanMediaFiles,
  mergeLongDigitalHumanVideoFiles,
} from '../src/lib/digital-human-long-media-local';
import { providerChannelCanClaim } from '../src/lib/digital-human-long-concurrency';
import { shouldSegmentHumanVideo } from '../src/features/digital-human/duration-policy';

const run = promisify(execFile);
const repo = path.resolve(__dirname, '..');

async function verifySqlContract() {
  const sql = await readFile(path.join(repo, 'supabase/migrations/20260904023000_digital_human_long_video_runtime.sql'), 'utf8');
  const attemptAccountingSql = await readFile(path.join(repo, 'supabase/migrations/20260904025000_digital_human_long_submission_attempt_accounting.sql'), 'utf8');
  const longClaim = sql.slice(sql.indexOf('CREATE FUNCTION public.claim_digital_human_long_segment'), sql.indexOf('CREATE FUNCTION public.retry_digital_human_long_segment'));
  const ordinaryClaim = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.claim_digital_video_dispatch'), sql.indexOf('REVOKE ALL ON FUNCTION'));
  assert.match(sql, /ADD COLUMN provider_key text/u);
  assert.match(sql, /ADD COLUMN model_hash text/u);
  assert.match(sql, /guard_digital_human_long_snapshot_immutable/u);
  assert.match(sql, /NEW\.provider_key IS DISTINCT FROM OLD\.provider_key/u);
  assert.match(sql, /NEW\.model_hash IS DISTINCT FROM OLD\.model_hash/u);
  assert.match(longClaim, /public\.digital_video_dispatch_jobs/u, 'long claim must inspect ordinary active jobs');
  assert.match(longClaim, /digital-video-channel:/u, 'long claim must share the provider advisory lock namespace');
  assert.match(ordinaryClaim, /public\.digital_human_long_segments/u, 'ordinary claim must inspect active long segments');
  assert.match(ordinaryClaim, /digital-video-channel:/u, 'ordinary claim must share the provider advisory lock namespace');
  assert.match(sql, /billing_operation_id = nullif\(trim\(p_billing_operation_id\)/u);
  assert.match(sql, /state = 'completed', billing_state = 'settled'/u);
  assert.match(sql, /merged_asset_id IS NULL/u);
  assert.match(sql, /digital_human_long_segments_completed_result_check/u);
  assert.match(sql, /pg_get_constraintdef\(oid\) LIKE '%video_task_id IS NOT NULL%'/u);
  assert.match(sql, /digital_human_long_jobs_completed_delivery_check/u);
  assert.match(sql, /billing_exempt AND locked_price_yuan = 0/u);
  assert.match(sql, /state IN \('dispatching','running','submission_unknown','finalizing','completed'\)/u);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/iu, 'forward-only runtime migration must not remove data');
  assert.match(attemptAccountingSql, /attempt_count = attempt_count \+ CASE WHEN v_segment\.state = 'queued' THEN 1 ELSE 0 END/u, 'status polls must not consume submission retries');
  assert.match(attemptAccountingSql, /public\.digital_video_dispatch_jobs/u, 'replacement claim must preserve ordinary queue exclusion');
  assert.match(attemptAccountingSql, /digital-video-channel:/u, 'replacement claim must preserve the shared provider lock');
  assert.doesNotMatch(attemptAccountingSql, /DROP TABLE|TRUNCATE|DELETE FROM/iu, 'forward-only attempt accounting migration must not remove data');
}

function verifyConcurrencyContract() {
  const activeOrdinary = [{ providerKey: 'provider-a', state: 'running' }];
  const activeLong = [{ providerKey: 'provider-a', state: 'dispatching' }];
  assert.equal(providerChannelCanClaim({ providerKey: 'provider-a', ownActive: [], oppositeActive: activeOrdinary }), false);
  assert.equal(providerChannelCanClaim({ providerKey: 'provider-a', ownActive: [], oppositeActive: activeLong }), false);
  assert.equal(providerChannelCanClaim({ providerKey: 'provider-b', ownActive: [], oppositeActive: [...activeOrdinary, ...activeLong] }), true);
  assert.equal(providerChannelCanClaim({ providerKey: 'provider-a', ownActive: [], oppositeActive: [{ providerKey: 'provider-a', state: 'completed' }] }), true);
}

function verifyPlanningAndBilling() {
  const plan = planAliLongDigitalHumanVideo({
    totalDurationSeconds: 245.5,
    boundaries: [
      { atSeconds: 80, kind: 'sentence' },
      { atSeconds: 82, kind: 'silence' },
      { atSeconds: 164, kind: 'manual' },
    ],
  });
  assert.equal(plan.segmentCount, 3);
  assert.ok(plan.segments.every((segment) => segment.durationSeconds > 2 && segment.durationSeconds <= 115));
  assert.equal(plan.segments.reduce((sum, segment) => sum + segment.durationSeconds, 0), 245.5);
  const quote = quoteAliLongDigitalHumanVideo(plan, 0.08);
  assert.equal(quote.lockedTotalYuan, 19.64);
  assert.equal(quote.segmentEstimates.reduce((sum, item) => Math.round((sum + item.amountYuan) * 100) / 100, 0), quote.lockedTotalYuan);
  const fractionalUnitQuote = quoteAliLongDigitalHumanVideo(plan, 0.005);
  assert.equal(fractionalUnitQuote.unitPriceYuan, 0.005);
  assert.equal(fractionalUnitQuote.lockedTotalYuan, 1.23);
  assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'completed', 'completed'], mergedAssetId: 'asset', lockedPriceYuan: 19.64 }), 'ready_to_settle');
  assert.equal(deriveLongVideoParentPhase({ childStates: ['completed', 'completed', 'completed'], mergedAssetId: 'asset', lockedPriceYuan: 19.64, chargedYuan: 19.64, billingOperationId: 'op' }), 'completed');
  assert.throws(() => deriveLongVideoParentPhase({ childStates: ['completed', 'running'], mergedAssetId: null, lockedPriceYuan: 19.64, chargedYuan: 19.64, billingOperationId: 'op' }), /禁止扣除用户费用/u);
}

async function verifyMediaPipeline() {
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || ffmpegStatic || '';
  assert.ok(ffmpeg, 'ffmpeg executable required');
  const directory = await mkdtemp(path.join(process.env.TEMP || process.cwd(), 'digital-human-long-test-'));
  try {
    const sourceVideo = path.join(directory, 'source.mp4');
    const sourceAudio = path.join(directory, 'source.wav');
    await Promise.all([
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x640:r=25:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourceVideo], { windowsHide: true, timeout: 60_000 }),
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=8', '-c:a', 'pcm_s16le', sourceAudio], { windowsHide: true, timeout: 60_000 }),
    ]);
    const outputs: string[] = [];
    for (const [index, start] of [0, 3].entries()) {
      const video = path.join(directory, `cut-${index}.mp4`);
      const audio = path.join(directory, `cut-${index}.wav`);
      await cutLongDigitalHumanMediaFiles({
        videoPath: sourceVideo, audioPath: sourceAudio, videoDurationSeconds: 8,
        startSeconds: start, durationSeconds: 3, outputVideoPath: video, outputAudioPath: audio,
      });
      // Provider fixtures include audio, so mux the cut speech into each result.
      const providerResult = path.join(directory, `provider-${index}.mp4`);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', providerResult], { windowsHide: true, timeout: 60_000 });
      outputs.push(providerResult);
    }
    const merged = path.join(directory, 'merged.mp4');
    await mergeLongDigitalHumanVideoFiles(outputs, merged);
    const result = await run(ffmpeg, ['-hide_banner', '-i', merged, '-f', 'null', '-'], { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    assert.match(result.stderr, /Video:/u);
    assert.match(result.stderr, /Audio:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyApiSurface() {
  for (const name of ['long-generate', 'long-status', 'long-history', 'long-cancel', 'long-download']) {
    const source = await readFile(path.join(repo, `src/app/api/digital-human/${name}/route.ts`), 'utf8');
    assert.match(source, /authorizeCurrentApiUser/u);
  }
  const worker = await readFile(path.join(repo, 'src/lib/digital-human-long-worker.ts'), 'utf8');
  assert.match(worker, /submission_unknown/u);
  assert.match(worker, /executeCashDeduction/u);
  assert.match(worker, /mergeLongDigitalHumanSegments/u);
  assert.match(worker, /idempotencyKey: text\(parent\.billing_idempotency_key\)/u);
  const page = await readFile(path.join(repo, 'src/app/digital-human/page.tsx'), 'utf8');
  // Exercise the same policy used by the page; input length alone cannot select
  // a different provider or route a non-Retalk model to the long-video worker.
  const retalk = { supportsLongVideoSegmentation: true };
  for (const seconds of [30, 60, 115]) assert.equal(shouldSegmentHumanVideo(retalk, 'video', seconds), false);
  for (const seconds of [115.1, 120, 245.5]) assert.equal(shouldSegmentHumanVideo(retalk, 'video', seconds), true);
  assert.equal(shouldSegmentHumanVideo(retalk, 'photo', 121), false);
  assert.equal(shouldSegmentHumanVideo({ supportsLongVideoSegmentation: false }, 'video', 121), false);
  assert.equal(shouldSegmentHumanVideo(undefined, 'video', 121), false);
  assert.equal(shouldSegmentHumanVideo(retalk, 'video', Number.NaN), false);
  assert.equal(shouldSegmentHumanVideo(retalk, 'video', Number.POSITIVE_INFINITY), false);
  assert.match(page, /\/api\/digital-human\/long-generate/u);
  assert.match(page, /\/api\/digital-human\/long-status/u);
  assert.match(page, /\/api\/digital-human\/long-history/u);
  assert.match(page, /\/api\/digital-human\/long-cancel/u);
  assert.match(page, /\/api\/digital-human\/long-download/u);
  assert.match(page, /自动分段合并/u);
  const downloadRoute = await readFile(path.join(repo, 'src/app/api/digital-human/long-download/route.ts'), 'utf8');
  assert.match(downloadRoute, /getLongJobDownloadForUser/u);
  const repository = await readFile(path.join(repo, 'src/lib/digital-human-long-repository.ts'), 'utf8');
  assert.match(repository, /responseFileName/u);
}

async function main() {
  await verifySqlContract();
  verifyConcurrencyContract();
  verifyPlanningAndBilling();
  await verifyMediaPipeline();
  await verifyApiSurface();
  console.log('PASS digital-human long-video runtime: plan, media cut/merge, bidirectional queue exclusion, parent-only billing, APIs');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
