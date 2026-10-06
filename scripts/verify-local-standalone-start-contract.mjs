import assert from "node:assert/strict";
import { createLocalStandaloneDatabaseEnv } from "./run-start.mjs";
import {
  SHARED_CONFIGURATION_TABLES,
  configurationSourceStatus,
  sharedConfigurationConnection,
} from "../src/storage/database/configuration-source.ts";

function runtime(overrides = {}) {
  return {
    localOnly: true,
    databasePort: 54322,
    databaseName: "zimeiti_local",
    supabaseUrl: "http://127.0.0.1:54321",
    serviceRoleKey: "fixture-service-role-key",
    anonKey: "fixture-anon-key",
    jwtSecret: "fixture-jwt-secret-value",
    ownerConnection: {
      host: "127.0.0.1",
      port: 54322,
      database: "zimeiti_local",
      user: "fixture_owner",
      password: "fixture-password#%:@?/中文",
    },
    ...overrides,
  };
}

const oldRemote = {
  COZE_SUPABASE_URL: "https://old.example.invalid",
  COZE_SUPABASE_SERVICE_ROLE_KEY: "old-service-key",
  COZE_SUPABASE_ANON_KEY: "old-anon-key",
  SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_SUPABASE_URL: "https://old-shared.example.invalid",
  SHARED_CONFIGURATION_SERVICE_ROLE_KEY: "old-shared-service-key",
  JWT_SECRET: "old-jwt-secret",
  DATABASE_URL: "postgresql://old.example.invalid/old",
  NODE_ENV: "development",
};
const env = createLocalStandaloneDatabaseEnv(runtime(), oldRemote);
const database = new URL(env.DATABASE_URL);
assert.equal(env.COZE_SUPABASE_URL, "http://127.0.0.1:54321");
assert.equal(env.COZE_SUPABASE_SERVICE_ROLE_KEY, "fixture-service-role-key");
assert.equal(env.COZE_SUPABASE_ANON_KEY, "fixture-anon-key");
assert.equal(env.SHARED_CONFIGURATION_ENABLED, "1");
assert.equal(env.SHARED_CONFIGURATION_SUPABASE_URL, "http://127.0.0.1:54321");
assert.equal(env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY, "fixture-service-role-key");
assert.deepEqual(sharedConfigurationConnection(env), { url: "http://127.0.0.1:54321", key: "fixture-service-role-key" });
assert.deepEqual(configurationSourceStatus(env), {
  configuration: "local-acceptance",
  businessData: "local",
  sharedTables: [...SHARED_CONFIGURATION_TABLES],
  automaticCodeDeployment: false,
});
assert.equal(env.JWT_SECRET, "fixture-jwt-secret-value");
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.port, "54322");
assert.equal(database.pathname, "/zimeiti_local");
assert.equal(env.NODE_ENV, "production");
assert.equal(env.LOCAL_ACCEPTANCE_PREVIEW, "true");
assert.equal(env.LOCAL_VALIDATION_DIST_DIR, ".next-local-acceptance");
// The production-style local launcher intentionally uses the system resolver
// for provider result downloads; a fixed DoH endpoint is not injected here.
assert.equal(env.SAFE_FETCH_PUBLIC_DNS, undefined);

for (const invalid of [
  runtime({ supabaseUrl: "https://remote.example.invalid" }),
  runtime({ databasePort: 5432 }),
  runtime({ databaseName: "wrong" }),
  runtime({ ownerConnection: { ...runtime().ownerConnection, host: "remote.example.invalid" } }),
]) {
  assert.throws(() => createLocalStandaloneDatabaseEnv(invalid, oldRemote));
}
assert.throws(() => sharedConfigurationConnection({ ...env, LOCAL_ACCEPTANCE_PREVIEW: "false" }), /SHARED_CONFIGURATION_REQUIRES_CLOUD_HTTPS/u);
assert.throws(() => sharedConfigurationConnection({ ...env, SHARED_CONFIGURATION_SUPABASE_URL: "http://localhost:54321" }), /SHARED_CONFIGURATION_REQUIRES_CLOUD_HTTPS/u);

const serialized = JSON.stringify({ argv: [], log: "LOCAL_STANDALONE_RUNTIME_CONFIG_READ_FAILED" });
for (const secret of [env.COZE_SUPABASE_SERVICE_ROLE_KEY, env.COZE_SUPABASE_ANON_KEY, env.JWT_SECRET, decodeURIComponent(database.password)]) {
  assert.ok(!serialized.includes(secret));
}

console.log("Local standalone start contract: PASS (loopback override, production mode, fail closed, no secret diagnostics)");
