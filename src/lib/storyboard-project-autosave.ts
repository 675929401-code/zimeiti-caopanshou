/** Compare business changes without turning every monitoring tick into a write.
 * The actual saved document still contains all monitoring fields. */
export function storyboardProjectAutosaveFingerprint(document: unknown): string {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  delete copy.updatedAt;
  if (Array.isArray(copy.cards)) for (const card of copy.cards as Array<Record<string, unknown>>) {
    for (const key of ["videoLastCheckedAt", "videoPollFailures", "videoStatusDetail", "videoProgress", "imageValidatedAt"]) delete card[key];
    if (card.videoLifecycle && typeof card.videoLifecycle === "object") {
      const lifecycle = card.videoLifecycle as Record<string, unknown>;
      for (const key of ["observedAt", "idleRemainingSeconds", "progress"]) delete lifecycle[key];
    }
  }
  return JSON.stringify(copy);
}

export const STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS = 5_000;
export const STORYBOARD_MONITOR_CHECKPOINT_MS = 30_000;
