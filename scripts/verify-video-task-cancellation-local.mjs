#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-verify-video-task-cancellation",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

function value(result) {
  return result.rows[0]?.result;
}

function fixture(prefix, userId, modelId, providerTaskId = null) {
  const suffix = crypto.randomUUID();
  const taskId = `${prefix}-${suffix}`;
  const clientRequestId = `${prefix}-request-${suffix}`;
  const fingerprint = crypto.createHash("sha256").update(taskId).digest("hex");
  const configVersion = crypto.createHash("sha256").update(`routing:${taskId}`).digest("hex");
  return {
    taskId,
    clientRequestId,
    providerTaskId,
    fingerprint,
    params: {
      p_task_id: taskId,
      p_user_id: userId,
      p_model_id: modelId,
      p_client_request_id: clientRequestId,
      p_request_fingerprint: fingerprint,
      p_billing_price_yuan: 0,
      p_billing_cost_price_yuan: 0,
      p_billing_unit: "per_use",
      p_billing_quantity: 1,
      p_explicitly_free: true,
      p_billing_exempt: true,
      p_routing_snapshot: {
        schemaVersion: "1",
        configVersion,
        modelId,
        provider: "local-cancellation-fixture",
        protocolType: "local_fixture_video",
        modelName: "local-fixture",
        apiEndpoint: "https://fixture.invalid/v1/videos",
        credentialRef: "env://TEST_VIDEO_API_KEY",
        apiProtocolConfig: {},
      },
      p_provider_task_id: providerTaskId,
      p_task_label: "本地终止链回归",
      p_prompt: "local cancellation verification",
      p_aspect_ratio: "16:9",
      p_duration_seconds: 5,
    },
  };
}

async function reserve(item) {
  const result = await client.query(`
    INSERT INTO public.video_tasks (
      id,user_id,model_id,task_label,prompt,aspect_ratio,duration_seconds,
      status,task_id_external,error_message,price_charged,client_request_id,
      request_fingerprint,billing_price_yuan,billing_cost_price_yuan,billing_unit,
      billing_quantity,billing_state,billing_idempotency_key,explicitly_free,
      billing_exempt,routing_snapshot,routing_snapshot_hash,routing_snapshot_version
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,'pending',$8,'local cancellation verification',0,$9,
      $10,0,0,'per_use',1,$11,$12,true,true,$13::jsonb,$14,1
    )
    RETURNING id,status,billing_state
  `, [
    item.params.p_task_id,
    item.params.p_user_id,
    item.params.p_model_id,
    item.params.p_task_label,
    item.params.p_prompt,
    item.params.p_aspect_ratio,
    item.params.p_duration_seconds,
    item.params.p_provider_task_id,
    item.params.p_client_request_id,
    item.params.p_request_fingerprint,
    item.params.p_provider_task_id ? "provider_submitted" : "reserved",
    `video-terminal:${item.params.p_task_id}`,
    JSON.stringify(item.params.p_routing_snapshot),
    item.params.p_routing_snapshot.configVersion,
  ]);
  return { created: true, ...result.rows[0] };
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  check(identity.database_name === "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  check(identity.server_address === "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  check(Number(identity.server_port) === 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");

  const user = (await client.query("SELECT id::text AS id FROM public.users ORDER BY created_at ASC LIMIT 1")).rows[0];
  const model = (await client.query("SELECT id::text AS id FROM public.video_models ORDER BY created_at ASC LIMIT 1")).rows[0];
  check(Boolean(user?.id), "LOCAL_FIXTURE_USER_REQUIRED");
  check(Boolean(model?.id), "LOCAL_FIXTURE_VIDEO_MODEL_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;

  const tombstone = fixture("cancel-fence", user.id, model.id);
  const tombstoneResult = value(await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [user.id, tombstone.clientRequestId],
  ));
  check(tombstoneResult.status === "cancelled", "NO_TASK_REQUEST_CANCELLED");
  check(tombstoneResult.cancellation_state === "cancelled_before_dispatch", "NO_TASK_TOMBSTONE_REQUIRED");
  await client.query("SAVEPOINT late_reservation");
  let lateReservationRejected = false;
  let lateReservationError = "";
  try {
    await reserve(tombstone);
  } catch (error) {
    lateReservationError = `${String(error?.code || "")}:${String(error?.message || "")}`;
    lateReservationRejected = lateReservationError.includes("VIDEO_TASK_CANCELLED_BEFORE_DISPATCH");
    await client.query("ROLLBACK TO SAVEPOINT late_reservation");
  }
  check(lateReservationRejected, `TOMBSTONE_MUST_BLOCK_LATE_PROVIDER_RESERVATION:${lateReservationError || "NO_ERROR"}`);

  const beforeDispatch = fixture("cancel-before", user.id, model.id);
  const beforeReservation = await reserve(beforeDispatch);
  check(beforeReservation.created === true, "PRE_DISPATCH_FIXTURE_CREATED");
  const beforeResult = value(await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [user.id, beforeDispatch.clientRequestId],
  ));
  check(beforeResult.status === "cancelled", "PRE_DISPATCH_TASK_CANCELLED");
  check(beforeResult.upstream_required === false, "PRE_DISPATCH_UPSTREAM_NOT_REQUIRED");
  const beforeRow = (await client.query(
    "SELECT status,billing_state,price_charged,task_id_external FROM public.video_tasks WHERE id=$1",
    [beforeDispatch.taskId],
  )).rows[0];
  check(beforeRow.status === "cancelled", "PRE_DISPATCH_LOCAL_STATUS_CANCELLED");
  check(beforeRow.billing_state === "submission_failed", "PRE_DISPATCH_RESERVATION_RELEASED");
  check(Number(beforeRow.price_charged) === 0, "PRE_DISPATCH_ZERO_CHARGE");
  check(beforeRow.task_id_external === null, "PRE_DISPATCH_HAS_NO_UPSTREAM_TASK");

  const dispatched = fixture("cancel-upstream", user.id, model.id, `provider-${crypto.randomUUID()}`);
  const dispatchedReservation = await reserve(dispatched);
  check(dispatchedReservation.created === true, "DISPATCHED_FIXTURE_CREATED");
  const dispatchedRequest = value(await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [user.id, dispatched.clientRequestId],
  ));
  check(dispatchedRequest.upstream_required === true, "DISPATCHED_TASK_REQUIRES_UPSTREAM");
  const stillPending = (await client.query(
    "SELECT status FROM public.video_tasks WHERE id=$1",
    [dispatched.taskId],
  )).rows[0];
  check(stillPending.status === "pending", "DISPATCHED_TASK_NOT_LOCALLY_CANCELLED_EARLY");

  await client.query("SAVEPOINT wrong_provider_confirmation");
  let mismatchRejected = false;
  try {
    await client.query(
      "SELECT public.confirm_video_task_upstream_cancellation_atomic($1,$2,$3,$4)",
      [user.id, dispatched.clientRequestId, dispatched.taskId, "provider-wrong-id"],
    );
  } catch (error) {
    mismatchRejected = String(error?.message || "").includes("VIDEO_CANCELLATION_PROVIDER_TASK_MISMATCH");
    await client.query("ROLLBACK TO SAVEPOINT wrong_provider_confirmation");
  }
  check(mismatchRejected, "WRONG_PROVIDER_TASK_CONFIRMATION_REJECTED");

  const confirmed = value(await client.query(
    "SELECT public.confirm_video_task_upstream_cancellation_atomic($1,$2,$3,$4) AS result",
    [user.id, dispatched.clientRequestId, dispatched.taskId, dispatched.providerTaskId],
  ));
  check(confirmed.status === "cancelled", "EXACT_UPSTREAM_CONFIRMATION_CANCELS_LOCAL_TASK");
  const confirmedRow = (await client.query(
    "SELECT status,billing_state,price_charged FROM public.video_tasks WHERE id=$1",
    [dispatched.taskId],
  )).rows[0];
  check(confirmedRow.status === "cancelled", "CONFIRMED_TASK_STATUS_CANCELLED");
  check(confirmedRow.billing_state === "failed", "CONFIRMED_TASK_RESERVATION_RELEASED");
  check(Number(confirmedRow.price_charged) === 0, "CONFIRMED_TASK_ZERO_CHARGE");

  const charged = fixture("cancel-charged", user.id, model.id, `provider-${crypto.randomUUID()}`);
  await reserve(charged);
  const chargedRequest = value(await client.query(
    "SELECT public.request_video_task_cancellation_atomic($1,$2) AS result",
    [user.id, charged.clientRequestId],
  ));
  check(chargedRequest.upstream_required === true, "CHARGED_FIXTURE_FIRST_REQUIRES_UPSTREAM");
  await client.query("UPDATE public.video_tasks SET price_charged=1 WHERE id=$1", [charged.taskId]);
  const chargedConfirm = value(await client.query(
    "SELECT public.confirm_video_task_upstream_cancellation_atomic($1,$2,$3,$4) AS result",
    [user.id, charged.clientRequestId, charged.taskId, charged.providerTaskId],
  ));
  check(chargedConfirm.terminal_conflict === true, "CHARGED_TASK_CANNOT_BE_REWRITTEN_AS_CANCELLED");
  const chargedRow = (await client.query("SELECT status,price_charged FROM public.video_tasks WHERE id=$1", [charged.taskId])).rows[0];
  check(chargedRow.status === "pending", "CHARGED_CONFLICT_PRESERVES_TASK_STATUS");
  check(Number(chargedRow.price_charged) === 1, "CHARGED_CONFLICT_PRESERVES_ACCOUNTING");

  await client.query("ROLLBACK");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    localDatabase: `${identity.database_name}@${identity.server_address}:${identity.server_port}`,
    assertions,
    scenarios: 5,
    providerCalls: 0,
    paidCalls: 0,
    persistentDatabaseWrites: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "video-task-cancellation-local");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "database-regression.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
