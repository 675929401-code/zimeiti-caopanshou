import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const normalize = (value) => value.split(path.sep).join("/");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const sha256 = (relativePath) => crypto
  .createHash("sha256")
  .update(fs.readFileSync(path.join(root, relativePath)))
  .digest("hex");

function walk(relativeRoot, extensions) {
  const absoluteRoot = path.join(root, relativeRoot);
  const found = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relativePath = normalize(path.join(relativeRoot, entry.name));
    const lower = relativePath.toLowerCase();
    const pathSegments = lower.split("/");
    if (pathSegments.some((segment) => segment.startsWith("commerce") || segment.includes("带货"))) continue;
    if (entry.isDirectory()) {
      found.push(...walk(relativePath, extensions));
    } else if (extensions.some((extension) => lower.endsWith(extension))) {
      found.push(relativePath);
    }
  }
  return found;
}

const legacyMigrationPaths = [
  "supabase/migrations/20260825175000_autodl_h3_lifecycle.sql",
  "scripts/migrations/20260821_autodl_h3_lifecycle.sql",
];
for (const legacyPath of legacyMigrationPaths) {
  assert.equal(
    sha256(legacyPath),
    "946faca2a622863bd62d0866b145e3c84f09553b51d051e00ab08878ff8d5420",
    `${legacyPath} must remain byte-for-byte unchanged`,
  );
}

const forwardMigrationPath = "supabase/migrations/20260915235500_autodl_h3_revenue_profit.sql";
const forwardMigration = read(forwardMigrationPath);
assert.match(forwardMigration, /^-- Forward-only repair/u);
assert.match(forwardMigration, /CREATE OR REPLACE FUNCTION autodl_h3_finalize_video\(/u);
assert.match(
  forwardMigration,
  /INSERT INTO revenue_records\(user_id, model_id, task_id, cost_price, selling_price,\s*profit, is_admin, record_type, credits_charged, cash_charged\)/u,
);
assert.match(
  forwardMigration,
  /round\(\(p_price_yuan - p_cost_price\)::numeric, 12\)/u,
  "new H3 rows must persist RMB selling minus cost",
);
assert.ok(
  forwardMigration.indexOf("SELECT * INTO v_existing FROM autodl_h3_settlements")
    < forwardMigration.indexOf("INSERT INTO revenue_records"),
  "the existing settlement idempotency guard must remain before the revenue insert",
);
for (const marker of [
  "WITH matched_h3_revenue AS MATERIALIZED",
  "INNER JOIN autodl_h3_settlements AS settlement",
  "settlement.public_task_id = revenue.task_id",
  "settlement.user_id = revenue.user_id::text",
  "settlement.model_id = revenue.model_id",
  "settlement.price_yuan = revenue.selling_price",
  "settlement.cost_price = revenue.cost_price",
  "settlement.charged_yuan = COALESCE(revenue.cash_charged, 0)",
  "revenue.record_type = 'video'",
  "revenue.task_id LIKE 'h3q_%'",
  "revenue.profit IS NULL",
  "WHERE revenue.id = matched.id",
]) {
  assert.ok(forwardMigration.includes(marker), `conservative H3 backfill is missing: ${marker}`);
}
assert.match(forwardMigration, /REVOKE ALL ON FUNCTION autodl_h3_finalize_video[\s\S]*FROM PUBLIC, anon, authenticated;/u);
assert.match(forwardMigration, /GRANT EXECUTE ON FUNCTION autodl_h3_finalize_video[\s\S]*TO service_role;/u);
assert.match(forwardMigration, /COMMIT;\s*$/u);

const unifiedBillingMigrationPath = "supabase/migrations/20260922011000_autodl_h3_unified_role_billing.sql";
const profitAlignmentMigrationPath = "supabase/migrations/20260922012000_autodl_h3_profit_billing_alignment.sql";
const profitAlignmentMigration = read(profitAlignmentMigrationPath);
assert.match(profitAlignmentMigration, /^-- Preserve unified H3 billing/u);
assert.match(profitAlignmentMigration, /profit, is_admin, billing_exempt, record_type/u);
assert.match(profitAlignmentMigration, /round\(\(p_price_yuan - p_cost_price\)::numeric, 12\)/u);
assert.match(profitAlignmentMigration, /COALESCE\(v_user\.role, 'student'\) = 'admin', false, 'video'/u);
assert.match(profitAlignmentMigration, /REVOKE ALL ON FUNCTION autodl_h3_finalize_video[\s\S]*FROM PUBLIC, anon, authenticated;/u);
assert.match(profitAlignmentMigration, /GRANT EXECUTE ON FUNCTION autodl_h3_finalize_video[\s\S]*TO service_role;/u);
assert.match(profitAlignmentMigration, /COMMIT;\s*$/u);

const functionStart = "CREATE OR REPLACE FUNCTION autodl_h3_finalize_video(";
const functionEnd = "$function$;";
function extractH3Function(sql) {
  const start = sql.indexOf(functionStart);
  const endStart = sql.indexOf(functionEnd, start);
  assert.notEqual(start, -1, "H3 finalizer function start is missing");
  assert.notEqual(endStart, -1, "H3 finalizer function end is missing");
  return sql.slice(start, endStart + functionEnd.length).replace(/\r\n/gu, "\n");
}
const legacyFunction = extractH3Function(read(legacyMigrationPaths[0]));
const expectedForwardFunction = legacyFunction.replace(
  "  INSERT INTO revenue_records(user_id, model_id, task_id, cost_price, selling_price,\n"
    + "    is_admin, record_type, credits_charged, cash_charged)\n"
    + "  VALUES (v_ledger_user_id, p_model_id, p_public_task_id, p_cost_price, p_price_yuan,\n"
    + "    COALESCE(v_user.role, 'student') = 'admin', 'video', 0, v_charged);",
  "  INSERT INTO revenue_records(user_id, model_id, task_id, cost_price, selling_price,\n"
    + "    profit, is_admin, record_type, credits_charged, cash_charged)\n"
    + "  VALUES (v_ledger_user_id, p_model_id, p_public_task_id, p_cost_price, p_price_yuan,\n"
    + "    round((p_price_yuan - p_cost_price)::numeric, 12),\n"
    + "    COALESCE(v_user.role, 'student') = 'admin', 'video', 0, v_charged);",
);
assert.notEqual(expectedForwardFunction, legacyFunction, "expected H3 insert patch was not applied");
assert.equal(
  extractH3Function(forwardMigration),
  expectedForwardFunction,
  "the forward RPC must be byte-equivalent to the published function except for profit persistence",
);

const sqlRoots = ["supabase/migrations", "scripts/migrations", "deploy"];
const directSqlInsertPaths = sqlRoots
  .flatMap((relativeRoot) => walk(relativeRoot, [".sql"]))
  .filter((relativePath) => /INSERT\s+INTO\s+(?:public\.)?["']?revenue_records/iu.test(read(relativePath)))
  .sort();
assert.deepEqual(directSqlInsertPaths, [
  "scripts/migrations/20260821_autodl_h3_lifecycle.sql",
  "supabase/migrations/20260825175000_autodl_h3_lifecycle.sql",
  forwardMigrationPath,
  unifiedBillingMigrationPath,
  profitAlignmentMigrationPath,
]);

const applicationSourcePaths = walk("src", [".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const directApplicationInsertPaths = applicationSourcePaths
  .filter((relativePath) => /from\(["']revenue_records["']\)[\s\S]{0,160}\.insert\(/u.test(read(relativePath)))
  .sort();
assert.deepEqual(directApplicationInsertPaths, ["src/lib/revenue.ts"]);

const h3Finalizer = read("src/lib/autodl-h3-production-finalizer.ts");
assert.match(h3Finalizer, /client\.rpc\("autodl_h3_finalize_video"/u);

const digitalQueueWorker = read("src/lib/digital-video-queue-worker.ts");
assert.match(digitalQueueWorker, /finalizeVideoGenerationSuccess/u);
assert.doesNotMatch(digitalQueueWorker, /revenue_records/u);

const sharedVideoFinalizer = read("src/lib/video-terminal-finalizer.ts");
assert.match(sharedVideoFinalizer, /await recordRevenue\(\{/u);

const voiceSources = applicationSourcePaths
  .filter((relativePath) => relativePath.startsWith("src/app/api/voice/") || relativePath.startsWith("src/lib/voice"));
for (const relativePath of voiceSources) {
  assert.doesNotMatch(read(relativePath), /revenue_records/u, `${relativePath} bypasses the voice billing lifecycle`);
}
const voiceTts = read("src/app/api/voice/tts/route.ts");
assert.match(voiceTts, /voice_billing_records/u);

console.log(JSON.stringify({
  ok: true,
  legacyMigrationsUnchanged: legacyMigrationPaths.length,
  sqlDirectInsertPaths: directSqlInsertPaths,
  applicationDirectInsertPaths: directApplicationInsertPaths,
  h3ForwardMigration: forwardMigrationPath,
  digitalHumanRevenuePath: "digital-video-queue-worker -> video-terminal-finalizer -> recordRevenue",
  voiceBillingPath: "voice_generation_requests + voice_billing_records",
  networkRequests: 0,
  databaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
