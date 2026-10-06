#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const modelId = process.argv.find((value) => value.startsWith("--model-id="))
  ?.slice("--model-id=".length).trim();
if (!modelId) throw new Error("MODEL_ID_REQUIRED");

const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
if (runtime.ownerConnection?.host !== "127.0.0.1" || runtime.ownerConnection?.database !== "zimeiti_local") {
  throw new Error("LOCAL_DATABASE_REQUIRED");
}

const db = new pg.Client(runtime.ownerConnection);
await db.connect();
try {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const validation = (await db.query(`
    select validation_id,user_id,client_idempotency_key,image_record_id,state,quoted_price_yuan,cost_price_yuan,asset_id
      from public.image_model_validations
     where model_id=$1
     order by created_at desc
     limit 1
  `, [modelId])).rows[0];
  if (!validation) throw new Error("VALIDATION_NOT_FOUND");
  const billingKey = `image:h3_${createHash("sha256").update(`${validation.user_id}:${validation.client_idempotency_key}`).digest("hex").slice(0, 48)}`;
  const model = await db.query("select id,cost_price,selling_price,is_active,is_hidden from public.cover_models where id=$1", [modelId]);
  const operation = await db.query("select id,wallet,operation_kind,status,amount,delta,idempotency_key from public.wallet_operations where user_id=$1 and idempotency_key=$2", [validation.user_id, billingKey]);
  const ledger = await db.query("select operation_id,wallet,operation_kind,delta,idempotency_key from public.wallet_ledger_entries where user_id=$1 and idempotency_key=$2", [validation.user_id, billingKey]);
  const revenue = await db.query("select model_id,task_id,cost_price,selling_price,record_type,cash_charged,billing_exempt,profit from public.revenue_records where user_id=$1 and task_id=$2 and record_type='image'", [validation.user_id, billingKey]);
  const cash = await db.query("select type,amount,reference_id from public.cash_transactions where user_id=$1 and reference_id=$2", [validation.user_id, billingKey]);
  const request = await db.query("select delivery_asset_id from public.image_generation_requests where record_id=$1 and user_id=$2", [validation.image_record_id, validation.user_id]);
  const assetId = validation.asset_id || request.rows[0]?.delivery_asset_id;
  const asset = await db.query("select id,meta from public.user_files where id=$1 and user_id=$2", [assetId, validation.user_id]);
  const meta = asset.rows[0]?.meta || {};
  const report = {
    inspectedAt: new Date().toISOString(),
    model: model.rows[0] || null,
    validation: {
      id: validation.validation_id,
      state: validation.state,
      imageRecordId: validation.image_record_id,
      quotedPrice: Number(validation.quoted_price_yuan),
      costPrice: Number(validation.cost_price_yuan),
      hasAsset: Boolean(validation.asset_id),
      deliveredAssetId: assetId || null,
    },
    billingKey,
    operations: operation.rows,
    ledger: ledger.rows,
    revenue: revenue.rows,
    cashTransactions: cash.rows,
    assetBillingMeta: {
      billingReferenceId: meta.billingReferenceId,
      quotedPriceYuan: meta.quotedPriceYuan,
      actualCostPriceYuan: meta.actualCostPriceYuan,
      billingExempt: meta.billingExempt,
      billingExemptionReason: meta.billingExemptionReason,
      billingOperationId: meta.billingOperationId,
    },
    databaseWrites: 0,
    providerRequests: 0,
  };
  const output = path.resolve(".codex-evidence/gpt-image2-three-groups-live/latest-billing-diagnostic.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, output }, null, 2));
  await db.query("ROLLBACK");
} finally {
  await db.end();
}
