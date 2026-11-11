#!/usr/bin/env node
// Pure local database verification; all fixtures and gate changes roll back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
const runtime = JSON.parse((await readFile(process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true); assert.equal(runtime.ownerConnection?.host, "127.0.0.1"); assert.equal(Number(runtime.ownerConnection?.port), 54322); assert.equal(runtime.ownerConnection?.database, "zimeiti_local");
const db = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-publishing-v2-rollback-verifier", connectionTimeoutMillis: 10000, query_timeout: 120000 });
const user = randomUUID(), other = randomUUID(), planId = randomUUID();
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push({ name, passed: true }); };
const mutate = async (owner, input) => (await db.query("SELECT public.mutate_publish_v2_atomic($1::text,$2::jsonb) AS result", [owner, JSON.stringify(input)])).rows[0].result;
let point = 0;
async function rejects(name, code, fn) {
 const marker = `v2_test_${++point}`; await db.query(`SAVEPOINT ${marker}`); let observed = "NO_ERROR";
 try { await fn(); } catch (error) { observed = `${String(error.code || "UNKNOWN")}: ${String(error.message || "").slice(0,180)}`; await db.query(`ROLLBACK TO SAVEPOINT ${marker}`); }
 await db.query(`RELEASE SAVEPOINT ${marker}`); assert.ok(observed.includes(code),`${name}: expected ${code}; observed ${observed}`); check(name,true);
}
await db.connect(); let open = false;
try {
 const identity = (await db.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0]; assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });
 await db.query("BEGIN"); open = true; await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SELECT set_config('app.member_permission_write','on',true)");
 for (const [index, owner] of [user, other].entries()) {
  const suffix = owner.replaceAll("-", "");
  await db.query("INSERT INTO public.users(id,username,email,phone,password_hash,display_name,role,is_active,status,cash_balance,credits) VALUES($1::text,$2,$3,$4,'local-unusable-password-hash','发布V2回滚验收','student',true,'active',100,0)", [owner, `pub2-${suffix}`, `pub2-${suffix}@fixture.invalid`, `17${suffix.replace(/\D/g, "").padEnd(9, String(index)).slice(0,9)}`]);
  await db.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,'[\"publish_center\"]','[]',1,public.member_permission_checksum($1::text,'[\"publish_center\"]','[]',1),'custom','v2 rollback fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys=EXCLUDED.agent_navigation_keys,revision=1,checksum=EXCLUDED.checksum", [owner]);
 }
 await db.query("INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,operator_links,enabled_platforms) SELECT max(version)+1,true,true,'{}','[\"xhs\",\"wxSph\",\"douyin\"]' FROM public.pub_config_versions");
 await db.query("INSERT INTO public.pub_plan_versions(id,version,name,price_cents,quota,valid_days,platforms,enabled) VALUES($1::uuid,1,'v2 rollback fixture',125,8,1,'[\"xhs\",\"wxSph\",\"douyin\"]',true)", [planId]);
 const purchase = (await db.query("SELECT public.purchase_publish_package_atomic($1::text,$2::uuid,1,'v2-purchase-fixture',$3::text) AS result", [user, planId, createHash("sha256").update("v2-fixture").digest("hex")])).rows[0].result;
 const account = (await db.query("SELECT public.save_publish_account_atomic($1::text,'xhs','v2-account','回滚账号',NULL) AS result", [user])).rows[0].result;
 const collection = (await mutate(user, { action: "save-collection", expectedRevision: 0, name: "内容集合", description: "持久字段回滚验收", archived: false })).row;
 const group = (await mutate(user, { action: "save-group", expectedRevision: 0, name: "账号组", accountIds: [account.id] })).row;
 check("collections and account groups persist their intended fields", collection.name === "内容集合" && group.account_ids[0] === account.id);
 await rejects("foreign account cannot be added to a group", "PUBLISH_ACCOUNT_NOT_FOUND", () => mutate(other, { action: "save-group", expectedRevision: 0, name: "invalid", accountIds: [account.id] }));
 const targetId = randomUUID();
 const payload = { schemaVersion: 2, collectionId: collection.id, contentType: "image", title: "原始标题", body: "回滚正文", topics: ["主题"], media: [{ id: randomUUID(), role: "image", fileName: "image.png", size: 20, type: "image/png", lastModified: 1, source: "local_file", requiresReselection: true }], targets: [{ id: targetId, accountId: account.id, platform: "xhs", options: { declaration: 3 }, scheduledAt: null }] };
 payload.targets[0].coverMediaId=payload.media[0].id;
 const draft = (await mutate(user, { action: "save-draft", expectedRevision: 0, draft: payload })).row;
 await rejects("raw RPC requires an explicit expected revision", "PUBLISH_INPUT_INVALID", () => mutate(user, { action: "save-collection", name: "invalid", description: "", archived: false }));
 await rejects("raw RPC rejects empty collection names", "PUBLISH_INPUT_INVALID", () => mutate(user, { action: "save-collection", expectedRevision: 0, name: " ", description: "", archived: false }));
 await rejects("raw RPC refuses fractional media size", "PUBLISH_INPUT_INVALID", () => mutate(user, { action: "save-draft", expectedRevision: 0, draft: { ...payload, media: [{ ...payload.media[0], size: 0.5 }] } }));
 await rejects("raw RPC refuses undeclared native credential fields", "PUBLISH_INPUT_INVALID", () => mutate(user, { action: "save-draft", expectedRevision: 0, draft: { ...payload, targets: [{ ...payload.targets[0], options: { cookie: "synthetic-fixture" } }] } }));
 await rejects("raw RPC refuses impossible native schedule dates", "PUBLISH_INPUT_INVALID", () => mutate(user, { action: "save-draft", expectedRevision: 0, draft: { ...payload, targets: [{ ...payload.targets[0], scheduledAt: "2030-13-40T00:00:00Z" }] } }));
 await rejects("foreign draft cannot be edited", "PUBLISH_DRAFT_NOT_FOUND", () => mutate(other, { action: "save-draft", id: draft.id, expectedRevision: 1, draft: payload }));
 await rejects("stale draft revision cannot overwrite immutable content", "PUBLISH_REVISION_CONFLICT", () => mutate(user, { action: "save-draft", id: draft.id, expectedRevision: 0, draft: payload }));
 const batchInput = { action: "create-batch", draftId: draft.id, draftVersion: 1, targetIds: [targetId], idempotencyKey: "v2-batch-fixture" };
 const batch = (await mutate(user, batchInput)).row;
 const replayBatch = await mutate(user, batchInput); check("batch creation is idempotent and freezes account revision", replayBatch.row.id === batch.id && replayBatch.alreadyFulfilled && !!batch.account_snapshots[0].updatedAt);
 await mutate(user, { action: "save-draft", id: draft.id, expectedRevision: 1, draft: { ...payload, title: "后来的标题" } });
 await db.query("UPDATE public.pub_accounts SET updated_at=clock_timestamp()+interval '1 second' WHERE id=$1::uuid", [account.id]);
 const claimInput = { action: "claim", batchId: batch.id, targetId, entitlementId: purchase.entitlement.id, idempotencyKey: "v2-claim-fixture" };
 await rejects("changed browser account revision refuses a permit", "PUBLISH_V2_ACCOUNT_CHANGED", () => mutate(user, claimInput));
 const freshBatch = (await mutate(user, { ...batchInput, idempotencyKey: "v2-batch-fresh" })).row;
 const first = await mutate(user, { ...claimInput, batchId: freshBatch.id });
 const replay = await mutate(user, { ...claimInput, batchId: freshBatch.id });
 check("claim freezes original version and native options without a second permit", first.shouldExecute === true && replay.shouldExecute === false && first.row.id === replay.row.id && first.row.snapshot.draft.title === "原始标题" && first.row.snapshot.target.options.declaration === 3 && /^[a-f0-9]{64}$/.test(first.row.snapshot_hash));
 check("quota debited exactly once", Number((await db.query("SELECT used FROM public.pub_entitlements WHERE id=$1::uuid", [purchase.entitlement.id])).rows[0].used) === 1);
 const failureBatch=(await mutate(user,{...batchInput,idempotencyKey:"v2-attempt-failure-batch"})).row;
 await db.query("ALTER TABLE public.pub2_attempts ADD CONSTRAINT pub2_fixture_attempt_failure CHECK(request_key <> 'v2-forced-insert-failure')");
 await rejects("attempt insert failure rejects after quota update", "pub2_fixture_attempt_failure", ()=>mutate(user,{...claimInput,batchId:failureBatch.id,idempotencyKey:"v2-forced-insert-failure"}));
 check("attempt insertion failure rolls back quota and leaves no attempt",Number((await db.query("SELECT used FROM public.pub_entitlements WHERE id=$1::uuid",[purchase.entitlement.id])).rows[0].used)===1 && Number((await db.query("SELECT count(*) FROM public.pub2_attempts WHERE user_id=$1::text AND request_key='v2-forced-insert-failure'",[user])).rows[0].count)===0);
 await db.query("ALTER TABLE public.pub2_attempts DROP CONSTRAINT pub2_fixture_attempt_failure");
 const secondAccount = (await db.query("SELECT public.save_publish_account_atomic($1::text,'xhs','v2-account-2','回滚账号乙',NULL) AS result", [user])).rows[0].result;
 const clipA={...payload.media[0],id:randomUUID(),role:"video",type:"video/mp4"},clipB={...clipA,id:randomUUID()},coverA={...payload.media[0],id:randomUUID(),role:"cover"},coverB={...coverA,id:randomUUID()};
 const videoTargets=[{...payload.targets[0],id:randomUUID(),mediaIds:[clipA.id],coverMediaId:coverA.id,topicsOverride:["甲"]},{...payload.targets[0],id:randomUUID(),accountId:secondAccount.id,mediaIds:[clipB.id],coverMediaId:coverB.id,topicsOverride:["乙"]}];
 const videoDraft=(await mutate(user,{action:"save-draft",expectedRevision:0,draft:{...payload,contentType:"video",media:[clipA,clipB,coverA,coverB],targets:videoTargets}})).row;
 const videoBatch=(await mutate(user,{action:"create-batch",draftId:videoDraft.id,draftVersion:1,targetIds:videoTargets.map(item=>item.id),idempotencyKey:"v2-video-pool-batch"})).row;
 const videoAttempts=[];
 for(const [index,videoTarget] of videoTargets.entries()) videoAttempts.push(await mutate(user,{action:"claim",batchId:videoBatch.id,targetId:videoTarget.id,entitlementId:purchase.entitlement.id,idempotencyKey:`v2-video-pool-${index}`}));
 check("multi-video pool freezes independent clip and cover selectors per target",videoAttempts.every(item=>item.shouldExecute && item.row.snapshot.draft.media.length===4) && videoAttempts[0].row.snapshot.target.mediaIds[0]===clipA.id && videoAttempts[1].row.snapshot.target.mediaIds[0]===clipB.id && videoAttempts[1].row.snapshot.target.coverMediaId===coverB.id);
 await rejects("different key cannot claim the same batch target again", "PUBLISH_V2_TARGET_ALREADY_CLAIMED", () => mutate(user, { ...claimInput, batchId: freshBatch.id, idempotencyKey: "v2-second-permit" }));
 await rejects("foreign batch cannot consume another owner's quota", "PUBLISH_V2_BATCH_NOT_FOUND", () => mutate(other, { ...claimInput, batchId: freshBatch.id, idempotencyKey: "v2-cross-owner" }));
 await rejects("immutable draft version cannot be edited", "PUBLISH_V2_IMMUTABLE", () => db.query("UPDATE public.pub2_draft_versions SET payload='{}' WHERE draft_id=$1::uuid", [draft.id]));
 await rejects("immutable attempt cannot be edited", "PUBLISH_V2_IMMUTABLE", () => db.query("UPDATE public.pub2_attempts SET snapshot='{}' WHERE id=$1::uuid", [first.row.id]));
 const eventInput = { action: "report", attemptId: first.row.id, idempotencyKey: "v2-report-fixture", success: true, workId: "browser-only" };
 const event = await mutate(user, eventInput); const eventAgain = await mutate(user, eventInput);
 check("reports are append-only browser evidence and idempotent", event.row.source === "browser_reported" && event.row.id === eventAgain.row.id);
 await rejects("conflicting report cannot rewrite history", "PUBLISH_RECEIPT_CONFLICT", () => mutate(user, { ...eventInput, idempotencyKey: "v2-conflicting-report", success: false }));
 const future = new Date(Date.now()+86400000).toISOString();
 const schedule = (await mutate(user, { action: "save-schedule", draftId: draft.id, draftVersion: 2, targetId, scheduledAt: future })).row;
 const later = (await mutate(user, { action: "reschedule", id: schedule.id, expectedRevision: 1, scheduledAt: new Date(Date.now()+172800000).toISOString() })).row;
 await mutate(user, { action: "cancel-schedule", id: schedule.id, expectedRevision: later.revision });
 await rejects("cancelled local plan cannot be rescheduled", "PUBLISH_V2_SCHEDULE_LOCKED", () => mutate(user, { action: "reschedule", id: schedule.id, expectedRevision: 3, scheduledAt: future }));
 const cancelledBatch=(await mutate(user,{action:"create-batch",draftId:draft.id,draftVersion:2,targetIds:[targetId],idempotencyKey:"v2-cancelled-plan-batch"})).row;
 const cancelledClaim={action:"claim",batchId:cancelledBatch.id,targetId,entitlementId:purchase.entitlement.id,idempotencyKey:"v2-cancelled-plan-claim"};
 await rejects("explicitly cancelled plan cannot be executed", "PUBLISH_V2_SCHEDULE_LOCKED", ()=>mutate(user,{...cancelledClaim,scheduleId:schedule.id}));
 const manual=(await mutate(user,cancelledClaim));
 check("manual publish ignores a cancelled reminder and does not complete it",manual.shouldExecute && manual.row.snapshot.localSchedule===null && (await db.query("SELECT state FROM public.pub2_schedules WHERE id=$1::uuid",[schedule.id])).rows[0].state==="cancelled");
 await rejects("manual and scheduled intent under one key cannot share a permit","PUBLISH_IDEMPOTENCY_CONFLICT",()=>mutate(user,{...cancelledClaim,scheduleId:schedule.id}));
 const thirdVersion=(await mutate(user,{action:"save-draft",id:draft.id,expectedRevision:2,draft:payload})).row;
 const futureSchedule=(await mutate(user,{action:"save-schedule",draftId:draft.id,draftVersion:thirdVersion.revision,targetId,scheduledAt:future})).row;
 const futureBatch=(await mutate(user,{action:"create-batch",draftId:draft.id,draftVersion:thirdVersion.revision,targetIds:[targetId],idempotencyKey:"v2-future-plan-batch"})).row;
 const futureClaim={action:"claim",batchId:futureBatch.id,targetId,entitlementId:purchase.entitlement.id,idempotencyKey:"v2-future-plan-claim"};
 await rejects("explicit future plan cannot be executed before it is due","PUBLISH_V2_SCHEDULE_NOT_DUE",()=>mutate(user,{...futureClaim,scheduleId:futureSchedule.id}));
 const manualFuture=await mutate(user,futureClaim);
 check("manual publish leaves an unrelated future reminder planned",manualFuture.shouldExecute && manualFuture.row.snapshot.localSchedule===null && (await db.query("SELECT state FROM public.pub2_schedules WHERE id=$1::uuid",[futureSchedule.id])).rows[0].state==="planned");
 const dueVersion=(await mutate(user,{action:"save-draft",id:draft.id,expectedRevision:thirdVersion.revision,draft:payload})).row;
 const dueSchedule=(await mutate(user,{action:"save-schedule",draftId:draft.id,draftVersion:dueVersion.revision,targetId,scheduledAt:future})).row;
 await db.query("UPDATE public.pub2_schedules SET scheduled_at=now()-interval '1 minute' WHERE id=$1::uuid",[dueSchedule.id]);
 const dueBatch=(await mutate(user,{action:"create-batch",draftId:draft.id,draftVersion:dueVersion.revision,targetIds:[targetId],idempotencyKey:"v2-due-plan-batch"})).row;
 const dueClaim={action:"claim",batchId:dueBatch.id,targetId,entitlementId:purchase.entitlement.id,scheduleId:dueSchedule.id,idempotencyKey:"v2-due-plan-claim"};
 const dueAttempt=await mutate(user,dueClaim);const dueReplay=await mutate(user,dueClaim);
 check("explicit due plan is frozen and marked claimed exactly once",dueAttempt.shouldExecute && !dueReplay.shouldExecute && dueAttempt.row.snapshot.localSchedule.id===dueSchedule.id && (await db.query("SELECT state FROM public.pub2_schedules WHERE id=$1::uuid",[dueSchedule.id])).rows[0].state==="claimed");
 await rejects("executed local plan cannot be rescheduled","PUBLISH_V2_SCHEDULE_LOCKED",()=>mutate(user,{action:"reschedule",id:dueSchedule.id,expectedRevision:2,scheduledAt:future}));
 await rejects("unowned main-site asset reference is refused", "PUBLISH_V2_ASSET_UNAVAILABLE", () => mutate(user, { action: "save-draft", expectedRevision: 0, draft: { ...payload, media: [{ ...payload.media[0], source: "main_asset", requiresReselection: false, reference: { kind: "image_asset", id: randomUUID() } }] } }));
 await rejects("anonymous role cannot invoke V2 mutation", "permission denied", async () => { await db.query("SET LOCAL ROLE anon"); await mutate(user, batchInput); });
 await db.query("ROLLBACK"); open = false;
 check("all temporary fixture users are rolled back", Number((await db.query("SELECT count(*) FROM public.users WHERE id::text=ANY($1::text[])", [[user,other]])).rows[0].count) === 0);
 process.stdout.write(`${JSON.stringify({ status: "passed", scope: "v2-local-rollback-only", externalCalls: 0, concurrentExecutionTested: false, checks }, null, 2)}\n`);
} catch(error) {
 const failure={code:String(error.code || "UNKNOWN"),message:String(error.message || "").slice(0,240)};
 process.stdout.write(`${JSON.stringify({status:"failed",scope:"v2-local-rollback-only",externalCalls:0,concurrentExecutionTested:false,checks,error:failure,rollbackPending:open},null,2)}\n`);
 throw new Error(`PUBLISH_V2_LOCAL_TEST_FAILED ${failure.code}: ${failure.message}`);
}
finally {
 if (open) {
  await db.query("ROLLBACK");
  const remaining=Number((await db.query("SELECT count(*) FROM public.users WHERE id::text=ANY($1::text[])",[[user,other]])).rows[0].count);
  process.stdout.write(`${JSON.stringify({cleanupStatus:remaining===0?"rolled_back":"UNKNOWN",remainingFixtureUsers:remaining})}\n`);
 }
 await db.end();
}
