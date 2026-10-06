import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveAuthorizedVoiceSpeaker } from '../src/lib/vs/speaker-authorization';

const publicCatalog = [
  { speakerId: 'public-active', isActive: true },
  { speakerId: 'public-disabled', isActive: false },
];
const ownership = new Map([
  ['user-a', new Set(['owned-a'])],
  ['user-b', new Set(['owned-b'])],
]);
const resolveFor = (userId: string, speakerId: string) => resolveAuthorizedVoiceSpeaker({
  userId,
  speakerId,
  publicCatalog,
  findCompletedOwnedSpeaker: async (ownerId, candidate) => ownership.get(ownerId)?.has(candidate) === true,
});

async function main() {
  assert.equal(await resolveFor('user-a', 'public-active'), 'public-active');
  assert.equal(await resolveFor('user-a', 'public-disabled'), null);
  assert.equal(await resolveFor('user-a', 'owned-a'), 'owned-a');
  assert.equal(await resolveFor('user-a', 'owned-b'), null, 'foreign owned speaker was authorized');
  assert.equal(await resolveFor('user-b', 'owned-a'), null, 'foreign owned speaker was authorized for second user');
  assert.equal(await resolveFor('user-a', 'unknown-speaker'), null);
  assert.equal(await resolveFor('user-a', '../invalid'), null);

  const root = process.cwd();
  const tts = fs.readFileSync(path.join(root, 'src/app/api/voice/tts/route.ts'), 'utf8');
  const userVoices = fs.readFileSync(path.join(root, 'src/app/api/voice/user-voices/route.ts'), 'utf8');
  const guardIndex = tts.indexOf('const speakerRejection = await rejectUnauthorizedSpeakers(user, supabase, body)');
  for (const branch of [
    "if (body.textPrompt)",
    "if (body.mode === 'dual')",
    'if (body.mixSpeakers !== undefined)',
    'const { text, ssml, voiceId',
  ]) assert.ok(guardIndex >= 0 && guardIndex < tts.indexOf(branch), `speaker guard does not precede ${branch}`);
  for (const token of [
    'voiceIdSpeaker',
    'body.speaker2',
    'body.mixSpeakers.map',
    'body.references.map',
    "code: 'VOICE_SPEAKER_FORBIDDEN'",
    'upstreamSubmitted: false, creditsCharged: 0',
    "throw new Error('参考音频必须先上传并选择当前账号的已保存音频')",
  ]) assert.ok(tts.includes(token), `tts speaker guard missing ${token}`);
  assert.ok(userVoices.includes("code: 'VOICE_USER_CATALOG_WRITE_FORBIDDEN'"), 'arbitrary user speaker registration is still enabled');

  console.log(JSON.stringify({
    verifier: 'voice-speaker-authorization-contract',
    passed: true,
    usersChecked: ['user-a', 'user-b'],
    providerCalls: 0,
    paidRequests: 0,
    databaseMutations: 0,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
