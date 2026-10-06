import {
  type WorkspaceModelKind,
  type WorkspaceModelSurface,
} from "@/lib/workspace-model-policy";

export const WORKSPACE_MODEL_ASSIGNMENT_SETTING_KEY = "workspace_model_assignment_overrides_v1";
export const WORKSPACE_MODEL_CANDIDATE_BLOCKS_SETTING_KEY = "workspace_model_candidate_blocks_v1";

export type WorkspaceModelAssignmentOverrides = Partial<Record<
  WorkspaceModelSurface,
  Record<string, boolean>
>>;

export type WorkspaceModelCandidateBlocks = {
  modelIds: string[];
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseWorkspaceModelAssignmentOverrides(value: unknown): WorkspaceModelAssignmentOverrides {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { parsed = {}; }
  }
  const root = object(parsed);
  const surfaces = object(root.surfaces || root);
  return Object.fromEntries(Object.entries(surfaces).map(([surface, raw]) => [
    surface,
    Object.fromEntries(Object.entries(object(raw))
      .map(([modelId, enabled]) => [modelId.trim(), enabled] as const)
      .filter(([modelId, enabled]) => modelId.length > 0 && typeof enabled === "boolean")),
  ])) as WorkspaceModelAssignmentOverrides;
}

export function serializeWorkspaceModelAssignmentOverrides(overrides: WorkspaceModelAssignmentOverrides) {
  return JSON.stringify({ version: 1, surfaces: overrides });
}

export function parseWorkspaceModelCandidateBlocks(value: unknown): WorkspaceModelCandidateBlocks {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { parsed = {}; }
  }
  const root = object(parsed);
  const source = Array.isArray(root.modelIds) ? root.modelIds : [];
  return { modelIds: [...new Set(source.map(String).map((id) => id.trim()).filter(Boolean))] };
}

export function isWorkspaceModelCandidateBlocked(blocks: WorkspaceModelCandidateBlocks, modelId: unknown) {
  return blocks.modelIds.includes(String(modelId || "").trim());
}

export function workspaceModelAssignmentOverride(
  overrides: WorkspaceModelAssignmentOverrides,
  surface: WorkspaceModelSurface,
  modelId: unknown,
): boolean | null {
  const value = overrides[surface]?.[String(modelId || "")];
  return typeof value === "boolean" ? value : null;
}

/**
 * A resource-pool model never enters a product workspace implicitly. The
 * administrator must add it to that exact surface. Removing it here only
 * removes the surface reference; it never changes the resource-pool record.
 */
export function isWorkspaceModelAssigned(
  overrides: WorkspaceModelAssignmentOverrides,
  _kind: WorkspaceModelKind,
  model: Record<string, unknown>,
  surface: WorkspaceModelSurface,
) {
  const explicit = workspaceModelAssignmentOverride(overrides, surface, model.id);
  return explicit === true;
}

export function withWorkspaceModelAssignmentOverride(
  overrides: WorkspaceModelAssignmentOverrides,
  surface: WorkspaceModelSurface,
  modelId: string,
  enabled: boolean,
): WorkspaceModelAssignmentOverrides {
  return {
    ...overrides,
    [surface]: {
      ...(overrides[surface] || {}),
      [modelId]: enabled,
    },
  };
}
