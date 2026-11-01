import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersonAssetPreflight } from '@/features/digital-human/asset-preflight-contract';
import { findModelByPublicId } from '@/lib/public-model-dto';
import { gaoruiCredentialBindingFingerprint, gaoruiProviderOrigin } from '@/lib/gaorui-provider-asset-contract';
import { readGaoruiPersonAssetAdmission } from '@/lib/gaorui-person-asset-admission';
import { isDigitalHumanWorkspaceModel } from '@/lib/video-model-surface';
import { RETIRED_MODEL_PROVIDER } from '@/lib/model-retirement';
import { assertOwnedRow, version, readyAsset } from './gaorui-provider-assets';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export class PersonAssetPreflightError extends Error {
  constructor(readonly status: 404 | 503) { super(status === 404 ? 'ASSET_NOT_FOUND' : 'PREFLIGHT_UNAVAILABLE'); }
}

/** SELECT and a STABLE SELECT-only RPC. Never prepares or claims assets. */
export async function readPersonAssetPreflight(input: { userId: string; assetId: string; publicModelId: string }, deps: {
  db: SupabaseClient;
  resolveSecret: (reference: string) => string;
}): Promise<PersonAssetPreflight> {
  if (!UUID.test(input.userId) || !UUID.test(input.assetId)) throw new PersonAssetPreflightError(404);
  // Ownership is checked before model/configuration/cache lookup, including for admins.
  const owned = await deps.db.from('user_files').select('*').eq('id', input.assetId)
    .eq('user_id', input.userId).eq('file_category', 'image').eq('source', 'digital-human-input').maybeSingle();
  if (owned.error) throw new PersonAssetPreflightError(503);
  const asset = record(owned.data);
  try { assertOwnedRow(asset, { userId: input.userId, ownedAssetId: input.assetId }); }
  catch { throw new PersonAssetPreflightError(404); }
  if (!/^pm_[A-Za-z0-9_-]{24}$/u.test(input.publicModelId)) throw new PersonAssetPreflightError(404);
  const models = await deps.db.from('video_models').select('*').eq('is_active', true).eq('is_hidden', false);
  if (models.error) throw new PersonAssetPreflightError(503);
  const model = findModelByPublicId('video', (models.data || []) as Row[], input.publicModelId);
  if (!model || model.provider === RETIRED_MODEL_PROVIDER || model.protocol_type !== 'gaorui_video' || model.model_name !== 'seedance-2.0-fast'
    || !isDigitalHumanWorkspaceModel(model)) throw new PersonAssetPreflightError(404);
  const result: PersonAssetPreflight = { ownership: 'owned', version: 'unverified', content: 'unverified',
    cache: 'unavailable', fee: 'unverified', generationAuthorized: false };
  let fingerprint: string;
  let origin: string;
  try {
    origin = gaoruiProviderOrigin(String(model.api_endpoint));
    const secret = deps.resolveSecret(String(model.api_key || ''));
    if (!secret || /[\r\n]/u.test(secret)) return result;
    fingerprint = gaoruiCredentialBindingFingerprint({ secret, modelId: String(model.id), endpoint: String(model.api_endpoint) });
    result.fee = readGaoruiPersonAssetAdmission(model, { surface: 'digital-human', credentialBindingFingerprint: fingerprint }).ready ? 'verified' : 'unverified';
  } catch { return result; }
  // The private journal has no direct table SELECT grant, including service_role.
  const operations = await deps.db.rpc('read_gaorui_person_asset_preflight_v1', {
    p_user_id: input.userId, p_owned_asset_id: input.assetId, p_model_id: String(model.id),
    p_provider_origin: origin, p_credential_binding_fingerprint: fingerprint,
  });
  if (operations.error || !Array.isArray(operations.data) || operations.data.length > 100) return result;
  const currentVersion = version(asset);
  const matching = ((operations.data || []) as Row[]).filter(operation => {
    const scope = record(operation.scope);
    // Recheck all scope fields, even if a transport or adapter ignores filters.
    return scope.user_id === input.userId && scope.owned_asset_id === input.assetId
      && scope.model_id === model.id && scope.model_name === model.model_name
      && scope.provider_origin === origin && scope.credential_binding_fingerprint === fingerprint
      && scope.asset_version === currentVersion && scope.storage_provider === asset.storage_provider
      && scope.storage_key === asset.storage_key && scope.type === 'image'
      && scope.role === 'reference_image' && scope.purpose === 'person_reference'
      && /^[a-f0-9]{64}$/u.test(String(scope.content_sha256));
  });
  result.version = matching.length ? 'matched' : 'unmatched';
  // An unresolved operation takes precedence over a historical ready record.
  result.cache = matching.some(op => ['submission_unknown', 'reconciliation_required'].includes(String(op.state))) ? 'reconciliation_required'
    : matching.some(op => ['submitting', 'processing'].includes(String(op.state))) ? 'pending'
    : matching.some(op => op.state === 'ready' && readyAsset(record(op.result))) ? 'ready_record'
    : matching.some(op => op.state === 'ready') ? 'reconciliation_required'
    : matching.some(op => op.state === 'failed') ? 'failed' : 'missing';
  // Metadata cannot prove the current object's bytes still match the journal digest.
  // A ready record therefore never authorizes generation or skips the fee gate.
  return result;
}
