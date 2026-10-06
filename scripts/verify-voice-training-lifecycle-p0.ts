import fs from 'node:fs';
import path from 'node:path';

import { validateAudioFileSignature } from '../src/lib/audio-file-signature';
import { getVolcanoVoiceCredentialReference, loadVolcanoVoiceProviderConfig } from '../src/lib/server/voice-provider-config';
import { deriveVoiceTrainingSpeakerId } from '../src/lib/server/voice-training-lifecycle';

const root = process.cwd();
function read(relativePath: string) { return fs.readFileSync(path.join(root, relativePath), 'utf8'); }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function includesAll(source: string, tokens: string[], label: string) {
  for (const token of tokens) assert(source.includes(token), `${label} missing: ${token}`);
}

async function main() {

const wav = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0,
]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
const oggOpus = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20), Buffer.from('OpusHead')]);
assert(validateAudioFileSignature({ bytes: wav, fileName: 'a.wav', mimeType: 'audio/wav' }).extension === 'wav', 'valid WAV rejected');
assert(validateAudioFileSignature({ bytes: mp3, fileName: 'a.mp3', mimeType: 'audio/mpeg' }).extension === 'mp3', 'valid MP3 rejected');
assert(validateAudioFileSignature({ bytes: oggOpus, fileName: 'a.opus', mimeType: 'audio/opus' }).extension === 'opus', 'valid Opus rejected');
let mismatchRejected = false;
try { validateAudioFileSignature({ bytes: wav, fileName: 'fake.mp3', mimeType: 'audio/mpeg' }); } catch { mismatchRejected = true; }
assert(mismatchRejected, 'extension/MIME spoof was accepted');

const cloneSpeaker = deriveVoiceTrainingSpeakerId('user-a', 'attempt-1', 'clone');
assert(cloneSpeaker === deriveVoiceTrainingSpeakerId('user-a', 'attempt-1', 'clone'), 'speaker derivation is not deterministic');
assert(cloneSpeaker.startsWith('S_') && cloneSpeaker.length === 26, 'clone speaker format invalid');
assert(deriveVoiceTrainingSpeakerId('user-a', 'attempt-1', 'design').startsWith('D_'), 'design speaker format invalid');

const configuredRow = {
  id: 'voice-volcano', name: '火山语音供应商', role: 'voice_provider', subtype: 'tts', is_active: true,
  config: { provider: 'volcengine', api_key: 'secret://voice-test' },
};
assert(getVolcanoVoiceCredentialReference(configuredRow) === 'secret://voice-test', 'active voice provider binding not selected');
assert(getVolcanoVoiceCredentialReference({ ...configuredRow, is_active: false }) === '', 'inactive voice binding selected');
const configured = await loadVolcanoVoiceProviderConfig({
  listActivePlugins: async () => [configuredRow],
  resolveSecret: () => 'configured-secret-value',
  environment: {},
});
assert(configured?.source === 'plugins' && configured.apiKey === 'configured-secret-value', 'configured provider did not enter ready state');
const absent = await loadVolcanoVoiceProviderConfig({ listActivePlugins: async () => [], environment: {} });
assert(absent === null, 'missing provider config did not fail closed');

const cloneRoute = read('src/app/api/voice/clone/route.ts');
const designRoute = read('src/app/api/voice/design/route.ts');
const statusRoute = read('src/app/api/voice/status/route.ts');
const lifecycle = read('src/lib/server/voice-training-lifecycle.ts');
const migration = read('supabase/migrations/20260901153000_voice_training_provider_lifecycle.sql');
const extractRoute = read('src/app/api/voice/link-clone/extract-audio/route.ts');
const extractor = read('src/lib/vs/link-extractor.ts');
const selector = read('src/components/vs/ReferenceAudioSelector.tsx');
const referenceClient = read('src/lib/vs/reference-audio-extraction.ts');
const clonePage = read('src/app/voice-studio/clone/page.tsx');
const designPage = read('src/app/voice-studio/design/page.tsx');
const volcano = read('src/lib/vs/volcengine.ts');

for (const [label, source] of [['clone', cloneRoute], ['design', designRoute]] as const) {
  includesAll(source, ['claimVoiceTrainingProviderCall', 'markVoiceTrainingProviderAttempt', 'providerCallStarted = true', 'reconciliation_required', 'finalizeVoiceTrainingReady', "!== 'ready'"], label);
  assert(!source.includes('finalize_voice_training_authorization_atomic'), `${label} bypasses ready-only finalizer`);
  assert(!source.includes('release_voice_training_authorization_atomic'), `${label} bypasses terminal-evidence release`);
  assert(source.indexOf('markVoiceTrainingProviderAttempt') < source.lastIndexOf('finalizeVoiceTrainingReady'), `${label} finalizes before persistent lifecycle`);
}

includesAll(statusRoute, [
  'loadOwnedVoiceTrainingJob(db, user.id, jobKey, operation)',
  "body.jobKey ?? body.clientRequestId",
  "operationKind",
  'finalizeVoiceTrainingReady',
  "terminalKind: 'provider_failed'",
  'reconciliation_required',
], 'owner-scoped status route');
assert(!statusRoute.includes('body.speakerId'), 'status route trusts client speakerId');
assert(!statusRoute.includes('getVoiceStatus(body.'), 'status route queries arbitrary speakerId');

includesAll(lifecycle, ['.eq(\'user_id\', userId)', ".eq('job_key', jobKey)", 'claim_voice_training_provider_call_atomic', 'mark_voice_training_provider_attempt_atomic', 'release_voice_training_terminal_atomic', 'finalize_voice_training_ready_atomic'], 'lifecycle store');
includesAll(migration, ['provider_pending', 'reconciliation_required', 'provider_call_started_at', 'claim_voice_training_provider_call_atomic', 'VOICE_TRAINING_PROVIDER_MAY_HAVE_STARTED', 'VOICE_TRAINING_TERMINAL_READY_REQUIRED', 'TO service_role'], 'lifecycle migration');

includesAll(extractRoute, ['registerCustomVoiceAsset', 'audioAssetId: voice.id', 'voice: toPublicCustomVoice(voice)'], 'link extraction direct public asset');
assert(!extractRoute.includes('voice,\n'), 'link extraction leaks the internal stored voice object');
assert(!extractRoute.includes('audioBase64'), 'link extraction still returns base64 JSON');
assert(extractor.includes('wav: Buffer') && !extractor.includes('wavBase64'), 'extractor still base64-encodes WAV');
includesAll(referenceClient, ["fetch('/api/extract'", "'Idempotency-Key': attempt.clientRequestId", 'temporaryVideoUrl: video.temporary_url', 'assetId: String(voice.id)'], 'owned reference audio extraction lifecycle');
assert(!referenceClient.includes('audioData: extractedAudio.base64'), 'reference extraction still sends base64 to browser API');
assert(!selector.includes('base64ToFile') && selector.includes('assetId: pendingAudio.voice.id'), 'selector still decodes/reuploads base64');

for (const [label, source, operation] of [
  ['clone page', clonePage, 'clone'], ['design page', designPage, 'design'],
] as const) {
  includesAll(source, ["redirect('/voice-studio/imitate')"], `${label} compatible entry`);
  assert(!source.includes("body: JSON.stringify({ engine: 'volcano', speakerId"), `${label} polls arbitrary speakerId`);
}
assert(volcano.includes("loadVolcanoVoiceProviderConfig"), 'volcano adapter still uses placeholder Prisma config');
assert(!volcano.includes("from './prisma'"), 'volcano adapter imports deprecated placeholder Prisma');

console.log(JSON.stringify({
  verifier: 'voice-training-lifecycle-p0',
  passed: true,
  mode: 'offline-zero-cost-no-network-no-database-write',
  upstreamCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
