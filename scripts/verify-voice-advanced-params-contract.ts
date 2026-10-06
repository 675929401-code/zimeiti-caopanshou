import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src/app/api/voice/tts/route.ts'), 'utf8');
const requireSource = (value: string) => assert.ok(source.includes(value), `tts route missing: ${value}`);

requireSource('const finalSubtitle =');
requireSource('enable_subtitle: finalSubtitle');
requireSource('subtitles: finalSubtitle && combinedSubtitles.length > 0 ? combinedSubtitles : undefined');
requireSource("additions.cache_config = { text_type: 1, use_cache: true }");
requireSource("additions.mute_cut_threshold = '200'");
requireSource('prepareSeedAudioReferences(user.id, body)');
requireSource('provided.length > MAX_SEED_AUDIO_REFERENCES');
requireSource('readOwnedCustomVoiceAudio(userId, assetId)');
assert.ok(!source.includes('enable_subtitle: true'), 'dual mode still forces subtitles');
assert.ok(!source.includes('cache_config = { enable: true }'), 'deprecated cache_config contract remains');
assert.ok(!source.includes('mute_cut_threshold = 200'), 'mute_cut_threshold must be a string');

console.log(JSON.stringify({
  verifier: 'voice-advanced-params-contract',
  passed: true,
  mode: 'offline-zero-cost-static-contract',
  providerCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
}, null, 2));
