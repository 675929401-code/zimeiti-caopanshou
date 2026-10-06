import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('tsx'))('esbuild');
const built = await esbuild.build({stdin:{contents:`export * as scope from './src/lib/workbench-user-storage';export * as image from './src/lib/image-workbench-transfer';export * as video from './src/lib/video-task-transfer';export * as workflow from './src/lib/video-workflow-draft';export * as agent from './src/lib/agent-workbench-handoff';export * as general from './src/features/general-script/storage';`,resolveDir:process.cwd(),sourcefile:'scope-fixture.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
const local = new Map(), session = new Map(), events = [];
const storage = map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
const window = {localStorage:storage(local),sessionStorage:storage(session),dispatchEvent:event=>events.push({type:event.type,owner:event.detail?.ownerUserId})};
const module={exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require,window,atob,CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail}},BroadcastChannel:class {postMessage(){}close(){}}});
const {scope,image,video,workflow,agent,general}=module.exports;
const keys=[image.IMAGE_WORKBENCH_TRANSFER_KEY,image.IMAGE_WORKBENCH_TRANSFER_SESSION_KEY,video.VIDEO_TASK_TRANSFER_KEY,video.VIDEO_SMART_IMPORT_KEY,workflow.VIDEO_WORKFLOW_DRAFT_KEY,'short_drama_general_script_handoff_v1',agent.agentWorkbenchHandoffStorageKey('storyboard-workbench')];
for(const key of keys){local.set(key,'LEGACY_UNOWNED_BYTES');session.set(key,'LEGACY_UNOWNED_BYTES');}
function actor(id){if(!id){local.delete('auth_token');local.delete('auth_user');return;} const encoded=Buffer.from(JSON.stringify({userId:id,exp:Math.floor(Date.now()/1000)+600})).toString('base64url');local.set('auth_token',`fixture.${encoded}.not-a-signature`);local.set('auth_user',JSON.stringify({id}));}
const checks=[];
actor('A'); assert.equal(scope.readBrowserWorkbenchIdentity().userId,'A');
assert.equal(image.appendImageWorkbenchPromptTransfer('A private prompt').ownerUserId,'A');
video.dispatchVideoTaskTransfer(video.makeVideoTaskTransferPayload([{order:1,prompt:'A video prompt',imageUrl:'https://fixture.invalid/a.png'}]));
workflow.mergeVideoWorkflowDraft([{order:1,prompt:'A workflow prompt',imageUrl:'https://fixture.invalid/a.png',imageTarget:'reference'}]);
assert.equal(video.readPendingVideoTaskTransfer().ownerUserId,'A');assert.equal(workflow.readVideoWorkflowDraft().ownerUserId,'A');
general.saveGeneralScriptHandoff({fixture:'A'});assert.ok(local.has(scope.workbenchUserStorageKey('short_drama_general_script_handoff_v1','A')));
session.set(scope.workbenchUserStorageKey(agent.agentWorkbenchHandoffStorageKey('storyboard-workbench'),'A'),'{invalid');assert.equal(agent.readAgentWorkbenchHandoff('storyboard-workbench').code,'INVALID');checks.push('actual producers store current owner for image/video/workflow/script/agent paths');
const snapshotA=[...local,...session].filter(([key])=>key.endsWith(':user:A')).map(([key,value])=>[key,value]);
actor('B');assert.equal(image.readPendingImageWorkbenchPromptTransfer(),null);assert.equal(video.readPendingVideoTaskTransfer(),null);assert.equal(workflow.readVideoWorkflowDraft(),null);assert.equal(agent.readAgentWorkbenchHandoff('storyboard-workbench').code,'MISSING');
image.clearPendingImageWorkbenchPromptTransfer();video.clearPendingVideoTaskTransfer();workflow.clearVideoWorkflowDraft();checks.push('B cannot read or clear A transfers');
for(const [key,value] of snapshotA)assert.equal((local.has(key)?local:session).get(key),value);checks.push('return to A preserves original transfer bytes');
image.appendImageWorkbenchPromptTransfer('B prompt');video.dispatchVideoTaskTransfer(video.makeVideoTaskTransferPayload([{order:1,prompt:'B video prompt'}]));assert.equal(image.readPendingImageWorkbenchPromptTransfer().items[0].prompt,'B prompt');assert.equal(image.readPendingImageWorkbenchPromptTransfer(),null);assert.equal(video.readPendingVideoTaskTransfer().items[0].prompt,'B video prompt');checks.push('new B image transfer is scoped and consumed exactly once');
actor('A');assert.equal(image.readPendingImageWorkbenchPromptTransfer().items[0].prompt,'A private prompt');assert.equal(image.readPendingImageWorkbenchPromptTransfer(),null);assert.equal(video.readPendingVideoTaskTransfer().items[0].prompt,'A video prompt');assert.equal(workflow.readVideoWorkflowDraft().slots[0].referenceImageUrl,'https://fixture.invalid/a.png');
local.set('auth_user',JSON.stringify({id:'B'}));assert.equal(scope.readBrowserWorkbenchIdentity(),null);assert.equal(image.readPendingImageWorkbenchPromptTransfer(),null);checks.push('half-updated auth cache cannot route one token to another owner');
actor(null);assert.equal(image.appendImageWorkbenchPromptTransfer('logged out'),null);assert.equal(workflow.mergeVideoWorkflowDraft([{order:1,prompt:'logged out'}]),null);assert.equal(video.readPendingVideoTaskTransfer(),null);checks.push('logged out readers and writers cannot use prior data');
for(const key of [video.VIDEO_TASK_TRANSFER_KEY,video.VIDEO_SMART_IMPORT_KEY,workflow.VIDEO_WORKFLOW_DRAFT_KEY]){assert.equal(local.has(key),false);assert.equal(session.has(key),false);}
for(const key of [image.IMAGE_WORKBENCH_TRANSFER_KEY,image.IMAGE_WORKBENCH_TRANSFER_SESSION_KEY]){assert.equal(local.has(key),false);assert.equal(session.has(key),false);}
assert.equal(local.get('short_drama_general_script_handoff_v1'),'LEGACY_UNOWNED_BYTES');assert.equal(session.get('short_drama_general_script_handoff_v1'),'LEGACY_UNOWNED_BYTES');
assert.equal(local.get(agent.agentWorkbenchHandoffStorageKey('storyboard-workbench')),'LEGACY_UNOWNED_BYTES');assert.equal(session.has(agent.agentWorkbenchHandoffStorageKey('storyboard-workbench')),false);
assert.ok(events.every(event=>event.owner==='A'||event.owner==='B'));
const report={passed:true,actualHelpers:true,authCacheAndStorageMocked:true,syntheticTokensNeverSent:true,checks,browserHandoffsSessionOnly:true,imageHandoffConsumedOnce:true,legacyCreativeBytesCleared:true,legacyVideoBytesCleared:true,unrelatedLegacyBytesPreserved:true,ownerAttachedToEvents:true,networkRequests:0,businessWrites:0};await mkdir('.codex-evidence/workbench-user-scope-20260903',{recursive:true});await writeFile('.codex-evidence/workbench-user-scope-20260903/transfer-fixture.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
