import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  PRODUCTION_DATABASE_CONTRACT,
  validateProductionDatabaseOpenApi,
} from "../src/lib/production-database-readiness";

let networkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkRequests += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_NONCOMMERCE_MIGRATION_PACK_TEST");
};

try {
  const expectedNames = [
    "20260915231500_image_generation_failure_history.sql",
    "20260915233000_digital_human_long_history_visibility.sql",
    "20260915233500_extraction_request_snapshot.sql",
    "20260915234500_short_drama_script_history.sql",
    "20260915235500_autodl_h3_revenue_profit.sql",
  ];
  const planRun = spawnSync(process.execPath, ["scripts/prepare-noncommerce-migration-pack.mjs", "plan"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH || "" },
  });
  assert.equal(planRun.status, 0, planRun.stderr);
  const plan = JSON.parse(planRun.stdout) as {
    ok: boolean;
    mode: string;
    migrations: Array<{ name: string; objects: string[] }>;
    expectedObjectCount: number;
    prefixClosureUsed: boolean;
    migrationDirectoryScans: number;
    commerceMigrationFilesRead: number;
    databaseConnections: number;
    databaseWrites: number;
    networkRequests: number;
    localWrites: number;
  };
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "plan");
  assert.deepEqual(plan.migrations.map((entry) => entry.name), expectedNames);
  assert.equal(plan.migrations.flatMap((entry) => entry.objects).length, 11);
  assert.equal(plan.expectedObjectCount, 11);
  assert.equal(plan.prefixClosureUsed, false);
  assert.equal(plan.migrationDirectoryScans, 0);
  assert.equal(plan.commerceMigrationFilesRead, 0);
  assert.equal(plan.databaseConnections, 0);
  assert.equal(plan.databaseWrites, 0);
  assert.equal(plan.networkRequests, 0);
  assert.equal(plan.localWrites, 0);
  assert.equal(expectedNames.some((name) => /commerce|shopping|affiliate|带货/iu.test(name)), false);

  const generator = readFileSync("scripts/prepare-noncommerce-migration-pack.mjs", "utf8");
  assert.doesNotMatch(generator, /from\s+["'](?:pg|dotenv|node:https?|node:net)["']/u);
  assert.doesNotMatch(generator, /\bfetch\s*\(/u);
  assert.doesNotMatch(generator, /readdirSync|globSync/u, "exact pack must not scan the migration directory");

  const legacyRunner = readFileSync("scripts/db-migration-release.mjs", "utf8");
  assert.match(legacyRunner, /entries\.slice\(0, closureEnd \+ 1\)/u);
  assert.match(legacyRunner, /dependencyClosureAdded/u);
  assert.doesNotMatch(
    generator,
    /valueOf\(["']--only["']\)|startsWith\(["']--only=/u,
    "exact pack must not parse or use the prefix-expanding selector",
  );

  const contractSource = JSON.parse(readFileSync("deploy/policies/database-contract.v1.json", "utf8"));
  assert.equal(contractSource.contractVersion, "20260915235500");
  const openApiFixture = {
    paths: Object.fromEntries([
      ...PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [`/${entry.name}`, { get: {} }]),
      ...PRODUCTION_DATABASE_CONTRACT.rpcs.map((entry) => [
        `/rpc/${entry.name}`,
        { post: { requestBody: { schema: { properties: Object.fromEntries(entry.arguments.map((argument) => [argument, {}])) } } } },
      ]),
    ]),
    definitions: Object.fromEntries(PRODUCTION_DATABASE_CONTRACT.tables.map((entry) => [
      entry.name,
      { properties: Object.fromEntries(entry.columns.map((column) => [column, {}])) },
    ])),
  };
  type OpenApiFixture = typeof openApiFixture;
  assert.equal(validateProductionDatabaseOpenApi(openApiFixture).ok, true);

  const blockingCases: Array<{
    id: string;
    remove: (fixture: OpenApiFixture) => void;
    expected: (result: ReturnType<typeof validateProductionDatabaseOpenApi>) => boolean;
  }> = [
    {
      id: "short_drama_script_requests",
      remove: (fixture) => { delete fixture.paths["/short_drama_script_requests"]; },
      expected: (result) => result.missingTables.includes("short_drama_script_requests"),
    },
    {
      id: "extraction_attempts.request_snapshot",
      remove: (fixture) => { delete fixture.definitions.extraction_attempts.properties.request_snapshot; },
      expected: (result) => result.missingColumns.includes("extraction_attempts.request_snapshot"),
    },
    {
      id: "digital_human_long_jobs.history_hidden_at",
      remove: (fixture) => { delete fixture.definitions.digital_human_long_jobs.properties.history_hidden_at; },
      expected: (result) => result.missingColumns.includes("digital_human_long_jobs.history_hidden_at"),
    },
    {
      id: "revenue_records.profit",
      remove: (fixture) => { delete fixture.definitions.revenue_records.properties.profit; },
      expected: (result) => result.missingColumns.includes("revenue_records.profit"),
    },
    ...[
      "claim_short_drama_script_request_atomic",
      "finalize_short_drama_script_request_atomic",
      "checkpoint_extraction_request_atomic",
      "hide_digital_human_long_history_item",
      "autodl_h3_finalize_video",
    ].map((name) => ({
      id: name,
      remove: (fixture: OpenApiFixture) => { delete fixture.paths[`/rpc/${name}`]; },
      expected: (result: ReturnType<typeof validateProductionDatabaseOpenApi>) => result.missingRpcs.includes(name),
    })),
  ];
  for (const testCase of blockingCases) {
    const fixture = structuredClone(openApiFixture);
    testCase.remove(fixture);
    const result = validateProductionDatabaseOpenApi(fixture);
    assert.equal(result.ok, false, `missing object must block release readiness: ${testCase.id}`);
    assert.equal(testCase.expected(result), true, `missing object must be identified: ${testCase.id}`);
  }

  const missingH3CostArgument = structuredClone(openApiFixture);
  delete missingH3CostArgument.paths["/rpc/autodl_h3_finalize_video"]
    .post.requestBody.schema.properties.p_cost_price;
  const missingH3CostResult = validateProductionDatabaseOpenApi(missingH3CostArgument);
  assert.equal(missingH3CostResult.ok, false);
  assert.ok(missingH3CostResult.missingRpcArguments.includes("autodl_h3_finalize_video.p_cost_price"));

  const policy = JSON.parse(readFileSync("deploy/policies/release-policy.json", "utf8"));
  assert.deepEqual(policy.database.criticalMigrationOrder.slice(-5), expectedNames);
  assert.equal(policy.database.rollbackStrategies.generalScript.mode, "forward-repair-only-after-activation");
  assert.equal(policy.database.rollbackStrategies.h3Revenue.mode, "forward-repair-only-after-activation");
  assert.deepEqual(policy.database.nonCommerceRepairPack.migrations, expectedNames);
  assert.equal(policy.database.nonCommerceRepairPack.migrationCount, 5);
  assert.equal(policy.database.nonCommerceRepairPack.objectCount, 11);
  assert.equal(policy.database.nonCommerceRepairPack.legacyOnlySelectorAllowed, false);
  assert.equal(policy.database.nonCommerceRepairPack.executionMode, "isolated-migration-root-with-existing-runner");

  assert.equal(networkRequests, 0);
  console.log(JSON.stringify({
    ok: true,
    migrationCount: 5,
    objectCount: 11,
    exactAllowlist: true,
    prefixClosureUsed: false,
    commerceMigrationFilesRead: 0,
    missingObjectBlockingCases: blockingCases.length + 1,
    networkRequests,
    databaseConnections: 0,
    databaseWrites: 0,
    localWrites: 0,
    migrationSqlExecuted: 0,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
