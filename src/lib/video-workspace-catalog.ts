import type { WorkspaceModelSurface } from "./workspace-model-policy";
import { isWorkspaceModelAssigned, type WorkspaceModelAssignmentOverrides } from "./workspace-model-assignment-settings";

/** Commerce routes share a resource pool. Only explicitly assigned channels enter the internal catalog. */
export function commerceVideoCatalogSurface(overrides: WorkspaceModelAssignmentOverrides, row: Record<string, unknown>): WorkspaceModelSurface | null {
  if (isWorkspaceModelAssigned(overrides, "video", row, "commerce-generation-video")) return "commerce-generation-video";
  if (isWorkspaceModelAssigned(overrides, "video", row, "commerce-video")) return "commerce-video";
  return null;
}

/** These catalogues may display assigned models whose input is unavailable here. */
export function isVideoCatalogDisplaySurface(surface: unknown): boolean {
  return surface === "publish-center-video" || surface === "storyboard-video" || surface === "video-page";
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
