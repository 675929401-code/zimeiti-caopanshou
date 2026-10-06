import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureServerRuntimeEnvLoaded } from "../src/lib/server-runtime-env";
import {
  PRODUCTION_DATABASE_CONTRACT,
  probeProductionDatabaseReadiness,
} from "../src/lib/production-database-readiness";
import { isLikelyMojibake, normalizeDisplayText } from "../src/lib/display-normalization";

// Metadata only: no RPC invocation, task submission, wallet or database writes.
// Load credentials in memory through the same environment loader as the app.
ensureServerRuntimeEnvLoaded();

async function main() {
  const readiness = await probeProductionDatabaseReadiness();
  const features = new Set(["extraction-exactly-once", "wallet"]);
  const tables = PRODUCTION_DATABASE_CONTRACT.tables.filter((row) => features.has(row.feature));
  const rpcs = PRODUCTION_DATABASE_CONTRACT.rpcs.filter((row) => features.has(row.feature));
  const tableNames = new Set(tables.map((row) => row.name));
  const rpcNames = new Set(rpcs.map((row) => row.name));
  const missingTables = readiness.missingTables.filter((name) => tableNames.has(name));
  const missingColumns = readiness.missingColumns.filter((name) => tableNames.has(name.split(".")[0]));
  const missingRpcs = readiness.missingRpcs.filter((name) => rpcNames.has(name));
  const missingRpcArguments = readiness.missingRpcArguments.filter((name) => rpcNames.has(name.split(".")[0]));
  const metadataAvailable = readiness.state !== "probe-unavailable";
  const base = process.env.COZE_SUPABASE_URL?.trim();
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  const directDatabaseEnv = ["DEPLOY_DATABASE_URL", "SUPABASE_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"]
    .find((name) => Boolean(process.env[name]?.trim())) || null;
  let pluginInspection: Record<string, unknown> = { state: "unavailable" };
  let failureHistoryRetry: Record<string, unknown> = {
    ready: false,
    metadataAvailable: false,
    requestSnapshotColumn: false,
    checkpointRpc: false,
    historyProjectionRpc: false,
    unavailableReason: "数据库元数据不可用，失败历史快捷重试保持关闭",
  };
  let databaseScope = "unknown";
  let targetFingerprint: string | null = null;

  if (base && key) {
    try {
      const schemaEndpoint = new URL("rest/v1/", base.endsWith("/") ? base : `${base}/`);
      const schemaResponse = await fetch(schemaEndpoint, {
        method: "GET",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Accept-Profile": "public",
          Accept: "application/openapi+json",
        },
        signal: AbortSignal.timeout(10_000),
      });
      const document = schemaResponse.ok ? await schemaResponse.json() as {
        paths?: Record<string, { post?: unknown }>;
        definitions?: Record<string, { properties?: Record<string, unknown> }>;
      } : null;
      const requestSnapshotColumn = Boolean(document?.definitions?.extraction_attempts?.properties?.request_snapshot);
      const checkpointRpc = Boolean(document?.paths?.["/rpc/checkpoint_extraction_request_atomic"]?.post);
      const historyProjectionRpc = Boolean(document?.paths?.["/rpc/read_extraction_account_history"]?.post);
      const retryReady = requestSnapshotColumn && checkpointRpc && historyProjectionRpc;
      const missing = [
        !requestSnapshotColumn && "extraction_attempts.request_snapshot",
        !checkpointRpc && "checkpoint_extraction_request_atomic",
        !historyProjectionRpc && "read_extraction_account_history",
      ].filter((item): item is string => Boolean(item));
      failureHistoryRetry = {
        ready: retryReady,
        metadataAvailable: schemaResponse.ok,
        requestSnapshotColumn,
        checkpointRpc,
        historyProjectionRpc,
        projectionEvidence: retryReady ? "same-transaction-migration-contract" : "not-ready",
        unavailableReason: retryReady
          ? null
          : `提取主链可用；失败历史快捷重试尚未就绪：${missing.join("、") || "数据库元数据不可用"}`,
      };

      const endpoint = new URL("rest/v1/plugins", base.endsWith("/") ? base : `${base}/`);
      databaseScope = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ? "local" : "remote";
      targetFingerprint = createHash("sha256").update(endpoint.origin).digest("hex").slice(0, 16);
      endpoint.searchParams.set("select", "id,name,description,role,type,price_unit,price_per_use,cost_price,is_active");
      endpoint.searchParams.set("role", "in.(extract_workflow,extract_video,extract_text_third_party,extract_batch_third_party,coze_multifunction_extract)");
      endpoint.searchParams.set("order", "id.asc");
      endpoint.searchParams.set("limit", "100");
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "public" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        pluginInspection = { state: "unavailable", httpStatus: response.status };
      } else {
        const rows: unknown = await response.json();
        if (!Array.isArray(rows)) throw new Error("INVALID_PLUGIN_METADATA");
        pluginInspection = {
          state: "read-only-inspected",
          rowCount: rows.length,
          rows: rows.map((row) => ({
            id: row.id,
            role: row.role,
            type: row.type,
            active: row.is_active,
            name: normalizeDisplayText(row.name, "未命名插件"),
            priceUnit: normalizeDisplayText(row.price_unit, "次"),
            pricePerUse: row.price_per_use,
            costPrice: row.cost_price,
            suspiciousFields: ["name", "description", "price_unit"].filter((field) => isLikelyMojibake(row[field])),
            repairableFields: ["name", "description", "price_unit"].filter((field) =>
              typeof row[field] === "string" && normalizeDisplayText(row[field]) !== row[field].replace(/\s+/gu, " ").trim()),
          })),
        };
      }
    } catch {
      // Do not print raw network errors or URLs, which may contain credentials.
      pluginInspection = { state: "unavailable", code: "PLUGIN_METADATA_PROBE_UNAVAILABLE" };
    }
  }

  const schemaReady = metadataAvailable && !missingTables.length && !missingColumns.length
    && !missingRpcs.length && !missingRpcArguments.length;
  const result = {
    checkedAt: new Date().toISOString(),
    mode: "read-only-extraction-preflight",
    databaseScope,
    targetFingerprint,
    directMigrationConnectionConfigured: Boolean(directDatabaseEnv),
    directMigrationConnectionEnv: directDatabaseEnv,
    schema: {
      metadataAvailable,
      ready: schemaReady,
      requiredTables: tables.map((row) => row.name),
      requiredRpcs: rpcs.map((row) => row.name),
      missingTables, missingColumns, missingRpcs, missingRpcArguments,
    },
    failureHistoryRetry,
    pluginInspection,
    databaseWrites: 0,
    rpcInvocations: 0,
    providerCalls: 0,
    ordinaryUserEndToEnd: "not-executed",
  };
  const out = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
  if (out) {
    const outputPath = path.resolve(out);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  if (!schemaReady) process.exitCode = 2;
}

main().catch(() => {
  console.error("EXTRACTION_READINESS_PROBE_FAILED: no task or database write was requested");
  process.exitCode = 1;
});
