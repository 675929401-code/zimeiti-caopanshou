#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-invitation-security-guard",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});
const tag = `${Date.now()}${crypto.randomInt(1000, 9999)}`;
const phone = (offset) => `199${String((Number(tag.slice(-8)) + offset) % 100000000).padStart(8, "0")}`;
const codeValue = () => crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
const passwordHash = "$2b$10$codexInvitationSecurityFixtureOnly00000000000000000000";
const report = {
  passed: false,
  checkedAt: "",
  target: "127.0.0.1:54322/zimeiti_local",
  assertions: {},
  productionWrites: 0,
  paidCalls: 0,
};

await client.connect();
let open = false;
try {
  const admin = (await client.query(
    `SELECT id FROM public.users
     WHERE role='admin' AND coalesce(is_active,true) AND coalesce(status,'active')='active'
     ORDER BY created_at LIMIT 1`,
  )).rows[0];
  assert.ok(admin?.id, "LOCAL_ACTIVE_ADMIN_REQUIRED");
  await client.query("BEGIN");
  open = true;

  const inviterId = crypto.randomUUID();
  await client.query(
    `INSERT INTO public.users (
       id,username,password_hash,display_name,role,credits,cash_balance,is_active,status,
       member_status,member_expires_at,allowed_categories,phone,email,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'student',0,0,true,'active','active',now()+interval '1 year','[]'::jsonb,$5,$6,now(),now())`,
    [inviterId, `guard_inviter_${tag}`, passwordHash, "邀请码风控验收邀请人", phone(1), `guard-inviter-${tag}@qq.com`],
  );

  const policy4 = (await client.query(
    "SELECT public.set_invitation_security_policy_atomic($1,4,$2) AS result",
    [admin.id, `guard-policy-4:${tag}`],
  )).rows[0].result;
  assert.equal(policy4.success, true);
  assert.equal(Number(policy4.monthly_code_limit), 4);

  const firstFour = [];
  for (let index = 0; index < 4; index += 1) {
    const generated = (await client.query(
      "SELECT public.create_one_time_invitation_code($1::uuid) AS result",
      [inviterId],
    )).rows[0].result;
    assert.equal(generated.ok, true);
    assert.equal(Number(generated.issued_this_month), index + 1);
    firstFour.push(generated.code.code);
    await client.query(
      "UPDATE public.invitation_codes SET is_used=true,used_at=clock_timestamp() WHERE id=$1",
      [generated.code.id],
    );
  }
  assert.equal(new Set(firstFour).size, 4, "FOUR_DISTINCT_CODES_REQUIRED");
  const limited = (await client.query(
    "SELECT public.create_one_time_invitation_code($1::uuid) AS result",
    [inviterId],
  )).rows[0].result;
  assert.equal(limited.ok, false);
  assert.equal(limited.code, "INVITATION_MONTHLY_LIMIT");
  assert.equal(Number(limited.remaining_this_month), 0);
  report.assertions.monthlyFourCodeLimitIsDatabaseEnforced = true;

  const policy6 = (await client.query(
    "SELECT public.set_invitation_security_policy_atomic($1,6,$2) AS result",
    [admin.id, `guard-policy-6:${tag}`],
  )).rows[0].result;
  assert.equal(policy6.success, true);
  const riskCode1 = (await client.query(
    "SELECT public.create_one_time_invitation_code($1::uuid) AS result",
    [inviterId],
  )).rows[0].result;
  assert.equal(riskCode1.ok, true);

  const ipHash = "a".repeat(16);
  const deviceHash = "b".repeat(32);
  await client.query(
    `INSERT INTO public.user_auth_sessions(user_id,session_id,ip_hash,user_agent_hash,created_at,expires_at)
     VALUES($1,$2,$3,$4,now(),now()+interval '3 days')`,
    [inviterId, crypto.randomBytes(32).toString("hex"), ipHash, "c".repeat(32)],
  );
  const registration1 = (await client.query(
    "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      `guard-invitee-1-${tag}@qq.com`, phone(2), `guard_invitee_1_${tag}`, passwordHash,
      "邀请码风控验收新人一", riskCode1.code.code, crypto.randomBytes(32).toString("hex"), ipHash, deviceHash,
    ],
  )).rows[0].result;
  assert.equal(registration1.ok, true);
  assert.equal(registration1.risk_status, "review");
  assert.equal(registration1.automatic_trial_eligible, false);
  assert.ok(registration1.risk_reasons.includes("SAME_IP_AS_INVITER"));
  const invitee1Id = String(registration1.user.id);
  const record1 = (await client.query(
    "SELECT * FROM public.invitation_records WHERE invitee_id=$1::uuid",
    [invitee1Id],
  )).rows[0];
  assert.equal(record1.risk_status, "review");
  assert.equal(record1.automatic_trial_eligible, false);
  report.assertions.sameIpSignalPausesAutomaticTrialWithoutBlockingRegistration = true;

  const reused = (await client.query(
    "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      `guard-reuse-${tag}@qq.com`, phone(3), `guard_reuse_${tag}`, passwordHash,
      "邀请码复用拦截", riskCode1.code.code, crypto.randomBytes(32).toString("hex"), ipHash, deviceHash,
    ],
  )).rows[0].result;
  assert.equal(reused.ok, false);
  assert.equal(reused.code, "INVITATION_USED");
  const reusedCount = (await client.query("SELECT count(*)::integer count FROM public.users WHERE phone=$1", [phone(3)])).rows[0].count;
  assert.equal(Number(reusedCount), 0);
  report.assertions.oneCodeCreatesAtMostOneAccount = true;

  const riskCode2 = (await client.query(
    "SELECT public.create_one_time_invitation_code($1::uuid) AS result",
    [inviterId],
  )).rows[0].result;
  assert.equal(riskCode2.ok, true);
  const registration2 = (await client.query(
    "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      `guard-invitee-2-${tag}@qq.com`, phone(4), `guard_invitee_2_${tag}`, passwordHash,
      "邀请码风控验收新人二", riskCode2.code.code, crypto.randomBytes(32).toString("hex"), ipHash, deviceHash,
    ],
  )).rows[0].result;
  assert.equal(registration2.ok, true);
  assert.ok(registration2.risk_reasons.includes("SAME_IP_RECENT"));
  assert.ok(registration2.risk_reasons.includes("SAME_DEVICE_RECENT"));
  const record2 = (await client.query(
    "SELECT * FROM public.invitation_records WHERE invitee_id=$1::uuid",
    [String(registration2.user.id)],
  )).rows[0];
  report.assertions.sameDeviceAndRepeatedIpAreAuditableSignals = true;

  const cleared = (await client.query(
    "SELECT public.review_invitation_risk_atomic($1,$2,'cleared',$3,$4) AS result",
    [admin.id, record1.id, "已电话核实：家庭共用网络", `guard-clear:${tag}`],
  )).rows[0].result;
  assert.equal(cleared.success, true);
  const blocked = (await client.query(
    "SELECT public.review_invitation_risk_atomic($1,$2,'blocked',$3,$4) AS result",
    [admin.id, record2.id, "验收：确认异常", `guard-block:${tag}`],
  )).rows[0].result;
  assert.equal(blocked.success, true);
  const reviewedRows = await client.query(
    "SELECT id,risk_status,automatic_trial_eligible FROM public.invitation_records WHERE id=ANY($1::text[]) ORDER BY id",
    [[record1.id, record2.id]],
  );
  const byId = new Map(reviewedRows.rows.map((row) => [row.id, row]));
  assert.equal(byId.get(record1.id).risk_status, "cleared");
  assert.equal(byId.get(record1.id).automatic_trial_eligible, true);
  assert.equal(byId.get(record2.id).risk_status, "blocked");
  assert.equal(byId.get(record2.id).automatic_trial_eligible, false);
  assert.equal((await client.query("SELECT count(*)::integer count FROM public.invitation_risk_reviews WHERE invitation_record_id=ANY($1::text[])", [[record1.id, record2.id]])).rows[0].count, 2);
  report.assertions.humanReviewIsDurableAndAudited = true;

  const lateCode = codeValue();
  await client.query(
    "INSERT INTO public.invitation_codes(user_id,code,is_used,is_permanent) VALUES($1::uuid,$2,false,false)",
    [inviterId, lateCode],
  );
  await client.query("UPDATE public.users SET member_status='inactive' WHERE id=$1", [inviterId]);
  const deniedGeneration = (await client.query(
    "SELECT public.create_one_time_invitation_code($1::uuid) AS result",
    [inviterId],
  )).rows[0].result;
  assert.equal(deniedGeneration.ok, false);
  assert.equal(deniedGeneration.code, "INVITATION_OWNER_INVALID");
  await client.query("SAVEPOINT inactive_owner_consume");
  let ownerGuardRaised = false;
  try {
    await client.query(
      "SELECT public.register_invited_user_secure_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [
        `guard-inactive-owner-${tag}@qq.com`, phone(5), `guard_inactive_${tag}`, passwordHash,
        "无资格邀请人拦截", lateCode, crypto.randomBytes(32).toString("hex"), "d".repeat(16), "e".repeat(32),
      ],
    );
  } catch (error) {
    ownerGuardRaised = String(error.message || "").includes("INVITATION_OWNER_NOT_ELIGIBLE");
    await client.query("ROLLBACK TO SAVEPOINT inactive_owner_consume");
  }
  assert.equal(ownerGuardRaised, true, "INACTIVE_OWNER_CONSUMPTION_MUST_FAIL");
  const untouched = (await client.query("SELECT is_used FROM public.invitation_codes WHERE code=$1", [lateCode])).rows[0];
  assert.equal(untouched.is_used, false);
  report.assertions.onlyActiveFormalMembersCanIssueOrConsumeCodes = true;

  await client.query("ROLLBACK");
  open = false;
  report.passed = true;
  report.checkedAt = new Date().toISOString();
  const evidenceDir = path.resolve(".codex-evidence", "invitation-security-guard");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "database-chain.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (open) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
