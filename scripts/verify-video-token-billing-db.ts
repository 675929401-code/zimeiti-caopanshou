import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

async function main() {
// Run only after the migration has been applied by the owning window. Every
// fixture/hold/wallet mutation is inside BEGIN/ROLLBACK; this script never
// applies schema, commits, submits a provider job, or changes an existing balance.
const CONFIRM = "--execute-transaction-rollback-probe";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_ROLLBACK_PROBE_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const connection = {
  ...runtime.ownerConnection,
  ...(typeof runtime.postgresPassword === "string" ? { user: "postgres", password: runtime.postgresPassword } : {}),
  application_name: "codex-video-token-billing-rollback-probe",
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
};
const client = new pg.Client(connection);
const fixtureUserId = randomUUID();
const tag = randomUUID().replace(/-/gu, "");
const stages: string[] = [];
let open = false;
let savepointNumber = 0;
let modelId = "";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
type Json = Record<string, any>;

function fixture(userId: string, name: string, maximum = 6, sale = 2, cost = 1) {
  const requestId = `token-probe-${tag}-${name}`;
  const taskId = `vt_token_probe_${sha(requestId).slice(0, 32)}`;
  const routingHash = sha(`${requestId}:routing`);
  const sales = { "720p:no_reference_video": sale, "720p:reference_video": sale };
  const costs = { "720p:no_reference_video": cost, "720p:reference_video": cost };
  const quote = {
    schema: "video_token_quote.v1", resolution: "720p", pricingClass: "no_reference_video",
    saleYuanPerMillionTokens: sale, costYuanPerMillionTokens: cost,
    priceVersion: `video_token_sale.v1:${JSON.stringify(sales)}`, maxChargeYuan: maximum,
  };
  const routing = {
    schemaVersion: 1, modelId, displayName: "Rollback fixture", provider: "secure_skill_doubao_seedance",
    apiEndpoint: "https://fixture.invalid", protocolType: "secure_skill_doubao_seedance",
    modelName: "doubao-seedance-2-0-260128", durationSeconds: 6, supportsImageInput: true,
    credentialRef: "secret://token-billing-rollback-fixture", configVersion: routingHash,
    apiProtocolConfig: { provider_billing_unit: "token", token_sale_prices_per_million: sales,
      token_cost_prices_per_million: costs },
  };
  const request = {
    schema: "video_generation_request_snapshot.v1", userPrompt: "Rollback billing fixture",
    effectivePrompt: "Rollback billing fixture", promptNormalizations: [], negativePrompt: "",
    referenceAssets: [], targetDurationSeconds: 6, effectiveDurationSeconds: 6,
    aspectRatio: "16:9", resolution: "720p", fps: null, seed: null, generateAudio: false,
    publicModelId: "pm_token_rollback_fixture", routingConfigHash: routingHash,
    adapterVersion: "token-rollback-fixture.v1", providerPayloadHash: sha(`${requestId}:payload`),
  };
  const task = {
    p_task_id: taskId, p_user_id: userId, p_model_id: modelId, p_client_request_id: requestId,
    p_request_fingerprint: sha(`${requestId}:request`), p_billing_price_yuan: maximum,
    p_billing_cost_price_yuan: 0, p_billing_unit: "token", p_billing_quantity: 1,
    p_explicitly_free: false, p_billing_exempt: false,
    p_request_snapshot_hash: sha(`video-generation-request-snapshot:v1:${stable(request)}`),
    p_provider_task_id: `provider-${sha(requestId).slice(0, 24)}`,
    p_task_label: "token-billing-rollback-fixture", p_prompt: request.userPrompt,
    p_aspect_ratio: request.aspectRatio, p_resolution: request.resolution, p_duration_seconds: 6,
  };
  return { task, routing, request, quote };
}
type Fixture = ReturnType<typeof fixture>;
async function reserve(db: pg.Client, f: Fixture) {
  return (await db.query("select public.reserve_video_token_task_v1_atomic($1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb) receipt",
    [f.task, f.routing, f.request, f.quote])).rows[0].receipt as Json;
}
async function usage(db: pg.Client, f: Fixture, total: number, completion = total) {
  return (await db.query("select public.record_video_token_usage_v1_atomic($1,$2,$3,$4::bigint,$5::bigint) receipt",
    [f.task.p_task_id, f.task.p_user_id, f.task.p_provider_task_id, total, completion])).rows[0].receipt as Json;
}
async function settle(db: pg.Client, f: Fixture) {
  return (await db.query("select public.settle_video_token_task_v1_atomic($1,$2,$3,$4,$5::jsonb) receipt",
    [f.task.p_task_id, f.task.p_user_id, f.task.p_provider_task_id, "Rollback-only fixture charge",
      { price_snapshot: { requested_public_model_id: "pm_token_rollback_fixture" } }])).rows[0].receipt as Json;
}
async function imageCharge(amount: number, suffix: string) {
  return (await client.query("select public.apply_wallet_operation_atomic($1,'cash_charge',$2,$3,'Rollback image charge',$4::jsonb) receipt",
    [fixtureUserId, `image-probe:${tag}:${suffix}`, amount, { phase: "image_terminal" }])).rows[0].receipt as Json;
}
async function state(f: Fixture) {
  return (await client.query("select billing_unit,billing_price_yuan::text price,billing_cost_price_yuan::text cost,billing_reserved_yuan::text reserved,billing_token_usage,billing_token_quote,billing_state,status from public.video_tasks where id=$1", [f.task.p_task_id])).rows[0];
}
async function walletCount() {
  return Number((await client.query("select count(*) n from public.wallet_operations where user_id=$1", [fixtureUserId])).rows[0].n);
}
async function expectError(db: pg.Client, run: () => Promise<unknown>, code: string, message?: string) {
  const point = `expected_${++savepointNumber}`;
  await db.query(`savepoint ${point}`);
  let actual: any;
  try { await run(); } catch (error) { actual = error; }
  await db.query(`rollback to savepoint ${point}`);
  await db.query(`release savepoint ${point}`);
  assert.equal(actual?.code, code, message || "EXPECTED_SQLSTATE");
  if (message) assert.ok(String(actual.message).includes(message), message);
}
async function scenario(name: string, run: () => Promise<void>) {
  const point = `scenario_${++savepointNumber}`;
  await client.query(`savepoint ${point}`);
  try { await run(); stages.push(name); }
  finally { await client.query(`rollback to savepoint ${point}`); await client.query(`release savepoint ${point}`); }
}

async function createIsolatedUser() {
  const fields = (await client.query("select column_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='users' order by ordinal_position")).rows;
  const values: Json = {
    id: fixtureUserId, username: `e2e_token_${tag}`, email: `e2e-token-${tag}@fixture.invalid`,
    display_name: "Token rollback fixture",
    password: sha(`unused-fixture-password:${tag}`), password_hash: sha(`unused-fixture-password:${tag}`),
    role: "student", status: "active", is_active: true, credits: 0, cash_balance: 10,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const columns: string[] = [];
  for (const field of fields) {
    if (Object.hasOwn(values, field.column_name)) columns.push(field.column_name);
    else if (field.is_nullable === "NO" && !field.column_default) {
      throw new Error(`FIXTURE_USER_SCHEMA_UNSUPPORTED:${field.column_name}`);
    }
  }
  assert.ok(columns.includes("id") && columns.includes("cash_balance"), "FIXTURE_USER_FIELDS_REQUIRED");
  const names = columns.map(name => `"${name.replace(/"/gu, '""')}"`).join(",");
  await client.query(`insert into public.users(${names}) select ${names} from jsonb_populate_record(null::public.users,$1::jsonb)`, [values]);
}

// A new uncommitted fixture user is deliberately invisible to a second
// connection. Exercise actual account-lock contention using an existing local
// account, without changing its balance or committing either hold.
async function verifyConcurrentRollbackHolds() {
  const existing = (await client.query(`select u.id::text id,u.cash_balance::text balance from public.users u
    where u.cash_balance >= 0.02
      and not exists(select 1 from public.video_tasks t where t.user_id::text=u.id::text
        and t.status not in ('completed','failed','cancelled','expired'))
    order by u.id limit 1`)).rows[0];
  assert.ok(existing, "EXISTING_LOCAL_ACCOUNT_WITH_AVAILABLE_CASH_REQUIRED_FOR_CONCURRENCY");
  const a = new pg.Client(connection), b = new pg.Client(connection);
  let aOpen = false, bOpen = false;
  try {
    await Promise.all([a.connect(), b.connect()]);
    await a.query("begin"); aOpen = true;
    await b.query("begin"); bOpen = true;
    await a.query("set local role service_role");
    await b.query("set local role service_role");
    await b.query("set local lock_timeout='250ms'");
    const first = fixture(existing.id, "concurrent-a", 0.01), second = fixture(existing.id, "concurrent-b", 0.01);
    assert.equal((await reserve(a, first)).created, true);
    await expectError(b, () => reserve(b, second), "55P03");
    await a.query("rollback"); aOpen = false;
    assert.equal((await reserve(b, second)).created, true);
    await b.query("rollback"); bOpen = false;
    const after = (await client.query("select cash_balance::text balance from public.users where id::text=$1", [existing.id])).rows[0];
    assert.equal(after.balance, existing.balance, "EXISTING_LOCAL_ACCOUNT_BALANCE_MUST_NOT_CHANGE");
    assert.equal(Number((await client.query("select count(*) n from public.video_tasks where id=any($1::text[])",
      [[first.task.p_task_id, second.task.p_task_id]])).rows[0].n), 0, "CONCURRENT_HOLDS_MUST_ROLL_BACK");
    stages.push("two-connection-existing-local-account-lock-contention-and-rollback-release");
  } finally {
    if (aOpen) await a.query("rollback").catch(() => undefined);
    if (bOpen) await b.query("rollback").catch(() => undefined);
    await Promise.all([a.end(), b.end()]);
  }
}

let passed = false;
let failure: { name: string; code: string; message: string } | undefined;
try {
  await client.connect();
  assert.equal((await client.query("select current_database() name")).rows[0].name, "zimeiti_local");
  for (const signature of [
    "public.reserve_video_token_task_v1_atomic(jsonb,jsonb,jsonb,jsonb)",
    "public.record_video_token_usage_v1_atomic(text,text,text,bigint,bigint)",
    "public.settle_video_token_task_v1_atomic(text,text,text,text,jsonb)",
  ]) {
    const security = (await client.query(`select p.prosecdef,p.proconfig,
      has_function_privilege('service_role',p.oid,'execute') service,
      has_function_privilege('anon',p.oid,'execute') anon,
      has_function_privilege('authenticated',p.oid,'execute') authenticated
      from pg_proc p where p.oid=to_regprocedure($1)`, [signature])).rows[0];
    assert.ok(security, "TOKEN_MIGRATION_MUST_BE_APPLIED_BY_OWNER_FIRST");
    assert.equal(security.prosecdef, true); assert.deepEqual(security.proconfig, ["search_path=public, pg_temp"]);
    assert.equal(security.service, true); assert.equal(security.anon, false); assert.equal(security.authenticated, false);
  }
  stages.push("service-role-only-rpc-contracts");
  modelId = (await client.query("select id::text id from public.video_models where id=$1",
    ["secure-skill-doubao-seedance-2-0-g37"])).rows[0]?.id;
  assert.ok(modelId, "EXISTING_SEEDANCE_MODEL_ID_REQUIRED_NO_MODEL_WRITES_ALLOWED");
  await verifyConcurrentRollbackHolds();
  await client.query("begin"); open = true;
  await client.query("set local statement_timeout='10000ms'");
  await client.query("set local lock_timeout='2000ms'");
  await createIsolatedUser();
  await client.query("set local role service_role");

  await scenario("reservation-replay-and-immutable-quote", async () => {
    const f = fixture(fixtureUserId, "replay");
    assert.equal((await reserve(client, f)).created, true);
    assert.equal((await reserve(client, f)).created, false);
    const changed = { ...f, quote: { ...f.quote, maxChargeYuan: 5 }, task: { ...f.task, p_billing_price_yuan: 5 } };
    await expectError(client, () => reserve(client, changed), "23505", "VIDEO_TOKEN_RESERVATION_IMMUTABLE_CONFLICT");
    assert.equal(Number((await state(f)).reserved), 6); assert.equal(await walletCount(), 0);
  });
  await scenario("actual-price-still-holds-full-budget-before-wallet", async () => {
    const f = fixture(fixtureUserId, "hold"); await reserve(client, f);
    const first = await usage(client, f, 1_000_000);
    assert.equal(first.billing_state, "billing_pending"); assert.equal(Number(first.price_yuan), 2);
    const replay = await usage(client, f, 1_000_000);
    assert.equal(replay.usage_replayed, true); assert.deepEqual(replay.billing_token_usage, first.billing_token_usage);
    await expectError(client, () => reserve(client, fixture(fixtureUserId, "oversubscribed", 5)),
      "P0001", "VIDEO_BUDGET_RESERVATION_INSUFFICIENT");
    assert.equal(await walletCount(), 0);
  });
  await scenario("usage-conflict-preserves-first-receipt-and-blocks-stale-cash-charge", async () => {
    const f = fixture(fixtureUserId, "conflict"); await reserve(client, f);
    const first = await usage(client, f, 1_000_000), conflict = await usage(client, f, 2_000_000);
    assert.equal(conflict.billing_state, "billing_review");
    assert.deepEqual(conflict.billing_token_usage, first.billing_token_usage);
    await expectError(client, () => settle(client, f), "23514", "VIDEO_TOKEN_SETTLEMENT_BLOCKED");
    await expectError(client, () => client.query("select public.apply_wallet_operation_atomic($1,'cash_charge',$2,2,'stale application charge',$3::jsonb)",
      [fixtureUserId, `video-terminal:${f.task.p_task_id}`, { video_task_id: f.task.p_task_id, phase: "video_terminal" }]),
      "23514", "VIDEO_TOKEN_WALLET_CHARGE_BLOCKED");
    assert.equal(await walletCount(), 0); assert.equal(Number((await state(f)).price), 2);
  });
  await scenario("exceeded-quote-keeps-original-hold-and-never-charges", async () => {
    const f = fixture(fixtureUserId, "exceeded"); await reserve(client, f);
    const result = await usage(client, f, 4_000_000);
    assert.equal(result.billing_state, "quote_exceeded"); assert.equal(Number(result.price_yuan), 6);
    assert.equal(Number(result.billing_token_usage.saleAmountYuan), 8);
    await expectError(client, () => settle(client, f), "23514", "VIDEO_TOKEN_SETTLEMENT_BLOCKED");
    assert.equal(await walletCount(), 0);
  });
  await scenario("exact-decimal-rounding-and-zero-amount-review", async () => {
    const precise = fixture(fixtureUserId, "decimal", 6, 38.088, 31.74); await reserve(client, precise);
    const receipt = await usage(client, precise, 1234);
    assert.equal(Number(receipt.price_yuan), 0.05); assert.equal(Number(receipt.cost_price_yuan), 0.0392);
    await client.query("update public.video_tasks set status='failed' where id=$1", [precise.task.p_task_id]);
    const tiny = fixture(fixtureUserId, "tiny"); await reserve(client, tiny);
    const zero = await usage(client, tiny, 1);
    assert.equal(zero.billing_state, "billing_review"); assert.equal(Number(zero.price_yuan), 6);
    assert.equal(Number(zero.billing_token_usage.saleAmountYuan), 0); assert.equal(await walletCount(), 0);
  });
  await scenario("provider-binding-and-counter-validation", async () => {
    const f = fixture(fixtureUserId, "invalid"); await reserve(client, f);
    await expectError(client, () => usage(client, f, 10, 9), "22023", "VIDEO_TOKEN_USAGE_INVALID");
    const wrong = { ...f, task: { ...f.task, p_provider_task_id: "other-provider-task" } };
    await expectError(client, () => usage(client, wrong, 10), "23514", "VIDEO_TOKEN_USAGE_TASK_MISMATCH");
    assert.equal((await state(f)).billing_token_usage, null); assert.equal(await walletCount(), 0);
  });
  await scenario("missing-usage-pending-recovers-only-when-valid-receipt-arrives", async () => {
    const f = fixture(fixtureUserId, "pending"); await reserve(client, f);
    await client.query("update public.video_tasks set status='finalizing',billing_state='usage_pending' where id=$1", [f.task.p_task_id]);
    await expectError(client, () => settle(client, f), "23514", "VIDEO_TOKEN_SETTLEMENT_BLOCKED");
    const recovered = await usage(client, f, 1_000_000);
    assert.equal(recovered.billing_state, "billing_pending");
    assert.equal(Number(recovered.price_yuan), 2); assert.equal(await walletCount(), 0);
  });
  await scenario("image-cash-charge-cannot-consume-video-hold-but-own-actual-charge-can", async () => {
    const f = fixture(fixtureUserId, "full-hold", 10, 3, 1); await reserve(client, f);
    await expectError(client, () => imageCharge(10, "cannot-steal"), "P0001", "VIDEO_BUDGET_CASH_RESERVED");
    assert.equal(await walletCount(), 0);
    await usage(client, f, 1_000_000); const paid = await settle(client, f);
    assert.equal(Number(paid.amount), 3);
    assert.equal((await imageCharge(7, "remaining-cash")).success, true);
    assert.equal(Number((await client.query("select cash_balance from public.users where id=$1", [fixtureUserId])).rows[0].cash_balance), 0);
    const replay = await settle(client, f);
    assert.equal(replay.already_fulfilled, true, "LOW_BALANCE_MUST_NOT_BLOCK_COMPLETED_IDEMPOTENT_REPLAY");
    assert.equal(await walletCount(), 2);
  });
  await scenario("another-task-hold-remains-unspendable-after-own-token-settlement", async () => {
    const own = fixture(fixtureUserId, "own-hold", 6), other = fixture(fixtureUserId, "other-hold", 4);
    await reserve(client, own); await reserve(client, other); await usage(client, own, 1_000_000);
    assert.equal((await settle(client, own)).success, true);
    await expectError(client, () => imageCharge(5, "other-hold-cannot-steal"), "P0001", "VIDEO_BUDGET_CASH_RESERVED");
    assert.equal((await imageCharge(4, "unreserved-cash-only")).success, true);
    assert.equal(Number((await state(other)).reserved), 4); assert.equal((await state(other)).billing_token_usage, null);
  });
  await scenario("fixed-price-video-still-settles-own-hold-without-token-fields", async () => {
    const fixed = fixture(fixtureUserId, "fixed-price", 4), other = fixture(fixtureUserId, "fixed-other-hold", 6);
    await client.query(`select public.reserve_video_generation_task_request_snapshot_v1_atomic(
      p_task_id=>$1,p_user_id=>$2,p_model_id=>$3,p_client_request_id=>$4,p_request_fingerprint=>$5,
      p_billing_price_yuan=>4,p_billing_cost_price_yuan=>1,p_billing_unit=>'per_use',p_billing_quantity=>1,
      p_explicitly_free=>false,p_billing_exempt=>false,p_routing_snapshot=>$6::jsonb,p_request_snapshot=>$7::jsonb,
      p_request_snapshot_hash=>$8,p_provider_task_id=>$9,p_prompt=>$10,p_aspect_ratio=>'16:9',p_resolution=>'720p',p_duration_seconds=>6)`,
    [fixed.task.p_task_id, fixtureUserId, modelId, fixed.task.p_client_request_id, fixed.task.p_request_fingerprint,
      fixed.routing, fixed.request, fixed.task.p_request_snapshot_hash, fixed.task.p_provider_task_id, fixed.task.p_prompt]);
    await reserve(client, other);
    const paid = (await client.query("select public.apply_wallet_operation_atomic($1,'cash_charge',$2,4,'Fixed-price rollback charge',$3::jsonb) receipt",
      [fixtureUserId, `video-terminal:${fixed.task.p_task_id}`, { phase: "video_terminal", video_task_id: fixed.task.p_task_id }])).rows[0].receipt;
    assert.equal(paid.success, true); assert.equal((await state(fixed)).billing_unit, "per_use");
    assert.equal((await state(fixed)).billing_token_quote, null); assert.equal((await state(fixed)).reserved, null);
    await expectError(client, () => imageCharge(1, "fixed-other-hold-cannot-steal"), "P0001", "VIDEO_BUDGET_CASH_RESERVED");
  });
  await scenario("isolated-wallet-exactly-once-and-hold-release-after-completed-charge", async () => {
    const f = fixture(fixtureUserId, "settle"); await reserve(client, f); await usage(client, f, 1_000_000);
    const paid = await settle(client, f), replay = await settle(client, f);
    assert.equal(paid.success, true); assert.equal(paid.already_fulfilled, false);
    assert.equal(replay.already_fulfilled, true); assert.equal(String(replay.operation_id), String(paid.operation_id));
    assert.equal(await walletCount(), 1);
    assert.equal(Number((await client.query("select cash_balance from public.users where id=$1", [fixtureUserId])).rows[0].cash_balance), 8);
    const operation = (await client.query("select amount,delta,metadata,status from public.wallet_operations where id=$1", [paid.operation_id])).rows[0];
    assert.equal(Number(operation.amount), 2); assert.equal(Number(operation.delta), -2); assert.equal(operation.status, "completed");
    assert.deepEqual(operation.metadata.token_quote, f.quote);
    assert.equal(operation.metadata.token_usage.totalTokens, 1_000_000);
    assert.equal(operation.metadata.price_snapshot.request_fingerprint, f.task.p_request_fingerprint);
    assert.equal((await reserve(client, f)).created, false, "REPLAY_MUST_NOT_RESTORE_RESERVED_PRICE");
    assert.equal(Number((await state(f)).price), 2);
    assert.equal((await reserve(client, fixture(fixtureUserId, "released", 8))).created, true,
      "COMPLETED_ACTUAL_WALLET_CHARGE_MUST_RELEASE_THE_FULL_OLD_HOLD");
  });
  await scenario("late-conflicting-usage-audits-without-changing-paid-or-completed-terminal", async () => {
    const f = fixture(fixtureUserId, "late-conflict"); await reserve(client, f);
    const first = await usage(client, f, 1_000_000); await settle(client, f);
    const before = await state(f), paidConflict = await usage(client, f, 2_000_000);
    assert.equal(paidConflict.usage_conflict, true); assert.equal(paidConflict.billing_state, before.billing_state);
    assert.deepEqual(paidConflict.billing_token_usage, first.billing_token_usage); assert.equal(Number(paidConflict.price_yuan), 2);
    await client.query("update public.video_tasks set status='completed',billing_state='settled',price_charged=2,completed_at=now(),video_url='https://fixture.invalid/result.mp4' where id=$1", [f.task.p_task_id]);
    const completedConflict = await usage(client, f, 3_000_000);
    assert.equal(completedConflict.status, "completed"); assert.equal(completedConflict.billing_state, "settled");
    const audit = (await client.query("select billing_token_usage_conflict,price_charged,video_url from public.video_tasks where id=$1", [f.task.p_task_id])).rows[0];
    assert.equal(Number(audit.billing_token_usage_conflict.observations), 2);
    assert.match(audit.billing_token_usage_conflict.usageHash, /^[a-f0-9]{32}$/u);
    assert.equal(Number(audit.price_charged), 2); assert.equal(audit.video_url, "https://fixture.invalid/result.mp4");
    assert.equal(await walletCount(), 1);
  });

  await client.query("rollback"); open = false;
  assert.equal(Number((await client.query("select count(*) n from public.users where id::text=$1", [fixtureUserId])).rows[0].n), 0);
  assert.equal(await walletCount(), 0);
  assert.equal(Number((await client.query("select count(*) n from public.video_tasks where user_id::text=$1", [fixtureUserId])).rows[0].n), 0);
  stages.push("all-fixtures-wallet-and-tasks-absent-after-rollback");
  passed = true;
} catch (error: any) {
  // Error messages are fixed assertion/RPC codes. Never print connection,
  // query parameters, runtime config, SQL detail, or supplied credentials.
  failure = { name: error?.name || "Error", code: typeof error?.code === "string" ? error.code : "ASSERTION_OR_RUNTIME_ERROR",
    message: String(error?.message || "Probe failed").split("\n")[0].slice(0, 240) };
  process.exitCode = 1;
} finally {
  if (open) await client.query("rollback").catch(() => undefined);
  await client.end();
  console.log(JSON.stringify({ passed, rollbackOnly: true, schemaWrites: 0, committedWrites: 0,
    concurrencyAccountScope: "existingLocalAccount", concurrencyAccountBalanceWrites: 0,
    existingUserBalanceWrites: 0, modelWrites: 0, providerCalls: 0, stages, ...(failure ? { failure } : {}) }, null, 2));
}
}
void main().catch((error: any) => {
  console.error(JSON.stringify({ passed: false, stage: "preflight", code: error?.code || "PREFLIGHT_FAILED",
    message: String(error?.message || "Preflight failed").split("\n")[0].slice(0, 240) }));
  process.exitCode = 1;
});
