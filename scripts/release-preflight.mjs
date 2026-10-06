#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--") && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    args.set(arg, process.argv[i + 1]);
    i += 1;
  } else if (arg.startsWith("--")) {
    args.set(arg, "1");
  }
}

const root = path.resolve(args.get("--root") || process.cwd());
const strictLegacy = args.get("--strict-legacy") !== "0";
const mode = args.get("--mode") || "prepare";
const supportedModes = new Set(["prepare", "publish", "deploy"]);
const releaseIgnoreFile = ".releaseignore";

if (!supportedModes.has(mode)) {
  console.error(`Unknown release preflight mode: ${mode}`);
  console.error("Expected one of: prepare, publish, deploy");
  process.exit(2);
}

const requiredFiles = [
  ".gitattributes",
  "package.json",
  "pnpm-lock.yaml",
  "next.config.ts",
  "tsconfig.json",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/api/version/route.ts",
  "scripts/git-auto-deploy.sh",
  "scripts/gitee-webhook-server.mjs",
  "scripts/release-preflight.mjs",
  "scripts/publish-gitee-full.mjs",
  "scripts/publish-gitee-full.sh",
  "scripts/build-voice-platform.sh",
  "scripts/start.sh",
  "scripts/verify-local-release-chain.mjs",
  "scripts/verify-release-security-p0.ts",
  "scripts/verify-storyboard-agent-output-import.ts",
  "voice-platform/package.json",
  "voice-platform/pnpm-lock.yaml",
  releaseIgnoreFile,
];

const forbiddenPaths = [
  ".git",
  ".next",
  "node_modules",
  ".env.local",
  ".env.production",
  "public/uploads",
  "backups/latest.json",
  "tsconfig.tsbuildinfo",
];

// 只记录路径，不读取或输出疑似凭据值。以下历史文档在完成脱敏与凭据轮换前
// 不能进入任何新代码仓；即使旧发布脚本被误启用，预检也必须阻断。
const knownSensitiveHistoryPaths = [
  "STANDARD.md",
  "docs/EMERGENCY-RESTORE.md",
];

const localOnlyReleasePaths = [
  ".npmrc",
  ".codex-artifacts",
  ".codex-backups",
  ".codex-browser",
  ".codex-designs",
  ".codex-evidence",
  ".codex-runtime",
  ".codex-runtime-backups",
  ".codex-runtime-logs",
  ".codex-screenshots",
  ".codex-snapshots",
  ".codex-staging",
  ".codex-task-snapshots",
  ".codex-temp",
  "assets",
  "backups",
  "data/generations.json",
  "public/uploads",
  "voice-platform/dev.db",
  "voice-platform/prisma/dev.db",
  "voice-platform/prisma/dev.db-shm",
  "voice-platform/prisma/dev.db-wal",
  "voice-platform/prisma/prisma/dev.db",
];

const legacyScripts = [
  "scripts/deploy.sh",
  "scripts/deploy-prod.sh",
  "scripts/deploy-full.js",
  "scripts/deploy-direct.js",
  "scripts/deploy-ssh.js",
  "scripts/deploy-tencent.sh",
  "scripts/deploy-to-tencent.sh",
  "scripts/sync-deploy.sh",
  "scripts/sync-to-server.sh",
  "scripts/git-backup.sh",
];

const blockedRemoteEntrypoints = [
  "scripts/git-auto-deploy.sh",
  "scripts/gitee-webhook-server.mjs",
  "scripts/publish-gitee-full.mjs",
  "scripts/publish-gitee-full.sh",
];

const skippedDirs = new Set([
  ".git",
  ".next",
  "node_modules",
  ".codex-designs",
  ".codex-screenshots",
  ".codex-temp",
  ".logs",
  ".rollback-voice-studio",
  ".tmp-help-audit",
  ".tmp-runtime",
  "backups",
  "tmp",
  ".tmp-e2e",
  ".secure",
  "logs",
]);

const skippedFiles = new Set([
  ".npmrc",
  ".env.local",
  ".env.production",
  "tsconfig.tsbuildinfo",
]);

const sensitivePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:const|let|var)\s+(?:API_KEY|ACCESS_KEY|SECRET_KEY(?:_B64)?|SITE_API_KEY|AUTH_SECRET|JWT_SECRET|PPT6_CLIENT_SECRET)\s*=\s*["'](?![^"']*(?:example|placeholder|your_|xxx|todo|change.?me))[^"'\r\n]{8,}["']/im,
  /process\.env\.[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET_KEY|AUTH_SECRET|JWT_SECRET|PASSWORD|TOKEN|CLIENT_SECRET)[A-Z0-9_]*\s*\|\|\s*["'](?![^"']*(?:example|placeholder|your_|xxx|todo|change.?me))[^"'\r\n]{8,}["']/im,
  /clientSecretKey\s*:\s*["'](?![^"']*(?:test|fixture|example|placeholder|dummy|your_))[A-Za-z0-9]{32,}["']/im,
  /media_ticket=eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /^COZE_SUPABASE_SERVICE_ROLE_KEY=(?!\s*$)(?!["']?\$\{)(?!.*(?:example|placeholder|your_|xxx|todo)).{12,}$/im,
  /^LLM_API_KEY=(?!\s*$)(?!["']?\$\{)(?!.*(?:example|placeholder|your_|xxx|todo)).{12,}$/im,
  /^JWT_SECRET=(?!\s*$)(?!["']?\$\{)(?!.*(?:example|placeholder|your_|xxx|todo)).{12,}$/im,
  /^(?:VOLCENGINE_API_KEY_\d+|SITE_API_KEY|AUTH_SECRET|TEST_PASSWORD|PPT6_CLIENT_SECRET)=(?!\s*$)(?!["']?\$\{)(?!.*(?:example|placeholder|your_|xxx|todo)).{8,}$/im,
  /"apiKey"\s*:\s*"(?!\s*")(?!\$\{)(?!.*(?:example|placeholder|your_|xxx|todo))[^"\r\n]{8,}"/im,
];

const failures = [];
const warnings = [];
let releaseFileCount = 0;
let releaseByteCount = 0;
const largestReleaseFiles = [];

function normalizeRelativePath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function wildcardRuleToRegExp(rule) {
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
}

const releaseIgnoreRules = fs.existsSync(path.join(root, releaseIgnoreFile))
  ? fs.readFileSync(path.join(root, releaseIgnoreFile), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
  : [];

function isReleaseIgnored(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return releaseIgnoreRules.some((rawRule) => {
    const directoryRule = rawRule.endsWith("/");
    const rule = normalizeRelativePath(rawRule);
    if (!rule) return false;
    if (directoryRule) return normalized === rule || normalized.startsWith(`${rule}/`);
    if (rule.includes("*")) return wildcardRuleToRegExp(rule).test(normalized);
    return normalized === rule;
  });
}

// Avatar aliases are part of the shipped UI contract. The database stores the
// agent record and icon URL, while these static files provide the stable local
// fallback used by the marketplace and chat sidebar. A release without them
// is incomplete even when all API records are present.
const requiredAvatarAssets = [
  "public/avatars/cute-semantic/agent-cute-01.webp",
  "public/avatars/cute-semantic/agent-cute-10.webp",
  "public/avatars/cute-semantic/agent-cute-33.webp",
  "public/avatars/agent-cyber-01.png",
];

// These files are user-visible runtime dependencies, not optional test media.
// A Git release that silently drops globally ignored video extensions would
// render the home page, Canvas and help examples as broken empty surfaces.
const requiredProductionMedia = [
  "public/youcai-media/v1/featured/homepage-hero-seedance-2.mp4",
  "public/youcai-media/v1/featured/canvas-banner-youcai.mp4",
  "public/short-drama/inspiration-media/v1/official-film-showcase-v1.mp4",
  "public/help/storyboard-video-case.mp4",
];

function rel(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

for (const file of requiredFiles) {
  if (!exists(file)) fail(`Missing required release file: ${file}`);
}

for (const asset of requiredAvatarAssets) {
  if (!exists(asset)) fail(`Missing required static avatar asset: ${asset}`);
}

for (const asset of requiredProductionMedia) {
  if (!exists(asset)) fail(`Missing required production media asset: ${asset}`);
  if (isReleaseIgnored(asset)) fail(`Required production media is excluded by ${releaseIgnoreFile}: ${asset}`);
}

for (const localPath of localOnlyReleasePaths) {
  if (exists(localPath) && !isReleaseIgnored(localPath)) {
    fail(`Local-only path is not excluded by ${releaseIgnoreFile}: ${localPath}`);
  }
}

const avatarRoot = path.join(root, "public/avatars");
if (fs.existsSync(avatarRoot)) {
  const avatarCount = fs.readdirSync(avatarRoot, { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.(?:png|jpe?g|webp|gif)$/i.test(entry)).length;
  if (avatarCount < requiredAvatarAssets.length) {
    fail(`Static avatar asset count is too low: ${avatarCount}`);
  }
}

for (const forbidden of forbiddenPaths) {
  if (exists(forbidden)) {
    if (forbidden === ".env.local") {
      warn("Local .env.local exists; publish script must exclude it from Git.");
    } else if ([".git", ".next", "node_modules", "tsconfig.tsbuildinfo"].includes(forbidden)) {
      warn(`Local-only path exists and must be excluded from release archive: ${forbidden}`);
    } else {
      warn(`Runtime data path exists and must be excluded from Git release: ${forbidden}`);
    }
  }
}

for (const sensitivePath of knownSensitiveHistoryPaths) {
  if (exists(sensitivePath) && !isReleaseIgnored(sensitivePath)) {
    fail(`Known sensitive historical file is not excluded by ${releaseIgnoreFile}: ${sensitivePath}`);
  }
}

for (const script of legacyScripts) {
  const fullPath = path.join(root, script);
  if (!fs.existsSync(fullPath)) continue;
  const text = fs.readFileSync(fullPath, "utf8");
  if (strictLegacy && !text.includes("LEGACY_DEPLOY_DISABLED")) {
    fail(`Legacy deploy entry is not disabled: ${script}`);
  }
}

const confirmedBlockedRemoteEntrypoints = [];
for (const script of blockedRemoteEntrypoints) {
  const fullPath = path.join(root, script);
  if (!fs.existsSync(fullPath)) continue;
  const text = fs.readFileSync(fullPath, "utf8");
  const disabledIndex = text.indexOf("LEGACY_DEPLOY_DISABLED");
  const blockedIndex = text.indexOf("BLOCKED:");
  const shellExitMatch = text.match(/\bexit\s+2\b/u);
  const nodeExitMatch = text.match(/process\.exit\(\s*2\s*\)/u);
  const exitIndexes = [shellExitMatch?.index, nodeExitMatch?.index]
    .filter((value) => typeof value === "number");
  const exitIndex = exitIndexes.length > 0 ? Math.min(...exitIndexes) : -1;
  if (
    disabledIndex < 0
    || blockedIndex < disabledIndex
    || exitIndex < blockedIndex
    || exitIndex > 2048
  ) {
    fail(`Remote publish/deploy entrypoint is not fail-closed near the file start: ${script}`);
    continue;
  }
  confirmedBlockedRemoteEntrypoints.push(script);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = rel(fullPath);
    if (isReleaseIgnored(relativePath)) continue;
    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name) || skippedDirs.has(relativePath)) continue;
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (skippedFiles.has(entry.name) || skippedFiles.has(relativePath)) continue;
    if (
      entry.name.endsWith(".log")
      || entry.name.includes(".tsbuildinfo")
      || [".db", ".sqlite", ".sqlite3"].includes(path.extname(entry.name).toLowerCase())
      || /-(?:wal|shm)$/u.test(entry.name)
    ) continue;
    if (/^\.env\.local/.test(entry.name) || /^\.env\.production/.test(entry.name)) continue;
    const fileStats = fs.statSync(fullPath);
    releaseFileCount += 1;
    releaseByteCount += fileStats.size;
    largestReleaseFiles.push({ path: relativePath, bytes: fileStats.size });
    largestReleaseFiles.sort((left, right) => right.bytes - left.bytes);
    if (largestReleaseFiles.length > 5) largestReleaseFiles.length = 5;
    if (fileStats.size > 2 * 1024 * 1024) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".sh") {
      const shellBytes = fs.readFileSync(fullPath);
      if (shellBytes.includes(Buffer.from("\r\n")) || shellBytes.includes(0x0d)) {
        fail(`Linux shell entrypoint uses CRLF or CR line endings: ${relativePath}`);
      }
    }
    if (![".js", ".mjs", ".ts", ".tsx", ".json", ".sh", ".md", ".txt", ".yml", ".yaml", ".env", ".example"].includes(ext) && !entry.name.startsWith(".env") && !relativePath.startsWith("scripts/")) {
      continue;
    }
    const text = fs.readFileSync(fullPath, "utf8");
    for (const pattern of sensitivePatterns) {
      if (pattern.test(text)) {
        fail(`Sensitive secret-like content found in ${relativePath}`);
      }
    }
  }
}

walk(root);

const packageJsonPath = path.join(root, "package.json");
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const scriptName of ["release:preflight", "release:prepare", "release:publish", "release:deploy", "verify:release-chain"]) {
    if (!packageJson.scripts?.[scriptName]) fail(`package.json missing script: ${scriptName}`);
  }
  const expectedReleaseCommands = {
    "release:preflight": "node ./scripts/release-preflight.mjs --mode prepare",
    "release:prepare": "node ./scripts/release-preflight.mjs --mode prepare && node ./scripts/verify-local-release-chain.mjs",
    "release:publish": "node ./scripts/release-preflight.mjs --mode publish",
    "release:deploy": "node ./scripts/release-preflight.mjs --mode deploy",
  };
  for (const [scriptName, expectedCommand] of Object.entries(expectedReleaseCommands)) {
    const actualCommand = packageJson.scripts?.[scriptName];
    if (actualCommand !== expectedCommand) {
      fail(`package.json ${scriptName} must use the fail-closed release status gate`);
    }
  }
  const scriptEntrypointPattern = /(?:^|\s)(?:node|tsx|bash)\s+(?:\.\/)?(scripts\/[A-Za-z0-9._/-]+\.(?:js|mjs|cjs|ts|tsx|sh))(?=$|\s)/gu;
  for (const [scriptName, command] of Object.entries(packageJson.scripts || {})) {
    if (typeof command !== "string") continue;
    for (const match of command.matchAll(scriptEntrypointPattern)) {
      const entrypoint = match[1];
      const entrypointPath = path.join(root, ...entrypoint.split("/"));
      if (!fs.existsSync(entrypointPath)) {
        fail(`package.json script ${scriptName} references missing entrypoint: ${entrypoint}`);
      } else if (isReleaseIgnored(entrypoint)) {
        fail(`package.json script ${scriptName} entrypoint is excluded by ${releaseIgnoreFile}: ${entrypoint}`);
      }
    }
  }
}

const storyboardVerifierPath = path.join(root, "scripts", "verify-storyboard-agent-output-import.ts");
if (fs.existsSync(storyboardVerifierPath)) {
  const storyboardVerifier = fs.readFileSync(storyboardVerifierPath, "utf8");
  if (storyboardVerifier.includes(".tmp-e2e")) {
    fail("Storyboard import verifier depends on release-excluded .tmp-e2e content");
  }
}

const voicePlatformBuildScriptPath = path.join(root, "scripts", "build-voice-platform.sh");
if (fs.existsSync(voicePlatformBuildScriptPath)) {
  const voicePlatformBuildScript = fs.readFileSync(voicePlatformBuildScriptPath, "utf8");
  for (const marker of ["--ignore-workspace", "--sync-db", "prisma db push"]) {
    if (!voicePlatformBuildScript.includes(marker)) {
      fail(`build-voice-platform.sh is missing isolation marker: ${marker}`);
    }
  }
  if (voicePlatformBuildScript.includes("--accept-data-loss")) {
    fail("build-voice-platform.sh must not allow destructive Prisma schema synchronization");
  }
  if (!voicePlatformBuildScript.includes("SYNC_DB=0")) {
    fail("build-voice-platform.sh must default database synchronization to disabled");
  }
}

const startScriptPath = path.join(root, "scripts", "start.sh");
if (fs.existsSync(startScriptPath)) {
  const startScript = fs.readFileSync(startScriptPath, "utf8");
  if (!startScript.includes('VOICE_BUILD_SCRIPT="${COZE_WORKSPACE_PATH}/scripts/build-voice-platform.sh"')) {
    fail("start.sh does not declare the isolated voice-platform build entrypoint");
  }
  if (!startScript.includes('bash "$VOICE_BUILD_SCRIPT"')) {
    fail("start.sh does not invoke build-voice-platform.sh when the voice build is absent");
  }
  if (startScript.includes('bash "$VOICE_BUILD_SCRIPT" --sync-db')) {
    fail("start.sh must not automatically synchronize the voice-platform database");
  }
  if (/if \[ ! -d "\.next" \]; then[\s\S]{0,600}pnpm\s+(?:install|next\s+build)/u.test(startScript)) {
    fail("start.sh still bypasses the isolated voice-platform build entrypoint");
  }
}

for (const message of warnings) console.warn(`WARN ${message}`);

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL ${message}`);
  console.error(`\nRelease preflight failed: ${failures.length} blocking issue(s).`);
  process.exit(1);
}

console.log(`Release inventory: ${releaseFileCount} files, ${releaseByteCount} bytes`);
console.log(`Largest release files: ${largestReleaseFiles.map((file) => `${file.path} (${file.bytes})`).join(", ")}`);
console.log(`LOCAL_PREPARE PASS: release source is self-contained for ${root}`);
console.warn(`PUBLISH_DEPLOY BLOCKED: no authorized clean origin/deploy pipeline is configured; fail-closed entrypoints: ${confirmedBlockedRemoteEntrypoints.join(", ")}`);

if (mode !== "prepare") {
  console.error(`BLOCKED release:${mode}: configure and authorize a new clean private publish/deploy pipeline before remote writes.`);
  process.exit(2);
}
