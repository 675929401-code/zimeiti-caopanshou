import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveFfmpegExecutable } from '../src/lib/video-postprocess';
import { extractAudioFromLocalVideo } from '../src/lib/vs/link-extractor';

import {
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_SEED_AUDIO_REFERENCES,
  REFERENCE_AUDIO_DURATION_OPTIONS,
  REFERENCE_AUDIO_MAX_DURATION_SECONDS,
  REFERENCE_AUDIO_MIN_DURATION_SECONDS,
  normalizeReferenceAudioDuration,
} from '../src/lib/vs/reference-audio-contract';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const includesAll = (source: string, values: string[], label: string) => {
  for (const value of values) assert.ok(source.includes(value), `${label} missing ${value}`);
};

async function runFfmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(), args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`fixture ffmpeg exited ${code}: ${stderr.slice(-800)}`)));
  });
}

async function createFixtureVideo(output: string, duration: number) {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=#17201d:s=320x240:d=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=16000:duration=${duration}`,
    '-shortest', '-c:v', 'mpeg4', '-q:v', '8', '-c:a', 'aac', '-b:a', '64k', output,
  ]);
}

async function runLocalFfmpegFixture() {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'voice-reference-fixture-'));
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith('voice-reference-audio-')));
  try {
    const longVideo = path.join(fixtureDir, 'sixteen-seconds.mp4');
    const shortVideo = path.join(fixtureDir, 'eight-seconds.mp4');
    await createFixtureVideo(longVideo, 16);
    await createFixtureVideo(shortVideo, 8);

    const extracted = await extractAudioFromLocalVideo(longVideo, 15, { title: '本地夹具' });
    assert.equal(extracted.wav.toString('ascii', 0, 4), 'RIFF', 'local fixture did not produce a WAV');
    assert.ok(extracted.duration >= 14 && extracted.duration <= 15.05, `unexpected extracted duration: ${extracted.duration}`);
    await assert.rejects(
      () => extractAudioFromLocalVideo(shortVideo, 15),
      /不足 14 秒/u,
      'short source video was not rejected',
    );
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
  const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith('voice-reference-audio-') && !before.has(name));
  assert.deepEqual(after, [], `extractor leaked temporary directories: ${after.join(', ')}`);
}

async function main() {
  assert.equal(REFERENCE_AUDIO_MIN_DURATION_SECONDS, 14);
  assert.equal(REFERENCE_AUDIO_MAX_DURATION_SECONDS, 30);
  assert.deepEqual([...REFERENCE_AUDIO_DURATION_OPTIONS], [15, 20, 30]);
  assert.equal(MAX_REFERENCE_AUDIO_BYTES, 15 * 1024 * 1024);
  assert.equal(MAX_SEED_AUDIO_REFERENCES, 3);
  assert.equal(normalizeReferenceAudioDuration(14), 14);
  assert.equal(normalizeReferenceAudioDuration(30), 30);
  assert.throws(() => normalizeReferenceAudioDuration(10), /14-30/u);
  await runLocalFfmpegFixture();

  const client = read('src/lib/vs/reference-audio-extraction.ts');
  includesAll(client, [
    "fetch('/api/extract'",
    "extraction_mode: 'video'",
    'isActiveTemporaryExtractVideo(candidate)',
    'temporaryVideoUrl: video.temporary_url',
    "fetch('/api/voice/link-clone/extract-audio'",
    'assetId: String(voice.id)',
    'clearBrowserClientAttempt(storageKey, attempt.clientRequestId)',
  ], 'client two-stage extraction');
  assert.ok(!client.includes('audio_url'), 'client must not accept supplier audio_url');
  assert.ok(!client.includes('download_url'), 'client must not accept supplier download_url');
  assert.ok(!client.includes('url: shareText'), 'client must not fall back to the share page URL');

  const route = read('src/app/api/voice/link-clone/extract-audio/route.ts');
  includesAll(route, [
    "value.startsWith('/api/extract/local-video?')",
    "new Set(['file', 'owner', 'expires', 'sig'])",
    'ownerId !== userId',
    'verifyExtractTemporaryVideoSignature',
    'resolveExtractLocalVideoPath(fileHash)',
    'extractAudioFromLocalVideo(videoPath, duration',
    "source: 'link-extracted'",
    'registerCustomVoiceAsset',
  ], 'server owned temporary video gate');
  assert.ok(!route.includes('safeFetch'), 'audio stage must never fetch an arbitrary client URL');
  assert.ok(!route.includes('extractAudioFromLink'), 'legacy link resolver must not be reachable');

  const extractor = read('src/lib/vs/link-extractor.ts');
  includesAll(extractor, ['spawn(binary, args, { windowsHide: true })', "'-vn'", "'-ar', String(AUDIO_SAMPLE_RATE)", 'readWavDurationSeconds(wav)', 'actualDuration + 0.05 < REFERENCE_AUDIO_MIN_DURATION_SECONDS', 'await rm(tempDir, { recursive: true, force: true })'], 'local ffmpeg extraction');
  assert.ok(!extractor.includes("'-ss'"), 'extractor still skips two seconds and can undercut the 14 second minimum');
  assert.ok(!/PPT6|ppt6|safeFetch|download_url/u.test(extractor), 'legacy remote resolver remains in local extractor');

  const selector = read('src/components/vs/ReferenceAudioSelector.tsx');
  includesAll(selector, ['REFERENCE_AUDIO_DURATION_OPTIONS', 'MAX_REFERENCE_AUDIO_BYTES', '<AudioPlayer audioUrl={pendingAudio.voice.url}', 'assetId: pendingAudio.voice.id'], 'reference selector');
  assert.ok(!selector.includes('{10}秒'), 'selector still exposes an invalid 10 second option');

  const workspace = read('src/app/voice-studio/workspace/page.tsx');
  includesAll(workspace, ['extractReferenceAudioFromShareLink', 'references: audioGenLinks.map(item => ({ assetId: item.assetId }))', 'MAX_SEED_AUDIO_REFERENCES'], 'workspace reference submission');
  const imitate = read('src/app/voice-studio/imitate/page.tsx');
  includesAll(imitate, ['assetId?: string', 'assetId: audio.assetId', 'if (ref.assetId) return { assetId: ref.assetId }'], 'imitation owned reference submission');

  const tts = read('src/app/api/voice/tts/route.ts');
  includesAll(tts, ['prepareSeedAudioReferences(user.id, body)', 'readOwnedCustomVoiceAudio(userId, assetId)', 'MAX_SEED_AUDIO_REFERENCES', "throw new Error('参考音频链接不再直接接收，请重新选择已保存音频')"], 'server Seed Audio reference validation');

  const layout = read('src/app/voice-studio/layout.tsx');
  assert.ok(!layout.includes('GlobalTaskBar'), 'dead GlobalTaskBar remains mounted in voice layout');
  assert.equal(fs.existsSync(path.join(root, 'src/components/vs/LinkCloneForm.tsx')), false, 'unreachable legacy LinkCloneForm remains');

  console.log(JSON.stringify({
    verifier: 'voice-reference-audio-chain',
    passed: true,
    mode: 'offline-zero-cost-no-network-no-database-write',
    providerCalls: 0,
    paidRequests: 0,
    databaseMutations: 0,
    localFfmpegFixtures: { successSeconds: 16, rejectedSeconds: 8 },
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
