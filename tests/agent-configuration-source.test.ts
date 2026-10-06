import test from 'node:test';
import assert from 'node:assert/strict';
import { routeConfigurationTables, sharedConfigurationConnection, configurationSourceStatus } from '../src/storage/database/configuration-source';
import { canonicalAgentModelBinding } from '../src/lib/agent-model-binding';

test('configuration reads and writes use cloud; users, billing and RPCs retain business database', () => {
  const calls: string[] = [];
  const client = (name: string) => ({ name, from(table: string) { return { update() { calls.push(`${name}:${table}:update`); }, select() { calls.push(`${name}:${table}:select`); } }; }, rpc() { return this.name; } });
  const routed = routeConfigurationTables(client('business'), client('cloud'));
  for (const table of ['agents', 'llm_models', 'categories', 'prompt_versions', 'agent_skills']) { routed.from(table).select(); routed.from(table).update(); }
  for (const table of ['users', 'messages', 'video_tasks', 'video_models']) routed.from(table).select();
  assert.equal(calls.filter(c => c.startsWith('cloud:')).length, 10);
  assert.equal(calls.filter(c => c.startsWith('business:')).length, 4);
  assert.equal(routed.rpc(), 'business');
});

test('only avatar bucket follows shared configuration storage', () => {
  const business = { storage: { from: (bucket: string) => `business:${bucket}` } };
  const cloud = { storage: { from: (bucket: string) => `cloud:${bucket}` } };
  const routed = routeConfigurationTables(business, cloud);
  assert.equal(routed.storage.from('avatars'), 'cloud:avatars');
  assert.equal(routed.storage.from('user-videos'), 'business:user-videos');
});

test('cloud selection never silently falls back when credentials are missing or source is local', () => {
  assert.equal(sharedConfigurationConnection({}), null);
  assert.throws(() => sharedConfigurationConnection({ SHARED_CONFIGURATION_ENABLED: '1' }), /CREDENTIALS_MISSING/);
  assert.throws(() => sharedConfigurationConnection({ SHARED_CONFIGURATION_ENABLED: '1', SHARED_CONFIGURATION_SUPABASE_URL: 'http://127.0.0.1:54321', SHARED_CONFIGURATION_SERVICE_ROLE_KEY: 'test-only' }), /CLOUD_HTTPS/);
  const status = configurationSourceStatus({ SHARED_CONFIGURATION_ENABLED: '1', COZE_SUPABASE_URL: 'http://127.0.0.1:54321' });
  assert.equal(status.configuration, 'shared-cloud');
  assert.equal(status.businessData, 'local');
  assert.equal(JSON.stringify(status).includes('test-only'), false);
});

test('local acceptance reports its loopback configuration source without exposing credentials', () => {
  const status = configurationSourceStatus({
    SHARED_CONFIGURATION_ENABLED: '1',
    SHARED_CONFIGURATION_SUPABASE_URL: 'http://127.0.0.1:54321',
    SHARED_CONFIGURATION_SERVICE_ROLE_KEY: 'test-only',
    COZE_SUPABASE_URL: 'http://127.0.0.1:54321',
    LOCAL_ACCEPTANCE_PREVIEW: 'true',
  });
  assert.equal(status.configuration, 'local-acceptance');
  assert.equal(status.businessData, 'local');
  assert.equal(JSON.stringify(status).includes('test-only'), false);
});

test('agent binding uses canonical model name and rejects missing, hidden, media or uncredentialed models', () => {
  const model = { id: 'model-a', model_name: 'claude-test', is_active: true, api_key: 'env://TEST_KEY', category: 'text' };
  assert.deepEqual(canonicalAgentModelBinding('model-a', model), { model_id: 'model-a', model: 'claude-test' });
  assert.throws(() => canonicalAgentModelBinding('missing', model));
  assert.throws(() => canonicalAgentModelBinding('', null));
  for (const patch of [{ is_active: false }, { is_hidden: true }, { user_access: 'hidden' }, { model_name: 'glm-image' }, { api_key: '' }]) {
    assert.throws(() => canonicalAgentModelBinding('model-a', { ...model, ...patch }));
  }
});
