import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { toUserVoiceDto } from '../src/lib/vs/user-voice-dto';

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const voicesPage = read('src/app/voice-studio/voices/page.tsx');
const workspacePage = read('src/app/voice-studio/workspace/page.tsx');
const userVoicesRoute = read('src/app/api/voice/user-voices/route.ts');
const servicesRoute = read('src/app/api/voice/services/route.ts');
const pricingRoute = read('src/app/api/voice/pricing/route.ts');
const pricingLibrary = read('src/lib/vs/pricing.ts');
const runtimeCatalog = read('src/app/api/tools/runtime-catalog/route.ts');

const dto = toUserVoiceDto({
  id: 42,
  voice_type: 'clone',
  voice_name: '账号 A 的音色',
  speaker_id: 'speaker-owner-a',
  language: 'zh',
  source_info: {
    description: '账号私有克隆音色',
    gender: 'female',
    demoAudioUrl: '/api/voice/audio/asset-a',
  },
  created_at: '2026-09-15T00:00:00.000Z',
});

assert.deepEqual(dto, {
  id: 'speaker-owner-a',
  recordId: '42',
  speakerId: 'speaker-owner-a',
  name: '账号 A 的音色',
  description: '账号私有克隆音色',
  category: '克隆',
  tags: ['克隆'],
  styleTags: ['克隆'],
  gender: 'female',
  type: 'cloned',
  engine: 'volcano',
  language: 'zh',
  demoAudioUrl: '/api/voice/audio/asset-a',
  createdAt: '2026-09-15T00:00:00.000Z',
});

assert.match(voicesPage, /fetch\('\/api\/voice\/user-voices'/);
assert.doesNotMatch(voicesPage, /\/api\/voice\/list\?type=(?:cloned|designed)&mine=true/);
assert.match(voicesPage, /result\?\.success!==true\|\|!Array\.isArray\(result\.voices\)/);
assert.match(workspacePage, /fetch\('\/api\/voice\/user-voices'/);
assert.match(workspacePage, /cache: 'no-store'/);
assert.match(workspacePage, /as UserVoiceDto\[\]/);
assert.doesNotMatch(workspacePage, /voice_id: string;[\s\S]{0,500}voice_type: string;/);

assert.match(userVoicesRoute, /\.eq\('user_id', user\.id\)/);
assert.match(userVoicesRoute, /\.select\('id,voice_type,voice_name,speaker_id,language,source_info,created_at,updated_at'\)/);
assert.match(userVoicesRoute, /voices: visibleRecords\.map\(toUserVoiceDto\)/);
assert.match(userVoicesRoute, /Cache-Control', 'private, no-store'/);
assert.match(userVoicesRoute, /VOICE_USER_CATALOG_UNAVAILABLE/);
const userVoicesPostStart = userVoicesRoute.indexOf('export async function POST');
assert.ok(userVoicesPostStart > 0);
assert.doesNotMatch(userVoicesRoute.slice(0, userVoicesPostStart), /error\.message/);
assert.match(userVoicesRoute, /VOICE_USER_DELETE_FAILED/);
assert.doesNotMatch(userVoicesRoute, /NextResponse\.json\(\{ error: error\.message \}/);

assert.match(servicesRoute, /VOICE_SERVICE_CATALOG_RETIRED/);
assert.match(servicesRoute, /status: 410/);
assert.match(servicesRoute, /available: false/);
assert.doesNotMatch(servicesRoute, /service-store|getEnabledCards|retailPrice/);

const allPricingStart = pricingLibrary.indexOf('export function getAllModelPricing');
const allPricingEnd = pricingLibrary.indexOf('// ─── 费用计算', allPricingStart);
const allPricingSource = pricingLibrary.slice(allPricingStart, allPricingEnd);
assert.match(allPricingSource, /throw new VoicePricingCatalogError\(\)/);
assert.doesNotMatch(allPricingSource, /return \[\]/);
assert.match(pricingRoute, /pricing\.length === 0/);
assert.match(pricingRoute, /status: 503/);
assert.match(pricingRoute, /VOICE_PRICING_CATALOG_UNAVAILABLE/);
assert.match(pricingRoute, /Cache-Control': 'private, no-store'/);

assert.match(runtimeCatalog, /case "coze_multifunction_extract": return "Coze"/);
assert.match(runtimeCatalog, /providerFallbackForRole\(row, fallbackProvider\)/);
assert.match(runtimeCatalog, /const sharedQuote = quote\(coze, "三合一提取工作流"\)/);
for (const [surface, service] of [
  ['video', '视频提取'],
  ['text', '文案提取'],
  ['batch', '批量提取'],
  ['search', '搜索提取'],
] as const) {
  assert.match(runtimeCatalog, new RegExp(`${surface}: publicQuote\\(sharedQuote, "${service}", isAdmin\\)`));
}

console.log(JSON.stringify({
  passed: true,
  accountScopedCustomVoiceCatalog: true,
  unifiedUserVoiceDto: true,
  retiredMisleadingLegacyServiceCatalog: true,
  pricingReadFailureClosed: true,
  cozeProviderLabelStableAcrossSurfaces: true,
  oneSharedThreeInOneQuoteAcrossSurfaces: true,
  providerCalls: 0,
  paidCalls: 0,
  databaseWrites: 0,
}, null, 2));
