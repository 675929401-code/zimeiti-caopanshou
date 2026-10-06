import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });

// Match the deployed server's fail-closed branch without changing any files.
(process.env as Record<string, string | undefined>).NODE_ENV = "production";

async function main() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    const { storageManager } = await import("../src/storage/object");
    const status = await storageManager.getStatus();
    const safeReport = {
      audit: "storage-provider-readonly",
      defaultProvider: status.defaultProvider,
      fallbackProvider: status.fallbackProvider,
      initializedProviders: status.initializedProviders,
      runtimeMode: status.runtimeMode,
      productionSafe: status.productionSafe,
      degraded: status.degraded,
      issues: status.issues,
      cosConfigured: Boolean(
        (status.config.storage_tencent_cos_bucket || process.env.COS_BUCKET)
        && (status.config.storage_tencent_cos_secret_id || process.env.COS_SECRET_ID)
        && (status.config.storage_tencent_cos_secret_key || process.env.COS_SECRET_KEY)
      ),
      credentialsPrinted: false,
      writesPerformed: 0,
    };
    originalLog(JSON.stringify(safeReport, null, 2));
    if (!safeReport.productionSafe || safeReport.degraded) process.exitCode = 2;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

main().catch((error) => {
  console.error("storage provider audit failed:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
});
