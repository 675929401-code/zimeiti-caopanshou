#!/usr/bin/env node
import assert from "node:assert/strict";

const origin = String(process.env.COZE_SUPABASE_URL || "").replace(/\/+$/u, "");
const serviceRoleKey = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
assert.equal(origin, "http://127.0.0.1:54321", "LOCAL_DATABASE_REQUIRED");
assert.ok(serviceRoleKey, "LOCAL_SERVICE_ROLE_REQUIRED");

const modelsUrl = new URL("/rest/v1/llm_models", origin);
modelsUrl.searchParams.set("select", "api_endpoint,api_key,model_name,is_active");
modelsUrl.searchParams.set("api_endpoint", "ilike.*token.secure-skill.com*");
modelsUrl.searchParams.set("is_active", "eq.true");
modelsUrl.searchParams.set("limit", "20");
const modelsResponse = await fetch(modelsUrl, {
  headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  cache: "no-store",
  signal: AbortSignal.timeout(10_000),
});
const configuredRows = await modelsResponse.json().catch(() => []);
assert.ok(modelsResponse.ok && Array.isArray(configuredRows), "LOCAL_MODEL_CONFIGURATION_READ_FAILED");
const credentialRow = configuredRows.find(row => String(row?.api_key || "").trim());
assert.ok(credentialRow, "SECURE_SKILL_SERVER_CREDENTIAL_NOT_CONFIGURED");

const configuredEndpoint = new URL(String(credentialRow.api_endpoint || ""));
assert.equal(configuredEndpoint.protocol, "https:", "HTTPS_PROVIDER_REQUIRED");
assert.equal(configuredEndpoint.hostname, "token.secure-skill.com", "EXACT_PROVIDER_HOST_REQUIRED");
const catalogUrl = new URL("/v1/models", configuredEndpoint.origin);
const catalogResponse = await fetch(catalogUrl, {
  headers: { Authorization: `Bearer ${String(credentialRow.api_key).trim()}` },
  cache: "no-store",
  redirect: "error",
  signal: AbortSignal.timeout(20_000),
});
const catalog = await catalogResponse.json().catch(() => ({}));
assert.equal(catalogResponse.ok, true, `PROVIDER_CATALOG_HTTP_${catalogResponse.status}`);
const ids = (Array.isArray(catalog?.data) ? catalog.data : [])
  .map(item => String(item?.id || "").trim().toLowerCase())
  .filter(Boolean);
const target = "gpt-6-sol";

console.log(JSON.stringify({
  verifier: "secure-skill-text-catalog-safe-local",
  providerHost: catalogUrl.hostname,
  authenticatedCatalogStatus: catalogResponse.status,
  catalogModelCount: ids.length,
  targetModel: target,
  targetAvailable: ids.includes(target),
  configuredCredentialCount: configuredRows.filter(row => String(row?.api_key || "").trim()).length,
  credentialValuePrinted: false,
  databaseWrites: 0,
  paidCalls: 0,
}, null, 2));
