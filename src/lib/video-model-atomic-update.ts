import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type Database = ReturnType<typeof getSupabaseAdminClient>;
type Row = Record<string, unknown>;

// Counters are deliberately excluded: a completed task must not prevent a
// configuration edit or have its accounting overwritten by that edit.
const CONFIGURATION_FIELDS = [
  "name", "provider", "api_endpoint", "api_key", "protocol_type",
  "request_template", "response_mapping", "price_per_use", "currency",
  "duration_seconds", "max_duration", "supports_image_input", "is_active",
  "sort_order", "admin_notes", "model_name", "cost_price", "is_hidden",
  "billing_mode", "token_billing_enabled", "input_cost_per_million",
  "output_cost_per_million", "profit_margin", "token_rounding_unit",
  "cost_per_use", "api_protocol_config", "requires_image",
] as const;

/** Send the comparison in a POST body, never a potentially huge gateway URL. */
export function updateVideoModelAtomic(db: Database, current: Row, updates: Row) {
  const { id, ...patch } = updates;
  if (id !== undefined && String(id) !== String(current.id)) throw new Error("VIDEO_MODEL_ID_MISMATCH");
  const expected = Object.fromEntries(CONFIGURATION_FIELDS
    .filter(field => current[field] !== undefined)
    .map(field => [field, current[field]]));
  return db.rpc("update_video_model_configuration_atomic", {
    p_model_id: String(current.id),
    p_expected: expected,
    p_updates: patch,
  }).abortSignal(AbortSignal.timeout(15_000)).maybeSingle();
}
