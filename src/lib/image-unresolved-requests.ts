export const IMAGE_UNRESOLVED_REFERENCE_SCHEMA = "image_unresolved_request_reference.v1" as const;
export const IMAGE_UNRESOLVED_REQUEST_LIMIT = 100;

export type ImageUnresolvedRecoveryState =
  | "processing"
  | "provider_completed_pending_delivery"
  | "unknown";

export type ImageUnresolvedRequestReference = {
  schema: typeof IMAGE_UNRESOLVED_REFERENCE_SCHEMA;
  generationKey: string;
  generationTraceId: string;
  state: ImageUnresolvedRecoveryState;
  updatedAt: string;
};

export type ImageUnresolvedRequestRow = {
  client_idempotency_key: unknown;
  client_trace_id: unknown;
  payload_fingerprint: unknown;
  state: unknown;
  response: unknown;
  delivery_state: unknown;
  delivery_asset_id: unknown;
  updated_at: unknown;
};

const STABLE_KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const RECOVERY_STATES = new Set<ImageUnresolvedRecoveryState>([
  "processing",
  "provider_completed_pending_delivery",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundTerminalRejection(row: ImageUnresolvedRequestRow) {
  return row.state === "failed_unknown"
    && typeof row.payload_fingerprint === "string"
    && Boolean(parseImageRequestRejectionReceipt(row.response, row.payload_fingerprint));
}

/**
 * Convert a private request row into the smallest browser-safe recovery pointer.
 * Prompt text, request snapshots, provider results, billing data and record IDs
 * deliberately stay on the server.
 */
export function toImageUnresolvedRequestReference(
  row: ImageUnresolvedRequestRow,
): ImageUnresolvedRequestReference | null {
  const generationKey = typeof row.client_idempotency_key === "string" ? row.client_idempotency_key : "";
  const generationTraceId = typeof row.client_trace_id === "string" ? row.client_trace_id : "";
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
  if (!STABLE_KEY.test(generationKey)
    || !STABLE_KEY.test(generationTraceId)
    || !updatedAt
    || !Number.isFinite(Date.parse(updatedAt))) return null;

  if (isBoundTerminalRejection(row)) return null;
  if (row.state === "completed"
    && row.delivery_state === "delivered"
    && typeof row.delivery_asset_id === "string"
    && row.delivery_asset_id.trim()) return null;

  let state: ImageUnresolvedRecoveryState;
  if (row.state === "failed_unknown") state = "unknown";
  else if (row.state === "completed") state = "provider_completed_pending_delivery";
  else if (row.state === "intent") {
    state = isRecord(row.response) && row.response.schema === "image_provider_checkpoint.v1"
      ? "provider_completed_pending_delivery"
      : "processing";
  } else return null;

  return {
    schema: IMAGE_UNRESOLVED_REFERENCE_SCHEMA,
    generationKey,
    generationTraceId,
    state,
    updatedAt: new Date(updatedAt).toISOString(),
  };
}

export function parseImageUnresolvedRequestReferences(value: unknown): ImageUnresolvedRequestReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!isRecord(entry)
      || entry.schema !== IMAGE_UNRESOLVED_REFERENCE_SCHEMA
      || typeof entry.generationKey !== "string" || !STABLE_KEY.test(entry.generationKey)
      || typeof entry.generationTraceId !== "string" || !STABLE_KEY.test(entry.generationTraceId)
      || typeof entry.state !== "string" || !RECOVERY_STATES.has(entry.state as ImageUnresolvedRecoveryState)
      || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) return [];
    const identity = `${entry.generationKey}\u0000${entry.generationTraceId}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{
      schema: IMAGE_UNRESOLVED_REFERENCE_SCHEMA,
      generationKey: entry.generationKey,
      generationTraceId: entry.generationTraceId,
      state: entry.state as ImageUnresolvedRecoveryState,
      updatedAt: new Date(entry.updatedAt).toISOString(),
    }];
  });
}
import { parseImageRequestRejectionReceipt } from "@/lib/image-request-rejection";
