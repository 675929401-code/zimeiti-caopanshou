import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeVolcanoSubtitles } from '../src/lib/vs/volcengine';

const normalized = normalizeVolcanoSubtitles([
  { sentence: '第一段', begin_time: '120', end_time: '860' },
  { text: '第二段', start_ms: '900', end_ms: '1400' },
  { text: '第一段', startMs: 120, endMs: 860 },
  { text: '', startMs: 0, endMs: 10 },
  { text: '坏时间', startMs: 'not-a-number', endMs: 20 },
]);
assert.deepEqual(normalized, [
  { text: '第一段', startMs: 120, endMs: 860 },
  { text: '第二段', startMs: 900, endMs: 1400 },
]);

const root = process.cwd();
const volcano = fs.readFileSync(path.join(root, 'src/lib/vs/volcengine.ts'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src/app/api/voice/tts/route.ts'), 'utf8');
const joiner = fs.readFileSync(path.join(root, 'src/lib/voice-audio-join.ts'), 'utf8');

for (const token of [
  'const streamedSubtitles: unknown[] = []',
  'streamedSubtitles.push(...evt.subtitles)',
  'data.subtitles = streamedSubtitles',
  'normalizeVolcanoSubtitles(dataAny?.subtitles)',
]) assert.ok(volcano.includes(token), `volcano subtitle stream missing ${token}`);

for (const token of [
  'const finalSubtitle = enableSubtitle ?? bodySubtitle ?? false',
  'enable_subtitle: finalSubtitle',
  'subtitles: finalSubtitle && combinedSubtitles.length > 0 ? combinedSubtitles : undefined',
]) assert.ok(route.includes(token), `dual subtitle response missing ${token}`);
assert.ok(!route.includes('enable_subtitle: true'), 'dual subtitle request is still forced on');

for (const token of [
  'const offsetMs = Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) * 1000)',
  'startMs: subtitle.startMs + offsetMs',
  'endMs: subtitle.endMs + offsetMs',
]) assert.ok(joiner.includes(token), `dual subtitle offset missing ${token}`);

console.log(JSON.stringify({
  verifier: 'voice-subtitle-contract',
  passed: true,
  normalizedSegments: normalized.length,
  providerCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
}, null, 2));
