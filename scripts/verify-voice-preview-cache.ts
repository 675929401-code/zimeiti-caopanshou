import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoicePreviewCache } from '../src/lib/server/voice-preview-cache';

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'voice-preview-cache-'));
  const cached = createVoicePreviewCache(directory);
  // A transport fixture for cache semantics; real MP3 decoding is a separate gate.
  const audio = { audioUrl: 'data:audio/mp3;base64,' + Buffer.from('ID3fixture-cache-only').toString('base64'), duration: 0 };
  const input = { speakerId: 'public-chinese-voice', text: '固定试听', providerIdentity: 'fixture-secret-never-persist', ownerId: null };
  let calls = 0;
  const generate = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return audio; };
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => cached(input, generate)));
  assert.equal(calls, 1); assert.ok(concurrent.every(result => result.audio.audioUrl === audio.audioUrl));
  assert.equal((await createVoicePreviewCache(directory)(input, generate)).cacheHit, true);
  assert.equal(calls, 1, 'A fresh cache instance must reuse the persisted result');
  await cached({ ...input, ownerId: 'alice' }, generate);
  await cached({ ...input, ownerId: 'bob' }, generate);
  assert.equal(calls, 3, 'Private voices must not share samples between accounts or with public samples');
  await cached({ ...input, text: '新试听' }, generate);
  await cached({ ...input, providerIdentity: 'new-provider' }, generate);
  assert.equal(calls, 5, 'Text and provider changes must invalidate the sample');
  const files = await readdir(directory);
  assert.equal(files.length, 5);
  for (const file of files) assert.ok(!(await readFile(path.join(directory, file), 'utf8')).includes(input.providerIdentity));
  await assert.rejects(cached({ ...input, speakerId: 'failed' }, async () => { throw new Error('provider failed'); }));
  assert.equal((await readdir(directory)).length, 5, 'Failures must never become cache hits');
  await assert.rejects(cached({ ...input, speakerId: 'bad-audio' }, async () => ({ audioUrl: 'data:audio/mp3;base64,YmFk', duration: 1 })));
  const expiredFile = path.join(directory, files[0]);
  const expired = JSON.parse(await readFile(expiredFile, 'utf8')); expired.expiresAt = 0;
  await writeFile(expiredFile, JSON.stringify(expired));
  const inputs = [input, { ...input, ownerId: 'alice' }, { ...input, ownerId: 'bob' }, { ...input, text: '新试听' }, { ...input, providerIdentity: 'new-provider' }];
  for (const variant of inputs) await cached(variant, generate);
  assert.equal(calls, 6, 'Only the expired sample may regenerate');
  console.log(JSON.stringify({ status: 'passed', concurrentRequests: 20, initialSynthesisCalls: 1, checks: ['restart reuse', 'private ownership', 'provider and text invalidation', 'no persisted credentials', 'no failed audio cached', 'expiry'] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
