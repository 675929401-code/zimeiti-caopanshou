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
const ast = ts.createSourceFile(target, candidate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes=[]; function visit(node){nodes.push(node);ts.forEachChild(node,visit);} visit(ast);
const named = name => { const matches=nodes.filter(node => (ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node)) && node.name?.getText(ast)===name); assert.equal(matches.length,1,`Unique actual declaration required: ${name}`); return matches[0]; };
const callbackNode = name => { const init=named(name).initializer; assert.ok(init,`Actual initializer required: ${name}`); const value=ts.isCallExpression(init)&&init.expression.getText(ast)==='useCallback'?init.arguments[0]:init; assert.ok(ts.isArrowFunction(value)||ts.isFunctionExpression(value),`Actual function required: ${name}`); return value; };
const callback = name => callbackNode(name).getText(ast);
const descendants = node => { const found=[]; const walk=value=>{found.push(value);ts.forEachChild(value,walk);};walk(node);return found; };
const uniqueIf = (scope,condition) => { const matches=descendants(scope).filter(node=>ts.isIfStatement(node)&&node.expression.getText(ast)===condition);assert.equal(matches.length,1,`Unique actual branch required: ${condition}`);return matches[0].getText(ast); };
const checkedSlice = (text,start,end,label) => { assert.ok(start>=0&&end>start,`Nonempty actual source required: ${label}`);return text.slice(start,end); };
const revoked = []; let created = 0;
const blobUrls = { createObjectURL: () => `blob:synthetic-${++created}`, revokeObjectURL: url => revoked.push(url) };
const loaded=new Map();
function load(file, dependencies = {}) {
  const absolute=path.resolve(file);if(loaded.has(absolute))return loaded.get(absolute).exports;
  const module = { exports: {} };
  loaded.set(absolute,module);
  runInNewContext(compile(readFileSync(absolute, 'utf8')).outputText, { module, exports: module.exports, require: name => {
    if(name in dependencies)return dependencies[name];if(name==='zod')return {z};
    if(name.startsWith('@/lib/')||name.startsWith('.')){const target=name.startsWith('@/lib/')?path.resolve('src',name.slice(2)):path.resolve(path.dirname(absolute),name);assert.ok(target.startsWith(path.resolve('src/lib')+path.sep),'Only actual local pure library dependencies are allowed');return load(path.extname(target)?target:target+'.ts');}
    throw Error('Unmocked '+name);
  }, Blob, Uint8Array, atob, URL:blobUrls, crypto:webcrypto,fetch:()=>assert.fail('Library loading must not perform network I/O') });
  return module.exports;
}
const refs = load('src/lib/generated-image-reference.ts', { zod: { z } });
const client = load('src/lib/generated-image-client-delivery.ts', { '@/lib/generated-image-reference': refs });
const board = load('src/lib/storyboard-board-export.ts', {});
const resultState = load('src/lib/storyboard-image-result-state.ts', {});
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
const generateNode=callbackNode('generateImage');
const imagePosts=descendants(generateNode).filter(node=>ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='fetch'&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='/api/image/generate');
assert.equal(imagePosts.length,1,'generateImage must contain exactly one explicit image POST');
let dispatchAncestor=imagePosts[0].parent;
while(dispatchAncestor&&dispatchAncestor!==generateNode){
  assert.ok(!ts.isForStatement(dispatchAncestor)&&!ts.isForInStatement(dispatchAncestor)&&!ts.isForOfStatement(dispatchAncestor)&&!ts.isWhileStatement(dispatchAncestor)&&!ts.isDoStatement(dispatchAncestor),'The explicit image POST must not be nested in a retry loop');
  dispatchAncestor=dispatchAncestor.parent;
}
assert.equal(dispatchAncestor,generateNode,'The explicit image POST must remain owned by generateImage');
let responseStatement=imagePosts[0];while(responseStatement&&!ts.isVariableStatement(responseStatement))responseStatement=responseStatement.parent;
assert.ok(responseStatement&&ts.isBlock(responseStatement.parent)&&ts.isTryStatement(responseStatement.parent.parent));
const singleBlock=responseStatement.parent.parent.parent;
assert.ok(ts.isBlock(singleBlock)&&singleBlock.statements.some(node=>ts.isTryStatement(node)),'Actual single-dispatch Block required');
assert.equal(descendants(singleBlock).filter(node=>ts.isCallExpression(node)&&node===imagePosts[0]).length,1);
const singleDispatch=singleBlock.getText(ast);
const localDeclaration = name => { const matches=descendants(generateNode).filter(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)===name);assert.equal(matches.length,1,`Unique generateImage local required: ${name}`);return `const ${matches[0].getText(ast)};`; };
const submissionGuards=['sameImageSubmissionScope','sameImageRequestCurrent','assertImageSubmissionCurrent'].map(localDeclaration).join('\n');
const submissionInput=named('storyboardImageSubmissionInput').getText(ast);
class RetryableImageFileError extends Error {}
async function receive(data, failDecode = false, failRatio = false, options = {}) {
  const requestSnapshot={strictSingleSubmit:false,runId:'run',cardId:'card',cardOrder:1,prompt:'fixture prompt',modelId:'fixture-model',aspectRatio:'16:9',referenceImageUrls:[]};
  const card = { id:'card',order:1,imagePrompt:'fixture prompt',imageClientRequestId:'key',imageClientRequestFingerprint:'fingerprint',imageRequestSnapshot:requestSnapshot }, current = { id:'run',ratio:'16:9',cards:[card] }, module = { exports: {} };
  const imageOperation=Symbol('fixture'),owner={current:'user\0fixture'},runRef={current};
  let posts = 0, dataFetches = 0; const patches = [], originalBlobs=new Map();
  const context={
    module,requestSnapshot,scopeMountedRef:{current:true},contextReadyRef:{current:true},navigationRef:{current:false},imageDownloadOwnerRef:owner,imageSubmissionOwner:owner.current,imageSubmissionOperationsRef:{current:new Map([['card',imageOperation]])},imageSubmissionsRef:{current:new Set(['card'])},imageOperation,
    current,runRef,card,cardId:'card',userId:'user',token:'fixture',clientTraceId:'trace',clientIdempotencyKey:'key',imageClientRequestFingerprint:'fingerprint',recovering:false,modelName:'public fixture',AbortSignal,URL:blobUrls,
    effectiveImageRatio:run=>run.ratio,assertPlannedDirectorReferencesCurrent:()=>{if(options.preflightRejected)throw Error('fixture reference preflight changed');},
    fetch: async (url, init) => { if (url !== '/api/image/generate') { dataFetches++; throw Error('CSP: connect-src denies non-HTTP scheme'); } assert.equal(init.method, 'POST'); posts++; if(options.networkFailure)throw Error('fixture transport failed');return { ok:options.responseOk!==false,json:async()=>data }; },
    storyboardInlineReceiptFields: fields, resolveGeneratedImageClientDelivery: client.resolveGeneratedImageClientDelivery,
    patchCard: (_id, patch) => { Object.assign(card, patch); patches.push(patch); },
    browserImageReady: async () => { if (failDecode) throw Error('decode failed'); return { width: 320, height: 180 }; },
    imageDimensionsMatchAspectRatio: () => !failRatio, providerMediaUrl: () => null, RetryableImageFileError,
    readOwnedStoryboardImage: () => { throw Error('Implicit asset recovery forbidden'); },
    originalBoardBlobsRef:{current:originalBlobs},rememberStoryboardBoardBlob:board.rememberStoryboardBoardBlob,Blob,
    ephemeralImageUrlsRef: { current: new Set() }, clearBrowserClientAttempt() {}, setNotice() {}, delay: () => { throw Error('Paid inline must not enter retry'); },
  };
  runInNewContext(compile(`${submissionInput}\n${submissionGuards}\nmodule.exports={input:storyboardImageSubmissionInput(current,card),receive:async()=>{let completedInlineReceipt=null;let imageProviderDispatched=false;${singleDispatch}}};`).outputText,context);
  context.expectedImageInput=module.exports.input;
  if(options.ownerChanged)owner.current='different-owner';if(options.fingerprintChanged)card.imageClientRequestFingerprint='changed';if(options.inputChanged)card.imagePrompt='changed prompt';
  let value,error;try{value=await module.exports.receive();}catch(cause){error=cause;}
  assert.equal(posts,options.noPost?0:1);assert.equal(dataFetches,0);
  if(options.expectError){assert.ok(error,'Actual dispatch guard/failure must reject');return {error,posts,patches};}assert.ifError(error);
  assert.equal(card.imageStatus, 'done'); assert.equal(card.imagePriceCharged, 0.01); assert.equal(card.imageBillingState, 'settled'); assert.equal(card.imageRecordId, recordId);
  return { value, card, patches, posts, dataFetches };
}
const visible = await receive(payload); assert.ok(visible.value.imageUrl.startsWith('blob:')); assert.equal(visible.card.imageRetryBlocked, false); assert.equal(revoked.length, 0);
const noPreview = await receive(payload, true); assert.equal(noPreview.value, null); assert.equal(noPreview.card.imageUrl, undefined); assert.equal(noPreview.card.imageRetryBlocked, true); assert.equal(revoked.length, 1);
const wrongRatio = await receive(payload, false, true); assert.equal(wrongRatio.card.imageStatus, 'done'); assert.equal(wrongRatio.card.imagePriceCharged, 0.01); assert.equal(revoked.length, 2);
const replay = await receive({ ...payload, images: [] }); assert.equal(replay.value, null); assert.equal(replay.card.imageRetryBlocked, true);
const invalidBytes = await receive({ ...payload, images: [{ ...payload.images[0], url: 'invalid transient format' }] }, true); assert.equal(invalidBytes.card.imageStatus, 'done'); assert.equal(invalidBytes.card.imagePriceCharged, 0.01);
for(const options of [{networkFailure:true},{responseOk:false}])await receive({error:'fixture rejected',state:'rejected',canResubmit:true,sameKeyCanResubmit:false},false,false,{...options,expectError:true});
for(const options of [{ownerChanged:true},{fingerprintChanged:true},{inputChanged:true},{preflightRejected:true}])await receive(payload,false,false,{...options,noPost:true,expectError:true});
const pollStart = candidate.indexOf('          if (status.state === "completed" && status.deliveryMode === "inline_ephemeral")');
const pollEnd = candidate.indexOf('          if (status.state === "completed" && status.deliveryMode === "provider_url"', pollStart);
const pollModule = { exports: {} }; let pollPatch; const pollCard={id:'card'}; const pollRun={current:{cards:[pollCard]}}; const pollBlobs={current:new Set()};
runInNewContext(compile(`module.exports=async status=>{${checkedSlice(candidate,pollStart,pollEnd,'completed-inline poll')}};`).outputText, { module: pollModule, card: pollCard, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, storyboardInlineReceiptFields: fields,restoreOwnedBoard:async()=>false,isCurrentInspection:()=>true,patchInspection:patch=>{pollPatch=patch;} });
await pollModule.exports({ ...payload, state: 'completed', images: [] }); assert.equal(pollPatch.imagePriceCharged, 0.01); assert.equal(pollPatch.imageBillingState, 'settled'); assert.equal(pollPatch.imageUrl, undefined);
const recoveredStart = candidate.indexOf('      const recoveredInlineReceipt =');
const recoveredModule = { exports: {} }; let recoveredPatch;
const recoveredBranch=uniqueIf(generateNode,'recoveredInlineReceipt');
runInNewContext(compile(`module.exports=async status=>{${checkedSlice(candidate,recoveredStart,candidate.indexOf('      if (recoveredInlineReceipt)',recoveredStart),'recovered inline receipt')}${recoveredBranch}};`).outputText, { module: recoveredModule, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, card: { order: 1 }, cardId: 'card', storyboardInlineReceiptFields: fields,restoreOwnedBoard:async()=>false,sameImageRequestCurrent:()=>true,patchCard: (_id, patch) => { recoveredPatch = patch; }, setNotice() {} });
await recoveredModule.exports({ ...payload, state: 'completed', images: [] }); assert.equal(recoveredPatch.imageStatus, 'done'); assert.equal(recoveredPatch.imagePriceCharged, 0.01);
assert.equal(sha(readFileSync(target)), sourceSha256);
const summary = { proposedOnly: true, productSourceUnchanged: true, syntaxDiagnostics: 0, passed: true, checks: ['actual shared helper direct decode under data-fetch denial', 'actual component receiving loop success', 'preview decode failure retains paid success, one POST, blob finally revoked', 'metadata-only replay keeps fee and cannot recover', 'malformed transient does not retry paid generation', 'actual poll completed-inline cash and settlement', 'actual catch completed-inline cash and settlement'], sourceSha256: sourceSha256, realNetworkCalls: 0, realDatabaseWrites: 0, realProviderCalls: 0, scope: 'RAM candidate statement VM; not browser or paid E2E; no product source applied' };

Object.assign(pollCard,{imageRecordId:recordId,imageDeliveryMode:'inline_ephemeral',imageUrl:'blob:current',imageValidatedAt:1});pollBlobs.current.add('blob:current');
await pollModule.exports({...payload,state:'completed',images:[]});assert.equal(pollPatch.imageUrl,'blob:current');assert.equal(pollPatch.imageValidatedAt,1);assert.equal(pollPatch.imageRetryBlocked,false);
const recoverStart = candidate.indexOf('        if (confirmed?.state === "completed" && confirmed.deliveryMode === "inline_ephemeral")');
const recoverEnd = candidate.indexOf('        if (confirmed?.state === "completed" && confirmed.deliveryMode === "provider_url"', recoverStart);
const explicitModule = { exports: {} }; let explicitPatch;
runInNewContext(compile(`module.exports=async confirmed=>{${checkedSlice(candidate,recoverStart,recoverEnd,'explicit completed-inline recovery')}};`).outputText, { module:explicitModule, runRef:pollRun, ephemeralImageUrlsRef:pollBlobs, cardId:'card', storyboardInlineReceiptFields:fields,restoreOwnedBoard:async()=>false,sameImageRequestCurrent:()=>true,patchCard:(_id,patch)=>{explicitPatch=patch;} });
await explicitModule.exports({...payload,state:'completed',images:[]});assert.equal(explicitPatch.imageUrl,'blob:current');assert.equal(explicitPatch.imagePriceCharged,0.01);assert.equal(explicitPatch.imageBillingState,'settled');
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
const pureNames=['hasValidatedImage','isCompletedInlineImageReceipt','isUnavailableCompletedInlineImage','imageAttemptNeedsResolution','cardStatus'];
const pureSource=pureNames.map(name=>named(name).getText(ast)).join('\n');
const terminalModule={exports:{}};
runInNewContext(compile(pureSource+'\nmodule.exports={hasValidatedImage,isCompletedInlineImageReceipt,isUnavailableCompletedInlineImage,imageAttemptNeedsResolution,cardStatus};').outputText,{...resultState,module:terminalModule});
const terminal=terminalModule.exports;
const restored={...snapshot.cards[0],id:'paid',order:1,videoPrompt:'A fixed camera observes the subject.',videoStatus:'idle',imageClientRequestId:'original-key',imageClientTraceId:'original-trace',imageClientRequestFingerprint:'original-fingerprint',referenceImageUrls:[]};
assert.equal(restored.imageRetryBlocked,true);assert.equal(restored.imageStatus,'done');
assert.equal(terminal.imageAttemptNeedsResolution(restored),false);
assert.equal(terminal.cardStatus(restored).status,'done');assert.match(terminal.cardStatus(restored).label,/已完成.*不可恢复/u);
for(const patch of [{imageRecordId:'bad'},{imagePriceCharged:-1},{imagePriceCharged:undefined},{imageBillingState:'pending'},{imageStatus:'failed'},{imageDeliveryMode:'provider_url'}])assert.equal(terminal.imageAttemptNeedsResolution({...restored,...patch}),true);
const pollCandidates=descendants(callbackNode('inspectActiveImages')).filter(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='candidates');assert.equal(pollCandidates.length,1);
const pollExpression=`const ${pollCandidates[0].getText(ast)};`;
let submissions=0;
function pollCards(cards){const module={exports:{}};runInNewContext(compile(pureSource+'\n'+pollExpression+'\nmodule.exports=candidates;').outputText,{...resultState,module,runRef:{current:{cards}},imageSubmissionsRef:{current:new Set()}});return module.exports;}
assert.equal(pollCards([restored]).length,0);
const unknown={...restored,id:'unknown',imageStatus:'failed',imageBillingState:'pending'};
assert.equal(pollCards([unknown]).length,1);assert.equal(terminal.imageAttemptNeedsResolution(unknown),true);
const chain=load('src/lib/storyboard-chain-contract.ts',{zod:{z},'@/lib/generated-image-reference':refs});
function libraryFunctions(file,names){const source=readFileSync(file,'utf8'),syntax=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);return names.map(name=>{const declarations=syntax.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.equal(declarations.length,1,`Actual library function required: ${name}`);return declarations[0].getText(syntax).replace(/^export /u,'');}).join('\n');}
const continuousBlockers=libraryFunctions('src/lib/storyboard-continuous-production.ts',['storyboardProductionBlocker'])+'\n'+libraryFunctions('src/lib/storyboard-automatic-video-inputs.ts',['automaticProductionCard','automaticProductionRun','storyboardAutomaticVideoProductionBlocker']);
let runtime={id:'run',executionMode:'ordinary',cards:[restored]};const runRef={current:runtime};let notice='';let submittedIds=[],chainedCalls=0,continuousCalls=0;
function actualCallback(name,extra={}){const module={exports:{}};const ordinary=name==='batchImages'?`const ordinaryBatchImages=${callback('ordinaryBatchImages')};\n`:'';runInNewContext(compile(pureSource+'\n'+continuousBlockers+'\n'+ordinary+'module.exports='+callback(name)+';').outputText,{...resultState,...chain,module,run:{cards:runtime.cards},runRef,batchMode:'',batchAuthorizationRef:{current:null},initialReferenceAdoptionRef:{current:false},workspaceGenerationRef:{current:1},ensureInitialReferencesAdopted:async()=>true,visualAssetMutationRef:{current:false},navigationRef:{current:false},contextReadyRef:{current:true},activeImageSelectionIssue:'',activeImageRatioIssue:'',activeVideoSelectionIssue:'',imageCapabilities:{maxReferenceImages:4},videoPromptRequired:false,setNotice:value=>notice=value,setBatchMode(){},buildBatchAuthorization:(kind,cardIds)=>({kind,cardIds}),runImageBatch:async ids=>{submittedIds.push(...ids);return ids;},startChainedImages:async()=>{chainedCalls++;},runVideoBatch:()=>assert.fail('No video without current media'),isActiveVideoStatus:()=>false,imageSubmissionsRef:{current:new Set()},videoSubmissionsRef:{current:new Set()},
  continuousBusyRef:{current:false},continuousAuthorizationRef:{current:null},visualAssetGenerationRef:{current:false},token:'fixture',userId:'user',activeVideoModel:{id:'video-fixture'},isStoryboardImageWorkflow:()=>true,setContinuousStatus(){},setContinuousMessage:value=>notice=value,processContinuousProduction:()=>{continuousCalls++;assert.fail('Completed unavailable receipt must not start production');},storyboardProductionImageInputMatch:()=>assert.fail('Unavailable paid receipt must stop before further production'),
  setRun:updater=>{runtime=typeof updater==='function'?updater(runtime):updater;runRef.current=runtime;},...extra});return module.exports;}
actualCallback('patchCard')('paid',{imagePrompt:'Edited long English prompt '+ 'word '.repeat(160)});
const edited=runtime.cards[0];for(const key of ['imageStatus','imageRecordId','imageClientRequestId','imageClientTraceId','imageClientRequestFingerprint','imagePriceCharged','imageBillingState'])assert.equal(edited[key],restored[key]);
await actualCallback('batchImages')();assert.equal(submittedIds.length,0);
runtime.cards.push({id:'new',order:2,imageStatus:'idle',imagePrompt:'New card',referenceImageUrls:[],videoStatus:'idle'});
await actualCallback('batchImages')();assert.deepEqual(submittedIds,['new']);
submittedIds=[];runtime.cards=[edited,unknown];await actualCallback('batchImages')();assert.equal(submittedIds.length,0);assert.match(notice,/待确认/u);
runtime.cards=[edited];await actualCallback('startContinuousProduction')();assert.equal(submittedIds.length,0);assert.equal(continuousCalls,0);assert.match(notice,/原生成请求.*核验/u);
runtime.executionMode='chained';await actualCallback('batchImages')();assert.equal(chainedCalls,1);assert.equal(submittedIds.length,0);runtime.executionMode='ordinary';
// The real programmatic guard retains the original request identity and performs no POST.
const guardModule={exports:{}};runInNewContext(compile(pureSource+'\nmodule.exports=()=>{'+uniqueIf(generateNode,'card.imageRetryBlocked')+'};').outputText,{...resultState,module:guardModule,card:edited,setNotice:value=>notice=value,fetch:()=>{submissions++;assert.fail('Completed receipt must never resubmit');}});guardModule.exports();assert.equal(submissions,0);assert.match(notice,/已完成.*不可恢复/u);
// Render the actual JSX text/title expressions, rather than testing copied display strings.
const emptyExpression=nodes.filter(node=>ts.isJsxExpression(node)&&node.expression?.getText(ast).includes('"尚未生成"')).sort((a,b)=>a.getWidth(ast)-b.getWidth(ast))[0].expression.getText(ast);
const imageButton=nodes.find(node=>ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(ast)==='className'&&attr.initializer?.getText(ast)==='"is-command is-image-command"'));
const titleExpression=imageButton.openingElement.attributes.properties.find(attr=>attr.name?.getText(ast)==='title').initializer.expression.getText(ast);
const labelExpression=imageButton.children.find(node=>ts.isJsxExpression(node)&&node.expression?.getText(ast).includes('"结果待确认"')).expression.getText(ast);
for(const [expression,expected]of [[emptyExpression,'已完成·临时图片不可恢复'],[titleExpression,'图片已完成，临时图片不可恢复，已禁止重复提交'],[labelExpression,'图片不可恢复']]){const module={exports:{}};runInNewContext(compile(pureSource+'\nmodule.exports=('+expression+');').outputText,{...resultState,module,card:edited,imageViewOnly:false,isActiveVideoStatus:()=>false,batchMode:'',activeImageSelectionIssue:'',statusText:()=>assert.fail('No active state')});assert.equal(module.exports,expected);}
runtime.cards=[edited,{id:'other',videoStatus:'idle'}];actualCallback('removeCard')('paid');assert.equal(runtime.cards.length,1);assert.equal(runtime.cards[0].id,'other');
// Execute the full actual automatic poll callback with the restored terminal card.
const inspectModule={exports:{}};let statusChecks=0;
runInNewContext(compile(pureSource+'\nmodule.exports='+callback('inspectActiveImages')+';').outputText,{...resultState,module:inspectModule,runRef:{current:{cards:[edited]}},imageSubmissionsRef:{current:new Set()},fetch:()=>{statusChecks++;assert.fail('No completed receipt status GET');}});
await inspectModule.exports();assert.equal(statusChecks,0);assert.equal(submissions,0);

assert.equal(sha(readFileSync(target)),sourceSha256);
console.log(JSON.stringify({...summary, completedTerminalReceipt:true, actualBatchEditDeletePollAndDisplay:true,singlePostAstBinding:true,successAndFailureSinglePost:true,ownerFingerprintInputAndPreflightNoPost:true,actualContinuousTerminalNoDispatch:true,proposedOnly:false,scope:'actual component/shared helper and actual installed browser route callback; mocked dependencies, no browser/provider/DB', redirectAndOnlyOkNegatives:18, liveSameRecordBlobPreserved:true}));
