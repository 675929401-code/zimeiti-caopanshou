import assert from "node:assert/strict";
import {
  LOCAL_RUNTIME_PROFILE_FORMAL_SHARED,
  LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE,
  createFormalLocalSharedDatabaseEnv,
  createLocalRuntimeDatabaseEnv,
  createLocalStandaloneDatabaseEnv,
  localRuntimeProfileStatus,
  resolveLocalRuntimeProfile,
  shouldStartLocalDataServices,
  validateFormalLocalSharedConfiguration,
} from "./run-start.mjs";
import { createLocalPreviewLaunchPlan } from "./start-local-data-preview.mjs";
import { configurationSourceStatus } from "../src/storage/database/configuration-source.ts";

function fixtureCredentialUrl(protocol, hostname, {
  port = "",
  pathname = "/",
  username = "fixture_user",
  password = "fixture_password",
  search = {},
} = {}) {
  const url = new URL(`${protocol}//${hostname}`);
  url.username = username;
  url.password = password;
  url.port = port;
  url.pathname = pathname;
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  return url.toString();
}

function runtime() {
  return {
    localOnly: true,
    databasePort: 54322,
    databaseName: "zimeiti_local",
    supabaseUrl: "http://127.0.0.1:54321",
    serviceRoleKey: "fixture-local-service-role-key",
    anonKey: "fixture-local-anon-key",
    jwtSecret: "fixture-local-jwt-secret",
    ownerConnection: {
      host: "127.0.0.1",
      port: 54322,
      database: "zimeiti_local",
      user: "fixture_owner",
      password: "fixture-local-password",
    },
  };
}

const formalBase = {
  LOCAL_RUNTIME_PROFILE: LOCAL_RUNTIME_PROFILE_FORMAL_SHARED,
  SHARED_CONFIGURATION_ENABLED: "1",
  SHARED_CONFIGURATION_ID: "production-agents-v1",
  SHARED_CONFIGURATION_SUPABASE_URL: "https://shared.example.invalid",
  SHARED_CONFIGURATION_SERVICE_ROLE_KEY: "fixture-remote-service-role-key",
  COZE_SUPABASE_URL: "https://business.example.invalid",
  COZE_SUPABASE_SERVICE_ROLE_KEY: "fixture-cloud-service-role-key",
  COZE_SUPABASE_ANON_KEY: "fixture-cloud-anon-key",
  JWT_SECRET: "fixture-cloud-jwt-secret",
  DATABASE_URL: fixtureCredentialUrl("postgresql:", "database.example.invalid", {
    port: "5432",
    pathname: "/cloud_business",
    username: "cloud_user",
    password: "cloud_password",
    search: { sslmode: "verify-full" },
  }),
  PUBLISHING_EXTERNAL_EXECUTION_ENABLED: "true",
};

assert.equal(resolveLocalRuntimeProfile({}), LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(resolveLocalRuntimeProfile({ LOCAL_RUNTIME_PROFILE: "local-acceptance" }), LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(resolveLocalRuntimeProfile(formalBase), LOCAL_RUNTIME_PROFILE_FORMAL_SHARED);
assert.throws(() => resolveLocalRuntimeProfile({ LOCAL_RUNTIME_PROFILE: "formal" }), /LOCAL_RUNTIME_PROFILE_INVALID/u);
assert.equal(shouldStartLocalDataServices({}), true);
assert.equal(shouldStartLocalDataServices(formalBase), false);

const formal = createFormalLocalSharedDatabaseEnv({ localOnly: false }, formalBase);
assert.deepEqual(createLocalRuntimeDatabaseEnv(runtime(), formalBase), formal);
assert.equal(formal.LOCAL_RUNTIME_PROFILE, LOCAL_RUNTIME_PROFILE_FORMAL_SHARED);
assert.equal(formal.LOCAL_ACCEPTANCE_PREVIEW, "false");
assert.equal(formal.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, "true");
assert.equal(formal.LOCAL_VALIDATION_DIST_DIR, ".next");
assert.equal(formal.COZE_SUPABASE_URL, "https://business.example.invalid/");
assert.equal(formal.COZE_SUPABASE_SERVICE_ROLE_KEY, formalBase.COZE_SUPABASE_SERVICE_ROLE_KEY);
assert.equal(formal.COZE_SUPABASE_ANON_KEY, formalBase.COZE_SUPABASE_ANON_KEY);
assert.equal(formal.JWT_SECRET, formalBase.JWT_SECRET);
assert.equal(new URL(formal.DATABASE_URL).hostname, "database.example.invalid");
assert.equal(new URL(formal.DATABASE_URL).searchParams.get("sslmode"), "verify-full");
assert.equal(formal.SHARED_CONFIGURATION_ENABLED, "1");
assert.equal(formal.SHARED_CONFIGURATION_ID, formalBase.SHARED_CONFIGURATION_ID);
assert.equal(formal.SHARED_CONFIGURATION_SUPABASE_URL, "https://shared.example.invalid/");
assert.equal(formal.SHARED_CONFIGURATION_SERVICE_ROLE_KEY, formalBase.SHARED_CONFIGURATION_SERVICE_ROLE_KEY);
assert.equal(formal.MEDIA_QUEUE_WORKER_PROCESS, "0");
assert.equal(formal.DIGITAL_VIDEO_QUEUE_WORKER, "0");
assert.equal(formal.DIGITAL_HUMAN_LONG_WORKER, "0");
assert.deepEqual(configurationSourceStatus(formal), {
  configuration: "shared-cloud",
  businessData: "cloud",
  sharedTables: configurationSourceStatus(formal).sharedTables,
  automaticCodeDeployment: false,
});

const status = localRuntimeProfileStatus(formal);
assert.deepEqual(status, {
  runtimeProfile: "formal-local-shared",
  businessData: "shared-cloud",
  authentication: "shared-cloud",
  configuration: "shared-cloud",
  sharedConfigurationEnabled: true,
  sharedConfigurationIdConfigured: true,
});
const serializedStatus = JSON.stringify(status);
for (const secretOrIdentifier of [
  formal.SHARED_CONFIGURATION_SUPABASE_URL,
  formal.SHARED_CONFIGURATION_SERVICE_ROLE_KEY,
  formal.SHARED_CONFIGURATION_ID,
  formal.DATABASE_URL,
  formal.COZE_SUPABASE_URL,
  formal.COZE_SUPABASE_SERVICE_ROLE_KEY,
  formal.COZE_SUPABASE_ANON_KEY,
  formal.JWT_SECRET,
]) assert.ok(!serializedStatus.includes(secretOrIdentifier));
const serializedSourceStatus = JSON.stringify(configurationSourceStatus(formal));
for (const secretOrIdentifier of [
  formalBase.SHARED_CONFIGURATION_ID,
  formalBase.SHARED_CONFIGURATION_SUPABASE_URL,
  formalBase.SHARED_CONFIGURATION_SERVICE_ROLE_KEY,
  formalBase.COZE_SUPABASE_URL,
  formalBase.COZE_SUPABASE_SERVICE_ROLE_KEY,
  formalBase.COZE_SUPABASE_ANON_KEY,
  formalBase.JWT_SECRET,
  formalBase.DATABASE_URL,
]) {
  assert.ok(!serializedSourceStatus.includes(secretOrIdentifier));
}
assert.throws(() => configurationSourceStatus({
  ...formal,
  SHARED_CONFIGURATION_SUPABASE_URL: "not-a-url",
}), /SHARED_CONFIGURATION_URL_INVALID/u);

const invalidFormalConfigurations = [
  [{ ...formalBase, SHARED_CONFIGURATION_ENABLED: "0" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_DISABLED/u],
  [{ ...formalBase, SHARED_CONFIGURATION_ID: "" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_ID_REQUIRED/u],
  [{ ...formalBase, SHARED_CONFIGURATION_ID: "bad id" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_ID_INVALID/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_URL_REQUIRED/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "not-a-url" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_URL_INVALID/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "http://shared.example.invalid" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "https://127.0.0.1" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "https://0.0.0.0" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "https://service.localhost" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: "https://[::ffff:127.0.0.1]" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SUPABASE_URL: fixtureCredentialUrl("https:", "shared.example.invalid") }, /FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, SHARED_CONFIGURATION_SERVICE_ROLE_KEY: "" }, /FORMAL_LOCAL_SHARED_CONFIGURATION_KEY_REQUIRED/u],
  [{ ...formalBase, COZE_SUPABASE_URL: "" }, /FORMAL_LOCAL_CLOUD_BUSINESS_URL_REQUIRED/u],
  [{ ...formalBase, COZE_SUPABASE_URL: "not-a-url" }, /FORMAL_LOCAL_CLOUD_BUSINESS_URL_INVALID/u],
  [{ ...formalBase, COZE_SUPABASE_URL: "http://business.example.invalid" }, /FORMAL_LOCAL_CLOUD_BUSINESS_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, COZE_SUPABASE_URL: "https://127.0.0.1" }, /FORMAL_LOCAL_CLOUD_BUSINESS_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, COZE_SUPABASE_URL: "https://0.0.0.0" }, /FORMAL_LOCAL_CLOUD_BUSINESS_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, COZE_SUPABASE_URL: fixtureCredentialUrl("https:", "business.example.invalid") }, /FORMAL_LOCAL_CLOUD_BUSINESS_REQUIRES_REMOTE_HTTPS/u],
  [{ ...formalBase, COZE_SUPABASE_SERVICE_ROLE_KEY: "" }, /FORMAL_LOCAL_CLOUD_SERVICE_ROLE_KEY_REQUIRED/u],
  [{ ...formalBase, COZE_SUPABASE_ANON_KEY: "" }, /FORMAL_LOCAL_CLOUD_ANON_KEY_REQUIRED/u],
  [{ ...formalBase, JWT_SECRET: "" }, /FORMAL_LOCAL_CLOUD_JWT_SECRET_REQUIRED/u],
  [{ ...formalBase, DATABASE_URL: "" }, /FORMAL_LOCAL_CLOUD_DATABASE_URL_REQUIRED/u],
  [{ ...formalBase, DATABASE_URL: "not-a-url" }, /FORMAL_LOCAL_CLOUD_DATABASE_URL_INVALID/u],
  [{ ...formalBase, DATABASE_URL: "http://database.example.invalid/cloud" }, /FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS/u],
  [{ ...formalBase, DATABASE_URL: fixtureCredentialUrl("postgresql:", "127.0.0.1", { port: "5432", pathname: "/cloud", search: { sslmode: "require" } }) }, /FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS/u],
  [{ ...formalBase, DATABASE_URL: fixtureCredentialUrl("postgresql:", "0.0.0.0", { port: "5432", pathname: "/cloud", search: { sslmode: "require" } }) }, /FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS/u],
  [{ ...formalBase, DATABASE_URL: fixtureCredentialUrl("postgresql:", "database.example.invalid", { port: "5432", pathname: "/cloud" }) }, /FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS/u],
  [{ ...formalBase, DATABASE_URL: fixtureCredentialUrl("postgresql:", "database.example.invalid", { port: "5432", pathname: "/cloud", search: { sslmode: "disable" } }) }, /FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS/u],
];
for (const [input, expected] of invalidFormalConfigurations) {
  assert.throws(() => validateFormalLocalSharedConfiguration(input), expected);
  assert.throws(() => createFormalLocalSharedDatabaseEnv(runtime(), input), expected);
  assert.throws(() => createLocalRuntimeDatabaseEnv(runtime(), input), expected);
}

const acceptance = createLocalStandaloneDatabaseEnv(runtime(), formalBase);
assert.deepEqual(createLocalRuntimeDatabaseEnv(runtime(), {}), createLocalStandaloneDatabaseEnv(runtime(), {}));
assert.equal(acceptance.LOCAL_RUNTIME_PROFILE, LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(acceptance.LOCAL_ACCEPTANCE_PREVIEW, "true");
assert.equal(acceptance.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, "false");
assert.equal(acceptance.SHARED_CONFIGURATION_ID, LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(acceptance.SHARED_CONFIGURATION_SUPABASE_URL, "http://127.0.0.1:54321");
assert.equal(acceptance.SHARED_CONFIGURATION_SERVICE_ROLE_KEY, runtime().serviceRoleKey);
assert.equal(acceptance.COZE_SUPABASE_URL, "http://127.0.0.1:54321");
assert.equal(new URL(acceptance.DATABASE_URL).hostname, "127.0.0.1");
assert.equal(acceptance.MEDIA_QUEUE_WORKER_PROCESS, "1");
assert.equal(acceptance.DIGITAL_VIDEO_QUEUE_WORKER, "1");
assert.equal(acceptance.DIGITAL_HUMAN_LONG_WORKER, "1");
for (const cloudValue of [
  formalBase.SHARED_CONFIGURATION_ID,
  formalBase.SHARED_CONFIGURATION_SUPABASE_URL,
  formalBase.SHARED_CONFIGURATION_SERVICE_ROLE_KEY,
  formalBase.COZE_SUPABASE_URL,
  formalBase.COZE_SUPABASE_SERVICE_ROLE_KEY,
  formalBase.COZE_SUPABASE_ANON_KEY,
  formalBase.JWT_SECRET,
  formalBase.DATABASE_URL,
]) {
  assert.ok(!JSON.stringify(acceptance).includes(cloudValue));
}

const developmentAcceptance = createLocalPreviewLaunchPlan(runtime(), formalBase, {
  LOCAL_RUNTIME_PROFILE: LOCAL_RUNTIME_PROFILE_FORMAL_SHARED,
  SHARED_CONFIGURATION_ID: "must-not-survive",
}, "C:\\runtime\\node.exe");
assert.equal(developmentAcceptance.env.LOCAL_RUNTIME_PROFILE, LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(developmentAcceptance.env.SHARED_CONFIGURATION_ID, LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.equal(developmentAcceptance.env.SHARED_CONFIGURATION_SUPABASE_URL, "http://127.0.0.1:54321");
const acceptance5000 = createLocalPreviewLaunchPlan(runtime(), formalBase, {}, "C:\\runtime\\node.exe", 5000);
assert.equal(acceptance5000.env.PORT, "5000");
assert.equal(acceptance5000.env.LOCAL_RUNTIME_PROFILE, LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE);
assert.deepEqual(acceptance5000.args.slice(-2), ["--port", "5000"]);

console.log(JSON.stringify({
  passed: true,
  profiles: [LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE, LOCAL_RUNTIME_PROFILE_FORMAL_SHARED],
  rejectedFormalConfigurations: invalidFormalConfigurations.length,
  externalConnections: 0,
  childProcessesStarted: 0,
}));
