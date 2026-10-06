import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import {
  PRODUCTION_DATABASE_CONTRACT,
  validateProductionDatabaseOpenApi,
} from "../src/lib/production-database-readiness";

dotenv.config({ path: ".env.local", quiet: true });

const SOURCE_ROOT = path.join(process.cwd(), "src");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const NON_DATABASE_FROM_LITERALS = new Set(["table"]);
const NON_CONTRACT_RPCS = new Set([
  // Optional deployment/diagnostic helpers. Production request handling must not
  // require either function to be publicly exposed through PostgREST.
  "exec_sql",
  "set_config",
]);

function requiredConfig(): { endpoint: string; host: string; key: string } {
  const rawUrl = process.env.COZE_SUPABASE_URL?.trim() || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  assert(rawUrl, "PRODUCTION_SCHEMA_SUPABASE_URL_MISSING");
  assert(key, "PRODUCTION_SCHEMA_SERVICE_ROLE_KEY_MISSING");
  const base = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
  const endpoint = new URL("rest/v1/", base);
  return { endpoint: endpoint.toString(), host: endpoint.host, key };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [absolute];
    return [];
  }));
  return nested.flat();
}

function collectLiteralCalls(
  source: string,
  method: "from" | "rpc",
): string[] {
  const expression = new RegExp(`\\.${method}\\(\\s*["']([^"']+)["']`, "gu");
  return Array.from(source.matchAll(expression))
    .filter((match) => {
      if (method !== "from") return true;
      const prefix = source.slice(Math.max(0, (match.index || 0) - 80), match.index || 0);
      return !/\.storage\s*$/u.test(prefix);
    })
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
}

function collectConstantCalls(
  source: string,
  method: "from" | "rpc",
): string[] {
  const constants = new Map<string, string>();
  const declaration = /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/gu;
  for (const match of source.matchAll(declaration)) {
    const name = match[1]?.trim() || "";
    const value = match[2]?.trim() || "";
    if (name && value) constants.set(name, value);
  }

  const expression = new RegExp(`\\.${method}\\(\\s*([A-Z][A-Z0-9_]*)\\s*\\)`, "gu");
  return Array.from(source.matchAll(expression))
    .filter((match) => {
      if (method !== "from") return true;
      const prefix = source.slice(Math.max(0, (match.index || 0) - 80), match.index || 0);
      return !/\.storage\s*$/u.test(prefix);
    })
    .map((match) => constants.get(match[1] || "") || "")
    .filter(Boolean);
}

async function sourceContracts(): Promise<{ tables: string[]; rpcs: string[] }> {
  const files = await sourceFiles(SOURCE_ROOT);
  const tableNames = new Set<string>();
  const rpcNames = new Set<string>();

  for (const file of files) {
    const source = await readFile(file, "utf8");
    collectLiteralCalls(source, "from")
      .filter((name) => !NON_DATABASE_FROM_LITERALS.has(name))
      .forEach((name) => tableNames.add(name));
    collectConstantCalls(source, "from")
      .filter((name) => !NON_DATABASE_FROM_LITERALS.has(name))
      .forEach((name) => tableNames.add(name));
    collectLiteralCalls(source, "rpc")
      .filter((name) => !NON_CONTRACT_RPCS.has(name))
      .forEach((name) => rpcNames.add(name));
    collectConstantCalls(source, "rpc")
      .filter((name) => !NON_CONTRACT_RPCS.has(name))
      .forEach((name) => rpcNames.add(name));
  }

  return {
    tables: Array.from(tableNames).sort(),
    rpcs: Array.from(rpcNames).sort(),
  };
}

async function fetchOpenApi(): Promise<{ host: string; document: unknown }> {
  const config = requiredConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
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
    assert(response.ok, `PRODUCTION_SCHEMA_OPENAPI_FAILED_${response.status}`);
    const document: unknown = await response.json();
    return { host: config.host, document };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const [contracts, openApi] = await Promise.all([sourceContracts(), fetchOpenApi()]);
  const check = validateProductionDatabaseOpenApi(openApi.document);
  const declaredTables = new Set(PRODUCTION_DATABASE_CONTRACT.tables.map((table) => table.name));
  const declaredRpcs = new Set(PRODUCTION_DATABASE_CONTRACT.rpcs.map((rpc) => rpc.name));
  const diagnosticOnlySourceTables = contracts.tables.filter((name) => !declaredTables.has(name));
  const diagnosticOnlySourceRpcs = contracts.rpcs.filter((name) => !declaredRpcs.has(name));
  const result = {
    verifier: "production-schema-readiness",
    mode: "versioned-read-only-openapi-contract-probe",
    targetHost: openApi.host,
    databaseContract: {
      id: check.contractId,
      version: check.contractVersion,
      tableCount: check.tableCount,
      rpcCount: check.rpcCount,
    },
    sourceContract: {
      tableCount: contracts.tables.length,
      rpcCount: contracts.rpcs.length,
      diagnosticOnlySourceTables,
      diagnosticOnlySourceRpcs,
    },
    readiness: check.ok ? "ready" : "migration_not_ready",
    missingTables: check.missingTables,
    missingColumns: check.missingColumns,
    missingRpcs: check.missingRpcs,
    missingRpcArguments: check.missingRpcArguments,
    forbiddenRpcsPresent: check.forbiddenRpcsPresent,
    databaseWrites: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  };
  console.log(JSON.stringify(result, null, 2));
  assert.equal(check.ok, true, "PRODUCTION_SCHEMA_CONTRACT_NOT_READY");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
