import { normalizeDomainClaim, type NormalizedDomainClaim } from "@/lib/domain-tls-brand-release-control-plane";
import {
  isPlatformBrandAssetPurpose,
  type PlatformBrandAssetPurpose,
} from "@/lib/branding/contracts";

export interface WhiteLabelContact {
  name: string;
  wechat: string;
  phone: string;
  email: string;
}

export interface WhiteLabelDraftInput {
  profileId: string | null;
  expectedRevision: number;
  brandName: string;
  brandShortName: string;
  brandSlogan: string;
  brandDescription: string;
  contact: WhiteLabelContact;
  assetIds: Partial<Record<PlatformBrandAssetPurpose, string>>;
  domain: NormalizedDomainClaim;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class WhiteLabelValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WhiteLabelValidationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WhiteLabelValidationError("贴牌配置必须是对象", "WHITE_LABEL_REQUEST_INVALID");
  }
  return value as Record<string, unknown>;
}

function field(value: unknown, label: string, max: number, required = false): string {
  if (value == null) {
    if (required) throw new WhiteLabelValidationError(`${label}不能为空`, "WHITE_LABEL_FIELD_REQUIRED");
    return "";
  }
  if (typeof value !== "string") {
    throw new WhiteLabelValidationError(`${label}格式无效`, "WHITE_LABEL_FIELD_INVALID");
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (required && !normalized) {
    throw new WhiteLabelValidationError(`${label}不能为空`, "WHITE_LABEL_FIELD_REQUIRED");
  }
  if (normalized.length > max) {
    throw new WhiteLabelValidationError(`${label}最多 ${max} 个字符`, "WHITE_LABEL_FIELD_TOO_LONG");
  }
  return normalized;
}

export function parseWhiteLabelDraftInput(input: unknown): WhiteLabelDraftInput {
  const root = object(input);
  const profileId = root.profileId == null || root.profileId === "" ? null : field(root.profileId, "配置编号", 36);
  if (profileId && !UUID.test(profileId)) {
    throw new WhiteLabelValidationError("贴牌配置编号无效", "WHITE_LABEL_PROFILE_ID_INVALID");
  }
  const expectedRevision = Number(root.expectedRevision ?? 0);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new WhiteLabelValidationError("配置版本无效", "WHITE_LABEL_REVISION_INVALID");
  }
  const contact = root.contact == null ? {} : object(root.contact);
  const email = field(contact.email, "联系邮箱", 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new WhiteLabelValidationError("联系邮箱格式无效", "WHITE_LABEL_EMAIL_INVALID");
  }
  const rawAssetIds = root.assetIds == null ? {} : object(root.assetIds);
  const assetIds: Partial<Record<PlatformBrandAssetPurpose, string>> = {};
  for (const [purpose, rawId] of Object.entries(rawAssetIds)) {
    if (!isPlatformBrandAssetPurpose(purpose) || typeof rawId !== "string" || !UUID.test(rawId)) {
      throw new WhiteLabelValidationError("白标品牌资产引用无效", "WHITE_LABEL_ASSET_REFERENCE_INVALID");
    }
    assetIds[purpose] = rawId.toLowerCase();
  }
  return {
    profileId: profileId?.toLowerCase() || null,
    expectedRevision,
    brandName: field(root.brandName, "客户品牌名", 120, true),
    brandShortName: field(root.brandShortName, "品牌简称", 60),
    brandSlogan: field(root.brandSlogan, "品牌标语", 120),
    brandDescription: field(root.brandDescription, "品牌说明", 500),
    contact: {
      name: field(contact.name, "联系人", 80),
      wechat: field(contact.wechat, "微信号", 80),
      phone: field(contact.phone, "联系电话", 40),
      email,
    },
    assetIds,
    domain: normalizeDomainClaim(root.hostname),
  };
}

export function parseWhiteLabelVerificationInput(input: unknown): { profileId: string; expectedRevision: number } {
  const root = object(input);
  const profileId = field(root.profileId, "配置编号", 36, true).toLowerCase();
  const expectedRevision = Number(root.expectedRevision);
  if (!UUID.test(profileId)) {
    throw new WhiteLabelValidationError("贴牌配置编号无效", "WHITE_LABEL_PROFILE_ID_INVALID");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new WhiteLabelValidationError("配置版本无效", "WHITE_LABEL_REVISION_INVALID");
  }
  return { profileId, expectedRevision };
}

export const parseWhiteLabelPublicationInput = parseWhiteLabelVerificationInput;

export function parseWhiteLabelAssetUploadFields(input: {
  profileId: FormDataEntryValue | null;
  expectedRevision: FormDataEntryValue | null;
  purpose: FormDataEntryValue | null;
}): { profileId: string; expectedRevision: number; purpose: PlatformBrandAssetPurpose } {
  const profileId = typeof input.profileId === "string" ? input.profileId.trim().toLowerCase() : "";
  const expectedRevision = Number(typeof input.expectedRevision === "string" ? input.expectedRevision : NaN);
  if (!UUID.test(profileId)) {
    throw new WhiteLabelValidationError("贴牌配置编号无效", "WHITE_LABEL_PROFILE_ID_INVALID");
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new WhiteLabelValidationError("配置版本无效", "WHITE_LABEL_REVISION_INVALID");
  }
  if (!isPlatformBrandAssetPurpose(input.purpose)) {
    throw new WhiteLabelValidationError("白标品牌资产用途无效", "WHITE_LABEL_ASSET_PURPOSE_INVALID");
  }
  return { profileId, expectedRevision, purpose: input.purpose };
}
