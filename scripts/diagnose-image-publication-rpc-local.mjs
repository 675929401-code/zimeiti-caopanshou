#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import sharp from "sharp";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const modelId = process.argv.find((value) => value.startsWith("--model-id="))?.slice("--model-id=".length).trim();
const runtimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  assert.ok(modelId, "MODEL_ID_REQUIRED");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
  assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
  assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
  const db = new pg.Client(runtime.ownerConnection);
  await db.connect();
  let transactionOpen = false;
  try {
    const validation = (await db.query(`
      select validation_id,user_id,configuration_hash,model_snapshot_hash,image_record_id
        from public.image_model_validations where model_id=$1 order by created_at desc limit 1
    `, [modelId])).rows[0];
    assert.ok(validation, "VALIDATION_NOT_FOUND");
    const model = (await db.query("select is_active,is_hidden from public.cover_models where id=$1", [modelId])).rows[0];
    const request = (await db.query("select delivery_asset_id from public.image_generation_requests where record_id=$1 and user_id=$2", [validation.image_record_id, validation.user_id])).rows[0];
    const asset = (await db.query("select id,storage_key,file_size,content_type from public.user_files where id=$1 and user_id=$2", [request.delivery_asset_id, validation.user_id])).rows[0];
    assert.ok(asset, "DELIVERED_ASSET_NOT_FOUND");

    const response = await fetch(`${origin}/api/storage/files/${encodeURIComponent(asset.id)}/content?download=1`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `ASSET_READ_FAILED:${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(bytes.length, Number(asset.file_size), "ASSET_SIZE_MISMATCH");
    const evidence = {
      schema: "image_decoded_asset.v1",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: Number(metadata.width),
      height: Number(metadata.height),
    };

    await db.query("BEGIN");
    transactionOpen = true;
    try {
      await db.query(`select public.publish_image_model_validation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [
        validation.validation_id,
        validation.user_id,
        validation.configuration_hash,
        validation.model_snapshot_hash,
        model.is_active,
        model.is_hidden,
        String(asset.id),
        asset.storage_key,
        Number(asset.file_size),
        asset.content_type,
        JSON.stringify(evidence),
      ]);
      console.log(JSON.stringify({ success: true, wouldPublish: true, rolledBack: true }));
    } catch (error) {
      console.log(JSON.stringify({
        success: false,
        wouldPublish: false,
        rolledBack: true,
        databaseCode: /^[A-Z0-9]{5}$/u.test(String(error?.code || "")) ? error.code : null,
        databaseMessage: String(error?.message || "UNKNOWN_DATABASE_ERROR").slice(0, 300),
      }));
    }
    await db.query("ROLLBACK");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "IMAGE_PUBLICATION_RPC_DIAGNOSTIC_FAILED");
    process.exitCode = 1;
  });
}
