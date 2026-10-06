import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const nativeRequire = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../src/commerce/server/configuration-platform.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'configuration-platform.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const state = { release: null, releaseQueries: 0, networkCalls: 0 };
const database = {
  from(table) {
    assert.equal(table, 'commerce_config_releases');
    return {
      select() { return this; },
      eq() { return this; },
      limit() { return this; },
      async maybeSingle() {
        state.releaseQueries += 1;
        return { data: state.release, error: null };
      },
    };
  },
};
const loadedModule = { exports: {} };
const context = vm.createContext({
  module: loadedModule,
  exports: loadedModule.exports,
  console,
  fetch() {
    state.networkCalls += 1;
    throw new Error('zero-network regression must not call fetch');
  },
  require(specifier) {
    if (specifier === 'node:crypto') return nativeRequire(specifier);
    if (specifier === '@/storage/database/supabase-client') return { getSupabaseAdminClient: () => database };
    if (specifier === '@/storage/database/configuration-source') return { sharedConfigurationEnabled: () => true };
    if (specifier === './commerce-curated-model-profiles') return { isCuratedConfigurationSelectable: () => true };
    throw new Error(`Unexpected dependency: ${specifier}`);
  },
});
vm.runInContext(compiled, context, { filename: 'configuration-platform.ts' });

const platform = loadedModule.exports;
const manifest = {
  schema: 'commerce-config/v1',
  cardVersionIds: [],
  promptVersionIds: [],
  knowledgeDocumentIds: [],
  operationRouteIds: [],
  defaultModels: {},
};
state.release = {
  id: '11111111-1111-4111-8111-111111111111',
  release_version: 1,
  manifest,
  manifest_sha256: platform.manifestHash(manifest),
  published_at: '2026-09-23T00:00:00.000Z',
  validation_result: { ok: true },
};

const loaded = await platform.primePublishedCommerceConfiguration({ required: true });
assert.equal(loaded.releaseId, state.release.id);
assert.equal(state.releaseQueries, 1);

state.release = null;
await assert.rejects(
  platform.primePublishedCommerceConfiguration({ force: true, required: true }),
  /COMMERCE_CONFIG_RELEASE_MISSING/u,
);
assert.equal(platform.currentPublishedCommerceConfiguration(), null, 'missing current release must evict the previously cached release');
assert.deepEqual(
  { loaded: platform.commerceConfigurationStatus().loaded, error: platform.commerceConfigurationStatus().error },
  { loaded: false, error: 'COMMERCE_CONFIG_RELEASE_MISSING' },
);

await assert.rejects(
  platform.primePublishedCommerceConfiguration({ required: true }),
  /COMMERCE_CONFIG_RELEASE_MISSING/u,
  'a required read inside the TTL must fail again instead of returning the stale release',
);
assert.equal(state.releaseQueries, 3, 'the errored cache entry must not satisfy the fast-cache path');
assert.equal(state.networkCalls, 0);

console.log(JSON.stringify({
  suite: 'commerce-configuration-cache-fail-closed',
  passed: 8,
  releaseQueries: state.releaseQueries,
  networkCalls: state.networkCalls,
  providerCalls: 0,
  walletWrites: 0,
  databaseWrites: 0,
}));
