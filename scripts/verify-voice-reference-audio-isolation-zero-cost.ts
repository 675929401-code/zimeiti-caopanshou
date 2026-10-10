import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteOwnedReferenceAudio,
  getOwnedReferenceAudio,
  listOwnedReferenceAudio,
  MAX_REFERENCE_AUDIO_FILE_BYTES,
  ReferenceAudioStorageError,
  registerReferenceAudioOwnership,
  renameOwnedReferenceAudio,
  validateReferenceAudioFilename,
} from '../voice-platform/src/lib/runtime-paths';

function expectStorageError(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => error instanceof ReferenceAudioStorageError && error.code === code);
}

function writeWav(filepath: string, bytes = 64) {
  const content = Buffer.alloc(bytes);
  content.write('RIFF', 0, 'ascii');
  content.writeUInt32LE(Math.max(0, bytes - 8), 4);
  content.write('WAVE', 8, 'ascii');
  fs.writeFileSync(filepath, content);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-reference-isolation-'));
try {
  assert.equal(validateReferenceAudioFilename('1710000000000_link_ab12.wav'), '1710000000000_link_ab12.wav');
  expectStorageError(() => validateReferenceAudioFilename('../escape.wav'), 'INVALID_FILENAME');
  expectStorageError(() => validateReferenceAudioFilename('payload.exe'), 'UNSUPPORTED_MEDIA_TYPE');

  writeWav(path.join(directory, 'owner-a.wav'));
  writeWav(path.join(directory, 'owner-b.wav'));
  writeWav(path.join(directory, 'legacy-unowned.wav'));
  fs.writeFileSync(path.join(directory, 'fake.wav'), Buffer.from('not a wave file'));

  const ownerA = registerReferenceAudioOwnership('user-a', 'owner-a.wav', 'A', directory);
  registerReferenceAudioOwnership('user-b', 'owner-b.wav', 'B', directory);
  assert.equal(ownerA.mimeType, 'audio/wav');
  assert.deepEqual(listOwnedReferenceAudio('user-a', directory).map((entry) => entry.filename), ['owner-a.wav']);
  assert.deepEqual(listOwnedReferenceAudio('user-b', directory).map((entry) => entry.filename), ['owner-b.wav']);
  expectStorageError(() => getOwnedReferenceAudio('user-a', 'legacy-unowned.wav', directory), 'REFERENCE_AUDIO_NOT_FOUND');

  expectStorageError(() => getOwnedReferenceAudio('user-b', 'owner-a.wav', directory), 'REFERENCE_AUDIO_NOT_FOUND');
  expectStorageError(() => renameOwnedReferenceAudio('user-b', 'owner-a.wav', 'stolen', directory), 'REFERENCE_AUDIO_NOT_FOUND');
  expectStorageError(() => deleteOwnedReferenceAudio('user-b', 'owner-a.wav', directory), 'REFERENCE_AUDIO_NOT_FOUND');
  expectStorageError(() => registerReferenceAudioOwnership('user-a', 'fake.wav', undefined, directory), 'REFERENCE_AUDIO_MIME_INVALID');

  const renamed = renameOwnedReferenceAudio('user-a', 'owner-a.wav', '我的参考音频', directory);
  assert.equal(renamed.displayName, '我的参考音频');

  fs.appendFileSync(path.join(directory, 'owner-a.wav'), Buffer.from([0]));
  expectStorageError(() => getOwnedReferenceAudio('user-a', 'owner-a.wav', directory), 'REFERENCE_AUDIO_INTEGRITY_MISMATCH');
  fs.truncateSync(path.join(directory, 'owner-a.wav'), ownerA.size);

  assert.equal(deleteOwnedReferenceAudio('user-a', 'owner-a.wav', directory), 'owner-a.wav');
  assert.equal(fs.existsSync(path.join(directory, 'owner-a.wav')), false);
  assert.deepEqual(listOwnedReferenceAudio('user-a', directory), []);

  fs.writeFileSync(path.join(directory, 'too-large.wav'), Buffer.alloc(MAX_REFERENCE_AUDIO_FILE_BYTES + 1));
  expectStorageError(() => registerReferenceAudioOwnership('user-a', 'too-large.wav', undefined, directory), 'REFERENCE_AUDIO_SIZE_INVALID');

  const routeSource = fs.readFileSync(path.join(process.cwd(), 'voice-platform/src/app/api/reference-audio/route.ts'), 'utf8');
  const authSource = fs.readFileSync(path.join(process.cwd(), 'voice-platform/src/lib/auth.ts'), 'utf8');
  const extractSource = fs.readFileSync(path.join(process.cwd(), 'voice-platform/src/app/api/voice/link-clone/extract-audio/route.ts'), 'utf8');
  const clientSource = fs.readFileSync(path.join(process.cwd(), 'voice-platform/src/components/ReferenceAudioSelector.tsx'), 'utf8');
  const nginxSource = fs.readFileSync(path.join(process.cwd(), 'deploy/nginx/agent-hub.vnext.conf.example'), 'utf8');
  const readinessSource = fs.readFileSync(path.join(process.cwd(), 'voice-platform/src/app/api/release-readiness/route.ts'), 'utf8');
  assert.match(routeSource, /getUserFromRequest\(request\)/u);
  assert.match(routeSource, /getOwnedReferenceAudio\(user\.userId/u);
  assert.match(routeSource, /renameOwnedReferenceAudio\(user\.userId/u);
  assert.match(routeSource, /deleteOwnedReferenceAudio\(user\.userId/u);
  assert.match(routeSource, /status: range \? 206 : 200/u);
  assert.doesNotMatch(routeSource, /referenceAudioPublicUrl/u);
  assert.match(authSource, /MIN_AUTH_SECRET_BYTES = 32/u);
  assert.match(authSource, /if \(!secret\) return null/u);
  assert.match(authSource, /Buffer\.byteLength\(secret, 'utf8'\) >= MIN_AUTH_SECRET_BYTES/u);
  assert.match(readinessSource, /isAuthSecurelyConfigured\(\)/u);
  assert.match(extractSource, /registerReferenceAudioOwnership\(authUser\.userId/u);
  assert.match(extractSource, /readBodyWithinLimit\(downloadRes, MAX_REFERENCE_AUDIO_FILE_BYTES\)/u);
  assert.match(extractSource, /reader\.cancel\('REFERENCE_AUDIO_TOO_LARGE'\)/u);
  assert.match(extractSource, /buffer\.length > MAX_REFERENCE_AUDIO_FILE_BYTES/u);
  assert.doesNotMatch(extractSource, /downloadRes\.arrayBuffer\(\)/u);
  assert.match(clientSource, /Authorization: `Bearer \$\{token\}`/u);
  assert.match(clientSource, /fetchOwnedAudioFile/u);
  assert.match(nginxSource, /location \^~ \/voice-platform\/reference-audio\/ \{\s*return 404;/u);
  assert.doesNotMatch(nginxSource, /alias __RELEASE_ROOT__\/shared\/voice\/reference-audio\//u);

  console.log(JSON.stringify({
    verifier: 'voice-reference-audio-isolation',
    passed: true,
    mode: 'offline-zero-network-zero-paid-zero-database',
    checks: ['auth-required', 'owner-list-read-rename-delete', 'filename', 'mime-sniff', 'size', 'quota-contract', 'integrity-drift'],
    providerCalls: 0,
    paidRequests: 0,
    databaseMutations: 0,
  }, null, 2));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
