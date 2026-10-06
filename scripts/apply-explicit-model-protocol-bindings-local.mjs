#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261006103500";
const NAME = "explicit_model_protocol_bindings";
const FILE = `${VERSION}_${NAME}.sql`;
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const backupDirectory = process.env.MODEL_PROTOCOL_BACKUP_DIRECTORY?.trim();

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-only"), "LOCAL_ONLY_CONFIRMATION_REQUIRED");
assert.ok(backupDirectory, "MODEL_PROTOCOL_BACKUP_DIRECTORY_REQUIRED");

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const sql = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = sql.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
assert.doesNotMatch(normalized, /TRUNCATE\s+|DELETE\s+FROM|DROP\s+TABLE/iu);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const migrationHash = sha256(sql);

const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-explicit-model-protocol-bindings",
  query_timeout: 120_000,
});
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name,inet_server_addr()::text AS server_address,inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.match(identity.server_address, /^127\.0\.0\.1(?:\/32)?$/u);

  const before = {
    llm: (await client.query("SELECT id,model_name,api_endpoint,api_protocol_config FROM public.llm_models ORDER BY id")).rows,
    image: (await client.query("SELECT id,model_name,provider,api_endpoint,api_protocol_config FROM public.cover_models ORDER BY id")).rows,
    video: (await client.query("SELECT id,model_name,provider,api_endpoint,protocol_type,api_protocol_config FROM public.video_models ORDER BY id")).rows,
  };
  await fs.mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, "local-db-protocol-bindings-before.json");
  await fs.writeFile(backupPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    target: `${identity.server_address}:${identity.server_port}/${identity.database_name}`,
    credentialsIncluded: false,
    ...before,
  }, null, 2), "utf8");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [261006103500]);
  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], migrationHash, "codex-local-explicit-model-protocols"],
    );
  }
  await client.query("COMMIT");
  transactionOpen = false;

  const missingLlm = await client.query(`SELECT count(*)::int AS count FROM public.llm_models
    WHERE coalesce(api_protocol_config->>'provider','')=''
       OR coalesce(api_protocol_config->>'protocol','') NOT IN ('openai_chat','anthropic_messages')`);
  const missingImage = await client.query(`SELECT count(*)::int AS count FROM public.cover_models
    WHERE coalesce(provider,'')=''
       OR coalesce(api_protocol_config->>'protocol','') NOT IN ('chat_completions','google_generate_content','images_generations','images_edits')`);
  const missingVideo = await client.query(`SELECT count(*)::int AS count FROM public.video_models
    WHERE coalesce(provider,'')='' OR coalesce(protocol_type,'')=''`);
  assert.equal(missingLlm.rows[0].count, 0, "LLM_BINDING_BACKFILL_INCOMPLETE");
  assert.equal(missingImage.rows[0].count, 0, "IMAGE_BINDING_BACKFILL_INCOMPLETE");
  assert.equal(missingVideo.rows[0].count, 0, "VIDEO_BINDING_BACKFILL_INCOMPLETE");

  const repairedImages = await client.query(`SELECT id,model_name,provider,
      api_protocol_config->>'protocol' AS protocol,
      api_protocol_config->>'reference_transport' AS reference_transport
    FROM public.cover_models
    WHERE id=ANY($1::text[]) ORDER BY id`, [["gemini-3-0-pro-image-chA", "gemini-3-1-flash-image-chA"]]);
  assert.equal(repairedImages.rowCount, 2, "REPAIRED_IMAGE_MODELS_MISSING");
  for (const row of repairedImages.rows) {
    assert.equal(row.provider, "secure_skill_chat");
    assert.equal(row.protocol, "chat_completions");
    assert.equal(row.reference_transport, "chat_inline_data");
  }

  console.log(JSON.stringify({
    passed: true,
    localDatabaseOnly: true,
    target: `${identity.server_address}:${identity.server_port}/${identity.database_name}`,
    migration: FILE,
    migrationHash,
    backupPath,
    bindingCounts: { llm: before.llm.length, image: before.image.length, video: before.video.length },
    repairedImages: repairedImages.rows,
    providerCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
