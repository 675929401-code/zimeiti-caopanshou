const path = require("node:path");

// Production storage is rooted on the dedicated /data mount. Falling back to
// /srv would place mutable state on the system disk when an environment value
// is accidentally omitted.
const releaseRoot = process.env.RELEASE_ROOT || "/data/web";
const webRoot = process.env.WEB_RELEASE_DIR || path.join(releaseRoot, "current-web");
const voiceRoot = process.env.VOICE_RELEASE_DIR || path.join(releaseRoot, "current-voice");
const logRoot = process.env.RELEASE_LOG_DIR || path.join(releaseRoot, "shared", "logs");
const appDataDir = process.env.APP_DATA_DIR || path.join(releaseRoot, "shared", "data");
const appRuntimeDir = process.env.APP_RUNTIME_DIR || path.join(releaseRoot, "shared", "runtime");
const commerceDataDir = process.env.COMMERCE_DATA_DIR || path.join(appRuntimeDir, "commerce-agent");
const commerceDiscoveryCatalog = process.env.COMMERCE_DISCOVERY_CATALOG || path.join(appRuntimeDir, "commerce-discovery", "catalog.json");
const commerceGatewayKeyFile = process.env.COMMERCE_GATEWAY_KEY_FILE || path.join(commerceDataDir, "main-gateway.key");
const idempotencyDir = process.env.IDEMPOTENCY_DIR || path.join(appRuntimeDir, "llm-request-idempotency");
const backupDir = process.env.BACKUP_DIR || path.join(releaseRoot, "shared", "backups");
const uploadsRoot = process.env.STORAGE_LOCAL_BASE_PATH || path.join(releaseRoot, "shared", "uploads");
const publicAssetRoot = process.env.PUBLIC_ASSET_ROOT || path.join(releaseRoot, "shared", "assets", "current", "public");
const voiceDatabasePath = process.env.VOICE_SQLITE_PATH || path.join(releaseRoot, "shared", "voice", "voice.db");
const voiceReferenceAudioDir = process.env.VOICE_REFERENCE_AUDIO_DIR || path.join(releaseRoot, "shared", "voice", "reference-audio");
const voiceDatabaseUrl = process.env.VOICE_DATABASE_URL || `file:${voiceDatabasePath}`;
const assetDigest = process.env.ASSET_DIGEST || "";
const assetManifestSha256 = process.env.ASSET_MANIFEST_SHA256 || "";
const releaseId = process.env.RELEASE_ID || "";
const deployCommitSha = process.env.DEPLOY_COMMIT_SHA || "";
const expectedBuildId = process.env.EXPECTED_BUILD_ID || "";
const cozeProjectEnv = process.env.COZE_PROJECT_ENV || "PROD";
const mediaWorkerInstances = Math.max(1, Math.min(8, Number.parseInt(process.env.MEDIA_QUEUE_WORKER_INSTANCES || "2", 10) || 2));
const mediaWorkerPort = String(Math.max(1024, Math.min(65535, Number.parseInt(process.env.MEDIA_QUEUE_WORKER_PORT || "5102", 10) || 5102)));

const common = {
  interpreter: process.execPath,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  restart_delay: 5000,
  max_restarts: 10,
  kill_timeout: 15000,
  listen_timeout: 30000,
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "agent-hub-web",
      cwd: webRoot,
      script: path.join(webRoot, "server.js"),
      max_memory_restart: "1G",
      error_file: path.join(logRoot, "agent-hub-web-error.log"),
      out_file: path.join(logRoot, "agent-hub-web-out.log"),
      env_production: {
        NODE_ENV: "production",
        PORT: "5000",
        HOSTNAME: "127.0.0.1",
        RELEASE_ROOT: releaseRoot,
        APP_DATA_DIR: appDataDir,
        APP_RUNTIME_DIR: appRuntimeDir,
        COMMERCE_DATA_DIR: commerceDataDir,
        COMMERCE_DISCOVERY_CATALOG: commerceDiscoveryCatalog,
        COMMERCE_GATEWAY_KEY_FILE: commerceGatewayKeyFile,
        IDEMPOTENCY_DIR: idempotencyDir,
        BACKUP_DIR: backupDir,
        PUBLIC_ASSET_ROOT: publicAssetRoot,
        STORAGE_LOCAL_BASE_PATH: uploadsRoot,
        VOICE_SQLITE_PATH: voiceDatabasePath,
        VOICE_REFERENCE_AUDIO_DIR: voiceReferenceAudioDir,
        ASSET_DIGEST: assetDigest,
        ASSET_MANIFEST_SHA256: assetManifestSha256,
        RELEASE_ID: releaseId,
        DEPLOY_COMMIT_SHA: deployCommitSha,
        EXPECTED_BUILD_ID: expectedBuildId,
        COZE_PROJECT_ENV: cozeProjectEnv,
        RELEASE_READINESS_PROFILE: "production-full-v1",
        MEDIA_QUEUE_WORKER_PROCESS: "0",
        DIGITAL_VIDEO_QUEUE_WORKER: "0",
        DIGITAL_HUMAN_LONG_WORKER: "0",
      },
    },
    {
      ...common,
      name: "agent-hub-voice",
      cwd: voiceRoot,
      script: path.join(voiceRoot, "server.js"),
      max_memory_restart: "768M",
      error_file: path.join(logRoot, "agent-hub-voice-error.log"),
      out_file: path.join(logRoot, "agent-hub-voice-out.log"),
      env_production: {
        NODE_ENV: "production",
        PORT: "5001",
        HOSTNAME: "127.0.0.1",
        RELEASE_ROOT: releaseRoot,
        APP_DATA_DIR: appDataDir,
        APP_RUNTIME_DIR: appRuntimeDir,
        COMMERCE_DATA_DIR: commerceDataDir,
        COMMERCE_DISCOVERY_CATALOG: commerceDiscoveryCatalog,
        COMMERCE_GATEWAY_KEY_FILE: commerceGatewayKeyFile,
        IDEMPOTENCY_DIR: idempotencyDir,
        BACKUP_DIR: backupDir,
        PUBLIC_ASSET_ROOT: publicAssetRoot,
        DATABASE_URL: voiceDatabaseUrl,
        VOICE_SQLITE_PATH: voiceDatabasePath,
        VOICE_REFERENCE_AUDIO_DIR: voiceReferenceAudioDir,
        RELEASE_ID: releaseId,
        DEPLOY_COMMIT_SHA: deployCommitSha,
        EXPECTED_BUILD_ID: expectedBuildId,
        COZE_PROJECT_ENV: cozeProjectEnv,
        RELEASE_READINESS_PROFILE: "production-full-v1",
      },
    },
    {
      ...common,
      name: "agent-hub-media-worker",
      cwd: webRoot,
      script: path.join(webRoot, "server.js"),
      // Fork uses the explicitly selected Node binary even when the shared PM2
      // daemon runs an older Node for unrelated applications. Each queue worker
      // has its own loopback health port; queue coordination remains database based.
      exec_mode: "fork",
      instances: mediaWorkerInstances,
      increment_var: "PORT",
      instance_var: "MEDIA_QUEUE_WORKER_INSTANCE",
      shutdown_with_message: true,
      kill_timeout: 35000,
      max_memory_restart: "768M",
      error_file: path.join(logRoot, "agent-hub-media-worker-error.log"),
      out_file: path.join(logRoot, "agent-hub-media-worker-out.log"),
      env_production: {
        NODE_ENV: "production",
        PORT: mediaWorkerPort,
        HOSTNAME: "127.0.0.1",
        RELEASE_ROOT: releaseRoot,
        APP_DATA_DIR: appDataDir,
        APP_RUNTIME_DIR: appRuntimeDir,
        COMMERCE_DATA_DIR: commerceDataDir,
        COMMERCE_DISCOVERY_CATALOG: commerceDiscoveryCatalog,
        COMMERCE_GATEWAY_KEY_FILE: commerceGatewayKeyFile,
        IDEMPOTENCY_DIR: idempotencyDir,
        BACKUP_DIR: backupDir,
        PUBLIC_ASSET_ROOT: publicAssetRoot,
        STORAGE_LOCAL_BASE_PATH: uploadsRoot,
        VOICE_SQLITE_PATH: voiceDatabasePath,
        VOICE_REFERENCE_AUDIO_DIR: voiceReferenceAudioDir,
        ASSET_DIGEST: assetDigest,
        ASSET_MANIFEST_SHA256: assetManifestSha256,
        RELEASE_ID: releaseId,
        DEPLOY_COMMIT_SHA: deployCommitSha,
        EXPECTED_BUILD_ID: expectedBuildId,
        COZE_PROJECT_ENV: cozeProjectEnv,
        RELEASE_READINESS_PROFILE: "production-full-v1",
        MEDIA_QUEUE_WORKER_PROCESS: "1",
        MEDIA_QUEUE_WORKER_DRAIN_MS: "25000",
        DIGITAL_VIDEO_QUEUE_WORKER: "1",
        DIGITAL_HUMAN_LONG_WORKER: "1",
      },
    },
  ],
};
