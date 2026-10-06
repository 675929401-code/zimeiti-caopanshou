#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const failures = [];
const pass = (message) => console.log(`PASS ${message}`);
const fail = (message) => failures.push(message);
const read = (relativePath) => {
  const fullPath = path.join(root, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) {
    fail(`missing required file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(fullPath, "utf8");
};

const packageJson = JSON.parse(read("package.json") || "{}");
const productionTopology = JSON.parse(read("deploy/environments/production-topology.template.json") || "{}");
const productionEnvExample = read("deploy/environments/production.env.example");
const nodeTsxRunner = "node ./scripts/run-node-maintenance-tsx.mjs";
const expectedScripts = {
  "verify:security-p0-stage2": `${nodeTsxRunner} ./scripts/verify-release-security-p0.ts`,
  "verify:storyboard-import": `${nodeTsxRunner} ./scripts/verify-storyboard-agent-output-import.ts`,
  "verify:release-chain": "node ./scripts/verify-local-release-chain.mjs",
  "release:preflight": "node ./scripts/release-preflight.mjs --mode prepare",
  "release:prepare": "node ./scripts/release-preflight.mjs --mode prepare && node ./scripts/verify-local-release-chain.mjs",
  "release:publish": "node ./scripts/release-preflight.mjs --mode publish",
  "release:deploy": "node ./scripts/release-preflight.mjs --mode deploy",
  "deploy:remotes": "node ./scripts/configure-release-remotes.mjs",
  "deploy:remotes:apply": "node ./scripts/configure-release-remotes.mjs --apply",
  "deploy:handoff": "node ./scripts/create-release-handoff.mjs",
  "deploy:env:verify": "node ./scripts/verify-production-environment.mjs",
  "deploy:status": "node ./scripts/release-close-loop.mjs --human",
  "deploy:close-loop": "node ./scripts/release-close-loop.mjs",
  "deploy:close-loop:push": "node ./scripts/release-close-loop.mjs --push-git",
};
for (const [name, expected] of Object.entries(expectedScripts)) {
  if (packageJson.scripts?.[name] !== expected) {
    fail(`package.json ${name} must be ${JSON.stringify(expected)}`);
  }
}
if (failures.length === 0) pass("package release commands are self-contained and fail-closed");

if (productionTopology.git?.primaryRemote?.name !== "origin"
  || productionTopology.git?.backupRemote?.name !== "backup"
  || productionTopology.git?.primaryRemote?.recommendedProvider !== "Gitee private repository"
  || !String(productionTopology.git?.backupRemote?.recommendedProvider || "").includes("independent private Git provider")
  || productionTopology.database?.migrationUrlEnv !== "DEPLOY_DATABASE_URL"
  || productionTopology.serverDeploy?.mode !== "immutable-artifact-overwrite-app-only") {
  fail("production topology template must define Gitee origin, independent backup, DEPLOY_DATABASE_URL, and artifact-only server deployment");
} else {
  pass("production topology template captures the selected industry-standard deployment shape");
}

for (const marker of [
  "RELEASE_ORIGIN_URL=",
  "RELEASE_BACKUP_URL=",
  "DEPLOY_DATABASE_URL=",
  "DEPLOY_SSH_TARGET=",
  "DEPLOY_RELEASE_ROOT=/srv/zimeiti-caopanshou",
  "ASSET_DELIVERY_MODE=disk",
  "ASSET_STORAGE_DRIVER=disk",
]) {
  if (!productionEnvExample.includes(marker)) fail(`production env example is missing marker: ${marker}`);
}
if (/=.+(?:password|token|secret|AKIA|sk-|ghp_)/iu.test(productionEnvExample)) {
  fail("production env example must not contain real-looking credentials");
} else {
  pass("production env example documents required variables without credentials");
}

const releaseIgnore = read(".releaseignore")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
if (!releaseIgnore.includes(".npmrc")) {
  fail(".npmrc must be excluded from every release archive");
} else {
  pass("local npm registry configuration is excluded from release archives");
}
for (const verifier of [
  "scripts/verify-release-security-p0.ts",
  "scripts/verify-storyboard-agent-output-import.ts",
  "scripts/verify-local-release-chain.mjs",
  "scripts/configure-release-remotes.mjs",
  "scripts/create-release-handoff.mjs",
  "scripts/verify-production-environment.mjs",
  "scripts/release-close-loop.mjs",
]) {
  read(verifier);
  if (releaseIgnore.includes(verifier)) fail(`release verifier is excluded by .releaseignore: ${verifier}`);
}

const remoteConfigurator = read("scripts/configure-release-remotes.mjs");
for (const marker of [
  "MISSING_REMOTE_URLS",
  "INVALID_OR_LOCAL_REMOTE_URL",
  "REMOTE_HOSTS_NOT_DISTINCT",
  "RELEASE_REPO_NOT_CLEAN",
  "setRemote",
  "RELEASE_ORIGIN_URL",
  "RELEASE_BACKUP_URL",
]) {
  if (!remoteConfigurator.includes(marker)) fail(`remote configurator is missing marker: ${marker}`);
}
if (/gitBin,\s*\["push"/u.test(remoteConfigurator)) {
  fail("remote configurator must not push code; publishing belongs to the accepted-release Publish entrypoint");
} else {
  pass("release remote configurator validates origin/backup without pushing code");
}

const handoffCreator = read("scripts/create-release-handoff.mjs");
for (const marker of [
  "gitBundle",
  "sourceZip",
  "handoff-manifest.json",
  "GIT_BUNDLE_VERIFY_FAILED",
  "RELEASE_REPO_NOT_CLEAN",
  "sourceZip 仅用于源码交接",
]) {
  if (!handoffCreator.includes(marker)) fail(`release handoff creator is missing marker: ${marker}`);
}
if (/db-migration-release\.mjs|DEPLOY_DATABASE_URL\s*=|ssh\s+root@|scp\s+/u.test(handoffCreator)) {
  fail("release handoff creator must not run database migrations or server SSH/SCP actions");
} else {
  pass("release handoff creator packages Git/source evidence without database or server actions");
}

const closeLoopSource = read("scripts/release-close-loop.mjs");
for (const marker of [
  "verify-deployment-readiness.mjs",
  "--mode=code",
  "--mode=production",
  "verify-production-environment.mjs",
  "db-migration-release.mjs",
  "redactRemoteUrl",
  "--push-git",
  "--human",
  "production-topology.template.json",
]) {
  if (!closeLoopSource.includes(marker)) fail(`close-loop orchestrator is missing marker: ${marker}`);
}
if (/db-migration-release\.mjs",\s*"apply"/u.test(closeLoopSource)) {
  fail("close-loop orchestrator must not apply database migrations automatically");
} else {
  pass("close-loop orchestrator checks code, Git and database state without automatic database writes");
}

const storyboardVerifier = read("scripts/verify-storyboard-agent-output-import.ts");
if (storyboardVerifier.includes(".tmp-e2e")) {
  fail("storyboard verifier still depends on release-excluded .tmp-e2e content");
} else if (storyboardVerifier.includes("inline-release-safe-four-code-blocks")) {
  pass("storyboard verifier uses an inline release-safe fixture");
} else {
  fail("storyboard verifier is missing its inline release-safe fixture marker");
}

for (const [relativePath, exitPattern] of [
  ["scripts/git-auto-deploy.sh", /\bexit\s+2\b/u],
  ["scripts/gitee-webhook-server.mjs", /process\.exit\(\s*2\s*\)/u],
  ["scripts/publish-gitee-full.mjs", /process\.exit\(\s*2\s*\)/u],
  ["scripts/publish-gitee-full.sh", /\bexit\s+2\b/u],
]) {
  const source = read(relativePath);
  const guard = source.slice(0, 2048);
  if (!guard.includes("LEGACY_DEPLOY_DISABLED") || !guard.includes("BLOCKED:") || !exitPattern.test(guard)) {
    fail(`legacy remote entrypoint is not fail-closed near the file start: ${relativePath}`);
  }
}
if (!failures.some((message) => message.includes("legacy remote entrypoint"))) {
  pass("legacy Gitee publish, webhook and deploy entrypoints remain blocked");
}

const preflight = read("scripts/release-preflight.mjs");
for (const marker of ["LOCAL_PREPARE PASS", "PUBLISH_DEPLOY BLOCKED", 'mode !== "prepare"']) {
  if (!preflight.includes(marker)) fail(`release preflight is missing status contract marker: ${marker}`);
}
if (preflight.includes('for (const marker of ["git archive", "ln -sfn"')) {
  fail("release preflight still treats unreachable legacy deploy body text as readiness evidence");
} else {
  pass("release preflight separates local preparation from blocked remote release modes");
}

const startScript = read("scripts/start.sh");
if (!startScript.includes('bash "$VOICE_BUILD_SCRIPT"')) {
  fail("start.sh does not call the isolated voice-platform build script");
}
if (startScript.includes('bash "$VOICE_BUILD_SCRIPT" --sync-db')) {
  fail("start.sh automatically enables voice-platform database synchronization");
}
if (/if \[ ! -d "\.next" \]; then[\s\S]{0,600}pnpm\s+(?:install|next\s+build)/u.test(startScript)) {
  fail("start.sh still performs a non-isolated voice-platform build");
} else {
  pass("voice-platform missing-build path uses the isolated builder without database sync");
}

const voiceBuild = read("scripts/build-voice-platform.sh");
for (const marker of ["SYNC_DB=0", "--ignore-workspace", "--sync-db", "prisma db push"] ) {
  if (!voiceBuild.includes(marker)) fail(`voice build is missing marker: ${marker}`);
}
if (voiceBuild.includes("--accept-data-loss")) {
  fail("voice build allows destructive database synchronization");
} else {
  pass("voice build defaults database synchronization to disabled");
}

const versionRoute = read("src/app/api/version/route.ts");
for (const marker of [
  "DEPLOY_COMMIT_SHA",
  "RELEASE_ID",
  "safeDeployCommitSha",
  "safeReleaseId",
  "deployCommitSha",
  "releaseId",
  "buildId",
]) {
  if (!versionRoute.includes(marker)) fail(`version route is missing safe release metadata marker: ${marker}`);
}
try {
  JSON.parse(read("public/version.json"));
  pass("public/version.json remains valid JSON");
} catch (error) {
  fail(`public/version.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`);
  console.error(`Local release chain verification failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log("Local release chain verification passed without network, database, build, or deployment actions.");
