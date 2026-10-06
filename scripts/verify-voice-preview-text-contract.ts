import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveVoicePreviewText, VOICE_PREVIEW_CATEGORIES } from '../src/lib/vs/preview-texts';

assert.ok(VOICE_PREVIEW_CATEGORIES.includes('模拟真人'), '模拟真人 preview category is missing');
assert.equal(resolveVoicePreviewText('模拟真人'), resolveVoicePreviewText('情感治愈'));
assert.ok(resolveVoicePreviewText('热门推荐').length <= 51, 'shared preview text exceeds provider limit');
assert.equal(resolveVoicePreviewText('unknown'), resolveVoicePreviewText('__default__'));

const route = fs.readFileSync(path.join(process.cwd(), 'src/app/api/voice/preview/route.ts'), 'utf8');
const client = fs.readFileSync(path.join(process.cwd(), 'src/lib/vs/preview-cache.ts'), 'utf8');
assert.ok(route.includes("import { resolveVoicePreviewText } from '@/lib/vs/preview-texts'"));
assert.ok(client.includes("import { resolveVoicePreviewText } from '@/lib/vs/preview-texts'"));
assert.ok(!route.includes('const PREVIEW_TEXTS'), 'server retained a divergent preview text map');
assert.ok(!client.includes('const PREVIEW_TEXTS'), 'client retained a divergent preview text map');
assert.ok(client.includes("typeof ttsData.text === 'string'"), 'client does not respect authoritative server text');
assert.ok(client.includes('textHash: textHash(text)'), 'client caches against the authoritative server text');

console.log(JSON.stringify({
  verifier: 'voice-preview-text-contract',
  passed: true,
  mode: 'offline-zero-cost-no-preview-request',
  providerCalls: 0,
  paidRequests: 0,
  databaseMutations: 0,
}, null, 2));
