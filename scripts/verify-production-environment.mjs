#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const jsonMode = args.includes("--json") || args.includes("--machine");
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const topologyPath = path.join(root, "deploy", "environments", "production-topology.template.json");
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const topology = fs.existsSync(topologyPath) ? JSON.parse(fs.readFileSync(topologyPath, "utf8")) : {};
const releaseRepo = path.resolve(
  process.env.RELEASE_REPO
    || path.join(root, "..", "Git发布仓", "zimeiti-caopanshou-source-vnext"),
);
const gitBin = process.env.GIT_BIN || "git";
const envFile = valueOf("--env-file");

function valueOf(name) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) return args[index + 1].trim();
  return "";
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || root,
    encoding: "utf8",
    windowsHide: true,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : null,
  };
}

function parseEnvFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { __error: `env file not found: ${resolved}` };
  }
  const parsed = {};
  for (const rawLine of fs.readFileSync(resolved, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    parsed[key] = rawValue.replace(/^["']|["']$/gu, "").trim();
  }
  return parsed;
}

const envFileValues = parseEnvFile(envFile);
const getEnv = (name) => process.env[name] ?? envFileValues[name] ?? "";

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized
    || normalized.includes("<")
    || normalized.includes(">")
    || normalized.includes("example.invalid")
    || normalized.includes("example/")
    || normalized.includes("your-")
    || normalized.includes("xxx")
    || normalized === "todo"
    || normalized === "changeme";
}

function isLocalPath(value) {
  return /^[a-zA-Z]:[\\/]/u.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("/")
    || value.includes("\\");
}

function remoteHost(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  if (!value || isLocalPath(value)) return null;
  if (value.includes("://")) {
    try {
      const parsed = new URL(value);
      if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || parsed.password) return null;
      if (parsed.protocol === "https:" && parsed.username) return null;
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const scpLike = /^([^@:]+@)?([^:/]+):[^:]+$/u.exec(value);
  return scpLike ? scpLike[2].toLowerCase() : null;
}

function safeUrlSummary(value) {
  if (!value) return { configured: false, host: null, protocol: null };
  try {
    const parsed = new URL(value);
    return { configured: true, host: parsed.hostname, protocol: parsed.protocol.replace(/:$/u, "") };
  } catch {
    return { configured: true, host: "invalid-url", protocol: null };
  }
}

function linuxAbsolutePathOk(value) {
  if (!value || !value.startsWith("/")) return false;
  if (["/", "/root", "/home", "/srv", "/var", "/www"].includes(value.replace(/\/+$/u, "") || "/")) return false;
  return !value.includes("..") && !value.includes("\\");
}

function parseSshTarget(value) {
  const match = /^([a-z_][a-z0-9_-]*)@([A-Za-z0-9.-]+)$/u.exec(String(value || "").trim());
  if (!match) return { configured: Boolean(value), valid: false, user: null, host: null };
  return { configured: true, valid: true, user: match[1], host: match[2], rootUser: match[1] === "root" };
}

function readReleaseRemotes() {
  if (!fs.existsSync(path.join(releaseRepo, ".git"))) return [];
  return run(gitBin, ["remote"], { cwd: releaseRepo }).stdout
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => {
      const url = run(gitBin, ["remote", "get-url", name], { cwd: releaseRepo }).stdout.trim();
      return { name, host: remoteHost(url) || "local" };
    });
}

const checks = [];
function add(name, passed, severity, detail, data = {}) {
  checks.push({ name, passed, severity, detail, data });
}

if (envFileValues.__error) {
  add("env-file", false, "blocker", envFileValues.__error);
} else {
  add("env-file", true, "pass", envFile ? "optional env file loaded without printing secrets" : "no env file supplied; using process environment only");
}

const remotes = readReleaseRemotes();
const requiredRemoteNames = policy.git?.requiredRemotes || ["origin", "backup"];
const requiredRemotes = remotes.filter((remote) => requiredRemoteNames.includes(remote.name));
const missingRemotes = requiredRemoteNames.filter((name) => !requiredRemotes.some((remote) => remote.name === name));
const remoteHosts = new Set(requiredRemotes.map((remote) => remote.host));
const envOrigin = getEnv("RELEASE_ORIGIN_URL");
const envBackup = getEnv("RELEASE_BACKUP_URL");
add(
  "git-formal-remotes",
  missingRemotes.length === 0
    && (!policy.git?.requireDistinctRemoteHosts || remoteHosts.size === requiredRemoteNames.length)
    && !requiredRemotes.some((remote) => remote.host === "local"),
  "blocker",
  missingRemotes.length
    ? `missing release repo remotes: ${missingRemotes.join(", ")}`
    : "formal release remotes are configured",
  {
    releaseRepo,
    remotes,
    envOriginReady: Boolean(remoteHost(envOrigin) && !isPlaceholder(envOrigin)),
    envBackupReady: Boolean(remoteHost(envBackup) && !isPlaceholder(envBackup)),
  },
);

const databaseEnvNames = policy.database?.migrationDatabaseUrlEnv || ["DEPLOY_DATABASE_URL", "SUPABASE_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL"];
const databaseCandidates = databaseEnvNames.map((name) => ({ name, value: getEnv(name) })).filter((item) => item.value);
const databaseUrl = databaseCandidates[0];
const dbSummary = safeUrlSummary(databaseUrl?.value || "");
add(
  "database-migration-url",
  Boolean(databaseUrl && dbSummary.host && dbSummary.host !== "invalid-url" && !isPlaceholder(databaseUrl.value)),
  "blocker",
  databaseUrl ? `database url configured via ${databaseUrl.name}` : "database migration url is missing",
  { envName: databaseUrl?.name || null, ...dbSummary },
);

const sshTarget = parseSshTarget(getEnv("DEPLOY_SSH_TARGET"));
const sshPort = getEnv("DEPLOY_SSH_PORT") || "22";
add(
  "server-ssh-target",
  sshTarget.valid && /^\d{1,5}$/u.test(sshPort) && Number(sshPort) > 0 && Number(sshPort) <= 65535 && !isPlaceholder(getEnv("DEPLOY_SSH_TARGET")),
  "blocker",
  sshTarget.valid ? `server ssh target configured for ${sshTarget.user}@${sshTarget.host}:${sshPort}` : "DEPLOY_SSH_TARGET must be user@host",
  { configured: sshTarget.configured, user: sshTarget.user, host: sshTarget.host, port: sshPort, rootUser: sshTarget.rootUser },
);
if (sshTarget.rootUser) {
  add("server-ssh-user-policy", true, "warning", "root ssh target is usable only as a transitional deployment identity; prefer a locked deploy user", { user: "root" });
}

const releaseRoot = getEnv("DEPLOY_RELEASE_ROOT") || getEnv("RELEASE_ROOT");
const incomingDir = getEnv("DEPLOY_INCOMING_DIR");
const releaseRootSafe = linuxAbsolutePathOk(releaseRoot) && releaseRoot === "/data/web";
const incomingDirSafe = linuxAbsolutePathOk(incomingDir) && incomingDir === "/data/direct-deploy/incoming";
add(
  "server-release-root",
  releaseRootSafe,
  "blocker",
  releaseRootSafe ? "release root is fixed under the verified /data mount" : "DEPLOY_RELEASE_ROOT/RELEASE_ROOT must be exactly /data/web",
  { releaseRoot: releaseRoot || null },
);
add(
  "server-incoming-dir",
  incomingDirSafe,
  "blocker",
  incomingDirSafe ? "incoming artifacts remain under the verified /data mount" : "DEPLOY_INCOMING_DIR must be exactly /data/direct-deploy/incoming",
  { incomingDir: incomingDir || null },
);

for (const [name, fallback] of [
  ["APP_DATA_DIR", `${releaseRoot}/shared/data`],
  ["APP_RUNTIME_DIR", `${releaseRoot}/shared/runtime`],
  ["COMMERCE_DATA_DIR", `${releaseRoot}/shared/runtime/commerce-agent`],
  ["COMMERCE_DISCOVERY_CATALOG", `${releaseRoot}/shared/runtime/commerce-discovery/catalog.json`],
  ["COMMERCE_GATEWAY_KEY_FILE", `${releaseRoot}/shared/runtime/commerce-agent/main-gateway.key`],
  ["IDEMPOTENCY_DIR", `${releaseRoot}/shared/runtime/llm-request-idempotency`],
  ["BACKUP_DIR", `${releaseRoot}/shared/backups`],
  ["STORAGE_LOCAL_BASE_PATH", `${releaseRoot}/shared/uploads`],
  ["PUBLIC_ASSET_ROOT", `${releaseRoot}/shared/assets/current/public`],
  ["VOICE_SQLITE_PATH", `${releaseRoot}/shared/voice/voice.db`],
  ["VOICE_REFERENCE_AUDIO_DIR", `${releaseRoot}/shared/voice/reference-audio`],
]) {
  const configuredValue = getEnv(name);
  const value = configuredValue || (releaseRootSafe ? fallback : "");
  const pathOk = linuxAbsolutePathOk(value)
    && (value === "/data/web/shared" || value.startsWith("/data/web/shared/"));
  add(
    `runtime-path:${name}`,
    pathOk,
    "blocker",
    `${name} ${pathOk ? "is scoped" : "is missing or unsafe"}`,
    { path: value || null },
  );
}

const assetMode = (getEnv("ASSET_DELIVERY_MODE") || "disk").toLowerCase();
const storageDriver = (getEnv("ASSET_STORAGE_DRIVER") || assetMode || "disk").toLowerCase();
add(
  "asset-storage-mode",
  ["disk", "cos", "auto"].includes(assetMode) && ["disk", "cos"].includes(storageDriver),
  "blocker",
  `asset mode=${assetMode}, storage=${storageDriver}`,
  { assetMode, storageDriver, selectedShortTerm: topology.assets?.shortTerm?.strategy, selectedLongTerm: topology.assets?.longTerm?.strategy },
);
if (storageDriver === "cos" || assetMode === "cos") {
  const cosRequired = ["COS_BUCKET", "COS_REGION", "COS_CDN_BASE_URL", "COS_PUBLIC_ASSET_PREFIX"];
  const missingCos = cosRequired.filter((name) => isPlaceholder(getEnv(name)));
  add(
    "cos-cdn-config",
    missingCos.length === 0,
    "blocker",
    missingCos.length ? `missing COS/CDN config: ${missingCos.join(", ")}` : "COS/CDN public asset config is present",
    { missing: missingCos, cdnHost: safeUrlSummary(getEnv("COS_CDN_BASE_URL")).host },
  );
} else {
  add("cos-cdn-config", true, "pass", "COS/CDN not required while ASSET_STORAGE_DRIVER=disk");
}

const blockers = checks.filter((check) => check.severity === "blocker" && !check.passed);
const warnings = checks.filter((check) => check.severity === "warning");
const result = {
  ok: blockers.length === 0,
  status: blockers.length === 0 ? "PASS" : "NO_GO",
  generatedAt: new Date().toISOString(),
  releaseRepo,
  topology: {
    gitOrigin: topology.git?.primaryRemote?.recommendedProvider,
    gitBackup: topology.git?.backupRemote?.recommendedProvider,
    serverDeployMode: topology.serverDeploy?.mode,
  },
  summary: {
    blockers: blockers.length,
    warnings: warnings.length,
    passed: checks.filter((check) => check.passed).length,
  },
  checks,
  nextActions: blockers.map((check) => {
    if (check.name === "git-formal-remotes") return "Create/configure origin and backup using npm run deploy:remotes / deploy:remotes:apply.";
    if (check.name === "database-migration-url") return "Set DEPLOY_DATABASE_URL in a private env/secret location after taking a database backup.";
    if (check.name === "server-ssh-target") return "Configure DEPLOY_SSH_TARGET=user@host and ensure SSH credentials are available outside chat.";
    if (check.name === "server-release-root") return "Set DEPLOY_RELEASE_ROOT and RELEASE_ROOT to /data/web; never fall back to /srv/system disk.";
    if (check.name === "server-incoming-dir") return "Set DEPLOY_INCOMING_DIR to /data/direct-deploy/incoming.";
    if (check.name.startsWith("runtime-path:")) return `Fix ${check.name.replace("runtime-path:", "")} so it points under the release root/shared tree.`;
    if (check.name === "cos-cdn-config") return "If enabling COS, configure bucket, region, CDN base URL and public asset prefix; otherwise keep disk mode.";
    return `Fix production environment check: ${check.name}.`;
  }),
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("自媒体操盘手生产环境配置检查");
  console.log("");
  console.log(`总体结论：${result.ok ? "通过" : "暂不能生产部署"}`);
  console.log(`生成时间：${result.generatedAt}`);
  console.log("");
  for (const check of checks) {
    const icon = check.passed ? "PASS" : check.severity === "warning" ? "WARN" : "BLOCKED";
    console.log(`${icon} ${check.name}: ${check.detail}`);
  }
  if (result.nextActions.length) {
    console.log("");
    console.log("下一步：");
    for (const action of result.nextActions) console.log(`- ${action}`);
  }
  console.log("");
  console.log("安全提醒：本检查不会打印数据库密码、Git token 或 SSH 私钥；这些值只能放在本机环境变量、CI Secret 或服务器 Secret。");
}

process.exit(result.ok ? 0 : 1);
