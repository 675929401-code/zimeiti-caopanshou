import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveVoiceSqlitePath } from "../src/lib/voice-studio/database-path";

const root = process.cwd();
const localFallback = resolveVoiceSqlitePath({}, root);
assert.equal(localFallback, path.join(root, "voice-platform", "prisma", "dev.db"));
assert.throws(() => resolveVoiceSqlitePath({ NODE_ENV: "production" }, root), /required in production/u);
assert.throws(
  () => resolveVoiceSqlitePath({ NODE_ENV: "production", VOICE_SQLITE_PATH: "relative.db" }, root),
  /must be absolute/u,
);
const productionPath = path.resolve(root, ".runtime-fixture", "voice.db");
assert.equal(
  resolveVoiceSqlitePath({ NODE_ENV: "production", VOICE_SQLITE_PATH: productionPath }, root),
  productionPath,
);

const dbSource = readFileSync(path.join(root, "src/lib/voice-studio/db.ts"), "utf8");
const pricingSource = readFileSync(path.join(root, "src/lib/vs/pricing.ts"), "utf8");
for (const [name, source] of [["db", dbSource], ["pricing", pricingSource]] as const) {
  assert.match(source, /resolveVoiceSqlitePath/u, `${name} must use the shared path resolver`);
  assert.doesNotMatch(source, /path\.join\(process\.cwd\(\),\s*['"]voice-platform/u, `${name} hardcodes release-local SQLite`);
  assert.match(source, /fileMustExist:\s*process\.env\.NODE_ENV === ['"]production['"]/u, `${name} may create an empty production DB`);
}

const pm2 = readFileSync(path.join(root, "deploy/pm2/ecosystem.vnext.config.cjs"), "utf8");
for (const marker of ["shared\", \"voice\", \"voice.db", "VOICE_SQLITE_PATH", "VOICE_DATABASE_URL", "DATABASE_URL: voiceDatabaseUrl", "COMMERCE_DATA_DIR", "COMMERCE_GATEWAY_KEY_FILE", "commerce-agent", "main-gateway.key"]) {
  assert.ok(pm2.includes(marker), `PM2 data contract is missing: ${marker}`);
}
const deploy = readFileSync(path.join(root, "scripts/deploy-artifact-vnext.sh"), "utf8");
const normalizedDeploy = deploy.replace(/\\\r?\n\s*/gu, " ");
assert.match(deploy, /VOICE_DATABASE_PATH/u, "deploy data gate is missing Voice DB identity");
assert.match(
  normalizedDeploy,
  /\[\[[^\n]*-f\s+"\$VOICE_DATABASE_PATH"[^\n]*!\s+-L\s+"\$VOICE_DATABASE_PATH"[^\n]*-s\s+"\$VOICE_DATABASE_PATH"[^\n]*\]\]/u,
  "deploy must require a non-empty regular non-symlink Voice database",
);
assert.match(deploy, /"custom-voices\.json"/u, "deploy must require custom voice metadata");
assert.doesNotMatch(deploy, /prisma\s+(?:db push|migrate|db seed)|npm run db:seed/u);

const localStart = readFileSync(path.join(root, "scripts/run-start.mjs"), "utf8");
for (const marker of ["APP_DATA_DIR", "APP_RUNTIME_DIR", "COMMERCE_DATA_DIR", "COMMERCE_GATEWAY_KEY_FILE", "IDEMPOTENCY_DIR", "BACKUP_DIR", "VOICE_SQLITE_PATH"]) {
  assert.ok(localStart.includes(marker), `Windows local production preview is missing ${marker}`);
}
assert.match(localStart, /localProductionPreviewEnv/u, "run-start must inject local production preview data paths");
assert.match(localStart, /path\.dirname\(process\.execPath\)/u, "run-start must expose the resolved Node runtime to child tools");

const policy = JSON.parse(readFileSync(path.join(root, "deploy/policies/release-policy.json"), "utf8"));
assert.ok(policy.runtime.mutablePaths.includes("data"));
assert.ok(policy.runtime.requiredServerMounts.includes("shared/voice/voice.db"));
assert.ok(policy.runtime.requiredServerMounts.includes("shared/runtime/commerce-agent"));
assert.ok(policy.runtime.requiredServerMounts.includes("shared/assets/releases"));
assert.ok(policy.runtime.requiredServerMounts.includes("shared/assets/current"));
assert.ok(policy.runtime.requiredDataFiles.includes("custom-voices.json"));
assert.equal(policy.runtime.requiredDataShapes["custom-voices.json"], "array");

console.log(JSON.stringify({
  ok: true,
  localFallback,
  productionRequiresAbsolutePersistentPath: true,
  webAndVoiceShareOneDatabase: true,
  deploymentCannotCreateOrSeedDatabase: true,
}, null, 2));
