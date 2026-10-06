import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const EVIDENCE_DIR = path.resolve(".codex-evidence/storyboard-image-capability-reconciliation-r351");
const LOW_GROUP_ID = "pending-cover-model-gpt-image-2-image-2-1k";
const ADOBE_GROUP_ID = "pending-cover-model-gpt-image-2-adobe-mid";
const OFFICIAL_GROUP_ID = "pending-cover-model-gpt-image-2-official";
const ACCOUNT_UNAVAILABLE_MODEL_NAMES = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
const FIXED_TARGET_IDS = [LOW_GROUP_ID, ADOBE_GROUP_ID, OFFICIAL_GROUP_ID];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function money(value, fallback) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : fallback;
}

function safeRow(row) {
  const config = object(row.api_protocol_config);
  return {
    id: row.id,
    name: row.name,
    modelName: row.model_name,
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    costPrice: Number(row.cost_price),
    sellingPrice: Number(row.selling_price),
    resolutions: config.resolution_options || [],
    defaultResolution: config.default_resolution || "",
    resolutionCosts: config.resolution_cost_prices || {},
    resolutionPrices: config.resolution_prices || {},
    aspectRatios: config.aspect_ratios || [],
    catalogVisibility: config.catalog_visibility || "",
    publicAvailabilityCode: config.public_availability_code || "",
    activationState: config.activation_state || "",
  };
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-image-capability-reconciliation"), "LOCAL_CAPABILITY_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
const connection = runtime.ownerConnection;
assert.equal(connection.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(connection.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(connection.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

await mkdir(EVIDENCE_DIR, { recursive: true });
const client = new pg.Client({ ...connection, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
let transactionOpen = false;
try {
  await client.connect();
  const identity = (await client.query(
    "select current_database() as database_name, inet_server_addr()::text as server_address, inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  const beforeRows = (await client.query(`
    select id,name,model_name,cost_price,selling_price,is_active,is_hidden,api_protocol_config
      from public.cover_models
     where id = any($1::text[])
        or (model_name = any($2::text[]) and is_active=true and is_hidden=false)
     order by id
  `, [FIXED_TARGET_IDS, ACCOUNT_UNAVAILABLE_MODEL_NAMES])).rows;
  assert.equal(beforeRows.length, FIXED_TARGET_IDS.length + ACCOUNT_UNAVAILABLE_MODEL_NAMES.length, "TARGET_IMAGE_MODELS_MISSING");
  assert.equal(beforeRows.find((row) => row.id === LOW_GROUP_ID)?.model_name, "gpt-image-2");
  assert.equal(beforeRows.find((row) => row.id === ADOBE_GROUP_ID)?.model_name, "gpt-image-2");
  for (const modelName of ACCOUNT_UNAVAILABLE_MODEL_NAMES) {
    assert.equal(beforeRows.filter((row) => row.model_name === modelName).length, 1, `ACTIVE_ACCOUNT_TARGET_NOT_UNIQUE:${modelName}`);
  }
  const accountUnavailableIds = [
    OFFICIAL_GROUP_ID,
    ...ACCOUNT_UNAVAILABLE_MODEL_NAMES.map((modelName) => beforeRows.find((row) => row.model_name === modelName).id),
  ];
  const targetIds = [LOW_GROUP_ID, ADOBE_GROUP_ID, ...accountUnavailableIds];

  await client.query("begin");
  transactionOpen = true;
  await client.query("select pg_advisory_xact_lock($1)", ["260921171000"]);
  await client.query("select id from public.cover_models where id = any($1::text[]) for update", [targetIds]);

  const lowConfig = {
    resolution_options: ["1K"],
    default_resolution: "1K",
    resolution_cost_prices: { "1K": 0.05 },
    resolution_prices: { "1K": 0.1 },
  };
  await client.query(`
    update public.cover_models
       set cost_price=$2, selling_price=$3, is_active=true, is_hidden=false,
           api_protocol_config=(coalesce(api_protocol_config,'{}'::jsonb) - 'catalog_visibility' - 'public_availability_code') || $4::jsonb,
           updated_at=now()
     where id=$1
  `, [LOW_GROUP_ID, 0.05, 0.1, JSON.stringify(lowConfig)]);

  const adobeBefore = beforeRows.find((row) => row.id === ADOBE_GROUP_ID);
  const adobeConfig = object(adobeBefore.api_protocol_config);
  const adobeCosts = object(adobeConfig.resolution_cost_prices);
  const adobePrices = object(adobeConfig.resolution_prices);
  const verifiedAdobeConfig = {
    resolution_options: ["1K", "2K", "4K"],
    default_resolution: "2K",
    resolution_cost_prices: {
      "1K": money(adobeCosts["1K"], Number(adobeBefore.cost_price)),
      "2K": money(adobeCosts["2K"], Number(adobeBefore.cost_price)),
      "4K": money(adobeCosts["4K"], Number(adobeBefore.cost_price)),
    },
    resolution_prices: {
      "1K": money(adobePrices["1K"], Number(adobeBefore.selling_price)),
      "2K": money(adobePrices["2K"], Number(adobeBefore.selling_price)),
      "4K": money(adobePrices["4K"], Number(adobeBefore.selling_price)),
    },
  };
  await client.query(`
    update public.cover_models
       set is_active=true, is_hidden=false,
           api_protocol_config=(coalesce(api_protocol_config,'{}'::jsonb) - 'catalog_visibility' - 'public_availability_code') || $2::jsonb,
           updated_at=now()
     where id=$1
  `, [ADOBE_GROUP_ID, JSON.stringify(verifiedAdobeConfig)]);

  for (const id of accountUnavailableIds) {
    const current = beforeRows.find((row) => row.id === id);
    const config = object(current.api_protocol_config);
    const costs = object(config.resolution_cost_prices);
    const prices = object(config.resolution_prices);
    const isImage25 = String(current.model_name).startsWith("gpt-image-2.5-");
    const unavailableConfig = {
      catalog_visibility: "visible_disabled",
      public_availability_code: "upstream_account_unavailable",
      activation_state: "upstream_account_unavailable",
      ...(isImage25 ? {
        resolution_options: ["1K"],
        default_resolution: "1K",
        resolution_cost_prices: { "1K": money(costs["1K"], Number(current.cost_price)) },
        resolution_prices: { "1K": money(prices["1K"], Number(current.selling_price)) },
        aspect_ratios: ["1:1", "3:2", "2:3"],
      } : {}),
    };
    await client.query(`
      update public.cover_models
         set is_active=false, is_hidden=false,
             api_protocol_config=coalesce(api_protocol_config,'{}'::jsonb) || $2::jsonb,
             updated_at=now()
       where id=$1
    `, [id, JSON.stringify(unavailableConfig)]);
  }

  await client.query("notify pgrst, 'reload schema'");
  await client.query("commit");
  transactionOpen = false;

  const afterRows = (await client.query(`
    select id,name,model_name,cost_price,selling_price,is_active,is_hidden,api_protocol_config
      from public.cover_models
     where id = any($1::text[])
     order by id
  `, [targetIds])).rows;
  const after = afterRows.map(safeRow);
  const low = after.find((row) => row.id === LOW_GROUP_ID);
  assert.deepEqual(low.resolutions, ["1K"]);
  assert.equal(low.defaultResolution, "1K");
  assert.equal(low.active, true);
  const adobe = after.find((row) => row.id === ADOBE_GROUP_ID);
  assert.deepEqual(adobe.resolutions, ["1K", "2K", "4K"]);
  assert.equal(adobe.defaultResolution, "2K");
  assert.equal(adobe.active, true);
  for (const id of accountUnavailableIds) {
    const row = after.find((item) => item.id === id);
    assert.equal(row.active, false, `ACCOUNT_TARGET_ACTIVE:${id}`);
    assert.equal(row.hidden, false, `ACCOUNT_TARGET_HIDDEN:${id}`);
    assert.equal(row.catalogVisibility, "visible_disabled", `ACCOUNT_TARGET_NOT_VISIBLE_DISABLED:${id}`);
    assert.equal(row.publicAvailabilityCode, "upstream_account_unavailable", `ACCOUNT_TARGET_STATUS_MISMATCH:${id}`);
  }

  const evidence = {
    checkedAt: new Date().toISOString(),
    localOnly: true,
    database: identity.database_name,
    serverAddress: identity.server_address,
    serverPort: identity.server_port,
    before: beforeRows.map(safeRow),
    after,
    verifiedCanaries: {
      lowGroup: { resolutions: ["1K"], output: "1672x941", result: "completed" },
      adobeMid: { resolutions: ["1K", "2K", "4K"], outputs: ["1536x864", "2048x1152", "3840x2160"], result: "completed" },
      accountUnavailable: accountUnavailableIds,
    },
    sourceSha256: sha256(await readFile(import.meta.filename)),
    databaseWrites: true,
    providerRequests: 0,
    paidGenerationRequests: 0,
    credentialsPrinted: false,
  };
  const output = path.join(EVIDENCE_DIR, "summary.json");
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, output, after }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end();
}
