import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageProviderType } from "@/storage/object/types";
import {
  gaoruiProviderOrigin,
  gaoruiCredentialBindingFingerprint,
  issueGaoruiTrustedPersonAsset,
  type GaoruiTrustedPersonAsset,
} from "@/lib/gaorui-provider-asset-contract";
import { assertGaoruiPersonAssetFeeAuthorization, type GaoruiAssetPreparationAuthorization } from "@/lib/gaorui-person-asset-admission";
export { gaoruiCredentialBindingFingerprint } from "@/lib/gaorui-provider-asset-contract";
export type { GaoruiAssetPreparationAuthorization } from "@/lib/gaorui-person-asset-admission";

const MODEL = "seedance-2.0-fast" as const;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Row = Record<string, unknown>;
export type GaoruiAssetState = "submitting" | "ready" | "processing" | "submission_unknown" | "reconciliation_required" | "failed";
type AssetState = GaoruiAssetState;

export class GaoruiProviderAssetError extends Error {
  constructor(public readonly code: string, public readonly state?: AssetState, public readonly operationId?: string) {
    super(code);
    this.name = "GaoruiProviderAssetError";
  }
}

export type PrepareGaoruiPersonAssetInput = {
  userId: string;
  ownedAssetId: string;
  modelId: string;
  modelName: string;
  endpoint: string;
  credentialBindingFingerprint: string;
  /** Resolved server credential, used only in the request header. */
  secret: string;
  authorization: GaoruiAssetPreparationAuthorization;
};

export type GaoruiAssetDependencies = {
  db: SupabaseClient;
  fetch: typeof fetch;
  storage: {
    readBounded(key: string, maxBytes: number, timeoutMs: number, provider: StorageProviderType): Promise<Buffer>;
    getSignedUrl(key: string, options: { expireTime: number }, provider: StorageProviderType): Promise<string>;
  };
  /** Server-only durable task linkage, invoked after claim and before POST. */
  onClaim?: (claim: { operationId: string; state: GaoruiAssetState }) => Promise<void>;
};

function fail(code: string, state?: AssetState): never { throw new GaoruiProviderAssetError(code, state); }
function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }

function assertInput(input: PrepareGaoruiPersonAssetInput) {
  if (!UUID.test(input.userId) || !UUID.test(input.ownedAssetId) || !input.modelId.trim()
    || input.modelName !== MODEL || !HASH.test(input.credentialBindingFingerprint)
    || !input.secret || /[\r\n]/u.test(input.secret)) fail("GAORUI_ASSET_INPUT_INVALID");
  try { gaoruiProviderOrigin(input.endpoint); } catch { fail("GAORUI_ASSET_ENDPOINT_INVALID"); }
  if (input.credentialBindingFingerprint !== gaoruiCredentialBindingFingerprint(input)) fail("GAORUI_ASSET_CREDENTIAL_BINDING_INVALID");
  try { assertGaoruiPersonAssetFeeAuthorization(input.authorization, {
    modelId: input.modelId, modelName: input.modelName, providerOrigin: gaoruiProviderOrigin(input.endpoint),
    credentialBindingFingerprint: input.credentialBindingFingerprint,
  }); } catch (error) {
    fail(error instanceof Error && /^GAORUI_[A-Z0-9_]+$/u.test(error.message) ? error.message : "GAORUI_ASSET_FEE_UNVERIFIED");
  }
}

export function assertOwnedRow(row: Row, input: Pick<PrepareGaoruiPersonAssetInput, 'ownedAssetId' | 'userId'>) {
  const meta = record(row.meta);
  if (row.id !== input.ownedAssetId || row.user_id !== input.userId || row.file_category !== "image"
    || row.source !== "digital-human-input" || row.deleted_at || row.is_deleted === true
    || meta.deleted_at || meta.deletedAt || meta.deleted === true
    || typeof row.storage_key !== "string" || !row.storage_key
    || row.storage_provider !== "tencent_cos"
    || !["image/png", "image/jpeg", "image/webp"].includes(String(row.content_type))
    || !Number.isSafeInteger(Number(row.file_size)) || Number(row.file_size) <= 0 || Number(row.file_size) > MAX_IMAGE_BYTES) {
    fail("GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE");
  }
}

async function ownedRow(db: SupabaseClient, input: PrepareGaoruiPersonAssetInput): Promise<Row> {
  // Selecting the row also detects physical deletion; optional deletion flags are
  // checked in assertOwnedRow without requiring a nonexistent schema column.
  const { data, error } = await db.from("user_files").select("*")
    .eq("id", input.ownedAssetId).eq("user_id", input.userId)
    .eq("file_category", "image").eq("source", "digital-human-input").maybeSingle();
  if (error) fail("GAORUI_PERSON_ASSET_LOOKUP_UNAVAILABLE");
  const row = record(data);
  assertOwnedRow(row, input);
  return row;
}

export function version(row: Row): string {
  const meta = record(row.meta);
  return sha(JSON.stringify([row.id, row.user_id, row.storage_provider, row.storage_key,
    row.file_size, row.content_type, row.created_at ?? null, meta.contentVersion ?? null, meta.etag ?? null]));
}

function signedUrl(value: string, storageKey: string): string {
  let url: URL;
  try { url = new URL(value); } catch { fail("GAORUI_PERSON_ASSET_SIGNING_INVALID"); }
  let key: string;
  try { key = decodeURIComponent(url.pathname.slice(1)); } catch { fail("GAORUI_PERSON_ASSET_SIGNING_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || key !== storageKey) {
    fail("GAORUI_PERSON_ASSET_SIGNING_INVALID");
  }
  return value;
}

export function readyAsset(value: Row, sourceUrl?: string): { assetId: string; assetUrl: string } | null {
  const id = value.asset_id;
  if (value.status !== "ready" || value.model !== MODEL || value.asset_type !== "Image" || value.visibility !== "private"
    || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(id)
    || typeof value.asset_url !== "string" || !/^asset:\/\//iu.test(value.asset_url)
    || value.asset_url.slice(8) !== id) return null;
  if (value.type !== undefined && value.type !== "image") return null;
  if (value["asset-id"] !== undefined && value["asset-id"] !== id) return null;
  if (value.mode !== undefined && value.mode !== "asset") return null;
  if (value.purpose !== undefined && value.purpose !== "person_reference") return null;
  if (sourceUrl !== undefined && value.source_url !== undefined && value.source_url !== sourceUrl) return null;
  if (value.content !== undefined) {
    const content = record(value.content);
    const image = record(content.image_url);
    if (content.type !== "image_url" || content.role !== "reference_image" || content.status !== "ready"
      || content.subject_type !== "person" || image.status !== "ready" || image.asset_id !== id
      || typeof image.url !== "string" || !/^asset:\/\//iu.test(image.url) || image.url.slice(8) !== id) return null;
    if (sourceUrl !== undefined && image.source_url !== undefined && image.source_url !== sourceUrl) return null;
  }
  return { assetId: id, assetUrl: `asset://${id}` };
}

async function readResponse(response: Response): Promise<Row> {
  const reader = response.body?.getReader();
  if (!reader) fail("GAORUI_ASSET_RESPONSE_INVALID", "submission_unknown");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      fail("GAORUI_ASSET_RESPONSE_INVALID", "submission_unknown");
    }
    parts.push(part.value);
  }
  try { return record(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
  catch { fail("GAORUI_ASSET_RESPONSE_INVALID", "submission_unknown"); }
}

async function dependencies(given?: Partial<GaoruiAssetDependencies>): Promise<GaoruiAssetDependencies> {
  const db = given?.db ?? (await import("@/storage/database/supabase-client")).getSupabaseAdminClient();
  const storage = given?.storage ?? (await import("@/storage/object")).storageManager;
  return { db, storage, fetch: given?.fetch ?? fetch, onClaim: given?.onClaim };
}

/**
 * Generate intent only. Quotes must never call this preparation function.
 * A durable claim precedes the one possible POST; no state permits an automatic
 * retry after a request may have left this process. Unknown results require an
 * operator/provider reconciliation path, not a fresh claim.
 */
async function prepareGaoruiPersonAssetImpl(
  input: PrepareGaoruiPersonAssetInput,
  given?: Partial<GaoruiAssetDependencies>,
): Promise<GaoruiTrustedPersonAsset> {
  assertInput(input);
  const deps = await dependencies(given);
  const row = await ownedRow(deps.db, input);
  let bytes: Buffer;
  let sourceUrl: string;
  try {
    bytes = await deps.storage.readBounded(String(row.storage_key), MAX_IMAGE_BYTES, 20_000, "tencent_cos");
    sourceUrl = signedUrl(await deps.storage.getSignedUrl(String(row.storage_key), { expireTime: 3600 }, "tencent_cos"), String(row.storage_key));
  } catch (error) {
    if (error instanceof GaoruiProviderAssetError) throw error;
    fail("GAORUI_PERSON_ASSET_STORAGE_UNAVAILABLE");
  }
  if (!bytes.length || bytes.length !== Number(row.file_size) || bytes.length > MAX_IMAGE_BYTES) fail("GAORUI_PERSON_ASSET_CONTENT_CHANGED");
  const contentSha256 = sha(bytes);
  const assetVersion = version(row);
  const scope = {
    user_id: input.userId, owned_asset_id: input.ownedAssetId,
    asset_version: assetVersion, content_sha256: contentSha256,
    storage_provider: "tencent_cos", storage_key: String(row.storage_key),
    provider_origin: gaoruiProviderOrigin(input.endpoint),
    credential_binding_fingerprint: input.credentialBindingFingerprint,
    model_id: input.modelId, model_name: MODEL, type: "image", role: "reference_image", purpose: "person_reference",
  };
  const scopeKey = sha(JSON.stringify(scope));
  const claimToken = randomUUID();
  const { data, error } = await deps.db.rpc("claim_gaorui_provider_person_asset_v1", {
    p_scope_key: scopeKey, p_scope: scope, p_claim_token: claimToken,
    p_budget_authorization_id: input.authorization.budgetAuthorizationId,
    p_maximum_charge_cny: input.authorization.maximumChargeCny,
  });
  if (error) fail("GAORUI_ASSET_CLAIM_UNAVAILABLE");
  const claim = record(data);
  const operationId = String(claim.operation_id ?? "");
  if (!UUID.test(operationId) || claim.scope_key !== scopeKey) fail("GAORUI_ASSET_CLAIM_INVALID");
  try {
  const claimState = String(claim.state) as GaoruiAssetState;
  if (!["submitting", "ready", "processing", "submission_unknown", "reconciliation_required", "failed"].includes(claimState)) fail("GAORUI_ASSET_CLAIM_INVALID");
  await deps.onClaim?.({ operationId, state: claimState });
  const issue = async (result: { assetId: string; assetUrl: string }) => {
    // Ready cache reuse still proves current ownership and immutable identity.
    const current = await ownedRow(deps.db, input);
    if (version(current) !== assetVersion) fail("GAORUI_PERSON_ASSET_CONTENT_CHANGED");
    const currentBytes = await deps.storage.readBounded(String(current.storage_key), MAX_IMAGE_BYTES, 20_000, "tencent_cos");
    if (sha(currentBytes) !== contentSha256) fail("GAORUI_PERSON_ASSET_CONTENT_CHANGED");
    return issueGaoruiTrustedPersonAsset({ operationId, userId: input.userId,
      ownedAssetId: input.ownedAssetId, contentSha256, modelId: input.modelId, modelName: MODEL,
      endpointOrigin: scope.provider_origin, credentialBindingFingerprint: input.credentialBindingFingerprint,
      sourceUrl, assetId: result.assetId, assetUrl: result.assetUrl,
      type: "image", role: "reference_image", purpose: "person_reference" });
  };
  if (claim.state === "ready") {
    const result = readyAsset(record(claim.result));
    if (!result) fail("GAORUI_ASSET_READY_MAPPING_INVALID", "reconciliation_required");
    return issue(result);
  }
  if (claim.claimed !== true || claim.state !== "submitting") {
    const state = ["submitting", "processing", "submission_unknown", "reconciliation_required", "failed"].includes(String(claim.state))
      ? claim.state as AssetState : "reconciliation_required";
    fail("GAORUI_ASSET_NOT_READY", state);
  }

  async function settle(state: AssetState, result: Row | null, code: string | null) {
    const settled = await deps.db.rpc("settle_gaorui_provider_person_asset_v1", {
      p_scope_key: scopeKey, p_claim_token: claimToken, p_state: state, p_result: result, p_error_code: code,
    });
    if (settled.error || record(settled.data).state !== state) fail("GAORUI_ASSET_SETTLEMENT_UNAVAILABLE", "reconciliation_required");
  }

  let response: Response;
  let payload: Row;
  try {
    response = await deps.fetch(`${scope.provider_origin}/v1/assets/uploads`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${input.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: sourceUrl, model: MODEL, mode: "asset", type: "image", role: "reference_image", subject_type: "person", purpose: "person_reference" }),
    });
    payload = await readResponse(response);
  } catch {
    await settle("submission_unknown", null, "GAORUI_ASSET_SUBMISSION_UNKNOWN");
    fail("GAORUI_ASSET_SUBMISSION_UNKNOWN", "submission_unknown");
  }
  const result = response.ok ? readyAsset(payload, sourceUrl) : null;
  if (!result) {
    const state: AssetState = response.ok && ["processing", "queued", "pending"].includes(String(payload.status))
      ? "processing" : response.ok && payload.status === "failed" ? "failed" : "reconciliation_required";
    // Store only validated fields, never arbitrary upstream messages/URLs.
    const receipt: Row = {};
    for (const [source, target] of [["asset_task_id", "provider_task_id"], ["task_id", "provider_task_id"], ["asset_id", "provider_asset_id"], ["status", "upstream_status"]]) {
      const value = payload[source];
      if (typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/u.test(value)) receipt[target] = value;
    }
    await settle(state, receipt, "GAORUI_ASSET_NOT_READY");
    fail("GAORUI_ASSET_NOT_READY", state);
  }
  await settle("ready", { status: "ready", model: MODEL, asset_type: "Image", type: "image", visibility: "private", asset_id: result.assetId, asset_url: result.assetUrl }, null);
  return issue(result);
  } catch (error) {
    if (error instanceof GaoruiProviderAssetError) throw new GaoruiProviderAssetError(error.code, error.state ?? "reconciliation_required", operationId);
    throw new GaoruiProviderAssetError("GAORUI_ASSET_PREPARATION_UNAVAILABLE", "reconciliation_required", operationId);
  }
}

export async function prepareGaoruiPersonAsset(
  input: PrepareGaoruiPersonAssetInput,
  given?: Partial<GaoruiAssetDependencies>,
): Promise<GaoruiTrustedPersonAsset> {
  try { return await prepareGaoruiPersonAssetImpl(input, given); }
  catch (error) {
    if (error instanceof GaoruiProviderAssetError) throw error;
    fail("GAORUI_ASSET_PREPARATION_UNAVAILABLE");
  }
}
