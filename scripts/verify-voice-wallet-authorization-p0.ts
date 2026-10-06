import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function source(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  const present = existsSync(absolutePath);
  add(`file:${relativePath}`, present, present ? "present" : "missing");
  return present ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: string[]) {
  const missing = tokens.filter((token) => !text.includes(token));
  add(
    name,
    missing.length === 0,
    missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`,
  );
}

function excludesAll(name: string, text: string, tokens: string[]) {
  const found = tokens.filter((token) => text.includes(token));
  add(name, found.length === 0, found.length === 0 ? "forbidden tokens absent" : `found: ${found.join(", ")}`);
}

function ordered(name: string, text: string, first: string, second: string) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  add(
    name,
    firstIndex >= 0 && secondIndex > firstIndex,
    `first=${firstIndex}; second=${secondIndex}`,
  );
}

const deductPath = "src/app/api/voice/billing/deduct/route.ts";
const nestPath = "src/app/api/voice/nest/route.ts";
const clonePath = "src/app/api/voice/clone/route.ts";
const designPath = "src/app/api/voice/design/route.ts";
const migrationPath = "supabase/migrations/20260825173500_voice_atomic_authorization_purchase.sql";
const lifecycleMigrationPath = "supabase/migrations/20260901153000_voice_training_provider_lifecycle.sql";
const rollbackPath = "supabase/rollbacks/20260825173500_voice_atomic_authorization_purchase.rollback.sql";

const deduct = source(deductPath);
const nest = source(nestPath);
const clone = source(clonePath);
const design = source(designPath);
const migration = source(migrationPath);
const lifecycleMigration = source(lifecycleMigrationPath);
const rollback = source(rollbackPath);

includesAll("deduct:fail-closed-service-auth", deduct, [
  "getServerSecret('SITE_API_KEY')",
  "VOICE_BILLING_AUTH_NOT_CONFIGURED",
  "safeCompareSecret",
  "Idempotency-Key",
  "referenceId",
]);
includesAll("deduct:atomic-wallet", deduct, [
  "applyAtomicWalletOperation",
  "operationKind: 'cash_charge'",
  "voice:service:",
  "price_snapshot",
]);
excludesAll("deduct:no-source-secret-fallback-or-direct-user-mutation", deduct, [
  "getServerSecret('SITE_API_KEY',",
  ".from('users')",
  "cash_balance:",
]);

includesAll("nest:strict-quantity-and-key", nest, [
  "typeof quantity !== 'number'",
  "Number.isSafeInteger(quantity)",
  "quantity < 1 || quantity > 10",
  "VOICE_NEST_IDEMPOTENCY_KEY_REQUIRED",
]);
includesAll("nest:versioned-price-and-atomic-purchase", nest, [
  "voice_nest_price_versions",
  "purchase_voice_nest_slots_atomic",
  "priceSnapshot",
  "VOICE_NEST_IDEMPOTENCY_CONFLICT",
]);
excludesAll("nest:no-hardcoded-price-or-direct-wallet-write", nest, [
  "parseInt(",
  ".update({ cash_balance",
  ".from('cash_transactions').insert",
]);
add(
  "nest:no-hardcoded-price-constant",
  !/\bconst\s+[A-Z0-9_]*PRICE[A-Z0-9_]*\s*=\s*\d/i.test(nest),
  "no numeric price constant is embedded in the route",
);

for (const [operation, text, routeToken] of [
  ["clone", clone, "routeClone("],
  ["design", design, "designVoice("],
] as const) {
  includesAll(`${operation}:stable-key-fingerprint`, text, [
    "Idempotency-Key",
    "clientRequestId",
    "request_fingerprint",
    "sha256(",
  ]);
  includesAll(`${operation}:reservation-lifecycle`, text, [
    "reserve_voice_training_authorization_atomic",
    "markVoiceTrainingProviderAttempt",
    "releaseVoiceTrainingTerminal",
    "finalizeVoiceTrainingReady",
    "RESERVATION_RESULT_INVALID",
    "reconciliation_required",
  ]);
  ordered(
    `${operation}:reserve-before-provider`,
    text,
    "reserve_voice_training_authorization_atomic",
    routeToken,
  );
  ordered(
    `${operation}:provider-before-finalize`,
    text,
    routeToken,
    "const finalized = await finalizeVoiceTrainingReady",
  );
  excludesAll(`${operation}:no-direct-license-voice-or-billing-mutation`, text, [
    ".from('voice_clone_licenses')",
    ".from('user_voices')",
    ".from('voice_billing_records')",
    "license_key",
  ]);
}

excludesAll("design:no-unstable-clock-job-id", design, ["Date.now()"]);
includesAll("design:deterministic-provider-id", design, [
  "deriveVoiceTrainingSpeakerId(user.id, jobKey, 'design')",
  "VOICE_DESIGN_JOB_KEY_REQUIRED",
]);

includesAll("lifecycle-migration:durable-provider-state", lifecycleMigration, [
  "provider_pending",
  "reconciliation_required",
  "provider_call_started_at",
  "mark_voice_training_provider_attempt_atomic",
  "release_voice_training_terminal_atomic",
  "finalize_voice_training_ready_atomic",
  "VOICE_TRAINING_PROVIDER_MAY_HAVE_STARTED",
  "VOICE_TRAINING_TERMINAL_READY_REQUIRED",
]);

includesAll("migration:versioned-price-snapshot", migration, [
  "voice_nest_price_versions",
  "voice_nest_purchase_requests",
  "price_version_id",
  "unit_price_cash",
  "wallet_result",
  "VOICE_NEST_PRICE_NOT_CONFIGURED",
]);
add(
  "migration:no-embedded-active-price-seed",
  !/INSERT\s+INTO\s+public\.voice_nest_price_versions/i.test(migration),
  "forward migration contains no active price seed",
);
includesAll("migration:atomic-nest-purchase", migration, [
  "purchase_voice_nest_slots_atomic",
  "apply_wallet_operation_atomic",
  "VOICE_NEST_IDEMPOTENCY_CONFLICT",
  "FOR UPDATE",
  "VOICE_NEST_SLOT_INSERT_INCOMPLETE",
]);
includesAll("migration:authorization-reserve-release-finalize", migration, [
  "voice_training_authorization_jobs",
  "reserve_voice_training_authorization_atomic",
  "release_voice_training_authorization_atomic",
  "finalize_voice_training_authorization_atomic",
  "VOICE_TRAINING_IDEMPOTENCY_CONFLICT",
  "VOICE_TRAINING_LICENSE_RESERVATION_CONFLICT",
  "VOICE_TRAINING_RELEASE_CONFLICT",
  "VOICE_TRAINING_FINALIZE_CONFLICT",
]);
includesAll("migration:service-role-only", migration, [
  "SECURITY DEFINER",
  "REVOKE EXECUTE",
  "FROM PUBLIC, anon, authenticated",
  "TO service_role",
  "ENABLE ROW LEVEL SECURITY",
]);

includesAll("rollback:dedicated-and-complete", rollback, [
  "purchase_voice_nest_slots_atomic",
  "reserve_voice_training_authorization_atomic",
  "release_voice_training_authorization_atomic",
  "finalize_voice_training_authorization_atomic",
  "voice_training_authorization_jobs",
  "voice_nest_purchase_requests",
  "voice_nest_price_versions",
]);
add(
  "rollback:retains-legacy-user-data",
  !/DROP\s+TABLE\s+(IF\s+EXISTS\s+)?public\.(voice_nest_slots|voice_clone_licenses|user_voices)/i.test(rollback),
  "rollback retains legacy voice tables",
);

const migrationDirectory = path.join(root, "supabase/migrations");
const misplacedRollbacks = existsSync(migrationDirectory)
  ? readdirSync(migrationDirectory).filter((name) => name.endsWith(".rollback.sql"))
  : [];
add(
  "migration-directory:no-rollback-files",
  misplacedRollbacks.length === 0,
  misplacedRollbacks.length === 0 ? "no *.rollback.sql in migrations" : `misplaced: ${misplacedRollbacks.join(", ")}`,
);

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "voice-wallet-authorization-p0",
  mode: "offline-static-only-no-network-no-paid-call",
  passed: failed.length === 0,
  summary: {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
