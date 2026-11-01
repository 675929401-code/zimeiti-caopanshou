#!/usr/bin/env node
// The authenticated actor, persisted rows, settings DB and provider transport are RAM fixtures.
// Production save handlers, prefix consumer/composer/request serializer and Coze helpers execute unmodified.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';

import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
const outputArgs = process.argv.slice(2);
assert.ok(outputArgs.every(value => value.startsWith('--output-dir=')), 'UNSUPPORTED_EVIDENCE_ARGUMENT');
const outputOptions = outputArgs.filter(value => value.startsWith('--output-dir='));
assert.ok(outputOptions.length <= 1, 'ONE_OUTPUT_DIRECTORY_REQUIRED');
assert.ok(!outputOptions.length || outputOptions[0].length > '--output-dir='.length, 'OUTPUT_DIRECTORY_REQUIRED');
const evidenceRoot = path.resolve('.codex-evidence');
const outputDirectory = path.resolve(outputOptions[0]?.slice('--output-dir='.length) || `.codex-evidence/platform-settings-user-requests/run-${randomUUID()}`);
const outputRelative = path.relative(evidenceRoot, outputDirectory);
assert.ok(outputRelative && outputRelative !== '..' && !outputRelative.startsWith('..' + path.sep) && !path.isAbsolute(outputRelative), 'OUTPUT_MUST_STAY_INSIDE_IGNORED_EVIDENCE');
// Match the existing unique-run evidence convention; reject path aliases before any test runs.
let outputAncestor = path.parse(outputDirectory).root;
for (const part of path.relative(outputAncestor, path.dirname(outputDirectory)).split(path.sep).filter(Boolean)) {
  outputAncestor = path.join(outputAncestor, part);
  try { mkdirSync(outputAncestor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const metadata = lstatSync(outputAncestor);
  assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink() && path.relative(outputAncestor, realpathSync.native(outputAncestor)) === '', 'OUTPUT_ANCESTOR_MUST_BE_PHYSICAL_DIRECTORY');
}
try { mkdirSync(outputDirectory); } catch (error) { if (error.code === 'EEXIST') throw Error('EVIDENCE_RUN_DIRECTORY_EXISTS:' + outputDirectory); throw error; }
const {createHarness} = await import("./verify-platform-settings-runtime-consumers-zero-network.mjs");
const {load,setOfflineFetch} = await import("./fixtures/platform-settings-llm-vm.mjs");
const core=load('src/lib/server/llm-standard-request-preparation.ts');
const {LLMProxy}=load('src/lib/llm-proxy/proxy.ts');
const checks=[], captures=[];
const providerFetch=async(url,request={})=>{
 const u=new URL(url);assert.ok(u.hostname.endsWith('.invalid'),'only reserved fixture hosts allowed');
 captures.push({url:String(url),method:request.method||'GET',body:request.body?JSON.parse(request.body):null});
 return Response.json(u.pathname.endsWith('/chat/completions')?{choices:[{message:{role:'assistant',content:'RAM reply'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}}:{code:0,data:{space_bots:[]}});
};
setOfflineFetch(providerFetch);
const actorId='ordinary-consumer-fixture';
const body={agentId:'ordinary-agent-fixture',messages:[{role:'system',content:'Untrusted client system'},{role:'user',content:'A bounded ordinary user request.'}]};
const agent={id:body.agentId,name:'Fixture agent',source:'llm',is_active:true,system_prompt:'Controlled fixture. 输出规范：plain.',temperature:0.5,max_reply_tokens:256,max_context_rounds:6,max_context_tokens:2000,deep_thinking_type:0,enable_web_search:false};
const model={id:'fixture-model',model_name:'fixture-provider-model',max_reply_tokens:256};
const proxy=new LLMProxy({apiBase:'https://llm.fixture.invalid',apiKey:'ram-api-key',protocol:'openai_chat',retryCount:0});
for(const surface of ['admin','legacy']){
 const h=createHarness({upstreamFetch:providerFetch});
 const initial=Object.fromEntries([...h.rows].map(([key,row])=>[key,row.setting_value]));
 const b={global_system_prefix:'fixture-prefix-b',coze_api_base_url:'https://coze-b.invalid',coze_api_token:'fixture-token-b',coze_workspace_id:'fixture-space-b'};
 for(const [phase,values] of [['A',initial],['B',b],['A-restored',initial]]){
  if(phase!=='A')assert.equal((await h.save(surface,Object.fromEntries(Object.keys(b).map(key=>[key,values[key]])))).status,200);
  const prefix=await h.prefix.getGlobalSystemPrefix(h.dbFor('consumer'));
  assert.equal(prefix,values.global_system_prefix);
  const parameters=core.resolveLinkedModelRuntime(body,agent,model);
  const composed=await core.composeLlmRequestMessages({...parameters,agentId:agent.id,agentName:agent.name,agentRow:agent,mangaSkillOrchestration:null,isCanvasInternalWorkflow:false,verifiedUserId:actorId,body,globalPrefix:prefix,messages:body.messages,useModel:model.model_name,loadProfileContext:async()=>'',loadSkills:async()=>null});
  const request=core.buildLlmChatRequest(model.model_name,composed.finalMessages,parameters,false);
  const before=captures.length;await proxy.chat(request);assert.equal(captures.length,before+1,'exactly one mock provider request');
  const sent=captures.at(-1).body,systems=sent.messages.filter(message=>message.role==='system');
  assert.equal(systems.length,1);assert.equal(systems[0].content.split(prefix).length-1,1,'new prefix appears exactly once in actual HTTP system message');
  assert.ok(!systems[0].content.includes('Untrusted client system'),'client system prompt is filtered');
  assert.equal(sent.messages.at(-1).content,body.messages.at(-1).content);
  checks.push(`${surface}/${phase}: production prefix->composer->HTTP request system exactly once`);
  await h.coze.listBots();const list=captures.at(-1);assert.equal(new URL(list.url).origin,values.coze_api_base_url);assert.equal(new URL(list.url).searchParams.get('workspace_id'),values.coze_workspace_id);
  await h.coze.streamChat('fixture-bot',actorId,'Ordinary Coze fixture request');const chat=captures.at(-1);assert.equal(chat.url,values.coze_api_base_url+'/v3/chat');assert.equal(chat.body.user_id,actorId);assert.equal(chat.body.bot_id,'fixture-bot');assert.equal(chat.body.additional_messages[0].content,'Ordinary Coze fixture request');
  checks.push(`${surface}/${phase}: production Coze listBots workspace and streamChat URL/message`);
 }
 assert.equal(h.state.networkAttempts,0);assert.equal(h.state.mails.length,0,'no SMTP triggered in these new scenarios');
}
const files=['src/app/api/settings/admin/route.ts','src/app/api/settings/route.ts','src/app/api/llm/llm-state.ts','src/lib/server/llm-standard-request-preparation.ts','src/lib/llm-proxy/proxy.ts','src/lib/coze-api.ts'];
const report={passed:true,checks,actualProductionEntries:files,upstreamCaptures:captures.map(x=>({url:x.url,method:x.method,messageCount:x.body?.messages?.length||x.body?.additional_messages?.length||0})),realNetworkCalls:0,realDatabaseCalls:0,realPaidCalls:0,realSmtpCalls:0,limits:['Authenticated actor and persisted agent/DB rows are RAM fixtures.','Actual /api/llm and /api/chat HTTP handlers, authentication, reservations and billing settlement are not executed.','Coze workspace is verified on production listBots; streamChat does not serialize workspace_id.','Provider replies are mock data, not semantic model or real media acceptance.'],sha256:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))};
report.outputDirectory=outputDirectory;writeFileSync(path.join(outputDirectory,'prefix-coze-production-request.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
