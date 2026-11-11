import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import * as zod from 'zod';
assert.equal(process.version, 'v24.19.0');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#8057c8' } }).png().toBuffer();
const blob = new Blob([png], { type: 'image/png' }), recordId = 'a'.repeat(64);
const fetched = [];
let responseFactory = () => new Response(png, { headers: { 'content-type': 'image/png' } }), checks = 0;
const module = { exports: {} };
runInNewContext(compile(readFileSync('src/lib/generated-image-download.ts', 'utf8')), { module, exports: module.exports,
  Blob, Uint8Array, AbortSignal, AbortController, Set, Error, fetch: async (url, options) => { fetched.push({ url, options }); return responseFactory(options); } });
const helper = module.exports;
const check = condition => { assert.ok(condition); checks++; };
let image = await helper.readImageDownloadBlob({ kind: 'inline_ephemeral', blob }, '', new AbortController().signal);
check(image === blob && fetched.length === 0);
check(helper.imageDownloadFilename('1.png', new Blob(['fixture'], { type: 'image/jpeg' })) === '1.jpg');
check(helper.imageDownloadFilename('1', new Blob(['fixture'], { type: 'image/webp' })) === '1.webp');
image = await helper.readImageDownloadBlob({ kind: 'provider_url', recordId }, 'synthetic', new AbortController().signal);
check(image.type === 'image/png' && image.size === png.length && fetched.length === 1);
check(fetched[0].url === '/api/media-history/content?recordId=' + recordId && fetched[0].options.redirect === 'error' && fetched[0].options.cache === 'no-store');
for (const response of [
  () => new Response('expired', { status: 410, headers: { 'content-type': 'text/html' } }),
  () => new Response('denied', { status: 403, headers: { 'content-type': 'image/png' } }),
  () => new Response('<html>failure</html>', { headers: { 'content-type': 'text/html' } }),
  () => new Response('<html>failure</html>', { headers: { 'content-type': 'image/png' } }),
  () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(31 * 1024 * 1024) } }),
  () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(30 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'content-type': 'image/png' } }),
]) {
  responseFactory = response;
  await assert.rejects(helper.readImageDownloadBlob({ kind: 'provider_url', recordId }, 'synthetic', new AbortController().signal)); checks++;
}
await assert.rejects(helper.readImageDownloadBlob({ kind: 'inline_ephemeral', blob: new Blob(['not-an-image'], { type: 'image/png' }) }, '', new AbortController().signal)); checks++;
const beforeInvalid = fetched.length;
await assert.rejects(helper.readImageDownloadBlob({ kind: 'provider_url', recordId: 'wrong' }, 'synthetic', new AbortController().signal)); checks++;
check(fetched.length === beforeInvalid);
// 独立 AI 生图工作台已下线：其组件下载处理器不再存在，本脚本只保留共享下载助手与分镜处理器验证。
// Execute the actual storyboard callback, owner hooks and anchor helper in RAM.
const referenceModule = { exports: {} };
runInNewContext(compile(readFileSync('src/lib/generated-image-reference.ts', 'utf8')), {
  module: referenceModule, exports: referenceModule.exports,
  require: name => { assert.equal(name, 'zod'); return zod; },
});
const storyboardSource = readFileSync('src/components/storyboard-workbench.tsx', 'utf8');
const progressModule = { exports: {} };
runInNewContext(compile(readFileSync('src/lib/video-task-progress.ts', 'utf8')), {
  module: progressModule, exports: progressModule.exports,
});
const confirmationKeySource = storyboardSource.match(/function storyboardVideoConfirmationKey\([\s\S]*?\r?\n\}/u)?.[0];
const storyboardStart = storyboardSource.indexOf('  const imageDownloadOwnerRef = useRef(');
const storyboardEnd = storyboardSource.indexOf('  }, [userId, token]);', storyboardStart) + '  }, [userId, token]);'.length;
const anchorSource = storyboardSource.match(/function triggerDownload\([\s\S]*?\r?\n\}/u)?.[0];
assert.ok(storyboardStart > 0 && storyboardEnd > storyboardStart && anchorSource && confirmationKeySource);
assert.match(storyboardSource, /title="下载故事板" onClick=\{\(\) => void downloadStoryboardImage\(card\)\}/u);
assert.match(storyboardSource, /scopeMountedRef\.current = false;\s*imageDownloadOperationsRef\.current\.cancelAll\(\)/u);
const storyboardActual = compile(anchorSource + '\n' + confirmationKeySource + '\nmodule.exports=function(){' + storyboardSource.slice(storyboardStart, storyboardEnd) + 'return downloadStoryboardImage;}');
function storyboardHarness() {
  const module = { exports: {} }, refs = [], states = [], notices = [], downloads = [], created = [], revoked = [];
  const mounted = { current: true }, run = { id: 'download-fixture', cards: [] };
  let refIndex = 0, stateIndex = 0, cleanups = [];
  const effect = callback => { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup); };
  const sandbox = {
    module, userId: 'owner', token: 'synthetic', scopeMountedRef: mounted, run, runRef: { current: run },
    cloud: { save: async () => { throw new Error('CLOUD_WRITE_FORBIDDEN'); }, saveRetryAt: 0 },
    useRef: initial => { const index = refIndex++; return refs[index] ||= { current: initial }; },
    // Preserve lazy initialization and functional state updates across renders.
    useState: initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useCallback: callback => callback, useEffect: effect,
    updateVideoConfirmationMap: progressModule.exports.updateVideoConfirmationMap,
    // The real captured block now also initializes the optional local video
    // cache. This RAM-only download fixture has no IndexedDB runtime.
    useLayoutEffect: effect,
    VideoLocalAutoCache: class { constructor() { throw new Error('LOCAL_VIDEO_CACHE_UNAVAILABLE_IN_RAM_FIXTURE'); } },
    ImageDownloadOperations: helper.ImageDownloadOperations,
    GeneratedImageReferenceSchema: referenceModule.exports.GeneratedImageReferenceSchema,
    readImageDownloadBlob: helper.readImageDownloadBlob, imageDownloadFilename: helper.imageDownloadFilename,
    setNotice: notice => notices.push(notice), Error,
    URL: { createObjectURL: value => { created.push(value); return 'blob:download-' + created.length; }, revokeObjectURL: url => revoked.push(url) },
    window: { setTimeout: callback => { callback(); return 1; } },
    document: { body: { appendChild: () => undefined }, createElement: () => {
      const anchor = { href: '', download: '', click: () => downloads.push({ url: anchor.href, filename: anchor.download }), remove: () => undefined }; return anchor;
    } },
  };
  runInNewContext(storyboardActual, sandbox);
  const render = () => { refIndex = 0; stateIndex = 0; return module.exports(); };
  const result = { download: render(), notices, downloads, created, revoked,
    setIdentity: (userId, token, cancel = true) => {
      if (cancel) { for (const cleanup of cleanups) cleanup(); cleanups = []; }
      sandbox.userId = userId; sandbox.token = token; result.download = render();
    },
    unmount: () => { mounted.current = false; for (const cleanup of cleanups) cleanup(); },
  };
  return result;
}
const storyboardCard = { id: 'card', order: 1, imageUrl: 'https://upstream.invalid/private-image', imageDeliveryMode: 'provider_url', imageRecordId: recordId,
  imageRef: { schema: 'generated_image_ref.v1', recordId }, imagePriceCharged: 0.1, imageBillingState: 'settled' };
const originalCard = JSON.stringify(storyboardCard);
responseFactory = () => new Response(png, { headers: { 'content-type': 'image/png' } });
let sb = storyboardHarness(), storyboardCalls = fetched.length;
await sb.download(storyboardCard);
check(sb.downloads.length === 1 && sb.downloads[0].url === 'blob:download-1' && sb.created[0].type === 'image/png' && sb.revoked[0] === 'blob:download-1');
check(fetched.length === storyboardCalls + 1 && fetched.at(-1).url === '/api/media-history/content?recordId=' + recordId && fetched.at(-1).options.headers.Authorization === 'Bearer synthetic');
check(!fetched.some(call => call.url === storyboardCard.imageUrl));
for (const change of [
  { imageRecordId: 'wrong' }, { imageRecordId: 'b'.repeat(64) },
  { imageRef: { schema: 'generated_image_ref.v1', recordId: 'b'.repeat(64) } },
]) {
  sb = storyboardHarness(); storyboardCalls = fetched.length; await sb.download({ ...storyboardCard, ...change });
  check(sb.downloads.length === 0 && fetched.length === storyboardCalls && sb.notices.length === 1);
}
sb = storyboardHarness(); await sb.download({ ...storyboardCard, imageRef: undefined }); check(sb.downloads.length === 1);
const jpeg = await sharp(png).jpeg().toBuffer();
responseFactory = () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
sb = storyboardHarness(); await sb.download(storyboardCard); check(sb.downloads[0].filename === '01-故事板.jpg');
responseFactory = () => new Response('denied', { status: 403 });
sb = storyboardHarness(); await sb.download(storyboardCard); check(sb.downloads.length === 0 && sb.notices.length === 1);
responseFactory = () => { throw new Error('PRIVATE_UPSTREAM_SECRET'); };
sb = storyboardHarness(); await sb.download(storyboardCard); check(sb.downloads.length === 0 && sb.notices.length === 1 && !sb.notices[0].includes('PRIVATE_UPSTREAM_SECRET'));
for (const cancel of [target => target.setIdentity('other', 'synthetic'), target => target.setIdentity('owner', 'other-token'), target => target.unmount()]) {
  let activeSignal;
  responseFactory = options => new Promise((_, reject) => { activeSignal = options.signal; options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  sb = storyboardHarness(); const pending = sb.download(storyboardCard); cancel(sb); await pending;
  check(activeSignal.aborted && sb.downloads.length === 0 && sb.notices.length === 0);
}
let finishStoryboardRead;
responseFactory = () => new Promise(resolve => { finishStoryboardRead = resolve; });
sb = storyboardHarness(); const ownerRace = sb.download(storyboardCard);
sb.setIdentity('other', 'new-token', false); finishStoryboardRead(new Response(png, { headers: { 'content-type': 'image/png' } })); await ownerRace;
check(sb.downloads.length === 0 && sb.notices.length === 0);
for (const card of [
  { ...storyboardCard, imageDeliveryMode: 'inline_ephemeral', imageUrl: 'blob:current-inline' },
  { ...storyboardCard, imageDeliveryMode: undefined, imageUrl: '/legacy-owned-image' },
]) {
  sb = storyboardHarness(); storyboardCalls = fetched.length; await sb.download(card);
  check(sb.downloads.length === 1 && sb.downloads[0].url === card.imageUrl && sb.created.length === 0 && fetched.length === storyboardCalls);
}
check(JSON.stringify(storyboardCard) === originalCard);
console.log(JSON.stringify({ passed: true, checks, actualWorkbenchDownloadHandlers: false, actualStoryboardDownloadHandler: true, realNetworkCalls: 0, paidCalls: 0, databaseCalls: 0 }));
