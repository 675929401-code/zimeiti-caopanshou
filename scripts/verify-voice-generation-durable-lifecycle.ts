import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Check = { name: string; passed: boolean; detail: string };

const root = process.cwd();
const checks: Check[] = [];

function add(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

function source(relativePath: string) {
  const absolutePath = path.join(root, relativePath);
  const present = existsSync(absolutePath);
  add(`file:${relativePath}`, present, present ? "present" : "missing");
  return present ? readFileSync(absolutePath, "utf8") : "";
}

function includesAll(name: string, text: string, tokens: string[]) {
  const missing = tokens.filter((token) => !text.includes(token));
  add(name, missing.length === 0, missing.length === 0 ? "all contract tokens present" : `missing: ${missing.join(", ")}`);
}

function excludesAll(name: string, text: string, tokens: string[]) {
  const found = tokens.filter((token) => text.includes(token));
  add(name, found.length === 0, found.length === 0 ? "forbidden tokens absent" : `found: ${found.join(", ")}`);
}

function count(name: string, text: string, pattern: RegExp, expected: number) {
  const matches = text.match(pattern)?.length || 0;
  add(name, matches === expected, `expected=${expected}; actual=${matches}`);
}

function ordered(name: string, text: string, tokens: string[]) {
  const indexes: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const index = text.indexOf(token, cursor);
    indexes.push(index);
    if (index >= 0) cursor = index + token.length;
  }
  const passed = indexes.every((index) => index >= 0)
    && indexes.every((index, position) => position === 0 || index > indexes[position - 1]);
  add(name, passed, `indexes=${indexes.join(",")}`);
}

function functionSlice(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, Math.max(startIndex + start.length, 0));
  return startIndex >= 0 && endIndex > startIndex ? text.slice(startIndex, endIndex) : "";
}

const migrationPath = "supabase/migrations/20260827120000_voice_generation_durable_lifecycle.sql";
const rollbackPath = "supabase/rollbacks/20260827120000_voice_generation_durable_lifecycle.rollback.sql";
const lifecyclePath = "src/lib/voice-generation-lifecycle.ts";
const statusPath = "src/app/api/voice/generation-status/route.ts";
const routePath = "src/app/api/voice/tts/route.ts";

const migration = source(migrationPath);
const rollback = source(rollbackPath);
const lifecycle = source(lifecyclePath);
const statusRoute = source(statusPath);
const route = source(routePath);

ordered("migration:explicit-transaction", migration, ["BEGIN;", "COMMIT;"]);
count("migration:balanced-dollar-quotes", migration, /\$\$/gu, 8);
excludesAll("migration:forward-is-non-destructive", migration, [
  "DROP TABLE",
  "DROP FUNCTION",
  "CASCADE",
]);
includesAll("migration:wallet-preflight-and-durable-table", migration, [
  "wallet_operations",
  "wallet_ledger_entries",
  "apply_wallet_operation_atomic(text,text,text,numeric,text,jsonb)",
  "CREATE TABLE IF NOT EXISTS public.voice_generation_requests",
  "VOICE_LIFECYCLE_WALLET_MIGRATION_REQUIRED",
]);
includesAll("migration:identity-and-state-contract", migration, [
  "UNIQUE (user_id, request_id)",
  "UNIQUE (user_id, client_request_id, phase)",
  "phase IN ('seed-audio', 'mix', 'dual', 'tts')",
  "state IN ('submitting', 'completed', 'refunded', 'failed_unknown', 'recovery_required')",
  "payload_fingerprint ~ '^[0-9a-f]{64}$'",
]);
includesAll("migration:atomic-begin-and-replay", migration, [
  "CREATE OR REPLACE FUNCTION public.begin_voice_generation_atomic",
  "FOR UPDATE",
  "VOICE_LIFECYCLE_IDEMPOTENCY_CONFLICT",
  "VOICE_REQUEST_IN_PROGRESS_OR_UNKNOWN",
  "already_fulfilled",
  "v_request.state = 'completed'",
  "public.apply_wallet_operation_atomic(",
  "'credit_charge'",
]);
ordered("migration:request-created-before-wallet-charge-in-one-rpc", migration, [
  "INSERT INTO public.voice_generation_requests",
  "public.apply_wallet_operation_atomic(",
  "UPDATE public.voice_generation_requests",
]);
includesAll("migration:atomic-finalize", migration, [
  "CREATE OR REPLACE FUNCTION public.finalize_voice_generation_atomic",
  "VOICE_LIFECYCLE_RESULT_CONFLICT",
  "SET state = 'completed'",
  "response = p_response",
  "completed_at = now()",
]);
includesAll("migration:atomic-partial-and-terminal-refund", migration, [
  "CREATE OR REPLACE FUNCTION public.refund_voice_generation_atomic",
  "refund_scopes -> v_scope",
  "VOICE_LIFECYCLE_REFUND_CONFLICT",
  "VOICE_LIFECYCLE_TERMINAL_REFUND_INCOMPLETE",
  "'credit_refund'",
  "v_next_state := CASE WHEN coalesce(p_terminal, true) THEN 'refunded'",
]);
includesAll("migration:service-role-only-and-rls", migration, [
  "ENABLE ROW LEVEL SECURITY",
  "REVOKE ALL ON public.voice_generation_requests FROM PUBLIC, anon, authenticated",
  "REVOKE EXECUTE ON FUNCTION public.begin_voice_generation_atomic",
  "REVOKE EXECUTE ON FUNCTION public.finalize_voice_generation_atomic",
  "REVOKE EXECUTE ON FUNCTION public.refund_voice_generation_atomic",
  "TO service_role",
]);
excludesAll("migration:no-direct-users-balance-mutation", migration, [
  "UPDATE public.users",
  "INSERT INTO public.credit_transactions",
]);

includesAll("rollback:dedicated-and-complete", rollback, [
  "DROP FUNCTION IF EXISTS public.refund_voice_generation_atomic",
  "DROP FUNCTION IF EXISTS public.finalize_voice_generation_atomic",
  "DROP FUNCTION IF EXISTS public.begin_voice_generation_atomic",
  "DROP TABLE IF EXISTS public.voice_generation_requests",
]);
ordered("rollback:explicit-transaction", rollback, ["BEGIN;", "COMMIT;"]);
excludesAll("rollback:no-cascade", rollback, ["CASCADE"]);
const migrationDirectory = path.join(root, "supabase/migrations");
const misplacedRollbacks = existsSync(migrationDirectory)
  ? readdirSync(migrationDirectory).filter((name) => name.endsWith(".rollback.sql"))
  : [];
add("migration-directory:no-rollback-files", misplacedRollbacks.length === 0, misplacedRollbacks.length === 0 ? "clean" : misplacedRollbacks.join(", "));

includesAll("service:three-rpc-adapters-and-fail-closed", lifecycle, [
  'db.rpc("begin_voice_generation_atomic"',
  'db.rpc("finalize_voice_generation_atomic"',
  'db.rpc("refund_voice_generation_atomic"',
  "VOICE_LIFECYCLE_MIGRATION_NOT_READY",
  "VOICE_LIFECYCLE_FINALIZE_UNCONFIRMED",
  "VOICE_LIFECYCLE_REFUND_UNCONFIRMED",
]);
includesAll("service:status-is-user-scoped", lifecycle, [
  '.from("voice_generation_requests")',
  '.eq("user_id", input.userId)',
  '.eq("request_id", input.requestId)',
  '.eq("client_request_id", input.clientRequestId).eq("phase", input.phase)',
]);
includesAll("status-route:authenticated-query-and-safe-output", statusRoute, [
  "withAuth(request",
  "userId: user.id",
  "VOICE_LIFECYCLE_STATUS_INPUT_INVALID",
  "VOICE_LIFECYCLE_REQUEST_NOT_FOUND",
  'record.state === "completed" ? user.role === \'admin\' ? record.response : publicVoiceResponse(record.response) : null',
]);
excludesAll("status-route:no-sensitive-task-fields", statusRoute, [
  "payloadFingerprint:",
  "billingIdempotencyKey:",
  "priceSnapshot:",
  "walletOperationId:",
]);

includesAll("route:durable-helpers-and-stable-keys", route, [
  "beginVoiceGenerationAtomic",
  "finalizeVoiceGenerationAtomic",
  "refundVoiceGenerationAtomic",
  "buildVoicePayloadFingerprint",
  "voice:${operation.clientRequestId}:${operation.phase}:charge",
  "voice:${lifecycle.clientRequestId}:${lifecycle.phase}:${scope}:refund",
]);
count("route:four-phase-fingerprints", route, /buildVoicePayloadFingerprint\('(seed-audio|mix|dual|tts)'/gu, 4);
count("route:four-atomic-begins", route, /const deductResult = await deductCredits\(/gu, 4);
count("route:four-completed-finalizations", route, /finalizedResponse = await finalizeVoiceLifecycle\(/gu, 4);
const deduct = functionSlice(route, "async function deductCredits", "async function refundCredits");
count("route:one-unified-atomic-begin", deduct, /await beginVoiceGenerationAtomic\(\{/gu, 1);
includesAll("route:unified-zero-cost-exemption", deduct, [
  "const effectiveExemption = quotedAmount <= 0",
  "const chargeCredits = effectiveExemption ? 0 : quotedAmount",
  "billingExempt: effectiveExemption",
  "userRole,",
]);
includesAll("route:replay-and-fail-closed", route, [
  "replayCompletedVoiceResponse",
  "upstreamSubmitted: false",
  "creditsChargedThisAttempt: 0",
]);
excludesAll("route:no-legacy-direct-wallet-or-legacy-idempotency", route, [
  ".from('users').update(",
  ".from(\"users\").update(",
  "alreadyProcessedResponse",
  "Math.floor(creditsToCharge / 2)",
]);

const seed = functionSlice(route, "async function handleSeedAudio", "async function handleMixSynthesize");
const mix = functionSlice(route, "async function handleMixSynthesize", "async function handleDualTTS");
const dual = functionSlice(route, "async function handleDualTTS", "async function handleTTS");
const tts = route.slice(route.indexOf("async function handleTTS"));

for (const [name, text, phase, providerToken] of [
  ["seed", seed, "phase: 'seed-audio'", "generateAudio({"],
  ["mix", mix, "phase: 'mix'", "synthesizeMixSpeech({"],
  ["dual", dual, "phase: 'dual'", "await Promise.all(["],
  ["tts", tts, "phase: 'tts'", "synthesizeSpeech({"],
] as const) {
  includesAll(`route:${name}-complete-lifecycle`, text, [
    phase,
    "deductCredits(",
    "historySnapshot: createVoiceHistorySnapshot(",
    "replayCompletedVoiceResponse",
    "persistGeneratedAudio(",
    "finalizeVoiceLifecycle(",
    "refundCredits(",
    "requestId:",
    "clientRequestId",
  ]);
  ordered(`route:${name}-provider-after-claim-and-before-persistence`, text, [
    "deductCredits(",
    providerToken,
    "persistGeneratedAudio(",
    "finalizeVoiceLifecycle(",
  ]);
}

excludesAll("route:no-single-instance-generation-history-write", route, [
  "addGeneration(",
  "VOICE_HISTORY_PERSIST_FAILED",
]);
includesAll("route:durable-history-snapshot-at-atomic-begin", route, [
  "history_snapshot: operation.historySnapshot",
  "const generationId = lifecycle.requestId",
]);

includesAll("route:dual-exact-partial-refund", dual, [
  "const failedQuote = hasError1 ? quote1.costBreakdown : quote2.costBreakdown",
  "failedRefundCredits",
  "false,",
  "Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits)",
]);
includesAll("route:normal-tts-preserves-user-pitch", tts, [
  "const finalPitch = pitchRate ?? bodyPitch ?? 0",
  "pitch: finalPitch ?? 0",
]);
add("route:normal-tts-has-no-pitch-reset", !/let\s+finalPitch\s*=\s*0/u.test(tts), "user pitch is not shadowed after claim");

const failed = checks.filter((check) => !check.passed);
const report = {
  verifier: "voice-generation-durable-lifecycle",
  mode: "offline-static-only-no-network-no-paid-call",
  passed: failed.length === 0,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
