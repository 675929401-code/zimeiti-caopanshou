#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript'), root=path.resolve('');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const checks=[]; const effects={database:0,provider:0,reserve:0,search:0,secret:0};
const forbidden=()=>{effects.database++;throw new Error('OFFLINE_EFFECT_FORBIDDEN');};
let rpcAdapter, readonlyAdapter;
const cache=new Map();
function load(relative) {
  const absolute=path.resolve(root,relative); if(cache.has(absolute))return cache.get(absolute).exports;
  if(absolute.endsWith('.json'))return JSON.parse(fs.readFileSync(absolute,'utf8'));
  const module={exports:{}};cache.set(absolute,module);
  let source=fs.readFileSync(absolute,'utf8');
  if(relative.endsWith('quote-llm-standard-request-readonly.ts')) {
    source=source.replace('path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")',JSON.stringify(root));
    source=source.slice(0,source.indexOf('if (process.argv[1]'));
  }
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const customRequire=specifier=>{
    if(specifier==='@/storage/database/supabase-client')return {getSupabaseAdminClient:()=>rpcAdapter||readonlyAdapter?{rpc:rpcAdapter,from:readonlyAdapter}:forbidden(),getSupabaseClient:forbidden};
    if(specifier==='./db' && path.basename(absolute)==='billing.ts')return {getDb:forbidden};
    if(specifier.startsWith('node:'))return require(specifier);
    if(!specifier.startsWith('@/') && !specifier.startsWith('.'))return require(specifier);
    let target=specifier.startsWith('@/')?path.join(root,'src',specifier.slice(2)):path.resolve(path.dirname(absolute),specifier);
    if(!path.extname(target))target+='.ts';
    return load(path.relative(root,target));
  };
  vm.runInNewContext(compiled,{module,exports:module.exports,require:customRequire,__dirname:path.dirname(absolute),Buffer,URL,Response,Headers,console:{log(){},warn(){}},process:{argv:[],env:{}},setTimeout,clearTimeout},{filename:absolute});
  return module.exports;
}
const core=load('src/lib/server/llm-standard-request-preparation.ts'), cli=load('scripts/quote-llm-standard-request-readonly.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
function check(name,actual,expected=true){assert.deepEqual(plain(actual),plain(expected),name);checks.push(name);}
async function rejects(name,callback){await assert.rejects(callback);checks.push(name);}
const actor='ordinary-fixture',agentId='ordinary-marketplace-fixture';
const base={actor:{id:actor,is_active:true,status:'active',role:'student'},agent:{id:agentId,name:'Fixture director',source:'llm',is_active:true,model_id:'linked',model:'unrelated-legacy',system_prompt:'Controlled RAM authority fixture. 输出规范: plain.',config_revision:2,temperature:0,max_reply_tokens:1200,max_context_rounds:0,max_context_tokens:0},
  model:{id:'linked',name:'Fixture',model_name:'linked-provider-model',is_active:true,is_hidden:false,token_billing_enabled:true,input_cost_per_million:2,output_cost_per_million:8,cached_cost_per_million:4,profit_margin:20,token_rounding_unit:100,temperature:0.8,max_reply_tokens:4000,max_context_rounds:6,max_context_tokens:8000,deep_thinking_type:0,enable_web_search:false},
  settings:[{setting_key:'credits_per_yuan',setting_value:'50'},{setting_key:'global_system_prefix',setting_value:'Controlled RAM presentation.'}],skills:[],readsVerified:true};
const body={agentId,agentName:base.agent.name,messages:[{role:'system',content:'Untrusted client system'},{role:'user',content:'A bounded test sample.'}],stream:true,maxReplyTokens:10000,conversationId:'conversation_fixture',client_request_id:'llm_fixture_123'};
const pins={sourceVersion:'R_FIXTURE',buildId:'BUILD_FIXTURE'},publicId='pm_fixture';
const prepared=await core.prepareStandardLlmRequest(body,base,actor,publicId,pins);
// Execute the actual shared composer; these assertions concern submitted
// system-policy composition, not paid-model semantic compliance or outputs.
async function composeIdentityFixture(overrides={}) {
  const row=overrides.agentRow===undefined?structuredClone(base.agent):overrides.agentRow;
  return core.composeLlmRequestMessages({...core.resolveLinkedModelRuntime(body,base.agent,base.model),
    agentId,agentName:'伪造客户端名称',agentRow:row,mangaSkillOrchestration:null,
    isCanvasInternalWorkflow:false,verifiedUserId:actor,body,globalPrefix:'你是通用助手。仅作呈现规则。',
    messages:[{role:'user',content:'你是谁？'}],useModel:base.model.model_name,
    loadProfileContext:async()=>'',loadSkills:async()=>null,...overrides});
}
const identityComposed=await composeIdentityFixture();
check('actual composer uses current persisted name for platform introduction',identityComposed.effectiveSystemPrompt.includes('回答第一句必须逐字为：我是安哥训练的Fixture director智能体。'));
check('actual branded composer uses a conditional business introduction without technical identity replacement',identityComposed.effectiveSystemPrompt.includes('按下方平台业务介绍规则回答，再介绍') && identityComposed.effectiveSystemPrompt.includes('普通业务任务时，直接完成任务及其必要步骤，不先讨论身份') && !identityComposed.effectiveSystemPrompt.includes('你当前且唯一的身份'));
check('actual composer cannot brand with forged request name',identityComposed.effectiveSystemPrompt.includes('伪造客户端名称'),false);
check('actual composer wraps exactly one final system prompt',identityComposed.finalMessages.filter(message=>message.role==='system').length,1);
for(const [name,overrides] of [
  ['renamed persisted row',{agentRow:{...base.agent,name:'新版创作智能体'}}],
  ['manga persisted row name',{agentRow:{...base.agent,name:'持久化漫剧导演'},mangaSkillOrchestration:{systemPrompt:'漫剧已发布专属工作流。'}}],
]) {
  const result=await composeIdentityFixture(overrides),expected=name.startsWith('renamed')?'我是安哥训练的新版创作智能体。':'我是安哥训练的持久化漫剧导演智能体。';
  check(name+' uses authoritative introduction',result.effectiveSystemPrompt.includes(expected));
  check(name+' no repeated 智能体 suffix',result.effectiveSystemPrompt.includes('智能体智能体'),false);
}
for(const [name,overrides] of [
  ['free chat',{agentId:'__free_chat__',agentRow:null}],
  ['mismatched row',{agentRow:{...base.agent,id:'different-saved-agent'}}],
  ['external Coze row',{agentRow:{...base.agent,source:'coze'}}],
  ['canvas internal workflow',{isCanvasInternalWorkflow:true}],
  ['missing persisted name',{agentRow:{...base.agent,name:''}}],
]) {
  const result=await composeIdentityFixture(overrides);
  check(name+' has no platform brand grant',result.effectiveSystemPrompt.includes('安哥训练的'),false);
  check(name+' preserves unbranded business responsibility',result.effectiveSystemPrompt.includes('当用户询问当前业务智能体的名称、用途、能力或如何开始时，介绍') && result.effectiveSystemPrompt.includes('正常任务不重复职责说明'));
}
const longSavedWorkflow='专属职责。'.repeat(10000);
const longIdentity=await composeIdentityFixture({agentRow:{...base.agent,name:'长提示词导演',system_prompt:longSavedWorkflow}});
check('long prompt has business responsibilities at head and a task delivery reminder at tail',longIdentity.effectiveSystemPrompt.startsWith('【当前业务职责】\n本次任务对应的智能体名称是「长提示词导演」。') && longIdentity.effectiveSystemPrompt.endsWith('【任务交付提醒】\n按「长提示词导演」的专业领域与既定流程完成本轮请求，保留所需选择步骤和输出协议；普通任务直接交付，不重复职责或身份说明。'));
check('long prompt keeps one conditional branded introduction before the saved workflow',longIdentity.effectiveSystemPrompt.indexOf('回答第一句必须逐字为：我是安哥训练的长提示词导演智能体。')<longIdentity.effectiveSystemPrompt.indexOf(longSavedWorkflow) && longIdentity.effectiveSystemPrompt.indexOf(longSavedWorkflow)>0 && longIdentity.effectiveSystemPrompt.split('我是安哥训练的长提示词导演智能体。').length-1===1);
check('long prompt cannot repeat a competing branded receipt tail',longIdentity.effectiveSystemPrompt.includes('固定第一句仍为：'),false);
for(const userText of ['A','写一条宠物口播稿。','对话引用：“你是谁？”请继续写故事。','帮我写自我介绍。','你是谁？再写一条口播稿。','你是谁，我需要提供什么信息给你？','原文已经给你，下一步怎么开始？','你使用的底层模型由谁开发？']) {
  const result=await composeIdentityFixture({messages:[{role:'user',content:userText}]});
  check('actual composer preserves user task '+userText,result.finalMessages.filter(message=>message.role!=='system'),[{role:'user',content:userText}]);
  check('actual composer identity policy distinguishes creation and mixed tasks '+userText,result.effectiveSystemPrompt.includes('都不因此插入品牌介绍') && result.effectiveSystemPrompt.includes('先给这一句，再继续完成任务'));
}
check('product introduction is brief and asks only the first missing input',identityComposed.effectiveSystemPrompt.includes('首句后用一两句按专属设定说明能做什么、如何开始，只索取当前第一步尚缺的最少资料'));
check('existing material and workflow are reused rather than requested again',identityComposed.effectiveSystemPrompt.includes('用户已提供的原文或资料直接使用，不再索取') && identityComposed.effectiveSystemPrompt.includes('不新增必填项或选择步骤，不重复整套问卷'));
check('ordinary who-and-how questions default to product use',identityComposed.effectiveSystemPrompt.includes('这类日常问句默认介绍当前智能体的产品用途'));
check('technical facts have a single explicit-question exception scoped to identity questions',identityComposed.effectiveSystemPrompt.includes('回答身份或来源问题时，只有用户明确询问底层模型或开发方，才简短说明可核实的技术事实，不编造来源') && (identityComposed.effectiveSystemPrompt.match(/底层模型/g)||[]).length===1 && !identityComposed.effectiveSystemPrompt.includes('其他时候只介绍当前产品用途'));
check('existing source is acknowledged before asking for the pending workflow choice',identityComposed.effectiveSystemPrompt.includes('已收到原稿时明确告诉用户原稿已收到，再说明既有流程当前尚需的选择'));
for(const responseFormat of ['markdown','text','json_object']) {
  const result=await composeIdentityFixture({agentResponseFormat:responseFormat,agentRow:{...base.agent,system_prompt:'专属工作流。输出格式：必须保留 A、B、C 的三个选择步骤。'}});
  check(responseFormat+' retains custom workflow',result.effectiveSystemPrompt.includes('必须保留 A、B、C 的三个选择步骤。'));
  check(responseFormat+' menu presentation exception contract',result.effectiveSystemPrompt.includes('【自然语言交互菜单呈现规则】'),responseFormat!=='json_object');
  if(responseFormat==='text')check('text no longer blanket bans all menu markup',result.effectiveSystemPrompt.includes('不要使用 Markdown 排版语法'),false);
  if(responseFormat==='json_object')check('JSON identity cannot prepend prose or change machine schema',result.effectiveSystemPrompt.includes('不得在协议外追加身份句、擅自新增字段或破坏结构'));
}
const defaultTextMenu=await composeIdentityFixture({agentResponseFormat:'text',agentRow:{...base.agent,system_prompt:'先给选择菜单，再等用户选择。'}});
check('default text constrains ordinary body while allowing menu emphasis',defaultTextMenu.effectiveSystemPrompt.includes('普通正文使用纯文本格式输出；仅自然语言交互菜单可按平台菜单呈现规则适度强调重点'));
const strictText=await composeIdentityFixture({agentResponseFormat:'text',agentRow:{...base.agent,system_prompt:'输出格式：严格纯文本，禁止 Markdown。'},messages:[{role:'user',content:'请用纯文本，不要加粗。'}]});
check('explicit private strict format and user pure text retained',strictText.effectiveSystemPrompt.includes('输出格式：严格纯文本，禁止 Markdown。') && strictText.effectiveSystemPrompt.includes('用户明确要求本轮纯文本、不加格式时优先') && strictText.effectiveSystemPrompt.includes('专属设定明确要求严格纯文本、禁止 Markdown 或固定机器格式时优先'));
for (const directorId of ['agent-1786843330392-emdjv2','agent-1786633444187-594spj']) {
  const director=structuredClone(base);director.agent.id=directorId;director.agent.config_revision=200;
  director.model.deep_thinking_type=1;director.model.enable_web_search=true;
  director.skills=[{id:'unused-media-tool',tool_definition:{type:'function',function:{name:'generate_image'}}}];
  const sample={...body,agentId:directorId,messages:[{role:'user',content:'请搜索这个故事作为画面，不要改写文案。'}],enable_web_search:true,enable_web_search_overridden:true,deep_thinking_type:1,deep_thinking_overridden:true};
  const result=await core.prepareStandardLlmRequest(sample,director,actor,publicId,pins);
  check(directorId+' selected dialogue model retained',result.chatRequest.model,director.model.model_name);
  check(directorId+' search disabled',result.parameters.agentEnableWebSearch,false);
  check(directorId+' no multistage model calls',result.parameters.agentDeepThinkingType,0);
  check(directorId+' tools excluded',Boolean(result.chatRequest.tools),false);
  check(directorId+' prompt stays in saved authority',result.chatRequest.messages[0].content.includes(director.agent.system_prompt));
  check(directorId+' no director HOST injected',/HOST_(?:TEXT_CASTING|ASSETS|DIRECTOR|NARRATION)/u.test(result.chatRequest.messages[0].content),false);
  check(directorId+' explicit tools cannot enter request',Boolean(core.buildLlmChatRequest('model',[],result.parameters,true,[{type:'function'}]).tools),false);
}
for (const role of ['student','admin']) {
  const pending=structuredClone(base);pending.actor.role=role;pending.model.user_access='pending_model_activation';
  assert.throws(()=>core.assertStandardQuoteEligibility(body,pending,actor));
  checks.push('pending model quote rejected for '+role);
}
check('agent zero temperature preserved',prepared.chatRequest.temperature,0);
check('agent positive reply limit preserved',prepared.chatRequest.max_tokens,1200);
check('context zero survives linked preset',prepared.parameters.agentMaxContextTokens,0);
const historyFixture=structuredClone(base);historyFixture.agent.max_context_rounds=1;historyFixture.model.max_context_rounds=1;historyFixture.agent.response_format='json_object';historyFixture.model.response_format='json_object';
const historicalBody={...body,messages:[{role:'user',content:'old user'},{role:'assistant',content:'old answer'},{role:'user',content:'current user'},{role:'assistant',content:'current answer'}]};
const historical=await core.prepareStandardLlmRequest(historicalBody,historyFixture,actor,publicId,pins);
check('actual history trimming retains latest configured round',historical.chatRequest.messages.slice(1).map(m=>m.content),['current user','current answer']);
check('actual JSON response format retained',historical.chatRequest.response_format,{type:'json_object'});
check('client system authority removed',JSON.stringify(prepared.chatRequest).includes('Untrusted client system'),false);
check('server authority retained',JSON.stringify(prepared.chatRequest).includes(base.agent.system_prompt));
check('presentation appended before identity suffix',prepared.chatRequest.messages[0].content.includes('Controlled RAM presentation.'));
check('reservation is actual unchanged calculator',prepared.reservation,load('src/lib/llm-credit-reservation.ts').quoteLlmStreamReservation(prepared.chatRequest,prepared.billing.config,1));
check('cached input maximum used',prepared.reservation.inputBudget>8192);
check('price conversion explicit',prepared.platformReservationYuanEquivalent,prepared.reservation.amount/50);
for(const reply of [0,null]) {const fixture=structuredClone(base);fixture.agent.max_reply_tokens=reply;const result=await core.prepareStandardLlmRequest(body,fixture,actor,publicId,pins);
  check('agent reply '+reply+' existing semantics',result.chatRequest.max_tokens,reply===0?10000:4000);}
const native=structuredClone(base);native.model.deep_thinking_type=2;native.model.deduct_deep_think=1.5;
const nativeResult=await core.prepareStandardLlmRequest(body,native,actor,publicId,pins);check('native thinking actual multiplier',nativeResult.reservation.outputBudget,1800);
const zero=structuredClone(base);for(const key of ['input_cost_per_million','output_cost_per_million','cached_cost_per_million'])zero.model[key]=0;
check('zero price preserved', (await core.prepareStandardLlmRequest(body,zero,actor,publicId,pins)).reservation.amount,0);
function reader(fixture=base){return {readAgent:async()=>[fixture.agent],readModel:async()=>[fixture.model],readSettings:async()=>fixture.settings,readActor:async()=>[fixture.actor],readSkills:async()=>fixture.skills};}
for(const state of ['cold','warm']) {const snapshot=await core.readStandardSnapshot(reader(),actor,agentId);const result=await core.prepareStandardLlmRequest(body,snapshot,actor,publicId,pins);
  check(state+' strict reader shared request parity',result.chatRequest,prepared.chatRequest);check(state+' quote parity',result.reservation,prepared.reservation);}
for(const [name,mutate] of [
  ['active skill without tools',s=>s.skills=[{id:'active',tool_definition:null}]],
  ['search configured',s=>s.model.enable_web_search=true],['type1 thinking',s=>s.model.deep_thinking_type=1],
  ['invalid revision',s=>s.agent.config_revision=0],['wrong linked id',s=>s.model.id='different'],
  ['invalid model price',s=>s.model.profit_margin=100],['invalid conversion',s=>s.settings.push({setting_key:'credits_per_yuan',setting_value:'0'})],
  ['unknown role',s=>s.actor.role='superadmin'],['unknown read provenance',s=>s.readsVerified=false],
]) {const fixture=structuredClone(base);mutate(fixture);await rejects(name,()=>core.prepareStandardLlmRequest(body,fixture,actor,publicId,pins));}
await rejects('semantic search before any provider',()=>core.prepareStandardLlmRequest({...body,messages:[{role:'user',content:'请联网搜索最新情况'}]},base,actor,publicId,pins));
await rejects('multimodal refused',()=>core.prepareStandardLlmRequest({...body,messages:[{role:'user',content:[{type:'text',text:'test'}]}]},base,actor,publicId,pins));
await rejects('hidden request fields refused',()=>core.prepareStandardLlmRequest({...body,internal_workflow:'canvas-compiler'},base,actor,publicId,pins));
await rejects('strict skills read failure never treated cached empty',()=>core.readStandardSnapshot({...reader(),readSkills:async()=>{throw Error('secret raw DB error');}},actor,agentId));
core.assertQuoteExpectation(prepared.expectation,prepared.expectation);check('same expectation accepted',true);
for(const [name,mutate] of [
  ['revision',s=>s.agent.config_revision++],['base',s=>s.agent.system_prompt+=' change'],['global prefix',s=>s.settings[1].setting_value+=' change'],
  ['model temperature',s=>s.agent.temperature=0.2],['price',s=>s.model.output_cost_per_million++],
]){const fixture=structuredClone(base);mutate(fixture);const changed=await core.prepareStandardLlmRequest(body,fixture,actor,publicId,pins);
  assert.throws(()=>core.assertQuoteExpectation(prepared.expectation,changed.expectation));checks.push(name+' snapshot drift rejected');}
const changedMessage=await core.prepareStandardLlmRequest({...body,messages:[{role:'user',content:'Changed answer request'}]},base,actor,publicId,pins);
assert.throws(()=>core.assertQuoteExpectation(prepared.expectation,changedMessage.expectation));checks.push('composed messages drift rejected');
let readonlyEffects=0;check('actual CLI default plan', (await cli.runQuoteCli([],{readonly:()=>{readonlyEffects++;throw Error('forbidden');}})).connections,0);
check('plan no credential or connection port',readonlyEffects,0);
const connectionOptions={'expected-database':'fixture','expected-port':'54322'};
check('verified loopback connection accepted',cli.validateQuoteConnection('postgres://user:password@127.0.0.1:54322/fixture',connectionOptions,{}),'postgres://user:password@127.0.0.1:54322/fixture');
for(const value of ['postgres://user:password@example.com:54322/fixture','postgres://user:password@127.0.0.1:54322/other','postgres://user:password@127.0.0.1:54322/fixture?options=-csearch_path=evil']) {assert.throws(()=>cli.validateQuoteConnection(value,connectionOptions,{}));checks.push('unsafe connection rejected '+checks.length);}
assert.throws(()=>cli.validateQuoteConnection('postgres://user:password@127.0.0.1:54322/fixture',connectionOptions,{PGHOST:'evil'}));checks.push('unsafe PG env rejected');
const calls=[];let closed=0;const fakeClient={query:async(sql,args)=>{calls.push([sql,args]);return {rows:[]};},end:async()=>{closed++;}};
await rejects('transaction identity failure rolls back',()=>cli.readQuoteTransaction(fakeClient,{'expected-identity':'expected'},body,{readIdentity:async()=>({fingerprint:'different'})}));
check('actual transaction readonly first',calls[0][0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');check('failure rollback',calls.at(-1)[0],'ROLLBACK');check('failure connection closed',closed,1);
const goodCalls=[];const goodClient={query:async(sql,args)=>{goodCalls.push([sql,args]);if(sql.includes('public.agents'))return {rows:[base.agent]};if(sql.includes('public.llm_models'))return {rows:[base.model]};if(sql.includes('public.platform_settings'))return {rows:base.settings};if(sql.includes('public.users'))return {rows:[base.actor]};return {rows:[]};},end:async()=>{}};
let ticks=0;const deadlineCalls=[];let deadlineClosed=0;
await rejects('actual CLI overall deadline refuses further SELECT',()=>cli.readQuoteTransaction({query:async sql=>{deadlineCalls.push(sql);return {rows:[]};},end:async()=>{deadlineClosed++;}}, {},body,{now:()=>ticks++===0?0:20001}));
check('deadline only cleanup query permitted',deadlineCalls,['ROLLBACK']);check('deadline connection closed',deadlineClosed,1);
const receipt=await cli.readQuoteTransaction(goodClient,{'expected-identity':'verified','actor-id':actor,'public-model-id':publicId,'expected-source-version':pins.sourceVersion,'expected-build-id':pins.buildId,case:'long-list'},body,
  {readIdentity:async()=>({fingerprint:'verified'}),readSnapshot:core.readStandardSnapshot,prepare:core.prepareStandardLlmRequest,settingKeys:core.STANDARD_SETTING_KEYS,readPins:async()=>pins});
check('actual transaction only readonly/setup/select/rollback',goodCalls.every(([sql])=>/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL |SELECT |ROLLBACK)/u.test(sql)));
check('metadata-only receipt no original prompt',JSON.stringify(receipt).includes(base.agent.system_prompt),false);
check('metadata-only receipt no user prompt',JSON.stringify(receipt).includes(body.messages[1].content),false);
check('receipt platform amount',receipt.platformReservationCredits,prepared.reservation.amount);check('invoice explicitly unknown',receipt.providerInvoiceUpperBound,null);

// Exercise pg SELECT rows through the actual readonly adapter and shared preparation.
const pgAgentNumeric=['config_revision','deep_thinking_type','deduct_deep_think','max_context_rounds','max_context_tokens','max_reply_tokens','timeout','temperature'];
const pgModelNumeric=[...pgAgentNumeric.filter(key=>key!=='config_revision'),'input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin','token_rounding_unit'];
const numericOptions={'expected-identity':'verified','actor-id':actor,'public-model-id':publicId,'expected-source-version':pins.sourceVersion,'expected-build-id':pins.buildId,case:'long-list'};
function numericTransaction(fixture,observe={}) {
  const queries=[];let closed=0;
  const client={query:async(sql,args)=>{queries.push([sql,args]);return {rows:sql.includes('public.agents')?[fixture.agent]:sql.includes('public.llm_models')?[fixture.model]:sql.includes('public.platform_settings')?fixture.settings:sql.includes('public.users')?[fixture.actor]:[]};},end:async()=>{closed++;}};
  return {queries,closed:()=>closed,run:()=>cli.readQuoteTransaction(client,numericOptions,body,{readIdentity:async()=>({fingerprint:'verified'}),settingKeys:core.STANDARD_SETTING_KEYS,readPins:async()=>pins,
    readSnapshot:async(...args)=>{const snapshot=await core.readStandardSnapshot(...args);observe.snapshot=snapshot;return snapshot;},
    prepare:async(...args)=>{const result=await core.prepareStandardLlmRequest(...args);observe.prepared=result;return result;}})};
}
for(const multiplier of [1,1.5]) {
  const rest=structuredClone(base);Object.assign(rest.agent,{deep_thinking_type:2,deduct_deep_think:multiplier,timeout:75,temperature:0.25});
  Object.assign(rest.model,{deep_thinking_type:2,deduct_deep_think:multiplier,timeout:90,temperature:0.75,input_cost_per_million:2.125,output_cost_per_million:8.25,cached_cost_per_million:0,profit_margin:20.5});
  rest.agent.deleted_at=null;rest.agent.max_context_tokens=0;rest.agent.max_context_rounds=0;
  const pg=structuredClone(rest);
  for(const [row,fields] of [[pg.agent,pgAgentNumeric],[pg.model,pgModelNumeric]])for(const key of fields)if(typeof row[key]==='number')row[key]=key==='deduct_deep_think'&&multiplier===1?'1.0000':String(row[key]);
  const original=structuredClone(pg),observation={},transaction=numericTransaction(pg,observation),result=await transaction.run();
  const expected=await core.prepareStandardLlmRequest(body,rest,actor,publicId,pins);
  check('pg numeric '+multiplier+' full quote expectation matches REST',result.quoteExpectation,expected.expectation);
  core.assertQuoteExpectation(result.quoteExpectation,expected.expectation);checks.push('pg numeric '+multiplier+' actual expectation accepted');
  check('pg numeric '+multiplier+' price snapshot matches REST',result.denomination.priceSnapshot,expected.billing.priceSnapshot);
  check('pg numeric '+multiplier+' budgets and amount match REST',result.budgets,expected.reservation);
  check('pg numeric '+multiplier+' native output multiplier',result.budgets.outputBudget,1200*multiplier);
  check('pg numeric '+multiplier+' preserves settings text',observation.snapshot.settings,original.settings);
  check('pg numeric '+multiplier+' name and ids remain strings',[observation.snapshot.agent.id,observation.snapshot.agent.name,observation.snapshot.model.id,observation.snapshot.model.model_name],[rest.agent.id,rest.agent.name,rest.model.id,rest.model.model_name]);
  check('pg numeric '+multiplier+' does not mutate SELECT rows',pg,original);
  check('pg numeric '+multiplier+' cleanup', [transaction.queries.at(-1)[0],transaction.closed()],['ROLLBACK',1]);
}
const nullRest=structuredClone(base);nullRest.agent.max_reply_tokens=null;nullRest.agent.timeout=undefined;nullRest.model.deduct_deep_think=null;
const nullPg=structuredClone(nullRest);nullPg.agent.temperature='0';nullPg.model.max_reply_tokens='4000';const nullObservation={};
const nullReceipt=await numericTransaction(nullPg,nullObservation).run();
check('pg null fallback quote matches REST',nullReceipt.quoteExpectation,(await core.prepareStandardLlmRequest(body,nullRest,actor,publicId,pins)).expectation);
check('pg null and undefined preserved', [nullObservation.snapshot.agent.max_reply_tokens,nullObservation.snapshot.agent.timeout,nullObservation.snapshot.model.deduct_deep_think],[null,undefined,null]);
check('pg zero normalized without fallback',nullObservation.snapshot.agent.temperature,0);
for(const [name,value] of [['NaN','NaN'],['positive infinity','Infinity'],['negative infinity','-Infinity'],['overflow','1e309'],['blank','  '],['empty',''],['text','bad'],['hex','0x10'],['boolean',true],['array',[]],['object',{}],['number NaN',NaN],['number infinity',Infinity],['unsafe integer','9007199254740993']]) {
  const fixture=structuredClone(base);fixture.model.deduct_deep_think=value;const observation={},transaction=numericTransaction(fixture,observation);
  await rejects('pg numeric rejects '+name,transaction.run);
  check('pg invalid '+name+' rollback and close',[transaction.queries.at(-1)[0],transaction.closed()],['ROLLBACK',1]);
  check('pg invalid '+name+' stops before prepare',observation.prepared===undefined);
}
for(const [owner,key] of [['agent','config_revision'],['agent','deep_thinking_type'],['agent','max_context_rounds'],['agent','max_context_tokens'],['agent','max_reply_tokens'],['agent','timeout'],['model','token_rounding_unit']])for(const value of ['1.5','9007199254740993',9007199254740992]) {
  const fixture=structuredClone(base);fixture[owner][key]=value;const transaction=numericTransaction(fixture);
  await rejects('pg integer contract '+owner+'.'+key+' rejects '+value,transaction.run);
  check('pg integer contract '+owner+'.'+key+' cleanup '+value,[transaction.queries.at(-1)[0],transaction.closed()],['ROLLBACK',1]);
}

// Execute the real route quote-bound early block with a fluent readonly adapter and effect sentinels.
const routeSource=fs.readFileSync('src/app/api/llm/route.ts','utf8');const ast=ts.createSourceFile('route.ts',routeSource,ts.ScriptTarget.Latest,true);let early;
function visit(n){if(ts.isIfStatement(n)&&n.expression.getText(ast)==='quoteBound'&&n.getText(ast).includes('readStandardSnapshot'))early=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(early);
function fluent(table,fixture=base){return {select(){return this;},eq(){return this;},in(){return this;},then(resolve){return Promise.resolve(resolve({error:null,data:table==='agents'?[fixture.agent]:table==='llm_models'?[fixture.model]:table==='users'?[fixture.actor]:table==='platform_settings'?fixture.settings:fixture.skills}));}};}
const idempotency=load('src/lib/llm-request-idempotency.ts');
const fingerprint=value=>idempotency.fingerprintLlmRequest(Object.fromEntries(Object.entries(value).filter(([key])=>!['client_request_id','userId'].includes(key))));
let readonlyRecord=null, readonlyError=null, readonlyQueries=[];
readonlyAdapter=table=>{const query={table,filters:[]};readonlyQueries.push(query);return {select(fields){query.fields=fields;return this;},eq(key,value){query.filters.push([key,value]);return this;},async maybeSingle(){return {data:readonlyRecord,error:readonlyError};}};};
const admissionStore=new idempotency.DatabaseLlmRequestAttemptStore();
function earlyEnvironment(requestBody={...body,quote_expectation:prepared.expectation}) {return {llmRequestAttemptStore:admissionStore,clientRequestId:body.client_request_id,requestFingerprintPayload:Object.fromEntries(Object.entries(requestBody).filter(([key])=>!['client_request_id','userId'].includes(key))),fingerprintLlmRequest:idempotency.fingerprintLlmRequest,
  responseForLlmAttemptClaim:idempotency.responseForLlmAttemptClaim,LlmRequestIdempotencyError:idempotency.LlmRequestIdempotencyError,Response,Headers};}
const routeModule={exports:{}};vm.runInNewContext(ts.transpileModule(`module.exports=async function(){let preparedQuote;${early};return preparedQuote;}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
  {module:routeModule,...earlyEnvironment(),quoteBound:true,verifiedUserId:actor,agentId,isVirtualAgent:false,isCanvasInternalWorkflow:false,mangaSkillOrchestration:null,body:{...body,quote_expectation:prepared.expectation},client:{from:table=>fluent(table)},...core,
    readQuotePinFile:p=>p.endsWith('BUILD_ID')?pins.buildId:JSON.stringify({sourceVersion:pins.sourceVersion}),quotePinPath:path.join,process:{cwd:()=>root},toPublicModelId:()=>publicId});
const accepted=await routeModule.exports();check('actual route preflight uses shared prepared request',accepted.chatRequest,prepared.chatRequest);
let linkedBranch, replayBranch;
function findBranches(n){if(ts.isIfStatement(n)&&n.getText(ast).includes('const linkedRow = modelPresetConfig || modelIdData;'))linkedBranch=n.getText(ast);
  if(ts.isIfStatement(n)&&n.expression.getText(ast)==='claim.action !== "execute"')replayBranch=n.getText(ast);ts.forEachChild(n,findBranches);}findBranches(ast);
assert.ok(linkedBranch&&replayBranch);
const parameterNames=Object.keys(prepared.parameters);
for(const state of ['cold','warm']) {
  const resultModule={exports:{}};const declarations=parameterNames.map(key=>`let ${key}=999`).join(';');
  vm.runInNewContext(ts.transpileModule(`module.exports=function(){${declarations};${linkedBranch};return {${parameterNames.join(',')}}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {module:resultModule,agentRow:base.agent,model_overridden:false,isVirtualAgent:false,modelPresetConfig:state==='warm'?base.model:null,modelIdData:state==='cold'?base.model:null,body,...core});
  check('actual '+state+' route branch discards legacy parameters',resultModule.exports(),prepared.parameters);
}
const replayModule={exports:{}};let afterReplay=0;
vm.runInNewContext(`module.exports=function(claim){${replayBranch};afterEffect();}`,{module:replayModule,responseForLlmAttemptClaim:claim=>claim.record.responseBody,afterEffect:()=>afterReplay++});
check('actual route replay returns stored receipt',replayModule.exports({action:'replay',record:{responseBody:'original'}}),'original');
check('actual route replay exits before later effects',afterReplay,0);
const dispatchStart=routeSource.indexOf('    const effectiveMaxTokens = agentMaxReplyTokens;');
const dispatchEnd=routeSource.indexOf('    // ── 提前保存用户消息',dispatchStart);assert.ok(dispatchStart>0&&dispatchEnd>dispatchStart);
const dispatchBlock=routeSource.slice(dispatchStart,dispatchEnd);
function dispatchFixture(overrides={}) {const executable={exports:{}};let providerRequest,reservedAmount;
  vm.runInNewContext(ts.transpileModule(`module.exports=async function(){${dispatchBlock};reserve(streamQuote.amount);provider(chatRequest);return chatRequest;}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {module:executable,anthropic_thinking_profile:undefined,truncateFromMessageId:undefined,trustedTextOnly:core.isStoryboardTextOnlyAgent(base.agent.id,base.agent),...prepared.parameters,...core,quoteLlmStreamReservation:load('src/lib/llm-credit-reservation.ts').quoteLlmStreamReservation,preparedQuote:prepared,selectedModelBillingSnapshot:prepared.billing,
      useModel:prepared.billing.modelName,searchInjectedMessages:prepared.chatRequest.messages,stream:true,effectiveEnableWebSearch:false,skillInjection:null,
      reserve:amount=>{reservedAmount=amount;},provider:request=>{providerRequest=request;},...overrides});
  return {run:executable.exports,observed:()=>({providerRequest,reservedAmount})};}
const dispatch=dispatchFixture();check('actual dispatch returns single shared object',await dispatch.run(),prepared.chatRequest);
check('actual provider stub receives shared object unchanged',dispatch.observed().providerRequest===prepared.chatRequest);
check('actual reserve stub receives shared quote',dispatch.observed().reservedAmount,prepared.reservation.amount);
const driftedDispatch=dispatchFixture({agentTemperature:0.5});await assert.rejects(() => driftedDispatch.run());checks.push('actual late request drift refuses before reserve/provider');
check('late drift reserve/provider remain untouched',driftedDispatch.observed(),{});
for(const [name,mutate] of [['skills',s=>s.skills=[{id:'active'}]],['linked identity',s=>s.model.id='wrong'],['revision',s=>s.agent.config_revision=0],['search',s=>s.model.enable_web_search=true]]) {
  const fixture=structuredClone(base);mutate(fixture);const isolated={exports:{}};
  vm.runInNewContext(ts.transpileModule(`module.exports=async function(){let preparedQuote;${early};return preparedQuote;}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,
    {module:isolated,...earlyEnvironment(),quoteBound:true,verifiedUserId:actor,agentId,isVirtualAgent:false,isCanvasInternalWorkflow:false,mangaSkillOrchestration:null,body:{...body,quote_expectation:prepared.expectation},client:{from:table=>fluent(table,fixture)},...core,
      readQuotePinFile:p=>p.endsWith('BUILD_ID')?pins.buildId:JSON.stringify({sourceVersion:pins.sourceVersion}),quotePinPath:path.join,process:{cwd:()=>root},toPublicModelId:()=>publicId});
  await rejects('actual route '+name+' rejects before execution effects',isolated.exports);
}
// Actual store adapter and fingerprint, with a labelled RAM implementation of the atomic RPC contract.
const finalBody={...body,quote_expectation:prepared.expectation};
const initialFingerprint=fingerprint(finalBody);let claimed;
rpcAdapter=async(name,args)=>{assert.equal(name,'claim_llm_request_attempt_atomic');
  if(claimed && claimed.payload_fingerprint!==args.p_payload_fingerprint)return {data:null,error:{message:'LLM_ATTEMPT_PAYLOAD_CONFLICT'}};
  if(!claimed)claimed={record_id:args.p_record_id,user_id:args.p_user_id,client_request_id:args.p_client_request_id,payload_fingerprint:args.p_payload_fingerprint,state:'running',attempt_no:1,lease_owner:args.p_lease_owner,lease_token:1,created_at:'2026-10-12T00:00:00Z',updated_at:'2026-10-12T00:00:00Z'};
  return {error:null,data:{action:claimed.state==='succeeded'?'replay':'execute',record:claimed}};
};
const store=new idempotency.DatabaseLlmRequestAttemptStore();const claimInput={userId:actor,clientRequestId:body.client_request_id,payloadFingerprint:initialFingerprint,leaseOwner:'lease_fixture'};
check('actual store initial claim', (await store.claim(claimInput)).action,'execute');
claimed={...claimed,state:'succeeded',response_body:'controlled original receipt',response_fingerprint:sha256('controlled original receipt'),http_status:200};
const replay=await store.claim(claimInput);check('actual store completed replay',replay.action,'replay');check('actual replay original receipt',replay.record.responseBody,'controlled original receipt');
const changedFingerprint=fingerprint({...finalBody,quote_expectation:{...prepared.expectation,platformReservationCredits:prepared.reservation.amount+1}});
check('server fingerprint includes expectation drift',changedFingerprint!==initialFingerprint);
await assert.rejects(()=>store.claim({...claimInput,payloadFingerprint:changedFingerprint}),error=>error.code==='LLM_IDEMPOTENCY_CONFLICT');checks.push('actual store same key changed expectation conflict');
readonlyRecord=claimed;
const beforeReplays=readonlyQueries.length;
function orderedAdmission({requestBody=finalBody,quoteBound=true,readerFails=false,pinDrift=false,earlyResponse=false}={}) {
  const executable={exports:{}};let strictReads=0,claims=0;
  const context={module:executable,...earlyEnvironment(requestBody),quoteBound,verifiedUserId:actor,agentId,isVirtualAgent:false,isCanvasInternalWorkflow:false,mangaSkillOrchestration:null,body:requestBody,...core,
    client:{from:table=>{strictReads++;if(readerFails)throw Error('reader unknown');return fluent(table);}},
    readQuotePinFile:p=>p.endsWith('BUILD_ID')?(pinDrift?'changed-build':pins.buildId):JSON.stringify({sourceVersion:pins.sourceVersion}),quotePinPath:path.join,process:{cwd:()=>root},toPublicModelId:()=>publicId,
    earlyResponse,lateClaim:async()=>{claims++;return store.claim(claimInput);}};
  vm.runInNewContext(ts.transpileModule(`module.exports=async function(){let preparedQuote;${early};if(earlyResponse)return new Response('existing early refusal',{status:403});return lateClaim();}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return {run:executable.exports,counts:()=>({strictReads,claims})};
}
for(const options of [{pinDrift:true},{readerFails:true}]) {const execution=orderedAdmission(options);const result=await execution.run();check('ordered replay original receipt despite mutable configuration '+JSON.stringify(options),await result.text(),claimed.response_body);
  check('ordered replay skips strict reader and late claim '+JSON.stringify(options),execution.counts(),{strictReads:0,claims:0});}
const conflictAdmission=orderedAdmission({requestBody:{...finalBody,quote_expectation:{...prepared.expectation,platformReservationCredits:prepared.reservation.amount+1}},readerFails:true});
const conflictResponse=await conflictAdmission.run();check('ordered changed expectation retains payload conflict',(await conflictResponse.json()).code,'LLM_IDEMPOTENCY_CONFLICT');check('conflict before mutable reads/claim',conflictAdmission.counts(),{strictReads:0,claims:0});
readonlyRecord={...claimed,response_body:null};const malformedReplay=await orderedAdmission({readerFails:true}).run();check('malformed succeeded receipt refuses without regeneration',(await malformedReplay.json()).code,'LLM_ATTEMPT_REPLAY_INVALID');
for(const [field,value] of [['user_id','another_owner'],['client_request_id','another_request'],['record_id','0'.repeat(64)]]) {
  readonlyRecord={...claimed,[field]:value};const result=await orderedAdmission({readerFails:true}).run();check('readonly receipt rejects '+field+' mismatch',(await result.json()).code,'LLM_IDEMPOTENCY_CONFLICT');
}
readonlyRecord=null;claimed=undefined;
const freshDrift=orderedAdmission({pinDrift:true});await rejects('fresh drift refuses before atomic claim',freshDrift.run);check('fresh drift creates no running attempt',claimed===undefined);check('fresh drift no late claim',freshDrift.counts().claims,0);
const earlyRefusal=orderedAdmission({earlyResponse:true});check('existing early return preserved',(await earlyRefusal.run()).status,403);check('early return creates no running attempt',claimed===undefined);
const fresh=orderedAdmission();check('fresh passes strict gate to original single claim',(await fresh.run()).action,'execute');check('fresh claim only once',fresh.counts().claims,1);
const unresolved=structuredClone(claimed);readonlyRecord=unresolved;
check('readonly running does not duplicate lease state machine',await store.readSucceededReplay(claimInput),null);
for(const state of ['failed','failed_unknown','reconciliation_required']) {readonlyRecord={...unresolved,state};check('readonly '+state+' remains original atomic claim responsibility',await store.readSucceededReplay(claimInput),null);}
readonlyError={message:'unavailable raw connection details'};const unknownRead=await orderedAdmission().run();check('readonly failure never treated absent',(await unknownRead.json()).code,'LLM_IDEMPOTENCY_STORE_UNAVAILABLE');readonlyError=null;
readonlyRecord=null;const nonQuote=orderedAdmission({quoteBound:false,readerFails:true});await nonQuote.run();check('nonquote keeps original late atomic claim',nonQuote.counts(),{strictReads:0,claims:1});
const completedQueries=readonlyQueries.slice(beforeReplays);check('replay lookup always owner key record scoped',completedQueries.every(query=>query.table==='llm_request_attempts' && ['record_id','user_id','client_request_id'].every(key=>query.filters.some(([field])=>field===key))));
readonlyAdapter=undefined;
rpcAdapter=undefined;
check('actual core no DB/provider/reserve/search/secret effects',effects,{database:0,provider:0,reserve:0,search:0,secret:0});
console.log(JSON.stringify({passed:checks.length,failed:0,checks,effects,limits:'Actual core/adapters and extracted route block with in-memory fixtures only; not DB/browser/paid/provider acceptance.'},null,2));
