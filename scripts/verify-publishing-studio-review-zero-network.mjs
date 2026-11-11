import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { Blob, File } from 'node:buffer';
import ts from 'typescript';
import { z } from 'zod';

// Exercise the actual hook and actual draft copy/hash functions with a tiny
// deterministic RAM React lifecycle. Mutation dependencies throw on entry;
// this is a boundary test, never a mock publication-success test.
const root = path.resolve('src/features/publishing/studio');
const [hookSource, draftSource] = await Promise.all([fs.readFile(path.join(root, 'usePublishingStudio.ts'), 'utf8'), fs.readFile(path.join(root, 'studio-draft.ts'), 'utf8')]);
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const checks = [], forbiddenCalls = [], observedProbes = [];
const verify = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); assert.ok(passed, name); };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = async blob => createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const clone = value => structuredClone(value);
const moduleFrom = (source, dependencies, extras = {}) => {
  const exports = {};
  const context = vm.createContext({ exports, console, Error, TypeError, Blob, File, URL, Map, Set, Date, Uint8Array, structuredClone, crypto: webcrypto, setTimeout, clearTimeout,
    require: name => { if (!(name in dependencies)) throw new Error(`UNEXPECTED_IMPORT_${name}`); return dependencies[name]; }, ...extras });
  new vm.Script(compile(source)).runInContext(context); return exports;
};
const stop = label => async () => { forbiddenCalls.push(label); throw new Error(`MUTATION_BOUNDARY_REACHED_${label}`); };
const parse = value => value;
const draftDependencies = {
  '@/lib/publishing-v2-contract': { PublishingV2WxOptionsSchema: { parse }, PublishingV2XhsOptionsSchema: { parse } },
  '@/lib/publishing-v3-contract': { PublishingV3OptionsSchema: { parse }, preparePublishingV3Content: () => ({ errors: [] }), validatePublishingV3Media: () => [] },
  '@/lib/publishing-native': { prepareNativePluginContent: () => ({ errors: [] }), validateNativePublishingMedia: () => [] },
  '@/lib/publishing-generic-validation': { effectiveGenericPublishingContent: stop('unexpected-generic-content'), validateGenericPublishingContent: stop('unexpected-generic-validation'), validateGenericPublishingPolicy: stop('unexpected-generic-policy') },
  '@/lib/publishing-option-schema': { validatePublishingProviderOptions: stop('unexpected-generic-options') },
  './native-assets': { nativeSha256: sha, uploadNativeAsset: stop('upload') },
  './native-readable-media': { probeNativePublishingFile: async file => { observedProbes.push(file.name); return { width: 640, height: 360, duration: 2 }; }, readNativePublishingMedia: stop('unexpected-remote-media-read') },
};
const draftImplementation = moduleFrom(draftSource, draftDependencies);
function harness() {
  let owner = id(1), revision = 1, index = 0, rendered = false, workspaceReads = 0, historyReads = 0, importReads = 0;
  let pauseWorkspace = null;
  const slots = [], effects = [], listeners = new Set(), cleanups = [];
  const sampleFile = new File(['explicit local fixture'], 'review-fixture.mp4', { type: 'video/mp4' });
  const account = { id: id(2), platform: 'xhs', name: 'RAM review account', status: 'ready', selected: false, kind: 'browser', revision: 1, metadataRevision: 0, uid: 'fixture-uid' };
  const workspace = { accounts: [account], platforms: [{ key: 'xhs', name: '小红书', available: true, connectionAllowed: true, reason: 'RAM fixture' }], bootstrap: { schemaReady: true, access: { allowed: true, code: 'FIXTURE', message: 'fixture' }, config: { executionEnabled: true }, entitlements: [{ platforms: ['xhs'], quota: 9, used: 0, expiresAt: new Date(Date.now() + 3600000).toISOString() }] } };
  const host = { assertHostSession: (expected, expectedRevision) => { if (!owner || expected && owner !== expected || expectedRevision !== undefined && expectedRevision !== revision) throw new Error('OWNER_OR_SESSION_CHANGED'); return { user: { id: owner, displayName: 'fixture', username: 'fixture' }, wallet: { cashCents: 0 } }; }, getHostSessionRevision: () => revision,
    getHostSession: () => owner ? { user: { id: owner } } : null,
    loadHostSession: async () => host.assertHostSession(), subscribeHostSession: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const fakeReact = {
    useState: initial => { const key = index++; if (!rendered) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
    useRef: initial => { const key = index++; if (!rendered) slots[key] = { current: initial }; return slots[key]; },
    useEffect: callback => { index++; if (!rendered) effects.push(callback); },
    useCallback: (callback, dependencies) => { const key = index++; const prior = slots[key]; if (!prior || dependencies.some((value, offset) => !Object.is(value, prior.dependencies[offset]))) slots[key] = { callback, dependencies }; return slots[key].callback; },
  };
  const dependencies = {
    react: fakeReact, zod: { z }, '@/lib/native-operations-contract': { nativePreparePlanCanonical: stop('canonical-after-confirm') },
    '@/lib/publishing-studio-contract': { PublishingStudioDraftSchema: { parse } },
    '@/lib/publishing-generic-contract': { PublishingGenericMutationSchema: { parse } },
    '@/lib/native-main-media-contract': { nativeMainMediaPath: stop('unexpected-import-path') },
    '@/lib/publishing-v2-contract': { PublishingV2PageSchema: { parse }, PublishingV2VersionSchema: { parse } },
    '@/lib/publishing-v3-contract': { PublishingV3AuthSessionSchema: { parse } }, '@/lib/publishing-plugin': { inspectPublishingPlugin: stop('plugin-inspection'), publishingPluginMessage: String },
    './host-session': host, './native-assets': { nativeSha256: sha }, './native-publish-plan': { buildNativePublishPlan: stop('plan') },
    './native-media-bridge-client': { confirmNativeOfficialMainMedia: stop('bridge') },
    './native-publishing': { assertNativeRemainingQuota: stop('quota-reservation'), executeNativePublishing: stop('execute'), prepareNativePublishing: stop('prepare'), readNativePending: () => null, recoverNativePublish: stop('recovery'), subscribeNativePending: () => () => {} },
    './native-oauth': { isNativeOAuthPlatform: () => false, readNativeOAuthSession: stop('oauth-read'), safeNativeAuthorizationUrl: value => value, selectNativeOAuth: stop('oauth-selection'), startNativeOAuth: stop('oauth-start') },
    './native-auth': { selectNativeAuthorization: stop('auth-selection'), startNativeAuthorization: stop('auth-start') },
    './studio-api': { readStudioHistory: async () => { historyReads++; return []; }, readStudioHistoryPage: async () => { historyReads++; return { items: [], page: 1, pageSize: 30, total: 0, hasMore: false }; }, readStudioImport: async () => { importReads++; return []; }, readStudioWorkspace: async () => { workspaceReads++; if (pauseWorkspace) { const pause = pauseWorkspace; pauseWorkspace = null; await pause; } return clone(workspace); }, studioRequest: stop('API') },
    './studio-draft': draftImplementation, './studio-save': { saveStudioDraft: stop('save') },
    './studio-generic': { readStudioGenericPending: () => null, completeStudioGeneric: stop('generic-complete'), executeStudioGeneric: stop('generic-execute'), prepareStudioGeneric: stop('generic-prepare'), recoverStudioGeneric: stop('generic-recover') },
  };
  const hook = moduleFrom(hookSource, dependencies, {
    window: { addEventListener() {}, removeEventListener() {} }, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    navigator: { locks: { request: async (_key, _options, callback) => callback({}) } },
  });
  let current;
  const render = () => { index = 0; current = hook.usePublishingStudio(); rendered = true; return current; };
  render(); for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  const settle = async () => { for (let index = 0; index < 5; index++) await new Promise(resolve => setTimeout(resolve, 0)); return render(); };
  return { render, settle, counts: () => ({ workspaceReads, historyReads, importReads }), close: () => { for (const cleanup of cleanups) cleanup(); },
    ownerChange: () => { owner = id(9); revision++; },
    suspendWorkspace: () => { let release; pauseWorkspace = new Promise(resolve => { release = resolve; }); return release; },
    populate: async () => { await settle(); current.patchDraft({ contentType: 'video', title: '确认前本地草稿', body: '本轮只读边界', topics: ['只读'], media: [{ id: id(3), name: sampleFile.name, kind: 'video', size: sampleFile.size, file: sampleFile, stage: 'local', status: 'ready', url: 'blob:fixture-owned', width: 640, height: 360, duration: 2 }], targetOverrides: { [account.id]: { topics: ['单账号话题'], options: { xhs: { userDeclarationBind: { origin: '1' } } } } } }); render().toggleAccount(account.id); return render(); },
  };
}

const report = { passed: false, scope: 'Actual usePublishingStudio control flow and studio-draft copy/hash/subset mapping; RAM React/GET catalog and constraint dependencies. Hook mutation dependencies throw. A separate explicitly synthetic materialization fixture checks ID mapping only, never publication.', sources: { hook: createHash('sha256').update(hookSource).digest('hex'), draft: createHash('sha256').update(draftSource).digest('hex') }, checks, forbiddenCalls, syntheticHelperUploads: [], actualNetworkCalls: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { report.actualNetworkCalls++; throw new Error('NETWORK_FORBIDDEN'); };
try {
  {
    const h = harness(); const c = await h.settle();
    verify('mount starts an empty draft and requests no history/import', c.draft.title === '' && c.draft.body === '' && c.draft.media.length === 0 && h.counts().historyReads === 0 && h.counts().importReads === 0);
    h.close();
  }
  {
    const h = harness(); let c = await h.populate(); await c.checkDraft(); c = h.render();
    verify('checkDraft creates a review without upload prepare save bridge or plugin', Boolean(c.review?.id) && forbiddenCalls.length === 0);
    const reviewId = c.review.id; c.cancelReview(); c = h.render(); await c.publish(reviewId); c = h.render();
    verify('cancelled review ID cannot be reused for publication', c.review === null && /失效/u.test(c.error || '') && forbiddenCalls.length === 0);
    h.close();
  }
  {
    const h = harness(); let c = await h.populate(); await c.checkDraft(); c = h.render(); const old = c.review.id;
    c.patchDraft({ title: '修改后需重新确认' }); c = h.render(); await c.publish(old); c = h.render();
    verify('any edit invalidates the old review before side effects', c.review === null && /失效/u.test(c.error || '') && forbiddenCalls.length === 0);
    h.close();
  }
  {
    const h = harness(); let c = await h.populate(); await c.checkDraft(); c = h.render(); const old = c.review.id;
    h.ownerChange(); await c.publish(old); c = h.render();
    verify('owner/session change after review stops before upload or prepare', /OWNER_OR_SESSION_CHANGED/u.test(c.error || '') && forbiddenCalls.length === 0);
    h.close();
  }
  {
    const h = harness(); let c = await h.populate(); const release = h.suspendWorkspace(); const pending = c.checkDraft();
    c.patchDraft({ title: '检查等待期间改变内容' }); h.render(); release(); await pending; c = h.render();
    verify('late check completion cannot create a review for changed content', !c.review && /内容已变化/u.test(c.error || '') && forbiddenCalls.length === 0);
    h.close();
  }
  {
    const h = harness(); let c = await h.populate();
    const cover = (number, name) => ({ id: id(number), name, kind: 'image', size: 3, file: new File(['png'], name, { type: 'image/png' }), stage: 'local', status: 'ready', url: `blob:fixture-${number}` });
    c.patchDraft({ cover: cover(20, 'unused-common-cover.png') }); c = h.render();
    c.patchTarget(id(2), { cover: cover(21, 'selected-target-cover.png') }); c = h.render();
    c.patchTarget(id(8), { cover: cover(22, 'unselected-account-cover.png') }); c = h.render();
    observedProbes.length = 0; await c.checkDraft(); c = h.render();
    verify('review excludes unselected account cover and superseded common cover before reading or uploading', Boolean(c.review) && c.review.mediaCount === 2 && observedProbes.includes('selected-target-cover.png') && !observedProbes.includes('unused-common-cover.png') && !observedProbes.includes('unselected-account-cover.png') && forbiddenCalls.length === 0);
    h.close();
  }
  {
    const source = { ...draftImplementation.emptyStudioDraft(), title: '深拷贝', topics: ['原公共话题'], media: [], targetOverrides: { [id(2)]: { topics: ['原账号话题'], cover: { id: id(4), name: '原封面', kind: 'image', size: 1, width: 640, height: 360, status: 'ready' }, options: { wxSph: { poiInfo: { poiId: 'fixture', poiName: '原位置', latitude: 1, longitude: 2 } } } } } };
    const frozen = draftImplementation.copyStudioDraft(source);
    source.topics[0] = '改公共'; source.targetOverrides[id(2)].topics[0] = '改账号'; source.targetOverrides[id(2)].cover.width = 9; source.targetOverrides[id(2)].options.wxSph.poiInfo.poiName = '改位置';
    verify('frozen copy isolates topics cover metadata and nested platform options', frozen.topics[0] === '原公共话题' && frozen.targetOverrides[id(2)].topics[0] === '原账号话题' && frozen.targetOverrides[id(2)].cover.width === 640 && frozen.targetOverrides[id(2)].options.wxSph.poiInfo.poiName === '原位置');
  }
  {
    const media = [31, 32, 33].map((number, index) => { const file = new File([String(number)], `image-${index}.png`, { type: 'image/png' }); return { id: id(number), name: file.name, kind: 'image', size: file.size, file, stage: 'local', status: 'ready', url: `blob:fixture-${number}` }; });
    const draft = { ...draftImplementation.emptyStudioDraft(), title: '有序素材子集', media, targetOverrides: { [id(2)]: { mediaIds: [id(32), id(31)] } } };
    const account = { id: id(2), platform: 'xhs', name: 'fixture', kind: 'browser', revision: 1 };
    const params = draftImplementation.studioPlanItems(draft, [account])[0].params;
    verify('per-account image subset retains selected order in actual plan DTO', params.images.map(item => item.filename).join(',') === 'image-1.png,image-0.png');
    const copied = draftImplementation.copyStudioDraft(draft); draft.targetOverrides[id(2)].mediaIds.reverse();
    verify('frozen target media IDs are cloned independently', copied.targetOverrides[id(2)].mediaIds.join(',') === [id(32), id(31)].join(','));
    assert.throws(() => draftImplementation.targetStudioMedia({ ...draft, targetOverrides: { [id(2)]: { mediaIds: [id(31), id(31)] } } }, id(2)), /重复/);
    assert.throws(() => draftImplementation.targetStudioMedia({ ...draft, targetOverrides: { [id(2)]: { mediaIds: [id(99)] } } }, id(2)), /变化/);
    assert.throws(() => draftImplementation.studioPlanItems({ ...draft, targetOverrides: { [id(2)]: { mediaIds: [] } } }, [account]), /请选择/);
    verify('duplicate unknown and explicit empty target selections fail closed', forbiddenCalls.length === 0);

    const h = harness(); let c = await h.populate(); c.patchDraft({ contentType: 'image', media, targetOverrides: { [id(2)]: { mediaIds: [id(32), id(31)] } } }); c = h.render();
    observedProbes.length = 0; await c.checkDraft(); c = h.render();
    verify('review only reads selected union and displays each target original order', c.review?.mediaCount === 2 && c.review.targets[0].mediaNames.join(',') === 'image-1.png,image-0.png' && !observedProbes.includes('image-2.png') && forbiddenCalls.length === 0);
    const reviewId = c.review.id; c.patchTarget(id(2), { mediaIds: [id(31)] }); c = h.render(); await c.publish(reviewId); c = h.render();
    verify('changing target media subset invalidates the old review before any mutation', c.review === null && /失效/u.test(c.error || '') && forbiddenCalls.length === 0); h.close();

    const providerMap = new Map(media.slice(0, 2).map((item, index) => [`/fixture/provider/${item.name}`, { mediaId: id(60 + index), file: item.file, kind: 'provider', metadata: { width: 640, height: 360 } }]));
    const materializer = moduleFrom(draftSource, { ...draftDependencies,
      './native-assets': { nativeSha256: sha, uploadNativeAsset: async (file, options) => { options?.assertCurrent?.(); report.syntheticHelperUploads.push(file.name); return `/fixture/provider/${file.name}`; } },
      './native-readable-media': { probeNativePublishingFile: async () => ({ width: 640, height: 360 }), readNativePublishingMedia: async url => { assert.ok(providerMap.has(url)); return providerMap.get(url); } },
    });
    let guards = 0;
    const materialized = await materializer.materializeStudioDraft({ ...copied, media: media.slice(0, 2) }, () => { guards++; });
    verify('RAM materialization remaps local IDs to provider IDs without losing per-target order', materialized.targetOverrides[id(2)].mediaIds.join(',') === [id(61), id(60)].join(',') && materialized.media.map(item => item.id).join(',') === [id(60), id(61)].join(',') && guards > 0);
    verify('RAM materialization has no unused media or source-draft mutation', report.syntheticHelperUploads.join(',') === 'image-0.png,image-1.png' && copied.targetOverrides[id(2)].mediaIds.join(',') === [id(32), id(31)].join(','));
  }
  verify('all boundary cases have zero mutation entry and zero real network', forbiddenCalls.length === 0 && report.actualNetworkCalls === 0);
  report.passed = checks.every(item => item.passed);
} catch (error) { report.error = String(error.stack || error).slice(0, 2600); process.exitCode = 1; }
finally {
  globalThis.fetch = realFetch;
  const output = path.resolve('.codex-evidence/publishing-studio-f76f3d79/qa/zero-network-review-boundaries.json');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, forbiddenCalls: forbiddenCalls.length, actualNetworkCalls: report.actualNetworkCalls, output, ...(report.error ? { error: report.error } : {}) }));
}
