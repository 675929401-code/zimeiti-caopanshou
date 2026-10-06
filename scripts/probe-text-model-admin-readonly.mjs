import assert from 'node:assert/strict';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
assert.equal(origin, 'http://127.0.0.1:5000');
assert.ok(token);

const response = await fetch(`${origin}/api/admin/models`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
const payload = await response.json();
assert.equal(response.ok, true, String(payload?.error || 'model list unavailable'));
const textModels = (Array.isArray(payload.models) ? payload.models : [])
  .filter(model => model?.model_type === 'text');
const safeInventory = textModels.map(model => ({
  id: String(model.id || ''),
  name: String(model.name || ''),
  model_name: String(model.model_name || ''),
  provider: String(model.provider || ''),
  endpoint_host: (() => { try { return new URL(String(model.api_endpoint || '')).hostname; } catch { return ''; } })(),
  api_key_configured: model.api_key_configured === true,
  token_billing_enabled: model.token_billing_enabled === true,
  input_cost_per_million: model.input_cost_per_million,
  output_cost_per_million: model.output_cost_per_million,
  cached_cost_per_million: model.cached_cost_per_million,
  profit_margin: model.profit_margin,
  max_context_tokens: model.max_context_tokens,
  is_active: model.is_active !== false,
  is_hidden: model.is_hidden === true,
}));
const target = textModels
  .filter(model => model?.model_type === 'text' && String(model?.model_name || '').toLowerCase() === 'gpt-6-sol')
  .map(model => ({
    id: String(model.id || ''),
    name: String(model.name || ''),
    model_name: String(model.model_name || ''),
    endpoint_host: (() => { try { return new URL(String(model.api_endpoint || '')).hostname; } catch { return ''; } })(),
    api_key_configured: model.api_key_configured === true,
    token_billing_enabled: model.token_billing_enabled === true,
    input_cost_per_million: model.input_cost_per_million,
    output_cost_per_million: model.output_cost_per_million,
    cached_cost_per_million: model.cached_cost_per_million,
    profit_margin: model.profit_margin,
    max_context_tokens: model.max_context_tokens,
    deep_thinking_type: model.deep_thinking_type,
    is_active: model.is_active !== false,
    is_hidden: model.is_hidden === true,
  }));

console.log(JSON.stringify({
  verifier: 'text-model-admin-readonly',
  text_model_count: safeInventory.length,
  safe_inventory: safeInventory,
  target_count: target.length,
  target,
  databaseWrites: 0,
  providerCalls: 0,
  paidCalls: 0,
}, null, 2));
