import type { WorkspaceModelSurface } from "./workspace-model-policy";

/** These catalogues may display assigned models whose input is unavailable here. */
export function isVideoCatalogDisplaySurface(surface: unknown): boolean {
  return surface === "storyboard-video" || surface === "video-page";
}

export function isVisibleInPublicWorkspace(
  model: { surfaceCompatible: boolean; maxReferenceImages: number },
  surface: WorkspaceModelSurface | null,
): boolean {
  // Assignment, hidden and retired checks happen before this projection.
  // Visibility never changes the separate compatibility/submission verdict.
  if (isVideoCatalogDisplaySurface(surface)) return true;
  if (surface && !model.surfaceCompatible) return false;
  if (surface === "commerce-video") return model.maxReferenceImages >= 5;
  return true;
}
