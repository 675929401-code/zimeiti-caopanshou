export async function register() {
  // instrumentation is bundled for multiple runtimes. Lifecycle control is a
  // Node-only server concern and must never be pulled into Edge/browser builds.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureServerRuntimeEnvLoaded } = await import("@/lib/server-runtime-env");
  ensureServerRuntimeEnvLoaded();
  // Covers are derived files. Prune them at boot so covers of records that were
  // cleared or expired in an earlier process do not linger as orphans.
  try {
    const path = await import("node:path");
    const { resolveAppRuntimeDir } = await import("@/lib/runtime-paths");
    const { scheduleVideoThumbnailCachePrune } = await import("@/lib/video-thumbnail-cache");
    scheduleVideoThumbnailCachePrune({
      cacheRoot: path.join(resolveAppRuntimeDir(), "video-thumbnails"),
      force: true,
    });
  } catch {
    // Cache cleanup is best effort and must never block boot.
  }
  // Production queue work runs in a dedicated PM2 process built from the same
  // immutable standalone artifact. It starts at process boot and never depends
  // on a browser generation/status/history request to wake it.
  if (process.env.MEDIA_QUEUE_WORKER_PROCESS === "1") {
    const { startMediaQueueWorkerRuntime } = await import("@/lib/media-queue-worker-runtime");
    startMediaQueueWorkerRuntime();
    return;
  }
  const { shouldStartAutodlH3LifecycleWorker } = await import("@/lib/autodl-h3-runtime-start-gate");
  const { installAutodlH3ProductionRuntimeSafelyFromEnvironment } = await import("@/lib/autodl-h3-production-runtime");
  // Keep the website available when H3 lifecycle configuration is incomplete.
  // The installer reports only a fixed diagnostic and remains fail-closed.
  const installResult = installAutodlH3ProductionRuntimeSafelyFromEnvironment();
  if (!shouldStartAutodlH3LifecycleWorker(installResult)) return;
  const { startAutodlH3LifecycleWorkerFromEnvironment } = await import("@/lib/autodl-h3-lifecycle");
  startAutodlH3LifecycleWorkerFromEnvironment();
}
