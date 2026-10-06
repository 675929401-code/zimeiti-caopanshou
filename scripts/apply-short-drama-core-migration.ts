import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import {
  SHORT_DRAMA_TABLE_CONTRACT,
  shortDramaReadinessFromOpenApi,
  type ShortDramaReadiness,
} from "../src/lib/short-drama/readiness";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const confirmation = process.argv.find((argument) => argument.startsWith("--confirm-sha256="))
  ?.slice("--confirm-sha256=".length)
  .trim()
  .toLowerCase() || "";
const confirmedTargetHost = process.argv.find((argument) => argument.startsWith("--confirm-target-host="))
  ?.slice("--confirm-target-host=".length)
  .trim()
  .toLowerCase() || "";
const migrationsDirectory = path.join(process.cwd(), "supabase/migrations");
const migrationFileName = "20260823043000_short_drama_core.sql";
const migrationPath = path.join(migrationsDirectory, migrationFileName);
const rollbackPath = path.join(
  process.cwd(),
  "supabase/rollbacks/20260823043000_short_drama_core.rollback.sql",
);

const CANONICAL_MIGRATION_FILE = /^(\d{14})_[a-z0-9][a-z0-9_-]*\.sql$/iu;
const ROLLBACK_LIKE_MIGRATION_FILE = /(?:^|[._-])(?:rollback|down)(?:[._-]|$)/iu;

const REQUIRED_MARKERS = [
  "CREATE TABLE IF NOT EXISTS short_drama_projects",
  "CREATE TABLE IF NOT EXISTS short_drama_jobs",
  "CREATE TABLE IF NOT EXISTS short_drama_settlements",
  "CREATE OR REPLACE FUNCTION short_drama_create_project",
  "CREATE OR REPLACE FUNCTION short_drama_update_project",
  "CREATE OR REPLACE FUNCTION short_drama_delete_project",
  "REVOKE ALL ON TABLE short_drama_projects FROM anon, authenticated",
  "GRANT ALL ON TABLE short_drama_projects TO service_role",
] as const;

type OpenApiProbe = {
  readonly document: unknown;
  readonly endpointHost: string;
  readonly execSqlAvailable: boolean;
  readonly readiness: ShortDramaReadiness;
  readonly migrationState: "absent" | "partial" | "ready";
  readonly presentContractPaths: readonly string[];
  readonly missingContractPaths: readonly string[];
  readonly ownerIdContract: {
    readonly type: string | null;
    readonly format: string | null;
    readonly maxLength: number | null;
  };
};

const EXPECTED_CONTRACT_PATHS = [
  ...SHORT_DRAMA_TABLE_CONTRACT.map((table) => `/${table.name}`),
  "/rpc/short_drama_create_project",
  "/rpc/short_drama_update_project",
  "/rpc/short_drama_delete_project",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownerIdContractFromOpenApi(document: unknown): OpenApiProbe["ownerIdContract"] {
  const root = isRecord(document) ? document : {};
  const definitions = isRecord(root.definitions) ? root.definitions : {};
  const users = isRecord(definitions.users) ? definitions.users : {};
  const properties = isRecord(users.properties) ? users.properties : {};
  const id = isRecord(properties.id) ? properties.id : {};
  return {
    type: typeof id.type === "string" ? id.type : null,
    format: typeof id.format === "string" ? id.format : null,
    maxLength: typeof id.maxLength === "number" ? id.maxLength : null,
  };
}

function protectedOpenApiConfig(): {
  readonly endpoint: string;
  readonly endpointHost: string;
  readonly key: string;
} {
  const baseUrl = process.env.COZE_SUPABASE_URL?.trim() || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!baseUrl || !key) {
    throw new Error("SHORT_DRAMA_MIGRATION_TARGET_NOT_CONFIGURED");
  }

  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const endpoint = new URL("rest/v1/", normalizedBase);
  return { endpoint: endpoint.toString(), endpointHost: endpoint.host, key };
}

async function probeOpenApi(): Promise<OpenApiProbe> {
  const config = protectedOpenApiConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(config.endpoint, {
      method: "GET",
      headers: {
        Accept: "application/openapi+json",
        "Accept-Profile": "public",
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`SHORT_DRAMA_OPENAPI_PROBE_FAILED_${response.status}`);
    const document: unknown = await response.json();
    const paths = document && typeof document === "object" && !Array.isArray(document)
      && "paths" in document
      && document.paths && typeof document.paths === "object" && !Array.isArray(document.paths)
      ? document.paths as Record<string, unknown>
      : {};
    const presentContractPaths = EXPECTED_CONTRACT_PATHS.filter((entry) => Boolean(paths[entry]));
    const missingContractPaths = EXPECTED_CONTRACT_PATHS.filter((entry) => !paths[entry]);
    const readiness = shortDramaReadinessFromOpenApi(document);
    const migrationState = readiness.ok && missingContractPaths.length === 0
      ? "ready"
      : presentContractPaths.length === 0
        ? "absent"
        : "partial";
    return {
      document,
      endpointHost: config.endpointHost,
      execSqlAvailable: Boolean(paths["/rpc/exec_sql"]),
      readiness,
      migrationState,
      presentContractPaths,
      missingContractPaths,
      ownerIdContract: ownerIdContractFromOpenApi(document),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateFixedScope(sql: string): void {
  for (const marker of REQUIRED_MARKERS) {
    if (!sql.includes(marker)) throw new Error(`SHORT_DRAMA_MIGRATION_MARKER_MISSING:${marker}`);
  }
  if (/\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE)|TRUNCATE|DELETE\s+FROM)\b/iu.test(sql)) {
    throw new Error("SHORT_DRAMA_MIGRATION_DESTRUCTIVE_SCOPE_REJECTED");
  }
  if ((sql.match(/CREATE TABLE IF NOT EXISTS short_drama_[a-z_]+/g) || []).length !== 8) {
    throw new Error("SHORT_DRAMA_MIGRATION_TABLE_SCOPE_INVALID");
  }
  if ((sql.match(/CREATE(?: UNIQUE)? INDEX IF NOT EXISTS short_drama_[a-z0-9_]+/g) || []).length !== 15) {
    throw new Error("SHORT_DRAMA_MIGRATION_INDEX_SCOPE_INVALID");
  }
  if ((sql.match(/DROP TRIGGER IF EXISTS short_drama_[a-z0-9_]+/g) || []).length !== 5) {
    throw new Error("SHORT_DRAMA_MIGRATION_TRIGGER_SCOPE_INVALID");
  }
  if ((sql.match(/DROP POLICY IF EXISTS short_drama_[a-z0-9_]+/g) || []).length !== 8) {
    throw new Error("SHORT_DRAMA_MIGRATION_POLICY_SCOPE_INVALID");
  }
  if ((sql.match(/CREATE OR REPLACE FUNCTION short_drama_[a-z0-9_]+/g) || []).length !== 4) {
    throw new Error("SHORT_DRAMA_MIGRATION_FUNCTION_SCOPE_INVALID");
  }
  if ((sql.match(/user_id varchar\(36\) NOT NULL REFERENCES public\.users\(id\)/g) || []).length !== 8
      || (sql.match(/^\s{2}p_user_id varchar,/gm) || []).length !== 3
      || /^\s{2}user_id\s+uuid\b/imu.test(sql)) {
    throw new Error("SHORT_DRAMA_MIGRATION_OWNER_ID_CONTRACT_INVALID");
  }
  if (!/^BEGIN;/u.test(sql.trimStart()) || !/COMMIT;\s*$/u.test(sql)) {
    throw new Error("SHORT_DRAMA_MIGRATION_TRANSACTION_BOUNDARY_INVALID");
  }
}

function validateGuardedRollback(sql: string): void {
  if (!/^BEGIN;/u.test(sql.trimStart()) || !/COMMIT;\s*$/u.test(sql)) {
    throw new Error("SHORT_DRAMA_ROLLBACK_TRANSACTION_BOUNDARY_INVALID");
  }
  if (!sql.includes("SHORT_DRAMA_ROLLBACK_REFUSED_NONEMPTY")) {
    throw new Error("SHORT_DRAMA_ROLLBACK_NONEMPTY_GUARD_MISSING");
  }
  if (/\bDROP\s+(?:TABLE|FUNCTION)[^;\n]*\bCASCADE\b/iu.test(sql)) {
    throw new Error("SHORT_DRAMA_ROLLBACK_CASCADE_REJECTED");
  }
}

async function validateMigrationDirectorySafety(): Promise<void> {
  const migrationFiles = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const rollbackLikeFiles = migrationFiles.filter((fileName) => (
    ROLLBACK_LIKE_MIGRATION_FILE.test(fileName)
  ));
  if (rollbackLikeFiles.length > 0) {
    throw new Error(
      `SHORT_DRAMA_MIGRATION_DIRECTORY_ROLLBACK_FILE_REJECTED:${rollbackLikeFiles.join(",")}`,
    );
  }

  const nonCanonicalFiles = migrationFiles.filter((fileName) => (
    !CANONICAL_MIGRATION_FILE.test(fileName)
  ));
  if (nonCanonicalFiles.length > 0) {
    throw new Error(
      `SHORT_DRAMA_MIGRATION_DIRECTORY_NONCANONICAL_FILE_REJECTED:${nonCanonicalFiles.join(",")}`,
    );
  }

  const versions = new Map<string, string[]>();
  for (const fileName of migrationFiles) {
    const version = CANONICAL_MIGRATION_FILE.exec(fileName)?.[1];
    if (!version) continue;
    versions.set(version, [...(versions.get(version) || []), fileName]);
  }
  const duplicateVersions = Array.from(versions.entries())
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => `${version}=${files.join("+")}`);
  if (duplicateVersions.length > 0) {
    throw new Error(
      `SHORT_DRAMA_MIGRATION_DIRECTORY_DUPLICATE_VERSION_REJECTED:${duplicateVersions.join(",")}`,
    );
  }

  if (!migrationFiles.includes(migrationFileName)) {
    throw new Error("SHORT_DRAMA_MIGRATION_FILE_MISSING_FROM_FORWARD_DIRECTORY");
  }
  if (path.dirname(rollbackPath) === migrationsDirectory) {
    throw new Error("SHORT_DRAMA_ROLLBACK_PATH_MUST_NOT_BE_CLI_SCANNED");
  }
}

async function main(): Promise<void> {
  await validateMigrationDirectorySafety();
  const sql = await readFile(migrationPath, "utf8");
  const rollbackSql = await readFile(rollbackPath, "utf8");
  validateFixedScope(sql);
  validateGuardedRollback(rollbackSql);
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const rollbackSha256 = createHash("sha256").update(rollbackSql).digest("hex");
  const before = await probeOpenApi();
  const ownerIdContractCompatible = before.ownerIdContract.type === "string"
    && before.ownerIdContract.format === "character varying"
    && before.ownerIdContract.maxLength === 36;

  const baseEvidence = {
    migration: path.basename(migrationPath),
    sha256,
    rollback: path.relative(process.cwd(), rollbackPath).replaceAll(path.sep, "/"),
    rollbackSha256,
    migrationDirectoryPreflight: "passed",
    targetHost: before.endpointHost,
    readinessBefore: before.readiness,
    migrationStateBefore: before.migrationState,
    presentContractPaths: before.presentContractPaths,
    missingContractPaths: before.missingContractPaths,
    ownerIdContract: before.ownerIdContract,
    ownerIdContractCompatible,
    migrationExecutorAvailable: before.execSqlAvailable,
    credentialsPrinted: false,
    paidModelCalls: 0,
  } as const;

  if (!APPLY) {
    console.log(JSON.stringify({
      mode: "dry-run",
      ...baseEvidence,
      databaseWrites: 0,
      applyCommandAuthorized: false,
      requiredApplyConfirmations: [
        `--confirm-sha256=${sha256}`,
        `--confirm-target-host=${before.endpointHost}`,
      ],
    }, null, 2));
    return;
  }

  if (!ownerIdContractCompatible) {
    throw new Error("SHORT_DRAMA_TARGET_OWNER_ID_CONTRACT_MISMATCH");
  }
  if (before.migrationState === "ready") {
    console.log(JSON.stringify({
      mode: "already-ready-no-op",
      ...baseEvidence,
      databaseWrites: 0,
      applyCommandAuthorized: true,
    }, null, 2));
    return;
  }
  if (before.migrationState === "partial") {
    throw new Error("SHORT_DRAMA_PARTIAL_SCHEMA_MANUAL_REVIEW_REQUIRED");
  }

  if (confirmation !== sha256) {
    throw new Error("SHORT_DRAMA_MIGRATION_SHA256_CONFIRMATION_REQUIRED");
  }
  if (confirmedTargetHost !== before.endpointHost.toLowerCase()) {
    throw new Error("SHORT_DRAMA_MIGRATION_TARGET_HOST_CONFIRMATION_REQUIRED");
  }
  if (!before.execSqlAvailable) {
    throw new Error("SHORT_DRAMA_MIGRATION_EXECUTOR_UNAVAILABLE");
  }

  const db = getSupabaseAdminClient();
  const { error } = await db.rpc("exec_sql", { sql });
  if (error) throw new Error(`SHORT_DRAMA_MIGRATION_APPLY_FAILED:${error.message}`);

  const after = await probeOpenApi();
  if (!after.readiness.ok) {
    throw new Error(`SHORT_DRAMA_MIGRATION_CONTRACT_NOT_READY:${after.readiness.code}`);
  }
  console.log(JSON.stringify({
    mode: "applied",
    ...baseEvidence,
    readinessAfter: after.readiness,
    databaseWrites: 1,
    applyCommandAuthorized: true,
  }, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_ERROR",
    credentialsPrinted: false,
    paidModelCalls: 0,
  }));
  process.exitCode = 1;
});
