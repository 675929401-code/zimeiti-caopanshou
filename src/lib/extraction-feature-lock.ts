/**
 * Extraction configuration is frozen at the admin API boundary.
 * There is deliberately no admin toggle or environment-variable bypass.
 * An owner-authorized change requires a reviewed implementation and a new
 * verified baseline. Direct database/service-role or source access is outside
 * this API guard; this is not an owner authentication or database lock.
 */
const PROTECTED_EXTRACTION_ROLES = Object.freeze([
  "coze_multifunction_extract",
  "extract_workflow",
  "extract_text_third_party",
  "extract_batch_third_party",
  "extract_video",
] as const);

export const EXTRACTION_FEATURE_LOCK = Object.freeze({
  feature: "extraction",
  locked: true,
  scope: "admin-plugin-configuration",
  errorCode: "EXTRACTION_FEATURE_LOCKED",
  protectedRoles: PROTECTED_EXTRACTION_ROLES,
  message: "提取功能配置已受安全锁保护。新增、修改、启停、价格、凭据和删除均已冻结；须获得用户本人明确授权，经受控变更与验证后重新锁定。",
});

export function extractionConfigurationIsLocked(...roles: unknown[]): boolean {
  return roles.some(role => typeof role === "string"
    && PROTECTED_EXTRACTION_ROLES.some(protectedRole => protectedRole === role.trim()));
}

export function extractionFeatureLockedBody() {
  return {
    error: EXTRACTION_FEATURE_LOCK.message,
    error_code: EXTRACTION_FEATURE_LOCK.errorCode,
    featureLock: EXTRACTION_FEATURE_LOCK,
  };
}
