#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import { main, selfTest, ExposureBudget, assertStableModelId, assertCloneForm, assertCloneEntry,
  assertOnlyAliasDelta, assertWorkspaceOnlyAlias, assertReceiptLedger, activateValidationUI, publishCandidateUI, journalBeforeForward, createCheckpointWriter } from './verify-admin-image-alias-closed-loop-local.mjs';

// Real orchestration functions run against an injected page/response adapter.
// This is not product-browser/runtime evidence and performs no browser/network IO.
async function orchestrationTests() {
  let groups = 0;
  assertStableModelId('pending-cover-model-123-abcdef'); assertStableModelId('gemini-channel-a-async');
  for (const id of ['pm_public_alias', '../bad path', '', 'x'.repeat(201)]) assert.throws(()=>assertStableModelId(id)); groups++;
  const source = { provider:'custom',model_name:'image-model',api_endpoint:'https://fixture.invalid/v1',cost_price:.05,selling_price:.06,supports_image_input:true,sort_order:0,api_protocol_config:{protocol:'images_generations_async',reference_transport:'generations_url_array'} };
  const body = {...source,cost_per_use:.06,admin_notes:''}; delete body.selling_price;
  assertCloneForm(source,body);
  for(const change of [{provider:'other'},{model_name:'other'},{cost_price:0},{cost_per_use:0},{supports_image_input:false},{api_protocol_config:{...source.api_protocol_config,reference_transport:'none'}}]) assert.throws(()=>assertCloneForm(source,{...body,...change})); groups++;
  const complexExtra={resolution_options:['1K','2K'],resolution_prices:{'1K':.06,'2K':.1},submit:{method:'POST',path:'/v1/images'},poll:{interval:3},unknown_future:{nested:[1,true,null]}};
  const complexSource={...source,api_protocol_config:{...source.api_protocol_config,...complexExtra,admin_notes:'operator note',canary_verified:true,verificationNotice:'prior proof',__model_activation_gate:{state:'accepted'}}};
  const complexBody={...body,admin_notes:'operator note',api_protocol_config:{...source.api_protocol_config,...complexExtra}};
  assertCloneForm(complexSource,complexBody);assert.throws(()=>assertCloneForm(complexSource,{...complexBody,api_protocol_config:source.api_protocol_config}));groups++;
  const entry={id:'source',kind:'image',name:'Source',credentialRef:'source-ref',catalogState:'enabled',sortOrder:0,modelName:source.model_name,provider:source.provider,protocol:source.api_protocol_config.protocol,endpoint:source.api_endpoint,capabilities:{supportsImageInput:true,protocol:source.api_protocol_config},pricing:{cost:.05,selling:.06},configuration:{legacyTable:'cover_models',legacyId:'source',protocolConfig:source.api_protocol_config}};
  const alias={...structuredClone(entry),id:'alias',name:'Alias',credentialRef:'alias-ref'};alias.configuration.legacyId='alias';
  assertCloneEntry(entry,alias);
  for(const key of ['provider','protocol','endpoint','pricing','capabilities']) { const changed=structuredClone(alias);changed[key]=key==='pricing'?{cost:0,selling:.06}:key==='capabilities'?{supportsImageInput:false}:'other';assert.throws(()=>assertCloneEntry(entry,changed)); } groups++;
  const notedSource=structuredClone(entry),notedAlias=structuredClone(alias);notedSource.configuration.protocolConfig.admin_notes='same operator note';notedSource.capabilities.protocol.admin_notes='same operator note';notedAlias.configuration.protocolConfig.admin_notes='same operator note';notedAlias.capabilities.protocol.admin_notes='same operator note';assertCloneEntry(notedSource,notedAlias);notedAlias.configuration.protocolConfig.admin_notes='changed note';assert.throws(()=>assertCloneEntry(notedSource,notedAlias));groups++;
  const before={schema:'model-pool-config/v1',models:[entry,{...structuredClone(entry),kind:'agent',name:'Agent same ID'}]};
  const after={...before,models:[...before.models,alias]};assertOnlyAliasDelta(before,after,'alias','create');
  assert.throws(()=>assertOnlyAliasDelta(before,{...after,models:[entry,{...before.models[1],provider:'changed'},alias]},'alias','create'));
  assert.throws(()=>assertOnlyAliasDelta(before,{...after,models:[...after.models,alias]},'alias','create'));groups++;
  const workspace={schema:'workspace-model-config/v1',surfaces:{'image-workbench':{kind:'image',assignedModelIds:[],orderedModelIds:[]}}};
  const workspaceAfter={...workspace,modelPoolRelease:{releaseId:'pool',snapshotSha256:'sha'},surfaces:{'image-workbench':{kind:'image',assignedModelIds:['alias'],orderedModelIds:['alias']}}};
  assertWorkspaceOnlyAlias(workspace,workspaceAfter,'alias',true,{id:'pool',snapshot_sha256:'sha'});
  assert.throws(()=>assertWorkspaceOnlyAlias(workspace,workspaceAfter,'alias',true,{id:'other-pool',snapshot_sha256:'sha'}));groups++;
  assertReceiptLedger([{referenceId:'original-receipt',amount:-.06}],'original-receipt',.06);
  for(const rows of [[{referenceId:'unrelated-same-charge',amount:-.06}],[],[{referenceId:'original-receipt',amount:-.06},{referenceId:'original-receipt',amount:-.06}]]) assert.throws(()=>assertReceiptLedger(rows,'original-receipt',.06));groups++;
  const saved=[];let forwarded=0;
  await journalBeforeForward({journal:saved,event:{phase:'paid-forward',clientIdempotencyKey:'original-request',clientTraceId:'original-trace'},checkpoint:async()=>assert.equal(saved.length,1),forward:async()=>{forwarded++;}});
  await assert.rejects(journalBeforeForward({journal:[],event:{},checkpoint:async()=>{throw new Error('DISK_FAIL');},forward:async()=>{forwarded++;}}));assert.equal(forwarded,1);groups++;
  let opens=0,failForwarded=0;
  const failedWriter=createCheckpointWriter('/RAM/report.json',{open:async()=>{opens++;return {writeFile:async()=>{throw new Error('DISK_FAIL');},sync:async()=>assert.fail('sync after failure'),close:async()=>{}};},rename:async()=>assert.fail('rename after failed write')});
  await assert.rejects(journalBeforeForward({journal:[],event:{requestId:'retained-original'},checkpoint:()=>failedWriter({revision:1}),forward:async()=>{failForwarded++;}}));
  await assert.rejects(failedWriter({revision:2}));assert.equal(opens,1);assert.equal(failForwarded,0);groups++;
  const order=[],commits=[];let releaseWrite;const held=new Promise(resolve=>{releaseWrite=resolve;});
  const serialWriter=createCheckpointWriter('/RAM/report.json',{open:async(_file,flags,mode)=>{assert.equal(flags,'wx');assert.equal(mode,0o600);let revision;return {writeFile:async bytes=>{revision=JSON.parse(bytes).revision;order.push('write'+revision);if(revision===1)await held;},sync:async()=>order.push('sync'+revision),close:async()=>order.push('close'+revision)};},rename:async()=>{commits.push(commits.length+1);order.push('rename'+commits.length);}});
  const first=serialWriter({revision:1}),second=serialWriter({revision:2});await Promise.resolve();await Promise.resolve();assert.deepEqual(order,['write1']);releaseWrite();await Promise.all([first,second]);assert.deepEqual(order,['write1','sync1','close1','rename1','write2','sync2','close2','rename2']);groups++;

  const proof={validationKey:'iav_'+'a'.repeat(64),configurationHash:'b'.repeat(64),epoch:1,clientIdempotencyKey:'original-request',clientTraceId:'original-trace'},recordId='c'.repeat(64);
  const metadata={modelId:'alias',imageRecordId:recordId,proof};
  function activationFixture({wrongResponse=false,wrongProof=false,multipart=false}={}) {
    let polls=0,clicks=0;const events=[];
    const request={postDataJSON(){if(multipart)throw new Error('MULTIPART');return {...metadata,...(wrongProof?{proof:{...proof,epoch:2}}:{})};},headers:()=>({'x-image-publication-request':encodeURIComponent(JSON.stringify(metadata))}),method:()=> 'POST'};
    const response={url:()=> 'http://127.0.0.1:5000/api/admin/cover-models/validation/publish',request:()=>request,ok:()=>true,json:async()=>({success:true,modelId:wrongResponse?'other':'alias',imageRecordId:recordId,assetId:'retained-asset'})};
    const page={waitForResponse:async predicate=>{assert.equal(predicate(response),true);return response;}};
    const dialog={getByRole:()=>({click:async()=>{clicks++;assert.equal(events[0]?.phase,'activation-dispatch');}})};
    const read=async()=>{polls++;return {modelId:'alias',configurationHash:proof.configurationHash,validationKey:proof.validationKey,acceptance:polls===1?'pending':'published',existingAttempt:{imageRecordId:recordId,assetId:'retained-asset',state:polls===1?'completed':'published'}};};
    return {args:{page,dialog,aliasId:'alias',proof,recordId,read,checkpoint:async event=>events.push(event),wait:async()=>{},now:()=>0},stats:()=>({polls,clicks})};
  }
  const activation=activationFixture();await activateValidationUI(activation.args);assert.deepEqual(activation.stats(),{polls:2,clicks:1});groups++;
  for(const changes of [{wrongProof:true},{wrongResponse:true}])await assert.rejects(activateValidationUI(activationFixture(changes).args));groups++;
  await activateValidationUI(activationFixture({multipart:true}).args);groups++;

  function publishFixture({previewDrift=false,currentDrift=false,bodyDrift=false,readbackDrift=false}={}) {
    const expected={id:'base',snapshot_sha256:'d'.repeat(64)},candidate={id:'candidate',snapshot_sha256:'e'.repeat(64),status:'validated'},previewSha='f'.repeat(64);
    let reads=0,submitted=0,waiting;const actions=[],events=[];
    const preview={current:{releaseId:previewDrift?'other':'base',snapshotSha256:expected.snapshot_sha256},candidate:{releaseId:'candidate',snapshotSha256:candidate.snapshot_sha256},previewSha256:previewSha};
    const request={method:()=> 'POST',postDataJSON:()=>({action:'publish',releaseId:'candidate',previewSha256:bodyDrift?'0'.repeat(64):previewSha})};
    const response={url:()=> 'http://127.0.0.1:5000/api/admin/model-pool-releases',request:()=>request,ok:()=>true};
    const previewResponse={url:()=> 'http://127.0.0.1:5000/api/admin/model-pool-releases?previewReleaseId=candidate',request:()=>({method:()=> 'GET'}),ok:()=>true,json:async()=>({preview})};
    const click=async label=>{actions.push(label);if(label==='按预览发布'){submitted++;assert.equal(events.at(-1)?.phase,'publish-dispatch');}};
    const row={isVisible:async()=>true,getByRole:(_role,{name})=>({click:()=>click(name)})};
    const page={getByTestId:()=>({locator:()=>row}),waitForResponse:async predicate=>{const result=waiting?response:previewResponse;waiting=true;assert.equal(predicate(result),true);return result;}};
    const read=async()=>{reads++;return {current:reads===3?{...candidate,id:readbackDrift?'other':'candidate'}:{...expected,id:reads===2&&currentDrift?'other':'base'},releases:[candidate]};};
    return {args:{page,kind:'model-pool',releaseId:'candidate',expectedCurrent:expected,read,checkpoint:async event=>events.push(event)},stats:()=>({submitted,actions,events})};
  }
  const publication=publishFixture();await publishCandidateUI(publication.args);assert.equal(publication.stats().submitted,1);groups++;
  for(const change of [{previewDrift:true},{currentDrift:true}]){const fixture=publishFixture(change);await assert.rejects(publishCandidateUI(fixture.args));assert.equal(fixture.stats().submitted,0);}groups++;
  for(const change of [{bodyDrift:true},{readbackDrift:true}])await assert.rejects(publishCandidateUI(publishFixture(change).args));groups++;
  return groups;
}

const savedFetch = globalThis.fetch, savedConnect = pg.Client.prototype.connect;
const names = ['mkdir', 'writeFile', 'readFile', 'access', 'open', 'rename'];
const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
const calls = { network: 0, database: 0, filesystem: 0 };
globalThis.fetch = async () => { calls.network++; throw new Error('NETWORK_FORBIDDEN'); };
pg.Client.prototype.connect = async function () { calls.database++; throw new Error('DATABASE_FORBIDDEN'); };
for (const name of names) fs[name] = async () => { calls.filesystem++; throw new Error('FILESYSTEM_FORBIDDEN'); };
try {
  assert.equal((await main([])).mode, 'plan');
  assert.equal((await main(['--plan'])).providerCalls, 0);
  await assert.rejects(main(['--execute']));
  await assert.rejects(main(['--plan', '--execute']));
  const result = await selfTest();
  assert.equal(result.success, true);
  const ledger = new ExposureBudget(10);
  ledger.reserve('admin', 5); ledger.unknown('admin');
  assert.equal(ledger.safe().spent + ledger.safe().reserved, 5);
  assert.throws(() => ledger.reserve('customer', .05), /BUDGET_STOPPED_OR_DUPLICATE/u);
  assert.deepEqual(calls, { network: 0, database: 0, filesystem: 0 });
  const uiGroups=await orchestrationTests();
  assert.deepEqual(calls, { network: 0, database: 0, filesystem: 0 });
  console.log(JSON.stringify({ success: true, groups: result.groups + 3 + uiGroups, injectedUiOrchestrationGroups:uiGroups,calls, paidCalls: 0, businessBrowserCalls: 0,
    boundary: 'guard execution and side-effect-free plan only; not actual DB/UI/provider acceptance' }));
} finally {
  globalThis.fetch = savedFetch; pg.Client.prototype.connect = savedConnect;
  for (const name of names) fs[name] = originals[name];
}
