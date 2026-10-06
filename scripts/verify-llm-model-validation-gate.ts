import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LLM_MODEL_VALIDATION_MAX_AGE_MS,
  LlmModelValidationError,
  assertFreshLlmModelValidationEvidence,
  llmModelValidationConfigurationHash,
} from "../src/lib/llm-model-validation-gate";

const binding = {
  id: "11111111-1111-4111-8111-111111111111",
  model_name: "gpt-6-sol",
  api_endpoint: "https://token.secure-skill.com/v1/",
  billing_mode: "token",
  token_billing_enabled: true,
  input_cost_per_million: 0.6,
  output_cost_per_million: 3,
  cached_cost_per_million: 0.06,
  profit_margin: 9.090909,
  max_context_rounds: 20,
  max_context_tokens: 64000,
  max_reply_tokens: 4096,
  timeout: 120,
  deep_thinking_type: 2,
  enable_web_search: false,
  api_protocol_config: { provider: "secure_skill", protocol: "openai_chat", auth_scheme: "bearer" },
};
const secret = "fixture-secret-never-printed";
const hash = llmModelValidationConfigurationHash(binding, secret);
assert.match(hash, /^[a-f0-9]{64}$/u);
assert.notEqual(hash, llmModelValidationConfigurationHash({ ...binding, api_endpoint: "https://other.invalid/v1" }, secret));
assert.notEqual(hash, llmModelValidationConfigurationHash(binding, `${secret}-rotated`));
assert.notEqual(hash, llmModelValidationConfigurationHash({ ...binding, output_cost_per_million: 3.1 }, secret));
assert.notEqual(hash, llmModelValidationConfigurationHash({
  ...binding,
  api_protocol_config: { ...binding.api_protocol_config, protocol: "anthropic_messages" },
}, secret));

const now = Date.now();
const accepted = assertFreshLlmModelValidationEvidence(binding, secret, {
  model_id: binding.id,
  configuration_hash: hash,
  checked_at: new Date(now - 1_000).toISOString(),
}, now);
assert.equal(accepted.configurationHash, hash);
assert.throws(() => assertFreshLlmModelValidationEvidence(binding, secret, null, now), (error: unknown) => (
  error instanceof LlmModelValidationError && error.code === "TEXT_MODEL_VALIDATION_EVIDENCE_REQUIRED"
));
assert.throws(() => assertFreshLlmModelValidationEvidence(binding, `${secret}-rotated`, {
  model_id: binding.id,
  configuration_hash: hash,
  checked_at: new Date(now - 1_000).toISOString(),
}, now), /必须先完成当前配置/u);
assert.throws(() => assertFreshLlmModelValidationEvidence(binding, secret, {
  model_id: binding.id,
  configuration_hash: hash,
  checked_at: new Date(now - LLM_MODEL_VALIDATION_MAX_AGE_MS - 1).toISOString(),
}, now), (error: unknown) => (
  error instanceof LlmModelValidationError && error.code === "TEXT_MODEL_VALIDATION_EVIDENCE_EXPIRED"
));
assert.throws(() => assertFreshLlmModelValidationEvidence(binding, secret, {
  model_id: binding.id,
  configuration_hash: hash,
  checked_at: new Date(now + 60_001).toISOString(),
}, now), (error: unknown) => (
  error instanceof LlmModelValidationError && error.code === "TEXT_MODEL_VALIDATION_EVIDENCE_EXPIRED"
));

const llmTest = fs.readFileSync("src/app/api/admin/llm-test/route.ts", "utf8");
const activation = fs.readFileSync("src/app/api/admin/models/activate/route.ts", "utf8");
const unified = fs.readFileSync("src/app/api/admin/models/route.ts", "utf8");
const credentialHealth = fs.readFileSync("src/app/api/admin/credential-health/route.ts", "utf8");
const commandCenter = fs.readFileSync("src/lib/server/admin-command-center.ts", "utf8");
const migration = fs.readFileSync("supabase/migrations/20261001013000_llm_model_validation_activation_gate.sql", "utf8");
const accessMigration = fs.readFileSync("supabase/migrations/20261001014000_llm_model_user_access_activation_state.sql", "utf8");
const preservationMigration = fs.readFileSync("supabase/migrations/20261005051500_llm_model_activation_state_projection_preservation.sql", "utf8");
const localBaseline = fs.readFileSync("deploy/local/task-baseline.sql", "utf8");

assert.match(llmTest, /llm_model_validation_evidence/u);
assert.match(llmTest, /VALIDATION_EVIDENCE_PERSIST_FAILED/u);
assert.match(llmTest, /paidProbeUsed:\s*true/u);
assert.match(llmTest, /evidenceRecorded:\s*true/u);
assert.match(llmTest, /authorizeAdminCapability\(req,\s*"models\.manage"/u,
  "LLM_TEST_ROUTE_LOCAL_MODEL_MANAGEMENT_CAPABILITY_REQUIRED");
assert.match(llmTest, /requireStepUp:\s*true/u,
  "LLM_TEST_ROUTE_LOCAL_STEP_UP_REQUIRED");
assert.doesNotMatch(llmTest, /\bverifyAdminToken\b/u,
  "LLM_TEST_MUST_NOT_RELY_ON_ADMIN_ROLE_ONLY");
assert.doesNotMatch(llmTest, /evidence:\s*evidence\s*\?\s*\{[^}]*configurationHash/su,
  "LLM_TEST_RESPONSE_MUST_NOT_RETURN_CONFIGURATION_HASH");
assert.match(activation, /assertFreshLlmModelValidationEvidence/u);
assert.match(activation, /TEXT_MODEL_VALIDATION_EVIDENCE_READ_FAILED/u);
assert.match(activation, /select\("id,name,model_name,is_active,is_hidden,user_access,updated_at"\)/u);
assert.doesNotMatch(activation, /\.update\(\{ is_active: true, user_access: "available" \}\)[\s\S]{0,160}\.select\(\)/u);
assert.match(activation, /\.eq\("updated_at", model\.updated_at\)/u);
assert.doesNotMatch(activation, /\.eq\("is_active", false\)/u);
assert.doesNotMatch(activation, /return NextResponse\.json\(\{\s*model,\s*activated: true/su,
  "IDEMPOTENT_ACTIVATION_MUST_NOT_RETURN_THE_SECRET_BEARING_DATABASE_ROW");
assert.match(activation, /model:\s*\{[\s\S]*?id: model\.id,[\s\S]*?user_access: model\.user_access,[\s\S]*?updated_at: model\.updated_at/u);
assert.match(unified, /user_access:\s*PENDING_TEXT_USER_ACCESS[\s\S]{0,80}is_active:\s*false/u);
for (const [name, source] of [["credential-health", credentialHealth], ["command-center", commandCenter]] as const) {
  assert.match(source, /llm_model_validation_evidence/u, `${name}:LLM_VALIDATION_EVIDENCE_SOURCE_MISSING`);
  assert.match(source, /resolveProviderSecret/u, `${name}:SERVER_SECRET_RESOLUTION_MISSING`);
  assert.match(source, /llmModelValidationConfigurationHash/u, `${name}:CURRENT_CONFIGURATION_HASH_MISSING`);
  assert.match(source, /assertFreshLlmModelValidationEvidence/u, `${name}:SHARED_FRESHNESS_GATE_MISSING`);
  assert.match(source, /if \(!resolvedSecret\) (?:\{|continue)/u, `${name}:MISSING_SECRET_FAIL_CLOSED_MISSING`);
  assert.doesNotMatch(source, /configurationHash:\s*configurationHash/u, `${name}:CONFIGURATION_HASH_MUST_NOT_BE_RETURNED`);
  assert.doesNotMatch(source, /resolvedSecret:\s*resolvedSecret/u, `${name}:RESOLVED_SECRET_MUST_NOT_BE_RETURNED`);
}
assert.match(credentialHealth, /llmEvidenceAvailable = !llmValidations\.error/u);
assert.match(credentialHealth, /持久化验收证据暂时不可读，不能计为通过/u);
assert.match(credentialHealth, /模型配置或服务端凭据已变化，旧验收证据不能计为通过/u);
assert.match(credentialHealth, /验收证据已过期或时间异常，不能计为通过/u);
assert.match(credentialHealth, /configurationHashReturned:\s*false/u);
assert.match(commandCenter, /通路指令验收不等于业务质量/u);
assert.match(migration, /llm_model_validation_evidence/u);
assert.match(migration, /project_model_pool_configuration_atomic_before_llm_gate/u);
assert.match(migration, /md5\(coalesce\(api_key, ''\)\)/u);
assert.match(migration, /coalesce\(\(v_before -> target\.id::text ->> 'active'\)::boolean, false\)/u);
assert.match(accessMigration, /ALTER COLUMN user_access TYPE character varying\(32\)/u);
assert.match(preservationMigration, /'userAccess', user_access/u);
assert.match(preservationMigration, /v_before -> target\.id::text ->> 'userAccess'/u);
assert.match(preservationMigration, /THEN 'available'/u);
assert.match(preservationMigration, /ELSE 'pending_model_activation'/u);
assert.match(preservationMigration, /IS NOT DISTINCT FROM jsonb_build_array/u);
assert.match(localBaseline, /CREATE TABLE public\."llm_models"[\s\S]*?"user_access" character varying\(32\)/u);

console.log(JSON.stringify({
  passed: true,
  checks: 49,
  providerCalls: 0,
  databaseWrites: 0,
  credentialValuesPrinted: false,
}, null, 2));
