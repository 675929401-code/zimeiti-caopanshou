#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";
import {
  DATABASE_SEMANTIC_PROFILE,
  captureSemanticSnapshot,
  compareSemanticSnapshots,
  sha256,
  stableJson,
} from "./lib/database-semantic-catalog.mjs";

const { Client } = pg;
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args.shift() : "verify";
const root = path.resolve(valueOf("--root") || process.cwd());
const contractPath = path.resolve(root, valueOf("--contract") || "deploy/policies/database-semantic-contract.v1.json");
const databaseUrlEnvNames = (valueOf("--database-url-env") || "DEPLOY_DATABASE_URL,SUPABASE_DATABASE_URL,DATABASE_URL,POSTGRES_URL")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

function hasFlag(name) {
  return args.includes(name);
}

function valueOf(name) {
  const exact = args.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function databaseConfig() {
  for (const envName of databaseUrlEnvNames) {
    const connectionString = String(process.env[envName] || "").trim();
    if (!connectionString) continue;
    const parsed = new URL(connectionString);
    return { envName, connectionString, host: parsed.hostname.toLowerCase(), database: parsed.pathname.replace(/^\//u, "") };
  }
  throw new Error("DATABASE_URL_NOT_CONFIGURED");
}

function assertPathInsideRoot(filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("CONTRACT_PATH_OUTSIDE_PROJECT");
}

function contractDigest(value) {
  const core = { ...value };
  delete core.contractSha256;
  return sha256(stableJson(core));
}

async function withSnapshot(action) {
  const config = databaseConfig();
  const client = new Client({ connectionString: config.connectionString, application_name: `zimeiti-semantic-${command}` });
  await client.connect();
  try {
    const identity = await client.query(`select current_database() as database_name,
      coalesce(inet_server_addr()::text, 'local') as server_address,
      current_setting('server_version_num') as server_version`);
    const snapshot = await captureSemanticSnapshot(client);
    return await action(snapshot, {
      envName: config.envName,
      host: config.host,
      database: identity.rows[0]?.database_name || config.database,
      serverVersion: identity.rows[0]?.server_version || null,
    });
  } finally {
    await client.end();
  }
}

async function capture() {
  if (!hasFlag("--write")) throw new Error("CAPTURE_REQUIRES_WRITE_FLAG");
  assertPathInsideRoot(contractPath);
  if (fs.existsSync(contractPath) && !hasFlag("--replace")) throw new Error("CONTRACT_ALREADY_EXISTS");
  const result = await withSnapshot(async (snapshot, target) => {
    const core = {
      schemaVersion: 1,
      kind: "database-semantic-contract",
      profile: DATABASE_SEMANTIC_PROFILE,
      generatedAt: new Date().toISOString(),
      sourceLabel: String(valueOf("--source-label") || "reviewed-canonical-schema").slice(0, 160),
      sourceDatabase: target.database,
      migrationManifestSha256: String(valueOf("--migration-manifest-sha256") || "").trim() || null,
      extraObjectPolicy: "structural extras warn; privilege extras block",
      snapshot,
    };
    return { ...core, contractSha256: contractDigest(core) };
  });
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    passed: true,
    mode: "capture",
    contract: path.relative(root, contractPath).split(path.sep).join("/"),
    contractSha256: result.contractSha256,
    snapshotSha256: result.snapshot.sha256,
    sections: Object.fromEntries(Object.entries(result.snapshot.sections).map(([name, value]) => [name, value.rows])),
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
}

async function verify() {
  if (!fs.existsSync(contractPath)) throw new Error("DATABASE_SEMANTIC_CONTRACT_NOT_FOUND");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  if (contract.kind !== "database-semantic-contract" || contract.profile !== DATABASE_SEMANTIC_PROFILE) {
    throw new Error("DATABASE_SEMANTIC_CONTRACT_VERSION_UNSUPPORTED");
  }
  if (contract.contractSha256 !== contractDigest(contract)) throw new Error("DATABASE_SEMANTIC_CONTRACT_INTEGRITY_FAILED");
  const result = await withSnapshot(async (snapshot, target) => {
    const comparison = compareSemanticSnapshots(contract.snapshot, snapshot, { strictExtras: hasFlag("--strict-extras") });
    const group = (items) => Object.fromEntries([...new Set(items.map((item) => item.section))].sort()
      .map((section) => [section, items.filter((item) => item.section === section).length]));
    return {
      passed: comparison.passed,
      mode: "verify",
      profile: DATABASE_SEMANTIC_PROFILE,
      target: { envName: target.envName, host: target.host, database: target.database, serverVersion: target.serverVersion },
      contractSha256: contract.contractSha256,
      expectedSnapshotSha256: contract.snapshot.sha256,
      actualSnapshotSha256: snapshot.sha256,
      blockingCount: comparison.blocking.length,
      warningCount: comparison.warnings.length,
      blockingBySection: group(comparison.blocking),
      warningsBySection: group(comparison.warnings),
      blocking: comparison.blocking.slice(0, 100),
      warnings: comparison.warnings.slice(0, 50),
      truncated: comparison.blocking.length > 100 || comparison.warnings.length > 50,
      databaseWrites: 0,
      paidModelCalls: 0,
      credentialsPrinted: false,
    };
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}

async function main() {
  if (command === "capture") return capture();
  if (command === "verify") return verify();
  throw new Error("UNKNOWN_DATABASE_SEMANTIC_CONTRACT_COMMAND");
}

main().catch((error) => {
  console.error(JSON.stringify({
    passed: false,
    mode: command,
    code: error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_ERROR",
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exitCode = 1;
});
