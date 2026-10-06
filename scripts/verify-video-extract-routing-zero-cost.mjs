import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(path, 'utf8');
const [route, catalog, cache, safeFetch, errors, page, statusRoute, statusHook, exactlyOnce] = await Promise.all([
  read('src/app/api/extract/route.ts'),
  read('src/app/api/tools/runtime-catalog/route.ts'),
  read('src/lib/extract-local-video-cache.ts'),
  read('src/lib/safe-fetch.ts'),
  read('src/lib/extraction-provider-error.ts'),
  read('src/app/extract/page.tsx'),
  read('src/app/api/extract/status/route.ts'),
  read('src/hooks/use-extraction-attempt-status.ts'),
  read('src/lib/extraction-exactly-once.ts'),
]);

const sharedConfigResolver = route.slice(route.indexOf('async function getCozeMultifunctionConfig'), route.indexOf('// ============ 获取文案提取第三方差价渠道配置'));
assert.match(sharedConfigResolver, /\.eq\("role", "coze_multifunction_extract"\)/u);
assert.match(sharedConfigResolver, /\.eq\("is_active", true\)/u);
assert.match(sharedConfigResolver, /\.limit\(2\)/u);
assert.match(sharedConfigResolver, /pluginRows\.length > 1/u);
assert.match(sharedConfigResolver, /price_per_use, cost_price/u);
assert.match(sharedConfigResolver, /apiUrl.*apiToken/su);
assert.match(sharedConfigResolver, /requireConfiguredExtractionMoney\(pluginData\.price_per_use/u);
assert.match(sharedConfigResolver, /requireConfiguredExtractionMoney\(pluginData\.cost_price/u);

const videoBranchStart = route.indexOf('// 视频与文案共用同一个 active coze_multifunction_extract');
assert.ok(videoBranchStart >= 0, 'shared three-in-one video branch marker must exist');
const videoBranch = route.slice(videoBranchStart, route.indexOf('// 🔒 20260914', videoBranchStart));
assert.match(videoBranch, /getCozeMultifunctionConfig\(\)/u);
assert.match(videoBranch, /callCozeWorkflow\([^)]*,\s*[^,]+,\s*"video"/u);
assert.match(videoBranch, /schema: "coze_video_provider_result\.v1"/u);
assert.match(videoBranch, /provider_call_started: false/u);
assert.match(videoBranch, /EXTRACTION_PROVIDER_OUTCOME_UNKNOWN/u);
assert.match(videoBranch, /const billingExempt = false/u);
assert.match(videoBranch, /precheckCash\([^)]*pricePerUse,\s*1,\s*userId\)/u);
assert.match(route, /const amount = extractionTotalPrice\(unitPrice, count \|\| 1\)/u);
assert.doesNotMatch(route, /Math\.round\(unitPrice \* \(count \|\| 1\) \* 10000\) \/ 10000/u);
assert.match(route, /EXTRACTION_VIDEO_SINGLE_LINK_REQUIRED/u);
assert.match(route, /delete deliveredVideo\.cover/u);
assert.match(page, /\[linkList\[i\]\][\s\S]*?"video"/u);
assert.doesNotMatch(videoBranch, /userRole === ["']admin["']/u);
assert.doesNotMatch(videoBranch, /getActiveVideoExtractConfig|fetchExtractionProviderGetOnce|extract_video_ppt6_result/u);
assert.doesNotMatch(videoBranch, /fetchDouyinVideoMultiSource/u);
assert.doesNotMatch(videoBranch, /\bfetch\(/u);
assert.match(route, /schema: "coze_video_provider_result\.v1"/u);
assert.match(route, /readCozeVideoCheckpoint/u);
assert.match(route, /readPpt6VideoCheckpoint/u);
assert.match(route, /recoverFromProviderCheckpoint: recoverVideoFromCheckpoint/u);
assert.match(route, /keySuffix: "coze-video"/u);
assert.match(route, /keySuffix: "ppt6-video"/u);
const videoSettlement = route.slice(route.indexOf('async function persistAndSettleCozeVideos'), route.indexOf('async function recoverVideoFromCheckpoint'));
assert.match(videoSettlement, /const deliveredVideos = videoResults\.map/u);
assert.match(videoSettlement, /recovery_pending: true/u);
assert.match(videoSettlement, /请使用原请求再次提交以继续结算/u);
assert.match(exactlyOnce, /bodyEvidence\.recovery_pending === true/u);
assert.match(exactlyOnce, /bodyEvidence\.upstream_completed === true/u);
assert.match(exactlyOnce, /bodyEvidence\.provider_call_started === true/u);
assert.doesNotMatch(exactlyOnce, /bodyEvidence\.recovery_pending === true\s*&& bodyEvidence\.charged === false/u);

assert.match(catalog, /const sharedQuote = quote\(coze/u);
assert.match(catalog, /video: publicQuote\(sharedQuote/u);
assert.doesNotMatch(catalog, /quoteVideo\(byRole\("extract_video"\)\)/u);
assert.match(cache, /ensureCachedVideoFile\(parsed, fileHash, \{[\s\S]*?systemDnsPinned: true,[\s\S]*?renewOnReuse: true,[\s\S]*?\}\)/u);
assert.match(safeFetch, /options\.networkPolicy === "system-dns-pinned"/u);
assert.match(errors, /mode === 'video'[\s\S]*视频提取服务/u);
assert.match(page, /mode === "video" \? 210_000 : 30_000/u);
assert.match(page, /PendingExtractionRequestError/u);
assert.match(statusRoute, /client_request_id/u);
assert.match(statusRoute, /\.eq\('user_id', user\.id\)/u);
assert.match(statusHook, /client_request_id/u);
assert.match(statusHook, /value\.state === 'running'/u);
assert.doesNotMatch(statusHook, /method:\s*['"]POST['"]/u);

console.log(JSON.stringify({
  passed: true,
  activeVideoSource: 'coze_multifunction_extract',
  legacyPpt6CheckpointRecovery: true,
  explicitPinnedTemporaryCache: true,
  statusPollingIsReadOnly: true,
  realProviderRequests: 0,
  realDatabaseWrites: 0,
}));
