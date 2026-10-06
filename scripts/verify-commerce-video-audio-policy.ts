import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enforceVideoAudioPolicy } from '../src/commerce/server/video-audio-policy';
import { resolveFfmpegExecutable } from '../src/lib/video-postprocess';

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-commerce-audio-'));
  const audible = path.join(directory, 'audible.mp4');
  const silent = path.join(directory, 'silent.mp4');
  try {
  const generated = spawnSync(resolveFfmpegExecutable(), [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x160:r=12:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=44100:duration=1', '-shortest',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-movflags', '+faststart', audible,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr || 'fixture generation failed');
  const original = await fs.readFile(audible);
  const retained = await enforceVideoAudioPolicy({ bytes: original, type: 'video/mp4' }, true);
  assert.equal(retained.bytes, original, 'audio-enabled delivery must not be remuxed');
  const stripped = await enforceVideoAudioPolicy({ bytes: original, type: 'video/mp4' }, false);
  assert.ok(stripped.bytes.length > 0);
  assert.ok(stripped.bytes.length < original.length);
  await fs.writeFile(silent, stripped.bytes);
  const probe = spawnSync(resolveFfmpegExecutable(), ['-hide_banner', '-nostdin', '-i', silent], { encoding: 'utf8', windowsHide: true });
  const streams = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  assert.match(streams, /Video:/u);
  assert.doesNotMatch(streams, /Audio:/u);
  console.log(JSON.stringify({ suite: 'commerce-video-audio-policy', assertions: 6, passed: true, paidCalls: 0, originalBytes: original.length, silentBytes: stripped.bytes.length }));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
