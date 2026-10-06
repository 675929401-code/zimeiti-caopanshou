import type { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { assertImageValidationDatabase, imageModelConfigurationHash, imageValidationFailure, type ImageValidationRow } from "@/lib/image-admin-validation";

type Database = ReturnType<typeof getSupabaseAdminClient>;
const object = (value: unknown): ImageValidationRow => value && typeof value === "object" && !Array.isArray(value) ? value as ImageValidationRow : {};

/** Server-only: the returned model includes configuration secrets and must be projected. */
export function inspectImagePublicationState(value: unknown) {
  const entry = object(value), model = object(entry.model) as ImageValidationRow & { id: string };
  if (typeof model.id !== "string") imageValidationFailure("IMAGE_PUBLICATION_STATE_INVALID", "生图配置状态无效", 503);
  const modelSnapshotHash = String(entry.modelSnapshotHash || "");
  const current = imageModelConfigurationHash(model, modelSnapshotHash);
  const configured = Boolean(current.credentialReady);
  const matches = (candidate: unknown) => {
    const record = object(candidate);
    return current.credentialReady && record.modelSnapshotHash === modelSnapshotHash && record.configurationHash === current.configurationHash;
  };
  const published = Array.isArray(entry.published) && entry.published.some(matches);
  const baseline = object(entry.legacyBaseline);
  const legacyBaseline = matches(baseline) && typeof baseline.evidenceRef === "string" && baseline.evidenceRef.trim().length >= 8;
  return { model, modelSnapshotHash, configurationHash: current.configurationHash, configured, published, legacyBaseline,
    available: model.is_active === true && model.is_hidden === false && configured,
    admission: published ? "published" as const : legacyBaseline ? "legacy_baseline" as const : "pending" as const };
}

export async function readImagePublicationStates(db: Database, modelId?: string) {
  assertImageValidationDatabase(db);
  const result = await db.rpc("read_image_model_publication_state", { p_model_id: modelId || null });
  if (result.error || !Array.isArray(result.data)) imageValidationFailure("IMAGE_PUBLICATION_STORE_UNAVAILABLE", "生图模型发布状态暂不可读取", 503);
  return (result.data as unknown[]).map(inspectImagePublicationState);
}

export async function requirePublishedImageModel(db: Database, modelId: string) {
  const state = (await readImagePublicationStates(db, modelId)).find(entry => entry.model.id === modelId);
  if (!state?.available) imageValidationFailure("IMAGE_MODEL_CONFIGURATION_REQUIRED", "当前模型配置失效或密钥缺失，不能提交生成", 409);
  return state;
}

/** Draft integration for both administrator save routes: settings changes require a new proof. */
export function pendingImageConfigurationUpdate(current: ImageValidationRow, requested: ImageValidationRow) {
  const executionFields = [
    "name",
    "model_name",
    "provider",
    "api_endpoint",
    "api_key",
    "cost_price",
    "selling_price",
    "supports_image_input",
    "api_protocol_config",
  ];
  const next = { ...requested };
  for (const key of ["api_key", "api_endpoint"]) if (typeof next[key] === "string" && !next[key].trim()) delete next[key];
  const changed = executionFields.some(key => Object.hasOwn(next, key) && JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  // Configuration evidence is diagnostic. Editing a configured model must not
  // silently switch off a model that an administrator has kept online.
  void changed;
  return next;
}
