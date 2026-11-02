// Zero-network structural checks plus original TS mapper oracles for PG parity tests.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const read=n=>fs.readFileSync(path.join(ROOT,n),'utf8');
const ts=createRequire(path.join(ROOT,'package.json'))('typescript');
function pure(source,bindings){const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const exports={};new Function('exports','require',...Object.keys(bindings),js)(exports,name=>{if(name!=='node:crypto')throw Error('UNEXPECTED_IMPORT');return crypto;},...Object.values(bindings));return exports;}
const contract=pure(read('src/lib/platform-configuration-contract.ts'),{}),source=read('src/lib/server/platform-configuration-compatibility.ts'),ast=ts.createSourceFile('canonical.ts',source,ts.ScriptTarget.Latest,true);
const wanted=new Set(['record','string','finite','bool','legacyModelId','credentialRef','safeEndpoint','compactObject','entryFromLegacyRow']);const declarations=[];for(const n of ast.statements){if(ts.isFunctionDeclaration(n)&&wanted.has(n.name?.text)){wanted.delete(n.name.text);declarations.push(n.getText(ast));}else if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==='TABLE_KIND'))declarations.push(n.getText(ast));}assert.equal(wanted.size,0);
const mapper=pure(declarations.join('\n')+'\nexport {entryFromLegacyRow};',{randomUUID:()=>{throw Error('FIXTURE_ID_REQUIRED');},PlatformConfigurationError:class extends Error{}});
export function redactedOracleFixtures(){
 const rows=[
 ['llm_models',{id:'initial-null-empty',name:' fixture ',model_name:' model ',provider:'test',api_endpoint:'https://EXAMPLE.invalid:443',proxy_url:'https://alternate.invalid/v1',api_key:'fixture-only',is_active:true,is_hidden:false,user_access:'',response_format:null,api_protocol_config:{},input_cost_per_million:0,deep_thinking_type:0,enable_web_search:false}],
 ['llm_models',{id:'initial-empty-zero',name:'fixture',model_name:'model',provider:'test',api_endpoint:'https://example.invalid/v1',proxy_url:'https://alternate.invalid/v2',api_key:'',is_active:false,is_hidden:false,user_access:'',response_format:'',max_context_rounds:0,temperature:0,api_protocol_config:{nested:{nullValue:null,emptyValue:'',falseValue:false,list:[0,false,'',null]}}}],
 ['video_models',{id:'initial-pending',name:'video',model_name:'video',provider:'test',api_endpoint:'https://example.invalid',api_key:'fixture-only',is_hidden:false,supports_image_input:false,requires_image:true,duration_seconds:0,max_duration:10,cost_price:0,price_per_use:0,api_protocol_config:{__model_activation_gate:{state:'pending',reason:'fixture'},modes:['b','a']}}],
 ['video_models',{id:'initial-accepted',name:'video',model_name:'video',provider:'test',api_endpoint:'http://EXAMPLE.invalid:80/?x=one',api_key:'',is_hidden:false,api_protocol_config:{__model_activation_gate:{state:'accepted',fixture:true},modes:['b','a']}}],
 ['cover_models',{id:'initial-image',name:'image',model_name:'image',provider:'test',api_endpoint:'https://example.invalid',api_key:'fixture-only',is_hidden:false,supports_image_input:false,cost_price:0,selling_price:null,cost_per_use:0,api_protocol_config:{}}],
 ['video_models',{id:'\u000binitial-vv\u000b',name:'\u000bvfixturev\u000b',model_name:'modelv',provider:'test',api_endpoint:'\u000bhttps://example.invalid/v\u000b',api_key:'',is_hidden:false,api_protocol_config:{}}],
 ['cover_models',{id:'initial-retired',name:'retired',model_name:'retired',provider:'retired_configuration',api_endpoint:'',api_key:'',is_hidden:true,api_protocol_config:{}}]
 ];
 const endpointCases=[['https://113.31.180.249',false],['http://0.0.0.0:80',false],['https://255.255.255.255:443/v',false],['http://127.1',true],['http://0x7f000001',true],['http://0177.0.0.1',true],['http://2130706433',true]];
 endpointCases.forEach(([endpoint,expectHelperNull],index)=>rows.push(['video_models',{id:'initial-ipv4-'+index,name:'IPv4 fixture',model_name:'model',provider:'test',api_endpoint:endpoint,api_key:'',is_hidden:false,api_protocol_config:{}},expectHelperNull]));
 return rows.map(([table,row,expectHelperNull=false])=>({table,row,expectHelperNull,expected:contract.normalizeModelPoolSnapshot({schema:'model-pool-config/v1',models:[mapper.entryFromLegacyRow(table,row)]}).models[0]}));
}
export function verifyInitialDeltaMigration(){
 const sql=read('supabase/migrations/20261102060000_model_pool_initial_delta_live_baseline.sql');let checks=0;const check=fn=>{fn();checks++;};
 const original=read('supabase/migrations/20261027070000_model_pool_pure_removal_projection.sql').split('AS $delta$')[1].split('$delta$')[0];
 for(const bytes of [original.replace(/\r\n/g,'\n'),original.replace(/\r?\n/g,'\r\n')])check(()=>assert.ok(sql.includes(crypto.createHash('sha256').update(bytes).digest('hex'))));
 check(()=>assert.match(sql,/ALTER FUNCTION public\.model_pool_projection_delta\(jsonb\) RENAME TO model_pool_projection_delta_before_initial_live_baseline/));
 check(()=>assert.match(sql,/IF EXISTS \(SELECT 1 FROM public\.model_pool_config_releases r WHERE r\.is_current AND r\.status='published'\) THEN\s+RETURN QUERY SELECT \* FROM public\.model_pool_projection_delta_before_initial_live_baseline\(p_snapshot\);\s+RETURN;/));
 check(()=>assert.ok(!/\b(?:INSERT INTO|UPDATE public\.|DELETE FROM|CREATE TABLE|CREATE OR REPLACE FUNCTION public\.(?:publish_|project_))\b/i.test(sql)));
 check(()=>assert.match(sql,/baseline IS NULL OR baseline IS DISTINCT FROM candidate/));check(()=>assert.match(sql,/coalesce\(binding_key,''\)<>'' AND binding_key IS DISTINCT FROM physical_key/));
 check(()=>assert.match(sql,/matches<>1/));check(()=>assert.match(sql,/IF d\.removed THEN RAISE EXCEPTION/));
 check(()=>assert.match(sql,/REVOKE ALL ON FUNCTION public\.model_pool_initial_live_entry\(text,text\) FROM PUBLIC,anon,authenticated,service_role/));
 check(()=>assert.match(sql,/REVOKE ALL ON FUNCTION public\.model_pool_projection_delta_before_initial_live_baseline\(jsonb\) FROM PUBLIC,anon,authenticated,service_role/));
 for(const guard of ['proowner','proconfig','prosecdef','provolatile','proparallel','proisstrict','proleakproof','prokind','proretset','proacl','prosrc'])check(()=>assert.ok(sql.includes(guard)));
 const aclPairs=[...sql.matchAll(/pg_get_userbyid\(p\.proowner\) = '([^']+)'\s+AND p\.proacl::text = '([^']+)'/g)].map(m=>[m[1],m[2]]);
 check(()=>assert.deepEqual(aclPairs,[['zimeiti_owner','{zimeiti_owner=X/zimeiti_owner,service_role=X/zimeiti_owner}'],['postgres','{postgres=X/postgres,service_role=X/postgres,zimeiti_owner=X/postgres}']]));
 check(()=>assert.match(sql,/\) IS DISTINCT FROM true\s+OR p\.proconfig/));
 const allows=(owner,acl)=>aclPairs.some(([o,a])=>owner===o&&acl===a);
 check(()=>assert.ok(allows(...aclPairs[0])));check(()=>assert.ok(allows(...aclPairs[1])));
 for(const [owner,acl]of [
  ['postgres','{postgres=X/postgres,service_role=X/postgres}'],
  ['postgres','{postgres=X/postgres,service_role=X/postgres,zimeiti_owner=X/zimeiti_owner}'],
  ['postgres','{postgres=X/postgres,service_role=X/postgres,zimeiti_owner=X/postgres,anon=X/postgres}'],
  ['postgres','{postgres=X/postgres,service_role=X*/postgres,zimeiti_owner=X/postgres}'],
  ['postgres',aclPairs[0][1]],['zimeiti_owner',aclPairs[1][1]],['other',aclPairs[1][1]],['postgres',null]
 ])check(()=>assert.ok(!allows(owner,acl)));
 check(()=>assert.ok(!sql.includes('OWNER TO zimeiti_owner;')));
 check(()=>assert.match(sql,/SELECT pg_get_userbyid\(p\.proowner\) INTO STRICT original_owner[\s\S]*model_pool_projection_delta_before_initial_live_baseline\(jsonb\)/));
 check(()=>assert.match(sql,/original_owner NOT IN \('postgres','zimeiti_owner'\)/));
 check(()=>assert.ok(sql.includes("format('ALTER FUNCTION public.model_pool_initial_live_entry(text,text) OWNER TO %I',original_owner)")));
 check(()=>assert.ok(sql.includes("format('ALTER FUNCTION public.model_pool_projection_delta(jsonb) OWNER TO %I',original_owner)")));
 check(()=>assert.ok(!/GRANT[\s\S]{0,80}ON (?:TABLE|ALL TABLES)/i.test(sql)));
 check(()=>assert.match(sql,/END \$preserve_owner\$;\s+REVOKE ALL ON FUNCTION public\.model_pool_projection_delta\(jsonb\) FROM PUBLIC,anon,authenticated/));
 const oracle=redactedOracleFixtures();check(()=>assert.equal(oracle[0].expected.endpoint,'https://example.invalid/'));check(()=>assert.equal(oracle[0].expected.configuration.userAccess,undefined));check(()=>assert.equal(oracle[0].expected.configuration.responseFormat,undefined));check(()=>assert.equal(oracle[1].expected.configuration.responseFormat,undefined));check(()=>assert.equal(oracle[1].expected.configuration.maxContextRounds,0));check(()=>assert.equal(oracle[1].expected.configuration.temperature,0));check(()=>assert.deepEqual(oracle[1].expected.configuration.protocolConfig.nested.list,[0,false,'',null]));check(()=>assert.equal(oracle[2].expected.configuration.protocolConfig.__model_activation_gate.state,'pending'));check(()=>assert.equal(oracle[3].expected.configuration.protocolConfig.__model_activation_gate,undefined));check(()=>assert.equal(oracle[3].expected.endpoint,'http://example.invalid/?x=one'));check(()=>assert.equal(oracle[4].expected.pricing.selling,0));check(()=>assert.equal(oracle[6].expected.endpoint,'https://retired.invalid/cover_models/initial-retired'));
 check(()=>assert.equal(oracle[5].expected.id,'initial-vv'));check(()=>assert.equal(oracle[5].expected.name,'vfixturev'));check(()=>assert.equal(oracle[5].expected.endpoint,'https://example.invalid/v'));check(()=>assert.ok(sql.includes('chr(11)')));check(()=>assert.ok(!sql.includes('\\v')));
 const ipv4Pattern=sql.match(/host !~ '([^']+)' THEN RETURN NULL; END IF;/)[1];const acceptsCanonicalIpv4=h=>new RegExp(ipv4Pattern).test(h)&&h.split('.').every(n=>Number(n)<=255);
 for(const h of ['113.31.180.249','0.0.0.0','255.255.255.255'])check(()=>assert.ok(acceptsCanonicalIpv4(h)));
 for(const h of ['127.1','0x7f000001','0177.0.0.1','2130706433','113.31.180.249.','01.2.3.4','256.0.0.1'])check(()=>assert.ok(!acceptsCanonicalIpv4(h)));
 check(()=>assert.match(sql,/octet\.value::integer>255/));
 check(()=>assert.equal(oracle[7].expected.endpoint,'https://113.31.180.249/'));check(()=>assert.equal(oracle[8].expected.endpoint,'http://0.0.0.0/'));check(()=>assert.equal(oracle[9].expected.endpoint,'https://255.255.255.255/v'));
 for(const fixture of oracle.slice(10))check(()=>{assert.equal(fixture.expected.endpoint,'http://127.0.0.1/');assert.equal(fixture.expectHelperNull,true);});
 for(const fixture of oracle)for(const field of Object.keys(fixture.expected.configuration))check(()=>assert.ok(sql.includes(`'${field}'`)||sql.includes(`"${field}"`)));
 check(()=>assert.match(sql,/FROM walk AS item WHERE/));check(()=>assert.ok(!/jsonb_typeof\(value\)/.test(sql.slice(sql.indexOf(') SELECT 1 FROM walk AS item')))));
 return {status:'PASS',checks,redactedOracleFixtures:oracle.length,sqlExecuted:false,networkCalls:0,databaseWrites:0,limitations:'Structural/original-TS-oracle checks only; actual PostgreSQL parity and rollback are required.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyInitialDeltaMigration()));
