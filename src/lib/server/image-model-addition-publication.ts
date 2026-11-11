import "server-only";

import {
  configurationSha256,
  normalizeModelPoolSnapshot,
  stableConfigurationJson,
  validateModelPoolSnapshot,
  type ModelPoolEntry,
} from "@/lib/platform-configuration-contract";
import { resolveImageProviderContract } from "@/lib/image-provider-contract";
import { ensureServerRuntimeEnvLoaded } from "@/lib/server-runtime-env";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type Row = Record<string, unknown>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const same = (left: unknown, right: unknown) => {
  try { return stableConfigurationJson(left) === stableConfigurationJson(right); } catch { return false; }
};

export class ImageModelAdditionPublicationError extends Error {
  readonly retryable = false;
  readonly outcome: "outcome_unknown" | undefined;
  constructor(readonly code: string, readonly status = 409) {
    super(code === "IMAGE_ADDITION_ALREADY_PUBLISHED" ? "原图片模型候选已发布，请读取原候选，不要再次提交" : code === "IMAGE_ADDITION_OUTCOME_UNKNOWN"
      ? "图片模型原发布结果待核对，请读取原候选，不要重复发布"
      : "图片模型新增发布未通过校验，本次未确认提交");
    this.name = "ImageModelAdditionPublicationError";
    this.outcome = code === "IMAGE_ADDITION_OUTCOME_UNKNOWN" ? "outcome_unknown" : undefined;
  }
}
function fail(code: string, status = 409): never { throw new ImageModelAdditionPublicationError(code, status); }

/** Recognition only. The authoritative RPC repeats this check under its lock. */
export function inspectImageModelAddition(currentSnapshot: unknown, candidateSnapshot: unknown): { targetId: string; target: ModelPoolEntry } | null {
  try {
    const current = normalizeModelPoolSnapshot(currentSnapshot), next = normalizeModelPoolSnapshot(candidateSnapshot);
    if (next.models.length !== current.models.length + 1 || !validateModelPoolSnapshot(next).ok) return null;
    if (!same({ ...current, models: [] }, { ...next, models: [] })) return null;
    const additions = next.models.filter(model => !current.models.some(old => old.id === model.id));
    if (additions.length !== 1) return null;
    const target = additions[0], targetId = String(target.configuration.legacyId || "");
    if (target.kind !== "image" || target.id !== targetId || target.configuration.legacyTable !== "cover_models"
      || target.catalogState !== "enabled" || !/^[A-Za-z0-9._-]{1,160}$/.test(targetId)) return null;
    if (!same(next.models.filter(model => model.id !== target.id), current.models)) return null;
    const rawCurrent = row(currentSnapshot).models, rawNext = row(candidateSnapshot).models;
    if (!Array.isArray(rawCurrent) || !Array.isArray(rawNext)
      || !same(rawNext.filter(model => row(model).id !== target.id), rawCurrent)) return null;
    const pairs = next.models.map(model => `${model.configuration.legacyTable}:${model.configuration.legacyId}`);
    if (new Set(next.models.map(model => model.id)).size !== next.models.length || new Set(pairs).size !== pairs.length) return null;
    if (current.models.some(model => model.configuration.legacyTable === "cover_models" && model.configuration.legacyId === targetId)) return null;
    if (target.credentialRef !== `secret://platform-model/cover_models/${targetId}`
      || current.models.some(model => model.credentialRef === target.credentialRef)) return null;
    return { targetId, target };
  } catch { return null; }
}

/** This first additive path is limited to the already deployed, single local
 * acceptance database. A split cloud/business database needs its own reviewed
 * transaction identity; DATABASE_URL is never guessed or taken from a client. */
export function assertImageAdditionRuntime(env: Record<string, string | undefined>): void {
  try {
    const pg = new URL(env.DATABASE_URL || "");
    const rest = new URL(env.COZE_SUPABASE_URL || "");
    const shared = new URL(env.SHARED_CONFIGURATION_SUPABASE_URL || "");
    const localRest = (value: URL) => value.href === "http://127.0.0.1:54321/";
    if (env.LOCAL_RUNTIME_PROFILE !== "local-acceptance" || env.LOCAL_ACCEPTANCE_PREVIEW !== "true"
      || env.SHARED_CONFIGURATION_ENABLED !== "1" || env.SHARED_CONFIGURATION_ID !== "local-acceptance"
      || pg.protocol !== "postgresql:" || pg.hostname !== "127.0.0.1" || pg.port !== "54322" || pg.pathname !== "/zimeiti_local"
      || !localRest(rest) || !localRest(shared)) fail("IMAGE_ADDITION_DATABASE_UNAVAILABLE", 503);
  } catch { fail("IMAGE_ADDITION_DATABASE_UNAVAILABLE", 503); }
}

export type ImageModelAdditionPublicationInput = {
  actorId: string;
  currentReleaseId: string;
  currentSnapshotSha256: string;
  candidateReleaseId: string;
  candidateSnapshotSha256: string;
  targetModelId: string;
  dryRun?: boolean;
};
type TableDigest = { count: number; sha256: string };
export type ImageModelAdditionPublicationResult = {
  release: Row;
  dryRun: boolean;
  outcome: "committed" | "rolled_back" | "already_published";
  evidence: { targetModelId: string; verificationState: "pending"; protectedUnchanged: boolean;
    rollbackVerified: boolean; before: Record<string, TableDigest>; after: Record<string, TableDigest> };
};
function digests(value: unknown): Record<string, TableDigest> {
  return Object.fromEntries(Object.entries(row(value)).map(([table, raw]) => {
    const digest = row(raw);
    if (!/^[a-z][a-z0-9_]*$/.test(table) || !Number.isSafeInteger(digest.count) || Number(digest.count) < 0
      || !SHA.test(String(digest.sha256 || ""))) fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
    return [table, { count: Number(digest.count), sha256: String(digest.sha256) }];
  }));
}
const RELEASE_KEYS = ["id", "release_version", "schema_version", "status", "is_current", "snapshot", "snapshot_sha256",
  "validation_result", "change_note", "parent_release_id", "rollback_target_id", "created_by", "published_by", "created_at", "validated_at", "published_at"];

/** Called only after the normal administrator step-up, validation and preview
 * checks. No owner connection, SET ROLE, provider call, or generic projector. */
export async function publishImageModelAdditionRelease(input: ImageModelAdditionPublicationInput): Promise<ImageModelAdditionPublicationResult> {
  if (![input.actorId, input.currentReleaseId, input.candidateReleaseId].every(value => UUID.test(value))
    || ![input.currentSnapshotSha256, input.candidateSnapshotSha256].every(value => SHA.test(value))
    || !/^[A-Za-z0-9._-]{1,160}$/.test(input.targetModelId)
    || (input.dryRun !== undefined && typeof input.dryRun !== "boolean")) fail("IMAGE_ADDITION_INPUT_INVALID", 400);
  let db: ReturnType<typeof getSupabaseAdminClient>, read;
  try {
    ensureServerRuntimeEnvLoaded();
    assertImageAdditionRuntime(process.env);
    db = getSupabaseAdminClient();
    read = await db.from("model_pool_config_releases").select("*")
      .in("id", [input.currentReleaseId, input.candidateReleaseId]).abortSignal(AbortSignal.timeout(10_000));
  } catch (error) {
    if (error instanceof ImageModelAdditionPublicationError) throw error;
    fail("IMAGE_ADDITION_DATABASE_UNAVAILABLE", 503);
  }
  if (read.error || !Array.isArray(read.data)) fail("IMAGE_ADDITION_DATABASE_UNAVAILABLE", 503);
  const current = row(read.data.find((entry: unknown) => row(entry).id === input.currentReleaseId));
  const candidate = row(read.data.find((entry: unknown) => row(entry).id === input.candidateReleaseId));
  if (current.snapshot_sha256 !== input.currentSnapshotSha256 || candidate.snapshot_sha256 !== input.candidateSnapshotSha256
    || candidate.parent_release_id !== input.currentReleaseId || candidate.rollback_target_id != null) fail("IMAGE_ADDITION_BASE_CHANGED");
  let normalizedCurrent, normalizedCandidate;
  try { normalizedCurrent = normalizeModelPoolSnapshot(current.snapshot); normalizedCandidate = normalizeModelPoolSnapshot(candidate.snapshot); }
  catch { fail("IMAGE_ADDITION_CANDIDATE_INVALID"); }
  if (configurationSha256(normalizedCurrent) !== input.currentSnapshotSha256
    || configurationSha256(normalizedCandidate) !== input.candidateSnapshotSha256) fail("IMAGE_ADDITION_CANDIDATE_INVALID");
  const addition = inspectImageModelAddition(current.snapshot, candidate.snapshot);
  if (!addition || addition.targetId !== input.targetModelId) fail("IMAGE_ADDITION_CANDIDATE_INVALID");
  const target = addition.target, config = row(target.configuration.protocolConfig);
  if (!same(config, target.capabilities.protocol) || ![target.pricing.cost, target.pricing.selling].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
    || target.pricing.currency !== "CNY" || config.canary_verified === true || config.canaryVerified === true
    || row(config.__model_activation_gate).state === "evidence_ready") fail("IMAGE_ADDITION_TARGET_INVALID");
  try { resolveImageProviderContract({ provider: target.provider, model_name: target.modelName, api_endpoint: target.endpoint,
    supports_image_input: target.capabilities.supportsImageInput === true, api_protocol_config: config }); }
  catch { fail("IMAGE_ADDITION_TARGET_INVALID"); }
  let response;
  try {
    response = await db.rpc("publish_image_model_addition_only_atomic", {
      p_actor_id: input.actorId, p_release_id: input.candidateReleaseId,
      p_expected_candidate_sha256: input.candidateSnapshotSha256, p_expected_current_id: input.currentReleaseId,
      p_expected_current_sha256: input.currentSnapshotSha256, p_target_model_id: input.targetModelId,
      p_dry_run: input.dryRun === true,
      p_expected_current_snapshot: current.snapshot, p_expected_candidate_snapshot: candidate.snapshot,
    });
  } catch { fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503); }
  if (response.error) {
    if (["PGRST202", "42883"].includes(String(response.error.code))) fail("IMAGE_ADDITION_DATABASE_UNAVAILABLE", 503);
    if (String(response.error.code) === "42501") fail("IMAGE_ADDITION_ROLE_UNAVAILABLE", 503);
    const code = String(response.error.message || "");
    if (/^IMAGE_ADDITION_[A-Z_]+$/.test(code) && code !== "IMAGE_ADDITION_OUTCOME_UNKNOWN") {
      fail(code, /UNAVAILABLE|PRIVILEGE|ROLE|SCHEMA/.test(code) ? 503 : 409);
    }
    fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
  }
  const result = row(response.data), saved = row(result.release), proof = row(result.evidence);
  if (saved.id !== input.candidateReleaseId || saved.snapshot_sha256 !== input.candidateSnapshotSha256
    || !same(saved.snapshot, candidate.snapshot) || result.dryRun !== (input.dryRun === true)
    || !["committed", "rolled_back", "already_published"].includes(String(result.outcome))) fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
  const dryRun = input.dryRun === true;
  if (dryRun ? result.outcome !== "rolled_back" || saved.status !== "validated" || saved.is_current !== false
    : !["committed", "already_published"].includes(String(result.outcome)) || saved.status !== "published" || saved.is_current !== true) fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
  if (proof.targetModelId !== input.targetModelId || proof.verificationState !== "pending" || proof.protectedUnchanged !== true
    || (dryRun && proof.rollbackVerified !== true)) fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
  const before = digests(proof.before), after = digests(proof.after);
  if (!Object.keys(before).length || !same(before, after)) fail("IMAGE_ADDITION_OUTCOME_UNKNOWN", 503);
  return { release: Object.fromEntries(RELEASE_KEYS.filter(key => Object.hasOwn(saved, key)).map(key => [key, saved[key]])),
    dryRun, outcome: result.outcome as ImageModelAdditionPublicationResult["outcome"], evidence: {
      targetModelId: input.targetModelId, verificationState: "pending", protectedUnchanged: true,
      rollbackVerified: proof.rollbackVerified === true, before, after,
    } };
}
