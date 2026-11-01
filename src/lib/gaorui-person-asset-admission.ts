import { isDigitalHumanWorkspaceModel } from "./video-model-surface";

type Row = Record<string, unknown>;
const authorized = new WeakSet<object>();
export const GAORUI_PERSON_ASSET_FEE_SCHEMA = "gaorui_person_asset_fee_authorization.v1";

export type GaoruiAssetPreparationAuthorization = Readonly<{
  action: "prepare-person-reference";
  billingVerified: true;
  feeCny: 0;
  /** Local authorization ceiling; this is not a provider-enforced limit. */
  maximumChargeCny: 0;
  budgetAuthorizationId: string;
  providerOrigin: "https://gaorui.cc";
  modelId: string;
  modelName: "seedance-2.0-fast";
  credentialBindingFingerprint: string;
  verifiedAt: string;
  expiresAt: string;
  evidenceRef: string;
}>;

export type GaoruiPersonAssetAdmission = {
  required: boolean;
  ready: boolean;
  code: string | null;
  message: string | null;
  authorization?: GaoruiAssetPreparationAuthorization;
};

function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function blocked(code: string, message: string): GaoruiPersonAssetAdmission { return { required: true, ready: false, code, message }; }

/** Read-only admission shared by catalog and generate. It never prepares an asset. */
export function readGaoruiPersonAssetAdmission(
  model: Row,
  options: { surface?: string; now?: number; credentialBindingFingerprint?: string } = {},
): GaoruiPersonAssetAdmission {
  const required = model.protocol_type === "gaorui_video" && model.model_name === "seedance-2.0-fast"
    && (options.surface === "digital-human" || isDigitalHumanWorkspaceModel(model));
  if (!required) return { required: false, ready: true, code: null, message: null };
  const config = row(model.api_protocol_config);
  const fee = row(config.gaorui_person_asset_fee_authorization);
  if (fee.schema !== GAORUI_PERSON_ASSET_FEE_SCHEMA || fee.enabled !== true) {
    return blocked("GAORUI_ASSET_FEE_UNVERIFIED", "真人素材登记费用尚未核验并授权，请联系管理员；当前不会提交任务");
  }
  let origin: string;
  try {
    const endpoint = new URL(String(model.api_endpoint));
    if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) throw new Error();
    origin = endpoint.origin;
  } catch { return blocked("GAORUI_ASSET_FEE_SCOPE_MISMATCH", "真人素材费用授权与当前模型配置不一致，请联系管理员"); }
  if (origin !== "https://gaorui.cc" || fee.providerOrigin !== origin || fee.modelName !== model.model_name
    || fee.modelId !== model.id || typeof fee.credentialBindingFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(fee.credentialBindingFingerprint)
    || (options.credentialBindingFingerprint !== undefined && fee.credentialBindingFingerprint !== options.credentialBindingFingerprint)) {
    return blocked("GAORUI_ASSET_FEE_SCOPE_MISMATCH", "真人素材费用授权与当前模型或凭据不一致，请联系管理员");
  }
  const now = options.now ?? Date.now();
  const verifiedAt = typeof fee.verifiedAt === "string" ? Date.parse(fee.verifiedAt) : NaN;
  const expiresAt = typeof fee.expiresAt === "string" ? Date.parse(fee.expiresAt) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)
    || verifiedAt > now || expiresAt <= now || expiresAt <= verifiedAt) {
    return blocked("GAORUI_ASSET_FEE_AUTHORIZATION_EXPIRED", "真人素材费用授权尚未生效或已过期，请联系管理员");
  }
  if (typeof fee.evidenceRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:/._-]{3,499}$/u.test(fee.evidenceRef)
    || typeof fee.authorizationId !== "string" || !/^[A-Za-z0-9:_-]{8,160}$/u.test(fee.authorizationId)) {
    return blocked("GAORUI_ASSET_FEE_UNVERIFIED", "真人素材登记费用缺少核验依据或授权记录，请联系管理员");
  }
  // Positive fees require independent atomic budget reservation/settlement,
  // which this change deliberately does not claim to implement.
  if (fee.feeCny !== 0 || fee.maxChargeCny !== 0) {
    return blocked("GAORUI_ASSET_PAID_PREPARATION_UNSUPPORTED", "当前仅支持已核验为零费用的真人素材登记；收费登记尚未开放");
  }
  const authorization: GaoruiAssetPreparationAuthorization = Object.freeze({
    action: "prepare-person-reference", billingVerified: true, feeCny: 0, maximumChargeCny: 0,
    budgetAuthorizationId: fee.authorizationId, providerOrigin: "https://gaorui.cc", modelId: String(model.id),
    modelName: "seedance-2.0-fast", credentialBindingFingerprint: fee.credentialBindingFingerprint,
    verifiedAt: String(fee.verifiedAt), expiresAt: String(fee.expiresAt), evidenceRef: fee.evidenceRef,
  });
  authorized.add(authorization);
  return { required: true, ready: true, code: null, message: null, authorization };
}

export function assertGaoruiPersonAssetFeeAuthorization(
  authorization: unknown,
  scope: { modelId: string; modelName: string; providerOrigin: string; credentialBindingFingerprint: string; now?: number },
): asserts authorization is GaoruiAssetPreparationAuthorization {
  if (!authorization || typeof authorization !== "object" || !authorized.has(authorization)) throw new Error("GAORUI_ASSET_FEE_UNVERIFIED");
  const fee = authorization as GaoruiAssetPreparationAuthorization;
  if (fee.modelId !== scope.modelId || fee.modelName !== scope.modelName || fee.providerOrigin !== scope.providerOrigin
    || fee.credentialBindingFingerprint !== scope.credentialBindingFingerprint || fee.feeCny !== 0 || fee.maximumChargeCny !== 0) {
    throw new Error("GAORUI_ASSET_FEE_SCOPE_MISMATCH");
  }
  if (Date.parse(fee.expiresAt) <= (scope.now ?? Date.now())) throw new Error("GAORUI_ASSET_FEE_AUTHORIZATION_EXPIRED");
}
