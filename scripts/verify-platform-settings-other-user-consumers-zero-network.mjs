#!/usr/bin/env node
import assert from 'node:assert/strict';
import{readFileSync,mkdirSync,writeFileSync}from'node:fs';
import vm from'node:vm';import ts from'typescript';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
const outputArgs = process.argv.slice(2);
assert.ok(outputArgs.every(value => value.startsWith('--output-dir=')), 'UNSUPPORTED_EVIDENCE_ARGUMENT');
const outputOptions = outputArgs.filter(value => value.startsWith('--output-dir='));
assert.ok(outputOptions.length <= 1, 'ONE_OUTPUT_DIRECTORY_REQUIRED');
assert.ok(!outputOptions.length || outputOptions[0].length > '--output-dir='.length, 'OUTPUT_DIRECTORY_REQUIRED');
const evidenceRoot = path.resolve('.codex-evidence');
const outputDirectory = path.resolve(outputOptions[0]?.slice('--output-dir='.length) || `.codex-evidence/platform-settings-other-user-consumers/run-${randomUUID()}`);
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
const checks=[],gaps=[],observations=[];const plain=x=>JSON.parse(JSON.stringify(x));const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
for(const surface of ['admin','legacy']){
 // Actual ordinary email login-code route -> production code store/email module -> RAM nodemailer transport.
 const h=createHarness(),route=h.load('src/app/api/auth/send-email-code/route.ts'),store=h.load('src/lib/email-code-store.ts');
 const initial=Object.fromEntries([...h.rows].map(([key,row])=>[key,row.setting_value]));
 const b={email_smtp_host:'smtp-b.invalid',email_smtp_port:'587',email_smtp_user:'sender-b@example.invalid',email_smtp_pass:'fixture-password-b',email_from:'Fixture B'};
 for(const [phase,values]of[['A',initial],['B',b],['A-restored',initial]]){
  if(phase!=='A')assert.equal((await h.save(surface,Object.fromEntries(Object.keys(b).map(k=>[k,values[k]])))).status,200);
  const email=`recipient-${phase}@example.invalid`;h.state.user={id:'ordinary-fixture',email,is_active:true};
  const request=()=>new Request('http://fixture.invalid/api/auth/send-email-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
  assert.equal((await route.POST(request())).status,200);const mail=h.state.mails.at(-1);assert.equal(mail.options.host,values.email_smtp_host);assert.equal(mail.options.auth.user,values.email_smtp_user);assert.equal(mail.mail.from.name,values.email_from);assert.equal(mail.mail.to,email);
  const code=mail.mail.text.match(/验证码：(\d{6})/u)?.[1];assert.ok(code);assert.equal((await route.POST(request())).status,429);assert.equal(store.verifyCode(email,code,'register').ok,false);assert.equal(store.verifyCode(email,code,'login').ok,true);assert.equal(store.verifyCode(email,code,'login').ok,false);
  checks.push(`${surface}/${phase}: production email-code POST, sender config, purpose, one-time code and cooldown`);
 }
 const mailCount=h.state.mails.length;
 h.state.user={id:'ordinary-fixture',email:'disabled@example.invalid',is_active:false};
 const emailRequest=email=>new Request('http://fixture.invalid/api/auth/send-email-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
 assert.equal((await route.POST(emailRequest('disabled@example.invalid'))).status,403);h.state.user=null;assert.equal((await route.POST(emailRequest('missing@example.invalid'))).status,404);assert.equal((await route.POST(emailRequest('invalid'))).status,400);assert.equal(h.state.mails.length,mailCount);checks.push(`${surface}: disabled/missing/invalid ordinary email does not dispatch SMTP`);
 assert.equal(h.state.networkAttempts,0);
 // Actual billing parser/config getter and same usage computation, no wallet settlement.
 const billing=createHarness(),aConfig=await billing.billing.getBillingConfig();const a=billing.billing.calculateCredits(aConfig,1000000,2000000,200000);
 assert.equal((await billing.save(surface,{credits_per_yuan:'100'})).status,200);const bConfig=await billing.billing.getBillingConfig(),bb=billing.billing.calculateCredits(bConfig,1000000,2000000,200000);
 assert.equal(bb.sellPriceRmb,a.sellPriceRmb);assert.equal(bb.actualCostRmb,a.actualCostRmb);assert.equal(bb.creditsCharged,a.creditsCharged*2);assert.deepEqual(plain(billing.billing.calculateCredits(aConfig,1000000,2000000,200000)),plain(a));
 assert.equal((await billing.save(surface,{credits_per_yuan:'50'})).status,200);assert.deepEqual(plain(billing.billing.calculateCredits(await billing.billing.getBillingConfig(),1000000,2000000,200000)),plain(a));
 observations.push({surface,billing:{A:a.creditsCharged,B:bb.creditsCharged,sellPriceRmb:a.sellPriceRmb}});checks.push(`${surface}: same actual usage A/B credits change, RMB invariant, A snapshot invariant and restore`);
 // Actual auto-avatar public entry, production prompt/model resolver; provider transport only is stubbed to stop before storage.
 const requests=[];const avatar=createHarness({avatarRequest:async(...args)=>{requests.push({endpoint:args[0],prompt:args[2],options:args[3]});return{success:false,images:[],error:'RAM_CAPTURE_ONLY'};}});
 avatar.state.agent={id:'avatar-agent-fixture',avatar:null,config_revision:1};avatar.state.coverModels=['a','b'].map(id=>({id:`avatar-${id}`,name:`Fixture ${id}`,model_name:`fixture-${id}`,provider:'openai',api_endpoint:`https://avatar-${id}.invalid/images`,api_key:'fixture-api-key',is_active:true,is_hidden:false,sort_order:0}));
 const avatars=avatar.load('src/lib/auto-avatar/index.ts');
 assert.equal((await avatar.save(surface,{auto_avatar_enabled:'true',auto_avatar_model_id:'avatar-a'})).status,200);avatars.triggerAutoAvatar('avatar-agent-fixture','摄影师','拍摄作品',null);await settle();assert.equal(requests.length,1);assert.equal(requests.at(-1).options.modelName,'fixture-a');assert.ok(requests.at(-1).prompt.length>30);
 assert.equal((await avatar.save(surface,{auto_avatar_model_id:'avatar-b'})).status,200);avatars.triggerAutoAvatar('avatar-agent-fixture','摄影师','拍摄作品',null);await settle();assert.equal(requests.length,2);assert.equal(requests.at(-1).options.modelName,'fixture-b');
 const beforeManual=requests.length;avatars.triggerAutoAvatar('avatar-agent-fixture','摄影师','拍摄作品','https://owned.invalid/avatar.png');await settle();assert.equal(requests.length,beforeManual);
 assert.equal((await avatar.save(surface,{auto_avatar_enabled:'false'})).status,200);const beforeOff=requests.length;avatars.triggerAutoAvatar('avatar-agent-fixture','摄影师','拍摄作品',null);await settle();const immediateOffBlocks=requests.length===beforeOff;
 if(!immediateOffBlocks)gaps.push({surface,code:'AUTO_AVATAR_DISABLE_TTL_WINDOW',details:'Saved false but production trigger still dispatched RAM generation under cached true within 1 second.'});
 avatar.state.clock+=1001;const afterWindow=requests.length;avatars.triggerAutoAvatar('avatar-agent-fixture','摄影师','拍摄作品',null);await settle();assert.equal(requests.length,afterWindow);
 observations.push({surface,avatar:{selectedModels:requests.map(r=>r.options.modelName),immediateOffBlocks}});checks.push(`${surface}: auto-avatar production trigger/model A->B, manual avatar protection, disabled after declared TTL`);
}
// Execute exact workflow configuration/pricing and request-body AST blocks from the production image route.
const source=readFileSync('src/app/api/image/generate/route.ts','utf8'),ast=ts.createSourceFile('route.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);let branch,bodyNode,priceHelper;
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='configuredImagePrice')priceHelper=node;if(ts.isIfStatement(node)&&node.expression.getText(ast)==='effectiveMode === "workflow"'&&node.thenStatement.getText(ast).includes('.from("plugins")'))branch=node.thenStatement;if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>d.name.getText(ast)==='workflowBody'))bodyNode=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(branch&&bodyNode&&priceHelper,'production workflow AST anchors required');
const block=`${priceHelper.getText(ast)};module.exports=async function(dbClient,userId,workflowPrompt){let workflowCostPriceGlobal=NaN,workflowSellingPriceGlobal=NaN;const workflowConfig={apiUrl:'',appId:'',apiToken:''};${branch.getText(ast)};${bodyNode.getText(ast)};return{workflowConfig,workflowCostPriceGlobal,workflowSellingPriceGlobal,body:JSON.parse(workflowBody)};}`;
const module={exports:{}};vm.runInNewContext(ts.transpileModule(block,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,NextResponse:{json:(x,o)=>Response.json(x,o)},console:{warn(){}}});
const settings=[{setting_key:'cover_workflow_api_url',setting_value:'https://settings-workflow.invalid/run'},{setting_key:'cover_workflow_app_id',setting_value:'settings-app'},{setting_key:'cover_workflow_token',setting_value:'fixture-token'}];
for(const row of [null,{price_per_use:null,cost_price:0},{price_per_use:-1,cost_price:0},{price_per_use:0,cost_price:0},{price_per_use:1.5,cost_price:.5}]){
 const plugin=row?{...row,config:{api_base_url:'https://plugin-workflow.invalid/run',app_id:'plugin-app',api_token:'fixture-token'}}:null;
 const db={from(table){const q={select(){return q;},eq(){return q;},limit(){return q;},in(){return q;},maybeSingle:async()=>({data:plugin}),then(resolve,reject){return Promise.resolve({data:settings}).then(resolve,reject);}};return q;}};
 const r=await module.exports(db,'ordinary-fixture','Fixture cover prompt');if(!row||row.price_per_use==null||row.price_per_use<0){assert.ok(r instanceof Response);assert.equal(r.status,503);assert.equal((await r.json()).code,'IMAGE_PRICE_NOT_CONFIGURED');checks.push('cover production workflow: missing/invalid price fails closed');}else{assert.equal(r.workflowConfig.apiUrl,'https://plugin-workflow.invalid/run');assert.equal(r.workflowSellingPriceGlobal,row.price_per_use);assert.equal(r.workflowCostPriceGlobal,row.cost_price);assert.equal(r.body.app_id,'plugin-app');assert.equal(r.body.user_id,'ordinary-fixture');assert.equal(r.body.content.query.prompt[0].content.text,'Fixture cover prompt');checks.push('cover production workflow: plugin authority/price/body including explicitly free price');}
}
const report={passed:gaps.length===0,checks,gaps,observations,realNetworkCalls:0,realDatabaseWrites:0,realSmtpCalls:0,realPaidCalls:0,limits:['Auto-avatar provider returns RAM failure after request construction; storage/CAS success is not executed.','Email uses actual ordinary POST and code store with RAM users, settings, nodemailer.','Cover runs exact production config/price/body AST blocks with fixture actor; complete image HTTP authentication/admission/billing/history route is not executed.','platform_settings cover-workflow fallback has no prices and correctly returns 503; active plugin configuration takes precedence.','Billing executes same usage calculation and cached snapshots, no wallet settlement.']};report.outputDirectory=outputDirectory;writeFileSync(path.join(outputDirectory,'remaining-four-after-avatar-fix.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));if(gaps.length)process.exitCode=1;
