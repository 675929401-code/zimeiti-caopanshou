export interface AutodlH3RuntimeInstallResult {
  installed: boolean;
  reason: string;
}

/** Keep lifecycle startup fail-closed when production adapters are unavailable. */
export function shouldStartAutodlH3LifecycleWorker(
  result: AutodlH3RuntimeInstallResult,
): boolean {
  return result.installed === true || result.reason === "already-installed";
}
