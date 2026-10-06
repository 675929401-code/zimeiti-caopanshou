#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
const policy = JSON.parse(read("deploy/policies/release-policy.json"));
const releaseWorkflowSource = read("scripts/release-workflow.mjs");

for (const marker of [
  "inspectMigrationWorktree",
  "historical migration changed relative to HEAD; restore it and use a new forward-only migration",
  "historicalMigrationMutationAllowed: false",
  "newForwardMigrations",
]) assert.ok(releaseWorkflowSource.includes(marker), `release workflow migration immutability gate missing: ${marker}`);

assert.deepEqual(policy.source.publicSourcePaths, [
  "public/model-brands/bytedance.svg",
  "public/model-brands/generic.svg",
  "public/model-brands/google.svg",
  "public/model-brands/openai.svg",
  "public/model-brands/xai.svg",
  "public/product-assets/youcai-demo-v1/clean-v21/previews/03-shot-02.webp",
  "public/robots.txt",
  "public/short-drama/previews/film-studio-promo-bg-v2.webp",
  "public/short-drama/previews/film-studio-promo-bg-v3.webp",
  "public/short-drama/previews/hero-dream-floral-v2.webp",
  "public/short-drama/previews/hero-pipeline-v1.webp",
  "public/short-drama/previews/inspiration-moon-observatory-v1.webp",
  "public/short-drama/previews/inspiration-paper-fox-v1.webp",
  "public/short-drama/previews/inspiration-product-film-v1.webp",
  "public/short-drama/previews/inspiration-silent-pet-v1.webp",
  "public/short-drama/previews/manifest.json",
  "public/version.json",
  "public/youcai-media/v1/source-manifest.json",
]);
assert.equal(policy.source.publicSourceExtensions, undefined, "blanket public extension allowlists are forbidden");
assert.deepEqual(policy.source.preSnapshotVerifiers, [
  "scripts/verify-public-asset-contract.mjs",
  "scripts/verify-runtime-data-vnext.mjs",
]);
for (const pattern of ["**/*.db", "**/*.db-*", "**/*.sqlite", "**/*.sqlite-*", "**/*.sqlite3", "**/*.sqlite3-*"]) {
  assert.ok(policy.source.excludeGlobs.includes(pattern), `mutable SQLite path is not excluded from source snapshots: ${pattern}`);
}
for (const ignoreFile of [".gitignore", ".releaseignore"]) {
  const ignore = read(ignoreFile);
  for (const pattern of ["*.db", "*.db-*", "*.sqlite", "*.sqlite-*", "*.sqlite3", "*.sqlite3-*"]) {
    assert.ok(ignore.split(/\r?\n/u).includes(pattern), `${ignoreFile} is missing SQLite runtime exclusion: ${pattern}`);
  }
}
for (const required of [
  "shared/data",
  "shared/runtime",
  "shared/runtime/commerce-agent",
  "shared/runtime/commerce-discovery",
  "shared/assets/releases",
  "shared/assets/current",
  "shared/uploads",
  "shared/logs",
  "shared/backups",
  "shared/voice/voice.db",
  "shared/voice/reference-audio",
]) {
  assert.ok(policy.runtime.requiredServerMounts.includes(required), `missing persistent server mount: ${required}`);
}
assert.ok(policy.runtime.requiredDataFiles.includes("studio-config.json"));
assert.ok(policy.runtime.requiredDataFiles.includes("custom-voices.json"));
assert.equal(policy.runtime.requiredDataShapes["custom-voices.json"], "array");
assert.deepEqual(policy.assets.forbiddenPublicRoots, ["public/storyboard-reviews", "public/demo-assets"]);
assert.equal(policy.release.serverBuildAllowed, false);
assert.equal(policy.release.serverGitCheckoutAllowed, false);
assert.equal(policy.release.productionBuild.platform, "linux");
assert.equal(policy.release.productionBuild.nodeMajor, 24);
assert.equal(policy.release.productionBuild.nodeVersion, "24.19.0");
assert.equal(policy.release.productionBuild.pnpmVersion, "9.0.0");
assert.equal(policy.database.contract, "deploy/policies/database-contract.v1.json");
assert.equal(policy.database.probeMode, "read-only-postgrest-openapi");
assert.equal(policy.database.requireTablesColumnsRpcsAndArguments, true);
assert.equal(policy.database.requireForbiddenRpcAbsence, true);
assert.equal(policy.database.applicationManagedMigrationsAllowed, false);
assert.equal(policy.database.preMigrationBackupRequired, true);
const databaseContract = JSON.parse(read(policy.database.contract));
assert.equal(databaseContract.schemaVersion, 1);
assert.match(databaseContract.contractId, /^zimeiti-caopanshou-production-database-/u);
assert.match(databaseContract.contractVersion, /^\d{14}$/u);
assert.ok(databaseContract.tables.length >= 41, "production database contract is missing P0 tables");
assert.ok(databaseContract.rpcs.length >= 34, "production database contract is missing P0 RPCs");
assert.equal(new Set(databaseContract.tables.map((table) => table.name)).size, databaseContract.tables.length);
assert.equal(new Set(databaseContract.rpcs.map((rpc) => rpc.name)).size, databaseContract.rpcs.length);
for (const table of databaseContract.tables) {
  assert.match(table.name, /^[a-z][a-z0-9_]*$/u);
  assert.ok(Array.isArray(table.columns) && table.columns.length > 0, `database table columns missing: ${table.name}`);
  assert.equal(new Set(table.columns).size, table.columns.length, `duplicate database columns: ${table.name}`);
}
for (const rpc of databaseContract.rpcs) {
  assert.match(rpc.name, /^[a-z][a-z0-9_]*$/u);
  assert.ok(Array.isArray(rpc.arguments) && rpc.arguments.length > 0, `database RPC arguments missing: ${rpc.name}`);
  assert.equal(new Set(rpc.arguments).size, rpc.arguments.length, `duplicate RPC arguments: ${rpc.name}`);
}
for (const requiredTable of [
  "conversation_message_attachments",
  "canvas_document_requests",
  "short_drama_project_versions",
  "wallet_ledger_entries",
  "voice_training_authorization_jobs",
  "manju_config_audit",
  "skill_invocations",
  "cash_debt_records",
  "password_audit_log",
]) assert.ok(databaseContract.tables.some((table) => table.name === requiredTable), `P0 database table is missing: ${requiredTable}`);
assert.deepEqual(databaseContract.forbiddenRpcs.map((rpc) => rpc.name), ["fulfill_payment_order_atomic"]);
for (const backupPattern of ["**/*.bak", "**/*.backup", "**/*.old", "**/*.orig", "**/*.rej", "**/*~"]) {
  assert.ok(policy.source.excludeGlobs.includes(backupPattern), `clean source must exclude editor/backup artifact: ${backupPattern}`);
}
assert.ok(policy.source.excludeGlobs.includes("voice-platform/scripts/voices-full-backup.json"));
assert.match(read(".gitignore"), /^\/voice-platform\/scripts\/voices-full-backup\.json$/mu);
assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/mu, "Git text files must be normalized to LF across platforms");
assert.match(
  read(".gitattributes"),
  /^public\/youcai-media\/v1\/source-manifest[.]json -text -diff$/mu,
  "asset-digest-coupled manifest bytes must remain unchanged and non-text-diffable across Git checkout",
);

const packageJson = JSON.parse(read("package.json"));
for (const script of [
  "release:vnext:audit",
  "release:vnext:assets:write",
  "release:vnext:curate-demo-assets",
  "release:vnext:assets:cos-plan",
  "release:vnext:assets:materialize",
  "release:vnext:assets:verify",
  "release:vnext:inspiration:verify",
  "release:vnext:classify",
  "release:vnext:data:verify",
  "release:vnext:schema:verify",
  "release:vnext:snapshot",
  "release:vnext:sync",
  "release:vnext:build:web",
  "release:vnext:build:voice",
  "release:vnext:package",
  "release:vnext:verify",
  "deploy:nginx:render",
  "deploy:nginx:verify",
]) assert.ok(packageJson.scripts[script], `missing package script: ${script}`);
assert.equal(packageJson.scripts.preinstall, "node ./scripts/enforce-pnpm.mjs");
assert.equal(packageJson.scripts["e2e:browser:install"], "puppeteer browsers install chrome");
assert.equal(packageJson.scripts.validate, "tsc -p tsconfig.json && eslint . --quiet", "validation must not resolve a different nested pnpm binary");
assert.equal(packageJson.packageManager, `pnpm@${policy.release.productionBuild.pnpmVersion}`);
assert.equal(packageJson.engines.pnpm, policy.release.productionBuild.pnpmVersion);
const expectedPnpmOverrides = {
  "fast-xml-parser": "4.5.5",
  "form-data": "2.5.6",
  ini: "1.3.8",
  "linkify-it": "5.0.2",
  nanoid: "3.3.18",
  postcss: "8.5.18",
  sharp: "0.35.0",
};
assert.deepEqual(packageJson.pnpm?.overrides, expectedPnpmOverrides, "pnpm 9 overrides must live in package.json#pnpm");
const expectedOnlyBuiltDependencies = [
  "esbuild",
  "ffmpeg-static",
  "sharp",
  "unrs-resolver",
];
assert.deepEqual(
  packageJson.pnpm?.onlyBuiltDependencies,
  expectedOnlyBuiltDependencies,
  "pnpm 9 lifecycle-script allowlist must live in package.json#pnpm",
);
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("canvas"), "canvas lifecycle scripts must remain blocked");
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("puppeteer"), "browser download must remain outside release dependency installation");
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("better-sqlite3"), "better-sqlite3 v13 prebuild must not invoke node-gyp during install");
assert.equal(packageJson.dependencies["better-sqlite3"], "13.0.3");
assert.equal(packageJson.dependencies["@prisma/client"], undefined, "Web does not own the Voice Prisma client");
assert.equal(packageJson.dependencies.prisma, undefined, "Web does not own the Voice Prisma generator");
const voicePackageJson = JSON.parse(read("voice-platform/package.json"));
assert.equal(voicePackageJson.scripts.preinstall, "node ../scripts/enforce-pnpm.mjs");
assert.equal(voicePackageJson.packageManager, `pnpm@${policy.release.productionBuild.pnpmVersion}`);
assert.equal(voicePackageJson.engines.pnpm, policy.release.productionBuild.pnpmVersion);
assert.equal(voicePackageJson.dependencies["@prisma/client"], "^5.22.0");
assert.equal(voicePackageJson.devDependencies.prisma, "^5.22.0");
assert.deepEqual(voicePackageJson.pnpm?.onlyBuiltDependencies, [
  "@prisma/client",
  "@prisma/engines",
  "esbuild",
  "prisma",
  "sharp",
  "unrs-resolver",
]);
const workspaceManifest = read("pnpm-workspace.yaml");
assert.doesNotMatch(workspaceManifest, /^overrides:/mu, "pnpm 9 does not read root overrides from pnpm-workspace.yaml");
assert.doesNotMatch(workspaceManifest, /^allowBuilds:/mu, "pnpm 9 does not support pnpm 10 allowBuilds");
assert.doesNotMatch(workspaceManifest, /^onlyBuiltDependencies:/mu, "pnpm 9 lifecycle allowlist belongs in package.json");
const lockfileHeaderLines = read("pnpm-lock.yaml").split(/\r?\nimporters:/u, 1)[0].split(/\r?\n/u);
for (const [dependency, version] of Object.entries(expectedPnpmOverrides)) {
  assert.ok(lockfileHeaderLines.includes(`  ${dependency}: ${version}`), `lockfile override is missing or stale: ${dependency}`);
}
const pnpmEnforcer = read("scripts/enforce-pnpm.mjs");
assert.ok(pnpmEnforcer.includes(`expectedVersion = "${policy.release.productionBuild.pnpmVersion}"`));
const runtimeDataVerifier = read("scripts/verify-runtime-data-vnext.mjs");
for (const marker of ["explicitDataRoot", "EXTERNAL_RUNTIME_DATA_NOT_PRESENT", "pass --data-root to verify a mounted data release"]) {
  assert.ok(runtimeDataVerifier.includes(marker), `runtime-data source-boundary gate missing: ${marker}`);
}
const publicAssetContractVerifier = read("scripts/verify-public-asset-contract.mjs");
for (const marker of ["pinned-external-manifest", "full-local-sha256-and-decode", "partial local YouCai asset tree is forbidden", "activationReady: false"]) {
  assert.ok(publicAssetContractVerifier.includes(marker), `public-asset verification mode missing: ${marker}`);
}
const topLevelDatabaseClients = [];
const sourceScanStack = [path.join(root, "src")];
while (sourceScanStack.length > 0) {
  const directory = sourceScanStack.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceScanStack.push(filePath);
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      const relativePath = path.relative(root, filePath).split(path.sep).join("/");
      for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).entries()) {
        if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*getSupabase(?:Admin)?Client\(\);?\s*$/u.test(line)) {
          topLevelDatabaseClients.push(`${relativePath}:${index + 1}`);
        }
      }
    }
  }
}
assert.deepEqual(topLevelDatabaseClients, [], "database clients must be initialized inside request/runtime functions, never during module evaluation");

const ciWorkflow = read(".github/workflows/release-vnext.yml");
assert.match(ciWorkflow, /node-version:\s*"24\.19\.0"/u);
assert.match(ciWorkflow, /PUPPETEER_SKIP_DOWNLOAD:\s*"true"/u);
assert.match(ciWorkflow, /git diff --check "\$BASE_SHA\.\.\.\$HEAD_SHA"/u, "CI must reject new whitespace debt without rewriting the baseline");
assert.match(ciWorkflow, /sha256sum -c/u, "CI must verify the packager-owned checksum");
assert.doesNotMatch(ciWorkflow, /sha256sum[^\n]*>[^\n]*checksum/u, "CI must never overwrite the packager-owned checksum");
assert.match(ciWorkflow, /package-standalone-artifact\.mjs[\s\S]{0,400}--archive/u);
assert.match(
  ciWorkflow,
  /working-directory:\s*voice-platform[\s\S]{0,160}pnpm --ignore-workspace install --frozen-lockfile/u,
  "Voice dependencies must be installed from the isolated Voice lockfile",
);

const dockerfile = read("Dockerfile");
assert.match(dockerfile, /node:24\.19\.0-bookworm-slim@sha256:[0-9a-f]{64}/u);
assert.match(dockerfile, /pnpm-workspace\.yaml/u);
assert.match(dockerfile, /PUPPETEER_SKIP_DOWNLOAD=true/u);
assert.match(dockerfile, /\.next\/standalone/u);
assert.match(dockerfile, /USER nextjs/u);
assert.doesNotMatch(dockerfile, /require\(["']@prisma\/client["']\)/u, "Web image must not require the Voice Prisma client");
assert.doesNotMatch(dockerfile, /COPY\s+--from=deps\s+\/app\/node_modules\s+\.\/node_modules[\s\S]*FROM \$\{NODE_IMAGE\} AS runner[\s\S]*COPY.*node_modules/u);

const packager = read("scripts/package-standalone-artifact.mjs");
for (const marker of [
  "release-provenance.v1.json",
  "git([\"status\"",
  "schemaVersion: 2",
  "deployable",
  "buildEnvironment",
  "assetDigest",
  "sourceManifestSha256",
]) assert.ok(packager.includes(marker), `packager gate missing: ${marker}`);
assert.doesNotMatch(packager, /publicSourceExtensions/u);

const build = read("scripts/build-release-vnext.mjs");
for (const marker of ["productionBuild", "--allow-local-rehearsal", "--verify-pnpm-invocation", "resolvePnpmInvocation", "PNPM_CLI_PATH", "lockfileSha256", "nodeModulesAbi", "detectLibc", "DEPLOYMENT_VERSION", "servicePnpmPrefix", "--ignore-workspace", "required-server-files.json", "compiled deploymentId must equal the immutable Git commit", "Voice BUILD_ID must equal the immutable Git commit", "deploymentId: commitSha", "buildIdStrategy", "nextVersion"]) {
  assert.ok(build.includes(marker), `build provenance gate missing: ${marker}`);
}
assert.doesNotMatch(build, /pnpm[.]cmd/u, "Windows release builds must not spawn a .cmd shim directly");
const gitAutoDeploy = read("scripts/git-auto-deploy.sh");
assert.ok(
  gitAutoDeploy.includes(`corepack prepare pnpm@${policy.release.productionBuild.pnpmVersion} --activate`),
  "legacy deploy script must prepare the policy pnpm version",
);
assert.doesNotMatch(gitAutoDeploy, /pnpm@9\.15\.9/u, "legacy deploy script must not prepare a drifted pnpm 9.x version");
const nextConfig = read("next.config.ts");
assert.match(nextConfig, /deploymentId:\s*deploymentVersion/u);
assert.doesNotMatch(nextConfig, /generateBuildId/u, "Next 16 BUILD_ID must not be conflated with the immutable release commit");
assert.doesNotMatch(
  nextConfig,
  /outputFileTracingRoot:\s*process\.cwd\(\)/u,
  "Next config must not make NFT trace the entire project through a dynamic cwd root",
);
assert.match(
  nextConfig,
  /turbopack:\s*\{[\s\S]*?root:\s*process\.cwd\(\)/u,
  "Turbopack must stay pinned to the current project instead of scanning the parent drive",
);
const voiceNextConfig = read("voice-platform/next.config.ts");
assert.match(voiceNextConfig, /deploymentId:\s*deploymentVersion/u);
assert.match(voiceNextConfig, /generateBuildId:\s*deploymentVersion/u);
const pnpmCliPath = process.env.PNPM_CLI_PATH?.trim() || process.env.npm_execpath?.trim();
if (pnpmCliPath) {
  const pnpmInvocationSmoke = spawnSync(process.execPath, [path.join(root, "scripts/build-release-vnext.mjs"), "--verify-pnpm-invocation"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PNPM_CLI_PATH: pnpmCliPath },
  });
  assert.equal(pnpmInvocationSmoke.status, 0, pnpmInvocationSmoke.stderr || pnpmInvocationSmoke.stdout);
  assert.equal(JSON.parse(pnpmInvocationSmoke.stdout).pnpmVersion, policy.release.productionBuild.pnpmVersion);
}

const deployApi = read("src/app/api/deploy/route.ts");
assert.match(deployApi, /IN_APP_DEPLOY_DISABLED/u);
assert.doesNotMatch(deployApi, /next build|pm2 restart|public\/version\.json/u);
const legacyVoiceSync = read("src/app/api/admin/voices/sync/route.ts");
assert.match(legacyVoiceSync, /LEGACY_SOURCE_MUTATION_DISABLED/u);
assert.doesNotMatch(legacyVoiceSync, /writeFileSync|voices-volc\.ts/u);
for (const route of ["src/app/api/settings/route.ts", "src/app/api/settings/layout/route.ts"]) {
  assert.doesNotMatch(read(route), /writeFileSync|public["'],\s*["']version\.json/u, `${route} mutates immutable version metadata`);
}

const databaseReadiness = read("src/lib/production-database-readiness.ts");
for (const marker of [
  "validateProductionDatabaseOpenApi",
  "missingColumns",
  "missingRpcArguments",
  "forbiddenRpcsPresent",
  "application/openapi+json",
]) assert.ok(databaseReadiness.includes(marker), `database readiness gate missing: ${marker}`);
const releaseReadiness = read("src/app/api/release-readiness/route.ts");
assert.match(releaseReadiness, /probeProductionDatabaseReadiness/u);
assert.match(releaseReadiness, /production database contract is not ready/u);
assert.match(releaseReadiness, /probeProductionReferenceDataReadiness/u);
assert.match(releaseReadiness, /production reference data is not ready/u);
assert.match(releaseReadiness, /EXPECTED_BUILD_ID/u);
assert.doesNotMatch(releaseReadiness, /process\.cwd\(\)[\s\S]{0,80}BUILD_ID/u, "Web readiness must not make Next trace the source root");
for (const call of ["openSync", "readFileSync", "statSync", "lstatSync", "accessSync"]) {
  assert.doesNotMatch(
    releaseReadiness,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `Web readiness dynamic fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const runtimePaths = read("src/lib/runtime-paths.ts");
for (const call of ["existsSync", "mkdirSync", "statSync", "accessSync"]) {
  assert.doesNotMatch(
    runtimePaths,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `runtime path fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const voiceDatabasePath = read("src/lib/voice-studio/database-path.ts");
for (const call of ["resolve", "join"]) {
  assert.doesNotMatch(
    voiceDatabasePath,
    new RegExp(`path\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `Voice SQLite path.${call} must be excluded from Turbopack file tracing`,
  );
}
const localStorageProvider = read("src/storage/object/providers/local.ts");
for (const call of ["mkdir", "open", "rename", "rm", "readFile", "access", "unlink", "readdir", "stat"]) {
  assert.doesNotMatch(
    localStorageProvider,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `local storage fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const avatarRoute = read("src/app/api/avatars/route.ts");
for (const pattern of [
  /fs\.readFile\((?!\s*\/\* turbopackIgnore: true \*\/)/u,
  /path\.resolve\((?!\s*\/\* turbopackIgnore: true \*\/)/u,
]) assert.doesNotMatch(avatarRoute, pattern, "avatar runtime mounts must be excluded from Turbopack file tracing");
const voiceReleaseReadiness = read("voice-platform/src/app/api/release-readiness/route.ts");
assert.match(voiceReleaseReadiness, /EXPECTED_BUILD_ID/u);
assert.match(voiceReleaseReadiness, /must equal DEPLOY_COMMIT_SHA/u);
assert.doesNotMatch(voiceReleaseReadiness, /process\.cwd\(\)[\s\S]{0,80}BUILD_ID/u, "Voice readiness must not make Next trace the source root");
const referenceDataReadiness = read("src/lib/production-reference-data-readiness.ts");
for (const marker of [
  "voice_nest_price_versions",
  "manju_config_active",
  "manju_config_storage_state",
  "MANJU_CONFIG_DOMAINS",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "video_models",
  "video_channel_health",
  "isReleaseVerifiedVideoChannelHealth",
  "reference-data-not-ready",
]) assert.ok(referenceDataReadiness.includes(marker), `reference-data readiness gate missing: ${marker}`);
const healthRoute = read("src/app/api/health/route.ts");
assert.match(healthRoute, /probeProductionDatabaseReadiness/u);
assert.doesNotMatch(healthRoute, /requiredTables[\s\S]{0,600}["']avatars["']/u, "avatars storage bucket must not be treated as a database table");
const debtLedgerMigration = read("supabase/migrations/20260828193000_release_baseline_audit_and_debt.sql");
assert.match(debtLedgerMigration, /CREATE TABLE IF NOT EXISTS public\.cash_debt_records/u);
assert.match(debtLedgerMigration, /CREATE TABLE IF NOT EXISTS public\.password_audit_log/u);
const billing = read("src/lib/billing.ts");
assert.match(billing, /DEBT_LEDGER_QUERY_FAILED/u);
assert.match(billing, /failureCode:\s*'DEBT_LEDGER_UNAVAILABLE'/u);
const imageGenerate = read("src/app/api/image/generate/route.ts");
assert.match(imageGenerate, /BILLING_LEDGER_UNAVAILABLE/u);
assert.match(imageGenerate, /本次不会调用图片模型，也不会扣费/u);

const nginx = read("deploy/nginx/agent-hub.vnext.conf.example");
for (const marker of ["shared/assets/current/public", "public-assets.ready.v1.json", "api/release-readiness"]) {
  assert.ok(nginx.includes(marker), `nginx release contract missing: ${marker}`);
}
for (const token of ["__RELEASE_ROOT__", "__SERVER_NAMES__"]) {
  assert.ok(nginx.includes(token), `nginx template must keep an explicit renderer token: ${token}`);
}
assert.doesNotMatch(nginx, /^\s*server_name\s+example\.invalid\s*;/mu, "nginx template must not contain an active placeholder server name");
assert.doesNotMatch(nginx, /^\s*(?:root|alias)\s+\/srv\/zimeiti-caopanshou(?:\/|;)/mu, "nginx template must not contain an active example release root");
const nginxRenderer = read("scripts/render-nginx-config-vnext.mjs");
for (const marker of [
  "validateReleaseRoot",
  "validateServerNames",
  "unresolved placeholders",
  "output already exists",
  "writeAtomic",
]) assert.ok(nginxRenderer.includes(marker), `nginx renderer gate missing: ${marker}`);
assert.match(packageJson.scripts["release:vnext:verify"], /verify-render-nginx-config-vnext\.mjs/u, "formal release verification must execute the Nginx renderer test");
assert.match(nginx, /location = \/api\/payment\/notify\s*\{[\s\S]*?client_max_body_size 64k;/u, "payment callback bodies must be bounded at the edge");
assert.match(nginx, /location = \/api\/payment\/refund\s*\{[\s\S]*?client_max_body_size 16k;/u, "payment refund bodies must be bounded at the edge");
assert.match(nginx, /location = \/api\/payment\/refund\s*\{[\s\S]*?limit_req zone=agent_hub_paid_write_ip burst=5 nodelay;/u, "payment refunds must use the shared paid-write limiter");
assert.match(nginxRenderer, /validateRequestBodyLimits/u, "Nginx renderer must reject payment-limit and media-upload-limit drift");
assert.match(nginx, /location\s+(?:\^~\s+)?\/uploads\//u, "nginx mutable uploads location is missing");
assert.match(nginx, /storyboard-reviews\|demo-assets/u, "nginx must deny public evidence roots");
assert.match(packageJson.scripts["deploy:capacity:verify"], /verify-release-operational-capacity\.mjs\s+--mode=production/u, "deployment must run the production capacity gate");
const capacityVerifier = read("scripts/verify-release-operational-capacity.mjs");
for (const marker of [
  "single-public-web-process-boundary",
  "payment-edge-body-limits",
  "large-upload-edge-separation",
  "horizontal-web-scale-boundary",
  "single-web-no-cost-concurrency-probe",
  "PROBE_CONCURRENCY = 200",
  "paidModelCalls: 0",
  "databaseWrites: 0",
]) assert.ok(capacityVerifier.includes(marker), `operational capacity gate missing: ${marker}`);

const releaseWorkflow = read("scripts/release-workflow.mjs");
for (const marker of ["assetPolicySha256", "sha256-files-and-asset-policy", "canonicalSourceBuffer", "canonicalTextEol", "isExternalAsset", "attr\\/-text", "ls-files", "--eol", "w\\/(?:crlf|mixed)", "forbiddenPublicRoots", "requiredRemotes", "isSafelyIgnoredLegacyManagedFile", "check-ignore", "stats.nlink !== 1"]) {
  assert.ok(releaseWorkflow.includes(marker), `release workflow policy gate missing: ${marker}`);
}
assert.doesNotMatch(releaseWorkflow, /generatedAt:\s*new Date\(\)\.toISOString\(\)[\s\S]{0,250}kind:\s*["']public-assets/u);

const assetVerifier = read("scripts/verify-public-asset-release.mjs");
for (const marker of ["fileCount", "totalBytes", "mutableUploadsIncluded", "verificationMode", "storageBackend", "location"]) {
  assert.ok(assetVerifier.includes(marker), `asset READY verifier is missing: ${marker}`);
}
assert.match(assetVerifier, /storageBackend !== ["']disk["']/u, "local verifier must reject COS READY issuance");
assert.match(assetVerifier, /COS READY must be generated by publish-public-assets-cos-vnext/u);
assert.match(assetVerifier, /assetPolicySha256 !== assetPolicySha256/u, "local verifier must bind the current stable asset policy digest");
assert.match(assetVerifier, /symbolic links are forbidden/u);
assert.match(assetVerifier, /kind:\s*["']public-assets-verification-result["']/u);
assert.match(assetVerifier, /status:\s*["']VERIFIED["']/u);
assert.match(assetVerifier, /--write-ready is disabled/u);
assert.doesNotMatch(assetVerifier, /status:\s*["']READY["']/u, "local verifier must not mint final READY");
const cosPublisher = read("scripts/publish-public-assets-cos-vnext.mjs");
assert.match(cosPublisher, /verificationMode:\s*["']full-sha256["']/u);
assert.doesNotMatch(cosPublisher, /full-sha256-metadata/u);
assert.match(cosPublisher, /verifyRemoteContent/u);
for (const marker of [
  "Number.isSafeInteger",
  "SINGLE_PUT_MAX_BYTES",
  "assetPolicySha256 !== assetPolicySha256",
  "publisherScriptSha256",
  "remoteVerifiedFileCount",
  "remoteContentTypeVerified",
  "remoteCacheControlVerified",
  "put-object-forbid-overwrite",
]) assert.ok(cosPublisher.includes(marker), `COS publisher security gate missing: ${marker}`);
assert.doesNotMatch(cosPublisher, /cos\.uploadFile\s*\(/u, "unsafe multipart upload fallback must remain disabled");
const assetMaterializer = read("scripts/materialize-public-asset-release-vnext.mjs");
for (const marker of [
  "assetPolicySha256 !== assetPolicySha256",
  "publisherId: PUBLISHER_ID",
  "publisherScriptSha256",
  "remoteVerifiedFileCount",
  "MAX_RECEIPT_BYTES",
  "symbolic links are forbidden",
  "fsyncFile(destinationPath)",
  "public-assets-transport-receipt",
  "public-assets.bundle.v1.json",
  "public-assets.cos.ready.v1.json",
]) assert.ok(assetMaterializer.includes(marker), `asset materializer security gate missing: ${marker}`);
assert.doesNotMatch(assetMaterializer, /["']public-assets\.ready\.v1\.json["']/u, "materializer must not write the final READY filename");

for (const productionSource of [
  "src/app/help/storyboard-mode-showcase.tsx",
  "src/features/official-home/official-home-page.tsx",
  "src/lib/creation-center-catalog.ts",
  "src/components/manual-canvas.tsx",
  "src/components/storyboard-workbench.tsx",
]) {
  assert.doesNotMatch(read(productionSource), /\/(?:storyboard-reviews|demo-assets)\//u, `${productionSource} references public evidence`);
}
const pm2 = read("deploy/pm2/ecosystem.vnext.config.cjs");
for (const marker of ["APP_DATA_DIR", "APP_RUNTIME_DIR", "COMMERCE_DATA_DIR", "COMMERCE_DISCOVERY_CATALOG", "COMMERCE_GATEWAY_KEY_FILE", "BACKUP_DIR", "PUBLIC_ASSET_ROOT", "VOICE_REFERENCE_AUDIO_DIR", "EXPECTED_BUILD_ID", "COZE_PROJECT_ENV"]) {
  assert.ok(pm2.includes(marker), `PM2 release contract missing: ${marker}`);
}
const artifactDeployer = read("scripts/deploy-artifact-vnext.sh");
for (const marker of ["EXPECTED_BUILD_ID=\"$BUILD_ID\"", "active_build_id", "env.EXPECTED_BUILD_ID !== buildId", "\"$PREVIOUS_BUILD_ID\""]) {
  assert.ok(artifactDeployer.includes(marker), `artifact deployment build-identity gate missing: ${marker}`);
}
for (const marker of [
  "verify_exact_active_composite",
  "verify_exact_first_deploy_composite",
  "env.ASSET_DIGEST !== assetDigest",
  "ROLLBACK_ATTEMPTED",
  "handle_termination TERM 143",
  "handle_termination INT 130",
  "handle_termination HUP 129",
  "read_asset_release_backend",
  "CURRENT_ASSET_BACKEND",
  "ASSET_TARGET_BACKEND",
  '[[ "$EUID" -eq 0 ]] || die "--execute requires EUID=0',
  "seal_candidate_release",
  "verify_candidate_release_seal",
  "sealed candidate full SHA-256 inventory changed before activation",
]) assert.ok(artifactDeployer.includes(marker), `artifact deployment transaction gate missing: ${marker}`);
const stateMachineVerification = spawnSync(process.execPath, [path.join(root, "scripts/verify-deploy-state-machine.mjs")], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
assert.equal(stateMachineVerification.status, 0, `deployment state-machine verification failed: ${stateMachineVerification.stderr || stateMachineVerification.stdout}`);
const stateMachineReport = JSON.parse(stateMachineVerification.stdout);
assert.equal(stateMachineReport.ok, true, "deployment state-machine report did not pass");
assert.equal(stateMachineReport.staticStateMachineChecks, true, "deployment state-machine static gates did not pass");
assert.ok(stateMachineReport.embeddedNodeValidators >= 12, "deployment state-machine did not syntax-check every embedded Node validator");
assert.ok(Array.isArray(stateMachineReport.dynamicFaultInjectionChecks), "deployment state-machine did not execute fault injection");
for (const requiredHarness of ["signal", "exit", "first-deploy"]) {
  assert.ok(
    stateMachineReport.dynamicFaultInjectionChecks.some((result) => result.harness === requiredHarness),
    `deployment state-machine did not execute the ${requiredHarness} harness`,
  );
}
for (const requiredScenario of ["rollback-current", "rollback-absent", "rollback-rm-fail", "rollback-unexpected"]) {
  assert.ok(
    stateMachineReport.dynamicFaultInjectionChecks.some((result) => result.scenario === requiredScenario),
    `deployment state-machine did not execute first-deploy scenario ${requiredScenario}`,
  );
}
const provisioner = read("scripts/provision-release-root-vnext.sh");
for (const marker of [
  "--plan",
  "--execute",
  "RELEASE_ROOT_PROVISION_APPROVED",
  ".zimeiti-release-root",
  "shared/runtime/llm-request-idempotency",
  "PRAGMA quick_check",
  "no empty business data was generated",
]) assert.ok(provisioner.includes(marker), `release-root provisioner gate missing: ${marker}`);
assert.doesNotMatch(provisioner, /(?:echo|printf)[^\n]*(?:\[\]|\{\})[^\n]*shared\/data/u, "provisioner must not seed empty business JSON");

for (const script of [
  "scripts/release-workflow.mjs",
  "scripts/build-release-vnext.mjs",
  "scripts/package-standalone-artifact.mjs",
  "scripts/verify-deploy-state-machine.mjs",
  "scripts/verify-public-asset-release.mjs",
  "scripts/publish-public-assets-cos-vnext.mjs",
  "scripts/materialize-public-asset-release-vnext.mjs",
]) {
  const checked = spawnSync(process.execPath, ["--check", path.join(root, script)], { encoding: "utf8" });
  assert.equal(checked.status, 0, `${script} syntax failed: ${checked.stderr || checked.stdout}`);
}

const audit = spawnSync(process.execPath, [path.join(root, "scripts/release-workflow.mjs"), "audit"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
assert.equal(audit.status, 0, `release workflow audit failed: ${audit.stderr || audit.stdout}`);
const auditJson = JSON.parse(audit.stdout);
assert.equal(auditJson.status, "PASS");
assert.ok(auditJson.source.bytes < policy.source.maxBytes);
assert.ok(auditJson.externalAssets.bytes > auditJson.source.bytes);
assert.match(auditJson.externalAssets.pinnedDigest, /^[0-9a-f]{64}$/u);

console.log(JSON.stringify({
  ok: true,
  sourceFiles: auditJson.source.files,
  sourceBytes: auditJson.source.bytes,
  assetFiles: auditJson.externalAssets.files,
  assetBytes: auditJson.externalAssets.bytes,
  assetDigest: auditJson.externalAssets.pinnedDigest,
  productionBuild: policy.release.productionBuild,
}, null, 2));
