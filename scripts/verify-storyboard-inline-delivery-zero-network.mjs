// Executes current component statements in RAM. The test does not change product files.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
assert.equal(process.version, 'v24.19.0');
const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript'), { z } = require('zod'), sharp = require('sharp');
const target = 'src/components/storyboard-workbench.tsx';
const sha = value => createHash('sha256').update(value).digest('hex');
const original = readFileSync(target), sourceSha256 = sha(original);
const candidate = original.toString().replace(/\r\n/g, '\n');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: "candidate.tsx", reportDiagnostics: true });
assert.equal((compile(candidate).diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const revoked = []; let created = 0;
const blobUrls = { createObjectURL: () => `blob:synthetic-${++created}`, revokeObjectURL: url => revoked.push(url) };
function load(file, dependencies) {
  const module = { exports: {} };
  runInNewContext(compile(readFileSync(file, 'utf8')).outputText, { module, exports: module.exports, require: name => { if (name in dependencies) return dependencies[name]; throw Error('Unmocked ' + name); }, Blob, Uint8Array, atob, URL: blobUrls, crypto: webcrypto });
  return module.exports;
}
const refs = load('src/lib/generated-image-reference.ts', { zod: { z } });
const client = load('src/lib/generated-image-client-delivery.ts', { '@/lib/generated-image-reference': refs });
const helperText = candidate.slice(candidate.indexOf('function storyboardGeneratedReceiptFields('), candidate.indexOf('function isWorkbenchRatio('));
const helperModule = { exports: {} };
runInNewContext(compile(helperText + '\nmodule.exports=storyboardInlineReceiptFields;').outputText, { module: helperModule, projectGeneratedImageClientReceipt: client.projectGeneratedImageClientReceipt });
const fields = helperModule.exports;
const recordId = 'a'.repeat(64);
const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#7b55d8' } }).png().toBuffer();
const payload = { recordId, deliveryMode: 'inline_ephemeral', cashCharged: 0.01, billed: true, images: [{ url: 'data:image/png;base64,' + png.toString('base64'), recordId, deliveryMode: 'inline_ephemeral', width: 320, height: 180, ephemeral: true }] };
assert.equal(fields(payload).imagePriceCharged, 0.01);
assert.equal(fields(payload).imageBillingState, 'settled');
assert.equal(fields({ ...payload, idempotencyReplayed: true }).imageBillingState, 'restored');
assert.equal(fields({ ...payload, recordId: 'other-owner', images: [] }), null);
assert.equal(fields({ ...payload, cashCharged: -1 }), null);
const loopStart = candidate.indexOf('      const generationAttempts = requestSnapshot.strictSingleSubmit');
const loopEnd = candidate.indexOf('\n    } catch (error) {\n      const message', loopStart);
const loop = candidate.slice(loopStart, loopEnd);
class RetryableImageFileError extends Error {}
async function receive(data, failDecode = false, failRatio = false) {
  const card = { id: 'card', order: 1 }, current = { id: 'run', cards: [card] }, module = { exports: {} };
  let posts = 0, dataFetches = 0; const patches = [];
  runInNewContext(compile(`module.exports=async()=>{let completedInlineReceipt=null;${loop}};`).outputText, {
    module, requestSnapshot: { strictSingleSubmit: false, runId: 'run', cardId: 'card', cardOrder: 1, aspectRatio: '16:9', referenceImageUrls: [] }, IMAGE_GENERATION_ATTEMPTS: 3,
    scopeMountedRef: { current: true }, current, runRef: { current }, card, cardId: 'card', token: 'fixture', clientTraceId: 'trace', clientIdempotencyKey: 'key', modelName: 'public fixture', AbortSignal,
    fetch: async (url, init) => { if (url !== '/api/image/generate') { dataFetches++; throw Error('CSP: connect-src denies non-HTTP scheme'); } assert.equal(init.method, 'POST'); posts++; return { ok: true, json: async () => data }; },
    storyboardInlineReceiptFields: fields, resolveGeneratedImageClientDelivery: client.resolveGeneratedImageClientDelivery,
    patchCard: (_id, patch) => { Object.assign(card, patch); patches.push(patch); }, URL: blobUrls,
    browserImageReady: async () => { if (failDecode) throw Error('decode failed'); return { width: 320, height: 180 }; },
    imageDimensionsMatchAspectRatio: () => !failRatio, providerMediaUrl: () => null, RetryableImageFileError,
    readOwnedStoryboardImage: () => { throw Error('Implicit asset recovery forbidden'); },
    ephemeralImageUrlsRef: { current: new Set() }, clearBrowserClientAttempt() {}, setNotice() {}, delay: () => { throw Error('Paid inline must not enter retry'); },
  });
  const value = await module.exports();
  assert.equal(posts, 1); assert.equal(dataFetches, 0); assert.equal(card.imageStatus, 'done'); assert.equal(card.imagePriceCharged, 0.01); assert.equal(card.imageBillingState, 'settled'); assert.equal(card.imageRecordId, recordId);
  return { value, card, patches, posts, dataFetches };
}
const visible = await receive(payload); assert.ok(visible.value.imageUrl.startsWith('blob:')); assert.equal(visible.card.imageRetryBlocked, false); assert.equal(revoked.length, 0);
const noPreview = await receive(payload, true); assert.equal(noPreview.value, null); assert.equal(noPreview.card.imageUrl, undefined); assert.equal(noPreview.card.imageRetryBlocked, true); assert.equal(revoked.length, 1);
const wrongRatio = await receive(payload, false, true); assert.equal(wrongRatio.card.imageStatus, 'done'); assert.equal(wrongRatio.card.imagePriceCharged, 0.01); assert.equal(revoked.length, 2);
const replay = await receive({ ...payload, images: [] }); assert.equal(replay.value, null); assert.equal(replay.card.imageRetryBlocked, true);
const invalidBytes = await receive({ ...payload, images: [{ ...payload.images[0], url: 'invalid transient format' }] }, true); assert.equal(invalidBytes.card.imageStatus, 'done'); assert.equal(invalidBytes.card.imagePriceCharged, 0.01);
const pollStart = candidate.indexOf('          if (status.state === "completed" && status.deliveryMode === "inline_ephemeral")');
const pollEnd = candidate.indexOf('          if (status.state === "completed" && status.deliveryMode === "provider_url"', pollStart);
const pollModule = { exports: {} }; let pollPatch; const pollCard={id:'card'}; const pollRun={current:{cards:[pollCard]}}; const pollBlobs={current:new Set()};
runInNewContext(compile(`module.exports=status=>{${candidate.slice(pollStart, pollEnd)}};`).outputText, { module: pollModule, card: pollCard, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, storyboardInlineReceiptFields: fields, patchCard: (_id, patch) => { pollPatch = patch; } });
pollModule.exports({ ...payload, state: 'completed', images: [] }); assert.equal(pollPatch.imagePriceCharged, 0.01); assert.equal(pollPatch.imageBillingState, 'settled'); assert.equal(pollPatch.imageUrl, undefined);
const recoveredStart = candidate.indexOf('      const recoveredInlineReceipt =');
const recoveredEnd = candidate.indexOf('      const confirmedRejected =', recoveredStart);
const recoveredModule = { exports: {} }; let recoveredPatch;
runInNewContext(compile(`module.exports=status=>{${candidate.slice(recoveredStart, recoveredEnd)}};`).outputText, { module: recoveredModule, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, card: { order: 1 }, cardId: 'card', storyboardInlineReceiptFields: fields, patchCard: (_id, patch) => { recoveredPatch = patch; }, setNotice() {} });
recoveredModule.exports({ ...payload, state: 'completed', images: [] }); assert.equal(recoveredPatch.imageStatus, 'done'); assert.equal(recoveredPatch.imagePriceCharged, 0.01);
assert.equal(sha(readFileSync(target)), sourceSha256);
const summary = { proposedOnly: true, productSourceUnchanged: true, syntaxDiagnostics: 0, passed: true, checks: ['actual shared helper direct decode under data-fetch denial', 'actual component receiving loop success', 'preview decode failure retains paid success, one POST, blob finally revoked', 'metadata-only replay keeps fee and cannot recover', 'malformed transient does not retry paid generation', 'actual poll completed-inline cash and settlement', 'actual catch completed-inline cash and settlement'], sourceSha256: sourceSha256, realNetworkCalls: 0, realDatabaseWrites: 0, realProviderCalls: 0, scope: 'RAM candidate statement VM; not browser or paid E2E; no product source applied' };

Object.assign(pollCard,{imageRecordId:recordId,imageDeliveryMode:'inline_ephemeral',imageUrl:'blob:current',imageValidatedAt:1});pollBlobs.current.add('blob:current');
pollModule.exports({...payload,state:'completed',images:[]});assert.equal(pollPatch.imageUrl,'blob:current');assert.equal(pollPatch.imageValidatedAt,1);assert.equal(pollPatch.imageRetryBlocked,false);
const recoverStart = candidate.indexOf('        if (confirmed?.state === "completed" && confirmed.deliveryMode === "inline_ephemeral")');
const recoverEnd = candidate.indexOf('        if (confirmed?.state === "completed" && confirmed.deliveryMode === "provider_url"', recoverStart);
const explicitModule = { exports: {} }; let explicitPatch;
runInNewContext(compile(`module.exports=confirmed=>{${candidate.slice(recoverStart,recoverEnd)}};`).outputText, { module:explicitModule, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, cardId:'card', storyboardInlineReceiptFields:fields, patchCard:(_id,patch)=>{explicitPatch=patch;} });
explicitModule.exports({...payload,state:'completed',images:[]});assert.equal(explicitPatch.imageUrl,'blob:current');assert.equal(explicitPatch.imagePriceCharged,0.01);assert.equal(explicitPatch.imageBillingState,'settled');
const contracts = load('src/lib/storyboard-project-contract.ts', { zod:{z}, '@/lib/generated-image-reference':refs });
const persistence = load('src/lib/storyboard-local-persistence.ts', { '@/lib/storyboard-project-contract':contracts, '@/lib/generated-image-reference':refs });
const snapshot = persistence.createStoryboardPersistenceSnapshot({id:'run',cards:[{...visible.card,referenceImageUrls:[],imagePrompt:'Draw label data: value'}]});
assert.equal(snapshot.cards[0].imagePriceCharged,0.01);assert.equal(snapshot.cards[0].imageRecordId,recordId);assert.equal(snapshot.cards[0].imageUrl,undefined);assert.equal(snapshot.cards[0].imagePrompt,'Draw label data: value');
// Execute the exact installed browser route callback: real GET allowlist cannot follow redirects.
const browserSource = readFileSync('scripts/verify-storyboard-ephemeral-current-browser.mjs', 'utf8');
const { fulfillApprovedStoryboardRead } = await import('./verify-storyboard-ephemeral-current-browser.mjs');
const callbackStart = browserSource.indexOf('async (route) => {', browserSource.indexOf('await context.route('));
const callbackEnd = browserSource.indexOf('\n    });', callbackStart);
const callbackSource = browserSource.slice(callbackStart, callbackEnd) + '\n}';
const staticFunction = browserSource.slice(browserSource.indexOf('function isStaticEntry('), browserSource.indexOf('function loadContract('));
const approvedDeclaration = browserSource.slice(browserSource.indexOf('const approvedApiGets ='), browserSource.indexOf('function isStaticEntry('));
async function routeCase(pathname, status, method = 'GET') {
  const module = { exports: {} }, report = { approvedApiGetCounts: {}, approvedReadRejectedCount: 0, blockedExternalCount: 0, blockedOtherGetCount: 0, blockedNonGetCount: 0 };
  let forwarded = 0, fulfilled = 0, aborted = 0;
  runInNewContext(`${approvedDeclaration}\n${staticFunction}\nmodule.exports=${callbackSource};`, { module, URL, path, statSync, origin: 'http://127.0.0.1:5000', report, fulfillApprovedStoryboardRead, routeErrors: [], json: () => assert.fail('Unexpected fixture branch') });
  await module.exports({ request: () => ({ url: () => pathname.startsWith('https://') ? pathname : 'http://127.0.0.1:5000' + pathname, method: () => method }),
    fetch: async options => { assert.deepEqual(options, { maxRedirects: 0 }); forwarded++; return { ok: () => status >= 200 && status < 300, status: () => status }; },
    continue: () => assert.fail('Unbounded redirect continuation forbidden'), fulfill: async () => { fulfilled++; }, abort: async reason => { assert.equal(reason, 'blockedbyclient'); aborted++; },
  });
  return { forwarded, fulfilled, aborted, report };
}
for (const pathname of ['/api/cover-models', '/storyboard-workbench', '/_next/static/fixture.js']) {
  for (const status of [301, 302, 307, 308, 401, 500]) { const result = await routeCase(pathname, status); assert.equal(result.forwarded, 1); assert.equal(result.fulfilled, 0); assert.equal(result.aborted, 1); assert.equal(result.report.approvedReadRejectedCount, 1); }
  const ok = await routeCase(pathname, 200); assert.equal(ok.fulfilled, 1); assert.equal(ok.aborted, 0);
}
for (const pathname of ['/api/image/generate/status', '/api/video/h3-lifecycle', '/api/media-history/content', 'https://provider.invalid/result']) { const result = await routeCase(pathname, 200); assert.equal(result.forwarded, 0); assert.equal(result.aborted, 1); }
assert.equal((await routeCase('/api/settings', 200, 'POST')).forwarded, 0);
assert.ok(browserSource.includes('redirect: "error"')); assert.ok(browserSource.indexOf('report.failureIndicators =') < browserSource.indexOf('if (browser) await browser.close()'));

// Completed receipts restored by the actual persistence projector are terminal, not unknown.
const ast = ts.createSourceFile(target, candidate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes=[]; function visit(node){nodes.push(node);ts.forEachChild(node,visit);} visit(ast);
const named = name => nodes.find(node => (ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node)) && node.name?.getText(ast)===name);
const pureNames=['hasValidatedImage','isCompletedInlineImageReceipt','isUnavailableCompletedInlineImage','imageAttemptNeedsResolution','cardStatus'];
const pureSource=pureNames.map(name=>named(name).getText(ast)).join('\n');
const terminalModule={exports:{}};
runInNewContext(compile(pureSource+'\nmodule.exports={hasValidatedImage,isCompletedInlineImageReceipt,isUnavailableCompletedInlineImage,imageAttemptNeedsResolution,cardStatus};').outputText,{module:terminalModule});
const terminal=terminalModule.exports;
const restored={...snapshot.cards[0],id:'paid',order:1,videoStatus:'idle',imageClientRequestId:'original-key',imageClientTraceId:'original-trace',imageClientRequestFingerprint:'original-fingerprint',referenceImageUrls:[]};
assert.equal(restored.imageRetryBlocked,true);assert.equal(restored.imageStatus,'done');
assert.equal(terminal.imageAttemptNeedsResolution(restored),false);
assert.equal(terminal.cardStatus(restored).status,'done');assert.match(terminal.cardStatus(restored).label,/已完成.*不可恢复/u);
for(const patch of [{imageRecordId:'bad'},{imagePriceCharged:-1},{imagePriceCharged:undefined},{imageBillingState:'pending'},{imageStatus:'failed'},{imageDeliveryMode:'provider_url'}])assert.equal(terminal.imageAttemptNeedsResolution({...restored,...patch}),true);
const pollExpression=candidate.slice(candidate.indexOf('const candidates = runRef.current.cards.filter('),candidate.indexOf('      await Promise.all(candidates.map',candidate.indexOf('const candidates = runRef.current.cards.filter(')));
let submissions=0;
function pollCards(cards){const module={exports:{}};runInNewContext(compile(pureSource+'\n'+pollExpression+'\nmodule.exports=candidates;').outputText,{module,runRef:{current:{cards}},imageSubmissionsRef:{current:new Set()}});return module.exports;}
assert.equal(pollCards([restored]).length,0);
const unknown={...restored,id:'unknown',imageStatus:'failed',imageBillingState:'pending'};
assert.equal(pollCards([unknown]).length,1);assert.equal(terminal.imageAttemptNeedsResolution(unknown),true);
const callback=name=>named(name).initializer.arguments[0].getText(ast);
let runtime={cards:[restored]};const runRef={current:runtime};let notice='';let submittedIds=[];
function actualCallback(name,extra={}){const module={exports:{}};runInNewContext(compile(pureSource+'\nmodule.exports='+callback(name)+';').outputText,{module,run:{cards:runtime.cards},runRef,batchMode:'',activeImageSelectionIssue:'',activeVideoSelectionIssue:'',imageCapabilities:{maxReferenceImages:4},videoPromptRequired:false,setNotice:value=>notice=value,setBatchMode(){},runImageBatch:async ids=>{submittedIds.push(...ids);return ids;},runVideoBatch:()=>assert.fail('No video without current media'),isActiveVideoStatus:()=>false,setRun:updater=>{runtime=updater(runtime);runRef.current=runtime;},...extra});return module.exports;}
actualCallback('patchCard')('paid',{imagePrompt:'Edited long English prompt '+ 'word '.repeat(160)});
const edited=runtime.cards[0];for(const key of ['imageStatus','imageRecordId','imageClientRequestId','imageClientTraceId','imageClientRequestFingerprint','imagePriceCharged','imageBillingState'])assert.equal(edited[key],restored[key]);
await actualCallback('batchImages')();assert.equal(submittedIds.length,0);
runtime.cards.push({id:'new',order:2,imageStatus:'idle',imagePrompt:'New card',referenceImageUrls:[],videoStatus:'idle'});
await actualCallback('batchImages')();assert.deepEqual(submittedIds,['new']);
submittedIds=[];runtime.cards=[edited,unknown];await actualCallback('batchImages')();assert.equal(submittedIds.length,0);assert.match(notice,/待确认/u);
runtime.cards=[edited];await actualCallback('fullFlow')();assert.equal(submittedIds.length,0);assert.match(notice,/已完成.*不可恢复/u);
// The real programmatic guard retains the original request identity and performs no POST.
const guardStart=candidate.indexOf('    if (card.imageRetryBlocked) {',candidate.indexOf('const generateImage ='));
const guardEnd=candidate.indexOf('    if (isActiveVideoStatus',guardStart);
const guardModule={exports:{}};runInNewContext(compile(pureSource+'\nmodule.exports=()=>{'+candidate.slice(guardStart,guardEnd)+'};').outputText,{module:guardModule,card:edited,setNotice:value=>notice=value,fetch:()=>{submissions++;assert.fail('Completed receipt must never resubmit');}});guardModule.exports();assert.equal(submissions,0);assert.match(notice,/已完成.*不可恢复/u);
// Render the actual JSX text/title expressions, rather than testing copied display strings.
const emptyExpression=nodes.filter(node=>ts.isJsxExpression(node)&&node.expression?.getText(ast).includes('"尚未生成"')).sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0].expression.getText(ast);
const imageButton=nodes.find(node=>ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(ast)==='className'&&attr.initializer?.getText(ast)==='"is-command is-image-command"'));
const titleExpression=imageButton.openingElement.attributes.properties.find(attr=>attr.name?.getText(ast)==='title').initializer.expression.getText(ast);
const labelExpression=imageButton.children.find(node=>ts.isJsxExpression(node)&&node.expression?.getText(ast).includes('"结果待确认"')).expression.getText(ast);
for(const [expression,expected]of [[emptyExpression,'已完成·临时图片不可恢复'],[titleExpression,'图片已完成，临时图片不可恢复，已禁止重复提交'],[labelExpression,'图片不可恢复']]){const module={exports:{}};runInNewContext(compile(pureSource+'\nmodule.exports=('+expression+');').outputText,{module,card:edited,isActiveVideoStatus:()=>false,batchMode:'',activeImageSelectionIssue:'',statusText:()=>assert.fail('No active state')});assert.equal(module.exports,expected);}
runtime.cards=[edited,{id:'other',videoStatus:'idle'}];actualCallback('removeCard')('paid');assert.equal(runtime.cards.length,1);assert.equal(runtime.cards[0].id,'other');
// Execute the full actual automatic poll callback with the restored terminal card.
const inspectModule={exports:{}};let statusChecks=0;
runInNewContext(compile(pureSource+'\nmodule.exports='+named('inspectActiveImages').initializer.getText(ast)+';').outputText,{module:inspectModule,runRef:{current:{cards:[edited]}},imageSubmissionsRef:{current:new Set()},fetch:()=>{statusChecks++;assert.fail('No completed receipt status GET');}});
await inspectModule.exports();assert.equal(statusChecks,0);assert.equal(submissions,0);

console.log(JSON.stringify({...summary, completedTerminalReceipt:true, actualBatchEditDeletePollAndDisplay:true,proposedOnly:false,scope:'actual component/shared helper and actual installed browser route callback; mocked dependencies, no browser/provider/DB', redirectAndOnlyOkNegatives:18, liveSameRecordBlobPreserved:true}));
