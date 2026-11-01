import { createHash } from "node:crypto";

export type PlatformCredentialChange = { model_key: string; credential_ref: string; secret_value: string };
export type PlatformCredentialMetadata = {
  modelKey: string; credentialRef: string; pendingRevision: string;
  expectedExists: boolean; expectedRevision: string | null; state: "pending" | "applied";
};
export const MODEL_MUTATION_REQUEST_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** A lost response must not turn the same logical create request into another model. */
export function modelMutationLegacyId(actorId: string, requestId: string, table: string): string {
  const bytes = createHash("sha256").update(JSON.stringify([actorId.toLowerCase(), requestId.toLowerCase(), table])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only operational, opaque metadata may participate in the public preview. */
export function normalizeCredentialMetadata(value: unknown): PlatformCredentialMetadata[] {
  if (!Array.isArray(value)) throw new Error("PLATFORM_CONFIGURATION_CREDENTIAL_METADATA_INVALID");
  const seen = new Set<string>();
  return value.map((input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("PLATFORM_CONFIGURATION_CREDENTIAL_METADATA_INVALID");
    const row = input as Record<string, unknown>;
    const modelKey = String(row.modelKey || ""), credentialRef = String(row.credentialRef || ""), pendingRevision = String(row.pendingRevision || "");
    if (!modelKey || seen.has(modelKey) || !credentialRef || !MODEL_MUTATION_REQUEST_UUID.test(pendingRevision)
      || typeof row.expectedExists !== "boolean" || !["pending", "applied"].includes(String(row.state))
      || (row.expectedExists && !MODEL_MUTATION_REQUEST_UUID.test(String(row.expectedRevision || "")))
      || (!row.expectedExists && row.expectedRevision !== null)) throw new Error("PLATFORM_CONFIGURATION_CREDENTIAL_METADATA_INVALID");
    seen.add(modelKey);
    return { modelKey, credentialRef, pendingRevision, expectedExists: row.expectedExists, expectedRevision: row.expectedRevision as string | null, state: row.state as "pending" | "applied" };
  }).sort((left, right) => left.modelKey.localeCompare(right.modelKey));
}
