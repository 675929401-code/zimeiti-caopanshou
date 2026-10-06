#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const root = process.cwd();
const [healthSource, commandCenterSource, durableLoopSource, workerRuntimeSource] = await Promise.all([
  fs.readFile(path.resolve(root, "src/app/api/health/route.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/server/admin-command-center.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/durable-queue-loop.ts"), "utf8"),
  fs.readFile(path.resolve(root, "src/lib/media-queue-worker-runtime.ts"), "utf8"),
]);

const commandCenterTables = [...commandCenterSource.matchAll(/\.from\("([a-z0-9_]+)"\)/gu)]
  .map((match) => match[1])
  .filter((value, index, all) => all.indexOf(value) === index)
  .sort();

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-readonly-incident-slo-source-audit",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});

function quoteIdentifier(value) {
  assert.match(value, /^[a-z0-9_]+$/u, "UNSAFE_IDENTIFIER");
  return `"${value}"`;
}

async function tableSnapshot(table) {
  const columns = (await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  )).rows.map((row) => row.column_name);
  if (columns.length === 0) return { table, exists: false, count: null, states: null };
  const quoted = quoteIdentifier(table);
  const count = Number((await client.query(`SELECT count(*)::integer AS count FROM public.${quoted}`)).rows[0].count);
  const stateColumn = columns.includes("state") ? "state" : columns.includes("status") ? "status" : null;
  let states = null;
  if (stateColumn) {
    states = Object.fromEntries((await client.query(
      `SELECT coalesce(${quoteIdentifier(stateColumn)}::text, '<null>') AS key, count(*)::integer AS count
         FROM public.${quoted}
        GROUP BY 1 ORDER BY 1`,
    )).rows.map((row) => [row.key, Number(row.count)]));
  }
  let queue = null;
  if (columns.includes("next_run_at") || columns.includes("lease_until")) {
    const parts = [];
    if (columns.includes("next_run_at")) {
      parts.push("count(*) FILTER (WHERE next_run_at <= now())::integer AS due");
      parts.push("min(next_run_at) FILTER (WHERE next_run_at <= now()) AS oldest_due_at");
    }
    if (columns.includes("lease_until")) {
      parts.push("count(*) FILTER (WHERE lease_until > now())::integer AS active_leases");
    }
    const row = (await client.query(`SELECT ${parts.join(", ")} FROM public.${quoted}`)).rows[0];
    queue = {
      due: row.due === undefined ? null : Number(row.due),
      oldestDueAt: row.oldest_due_at || null,
      activeLeases: row.active_leases === undefined ? null : Number(row.active_leases),
    };
  }
  return { table, exists: true, count, states, queue, columns };
}

await client.connect();
let began = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );
  await client.query("BEGIN READ ONLY");
  began = true;
  const candidateRows = (await client.query(
    `SELECT c.relname AS table_name,
            array_agg(a.attname ORDER BY a.attnum) FILTER (WHERE a.attnum > 0 AND NOT a.attisdropped) AS columns
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND (
          c.relname = ANY($1::text[])
          OR c.relname ~ '(queue|job|worker|health|log|flight)'
        )
      GROUP BY c.relname
      ORDER BY c.relname`,
    [[
      "health_checks",
      "system_logs",
      "auto_fixes",
      "diagnostic_logs",
      "operation_flight_events",
      "digital_video_dispatch_jobs",
      "digital_human_long_projects",
      "digital_human_long_segments",
      "video_tasks",
    ]],
  )).rows;
  const persistentWorkerTables = candidateRows
    .filter((row) => {
      const columns = row.columns || [];
      return columns.includes("state") || columns.includes("status")
        || columns.includes("lease_until") || columns.includes("next_run_at");
    })
    .map((row) => row.table_name)
    .slice(0, 80);
  const requiredTables = [
    "health_checks",
    "system_logs",
    "auto_fixes",
    "diagnostic_logs",
    "operation_flight_events",
  ];
  const tables = [...new Set([...requiredTables, ...persistentWorkerTables])].sort();
  const snapshots = [];
  for (const table of tables) snapshots.push(await tableSnapshot(table));
  const migrationRows = (await client.query(
    `SELECT version::text AS version
       FROM supabase_migrations.schema_migrations
      WHERE version::text = ANY($1::text[])
      ORDER BY version::text`,
    [[
      "20261001020000",
      "20261001030000",
      "20261002170000",
    ]],
  )).rows.map((row) => row.version);
  await client.query("ROLLBACK");
  began = false;
  console.log(JSON.stringify({
    passed: true,
    mode: "local-read-only-audit",
    database: {
      host: runtime.ownerConnection.host,
      port: Number(runtime.ownerConnection.port),
      name: runtime.ownerConnection.database,
      localOnly: runtime.localOnly,
    },
    staticBoundaries: {
      healthRoute: {
        persistsHealthChecks: healthSource.includes(".from('health_checks')"),
        persistsSystemLogs: healthSource.includes(".from('system_logs')"),
        persistsAutoFixes: healthSource.includes(".from('auto_fixes')"),
        readsFlightRecorder: healthSource.includes(".from('operation_flight_events')"),
        canCallExternalCozeReadProbe: healthSource.includes("testCozeConnection()"),
        canProbeObjectStorage: healthSource.includes("storageManager.list"),
        automaticRepairEnabled: false,
      },
      commandCenter: {
        readOnlySources: commandCenterTables,
        sourceCount: commandCenterTables.length,
        boundedQueries: commandCenterSource.includes("QUERY_TIMEOUT_MS"),
        unavailableStatusSupported: commandCenterSource.includes('"unavailable"'),
      },
      workerRuntime: {
        schedulerIsProcessLocal: durableLoopSource.includes("single-process scheduler"),
        statusIsProcessMemory: durableLoopSource.includes("completedTicks")
          && durableLoopSource.includes("failedTicks"),
        aggregatedWorkers: [
          "digital_video",
          "video_history",
          "digital_human_long",
          "commerce_rolling",
          "commerce_ordinary",
        ].filter((name) => {
          const token = name === "digital_video" ? "digitalVideo"
            : name === "video_history" ? "videoHistory"
              : name === "digital_human_long" ? "digitalHuman"
                : name === "commerce_rolling" ? "commerceRolling"
                  : "commerceOrdinary";
          return workerRuntimeSource.includes(token);
        }),
        sharedPersistentHeartbeatSource: null,
      },
    },
    appliedRelevantMigrations: migrationRows,
    newControlPlaneApplied: migrationRows.includes("20261002170000"),
    tables: snapshots,
    conclusion: {
      existingSourcesConnectedToIncidentSlo: false,
      liveMetricsFabricPresent: false,
      missingSourcesMustRemain: "unavailable/null",
    },
    transactionRolledBack: true,
    productionWrites: 0,
  }, null, 2));
} finally {
  if (began) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
