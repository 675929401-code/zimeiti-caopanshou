#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "supabase/migrations/20260904193000_payment_refund_exactly_once.sql");
const rollbackPath = path.join(root, "supabase/rollbacks/20260904193000_payment_refund_exactly_once.rollback.sql");
const routePath = path.join(root, "src/app/api/payment/refund/route.ts");
const lifecyclePath = path.join(root, "src/lib/payment-refund-lifecycle.ts");
const providerPath = path.join(root, "src/lib/xunhupay.ts");
const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const evidenceDir = path.join(root, ".codex-evidence/payment-refund-exactly-once-20260904");

const [migration, rollback, route, lifecycle, provider, runtimeRaw] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(rollbackPath, "utf8"),
  readFile(routePath, "utf8"),
  readFile(lifecyclePath, "utf8"),
  readFile(providerPath, "utf8"),
  readFile(runtimePath, "utf8"),
]);

const checks = [];
function check(name, condition, detail = undefined) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(detail === undefined ? {} : { detail }) });
}
function indexOrder(name, source, needles) {
  let previous = -1;
  for (const needle of needles) {
    const current = source.indexOf(needle);
    assert.ok(current >= 0, `${name}: missing ${needle}`);
    assert.ok(current > previous, `${name}: wrong order for ${needle}`);
    previous = current;
  }
  checks.push({ name, passed: true });
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

check("fine-grained refund authorization", route.includes('authorizeAdminCapability(request, "wallet.adjust"')
  && route.includes("requireStepUp: true") && route.includes('operation: "payment_refund_authorize"'));
check("stale jwt role is not trusted", !/payload\.role\s*===\s*["']admin["']/u.test(route));
check("audit availability fails closed before refund claim", route.includes("PAYMENT_REFUND_AUDIT_UNAVAILABLE")
  && route.includes('action: "payment_refund_intent"'));
indexOrder("authorization and durable intent precede financial mutation", route, [
  'authorizeAdminCapability(request, "wallet.adjust"',
  'action: "payment_refund_intent"',
  "if (!intentRecorded)",
  "claimPaymentRefund({",
]);
check("refund terminal states append governance audit", route.includes('action: "payment_refund_result"')
  && route.includes('reasonCode: "REFUND_COMPLETED"') && route.includes('reasonCode: "REFUND_PROVIDER_RESULT_UNKNOWN"'));
check("request body is streaming bounded", route.includes("request.body.getReader()") && route.includes("PAYMENT_REFUND_REQUEST_TOO_LARGE"));
check("stable idempotency key is mandatory", route.includes('request.headers.get("idempotency-key")') && lifecycle.includes("PAYMENT_REFUND_IDEMPOTENCY_KEY_REQUIRED"));
check("refund reason respects provider protocol limit", lifecycle.includes("reason.length > 80") && migration.includes("length(reason) BETWEEN 1 AND 80"));
indexOrder("wallet reserve precedes provider call", route, ["claimPaymentRefund({", "markPaymentRefundProviderStarted({", "refundPayment({"]);
check("route has no direct order or wallet mutation", !route.includes('.from("payment_orders")') && !route.includes("apply_wallet_operation_atomic"));
check("provider ambiguity is non-retryable", route.includes("transport_or_provider_result_unknown") && route.includes("不要重新提交"));
check("provider refund uses one gateway only", provider.includes("return postToGateway(config.refundGateway") && !provider.slice(provider.indexOf("export async function refundPayment"), provider.indexOf("// ─── 订单查询")).includes("refundGatewayBackup"));
check("provider refund response requires signature and bound evidence", provider.includes("!result.hash || !verifyResponseSign(result, config.secret)")
  && provider.includes("tradeOrderId !== requestedTradeOrderId") && provider.includes("退款响应金额无效"));
check("provider paid state is retained for reconciliation", provider.includes("['OD', 'CD', 'RD', 'UD']"));
check("gateway responses are timeout and size bounded", provider.includes("MAX_GATEWAY_RESPONSE_BYTES = 64 * 1024")
  && provider.includes("AbortSignal.timeout(20_000)") && provider.includes("readBoundedGatewayResponse(response)"));
check("gateway errors do not log raw provider payloads", !provider.includes("响应签名验证失败:', result")
  && !provider.includes("JSON.stringify(result)"));
check("database claim locks the payment order", /FROM public\.payment_orders[\s\S]*?WHERE trade_order_id = v_trade_order_id[\s\S]*?FOR UPDATE/u.test(migration));
check("one live refund per order", migration.includes("payment_refund_one_active_per_order") && migration.includes("provider_refund_id") && migration.includes("UNIQUE INDEX"));
indexOrder("database reserve precedes provider lease", migration, ["apply_wallet_operation_atomic(", "mark_payment_refund_provider_started_atomic"]);
check("success requires exact provider evidence", migration.includes("PAYMENT_REFUND_EVIDENCE_MISMATCH")
  && migration.includes("v_provider_order <> v_attempt.trade_order_id") && migration.includes("round(p_provider_refund_amount,2) <> v_attempt.paid_amount"));
check("definitive failure releases wallet once", migration.includes("'payment-refund-release:' || v_attempt.attempt_id")
  && migration.includes("v_release_replayed") && migration.includes("v_provider_status <> 'UD'"));
check("ambiguous outcomes retain reservation", migration.includes("state='reconciliation_required'") && !/state='reconciliation_required'[\s\S]{0,400}payment-refund-release/u.test(migration));
check("refund state is service-role only", migration.includes("REVOKE ALL ON TABLE public.payment_refund_attempts FROM PUBLIC, anon, authenticated")
  && migration.includes("TO service_role"));
check("rollback refuses evidence loss", rollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_EVIDENCE_EXISTS"));

const runtime = JSON.parse(runtimeRaw);
const connection = runtime?.ownerConnection;
check("local-only database target", runtime?.localOnly === true
  && connection?.host === "127.0.0.1" && connection?.port === 54322
  && connection?.database === "zimeiti_local");

const sqlWithoutOuterTransaction = migration
  .split(/\r?\n/u)
  .filter((line) => !["BEGIN;", "COMMIT;"].includes(line.trim()) && !/^NOTIFY\s+pgrst\b/iu.test(line.trim()))
  .join("\n");

const client = new pg.Client(connection);
const fixture = {
  userId: randomUUID(),
  adminId: randomUUID(),
  creditsTrade: `CODX_REFUND_CREDITS_${randomUUID()}`,
  cashTrade: `CODX_REFUND_CASH_${randomUUID()}`,
  recoveryTrade: `CODX_REFUND_RECOVERY_${randomUUID()}`,
};
const attempt = (suffix) => sha256(`${fixture.adminId}\u0000${suffix}`);
const fingerprint = (trade, reason) => sha256(JSON.stringify({ tradeOrderId: trade, reason }));
const reason = "transactional-local-refund-verification";
let databaseChecks = 0;
let rolledBack = false;

function action(row) {
  return row.result?.action;
}
async function claim({ trade, key, owner }) {
  const result = await client.query(
    "select public.claim_payment_refund_attempt_atomic($1,$2,$3,$4,$5,$6,$7,$8) as result",
    [attempt(key), trade, fixture.adminId, key, fingerprint(trade, reason), reason, owner, 30],
  );
  return result.rows[0];
}
async function start({ trade, key, owner, token = 1 }) {
  const result = await client.query(
    "select public.mark_payment_refund_provider_started_atomic($1,$2,$3,$4) as result",
    [attempt(key), fingerprint(trade, reason), owner, token],
  );
  return result.rows[0];
}
async function finalize({ trade, key, owner, terminal, status, providerOrder = null, refundId = null, amount = null, token = 1 }) {
  const result = await client.query(
    "select public.finalize_payment_refund_attempt_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result",
    [attempt(key), fingerprint(trade, reason), owner, token, terminal, status, providerOrder, refundId, amount, { test: true }],
  );
  return result.rows[0];
}
async function expectDatabaseError(name, pattern, operation) {
  const savepoint = `sp_${databaseChecks + 1}`;
  await client.query(`savepoint ${savepoint}`);
  let matched = false;
  try {
    await operation();
  } catch (error) {
    matched = pattern.test(String(error?.message || ""));
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
  check(name, matched);
  databaseChecks += 1;
}

try {
  await client.connect();
  await client.query("begin");
  await client.query("set local lock_timeout='5s'");
  await client.query("set local statement_timeout='30s'");
  await client.query(sqlWithoutOuterTransaction);
  check("migration compiles against current local schema", true);

  await client.query(
    `insert into public.users
       (id,username,password_hash,display_name,role,credits,cash_balance,total_credits_recharged,total_credits_consumed,total_cash_recharged,total_cash_consumed)
     values ($1,$2,'not-a-login-hash','refund verifier','student',1000,100,1000,0,100,0)`,
    [fixture.userId, `refund_verify_${fixture.userId.replaceAll("-", "")}`],
  );
  for (const [trade, type, paid, credits, transaction] of [
    [fixture.creditsTrade, "credits", 10, 500, randomUUID()],
    [fixture.cashTrade, "cash", 10, null, randomUUID()],
    [fixture.recoveryTrade, "cash", 8, null, randomUUID()],
  ]) {
    await client.query(
      `insert into public.payment_orders
         (user_id,trade_order_id,type,amount,credits_amount,status,payment_method,payment_provider,
          provider_trade_order_id,provider_transaction_id,provider_paid_amount,provider_confirmed_at)
       values ($1,$2,$3,$4,$5,'paid','wechat','xunhupay',$2,$6,$4,now())`,
      [fixture.userId, trade, type, paid, credits, transaction],
    );
  }

  const creditKey = `refund-credit-${randomUUID()}`;
  const creditOwner = randomUUID();
  check("first claim executes", action(await claim({ trade: fixture.creditsTrade, key: creditKey, owner: creditOwner })) === "execute");
  check("same in-flight claim does not debit twice", action(await claim({ trade: fixture.creditsTrade, key: creditKey, owner: randomUUID() })) === "in_progress");
  let balances = (await client.query("select credits,cash_balance,total_credits_recharged,total_credits_consumed from public.users where id=$1", [fixture.userId])).rows[0];
  check("credit reservation changes wallet and recharge counters exactly once", Number(balances.credits) === 500
    && Number(balances.total_credits_recharged) === 500 && Number(balances.total_credits_consumed) === 0);
  await expectDatabaseError("different key cannot overlap the same order", /PAYMENT_REFUND_ALREADY_ACTIVE/u,
    () => claim({ trade: fixture.creditsTrade, key: `refund-conflict-${randomUUID()}`, owner: randomUUID() }));
  check("provider-start fence executes once", action(await start({ trade: fixture.creditsTrade, key: creditKey, owner: creditOwner })) === "execute");
  check("claim after provider start requires reconciliation", action(await claim({ trade: fixture.creditsTrade, key: creditKey, owner: randomUUID() })) === "reconciliation_required");
  check("ambiguous provider result remains reconciliation", action(await finalize({ trade: fixture.creditsTrade, key: creditKey, owner: creditOwner, terminal: "reconciliation_required", status: "UNKNOWN" })) === "reconciliation_required");
  check("definitive provider refusal releases reservation", action(await finalize({ trade: fixture.creditsTrade, key: creditKey, owner: creditOwner, terminal: "released", status: "UD" })) === "released");
  check("release replay does not credit twice", action(await finalize({ trade: fixture.creditsTrade, key: creditKey, owner: creditOwner, terminal: "released", status: "UD" })) === "released");
  balances = (await client.query("select credits,total_credits_recharged,total_credits_consumed from public.users where id=$1", [fixture.userId])).rows[0];
  check("released reservation restores exact credit state", Number(balances.credits) === 1000
    && Number(balances.total_credits_recharged) === 1000 && Number(balances.total_credits_consumed) === 0);

  const cashKey = `refund-cash-${randomUUID()}`;
  const cashOwner = randomUUID();
  check("cash refund claim executes", action(await claim({ trade: fixture.cashTrade, key: cashKey, owner: cashOwner })) === "execute");
  check("cash provider-start fence executes", action(await start({ trade: fixture.cashTrade, key: cashKey, owner: cashOwner })) === "execute");
  await expectDatabaseError("mismatched provider evidence cannot finalize", /PAYMENT_REFUND_EVIDENCE_MISMATCH/u,
    () => finalize({ trade: fixture.cashTrade, key: cashKey, owner: cashOwner, terminal: "completed", status: "CD", providerOrder: fixture.cashTrade, refundId: randomUUID(), amount: 9 }));
  const refundId = `RF_${randomUUID()}`;
  check("exact provider evidence finalizes", action(await finalize({ trade: fixture.cashTrade, key: cashKey, owner: cashOwner, terminal: "completed", status: "CD", providerOrder: fixture.cashTrade, refundId, amount: 10 })) === "replay");
  check("completed claim replays without a second provider lease", action(await claim({ trade: fixture.cashTrade, key: cashKey, owner: randomUUID() })) === "replay");
  const cashState = (await client.query(
    "select u.cash_balance,u.total_cash_recharged,u.total_cash_consumed,o.status,o.provider_refund_id from public.users u join public.payment_orders o on o.user_id=u.id::uuid where u.id=$1 and o.trade_order_id=$2",
    [fixture.userId, fixture.cashTrade],
  )).rows[0];
  check("completed refund retains reversal and binds order receipt", Number(cashState.cash_balance) === 90
    && Number(cashState.total_cash_recharged) === 90 && Number(cashState.total_cash_consumed) === 0
    && cashState.status === "refunded" && cashState.provider_refund_id === refundId);

  const recoveryKey = `refund-recovery-${randomUUID()}`;
  const firstOwner = randomUUID();
  check("pre-provider reservation is created", action(await claim({ trade: fixture.recoveryTrade, key: recoveryKey, owner: firstOwner })) === "execute");
  await client.query("update public.payment_refund_attempts set lease_until=now()-interval '1 second' where attempt_id=$1", [attempt(recoveryKey)]);
  const recovered = await claim({ trade: fixture.recoveryTrade, key: recoveryKey, owner: randomUUID() });
  check("expired pre-provider lease is recoverable", action(recovered) === "execute" && Number(recovered.result.record.lease_token) === 2);
  balances = (await client.query("select cash_balance from public.users where id=$1", [fixture.userId])).rows[0];
  check("lease recovery does not debit twice", Number(balances.cash_balance) === 82);

  await client.query("rollback");
  rolledBack = true;
  const residue = await client.query(
    "select (select count(*)::int from public.users where id=$1) users, (select count(*)::int from public.payment_orders where trade_order_id=any($2::text[])) orders",
    [fixture.userId, [fixture.creditsTrade, fixture.cashTrade, fixture.recoveryTrade]],
  );
  check("fault injection leaves zero persistent fixture rows", residue.rows[0].users === 0 && residue.rows[0].orders === 0);
} finally {
  if (!rolledBack) await client.query("rollback").catch(() => undefined);
  await client.end().catch(() => undefined);
}

await mkdir(evidenceDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  passed: true,
  checks,
  summary: {
    checks: checks.length,
    databaseFaultInjectionChecks: databaseChecks,
    providerCalls: 0,
    persistentDatabaseWrites: 0,
    targetDatabase: "loopback-local-only",
  },
};
await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
