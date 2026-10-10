import "server-only";

import type { PlatformBrandAssetPurpose } from "@/lib/branding/contracts";
import type { WhiteLabelDraftInput } from "@/lib/white-label-profile-contract";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import type { StorageProviderType } from "@/storage/object";

export interface WhiteLabelProfileSummary {
  profileId: string;
  tenantKey: string;
  siteKey: string;
  brandName: string;
  brandShortName: string;
  brandSlogan: string;
  brandDescription: string;
  contact: { name: string; wechat: string; phone: string; email: string };
  draftAssetIds: Partial<Record<PlatformBrandAssetPurpose, string>>;
  lifecycleStatus: string;
  revision: number;
  brandGeneration: number;
  draftReleaseId: string;
  publishedReleaseId: string;
  hostname: string;
  requestedHostname: string;
  claimStatus: string;
  expectedTxtName: string;
  expectedTxtValue: string;
  ownershipStatus: string;
  routingStatus: string;
  tlsStatus: string;
  httpsStatus: string;
  brandReleaseStatus: string;
  brandBindingStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhiteLabelAdminState {
  schemaVersion: 2;
  asOf: string;
  runtimePublicationReady: boolean;
  profiles: WhiteLabelProfileSummary[];
}

export interface RegisteredWhiteLabelAsset {
  id: string;
  profileId: string;
  purpose: PlatformBrandAssetPurpose;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
  storageKey: string;
  replayed: boolean;
}

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export class WhiteLabelAuthorityError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message);
    this.name = "WhiteLabelAuthorityError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function databaseError(error: unknown): WhiteLabelAuthorityError {
  const details = record(error);
  const message = [details.message, details.details, details.hint].filter((value) => typeof value === "string").join(" ");
  const known = [
    "WHITE_LABEL_REVISION_CONFLICT",
    "WHITE_LABEL_PROFILE_NOT_FOUND",
    "WHITE_LABEL_VERIFIED_DOMAIN_IMMUTABLE",
    "WHITE_LABEL_DRAFT_INVALID",
    "WHITE_LABEL_REQUEST_INVALID",
    "WHITE_LABEL_DOMAIN_NOT_VERIFIED",
    "WHITE_LABEL_ASSET_REFERENCE_INVALID",
    "WHITE_LABEL_ASSET_INVALID",
    "WHITE_LABEL_IDEMPOTENCY_KEY_CONFLICT",
  ].find((code) => message.includes(code));
  const schemaMissing = ["42P01", "42883", "PGRST202", "PGRST204"].includes(text(details.code))
    || /white_label_profiles|read_white_label_admin_state|save_white_label_draft_v2_atomic|publish_white_label_draft_atomic|register_white_label_asset_atomic/iu.test(message);
  return new WhiteLabelAuthorityError(
    known === "WHITE_LABEL_REVISION_CONFLICT"
      ? "该贴牌配置已被其他窗口更新，请刷新后再保存"
      : known === "WHITE_LABEL_PROFILE_NOT_FOUND"
        ? "贴牌配置不存在或已失效"
        : known === "WHITE_LABEL_VERIFIED_DOMAIN_IMMUTABLE"
          ? "已验证域名不能直接替换，请先走域名变更流程"
          : known === "WHITE_LABEL_DOMAIN_NOT_VERIFIED"
            ? "域名所有权尚未验证，不能发布"
            : known === "WHITE_LABEL_ASSET_REFERENCE_INVALID" || known === "WHITE_LABEL_ASSET_INVALID"
              ? "白标品牌资产无效或不属于当前配置"
              : known === "WHITE_LABEL_IDEMPOTENCY_KEY_CONFLICT"
                ? "请求编号已被其他贴牌操作使用"
          : schemaMissing
            ? "贴牌配置数据库尚未启用"
            : "贴牌配置写入失败",
    known || (schemaMissing ? "WHITE_LABEL_MIGRATION_REQUIRED" : "WHITE_LABEL_AUTHORITY_FAILURE"),
    error,
  );
}

function profile(value: unknown): WhiteLabelProfileSummary {
  const row = record(value);
  const contact = record(row.contact);
  return {
    profileId: text(row.profileId),
    tenantKey: text(row.tenantKey),
    siteKey: text(row.siteKey),
    brandName: text(row.brandName),
    brandShortName: text(row.brandShortName),
    brandSlogan: text(row.brandSlogan),
    brandDescription: text(row.brandDescription),
    contact: { name: text(contact.name), wechat: text(contact.wechat), phone: text(contact.phone), email: text(contact.email) },
    draftAssetIds: Object.fromEntries(
      Object.entries(record(row.draftAssetIds)).filter(([, value]) => typeof value === "string"),
    ) as Partial<Record<PlatformBrandAssetPurpose, string>>,
    lifecycleStatus: text(row.lifecycleStatus),
    revision: Number(row.revision || 0),
    brandGeneration: Number(row.brandGeneration || 0),
    draftReleaseId: text(row.draftReleaseId),
    publishedReleaseId: text(row.publishedReleaseId),
    hostname: text(row.hostname),
    requestedHostname: text(row.requestedHostname),
    claimStatus: text(row.claimStatus),
    expectedTxtName: text(row.expectedTxtName),
    expectedTxtValue: text(row.expectedTxtValue),
    ownershipStatus: text(row.ownershipStatus),
    routingStatus: text(row.routingStatus),
    tlsStatus: text(row.tlsStatus),
    httpsStatus: text(row.httpsStatus),
    brandReleaseStatus: text(row.brandReleaseStatus),
    brandBindingStatus: text(row.brandBindingStatus),
    createdAt: text(row.createdAt),
    updatedAt: text(row.updatedAt),
  };
}

export async function readWhiteLabelAdminState(): Promise<WhiteLabelAdminState> {
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc("read_white_label_admin_state");
  if (error) throw databaseError(error);
  const root = record(data);
  if (![1, 2].includes(Number(root.schemaVersion)) || !Array.isArray(root.profiles)) {
    throw new WhiteLabelAuthorityError("贴牌配置读回格式无效", "WHITE_LABEL_STATE_INVALID");
  }
  return {
    schemaVersion: 2,
    asOf: text(root.asOf),
    runtimePublicationReady: Number(root.schemaVersion) === 2,
    profiles: root.profiles.map(profile),
  };
}

export async function saveWhiteLabelDraft(params: {
  draft: WhiteLabelDraftInput;
  tokenHash: string;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  const { draft } = params;
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc("save_white_label_draft_v2_atomic", {
    p_profile_id: draft.profileId,
    p_expected_revision: draft.expectedRevision,
    p_brand_name: draft.brandName,
    p_brand_short_name: draft.brandShortName,
    p_contact_name: draft.contact.name,
    p_contact_wechat: draft.contact.wechat,
    p_contact_phone: draft.contact.phone,
    p_contact_email: draft.contact.email,
    p_requested_hostname: draft.domain.requestedHostname,
    p_ascii_hostname: draft.domain.asciiHostname,
    p_unicode_hostname: draft.domain.unicodeHostname,
    p_expected_txt_name: draft.domain.expectedTxtName,
    p_verification_token_hash: params.tokenHash,
    p_verification_token_hint: params.tokenHash.slice(0, 8),
    p_brand_slogan: draft.brandSlogan,
    p_brand_description: draft.brandDescription,
    p_asset_ids: draft.assetIds,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
  if (error) throw databaseError(error);
  return record(data);
}

export async function publishWhiteLabelDraft(params: {
  profileId: string;
  expectedRevision: number;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc("publish_white_label_draft_atomic", {
    p_profile_id: params.profileId,
    p_expected_revision: params.expectedRevision,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
  if (error) throw databaseError(error);
  return record(data);
}

export async function registerWhiteLabelAsset(params: {
  profileId: string;
  expectedRevision: number;
  purpose: PlatformBrandAssetPurpose;
  storageProvider: StorageProviderType;
  storageKey: string;
  sha256: string;
  mimeType: RegisteredWhiteLabelAsset["mimeType"];
  bytes: number;
  width: number;
  height: number;
  actorId: string;
  requestKey: string;
}): Promise<RegisteredWhiteLabelAsset> {
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc("register_white_label_asset_atomic", {
    p_profile_id: params.profileId,
    p_expected_revision: params.expectedRevision,
    p_purpose: params.purpose,
    p_storage_provider: params.storageProvider,
    p_storage_key: params.storageKey,
    p_sha256: params.sha256,
    p_mime_type: params.mimeType,
    p_bytes: params.bytes,
    p_width: params.width,
    p_height: params.height,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
  if (error) throw databaseError(error);
  const row = record(data);
  return {
    id: text(row.id),
    profileId: text(row.profileId),
    purpose: text(row.purpose) as PlatformBrandAssetPurpose,
    mimeType: text(row.mimeType) as RegisteredWhiteLabelAsset["mimeType"],
    bytes: Number(row.bytes || 0),
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    sha256: text(row.sha256),
    createdAt: text(row.createdAt),
    storageKey: text(row.storageKey),
    replayed: row.replayed === true,
  };
}

export async function recordWhiteLabelDomainVerification(params: {
  profileId: string;
  expectedRevision: number;
  passed: boolean;
  observedValuesHash: string;
  evidenceSha256: string;
  resolverName: string;
  errorCode: string;
  actorId: string;
  requestKey: string;
}): Promise<Record<string, unknown>> {
  const { data, error } = await (getSupabaseAdminClient() as unknown as RpcClient).rpc("record_white_label_domain_verification", {
    p_profile_id: params.profileId,
    p_expected_revision: params.expectedRevision,
    p_passed: params.passed,
    p_observed_values_hash: params.observedValuesHash,
    p_evidence_sha256: params.evidenceSha256,
    p_resolver_name: params.resolverName,
    p_error_code: params.errorCode,
    p_actor_id: params.actorId,
    p_request_key: params.requestKey,
  });
  if (error) throw databaseError(error);
  return record(data);
}
