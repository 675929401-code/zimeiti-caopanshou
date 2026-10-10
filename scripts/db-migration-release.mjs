#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";
import {
  assertForwardMigrationRoot,
  parseForwardMigrationName,
} from "./lib/forward-migration-source-validator.mjs";

const { Client } = pg;

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args.shift() : "plan";
const root = path.resolve(valueOf("--root") || process.cwd());
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const policy = readJson(policyPath);
const migrationRoot = path.resolve(root, valueOf("--migration-root") || policy.database?.migrationRoot || "supabase/migrations");
const rollbackRoot = path.resolve(root, policy.database?.rollbackRoot || "supabase/rollbacks");
const evidenceRoot = path.resolve(root, valueOf("--evidence-root") || ".codex-evidence/db-migration-release");
const databaseUrlEnvNames = (valueOf("--database-url-env") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const defaultDatabaseUrlEnvNames = policy.database?.migrationDatabaseUrlEnv?.length
  ? policy.database.migrationDatabaseUrlEnv
  : ["DEPLOY_DATABASE_URL", "SUPABASE_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"];
const databaseEnvCandidates = databaseUrlEnvNames.length ? databaseUrlEnvNames : defaultDatabaseUrlEnvNames;
const selectedOnly = (valueOf("--only") || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const confirmedTargetHost = String(valueOf("--confirm-target-host") || "").trim().toLowerCase();
const confirmedManifestSha256 = String(valueOf("--confirm-manifest-sha256") || "").trim().toLowerCase();
const confirmedBackup = String(valueOf("--confirm-backup") || "").trim();
const semanticReceiptPath = String(valueOf("--semantic-receipt") || "").trim();
const confirmedSemanticReceiptSha256 = String(valueOf("--confirm-semantic-receipt-sha256") || "").trim().toLowerCase();
const confirmedTargetFingerprint = String(valueOf("--confirm-target-fingerprint") || "").trim().toLowerCase();
const actor = String(valueOf("--actor") || process.env.USERNAME || process.env.USER || "codex-release").trim().slice(0, 120);
const writeEvidence = hasFlag("--write-evidence") || command === "apply" || command === "adopt";
const includeApplied = hasFlag("--include-applied");
const excludedForwardMigrations = new Set(
  Array.isArray(policy.database?.excludedForwardMigrations)
    ? policy.database.excludedForwardMigrations.map((item) => String(item || "").trim()).filter(Boolean)
    : [],
);

function validateForwardMigrationSource() {
  return assertForwardMigrationRoot({
    projectRoot: root,
    migrationRoot,
    rollbackRoot,
    legacyRollbackRelocations: policy.database?.legacyRollbackRelocations || [],
    // Production release commands run only from a committed checkout. A
    // missing/unborn Git repository or any HEAD/index/worktree drift must
    // fail closed before environment loading or database access.
    gitIndexMode: "required",
  });
}

validateForwardMigrationSource();

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const FORBIDDEN_FORWARD_PATTERNS = [
  { code: "DROP_DATABASE_FORBIDDEN", expression: /^\s*DROP\s+DATABASE\b/imu },
  { code: "DROP_SCHEMA_FORBIDDEN", expression: /^\s*DROP\s+SCHEMA\b/imu },
  { code: "DROP_TABLE_FORBIDDEN", expression: /^\s*DROP\s+TABLE\b/imu },
  { code: "TRUNCATE_FORBIDDEN", expression: /^\s*TRUNCATE\b/imu },
];
const ADVISORY_LOCK_ID = "260830500011";
const SEMANTIC_CHECK_VERSION = "catalog-and-transaction-noop.v2";
let onlySelectionReport = {
  requested: [],
  directlyMatched: [],
  dependencyClosureAdded: [],
};
let applyProgress = null;

function hasFlag(name) {
  return args.includes(name);
}

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function relativeSlash(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function migrationTransactionMode(sql) {
  const statements = sql
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("--"));
  const first = statements[0] || "";
  const last = statements[statements.length - 1] || "";
  const startsWithBegin = /^begin\s*;/iu.test(first);
  const endsWithCommit = /^commit\s*;/iu.test(last);
  if (startsWithBegin && endsWithCommit) return "self-contained";
  if (!startsWithBegin && !endsWithCommit) return "wrapped-by-runner";
  return "invalid-boundary";
}

function inspectMigration(filePath) {
  const sql = fs.readFileSync(filePath, "utf8");
  const name = path.basename(filePath);
  const parsedName = parseForwardMigrationName(name);
  if (!parsedName) {
    return {
      file: relativeSlash(filePath),
      name,
      valid: false,
      version: null,
      slug: null,
      bytes: Buffer.byteLength(sql, "utf8"),
      sha256: sha256(sql),
      errors: ["NON_CANONICAL_MIGRATION_FILE"],
      warnings: [],
      transactionMode: "invalid-boundary",
    };
  }
  const errors = [];
  const warnings = [];
  for (const pattern of FORBIDDEN_FORWARD_PATTERNS) {
    if (pattern.expression.test(sql)) errors.push(pattern.code);
  }
  if (/\bDELETE\s+FROM\b/iu.test(sql)) {
    warnings.push("DELETE_FROM_PRESENT_REVIEWED_AS_RUNTIME_RPC_BODY_OR_TARGETED_DATA_CHANGE");
  }
  const transactionMode = migrationTransactionMode(sql);
  if (transactionMode === "invalid-boundary") {
    errors.push("MIXED_TRANSACTION_BOUNDARY");
  }
  return {
    file: relativeSlash(filePath),
    name,
    valid: errors.length === 0,
    version: parsedName.version,
    slug: parsedName.slug,
    bytes: Buffer.byteLength(sql, "utf8"),
    sha256: sha256(sql),
    errors,
    warnings,
    transactionMode,
  };
}

function listMigrations() {
  const entries = validateForwardMigrationSource().entries
    .filter((entry) => !excludedForwardMigrations.has(entry.relativePath))
    .map((entry) => inspectMigration(path.join(migrationRoot, entry.relativePath)))
    .sort((left, right) => left.name.localeCompare(right.name));
  const versions = new Map();
  for (const entry of entries) {
    if (!entry.version) continue;
    versions.set(entry.version, [...(versions.get(entry.version) || []), entry.name]);
  }
  for (const [version, names] of versions) {
    if (names.length <= 1) continue;
    for (const entry of entries) {
      if (entry.version === version) {
        entry.valid = false;
        entry.errors.push(`DUPLICATE_MIGRATION_VERSION:${names.join("+")}`);
      }
    }
  }
  if (selectedOnly.length === 0) return entries;

  // SQL migrations do not carry a machine-readable dependency graph. The
  // only safe generic interpretation of --only is therefore an ordered prefix
  // through the newest selected migration. Selecting an isolated tail file
  // would silently skip schema prerequisites.
  const matchedIndexes = new Set();
  const directlyMatched = new Set();
  const unknownSelectors = [];
  for (const selector of selectedOnly) {
    const indexes = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => selector === entry.name || selector === entry.version || selector === entry.slug)
      .map(({ entry, index }) => {
        directlyMatched.add(entry.name);
        return index;
      });
    if (indexes.length === 0) unknownSelectors.push(selector);
    indexes.forEach((index) => matchedIndexes.add(index));
  }
  if (unknownSelectors.length > 0) {
    throw new Error(`ONLY_SELECTOR_NOT_FOUND:${unknownSelectors.join(",")}`);
  }
  if (matchedIndexes.size === 0) throw new Error("ONLY_SELECTION_EMPTY");
  const closureEnd = Math.max(...matchedIndexes);
  const selectedEntries = entries.slice(0, closureEnd + 1);
  onlySelectionReport = {
    requested: [...selectedOnly],
    directlyMatched: [...directlyMatched].sort(),
    dependencyClosureAdded: selectedEntries
      .map((entry) => entry.name)
      .filter((name) => !directlyMatched.has(name)),
  };
  return selectedEntries;
}

function databaseConfig() {
  for (const envName of databaseEnvCandidates) {
    const value = String(process.env[envName] || "").trim();
    if (!value) continue;
    const host = databaseHost(value);
    return { envName, value, host, configured: true };
  }
  return { envName: null, value: null, host: null, configured: false };
}

function databaseHost(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pgClient(config) {
  const local = config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1";
  return new Client({
    connectionString: config.value,
    ssl: local ? false : { rejectUnauthorized: false },
    statement_timeout: 120_000,
    connectionTimeoutMillis: 15_000,
  });
}

function migrationManifest(migrations) {
  const core = {
    schemaVersion: 1,
    projectId: policy.projectId || "zimeiti-caopanshou",
    migrationRoot: relativeSlash(migrationRoot),
    excludedForwardMigrations: [...excludedForwardMigrations].sort(),
    migrationCount: migrations.length,
    totalBytes: migrations.reduce((sum, item) => sum + item.bytes, 0),
    migrations: migrations.map((item) => ({
      version: item.version,
      name: item.name,
      sha256: item.sha256,
      transactionMode: item.transactionMode,
    })),
  };
  return { ...core, manifestSha256: sha256(stableJson(core)) };
}

async function readAppliedVersions(client) {
  const exists = await client.query(
    `select to_regclass('supabase_migrations.schema_migrations') as table_name`,
  );
  if (!exists.rows[0]?.table_name) return new Map();
  const result = await client.query(
    `select version::text as version,
            coalesce(name::text, '') as name,
            coalesce(hash::text, '') as hash,
            applied_at
       from supabase_migrations.schema_migrations
      order by version asc`,
  ).catch(async () => {
    const fallback = await client.query(
      `select version::text as version,
              '' as name,
              '' as hash,
              null::timestamptz as applied_at
         from supabase_migrations.schema_migrations
        order by version asc`,
    );
    return fallback;
  });
  return new Map(result.rows.map((row) => [String(row.version), row]));
}

async function ensureMigrationLedger(client) {
  await client.query(`create schema if not exists supabase_migrations`);
  await client.query(`
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      name text,
      statements text[],
      hash text,
      applied_by text,
      applied_at timestamptz not null default now()
    )
  `);
  await client.query(`alter table supabase_migrations.schema_migrations add column if not exists name text`);
  await client.query(`alter table supabase_migrations.schema_migrations add column if not exists statements text[]`);
  await client.query(`alter table supabase_migrations.schema_migrations add column if not exists hash text`);
  await client.query(`alter table supabase_migrations.schema_migrations add column if not exists applied_by text`);
  await client.query(`alter table supabase_migrations.schema_migrations add column if not exists applied_at timestamptz not null default now()`);
}

function appliedMigrationHashDrifts(migrations, appliedRows) {
  return migrations.flatMap((migration) => {
    const applied = appliedRows.get(migration.version);
    if (!applied) return [];
    const recordedHash = String(applied.hash || "").trim().toLowerCase();
    if (recordedHash === migration.sha256) return [];
    return [{
      version: migration.version,
      name: migration.name,
      recordedHash: recordedHash || null,
      currentHash: migration.sha256,
      reason: recordedHash ? "hash-mismatch" : "ledger-hash-missing",
    }];
  });
}

function applySql(sql, migration) {
  if (migration.transactionMode === "self-contained") return sql;
  return `begin;\n${sql.trim()}\ncommit;\n`;
}

function semanticProbeSql(sql, migration) {
  if (migration.transactionMode !== "self-contained") return sql;
  const lines = sql.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const meaningful = lines
    .map((line, index) => ({ index, text: line.trim() }))
    .filter((item) => item.text && !item.text.startsWith("--"));
  const first = meaningful[0];
  const last = meaningful.at(-1);
  if (!first || !/^begin\s*;$/iu.test(first.text) || !last || !/^commit\s*;$/iu.test(last.text)) {
    throw new Error(`SEMANTIC_PROBE_TRANSACTION_BOUNDARY_INVALID:${migration.name}`);
  }
  lines[first.index] = lines[first.index].replace(/begin\s*;/iu, "");
  lines[last.index] = lines[last.index].replace(/commit\s*;/iu, "");
  return lines.join("\n");
}

const CATALOG_SECTIONS = [
  {
    name: "relations-and-permissions",
    sql: `select n.nspname as schema_name, c.relname as object_name, c.relkind,
                 c.relpersistence, c.relrowsecurity, c.relforcerowsecurity,
                 c.relreplident, pg_catalog.pg_get_userbyid(c.relowner) as owner_name,
                 coalesce(c.relacl::text, '') as acl
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
           order by c.relname, c.relkind`,
  },
  {
    name: "columns-defaults-and-permissions",
    sql: `select n.nspname as schema_name, c.relname as relation_name, a.attnum,
                 a.attname as column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
                 a.attnotnull, a.attidentity, a.attgenerated,
                 coalesce(coll.collname, '') as collation_name,
                 coalesce(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid, true), '') as default_expression,
                 coalesce(a.attacl::text, '') as acl
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
       left join pg_collation coll on coll.oid = a.attcollation
           where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
           order by c.relname, a.attnum`,
  },
  {
    name: "constraints",
    sql: `select n.nspname as schema_name, c.relname as relation_name, con.conname,
                 con.contype, con.condeferrable, con.condeferred, con.convalidated,
                 pg_catalog.pg_get_constraintdef(con.oid, true) as definition
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public'
           order by c.relname, con.conname`,
  },
  {
    name: "indexes",
    sql: `select schemaname as schema_name, tablename as relation_name,
                 indexname, indexdef
            from pg_indexes
           where schemaname = 'public'
           order by tablename, indexname`,
  },
  {
    name: "functions-and-permissions",
    sql: `select n.nspname as schema_name, p.proname as function_name,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
                 pg_catalog.pg_get_function_result(p.oid) as result_type,
                 l.lanname as language_name, p.prokind, p.provolatile,
                 p.proparallel, p.prosecdef, p.proleakproof, p.proisstrict,
                 coalesce(p.proconfig::text, '') as configuration,
                 coalesce(p.proacl::text, '') as acl,
                 p.prosrc as source
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_language l on l.oid = p.prolang
           where n.nspname = 'public'
           order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`,
  },
  {
    name: "row-security-policies",
    sql: `select schemaname as schema_name, tablename as relation_name,
                 policyname, permissive, roles::text, cmd,
                 coalesce(qual, '') as using_expression,
                 coalesce(with_check, '') as check_expression
            from pg_policies
           where schemaname = 'public'
           order by tablename, policyname`,
  },
  {
    name: "triggers",
    sql: `select n.nspname as schema_name, c.relname as relation_name,
                 t.tgname as trigger_name, t.tgenabled,
                 pg_catalog.pg_get_triggerdef(t.oid, true) as definition
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
           order by c.relname, t.tgname`,
  },
  {
    name: "types-and-permissions",
    sql: `select n.nspname as schema_name, t.typname as type_name,
                 t.typtype, t.typcategory, t.typnotnull,
                 coalesce(t.typdefault, '') as default_value,
                 pg_catalog.pg_get_userbyid(t.typowner) as owner_name,
                 coalesce(t.typacl::text, '') as acl
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public'
           order by t.typname`,
  },
  {
    name: "enum-values",
    sql: `select n.nspname as schema_name, t.typname as type_name,
                 e.enumsortorder::text, e.enumlabel
            from pg_enum e
            join pg_type t on t.oid = e.enumtypid
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public'
           order by t.typname, e.enumsortorder`,
  },
  {
    name: "views",
    sql: `select schemaname as schema_name, viewname as view_name, definition
            from pg_views
           where schemaname = 'public'
           order by viewname`,
  },
  {
    name: "materialized-views",
    sql: `select schemaname as schema_name, matviewname as view_name,
                 hasindexes, ispopulated, definition
            from pg_matviews
           where schemaname = 'public'
           order by matviewname`,
  },
  {
    name: "sequences",
    sql: `select schemaname as schema_name, sequencename as sequence_name,
                 data_type, start_value::text, min_value::text, max_value::text,
                 increment_by::text, cycle, cache_size::text
            from pg_sequences
           where schemaname = 'public'
           order by sequencename`,
  },
  {
    name: "extensions",
    sql: `select e.extname, e.extversion, n.nspname as schema_name,
                 e.extrelocatable
            from pg_extension e
            join pg_namespace n on n.oid = e.extnamespace
           order by e.extname`,
  },
  {
    name: "schema-and-default-permissions",
    sql: `select 'schema'::text as permission_kind, n.nspname::text as object_name,
                 coalesce(n.nspacl::text, ''::text) as acl
            from pg_namespace n
           where n.nspname = 'public'
           union all
          select 'default:'::text || d.defaclobjtype::text, r.rolname::text,
                 coalesce(d.defaclacl::text, ''::text)
            from pg_default_acl d
            join pg_roles r on r.oid = d.defaclrole
            join pg_namespace n on n.oid = d.defaclnamespace
           where n.nspname = 'public'
           order by 1, 2`,
  },
];

const CATALOG_IDENTITY_FIELDS = {
  "relations-and-permissions": ["schema_name", "object_name", "relkind"],
  "columns-defaults-and-permissions": ["schema_name", "relation_name", "attnum", "column_name"],
  constraints: ["schema_name", "relation_name", "conname"],
  indexes: ["schema_name", "relation_name", "indexname"],
  "functions-and-permissions": ["schema_name", "function_name", "identity_arguments"],
  "row-security-policies": ["schema_name", "relation_name", "policyname"],
  triggers: ["schema_name", "relation_name", "trigger_name"],
  "types-and-permissions": ["schema_name", "type_name"],
  "enum-values": ["schema_name", "type_name", "enumsortorder", "enumlabel"],
  views: ["schema_name", "view_name"],
  "materialized-views": ["schema_name", "view_name"],
  sequences: ["schema_name", "sequence_name"],
  extensions: ["extname"],
  "schema-and-default-permissions": ["permission_kind", "object_name"],
};

function catalogObjectIdentity(sectionName, row) {
  const fields = CATALOG_IDENTITY_FIELDS[sectionName];
  if (!fields) throw new Error(`SEMANTIC_CATALOG_IDENTITY_MISSING:${sectionName}`);
  return fields.map((field) => String(row[field] ?? "")).join("|");
}

async function databaseSemanticSnapshot(client) {
  const sections = {};
  for (const section of CATALOG_SECTIONS) {
    let result;
    try {
      result = await client.query(section.sql);
    } catch (error) {
      error.semanticSection = section.name;
      throw error;
    }
    sections[section.name] = {
      rows: result.rows.length,
      sha256: sha256(stableJson(result.rows)),
      objects: result.rows.map((row) => ({
        key: catalogObjectIdentity(section.name, row),
        sha256: sha256(stableJson(row)),
      })),
    };
  }
  return {
    version: SEMANTIC_CHECK_VERSION,
    sections,
    sha256: sha256(stableJson(sections)),
  };
}

async function transactionDmlActivity(client) {
  const result = await client.query(`
    select schemaname as schema_name, relname as relation_name,
           n_tup_ins::bigint::text as inserted,
           n_tup_upd::bigint::text as updated,
           n_tup_del::bigint::text as deleted
      from pg_stat_xact_user_tables
     where schemaname = 'public'
     order by relname
  `);
  return new Map(result.rows.map((row) => [row.relation_name, row]));
}

function changedDmlActivity(before, after) {
  const changes = [];
  for (const relation of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(relation) || { inserted: "0", updated: "0", deleted: "0" };
    const right = after.get(relation) || { inserted: "0", updated: "0", deleted: "0" };
    const inserted = BigInt(right.inserted || 0) - BigInt(left.inserted || 0);
    const updated = BigInt(right.updated || 0) - BigInt(left.updated || 0);
    const deleted = BigInt(right.deleted || 0) - BigInt(left.deleted || 0);
    if (inserted !== 0n || updated !== 0n || deleted !== 0n) {
      changes.push({ relation, inserted: inserted.toString(), updated: updated.toString(), deleted: deleted.toString() });
    }
  }
  return changes.sort((left, right) => left.relation.localeCompare(right.relation));
}

function changedCatalogSections(before, after) {
  return CATALOG_SECTIONS
    .map((section) => section.name)
    .filter((name) => before.sections[name]?.sha256 !== after.sections[name]?.sha256);
}

function changedCatalogObjects(before, after) {
  const changes = [];
  for (const sectionName of Object.keys(before.sections)) {
    const beforeObjects = new Map((before.sections[sectionName]?.objects || []).map((item) => [item.key, item.sha256]));
    const afterObjects = new Map((after.sections[sectionName]?.objects || []).map((item) => [item.key, item.sha256]));
    const keys = [...new Set([...beforeObjects.keys(), ...afterObjects.keys()])].sort();
    for (const key of keys) {
      const beforeSha256 = beforeObjects.get(key) || null;
      const afterSha256 = afterObjects.get(key) || null;
      if (beforeSha256 === afterSha256) continue;
      changes.push({
        section: sectionName,
        object: key,
        change: beforeSha256 === null ? "added" : afterSha256 === null ? "removed" : "changed",
        beforeSha256,
        afterSha256,
      });
    }
  }
  return changes;
}

function safeDatabaseErrorCode(error) {
  const code = String(error?.code || "PROBE_EXECUTION_FAILED").trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(code) ? code : "PROBE_EXECUTION_FAILED";
}

function safeDatabaseErrorObject(error) {
  const message = String(error?.message || "");
  const match = message.match(/\b(relation|function|type|constraint|policy|trigger|index)\s+"([A-Za-z0-9_.:-]{1,120})"/iu);
  if (match) return `${match[1].toLowerCase()}:${match[2]}`;
  const fields = ["schema", "table", "column", "constraint", "datatype"];
  for (const field of fields) {
    const value = String(error?.[field] || "").trim();
    if (/^[A-Za-z0-9_.:-]{1,120}$/u.test(value)) return `${field}:${value}`;
  }
  return null;
}

async function probeMigrationSemanticNoop(client, migration) {
  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '120s'");
    const before = await databaseSemanticSnapshot(client);
    const dmlBefore = await transactionDmlActivity(client);
    const sql = fs.readFileSync(path.join(root, migration.file), "utf8");
    await client.query(semanticProbeSql(sql, migration));
    const after = await databaseSemanticSnapshot(client);
    const dmlAfter = await transactionDmlActivity(client);
    const changedSections = changedCatalogSections(before, after);
    const changedObjects = changedCatalogObjects(before, after);
    const dmlChanges = changedDmlActivity(dmlBefore, dmlAfter);
    await client.query("rollback");
    transactionOpen = false;
    return {
      version: migration.version,
      name: migration.name,
      sha256: migration.sha256,
      eligible: changedObjects.length === 0 && dmlChanges.length === 0,
      beforeCatalogSha256: before.sha256,
      afterCatalogSha256: after.sha256,
      checkedCatalogSections: CATALOG_SECTIONS.map((section) => section.name),
      changedCatalogSections: changedSections,
      changedCatalogObjects: changedObjects,
      dmlChanges,
      errorCode: null,
      errorObject: null,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch {
        // The sanitized probe result remains the authoritative failure.
      }
    }
    return {
      version: migration.version,
      name: migration.name,
      sha256: migration.sha256,
      eligible: false,
      beforeCatalogSha256: null,
      afterCatalogSha256: null,
      checkedCatalogSections: CATALOG_SECTIONS.map((section) => section.name),
      changedCatalogSections: [],
      changedCatalogObjects: [],
      dmlChanges: [],
      errorCode: safeDatabaseErrorCode(error),
      errorObject: safeDatabaseErrorObject(error),
      errorSection: typeof error?.semanticSection === "string" ? error.semanticSection : null,
    };
  }
}

async function databaseTargetIdentity(client, config) {
  const result = await client.query(`
    select current_database() as database_name,
           current_setting('server_version_num') as server_version,
           coalesce(inet_server_addr()::text, 'local') as server_address,
           coalesce(inet_server_port()::text, 'local') as server_port
  `);
  const row = result.rows[0] || {};
  const fingerprint = sha256(stableJson({
    configuredHost: config.host,
    databaseName: row.database_name,
    serverVersion: row.server_version,
    serverAddress: row.server_address,
    serverPort: row.server_port,
  }));
  return { fingerprint, serverVersion: row.server_version || null };
}

async function pendingMigrationsFor(client, migrations) {
  const appliedRows = await readAppliedVersions(client);
  const hashDrifts = appliedMigrationHashDrifts(migrations, appliedRows);
  if (hashDrifts.length > 0) {
    throw new Error(`APPLIED_MIGRATION_HASH_DRIFT:${hashDrifts.map((item) => item.version).join(",")}`);
  }
  return migrations.filter((migration) => !appliedRows.has(migration.version));
}

async function plan() {
  const migrations = listMigrations();
  const config = databaseConfig();
  const manifest = migrationManifest(migrations);
  const invalid = migrations.filter((migration) => !migration.valid);
  let database = {
    configured: config.configured,
    envName: config.envName,
    targetHost: config.host,
    ledgerReachable: null,
    appliedCount: null,
    pendingCount: null,
  };
  let applied = [];
  let pending = migrations;
  let hashDrifts = [];
  if (config.configured && command === "status") {
    const client = pgClient(config);
    await client.connect();
    try {
      const appliedRows = await readAppliedVersions(client);
      hashDrifts = appliedMigrationHashDrifts(migrations, appliedRows);
      applied = migrations.filter((migration) => appliedRows.has(migration.version));
      pending = migrations.filter((migration) => !appliedRows.has(migration.version));
      database = {
        ...database,
        ledgerReachable: true,
        appliedCount: applied.length,
        pendingCount: pending.length,
      };
    } finally {
      await client.end();
    }
  }
  const result = {
    ok: invalid.length === 0 && hashDrifts.length === 0,
    mode: command,
    projectId: manifest.projectId,
    migrationRoot: manifest.migrationRoot,
    excludedForwardMigrations: manifest.excludedForwardMigrations,
    manifestSha256: manifest.manifestSha256,
    migrationCount: manifest.migrationCount,
    totalBytes: manifest.totalBytes,
    database,
    invalid: invalid.map((item) => ({ name: item.name, errors: item.errors })),
    hashDrifts,
    onlySelection: selectedOnly.length > 0 ? onlySelectionReport : null,
    warnings: migrations.flatMap((item) => item.warnings.map((warning) => ({ name: item.name, warning }))),
    migrations: migrations.map((item) => ({
      version: item.version,
      name: item.name,
      sha256: item.sha256,
      transactionMode: item.transactionMode,
      valid: item.valid,
      ...(includeApplied ? { applied: applied.some((entry) => entry.version === item.version) } : {}),
    })),
    applyRequires: [
      "pre-migration database backup receipt",
      `--confirm-target-host=${config.host || "<database-host>"}`,
      `--confirm-manifest-sha256=${manifest.manifestSha256}`,
      "--confirm-backup=<backup-receipt-or-path>",
    ],
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  writeResult(result);
  if (!result.ok) process.exitCode = 1;
}

function semanticReceiptDigest(receipt) {
  const core = { ...receipt };
  delete core.receiptSha256;
  return sha256(stableJson(core));
}

async function semanticCheck() {
  const migrations = listMigrations();
  const invalid = migrations.filter((migration) => !migration.valid);
  if (invalid.length > 0) {
    throw new Error(`MIGRATION_PLAN_INVALID:${invalid.map((item) => item.name).join(",")}`);
  }
  const config = databaseConfig();
  if (!config.configured || !config.host) throw new Error("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
  const manifest = migrationManifest(migrations);
  const client = pgClient(config);
  let locked = false;
  let target;
  let pending = [];
  const results = [];
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    locked = true;
    target = await databaseTargetIdentity(client, config);
    pending = await pendingMigrationsFor(client, migrations);
    for (const migration of pending) {
      results.push(await probeMigrationSemanticNoop(client, migration));
    }
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
      } catch {
        // The semantic results remain valid; the session closes immediately.
      }
    }
    await client.end();
  }
  const eligible = results.filter((result) => result.eligible);
  const blocked = results.filter((result) => !result.eligible);
  const core = {
    schemaVersion: 1,
    kind: "migration-semantic-noop-receipt",
    semanticCheckVersion: SEMANTIC_CHECK_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: manifest.projectId,
    mode: "semantic-check",
    manifestSha256: manifest.manifestSha256,
    targetHost: config.host,
    targetFingerprint: target.fingerprint,
    serverVersion: target.serverVersion,
    migrationCount: migrations.length,
    appliedCount: migrations.length - pending.length,
    pendingCount: pending.length,
    eligibleCount: eligible.length,
    blockedCount: blocked.length,
    results,
    adoptionRule: "Only an exact catalog fingerprint match with zero transactional DML changes may be adopted.",
    committedMigrationSql: 0,
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  const result = { ...core, receiptSha256: semanticReceiptDigest(core) };
  writeResult(result);
  if (blocked.length > 0) process.exitCode = 1;
}

async function adoptSemanticNoops() {
  if (!semanticReceiptPath) throw new Error("SEMANTIC_RECEIPT_REQUIRED");
  const resolvedReceiptPath = path.resolve(root, semanticReceiptPath);
  if (!fs.existsSync(resolvedReceiptPath) || !fs.statSync(resolvedReceiptPath).isFile()) {
    throw new Error("SEMANTIC_RECEIPT_NOT_FOUND");
  }
  const receipt = readJson(resolvedReceiptPath);
  const calculatedReceiptSha256 = semanticReceiptDigest(receipt);
  if (receipt.receiptSha256 !== calculatedReceiptSha256) throw new Error("SEMANTIC_RECEIPT_INTEGRITY_FAILED");
  if (confirmedSemanticReceiptSha256 !== calculatedReceiptSha256) throw new Error("SEMANTIC_RECEIPT_CONFIRMATION_REQUIRED");
  if (receipt.kind !== "migration-semantic-noop-receipt" || receipt.semanticCheckVersion !== SEMANTIC_CHECK_VERSION) {
    throw new Error("SEMANTIC_RECEIPT_VERSION_UNSUPPORTED");
  }
  if (receipt.databaseWrites !== 0 || receipt.committedMigrationSql !== 0 || !Array.isArray(receipt.results)) {
    throw new Error("SEMANTIC_RECEIPT_UNSAFE");
  }

  const migrations = listMigrations();
  const invalid = migrations.filter((migration) => !migration.valid);
  if (invalid.length > 0) throw new Error(`MIGRATION_PLAN_INVALID:${invalid.map((item) => item.name).join(",")}`);
  const manifest = migrationManifest(migrations);
  if (receipt.manifestSha256 !== manifest.manifestSha256 || confirmedManifestSha256 !== manifest.manifestSha256) {
    throw new Error("MANIFEST_SHA256_CONFIRMATION_REQUIRED");
  }
  const config = databaseConfig();
  if (!config.configured || !config.host) throw new Error("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
  if (confirmedTargetHost !== config.host) throw new Error("TARGET_HOST_CONFIRMATION_REQUIRED");
  if (policy.database?.preMigrationBackupRequired !== false && confirmedBackup.length < 8) {
    throw new Error("PRE_MIGRATION_BACKUP_CONFIRMATION_REQUIRED");
  }

  const receiptByVersion = new Map(receipt.results.map((result) => [String(result.version), result]));
  for (const migration of migrations) {
    const recorded = receiptByVersion.get(migration.version);
    if (recorded && (recorded.name !== migration.name || recorded.sha256 !== migration.sha256)) {
      throw new Error(`SEMANTIC_RECEIPT_MIGRATION_CHANGED:${migration.version}`);
    }
  }

  const client = pgClient(config);
  let locked = false;
  let transactionOpen = false;
  const adopted = [];
  let pending = [];
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    locked = true;
    const target = await databaseTargetIdentity(client, config);
    if (receipt.targetFingerprint !== target.fingerprint || confirmedTargetFingerprint !== target.fingerprint) {
      throw new Error("TARGET_FINGERPRINT_CONFIRMATION_REQUIRED");
    }
    pending = await pendingMigrationsFor(client, migrations);
    const missingReceipt = pending.filter((migration) => !receiptByVersion.has(migration.version));
    if (missingReceipt.length > 0) {
      throw new Error(`SEMANTIC_RECEIPT_PENDING_SET_INCOMPLETE:${missingReceipt.map((item) => item.version).join(",")}`);
    }
    const candidates = pending.filter((migration) => receiptByVersion.get(migration.version)?.eligible === true);
    if (candidates.length === 0) throw new Error("NO_SEMANTIC_NOOP_MIGRATIONS_TO_ADOPT");
    for (const migration of candidates) {
      const recheck = await probeMigrationSemanticNoop(client, migration);
      if (!recheck.eligible
        || recheck.beforeCatalogSha256 !== receiptByVersion.get(migration.version).beforeCatalogSha256
        || recheck.afterCatalogSha256 !== receiptByVersion.get(migration.version).afterCatalogSha256) {
        throw new Error(`SEMANTIC_RECHECK_FAILED:${migration.version}`);
      }
    }

    await client.query("begin");
    transactionOpen = true;
    await ensureMigrationLedger(client);
    for (const migration of candidates) {
      const inserted = await client.query(
        `insert into supabase_migrations.schema_migrations
           (version, name, statements, hash, applied_by, applied_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (version) do nothing`,
        [migration.version, migration.slug, [migration.name], migration.sha256, `${actor}:semantic-noop-adopt`],
      );
      if (inserted.rowCount !== 1) throw new Error(`SEMANTIC_ADOPT_LEDGER_CONFLICT:${migration.version}`);
      adopted.push({ version: migration.version, name: migration.name, sha256: migration.sha256 });
    }
    await client.query("commit");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the original fail-closed adoption error.
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
      } catch {
        // The session closes immediately after this block.
      }
    }
    await client.end();
  }

  const result = {
    ok: true,
    mode: "adopt",
    projectId: manifest.projectId,
    manifestSha256: manifest.manifestSha256,
    semanticReceiptSha256: calculatedReceiptSha256,
    targetFingerprint: receipt.targetFingerprint,
    adoptedCount: adopted.length,
    remainingPendingCount: pending.length - adopted.length,
    adopted,
    backupReceipt: confirmedBackup,
    committedMigrationSql: 0,
    databaseWrites: adopted.length,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  writeResult(result);
}

async function apply() {
  const migrations = listMigrations();
  const invalid = migrations.filter((migration) => !migration.valid);
  if (invalid.length > 0) {
    throw new Error(`MIGRATION_PLAN_INVALID:${invalid.map((item) => item.name).join(",")}`);
  }
  const config = databaseConfig();
  if (!config.configured || !config.host) throw new Error("DEPLOY_DATABASE_URL_NOT_CONFIGURED");
  const manifest = migrationManifest(migrations);
  if (confirmedTargetHost !== config.host) throw new Error("TARGET_HOST_CONFIRMATION_REQUIRED");
  if (confirmedManifestSha256 !== manifest.manifestSha256) throw new Error("MANIFEST_SHA256_CONFIRMATION_REQUIRED");
  if (policy.database?.preMigrationBackupRequired !== false && confirmedBackup.length < 8) {
    throw new Error("PRE_MIGRATION_BACKUP_CONFIRMATION_REQUIRED");
  }

  const client = pgClient(config);
  const startedAt = new Date().toISOString();
  const applied = [];
  const skipped = [];
  applyProgress = {
    startedAt,
    targetHost: config.host,
    manifestSha256: manifest.manifestSha256,
    currentStage: "connect",
    currentMigration: null,
    committedMigrations: [],
    ledgerRecordedMigrations: [],
    committedButUnrecorded: null,
  };
  await client.connect();
  try {
    applyProgress.currentStage = "advisory-lock";
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    applyProgress.currentStage = "migration-ledger-readiness";
    await ensureMigrationLedger(client);
    const appliedRows = await readAppliedVersions(client);
    const hashDrifts = appliedMigrationHashDrifts(migrations, appliedRows);
    if (hashDrifts.length > 0) {
      throw new Error(`APPLIED_MIGRATION_HASH_DRIFT:${hashDrifts.map((item) => item.version).join(",")}`);
    }
    for (const migration of migrations) {
      const already = appliedRows.get(migration.version);
      if (already && !hasFlag("--replay-applied")) {
        skipped.push({
          version: migration.version,
          name: migration.name,
          reason: "already-applied-hash-verified",
          recordedHash: already.hash || null,
        });
        continue;
      }
      const sql = fs.readFileSync(path.join(root, migration.file), "utf8");
      applyProgress.currentMigration = { version: migration.version, name: migration.name, sha256: migration.sha256 };
      applyProgress.currentStage = "migration-sql";
      await client.query(applySql(sql, migration));
      applyProgress.committedMigrations.push(applyProgress.currentMigration);
      applyProgress.committedButUnrecorded = applyProgress.currentMigration;
      applyProgress.currentStage = "migration-ledger-write";
      await client.query(
        `insert into supabase_migrations.schema_migrations
           (version, name, statements, hash, applied_by, applied_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (version) do update
           set name = excluded.name,
               statements = excluded.statements,
               hash = excluded.hash,
               applied_by = excluded.applied_by,
               applied_at = excluded.applied_at`,
        [migration.version, migration.slug, [migration.name], migration.sha256, actor],
      );
      applied.push({ version: migration.version, name: migration.name, sha256: migration.sha256 });
      applyProgress.ledgerRecordedMigrations.push(applyProgress.currentMigration);
      applyProgress.committedButUnrecorded = null;
      applyProgress.currentMigration = null;
    }
    applyProgress.currentStage = "postgrest-schema-reload";
    await client.query("notify pgrst, 'reload schema'");
    applyProgress.currentStage = "advisory-unlock";
    await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
    applyProgress.currentStage = "complete";
  } catch (error) {
    try {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
    } catch {
      // The original error is more useful than an unlock failure.
    }
    throw error;
  } finally {
    await client.end();
  }

  const result = {
    ok: true,
    mode: "apply",
    projectId: manifest.projectId,
    targetHost: config.host,
    excludedForwardMigrations: manifest.excludedForwardMigrations,
    databaseUrlEnv: config.envName,
    manifestSha256: manifest.manifestSha256,
    startedAt,
    finishedAt: new Date().toISOString(),
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped,
    onlySelection: selectedOnly.length > 0 ? onlySelectionReport : null,
    backupReceipt: confirmedBackup,
    postApplyRequired: [
      "run: pnpm deploy:ready",
      "confirm PostgREST schema readiness is ready",
      "restart web service only after schema readiness passes",
    ],
    committedMigrationCount: applyProgress.committedMigrations.length,
    ledgerRecordedCount: applyProgress.ledgerRecordedMigrations.length,
    databaseWrites: applyProgress.committedMigrations.length + applyProgress.ledgerRecordedMigrations.length,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  writeResult(result);
}

function writeResult(result) {
  const json = JSON.stringify(result, null, 2);
  console.log(json);
  if (!writeEvidence) return;
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const fileName = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${command}.json`;
  fs.writeFileSync(path.join(evidenceRoot, fileName), `${json}\n`, "utf8");
}

async function main() {
  if (!["plan", "status", "semantic-check", "adopt", "apply"].includes(command)) {
    throw new Error("UNKNOWN_MIGRATION_COMMAND");
  }
  if (command === "apply") {
    await apply();
    return;
  }
  if (command === "semantic-check") {
    await semanticCheck();
    return;
  }
  if (command === "adopt") {
    await adoptSemanticNoops();
    return;
  }
  await plan();
}

main().catch((error) => {
  const failure = {
    ok: false,
    mode: command,
    code: error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_ERROR",
    ...(command === "apply" ? {
      startedAt: applyProgress?.startedAt || null,
      failedAt: new Date().toISOString(),
      targetHost: applyProgress?.targetHost || null,
      manifestSha256: applyProgress?.manifestSha256 || null,
      failedStage: applyProgress?.currentStage || "preflight",
      failedMigration: applyProgress?.currentMigration || null,
      committedMigrationCount: applyProgress?.committedMigrations?.length || 0,
      ledgerRecordedCount: applyProgress?.ledgerRecordedMigrations?.length || 0,
      committedButUnrecorded: applyProgress?.committedButUnrecorded || null,
      committedMigrations: applyProgress?.committedMigrations || [],
      ledgerRecordedMigrations: applyProgress?.ledgerRecordedMigrations || [],
    } : {}),
    databaseWrites: command === "apply"
      ? (applyProgress?.committedMigrations?.length || 0) + (applyProgress?.ledgerRecordedMigrations?.length || 0)
      : 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  const json = JSON.stringify(failure, null, 2);
  console.error(json);
  if (writeEvidence) {
    fs.mkdirSync(evidenceRoot, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${command}-failed.json`;
    fs.writeFileSync(path.join(evidenceRoot, fileName), `${json}\n`, "utf8");
  }
  process.exitCode = 1;
});
