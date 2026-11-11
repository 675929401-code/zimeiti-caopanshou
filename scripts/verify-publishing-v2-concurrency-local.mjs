#!/usr/bin/env node
// Isolated committed fixtures only. Requires root's explicit execution switch;
// never invokes a plugin/provider, and restores user/member/config baselines.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
assert.ok(process.argv.includes("--execute-fixtures"), "EXPLICIT_LOCAL_FIXTURE_EXECUTION_REQUIRED");
const runtime = JSON.parse((await readFile(process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u,""));
assert.equal(runtime.localOnly,true); assert.equal(runtime.ownerConnection?.host,"127.0.0.1"); assert.equal(Number(runtime.ownerConnection?.port),54322); assert.equal(runtime.ownerConnection?.database,"zimeiti_local");
assert.notEqual(process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED,"true");
assert.equal(process.env.LOCAL_NAV_ORIGIN,"http://127.0.0.1:5000");
assert.ok(process.env.LOCAL_NAV_ADMIN_TOKEN,"LOCAL_ADMIN_AUTH_REQUIRED");
// A step-up token may only come from the root's real password-unlock workflow;
// this verifier never creates authentication/session records itself.
const gate = await fetch("http://127.0.0.1:5000/api/admin/publishing",{headers:{Authorization:`Bearer ${process.env.LOCAL_NAV_ADMIN_TOKEN}`,...(process.env.LOCAL_ADMIN_STEP_UP_TOKEN?{"x-admin-step-up":process.env.LOCAL_ADMIN_STEP_UP_TOKEN}:{})},redirect:"error",signal:AbortSignal.timeout(15000)});
assert.equal(gate.status,200); assert.equal((await gate.json()).config?.runtimeExecutionEnabled,false);
const config = {...runtime.ownerConnection,application_name:"codex-publishing-v2-concurrency-fixtures",connectionTimeoutMillis:10000,query_timeout:120000};
const db = new pg.Client(config); const peers=[]; const user=randomUUID(),plan=randomUUID();
const checks=[]; const check=(name,condition)=>{assert.ok(condition,name);checks.push({name,passed:true});};
const sha=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mutate=async(client,input)=>(await client.query("SELECT public.mutate_publish_v2_atomic($1::text,$2::jsonb) AS result",[user,JSON.stringify(input)])).rows[0].result;
const realHash=async(client)=>sha({users:(await client.query("SELECT id,role,status,is_active,cash_balance,credits FROM public.users WHERE id<>$1::text ORDER BY id",[user])).rows,members:(await client.query("SELECT user_id,revision,checksum,feature_navigation_keys,agent_navigation_keys FROM public.member_permission_assignments WHERE user_id<>$1::text ORDER BY user_id",[user])).rows});
const configurationHash=async(client)=>sha((await client.query("SELECT * FROM public.pub_config_versions ORDER BY version")).rows);
let prepared=false,open=false,locked=false,version=null,baseline=null,configBaseline=null,cleanupUnknown=false;
await db.connect();
try {
 const identity=(await db.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];assert.deepEqual(identity,{db:"zimeiti_local",host:"127.0.0.1",port:54322});
 await db.query("SELECT pg_advisory_lock(hashtextextended('publish-center:config',0))");locked=true;
 baseline=await realHash(db);configBaseline=await configurationHash(db);
 version=Number((await db.query("SELECT max(version) AS v FROM public.pub_config_versions")).rows[0].v)+1;
 await db.query("BEGIN");open=true;await db.query("SELECT set_config('app.member_permission_write','on',true)");
 const suffix=user.replaceAll("-","");
 await db.query("INSERT INTO public.users(id,username,email,phone,password_hash,display_name,role,is_active,status,cash_balance,credits) VALUES($1::text,$2,$3,$4,'local-unusable-password-hash','发布V2并发验收','student',true,'active',100,0)",[user,`pub2-race-${suffix}`,`pub2-race-${suffix}@fixture.invalid`,`16${suffix.replace(/\D/g,"").padEnd(9,"7").slice(0,9)}`]);
 await db.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,'[\"publish_center\"]','[]',1,public.member_permission_checksum($1::text,'[\"publish_center\"]','[]',1),'custom','v2 temporary concurrency fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys=EXCLUDED.agent_navigation_keys,revision=1,checksum=EXCLUDED.checksum",[user]);
 await db.query("INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,operator_links,enabled_platforms,created_by) VALUES($1::integer,true,true,'{}','[\"xhs\"]',$2::text)",[version,user]);
 await db.query("INSERT INTO public.pub_plan_versions(id,version,name,price_cents,quota,valid_days,platforms,enabled,created_by) VALUES($1::uuid,1,'v2 temporary concurrency fixture',125,3,1,'[\"xhs\"]',true,$2::text)",[plan,user]);
 const purchase=(await db.query("SELECT public.purchase_publish_package_atomic($1::text,$2::uuid,1,'v2-race-purchase',$3::text) AS result",[user,plan,sha("v2-race-purchase")])).rows[0].result;
 const targets=[];
 for(let index=0;index<4;index++) {
  const account=(await db.query("SELECT public.save_publish_account_atomic($1::text,'xhs',$2::text,'临时并发账号',NULL) AS result",[user,`fixture-account-${index}`])).rows[0].result;
  targets.push({id:randomUUID(),accountId:account.id,platform:"xhs",options:{declaration:3},scheduledAt:null});
 }
 const draft=(await mutate(db,{action:"save-draft",expectedRevision:0,draft:{schemaVersion:2,collectionId:null,contentType:"image",title:"并发fixture",body:"临时数据",topics:[],media:[{id:randomUUID(),role:"image",fileName:"fixture.png",size:20,type:"image/png",lastModified:1,source:"local_file",requiresReselection:true}],targets}})).row;
 const batch=(await mutate(db,{action:"create-batch",draftId:draft.id,draftVersion:1,targetIds:targets.map(item=>item.id),idempotencyKey:"v2-race-batch"})).row;
 prepared=true;process.stdout.write(`${JSON.stringify({fixturePrepared:true,userId:user,planId:plan,configVersion:version})}\n`);
 await db.query("COMMIT");open=false;
 for(let index=0;index<2;index++){const peer=new pg.Client(config);await peer.connect();peers.push(peer);}
 const claim=(target,key)=>({action:"claim",batchId:batch.id,targetId:target.id,entitlementId:purchase.entitlement.id,idempotencyKey:key});
 const same=await Promise.all(peers.map(peer=>mutate(peer,claim(targets[0],"v2-race-same-key"))));
 check("two connections sharing a key receive exactly one permit and one immutable attempt",same.filter(item=>item.shouldExecute===true).length===1 && same[0].row.id===same[1].row.id);
 const competing=await Promise.allSettled(peers.map((peer,index)=>mutate(peer,claim(targets[1],`v2-race-different-${index}`))));
 check("different keys cannot execute the same batch target twice",competing.filter(item=>item.status==="fulfilled" && item.value.shouldExecute===true).length===1 && competing.filter(item=>item.status==="rejected" && String(item.reason.message).includes("PUBLISH_V2_TARGET_ALREADY_CLAIMED")).length===1);
 const quotaRace=await Promise.allSettled(peers.map((peer,index)=>mutate(peer,claim(targets[index+2],`v2-race-last-quota-${index}`))));
 check("different targets competing for the final quota receive at most one permit",quotaRace.filter(item=>item.status==="fulfilled" && item.value.shouldExecute===true).length===1 && quotaRace.filter(item=>item.status==="rejected" && String(item.reason.message).includes("PUBLISH_NO_QUOTA")).length===1);
 const entitlement=(await db.query("SELECT used,quota FROM public.pub_entitlements WHERE id=$1::uuid",[purchase.entitlement.id])).rows[0];check("concurrent quota never exceeds the purchased limit",Number(entitlement.used)===3 && Number(entitlement.quota)===3);
 const receipts=await Promise.allSettled(peers.map((peer,index)=>mutate(peer,{action:"report",attemptId:same[0].row.id,idempotencyKey:`v2-race-report-${index}`,success:index===0})));
 check("conflicting browser receipts append at most one immutable report",receipts.filter(item=>item.status==="fulfilled").length===1 && receipts.filter(item=>item.status==="rejected" && String(item.reason.message).includes("PUBLISH_RECEIPT_CONFLICT")).length===1);
} catch(error) {
 const failure={code:String(error.code || "UNKNOWN"),message:String(error.message || "").slice(0,240)};
 process.stdout.write(`${JSON.stringify({status:"failed",scope:"local-v2-isolated-two-connection-fixtures",externalCalls:0,concurrentExecutionTested:false,concurrentExecutionStarted:peers.length===2,checks,error:failure,cleanupPending:prepared},null,2)}\n`);
 throw new Error(`PUBLISH_V2_CONCURRENCY_TEST_FAILED ${failure.code}: ${failure.message}`);
}
finally {
 if(open)await db.query("ROLLBACK").catch(()=>{});
 await Promise.allSettled(peers.map(peer=>peer.end()));
 let cleaner=db;
 try {
  if(prepared) {
   try{await db.query("SELECT 1");}catch{await db.end().catch(()=>{});locked=false;cleaner=new pg.Client(config);await cleaner.connect();const target=(await cleaner.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];assert.deepEqual(target,{db:"zimeiti_local",host:"127.0.0.1",port:54322});await cleaner.query("SELECT pg_advisory_lock(hashtextextended('publish-center:config',0))");locked=true;}
   await cleaner.query("BEGIN");
   try {
    await cleaner.query("SELECT set_config('app.member_permission_write','on',true)");
    // RESTRICT uses a stricter visibility boundary than the remaining NO ACTION
    // foreign keys: remove ledger/cash in their own statements first.
    await cleaner.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=$1::text",[user]);
    await cleaner.query("DELETE FROM public.cash_transactions WHERE user_id=$1::uuid",[user]);
    // Owner-first dependency is deliberate: legal V2 cascades must precede
    // entitlement deletion. Remaining V1 NO ACTION references clear together.
    await cleaner.query(`WITH du AS (DELETE FROM public.users WHERE id=$1::text AND username=$4::text RETURNING id),ac AS (DELETE FROM public.pub_accounts WHERE user_id=$1::text AND EXISTS(SELECT 1 FROM du) RETURNING id),en AS (DELETE FROM public.pub_entitlements WHERE user_id=$1::text AND EXISTS(SELECT 1 FROM du) RETURNING id),pu AS (DELETE FROM public.pub_purchases WHERE user_id=$1::text AND EXISTS(SELECT 1 FROM du) RETURNING id),pl AS (DELETE FROM public.pub_plan_versions WHERE id=$2::uuid AND created_by=$1::text AND EXISTS(SELECT 1 FROM du) RETURNING id),co AS (DELETE FROM public.pub_config_versions WHERE version=$3::integer AND created_by=$1::text AND EXISTS(SELECT 1 FROM du) RETURNING version),wo AS (DELETE FROM public.wallet_operations WHERE user_id=$1::text AND EXISTS(SELECT 1 FROM du) AND (SELECT count(*) FROM pu)>=0 RETURNING id) SELECT (SELECT count(*) FROM du)+(SELECT count(*) FROM ac)+(SELECT count(*) FROM en)+(SELECT count(*) FROM pl)+(SELECT count(*) FROM co)+(SELECT count(*) FROM wo) removed`,[user,plan,version,`pub2-race-${user.replaceAll("-","")}`]);
    await cleaner.query("COMMIT");
   }catch(error){await cleaner.query("ROLLBACK").catch(()=>{});throw error;}
   check("fixture user and all immutable V2 records are removed by legal user cascade",Number((await cleaner.query("SELECT (SELECT count(*) FROM public.users WHERE id=$1::text)+(SELECT count(*) FROM public.pub2_attempts WHERE user_id=$1::text)+(SELECT count(*) FROM public.pub2_draft_versions WHERE user_id=$1::text)+(SELECT count(*) FROM public.wallet_operations WHERE user_id=$1::text) AS remaining",[user])).rows[0].remaining)===0);
   check("original real member permissions and user balances match baseline",await realHash(cleaner)===baseline);
   check("all original configuration versions match baseline",await configurationHash(cleaner)===configBaseline);
  }
 }catch(error){cleanupUnknown=true;process.stdout.write(`${JSON.stringify({status:"failed",checks,cleanupStatus:"UNKNOWN",userId:user,planId:plan,configVersion:version,errorCode:String(error.code||"CLEANUP_UNCONFIRMED"),errorMessage:String(error.message||"").slice(0,240)},null,2)}\n`);}
 finally{if(locked)await cleaner.query("SELECT pg_advisory_unlock(hashtextextended('publish-center:config',0))").catch(()=>{});await cleaner.end().catch(()=>{});if(cleaner!==db)await db.end().catch(()=>{});}
 if(cleanupUnknown)throw new Error("PUBLISH_V2_FIXTURE_CLEANUP_UNKNOWN: inspect the non-secret selectors above");
}
process.stdout.write(`${JSON.stringify({status:"passed",concurrentExecutionTested:true,externalCalls:0,scope:"local-v2-isolated-two-connection-fixtures",checks},null,2)}\n`);
