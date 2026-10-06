#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { SignJWT } from "jose";

const ORIGIN = String(process.env.LOCAL_APP_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");
assert.equal(ORIGIN, "http://127.0.0.1:5000", "FIXED_LOCAL_ORIGIN_REQUIRED");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");

const database = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-payment-settlement-readonly",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

let transactionOpen = false;
try {
  await database.connect();
  await database.query("BEGIN READ ONLY");
  transactionOpen = true;
  const candidateResult = await database.query(`
    SELECT o.trade_order_id, o.user_id::text, o.type, o.amount, o.credits_amount,
           o.status, o.payment_provider, o.provider_trade_order_id,
           o.provider_transaction_id, o.provider_paid_amount, o.provider_confirmed_at,
           u.username, u.role, s.session_id
      FROM public.payment_orders o
      JOIN public.users u ON u.id::text = o.user_id::text
      JOIN LATERAL (
        SELECT session_id
          FROM public.user_auth_sessions
         WHERE user_id::text = o.user_id::text
           AND revoked_at IS NULL
           AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1
      ) s ON true
     WHERE o.status = 'paid'
       AND u.is_active = true
       AND u.status IS DISTINCT FROM 'blocked'
       AND (
         nullif(trim(coalesce(o.provider_trade_order_id, '')), '') IS NULL
         OR nullif(trim(coalesce(o.provider_transaction_id, '')), '') IS NULL
         OR o.provider_paid_amount IS NULL
         OR o.provider_confirmed_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_operations w
            WHERE w.user_id = o.user_id::text
              AND w.idempotency_key = 'payment:' || o.trade_order_id
              AND w.status = 'completed'
         )
       )
     ORDER BY o.created_at DESC
     LIMIT 1
  `);
  assert.equal(candidateResult.rowCount, 1, "LOCAL_ANOMALOUS_PAID_ORDER_WITH_SESSION_REQUIRED");
  const candidate = candidateResult.rows[0];
  await database.query("COMMIT");
  transactionOpen = false;

  const token = await new SignJWT({
    userId: candidate.user_id,
    username: candidate.username,
    role: candidate.role,
    sessionId: candidate.session_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(String(runtime.jwtSecret)));
  const response = await fetch(`${ORIGIN}/api/payment/status?order=${encodeURIComponent(candidate.trade_order_id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `PAYMENT_STATUS_HTTP_${response.status}`);
  assert.equal(body?.order?.recorded_status, "paid", "historical marker must remain auditable");
  assert.equal(body?.order?.status, "reconciliation_required", "unproven paid marker must not be exposed as success");
  assert.equal(body?.order?.settlement_status, "reconciliation_required", "settlement must be explicitly unresolved");
  assert.equal(body?.order?.balance_credited, false, "unproven balance credit must remain false");
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("provider_transaction_id"), false, "provider transaction id leaked to user response");
  assert.equal(serialized.includes("provider_trade_order_id"), false, "provider merchant id leaked to user response");

  const report = {
    checkedAt: new Date().toISOString(),
    origin: ORIGIN,
    orderReference: crypto.createHash("sha256").update(String(candidate.trade_order_id)).digest("hex").slice(0, 16),
    recordedStatus: body.order.recorded_status,
    publicStatus: body.order.status,
    settlementStatus: body.order.settlement_status,
    balanceCredited: body.order.balance_credited,
    providerCalls: 0,
    paidCalls: 0,
    databaseWrites: 0,
    passed: true,
  };
  const evidenceDir = path.resolve(".codex-evidence", "payment-settlement-live-readonly-20261004");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (transactionOpen) await database.query("ROLLBACK").catch(() => undefined);
  await database.end().catch(() => undefined);
}
