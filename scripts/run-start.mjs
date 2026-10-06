import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ensureLocalDataReady } from "./local-data-readiness.mjs";
import { verifyLocalBuildFingerprintReceipt } from "./local-build-fingerprint.mjs";
import { LOCAL_PREVIEW_DATA_ROOT, LOCAL_PREVIEW_RUNTIME_FILE, validateLocalPreviewRuntime } from "./start-local-data-preview.mjs";

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

function readLocalStandaloneRuntime() {
  try {
    const runtimeFile = process.env.LOCAL_PREVIEW_RUNTIME_FILE?.trim() || LOCAL_PREVIEW_RUNTIME_FILE;
    return JSON.parse(fs.readFileSync(runtimeFile, "utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("LOCAL_STANDALONE_RUNTIME_CONFIG_READ_FAILED");
  }
}

function localProductionPreviewEnv(root, runtime, baseEnv = process.env) {
  const localDatabaseEnv = createLocalStandaloneDatabaseEnv(runtime, baseEnv);
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
  const { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ALL_PROXY, all_proxy, ...directEnv } = {
    ...process.env,
    ...options.env,
  };
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
    const runtime = readLocalStandaloneRuntime();
    const sourceIdentity = verifyLocalBuildFingerprintReceipt(root, ".next/local-source-fingerprint.v1.json");
    const serverPath = standaloneServer(root);
    console.log(`[run-start] Windows detected: starting current-source standalone BUILD_ID=${sourceIdentity.buildId} on port ${port}.`);
    const env = {
      ...localProductionPreviewEnv(root, runtime),
      PORT: port,
      HOSTNAME: "127.0.0.1",
    };
    const data = await ensureLocalDataReady({
      executable: process.execPath,
      cwd: root,
      env,
    }, { restore: true });
    if (data.restored) {
      console.log("[run-start] F-drive local database and REST services restored and verified.");
    }
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
