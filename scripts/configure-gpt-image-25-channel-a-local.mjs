#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import pg from "pg";

const TARGETS = [
  { id: "pending-cover-model-1789125082114-2ea1a1e15b37", modelName: "gpt-image-2.5-sunburst" },
  { id: "pending-cover-model-1789125219296-147da9a502d5", modelName: "gpt-image-2.5-flare" },
];
const PIXEL_SIZES = {
  "1K": {
    "1:1": "1024x1024",
    "16:9": "1280x720",
    "9:16": "720x1280",
    "3:2": "1056x704",
    "2:3": "704x1056",
  },
  "2K": {
    "1:1": "2048x2048",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
    "3:2": "2016x1344",
    "2:3": "1344x2016",
  },
  "4K": {
    "1:1": "2880x2880",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "3:2": "3504x2336",
    "2:3": "2336x3504",
  },
};
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function validatePixelSizes() {
  for (const [resolution, ratios] of Object.entries(PIXEL_SIZES)) {
    for (const [ratio, size] of Object.entries(ratios)) {
      const [width, height] = size.split("x").map(Number);
      const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
      assert.ok(width % 16 === 0 && height % 16 === 0, `${resolution}:${ratio}:MULTIPLE_OF_16_REQUIRED`);
      assert.ok(width * height >= 655_360, `${resolution}:${ratio}:MIN_PIXEL_COUNT_REQUIRED`);
      assert.ok(width * height <= 8_294_400, `${resolution}:${ratio}:MAX_PIXEL_COUNT_EXCEEDED`);
      assert.ok(width <= 3_840 && height <= 3_840, `${resolution}:${ratio}:MAX_EDGE_EXCEEDED`);
      assert.ok(Math.abs(width / height - ratioWidth / ratioHeight) < 0.001, `${resolution}:${ratio}:RATIO_MISMATCH`);
    }
  }
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-gpt-image-25-protocol"), "LOCAL_GPT_IMAGE_25_CONFIRMATION_REQUIRED");
validatePixelSizes();

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-gpt-image-25-channel-a-protocol",
  query_timeout: 30_000,
});
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  const ids = TARGETS.map((target) => target.id);
  const beforeResult = await client.query(`SELECT id,name,model_name,provider,api_endpoint,is_active,is_hidden,supports_image_input,api_protocol_config
    FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id`, [ids]);
  assert.equal(beforeResult.rowCount, TARGETS.length, "GPT_IMAGE_25_MODELS_MISSING");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260926101500]);
  for (const target of TARGETS) {
    const row = beforeResult.rows.find((candidate) => candidate.id === target.id);
    assert.equal(row.model_name, target.modelName, `${target.id}:MODEL_IDENTITY_MISMATCH`);
    assert.equal(row.provider, "openai_compat", `${target.id}:PROVIDER_MISMATCH`);
    assert.equal(new URL(row.api_endpoint).hostname, "token.secure-skill.com", `${target.id}:ENDPOINT_MISMATCH`);
    const nextConfig = {
      ...record(row.api_protocol_config),
      submit_path: "/v1/images/generations",
      edit_path: "/v1/images/edits",
      response_transport: "json",
      reference_transport: "edits_multipart_array",
      request_pixel_size_by_resolution: PIXEL_SIZES,
      provider_contract: "openai_images_gpt_2_5_2026_09",
    };
    await client.query(`UPDATE public.cover_models
      SET api_protocol_config=$2::jsonb,is_active=true,is_hidden=false,updated_at=now()
      WHERE id=$1`, [target.id, JSON.stringify(nextConfig)]);
  }
  await client.query("COMMIT");
  transactionOpen = false;

  const afterResult = await client.query(`SELECT id,name,model_name,provider,api_endpoint,is_active,is_hidden,supports_image_input,api_protocol_config
    FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id`, [ids]);
  for (const row of afterResult.rows) {
    assert.equal(row.is_active, true, `${row.id}:MUST_REMAIN_ACTIVE`);
    assert.equal(row.is_hidden, false, `${row.id}:MUST_REMAIN_VISIBLE`);
    assert.equal(row.api_protocol_config?.reference_transport, "edits_multipart_array");
    assert.deepEqual(row.api_protocol_config?.request_pixel_size_by_resolution, PIXEL_SIZES);
  }
  console.log(JSON.stringify({
    passed: true,
    localDatabaseOnly: true,
    database: identity.database_name,
    serverAddress: identity.server_address,
    serverPort: identity.server_port,
    models: afterResult.rows.map((row) => ({
      id: row.id,
      modelName: row.model_name,
      active: row.is_active,
      hidden: row.is_hidden,
      protocolConfigBefore: hash(beforeResult.rows.find((candidate) => candidate.id === row.id)?.api_protocol_config || {}),
      protocolConfigAfter: hash(row.api_protocol_config || {}),
      oneKLandscape: row.api_protocol_config.request_pixel_size_by_resolution["1K"]["16:9"],
    })),
    providerCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
