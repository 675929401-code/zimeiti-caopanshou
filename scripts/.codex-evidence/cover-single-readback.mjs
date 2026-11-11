import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Operator-invoked, GET-only readback of the already approved original order.
// No dotenv/runtime file, provider, RPC, product mutation or automatic replay.
const EXPECTED_PARENT = "aa965c59-85fe-4826-b7b7-a28eb6182cab";
const EXPECTED_IMAGE_MODEL = "pm_PZ3hS353YQNbfRnz2_9Ro0aX";
const EXPECTED_ANALYSIS_MODEL = "pm_ZV1b1wzgWPnoikNWnBtABufh";
const MARKER = ".codex-evidence/cover-db-20261106-e29b/paid/single-paid-approval-consumed-20261106.json";
const DEFAULT_OUTPUT = ".codex-evidence/cover-paid-20261106-3fd15654/billing-readback.json";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_.:-]{1,180}$/u;
const sha = value => createHash("sha256").update(value).digest("hex");
const moneyEqual = (left, right) => Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 1e-6;
const present = value => value !== null && value !== undefined && value !== "";
const inList = values => `in.(${values.map(value => { assert.ok(ID.test(String(value))); return `"${value}"`; }).join(",")})`;

// Columns are taken from the owning migrations and route/repository contracts.
// JSON projections read only named metadata; never select a raw response,
// prompt, provider receipt object, storage key, URL or arbitrary JSON body.
const COLUMNS = Object.freeze({
  cover_prepare_operations: "id,user_id,client_request_id,state,revision,analysis_request_id,analysis_attempt_id,error_code,analysisFingerprint:preparation->>analysisPayloadFingerprint,analysisModelId:preparation->quote->analysis->>modelId,imageModelId:preparation->quote->image->>modelId,imageAmount:preparation->quote->image->>amount,imageResolution:preparation->quote->image->>resolution,reusedFrom:preparation->>reuseAnalysisOperationId,billingOperationId:billing->>operation_id,creditsCharged:billing->>credits_charged,created_at,updated_at",
  llm_request_attempts: "record_id,user_id,client_request_id,state,attempt_no,payload_fingerprint,provider_call_started_at,http_status,response_fingerprint,result_reference,error_code,created_at,updated_at",
  cover_generation_attempts: "id,user_id,surface,client_idempotency_key,client_trace_id,state,background_asset_id,result_asset_id,history_record_id,error_code,parentId:task->>prepareOperationId,publicModelId:generation_input->>modelId,planVersion:task->renderPlan->>planVersion,outputWidth:task->renderPlan->outputSpec->>width,outputHeight:task->renderPlan->outputSpec->>height,created_at,updated_at",
  image_generation_requests: "record_id,user_id,user_hash,client_idempotency_key,client_trace_id,state,delivery_state,delivery_asset_id,payload_fingerprint,publicModelId:request_snapshot->>publicModelId,resolution:request_snapshot->>resolution,quotedPriceYuan:request_snapshot->>quotedPriceYuan,billingExempt:request_snapshot->>billingExempt,imageCount:request_snapshot->>imageCount,dispatchReceiptId:provider_dispatch_receipt->>receiptId,submissionReceiptId:provider_submission_receipt->>receiptId,created_at,updated_at",
  wallet_operations: "id,user_id,wallet,operation_kind,idempotency_key,amount,delta,status,publicModelId:metadata->>public_model_id,created_at,completed_at",
  wallet_ledger_entries: "id,operation_id,user_id,wallet,operation_kind,idempotency_key,delta,created_at",
  user_files: "id,user_id,file_category,storage_provider,content_type,file_size,created_at,exportSchema:meta->coverGeneratedExport->>schema,exportRecordId:meta->coverGeneratedExport->>recordId,exportRequestBindingSha256:meta->coverGeneratedExport->>requestBindingSha256,exportSha256:meta->coverGeneratedExport->>sha256,exportBytes:meta->coverGeneratedExport->>byteLength,exportWidth:meta->coverGeneratedExport->>width,exportHeight:meta->coverGeneratedExport->>height",
  cover_generation_history: "asset_id,user_id,background_asset_id,history_record_id,output_width,output_height,source_width,source_height,task_no,planVersion:plan->>planVersion,outputRatio:plan->outputSpec->>aspectRatio,planWidth:plan->outputSpec->>width,planHeight:plan->outputSpec->>height,created_at,hidden_at",
  conversation_messages: "id,user_id,agent_id,role,created_at",
});

export async function main(args = process.argv.slice(2)) {
  const OUTPUT = args.includes("--diagnostic-before-repair") ? DEFAULT_OUTPUT.replace(/\.json$/u, "-before-repair.json") : DEFAULT_OUTPUT;
  assert.ok(args.includes("--read-original-cover-only"), "READ_ORIGINAL_COVER_FLAG_REQUIRED");
  assert.equal(path.resolve(process.cwd()).replaceAll("\\", "/").toLowerCase(),
    "f:/总项目文件/skill存储系统/01_网页开发项目/自媒体操盘手/当前版本", "CANONICAL_F_SOURCE_REQUIRED");
  assert.equal(String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/$/u, ""), "http://127.0.0.1:5000", "LOCAL_SESSION_ORIGIN_REQUIRED");
  const database = new URL(process.env.COZE_SUPABASE_URL || "http://invalid");
  assert.equal(database.origin, "http://127.0.0.1:54321", "LOOPBACK_DATABASE_REQUIRED");
  const configuration = new URL(process.env.SHARED_CONFIGURATION_SUPABASE_URL || "http://invalid");
  assert.equal(configuration.origin, database.origin, "LOOPBACK_CONFIGURATION_REQUIRED");
  const sessionToken = process.env.LOCAL_NAV_ADMIN_TOKEN;
  const service = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(typeof sessionToken === "string" && sessionToken.length > 10, "VERIFIED_SESSION_REQUIRED");
  assert.ok(typeof service === "string" && service.length > 10, "WRAPPER_SERVICE_AUTHORITY_REQUIRED");
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "null");
  const userId = identity?.user?.id;
  assert.ok(identity?.user?.role === "admin" && UUID.test(userId || ""), "VERIFIED_EXISTING_OWNER_REQUIRED");
  const marker = JSON.parse(await fs.readFile(path.resolve(MARKER), "utf8"));
  assert.equal(marker.operationId, EXPECTED_PARENT, "ONLY_ORIGINAL_PARENT_ALLOWED");
  assert.ok(UUID.test(marker.clientRequestId || ""), "ORIGINAL_CLIENT_KEY_REQUIRED");
  assert.equal(marker.imageModelId, EXPECTED_IMAGE_MODEL);
  assert.equal(marker.analysisModelId, EXPECTED_ANALYSIS_MODEL);
  assert.ok(moneyEqual(marker.imageYuan, .30));
  const generationKey = `coverwb_${EXPECTED_PARENT}`;
  const analysisKey = `cover_analysis_${sha(`${userId}:${marker.clientRequestId}`).slice(0, 48)}`;
  const analysisRecordId = sha(`${userId}\0${analysisKey}`);
  const imageRecordId = sha(`${userId}\0${generationKey}`);
  const imageBillingKey = `image:h3_${sha(`${userId}:${generationKey}`).slice(0, 48)}`;
  const analysisPhases = ["response", "thinking", "answer", "skill-detect", "skill-answer", "coze-response"];
  const analysisBillingKeys = analysisPhases.map(phase => `llm:${analysisKey}:${phase}`);
  const walletKeys = [...analysisBillingKeys, ...analysisBillingKeys.map(key => `${key}:release`), imageBillingKey, `${imageBillingKey}:release`];
  const report = { schemaVersion: 1, scope: "GET-only original local cover billing and ownership readback", startedAt: new Date().toISOString(),
    operationId: EXPECTED_PARENT, clientRequestId: marker.clientRequestId, generationKey, userId,
    expected: { analysisModelId: EXPECTED_ANALYSIS_MODEL, imageModelId: EXPECTED_IMAGE_MODEL, imageYuan: .30, width: 1080, height: 1440 },
    reads: [], checks: [], records: {}, passed: false, providerCalls: 0, databaseWrites: 0,
    boundary: "No model dispatch/retry, RPC, balance mutation, raw response/prompt/provider URL/token readback. Counts concern the exact durable original keys, not an account-wide provider inventory." };
  const check = (condition, code) => report.checks.push({ code, passed: Boolean(condition) });
  const one = (rows, code) => { check(rows.length === 1, code); return rows.length === 1 ? rows[0] : null; };
  async function read(table, filters) {
    assert.ok(Object.hasOwn(COLUMNS, table), "UNAPPROVED_TABLE");
    assert.ok(Object.keys(filters).length > 0 && !Object.hasOwn(filters, "user_id"), "ORIGINAL_ORDER_FILTER_REQUIRED");
    const url = new URL(`/rest/v1/${table}`, database.origin);
    url.searchParams.set("select", COLUMNS[table]);
    url.searchParams.set("user_id", `eq.${userId}`);
    url.searchParams.set("limit", "32");
    for (const [field, value] of Object.entries(filters)) url.searchParams.set(field, value);
    const response = await fetch(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { apikey: service, Authorization: `Bearer ${service}`, Accept: "application/json" } });
    report.reads.push({ table, method: "GET", status: response.status });
    if (!response.ok) throw new Error(`READBACK_${table.toUpperCase()}_HTTP_${response.status}`);
    const rows = await response.json();
    assert.ok(Array.isArray(rows) && rows.length < 32, "BOUNDED_ROW_ARRAY_REQUIRED");
    assert.ok(rows.every(row => row.user_id === userId), "OWNER_FILTER_VIOLATION");
    return rows;
  }
  try {
    const parent = one(await read("cover_prepare_operations", { id: `eq.${EXPECTED_PARENT}`, client_request_id: `eq.${marker.clientRequestId}` }), "exactly_one_owned_original_parent");
    report.records.parent = parent;
    if (!parent) throw new Error("ORIGINAL_OWNED_PARENT_NOT_FOUND");
    check(parent.state === "plan_ready", "parent_plan_ready");
    check(parent.analysis_request_id === analysisKey && parent.analysis_attempt_id === analysisRecordId, "parent_original_analysis_binding");
    check(parent.analysisModelId === EXPECTED_ANALYSIS_MODEL && parent.imageModelId === EXPECTED_IMAGE_MODEL, "parent_approved_models");
    check(moneyEqual(parent.imageAmount, .30) && parent.imageResolution === "2K" && !present(parent.reusedFrom), "parent_original_paid_analysis_and_image_quote");
    const llm = one(await read("llm_request_attempts", { client_request_id: `eq.${analysisKey}` }), "exactly_one_original_llm_child");
    report.records.llm = llm;
    check(llm?.record_id === analysisRecordId && llm?.attempt_no === 1 && present(llm?.provider_call_started_at), "one_original_llm_provider_attempt");
    check(llm?.state === "succeeded" && llm?.http_status === 200 && llm?.payload_fingerprint === parent.analysisFingerprint, "llm_success_and_parent_payload_fingerprint");
    check(HASH.test(llm?.response_fingerprint || "") && llm?.result_reference === `llm-result:${analysisRecordId}:1:${llm?.response_fingerprint}`, "llm_result_reference_binding_without_response_read");
    const attempt = one(await read("cover_generation_attempts", { client_idempotency_key: `eq.${generationKey}`, client_trace_id: `eq.${generationKey}` }), "exactly_one_original_cover_attempt");
    report.records.coverAttempt = attempt;
    check(attempt?.parentId === EXPECTED_PARENT && attempt?.publicModelId === EXPECTED_IMAGE_MODEL, "cover_attempt_parent_and_model_binding");
    check(attempt?.state === "completed" && Number(attempt?.planVersion) === 2 && Number(attempt?.outputWidth) === 1080 && Number(attempt?.outputHeight) === 1440, "cover_attempt_completed_fixed_output");
    const image = one(await read("image_generation_requests", { client_idempotency_key: `eq.${generationKey}`, client_trace_id: `eq.${generationKey}` }), "exactly_one_original_image_request");
    report.records.image = image;
    check(image?.record_id === imageRecordId && image?.user_hash === sha(userId), "image_record_and_owner_hash_binding");
    check(image?.state === "completed" && image?.delivery_state === "delivered", "original_image_completed_and_delivered");
    check(image?.publicModelId === EXPECTED_IMAGE_MODEL && image?.resolution === "2K" && moneyEqual(image?.quotedPriceYuan, .30)
      && image?.billingExempt !== "true" && Number(image?.imageCount) === 1, "image_one_approved_model_2k_price_and_count");
    check(present(image?.dispatchReceiptId) && present(image?.submissionReceiptId), "image_original_dispatch_and_submission_receipts_present");

    const operations = await read("wallet_operations", { idempotency_key: inList(walletKeys) });
    report.records.walletOperations = operations;
    const analysisCharges = operations.filter(row => row.wallet === "credits" && row.operation_kind === "credit_charge");
    const imageCharges = operations.filter(row => row.wallet === "cash" && row.operation_kind === "cash_charge");
    const credit = one(analysisCharges, "exactly_one_original_analysis_credit_charge");
    const cash = one(imageCharges, "exactly_one_original_image_cash_charge");
    check(operations.length === 2 && operations.every(row => row.status === "completed"), "only_two_completed_original_charges_no_refund_or_extra_phase");
    check(credit?.idempotency_key === `llm:${analysisKey}:response` && String(credit?.id) === String(parent.billingOperationId)
      && credit?.publicModelId === EXPECTED_ANALYSIS_MODEL && Number(parent.creditsCharged) > 0 && moneyEqual(credit?.amount, parent.creditsCharged)
      && moneyEqual(credit?.delta, -Number(parent.creditsCharged)), "analysis_parent_billing_operation_and_actual_credits_match");
    check(cash?.idempotency_key === imageBillingKey && moneyEqual(cash?.amount, .30) && moneyEqual(cash?.delta, -.30), "image_exact_cash_charge_030");
    if (operations.length) {
      const ledger = await read("wallet_ledger_entries", { operation_id: inList(operations.map(row => String(row.id))) });
      report.records.walletLedger = ledger;
      check(ledger.length === operations.length && operations.every(operation => {
        const matches = ledger.filter(entry => String(entry.operation_id) === String(operation.id));
        return matches.length === 1 && matches[0].wallet === operation.wallet && matches[0].operation_kind === operation.operation_kind
          && matches[0].idempotency_key === operation.idempotency_key && moneyEqual(matches[0].delta, operation.delta);
      }), "every_original_wallet_operation_has_one_matching_ledger_entry");
    } else check(false, "every_original_wallet_operation_has_one_matching_ledger_entry");

    if (UUID.test(attempt?.background_asset_id || "") && UUID.test(attempt?.result_asset_id || "")) {
      const assets = await read("user_files", { id: inList([attempt.background_asset_id, attempt.result_asset_id]) });
      report.records.assets = assets;
      const background = assets.find(asset => asset.id === attempt.background_asset_id);
      const exportBinding = sha(JSON.stringify([userId, imageRecordId, generationKey, generationKey]));
      check(image?.delivery_asset_id === attempt.background_asset_id || background?.exportSchema === "cover_generated_export/1"
        && background.exportRecordId === imageRecordId && background.exportRequestBindingSha256 === exportBinding
        && HASH.test(background.exportSha256 || "") && Number(background.exportBytes) === Number(background.file_size)
        && Number(background.exportWidth) > 0 && Number(background.exportHeight) > 0, "original_paid_image_bound_to_owned_background_by_delivery_or_verified_export");
      check(attempt.background_asset_id !== attempt.result_asset_id && assets.length === 2 && assets.every(asset => asset.file_category === "image"
        && asset.storage_provider === "tencent_cos" && Number(asset.file_size) > 0 && /^image\/(png|jpeg|webp)$/u.test(asset.content_type)), "original_background_and_cover_are_two_owned_cloud_image_assets");
      const history = one(await read("cover_generation_history", { asset_id: `eq.${attempt.result_asset_id}` }), "exactly_one_owned_original_cover_history");
      report.records.coverHistory = history;
      check(history?.background_asset_id === attempt.background_asset_id && history?.history_record_id === attempt.history_record_id
        && Number(history?.planVersion) === 2 && history?.outputRatio === "3:4" && Number(history?.output_width) === 1080 && Number(history?.output_height) === 1440
        && Number(history?.planWidth) === 1080 && Number(history?.planHeight) === 1440 && !history?.hidden_at, "owned_history_matches_original_assets_and_fixed_1080x1440_plan");
      if (ID.test(attempt.history_record_id || "")) {
        const message = one(await read("conversation_messages", { id: `eq.${attempt.history_record_id}` }), "exactly_one_owned_original_media_history_message");
        report.records.mediaHistory = message;
        check(message?.agent_id === "image-workbench" && message?.role === "assistant", "saved_media_history_owner_and_agent_binding");
      } else check(false, "exactly_one_owned_original_media_history_message");
    } else check(false, "original_background_and_cover_have_owned_asset_ids");
    report.actualFees = { credits: present(parent.creditsCharged) ? Number(parent.creditsCharged) : null,
      cashYuan: cash ? Number(cash.amount) : null, analysisWalletOperationId: parent.billingOperationId || null,
      imageWalletOperationId: cash ? String(cash.id) : null };
    report.passed = report.checks.every(item => item.passed);
    report.outcome = report.passed ? "original_fees_ownership_and_history_verified" : "original_order_incomplete_or_mismatched_no_retry";
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.failure = { code: /^[A-Z][A-Z0-9_]{1,150}$/u.test(error?.message || "") ? error.message : "READBACK_UNCONFIRMED_NO_RETRY" };
    report.outcome = "readback_unconfirmed_no_retry";
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assert.ok(!serialized.includes(service) && !serialized.includes(sessionToken), "SECRET_MUST_NOT_BE_RECORDED");
    assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u);
    assert.doesNotMatch(serialized, /https?:\/\//u, "PROVIDER_OR_STORAGE_URL_MUST_NOT_BE_RECORDED");
    await fs.mkdir(path.dirname(path.resolve(OUTPUT)), { recursive: true });
    await fs.writeFile(path.resolve(OUTPUT), serialized, { flag: "wx" });
    console.log(JSON.stringify({ passed: report.passed, outcome: report.outcome, operationId: EXPECTED_PARENT,
      actualFees: report.actualFees, failedChecks: report.checks.filter(item => !item.passed).map(item => item.code), report: OUTPUT }));
  }
}
