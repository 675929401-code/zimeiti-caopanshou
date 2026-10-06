#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const taskId = process.argv.find((value) => value.startsWith("--task-id="))?.slice("--task-id=".length) || "";
assert.match(taskId, /^vt_[a-f0-9]{40}$/u, "VIDEO_TASK_ID_REQUIRED");
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const connection = runtime.ownerConnection;
assert.equal(connection.host, "127.0.0.1");
assert.equal(Number(connection.port), 54322);
assert.equal(connection.database, "zimeiti_local");

const db = new pg.Client({ ...connection, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
await db.connect();
try {
  await db.query("BEGIN READ ONLY");
  const task = (await db.query(`
    SELECT id,user_id::text AS user_id,model_id,client_request_id,task_id_external,task_label,
           status,submission_error_code,error_message,billing_state,billing_price_yuan,
           billing_cost_price_yuan,billing_idempotency_key,billing_operation_id,price_charged,
           provider_result_url,storage_url,video_url,provider_progress,provider_status_message,
            provider_last_polled_at,provider_poll_failures,provider_poll_lease_owner,
            provider_poll_lease_until,created_at,completed_at
      FROM public.video_tasks WHERE id=$1
  `, [taskId])).rows[0];
  assert.ok(task, "VIDEO_TASK_NOT_FOUND");
  const billingKey = String(task.billing_idempotency_key || "");
  const billingParams = [task.user_id, billingKey];
  const taskParams = [task.user_id, task.id];
  const operations = await db.query("SELECT id::text,status,wallet,operation_kind,amount,delta,created_at FROM public.wallet_operations WHERE user_id::text=$1 AND idempotency_key=$2", billingParams);
  const ledger = await db.query("SELECT id::text,operation_id::text,wallet,operation_kind,delta,created_at FROM public.wallet_ledger_entries WHERE user_id::text=$1 AND idempotency_key=$2", billingParams);
  const cash = await db.query("SELECT id::text,type,amount,created_at FROM public.cash_transactions WHERE user_id::text=$1 AND reference_id=$2", billingParams);
  const revenue = await db.query("SELECT id::text,cost_price,selling_price,cash_charged,billing_exempt,created_at FROM public.revenue_records WHERE user_id::text=$1 AND task_id=$2 AND record_type='video'", taskParams);
  const assets = await db.query("SELECT id::text,storage_provider,storage_key,file_size,content_type,created_at FROM public.user_files WHERE user_id::text=$1 AND meta->>'taskId'=$2", taskParams);
  const queueExists = Boolean((await db.query("SELECT to_regclass('public.digital_video_dispatch_jobs')::text AS name")).rows[0]?.name);
  const queue = queueExists
    ? (await db.query("SELECT task_id,state,error_code,error_message,lease_owner,lease_until,next_run_at,created_at,updated_at FROM public.digital_video_dispatch_jobs WHERE task_id=$1", [taskId])).rows
    : [];
  const report = {
    inspectedAt: new Date().toISOString(),
    localReadOnly: true,
    task: {
      ...task,
      user_id: undefined,
      client_request_id: undefined,
      billing_idempotency_key: billingKey ? "present" : "missing",
      billing_operation_id: task.billing_operation_id ? "present" : null,
      providerTaskIdPresent: Boolean(String(task.task_id_external || "").trim()),
      providerResultPresent: Boolean(String(task.provider_result_url || "").trim()),
      stableAssetPresent: Boolean(String(task.storage_url || "").trim()),
      provider_result_url: undefined,
      storage_url: undefined,
      video_url: undefined,
      providerPollLeaseOwner: task.provider_poll_lease_owner ? "present" : null,
      provider_poll_lease_owner: undefined,
      ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(task.created_at)) / 1_000)),
    },
    settlement: {
      walletOperations: operations.rows,
      walletLedgerEntries: ledger.rows,
      cashTransactions: cash.rows,
      revenueRecords: revenue.rows,
      ownedAssets: assets.rows,
    },
    queue,
  };
  await db.query("ROLLBACK");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.end();
}
