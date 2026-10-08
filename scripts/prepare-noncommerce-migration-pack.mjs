#!/usr/bin/env node
// Builds a local, exact-file migration root. It never loads environment files,
// opens a database connection, calls the network, or executes SQL.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "plan";
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const forbiddenCommerceContent = /\bcommerce\b|commerce_|shopping_|affiliate_|带货/iu;

const definitions = [
  {
    name: "20260915231500_image_generation_failure_history.sql",
    expectedSha256: "ff67c72114d4d22c913d38eea5155a53639501d796184a4f2bb2e200aadb9c72",
    objects: [
      "public.image_generation_requests.request_snapshot",
      "public.image_generation_requests.failure_hidden_at",
      "public.claim_image_generation_request_v2(text,text,text,text,text,text,jsonb)",
    ],
  },
  {
    name: "20260915233000_digital_human_long_history_visibility.sql",
    expectedSha256: "8bab1262b2b686e36f1f2b3794af6481623a44ee744769d055a37d2a131ad72c",
    objects: [
      "public.digital_human_long_jobs.history_hidden_at",
      "public.hide_digital_human_long_history_item(text,text)",
    ],
  },
  {
    name: "20260915233500_extraction_request_snapshot.sql",
    expectedSha256: "f01979f2d442c92fb949215036c57b691b36b9cd0d1ac7e52096fe087e685848",
    objects: [
      "public.extraction_attempts.request_snapshot",
      "public.checkpoint_extraction_request_atomic(text,text,text,jsonb)",
    ],
  },
  {
    name: "20260915234500_short_drama_script_history.sql",
    expectedSha256: "170eca23fb773f17d5b6e3df69002380c9956ad2f6856c4bf95349c1ecf82360",
    objects: [
      "public.short_drama_script_requests",
      "public.claim_short_drama_script_request_atomic(text,text,text,jsonb,text,text,text)",
      "public.finalize_short_drama_script_request_atomic(text,text,text,text,jsonb,text,jsonb,text,integer,text,text)",
    ],
  },
  {
    name: "20261009033000_runtime_function_contract_reconcile.sql",
    expectedSha256: "9a7aba4628eb0930b5d94e5542169d0ba13da78d2406ae748616bba8716c4b33",
    objects: [
      "public.autodl_h3_finalize_video(uuid,text,text,text,text,text,text,bigint,text,numeric,numeric,bigint)",
    ],
  },
];

assert.ok(["plan", "pack"].includes(command), "UNKNOWN_NONCOMMERCE_PACK_COMMAND");
assert.equal(definitions.length, 5);
assert.equal(definitions.flatMap((entry) => entry.objects).length, 11);

const migrations = definitions.map((definition) => {
  const source = path.join(root, "supabase", "migrations", definition.name);
  const sql = fs.readFileSync(source, "utf8");
  const digest = sha256(sql);
  assert.equal(digest, definition.expectedSha256, `NONCOMMERCE_MIGRATION_HASH_REVIEW_REQUIRED:${definition.name}`);
  assert.doesNotMatch(definition.name, forbiddenCommerceContent, `COMMERCE_FILENAME_FORBIDDEN:${definition.name}`);
  assert.doesNotMatch(sql, forbiddenCommerceContent, `COMMERCE_CONTENT_FORBIDDEN:${definition.name}`);
  assert.match(sql, /^\s*(?:--[^\n]*\n\s*)*BEGIN\s*;/iu, `MIGRATION_TRANSACTION_BEGIN_REQUIRED:${definition.name}`);
  assert.match(sql, /COMMIT\s*;\s*$/iu, `MIGRATION_TRANSACTION_COMMIT_REQUIRED:${definition.name}`);
  for (const objectName of definition.objects) {
    const marker = objectName.split(".").at(-1).replace(/\(.+$/u, "");
    assert.ok(sql.includes(marker), `MIGRATION_OBJECT_MARKER_MISSING:${definition.name}:${marker}`);
  }
  return {
    version: definition.name.slice(0, 14),
    name: definition.name,
    sha256: digest,
    bytes: Buffer.byteLength(sql),
    objects: definition.objects,
    source,
    sql,
  };
});

assert.deepEqual(
  migrations.map((entry) => entry.name),
  [...migrations].sort((left, right) => left.name.localeCompare(right.name)).map((entry) => entry.name),
  "NONCOMMERCE_MIGRATION_ORDER_INVALID",
);

const manifestCore = {
  schemaVersion: 1,
  packId: "zimeiti-noncommerce-five-migrations-v1",
  executionStatus: "NOT_EXECUTED",
  executionScope: "exact-isolated-migration-root",
  prefixClosureUsed: false,
  migrations: migrations.map((entry) => ({
    version: entry.version,
    name: entry.name,
    sha256: entry.sha256,
    bytes: entry.bytes,
    objects: entry.objects,
  })),
  expectedObjectCount: 11,
  migrationDirectoryScans: 0,
  commerceMigrationFilesRead: 0,
  sourceBusinessWritesAtPlan: 0,
  databaseConnections: 0,
  databaseWrites: 0,
  networkRequests: 0,
};
const manifestSha256 = sha256(JSON.stringify(manifestCore));

if (command === "plan") {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: "plan",
    ...manifestCore,
    manifestSha256,
    localWrites: 0,
  }, null, 2)}\n`);
  process.exit(0);
}

assert.ok(outputArgument, "NONCOMMERCE_PACK_OUTPUT_REQUIRED");
const output = path.resolve(root, outputArgument.slice("--output=".length));
const evidenceRoot = `${path.join(root, ".codex-evidence")}${path.sep}`;
assert.ok(output.startsWith(evidenceRoot), "NONCOMMERCE_PACK_OUTPUT_MUST_BE_UNDER_CODEX_EVIDENCE");
assert.ok(!fs.existsSync(output), "NONCOMMERCE_PACK_OUTPUT_ALREADY_EXISTS");

const migrationRoot = path.join(output, "migrations");
fs.mkdirSync(migrationRoot, { recursive: true });
for (const migration of migrations) {
  fs.copyFileSync(migration.source, path.join(migrationRoot, migration.name), fs.constants.COPYFILE_EXCL);
}

const preflightSql = `BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name, current_user AS management_role, version() AS server_version;
SELECT table_schema, table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN (
  'users','wallet_operations','image_generation_requests','digital_human_long_jobs',
  'extraction_attempts','extraction_history_hidden','extraction_history_preferences','short_drama_script_requests',
  'revenue_records','cash_transactions','video_models','video_tasks','autodl_h3_jobs',
  'autodl_h3_settlements','autodl_h3_instance_state'
)
ORDER BY table_name, ordinal_position;
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'claim_image_generation_request_v2','hide_digital_human_long_history_item',
  'checkpoint_extraction_request_atomic','claim_short_drama_script_request_atomic',
  'finalize_short_drama_script_request_atomic','read_extraction_account_history',
  'autodl_h3_finalize_video'
)
ORDER BY p.proname;
SELECT version, name, hash, applied_at
FROM supabase_migrations.schema_migrations
WHERE version IN ('20260915231500','20260915233000','20260915233500','20260915234500','20261009033000')
ORDER BY version;
ROLLBACK;
`;

const readme = `# Non-Commerce five-migration isolated root

Execution status: NOT_EXECUTED

This directory contains exactly the five reviewed non-Commerce forward migrations.
It contains no Commerce migration and does not use the legacy --only selector.

1. Recompute and confirm manifest and file SHA-256 values.
2. Confirm the exact target host and a recoverable pre-migration backup.
3. Run read-only-preflight.sql on the confirmed target and stop on partial objects or hash drift.
4. Plan with the existing guarded runner using this exact migration root and no --only flag:
   node scripts/db-migration-release.mjs plan --migration-root=<absolute-path-to-this-directory>/migrations
5. Apply only after explicit authorization, using the plan manifest SHA, confirmed target host and backup receipt.
6. Refresh PostgREST and run the complete production database readiness checks before enabling traffic.

The five files contain separate transaction boundaries. A failure in a later file does not undo an earlier committed file.
`;

const manifest = {
  ...manifestCore,
  manifestSha256,
  generatedAt: new Date().toISOString(),
  migrationRoot: "migrations",
  runnerMode: "existing-runner-with-isolated-migration-root-and-no-only-selector",
  requiredConfirmations: [
    "exact target host",
    "runner plan manifest SHA-256",
    "recoverable pre-migration backup receipt",
    "explicit apply authorization",
  ],
};
fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
fs.writeFileSync(path.join(output, "read-only-preflight.sql"), preflightSql, { flag: "wx" });
fs.writeFileSync(path.join(output, "README.md"), readme, { flag: "wx" });

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: "pack",
  output: path.relative(root, output).replaceAll("\\", "/"),
  migrationRoot: path.relative(root, migrationRoot).replaceAll("\\", "/"),
  migrationCount: migrations.length,
  expectedObjectCount: 11,
  manifestSha256,
  prefixClosureUsed: false,
  commerceMigrationFilesRead: 0,
  databaseConnections: 0,
  databaseWrites: 0,
  networkRequests: 0,
  localWrites: migrations.length + 3,
  executionStatus: "NOT_EXECUTED",
}, null, 2)}\n`);
