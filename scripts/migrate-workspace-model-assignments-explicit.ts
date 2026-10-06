/**
 * Retired on 2026-09-24.
 *
 * This seed script used to rewrite the complete workspace assignment JSON and
 * could overwrite newer per-surface choices made by another administrator.
 * The current baseline is restored by restore-current-workspace-models.mjs;
 * all interactive mutations use update_workspace_model_configuration_atomic.
 */
throw new Error(
  "RETIRED_WORKSPACE_ASSIGNMENT_SEED: use scripts/restore-current-workspace-models.mjs for the approved baseline",
);