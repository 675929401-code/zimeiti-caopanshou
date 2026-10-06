#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const key = process.argv.find((value) => value.startsWith("--key="))?.slice(6) || "";
const outputArgument = process.argv.find((value) => value.startsWith("--output="))?.slice(9) || "";
assert.match(key, /^[A-Za-z0-9_-]{16,180}$/u, "A valid image request key is required");
assert.ok(outputArgument, "An immutable --output path is required");
const output = path.resolve(outputArgument);
const evidenceRoot = `${path.resolve(".codex-evidence")}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), "Output must stay inside .codex-evidence");

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
assert.equal(runtime.ownerConnection?.port, 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const database = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-image-request-ledger-readonly",
});
const report = {
  inspectedAt: new Date().toISOString(),
  localOnly: true,
  databaseWrites: 0,
  providerRequests: 0,
  requestKey: key,
};
try {
  await database.connect();
  await database.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await database.query("SET LOCAL statement_timeout = '10s'");
  const requests = await database.query(
    `SELECT record_id,user_id,state,delivery_state,delivery_asset_id,
            response->>'schema' AS response_schema,
            response->>'provider_status' AS provider_status,
            created_at,updated_at
       FROM public.image_generation_requests
      WHERE client_idempotency_key=$1`,
    [key],
  );
  report.requestCount = requests.rowCount;
  report.requests = requests.rows.map(({ user_id: _userId, ...row }) => row);
  if (requests.rowCount === 1) {
    const userId = String(requests.rows[0].user_id);
    const billingKey = `image:h3_${createHash("sha256").update(`${userId}:${key}`).digest("hex").slice(0, 48)}`;
    const operations = await database.query(
      `SELECT operation_kind,idempotency_key,amount,delta,status,balance_before,balance_after,created_at,completed_at
         FROM public.wallet_operations
        WHERE user_id=$1 AND idempotency_key=ANY($2::text[])
        ORDER BY id`,
      [userId, [billingKey, `${billingKey}:release`]],
    );
    const balance = await database.query(
      "SELECT cash_balance,credits FROM public.users WHERE id=$1",
      [userId],
    );
    report.walletOperations = operations.rows;
    report.balance = balance.rows[0] || null;
    const charged = operations.rows.filter((row) => row.operation_kind === "cash_charge" && row.status === "completed")
      .reduce((sum, row) => sum + Number(row.amount), 0);
    const refunded = operations.rows.filter((row) => row.operation_kind === "cash_refund" && row.status === "completed")
      .reduce((sum, row) => sum + Number(row.amount), 0);
    report.billing = { charged, refunded, netCharged: Math.round((charged - refunded) * 1_000_000) / 1_000_000 };
  }
  await database.query("ROLLBACK");
} catch (error) {
  await database.query("ROLLBACK").catch(() => undefined);
  throw new Error(`READONLY_IMAGE_LEDGER_CHECK_FAILED:${/^[A-Z0-9_]{1,60}$/u.test(String(error?.code || "")) ? error.code : "REDACTED"}`);
} finally {
  await database.end().catch(() => undefined);
}

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({
  requestCount: report.requestCount,
  state: report.requests?.[0]?.state || null,
  billing: report.billing || null,
  output,
  databaseWrites: 0,
  providerRequests: 0,
}));
