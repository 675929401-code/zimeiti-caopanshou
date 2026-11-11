import { spawn } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ensureLocalDataReady } from "./local-data-readiness.mjs";
import { ensureNativePublishingReady } from "./native-publishing-readiness.mjs";
import { verifyLocalBuildFingerprintReceipt } from "./local-build-fingerprint.mjs";
import { LOCAL_PREVIEW_DATA_ROOT, LOCAL_PREVIEW_RUNTIME_FILE, validateLocalPreviewRuntime } from "./start-local-data-preview.mjs";

export const LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE = "local-acceptance";
export const LOCAL_RUNTIME_PROFILE_FORMAL_SHARED = "formal-local-shared";

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "::", "::1", "0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1"]);

function requiredEnvironmentValue(value, code) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(code);
  return value.trim();
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  return LOOPBACK_HOSTS.has(normalized)
    || normalized.endsWith(".localhost")
    || /^127(?:\.|$)/u.test(normalized)
    || /^::ffff:127(?:\.|$)/u.test(normalized)
    || /^::ffff:7f[0-9a-f]{2}(?::|$)/u.test(normalized);
}

function remoteHttpsUrl(value, requiredCode, invalidCode, insecureCode) {
  const raw = requiredEnvironmentValue(value, requiredCode);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(invalidCode);
  }
  if (!parsed.hostname || parsed.protocol !== "https:" || parsed.username || parsed.password || isLoopbackHostname(parsed.hostname)) {
    throw new Error(insecureCode);
  }
  return parsed;
}

export function resolveLocalRuntimeProfile(env = process.env) {
  const requested = env.LOCAL_RUNTIME_PROFILE?.trim();
  if (!requested || requested === LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE) return LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE;
  if (requested === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED) return LOCAL_RUNTIME_PROFILE_FORMAL_SHARED;
  throw new Error("LOCAL_RUNTIME_PROFILE_INVALID");
}

export function validateFormalLocalSharedConfiguration(env = process.env) {
  if (env.SHARED_CONFIGURATION_ENABLED !== "1") throw new Error("FORMAL_LOCAL_SHARED_CONFIGURATION_DISABLED");
  const id = requiredEnvironmentValue(env.SHARED_CONFIGURATION_ID, "FORMAL_LOCAL_SHARED_CONFIGURATION_ID_REQUIRED");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error("FORMAL_LOCAL_SHARED_CONFIGURATION_ID_INVALID");
  const key = requiredEnvironmentValue(env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY, "FORMAL_LOCAL_SHARED_CONFIGURATION_KEY_REQUIRED");
  const parsed = remoteHttpsUrl(
    env.SHARED_CONFIGURATION_SUPABASE_URL,
    "FORMAL_LOCAL_SHARED_CONFIGURATION_URL_REQUIRED",
    "FORMAL_LOCAL_SHARED_CONFIGURATION_URL_INVALID",
    "FORMAL_LOCAL_SHARED_CONFIGURATION_REQUIRES_REMOTE_HTTPS",
  );
  const businessServiceRoleKey = requiredEnvironmentValue(
    env.COZE_SUPABASE_SERVICE_ROLE_KEY,
    "FORMAL_LOCAL_CLOUD_SERVICE_ROLE_KEY_REQUIRED",
  );
  const businessAnonKey = requiredEnvironmentValue(
    env.COZE_SUPABASE_ANON_KEY,
    "FORMAL_LOCAL_CLOUD_ANON_KEY_REQUIRED",
  );
  const jwtSecret = requiredEnvironmentValue(env.JWT_SECRET, "FORMAL_LOCAL_CLOUD_JWT_SECRET_REQUIRED");
  const databaseUrl = requiredEnvironmentValue(env.DATABASE_URL, "FORMAL_LOCAL_CLOUD_DATABASE_URL_REQUIRED");
  const parsedBusinessUrl = remoteHttpsUrl(
    env.COZE_SUPABASE_URL,
    "FORMAL_LOCAL_CLOUD_BUSINESS_URL_REQUIRED",
    "FORMAL_LOCAL_CLOUD_BUSINESS_URL_INVALID",
    "FORMAL_LOCAL_CLOUD_BUSINESS_REQUIRES_REMOTE_HTTPS",
  );
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("FORMAL_LOCAL_CLOUD_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)
    || !parsedDatabaseUrl.hostname
    || isLoopbackHostname(parsedDatabaseUrl.hostname)
    || !["require", "verify-ca", "verify-full"].includes(parsedDatabaseUrl.searchParams.get("sslmode") || "")
  ) {
    throw new Error("FORMAL_LOCAL_CLOUD_DATABASE_REQUIRES_REMOTE_TLS");
  }
  return {
    id,
    url: parsed.toString(),
    key,
    businessUrl: parsedBusinessUrl.toString(),
    businessServiceRoleKey,
    businessAnonKey,
    jwtSecret,
    databaseUrl: parsedDatabaseUrl.toString(),
  };
}

export function shouldStartLocalDataServices(env = process.env) {
  return resolveLocalRuntimeProfile(env) === LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE;
}

export function localRuntimeProfileStatus(env = process.env) {
  const runtimeProfile = resolveLocalRuntimeProfile(env);
  if (runtimeProfile === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED) validateFormalLocalSharedConfiguration(env);
  return {
    runtimeProfile,
    businessData: runtimeProfile === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED ? "shared-cloud" : "local-loopback",
    authentication: runtimeProfile === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED ? "shared-cloud" : "local-acceptance",
    configuration: runtimeProfile === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED ? "shared-cloud" : "local-acceptance",
    sharedConfigurationEnabled: env.SHARED_CONFIGURATION_ENABLED === "1",
    sharedConfigurationIdConfigured: Boolean(env.SHARED_CONFIGURATION_ID?.trim()),
  };
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function firstExistingFile(paths) {
  return paths.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function ensureLinkedDirectory(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    console.warn(`[run-start] symlink failed for ${target}; copying instead. ${error instanceof Error ? error.message : ""}`);
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  }
}

function standaloneServer(root) {
  const standaloneRoot = path.join(root, ".next", "standalone");
  const serverPath = path.join(standaloneRoot, "server.js");
  if (!fs.existsSync(serverPath)) {
    throw new Error("[run-start] .next/standalone/server.js is missing. Run the production build first.");
  }
  ensureLinkedDirectory(path.join(root, ".next", "static"), path.join(standaloneRoot, ".next", "static"));
  ensureLinkedDirectory(path.join(root, "public"), path.join(standaloneRoot, "public"));
  return serverPath;
}

export function createLocalStandaloneDatabaseEnv(runtime, baseEnv = process.env) {
  const local = validateLocalPreviewRuntime(runtime);
  return {
    ...baseEnv,
    COZE_SUPABASE_URL: local.supabaseUrl,
    COZE_SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey,
    COZE_SUPABASE_ANON_KEY: local.anonKey,
    JWT_SECRET: local.jwtSecret,
    DATABASE_URL: local.databaseUrl,
    // Local acceptance must exercise the required shared-configuration path
    // against the validated loopback database. Do not inherit a cloud shared
    // configuration URL from .env.local into the local 5000 process.
    SHARED_CONFIGURATION_ENABLED: "1",
    SHARED_CONFIGURATION_SUPABASE_URL: local.supabaseUrl,
    SHARED_CONFIGURATION_SERVICE_ROLE_KEY: local.serviceRoleKey,
    SHARED_CONFIGURATION_ID: LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE,
    LOCAL_RUNTIME_PROFILE: LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE,
    NODE_ENV: "production",
    LOCAL_ACCEPTANCE_PREVIEW: "true",
    LOCAL_VALIDATION_DIST_DIR: ".next-local-acceptance",
    // 不固定 Cloudflare DoH：本网络直连 DoH 不可达，供应商结果下载必须走系统 DNS。
    AUTODL_H3_LIFECYCLE_ENABLED: "false",
    MEDIA_QUEUE_WORKER_PROCESS: "1",
    DIGITAL_VIDEO_QUEUE_WORKER: "1",
    DIGITAL_HUMAN_LONG_WORKER: "1",
  };
}

export function createFormalLocalSharedDatabaseEnv(_runtime, baseEnv = process.env) {
  const shared = validateFormalLocalSharedConfiguration(baseEnv);
  return {
    ...baseEnv,
    COZE_SUPABASE_URL: shared.businessUrl,
    COZE_SUPABASE_SERVICE_ROLE_KEY: shared.businessServiceRoleKey,
    COZE_SUPABASE_ANON_KEY: shared.businessAnonKey,
    JWT_SECRET: shared.jwtSecret,
    DATABASE_URL: shared.databaseUrl,
    SHARED_CONFIGURATION_ENABLED: "1",
    SHARED_CONFIGURATION_SUPABASE_URL: shared.url,
    SHARED_CONFIGURATION_SERVICE_ROLE_KEY: shared.key,
    SHARED_CONFIGURATION_ID: shared.id,
    LOCAL_RUNTIME_PROFILE: LOCAL_RUNTIME_PROFILE_FORMAL_SHARED,
    NODE_ENV: "production",
    LOCAL_ACCEPTANCE_PREVIEW: "false",
    LOCAL_VALIDATION_DIST_DIR: ".next",
    AUTODL_H3_LIFECYCLE_ENABLED: "false",
    // A formal local client is an interactive cloud client, not an additional
    // production worker host. Background queues remain owned by the server.
    MEDIA_QUEUE_WORKER_PROCESS: "0",
    DIGITAL_VIDEO_QUEUE_WORKER: "0",
    DIGITAL_HUMAN_LONG_WORKER: "0",
  };
}

export function createLocalRuntimeDatabaseEnv(runtime, baseEnv = process.env) {
  return resolveLocalRuntimeProfile(baseEnv) === LOCAL_RUNTIME_PROFILE_FORMAL_SHARED
    ? createFormalLocalSharedDatabaseEnv(runtime, baseEnv)
    : createLocalStandaloneDatabaseEnv(runtime, baseEnv);
}

function readLocalStandaloneRuntime() {
  try {
    const runtimeFile = process.env.LOCAL_PREVIEW_RUNTIME_FILE?.trim() || LOCAL_PREVIEW_RUNTIME_FILE;
    return JSON.parse(fs.readFileSync(runtimeFile, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("LOCAL_STANDALONE_RUNTIME_CONFIG_READ_FAILED");
  }
}

function localProductionPreviewEnv(root, runtime, baseEnv = process.env) {
  const localDatabaseEnv = createLocalRuntimeDatabaseEnv(runtime, baseEnv);
  let catalogOriginIP = baseEnv.FORMAL_CATALOG_ORIGIN_IP;
  if (!catalogOriginIP && localDatabaseEnv.LOCAL_RUNTIME_PROFILE === LOCAL_RUNTIME_PROFILE_LOCAL_ACCEPTANCE) {
    const deploymentFile = path.join(root, "deploy", "environments", "production.env.example");
    if (fs.existsSync(deploymentFile)) {
      const target = /^DEPLOY_SSH_TARGET=(?:[^@\s]+@)?([^\s#]+)\s*$/m.exec(fs.readFileSync(deploymentFile, "utf8"))?.[1];
      if (target && isIP(target)) catalogOriginIP = target;
    }
  }
  const runtimeDir = ensureDirectory(path.join(root, ".runtime"));
  const voiceSqlitePath = baseEnv.VOICE_SQLITE_PATH?.trim()
    || firstExistingFile([
      path.join(root, "voice-platform", "prisma", "dev.db"),
      path.join(root, "voice-platform", "dev.db"),
    ]);
  if (!voiceSqlitePath) {
    throw new Error("[run-start] local production preview requires an existing Voice SQLite database.");
  }
  const nodeDirectory = path.dirname(process.execPath);
  const currentPath = baseEnv.Path || baseEnv.PATH || "";
  const nextPath = currentPath.split(path.delimiter).includes(nodeDirectory)
    ? currentPath
    : `${nodeDirectory}${path.delimiter}${currentPath}`;
  const commerceDataDir = ensureDirectory(path.win32.join(LOCAL_PREVIEW_DATA_ROOT, "preview-runtime", "commerce-agent"));
  const commerceDiscoveryCatalog = path.win32.join(LOCAL_PREVIEW_DATA_ROOT, "preview-runtime", "commerce-discovery", "catalog.json");
  return {
    ...localDatabaseEnv,
    ...(catalogOriginIP ? { FORMAL_CATALOG_ORIGIN_IP: catalogOriginIP } : {}),
    // The standalone server runs with cwd=.next/standalone. Keep the verified
    // F-drive source root explicit so local runtime gates never resolve files
    // against the packaged working directory by accident.
    LOCAL_ACCEPTANCE_SOURCE_ROOT: root,
    APP_DATA_DIR: baseEnv.APP_DATA_DIR || ensureDirectory(path.join(root, "data")),
    // 主站与独立 5048 各自持有 SQLite；两端只通过受控网关通信。
    COMMERCE_DATA_DIR: commerceDataDir,
    COMMERCE_DISCOVERY_CATALOG: commerceDiscoveryCatalog,
    COMMERCE_GATEWAY_KEY_FILE: path.join(commerceDataDir, "main-gateway.key"),
    APP_RUNTIME_DIR: ensureDirectory(baseEnv.APP_RUNTIME_DIR || runtimeDir),
    IDEMPOTENCY_DIR: ensureDirectory(baseEnv.IDEMPOTENCY_DIR || path.join(runtimeDir, "llm-request-idempotency")),
    BACKUP_DIR: ensureDirectory(baseEnv.BACKUP_DIR || path.join(root, "backups")),
    VOICE_SQLITE_PATH: voiceSqlitePath,
    Path: nextPath,
    PATH: nextPath,
  };
}

function loadLocalPreviewEnvironment(root) {
  for (const relativePath of [".env.production.local", ".env.local", ".env.production", ".env"]) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    process.loadEnvFile(filePath);
  }
}

function run(command, args, options = {}) {
  // 本地预览的供应商下载必须直连：先合并完所有 env 来源，最后统一剥离代理变量，
  // 否则 options.env 展开的 baseEnv 会把 HTTPS_PROXY/NO_PROXY 带回来（TOS/COS 经代理必失败）。
  const directEnv = {
    ...process.env,
    ...options.env,
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    delete directEnv[key];
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...directEnv, NO_PROXY: "*", no_proxy: "*" },
    cwd: options.cwd || process.cwd(),
    shell: options.shell || false,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[run-start] terminated by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  }
}

async function main() {
  if (process.platform === "win32") {
    const port = process.env.DEPLOY_RUN_PORT || process.env.PORT || "5000";
    const root = process.cwd();
    loadLocalPreviewEnvironment(root);
    const startLocalDataServices = shouldStartLocalDataServices(process.env);
    const runtime = startLocalDataServices
      ? readLocalStandaloneRuntime()
      : null;
    const sourceIdentity = verifyLocalBuildFingerprintReceipt(root, ".next/local-source-fingerprint.v1.json");
    const serverPath = standaloneServer(root);
    console.log(`[run-start] Windows detected: starting current-source standalone BUILD_ID=${sourceIdentity.buildId} on port ${port}.`);
    const env = {
      ...localProductionPreviewEnv(root, runtime),
      PORT: port,
      HOSTNAME: "127.0.0.1",
    };
    console.log(`[run-start] runtime profile ${JSON.stringify(localRuntimeProfileStatus(env))}`);
    if (startLocalDataServices) {
      const data = await ensureLocalDataReady({
        executable: process.execPath,
        cwd: root,
        env,
      }, { restore: true });
      if (data.restored) {
        console.log("[run-start] F-drive local database and REST services restored and verified.");
      }
    }
    const native = await ensureNativePublishingReady({ cwd: root, executable: process.execPath });
    console.log(`[run-start] original publishing UI verified BUILD_ID=${native.nativeBuildId}.`);
    run(process.execPath, [serverPath], {
      cwd: path.dirname(serverPath),
      env,
    });
    return;
  }

  console.log("[run-start] POSIX detected: using deployment start.sh.");
  run("bash", ["./scripts/start.sh"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[run-start] REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
