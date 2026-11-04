import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hasReviewedDirectorChannel, REVIEWED_TEXT_HISTORY } from "../src/lib/server/text-model-reviewed-history";
import { adminRequirementForRequest } from "../src/lib/admin-governance";
import { isUnboundCatalogAgent } from "../src/lib/agent-catalog-lifecycle";
import { assertStandardQuoteEligibility,readStandardSnapshot } from "../src/lib/server/llm-standard-request-preparation";
import {
  CATALOG_PUBLICATION_FIELDS, isReviewedDirectorRebind, makePublicationPlan,parsePublication,parsePublicationJson,publicationHash,reviewedFields,hasExactCatalogDecimals,requirePublicationDestination,checkedPublicationIndex,
  type PublicationFields,type PublicationSnapshot,
} from "../src/lib/server/agent-catalog-publication";

const id="agent-catalog-fixture",key="9da8e12a-32cc-4f49-9891-1849a5ac3f48";
function fields(overrides:Record<string,unknown>={}):PublicationFields{
  return Object.assign(Object.fromEntries(CATALOG_PUBLICATION_FIELDS.map(k=>[k,null])),{
    source:"llm",model_id:"50dc98ff-164f-4d72-9deb-f43d56d2525c",model:"fixture-text",category:"引流带货",name:"测试导演",system_prompt:"合成的测试提示",user_access:"available",is_active:true,output_style:{},
  },overrides) as PublicationFields;
}
function input(f=fields(),override:Record<string,unknown>={}){
  return {action:"plan",source:{id,revision:7,fields:f,sourceHash:publicationHash(f)},requestKey:key,baseline:null,...override};
}
function snapshot(f:PublicationFields):PublicationSnapshot{
  return {id,deleted:false,fields:f,revision:2,rowDigest:"c".repeat(64),portability:[]};
}
test("an external operator can load the portable contract and owner CLI with only the project tsconfig",()=>{
  const project=fileURLToPath(new URL("../",import.meta.url));
  const probe=`
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const project=process.argv[1], req=createRequire(path.join(project,'package.json'));
    req('tsx/cjs/api').register({tsconfig:path.join(project,'tsconfig.json')});
    const contract=req(path.join(project,'src/lib/server/agent-catalog-publication.ts'));
    const core=await import(pathToFileURL(path.join(project,'scripts/agent-catalog-release-core.mjs')));
    await import(pathToFileURL(path.join(project,'scripts/agent-catalog-release-owner.mjs')));
    assert.equal(core.hash({fixture:true}),contract.publicationHash({fixture:true}));
  `;
  const run=spawnSync(process.execPath,["--input-type=module","--eval",probe,project],{cwd:tmpdir(),encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
});
test("SQL and API expose the same explicit portable column whitelist",()=>{
  const sql=readFileSync(new URL("../supabase/migrations/20261103010000_agent_catalog_publications.sql",import.meta.url),"utf8");
  const list=sql.match(/FROM unnest\(ARRAY\[(.*?)\]\) k;/su)?.[1];
  assert.ok(list);assert.deepEqual([...list.matchAll(/'([a-z_]+)'/gu)].map(x=>x[1]),[...CATALOG_PUBLICATION_FIELDS]);
  for(const k of ["id","config_revision","coze_coding_api_token","proxy_url","admin_notes","deleted_at","knowledge_base_id"])assert.ok(!new Set<string>(CATALOG_PUBLICATION_FIELDS).has(k));
});
test("source hashes recursively sort object keys, preserve arrays, and reject unreviewed or secret-bearing payloads",()=>{
  assert.equal(publicationHash({b:[2,3],a:null}),publicationHash({a:null,b:[2,3]}));
  assert.notEqual(publicationHash([2,3]),publicationHash([3,2]));
  const req=parsePublication(input());assert.equal(req.source.revision,7);
  const raw=input();assert.throws(()=>parsePublication({...raw,source:{...raw.source,sourceHash:"0".repeat(64)}}),/SOURCE_HASH/);
  assert.throws(()=>parsePublication(input(fields({proxy_url:"external"}))),/APPROVED_FIELDS/);
  assert.throws(()=>parsePublication(input(fields({output_style:{api_key:"fixture"}}))),/PROTECTED_FIELD/);
  assert.throws(()=>parsePublication(input(fields({model:"secret://fixture-placeholder"}))),/PROTECTED_REFERENCE/);
  assert.throws(()=>parsePublication(input(fields({preset_fields:[{defaultValue:"env://FIXTURE_ONLY"}]}))),/PROTECTED_REFERENCE/);
  assert.throws(()=>parsePublication(input(fields({base_fee:-2}))),/DECIMAL/);
  assert.throws(()=>parsePublication(input(fields(),{baseline:undefined})),/BASELINE/);
  assert.throws(()=>parsePublication(input(fields(),{action:"apply"})),/PLAN_HASH/);
});
test("new IDs retain source identity; old source revision is provenance only and no existing row can be overwritten without target baseline",()=>{
  const f=fields(),req=parsePublication(input(f)),row=snapshot(f);
  const create=makePublicationPlan(req,null,f,[]);assert.equal(create.id,id);assert.equal(create.operation,"create");assert.ok(create.eligible);assert.equal(create.currentRevision,null);
  assert.ok(makePublicationPlan(req,row,f,[]).blockers.includes("CATALOG_PRODUCTION_BASELINE_CONFLICT"));
  const updated=fields({sort_order:20}),write=parsePublication(input(updated,{baseline:{revision:2,hash:publicationHash(f)}}));
  const plan=makePublicationPlan(write,row,updated,[]);
  assert.equal(plan.operation,"update");assert.deepEqual(plan.changedFields,["sort_order"]);assert.equal(plan.currentRevision,2);assert.equal(plan.sourceRevision,7);assert.ok(plan.eligible);
  assert.ok(!makePublicationPlan(write,{...row,revision:3},updated,[]).eligible);
  assert.ok(!makePublicationPlan(write,{...row,deleted:true},updated,[]).eligible);
  assert.ok(!makePublicationPlan(write,null,updated,[]).eligible);
});
test("the manifest controls private publication independently of ID and business category",()=>{
  const f=fields();
  const raw=input(f,{audience:"owner-only"}),privateFields=reviewedFields(parsePublication(raw),null);
  assert.equal(privateFields.user_access,"hidden");assert.equal(privateFields.category,"引流带货");assert.equal(f.user_access,"available");
  assert.equal(reviewedFields(parsePublication(input(f)),null).user_access,"available");
  const current=snapshot(privateFields),request=parsePublication(input(f,{baseline:{revision:current.revision,hash:publicationHash(privateFields)}}));
  assert.ok(makePublicationPlan(request,current,f,[]).blockers.includes("CATALOG_AUDIENCE_BROADENING_REQUIRES_NATIVE_REVIEW"));
  const plan=makePublicationPlan(parsePublication(raw),null,privateFields,[]);
  assert.equal(plan.billingEvidence,"configuration-only");assert.equal(plan.providerCalls,0);
});
test("inactive director contract fields do not force a new contract and protected activations cannot be smuggled in",()=>{
  const raw=input();assert.deepEqual(reviewedFields(parsePublication(raw),null).output_style,{});
  const activated=fields({output_style:{production_contract_version:"unrecognized",production_contract_activated_at:"2026-11-03T09:00:00Z"}});
  assert.throws(()=>reviewedFields(parsePublication(input(activated)),null));
});
test("numeric scale is semantic and high-precision source amounts cannot be rounded into an apparent match",()=>{
  const amounts={nestedNumbers:[],base_fee:"0.010000",deduct_deep_think:null,temperature:null,input_cost_per_million:null,output_cost_per_million:null,cached_cost_per_million:null,profit_margin:null};
  assert.ok(hasExactCatalogDecimals(fields({base_fee:0.01}),amounts));
  assert.ok(hasExactCatalogDecimals(fields({base_fee:1e-9}),{...amounts,base_fee:"0.0000000010"}));
  assert.ok(!hasExactCatalogDecimals(fields({base_fee:9_007_199_254_740_992}),{...amounts,base_fee:"9007199254740993"}));
});
test("nested source numbers and wire JSON must round trip exactly before publishing",()=>{
  const raw={base_fee:null,deduct_deep_think:null,temperature:null,input_cost_per_million:null,output_cost_per_million:null,cached_cost_per_million:null,profit_margin:null};
  assert.ok(hasExactCatalogDecimals(fields({preset_fields:[{ratio:0.125}],output_style:{max:1e23}}),{...raw,nestedNumbers:["0.12500","1e23"]}));
  assert.ok(!hasExactCatalogDecimals(fields(),{...raw,nestedNumbers:["9007199254740993"]}));
  assert.ok(!hasExactCatalogDecimals(fields(),raw));assert.deepEqual(parsePublicationJson('{"a":[1.25000,1e23]}'),{a:[1.25,1e23]});
  for(const raw of ['{"a":[9007199254740993]}','{"a":[0.123456789012345678901]}','{"a":1e9999}'])assert.throws(()=>parsePublicationJson(raw),/PRECISION_NOT_PORTABLE/);
});
test("view-only 自用 requires the explicit owner-only audience, retains source access and cannot promote a card-level view restriction",()=>{
  const f=fields({category:"自用"}),access={target:{visibility:"view_only"}};
  const owner=parsePublication(input(f,{audience:"owner-only"})),target=reviewedFields(owner,null);
  assert.ok(makePublicationPlan(owner,null,target,[],access).eligible);
  assert.ok(makePublicationPlan(parsePublication(input(f)),null,f,[],access).blockers.includes("CATALOG_VIEW_ONLY_NOT_EXECUTABLE"));
  const old=snapshot({...f,user_access:"view_only"}),base={revision:old.revision,hash:publicationHash(old.fields)};
  assert.ok(makePublicationPlan(parsePublication(input(f,{audience:"owner-only",baseline:base})),old,target,[],{...access,previous:access.target}).blockers.includes("CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW"));
});
test("a self-use quote requires server-authenticated proof and never permits a card-level display restriction",()=>{
  const agent={...fields({category:"自用"}),id,config_revision:1};const model={id:agent.model_id,is_active:true,deep_thinking_type:0};
  const snapshot={actor:{id:"fixture",role:"admin",is_active:true},agent,model,skills:[],settings:[],readsVerified:true as const};
  const body={agentId:id,messages:[{role:"user",content:"hello"}]};
  assert.throws(()=>assertStandardQuoteEligibility(body,snapshot,"fixture"),/SELECTION_UNSUPPORTED/);
  assert.doesNotThrow(()=>assertStandardQuoteEligibility(body,{...snapshot,ownerSelfUseQuote:true},"fixture"));
  assert.doesNotThrow(()=>assertStandardQuoteEligibility(body,{...snapshot,ownerSelfUseQuote:true,agent:{...agent,user_access:"hidden"}},"fixture"));
  assert.throws(()=>assertStandardQuoteEligibility(body,{...snapshot,ownerSelfUseQuote:true,agent:{...agent,user_access:"view_only"}},"fixture"),/SELECTION_UNSUPPORTED/);
});
test("ordinary director edits preserve genuine production activation time across environments",()=>{
  const actual="2026-10-20T00:00:00.000Z",local="2026-10-22T00:00:00.000Z";
  const prompt="storyboard_director_contract.v2 storyboard_director_plan.v1 storyboard_performance.v1";
  const style={production_contract_version:"storyboard_director_contract.v2",production_contract_activated_at:actual};
  const f=fields({system_prompt:prompt,output_style:{...style,production_contract_activated_at:local,language:"zh"}});
  const raw=input(f),req=parsePublication({...raw,source:{...raw.source,id:"agent-1786633444187-594spj"}});
  const before=snapshot(fields({system_prompt:prompt,output_style:style}));
  assert.deepEqual(reviewedFields(req,before).output_style,{...style,language:"zh"});
});
test("the ordinary local QA process and interactive cloud profile can never dispatch a production publication",()=>{
  const production={NODE_ENV:"production"};
  assert.doesNotThrow(()=>requirePublicationDestination(production,"formal.example"));
  for(const [env,host] of [[production,"127.0.0.1"],[{...production,LOCAL_ACCEPTANCE_PREVIEW:"true"},"formal.example"],[{...production,LOCAL_RUNTIME_PROFILE:"formal-local-shared"},"formal.example"],[{NODE_ENV:"development"},"formal.example"]] as const)assert.throws(()=>requirePublicationDestination(env,host),/DESTINATION_REQUIRED/);
});
test("the native data publication permission is scoped to its two methods and exact resource path",()=>{
  const path="/api/admin/agent-catalog-publications";
  assert.deepEqual(adminRequirementForRequest(path,"GET"),{permission:"backups.manage",requireStepUp:true,operation:"agent_catalog_publication_read"});
  assert.deepEqual(adminRequirementForRequest(path,"POST"),{permission:"backups.manage",requireStepUp:true,operation:"agent_catalog_publication"});
  for(const method of ["PUT","DELETE","PATCH"])assert.notEqual(adminRequirementForRequest(path,method)?.operation,"agent_catalog_publication");
  assert.notEqual(adminRequirementForRequest(path+"/other","POST")?.operation,"agent_catalog_publication");
});
test("catalog-only is explicit, unbound for every role, preserves approved business data and cannot make a hidden source public",async()=>{
  const source=fields(),request=parsePublication(input(source,{lifecycle:"catalog-only",stripPortability:["PRIVATE_AGENT_PROXY"]}));
  const parked=reviewedFields(request,null),plan=makePublicationPlan(request,null,parked,[]);
  assert.equal(parked.category,source.category);assert.equal(parked.system_prompt,source.system_prompt);
  assert.deepEqual([parked.is_active,parked.user_access,parked.model_id,parked.model],[false,"view_only",null,""]);
  assert.deepEqual(plan.proposedModel,{id:source.model_id,name:source.model});assert.ok(isUnboundCatalogAgent(parked));
  assert.equal(reviewedFields(parsePublication(input(fields({user_access:"hidden"}),{lifecycle:"catalog-only"})),null).user_access,"hidden");
  assert.ok(!isUnboundCatalogAgent(source));assert.equal(parsePublication(input()).lifecycle,"executable");
  assert.throws(()=>parsePublication(input(source,{stripPortability:["PRIVATE_AGENT_PROXY"]})),/STRIPPING/);
  assert.throws(()=>parsePublication(input(source,{lifecycle:"catalog-only",stripPortability:["SKILL_REFERENCE"]})),/STRIPPING/);
  let otherReads=0;const unused=async()=>{otherReads++;return [];};
  await assert.rejects(()=>readStandardSnapshot({readAgent:async()=>[parked],readModel:unused,readSettings:unused,readActor:unused,readSkills:unused},"actor",id),/LLM_QUOTE_AGENT_MODEL_NOT_CONFIGURED/);
  assert.equal(otherReads,0);
});
test("bound director review pins the previous revision and both complete projections",()=>{
  const oldHash="e4a1cb0a4f0c7360e597f9ce0b200c51bfc200b9bbd5730ef1933e7fa02d64e0";
  const nextHash="ff7387aa0c1ab87aecd885f84c546ebd6499b49da2967f7ade0bb2c11f49c027";
  const {agentId}=REVIEWED_TEXT_HISTORY;
  assert.equal(isReviewedDirectorRebind(agentId,2,oldHash,nextHash),true);
  for(const [card,revision,before,after] of [[id,2,oldHash,nextHash],[agentId,3,oldHash,nextHash],
    [agentId,2,nextHash,nextHash],[agentId,2,oldHash,oldHash]] as const){
    assert.equal(isReviewedDirectorRebind(card,revision,before,after),false);
  }
  const old=snapshot(fields({model:"deepseek-v4-flash",model_id:"705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd",
    is_active:false,user_access:"view_only"}));
  const next=fields({model:"deepseek-flash",model_id:REVIEWED_TEXT_HISTORY.modelId});
  const request=parsePublication(input(next,{baseline:{revision:old.revision,hash:publicationHash(old.fields)}}));
  const proof={source:REVIEWED_TEXT_HISTORY.source,checkedAt:REVIEWED_TEXT_HISTORY.checkedAt,
    auditId:"00000000-0000-4000-8000-000000000001",auditCreatedAt:"2026-11-04T00:00:00.000Z"};
  assert.ok(makePublicationPlan(request,old,next,[],{},proof).blockers.includes("CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW"));
  assert.throws(()=>parsePublication({...input(next),reviewedModelAdmission:proof}),/UNAPPROVED|INVALID|FIELDS/u);
});

test("the reviewed r2 channel read projects only the stable ID and rejects any alternate route",async()=>{
  const row:Record<string,unknown>={id:REVIEWED_TEXT_HISTORY.agentId,config_revision:2,source:"llm",is_active:false,user_access:"view_only",
    deleted_at:null,model:"deepseek-v4-flash",model_id:"705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd",proxy_url:"https://api.deepseek.com",
    enable_knowledge_base:false,bot_id:null,knowledge_base_id:null,coze_coding_api_token:"",coze_coding_api_url:null,coze_coding_project_id:""};
  const read=async(changes:Record<string,unknown>,endpoint:unknown="https://api.deepseek.com/")=>{
    const source={...row,...changes};
    let match=true;
    const query={
      select(columns:string){assert.equal(columns,"id");return this;},
      eq(key:string,value:unknown){match=match&&source[key]===value;return this;},
      is(key:string,value:unknown){return this.eq(key,value);},
      or(filter:string){
        const allowed=filter.match(/^([a-z_]+)\.is\.null,\1\.(is\.false|eq\."")$/u);
        assert.ok(allowed);
        const value=source[allowed[1]];
        match=match && (value===null || value===(allowed[2]==="is.false"?false:""));
        return this;
      },
      async maybeSingle(){return {data:match?{id:source.id}:null,error:null};},
    };
    const db={from(name:string){assert.equal(name,"agents");return query;}};
    return hasReviewedDirectorChannel(db as unknown as Parameters<typeof hasReviewedDirectorChannel>[0],endpoint);
  };
  assert.ok(await read({}));
  assert.ok(await read({enable_knowledge_base:null,bot_id:"",coze_coding_api_token:null,coze_coding_api_url:""}));
  for(const key of ["bot_id","knowledge_base_id","coze_coding_api_token","coze_coding_api_url","coze_coding_project_id"])
    assert.equal(await read({[key]:"fixture-nonempty"}),false);
  for(const changes of [{id:"agent-other"},{config_revision:3},{model_id:"other"},{model:"other"},{is_active:true},{user_access:"hidden"},
    {source:"other"},{deleted_at:"2026-11-04"},{enable_knowledge_base:true},{proxy_url:"https://other.invalid"}])
    assert.equal(await read(changes),false);
  assert.equal(await read({},"https://other.invalid"),false);
});

test("owner index validates count, strict order, full scope and whitelisted metadata before declaring completeness",()=>{
  const row={id:"a",revision:3,sourceHash:"a".repeat(64),promptHash:"b".repeat(64),deleted:false,isActive:true,userAccess:"hidden",category:"引流带货",portability:[]};
  const entries=[row,{...row,id:"z",deleted:true}],base={schema:"agent-catalog-production-index.v1",complete:true,observedAt:"2026-11-03T10:00:00Z",database:{database:"fixture",oid:"123"},totalCount:2,counts:{active:1,hidden:1,tombstones:1},entries};
  assert.equal(checkedPublicationIndex(base).inventoryHash,publicationHash(entries));
  for(const bad of [{...base,totalCount:1},{...base,complete:false},{...base,entries:[row,row]},{...base,entries:[...entries].reverse()},
    {...base,counts:{active:2,hidden:1,tombstones:1}},{...base,entries:[{...row,system_prompt:"fixture"},entries[1]]}]){
    assert.throws(()=>checkedPublicationIndex(bad),/INDEX_INCOMPLETE/);
  }
});
test("private category visibility is authoritative in plans; view-only is display-only independently of the proposed model",()=>{
  const old=snapshot(fields({category:"客户研究室",user_access:"available"})),f=fields();
  const req=parsePublication(input(f,{baseline:{revision:old.revision,hash:publicationHash(old.fields)}}));
  const visibility={previous:{visibility:"private"},target:{visibility:"normal"}};
  assert.ok(makePublicationPlan(req,old,f,[],visibility).blockers.includes("CATALOG_AUDIENCE_BROADENING_REQUIRES_NATIVE_REVIEW"));
  assert.ok(makePublicationPlan(req,old,{...f,user_access:"hidden"},[],visibility).eligible);
  assert.ok(makePublicationPlan(req,old,f,[],{previous:{visibility:"view_only"},target:{visibility:"normal"}}).blockers.includes("CATALOG_VIEW_ONLY_PROMOTION_REQUIRES_NATIVE_REVIEW"));
  assert.ok(makePublicationPlan(req,null,{...f,user_access:"view_only"},[]).blockers.includes("CATALOG_VIEW_ONLY_NOT_EXECUTABLE"));
  assert.ok(makePublicationPlan(req,null,f,[],{target:{visibility:"view_only"}}).blockers.includes("CATALOG_VIEW_ONLY_NOT_EXECUTABLE"));
  assert.throws(()=>parsePublication(input(fields({user_access:"view_only"}),{audience:"owner-only",lifecycle:"executable"})),/VIEW_ONLY_NOT_EXECUTABLE/);
});
