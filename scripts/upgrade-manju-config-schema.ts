import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANJU_CONFIG_LATEST_SCHEMA_VERSION,
  isManjuMigrationNotReadyError,
  isUuid,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigActiveRow,
  type ManjuConfigPayload,
  type ManjuConfigReleaseRow,
  type ManjuConfigRevisionRow,
} from "../src/lib/server/manju-runtime-config";
import { MANJU_PRODUCTION_SEED } from "../src/lib/server/manju-production-seed";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

export const MANJU_SCHEMA_UPGRADE_DOMAINS = [
  "prompt",
  "content",
  "media",
  "feature_flags",
] as const;

export type ManjuSchemaUpgradeDomain = (typeof MANJU_SCHEMA_UPGRADE_DOMAINS)[number];

const ENVIRONMENT = "production" as const;
const SOURCE_SCHEMA_VERSION = "1.0.0";
const TARGET_SCHEMA_VERSION = MANJU_CONFIG_LATEST_SCHEMA_VERSION;
const ACTOR = "system:manju-schema-upgrade:1.1.0";
const SAFE_HOST_ROOT = "aidap-global.cn-beijing.volces.com";
const LOCAL_ALLOWLIST_ENV = "MANJU_SCHEMA_UPGRADE_ALLOWED_HOSTS";
const KEY_PREFIX = "manju.config.v1";
const MAX_COMPAT_DRAFTS = 10;
const MAX_COMPAT_HISTORY = 50;
const CURRENT_ETAG_PATTERN = /^[0-9a-f]{64}:[1-9][0-9]*$/u;
const LEGACY_ETAG_PATTERN = /^"manju-[0-9a-f]{64}"$/u;

type JsonObject = Record<string, unknown>;
type StorageMode = "compat" | "native";

export interface UpgradeArguments {
  apply: boolean;
  confirmedTargetHost: string;
  domains: ManjuSchemaUpgradeDomain[];
}

interface DatabaseErrorLike {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

interface StorageAuthority {
  environment: typeof ENVIRONMENT;
  domain: ManjuSchemaUpgradeDomain;
  mode: StorageMode;
  generation: number;
  compatSettingKey: string;
  compatActiveReleaseId: string | null;
  compatActiveRevisionId: string | null;
  compatPayloadHash: string | null;
  nativeActiveReleaseId: string | null;
  nativeActiveRevisionId: string | null;
  nativePayloadHash: string | null;
  updatedAt: string;
}

interface ActiveIdentity {
  pointer: ManjuConfigActiveRow;
  release: ManjuConfigReleaseRow;
  revision: ManjuConfigRevisionRow;
}

interface CompatReleaseSnapshot {
  release: ManjuConfigReleaseRow;
  revision: ManjuConfigRevisionRow;
}

interface CompatEnvelope {
  format: "manju-platform-settings-v1";
  environment: typeof ENVIRONMENT;
  domain: ManjuSchemaUpgradeDomain;
  active: ActiveIdentity | null;
  drafts: ManjuConfigRevisionRow[];
  history: CompatReleaseSnapshot[];
  updated_at: string;
}

interface LoadedCompatEnvelope {
  envelope: CompatEnvelope;
  storageRevision: string;
}

interface LoadedScope {
  authority: StorageAuthority;
  active: ActiveIdentity;
  drafts: ManjuConfigRevisionRow[];
  compat: LoadedCompatEnvelope | null;
}

export interface SchemaUpgradePayloadResult {
  payload: ManjuConfigPayload;
  payloadHash: string;
  addedPaths: string[];
}

interface PreparedScope {
  domain: ManjuSchemaUpgradeDomain;
  authority: StorageAuthority;
  previous: ActiveIdentity;
  targetPayload: ManjuConfigPayload;
  targetPayloadHash: string;
  addedPaths: string[];
  reusableDraftId: string | null;
  action: "current" | "publish-existing-draft" | "create-draft-and-publish";
}

interface CompletedScope {
  domain: ManjuSchemaUpgradeDomain;
  result: "unchanged" | "published";
  previousReleaseId: string;
  previousRevisionId: string;
  activeReleaseId: string;
  activeRevisionId: string;
  activePayloadHash: string;
  storageMode: StorageMode;
  storageGeneration: number;
}

interface InFlightScope {
  domain: ManjuSchemaUpgradeDomain;
  stage: "pre-write" | "draft-saved" | "publishing";
  draftRevisionId: string | null;
}

export class ManjuSchemaUpgradeError extends Error {
  readonly code: string;
  readonly scope?: string;

  constructor(code: string, message: string, scope?: string) {
    super(message);
    this.name = "ManjuSchemaUpgradeError";
    this.code = code;
    this.scope = scope;
  }
}

function fail(code: string, message: string, scope?: string): never {
  throw new ManjuSchemaUpgradeError(code, message, scope);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireString(value: unknown, code: string, scope: string): string {
  if (typeof value !== "string" || !value.trim()) fail(code, code, scope);
  return value;
}

function requireTimestamp(value: unknown, code: string, scope: string): string {
  const timestamp = requireString(value, code, scope);
  if (Number.isNaN(Date.parse(timestamp))) fail(code, code, scope);
  return timestamp;
}

function requireUuid(value: unknown, code: string, scope: string): string {
  const uuid = requireString(value, code, scope);
  if (!isUuid(uuid)) fail(code, code, scope);
  return uuid;
}

function requireNullableUuid(value: unknown, code: string, scope: string): string | null {
  if (value === null) return null;
  return requireUuid(value, code, scope);
}

function requireNullableActor(value: unknown, code: string, scope: string): string | null {
  if (value === null) return null;
  const actor = requireString(value, code, scope);
  if (actor.trim() !== actor || actor.length > 128) fail(code, code, scope);
  return actor;
}

function settingKey(domain: ManjuSchemaUpgradeDomain): string {
  return `${KEY_PREFIX}.${ENVIRONMENT}.${domain}`;
}

function scopeName(domain: ManjuSchemaUpgradeDomain): string {
  return `${ENVIRONMENT}/${domain}`;
}

function currentReleaseEtag(
  revision: Pick<ManjuConfigRevisionRow, "payload_hash">,
  releaseNumber: number,
): string {
  return `${revision.payload_hash}:${releaseNumber}`;
}

function legacyReleaseEtag(revision: Pick<ManjuConfigRevisionRow, "payload_hash">): string {
  return `"manju-${revision.payload_hash}"`;
}

function releaseEtagMatches(
  release: Pick<ManjuConfigReleaseRow, "etag" | "release_number">,
  revision: Pick<ManjuConfigRevisionRow, "payload_hash">,
): boolean {
  return release.etag === currentReleaseEtag(revision, release.release_number)
    || release.etag === legacyReleaseEtag(revision);
}

function databaseFailure(code: string, scope: string, error: DatabaseErrorLike | null): never {
  const databaseCode = typeof error?.code === "string" ? error.code : "unknown";
  const databaseMessage = typeof error?.message === "string"
    ? error.message.slice(0, 500)
    : "database operation failed";
  fail(code, `${code} database_code=${databaseCode} message=${databaseMessage}`, scope);
}

function normalizeRpcObject(value: unknown, code: string, scope: string): JsonObject {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (!isObject(normalized)) fail(code, code, scope);
  return normalized;
}

function decodeJwtSegment(segment: string, code: string): JsonObject {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) fail(code, code);
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (!isObject(parsed)) fail(code, code);
    return parsed;
  } catch (error) {
    if (error instanceof ManjuSchemaUpgradeError) throw error;
    fail(code, code);
  }
}

function validateOptionalJwtIssuer(value: unknown, expectedTargetHost?: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 256) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID", "JWT issuer is malformed");
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID", "JWT issuer contains control characters");
  }
  let issuerUrl: URL | null = null;
  try {
    issuerUrl = new URL(value);
  } catch {
    issuerUrl = null;
  }
  if (issuerUrl) {
    const issuerHost = issuerUrl.hostname.toLowerCase();
    if (
      issuerUrl.protocol !== "https:"
      || (issuerUrl.port && issuerUrl.port !== "443")
      || issuerUrl.username
      || issuerUrl.password
      || issuerUrl.search
      || issuerUrl.hash
      || (expectedTargetHost
        ? issuerHost !== expectedTargetHost
        : !isSafeDatabaseHost(issuerHost))
    ) {
      fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID", "JWT issuer URL is outside the exact target");
    }
    return;
  }
  if (value !== "supabase") {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUER_INVALID", "JWT issuer identifier is not allowlisted");
  }
}

/**
 * Perform the local, non-secret structural checks available before Supabase
 * verifies the JWT signature on the first request. The token is never logged.
 */
export function validateServiceRoleJwt(
  token: string,
  nowMilliseconds = Date.now(),
  expectedTargetHost?: string,
): void {
  const segments = token.trim().split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_INVALID", "Service-role credential must be a signed JWT");
  }
  const header = decodeJwtSegment(segments[0], "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_HEADER_INVALID");
  const claims = decodeJwtSegment(segments[1], "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_CLAIMS_INVALID");
  if (!(["HS256", "RS256", "ES256"] as unknown[]).includes(header.alg)) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ALGORITHM_REJECTED", "JWT algorithm is not allowlisted");
  }
  if (header.typ !== undefined && header.typ !== "JWT") {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_TYPE_REJECTED", "JWT type is invalid");
  }
  if (claims.role !== "service_role") {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_REQUIRED", "JWT role must be service_role");
  }
  validateOptionalJwtIssuer(claims.iss, expectedTargetHost);
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  if (
    !Number.isSafeInteger(claims.exp)
    || Number(claims.exp) <= 0
    || Number(claims.exp) > 253_402_300_799
  ) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_EXPIRATION_INVALID", "JWT expiration is invalid");
  }
  if (Number(claims.exp) <= nowSeconds + 30) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_EXPIRED", "JWT is expired or too close to expiration");
  }
  if (
    claims.nbf !== undefined
    && (
      !Number.isSafeInteger(claims.nbf)
      || Number(claims.nbf) < 0
      || Number(claims.nbf) > nowSeconds + 30
    )
  ) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_NOT_ACTIVE", "JWT is not active yet");
  }
  if (
    claims.iat !== undefined
    && (
      !Number.isSafeInteger(claims.iat)
      || Number(claims.iat) < 0
      || Number(claims.iat) > nowSeconds + 300
      || Number(claims.iat) > Number(claims.exp)
    )
  ) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_ISSUED_AT_INVALID", "JWT issued-at claim is invalid");
  }
  let signature: Buffer;
  if (!/^[A-Za-z0-9_-]+$/u.test(segments[2])) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_SIGNATURE_INVALID", "JWT signature is malformed");
  }
  try {
    signature = Buffer.from(segments[2], "base64url");
  } catch {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_SIGNATURE_INVALID", "JWT signature is malformed");
  }
  if (signature.length < 16) {
    fail("MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_JWT_SIGNATURE_INVALID", "JWT signature is malformed");
  }
}

function isSafeDatabaseHost(host: string): boolean {
  return host === SAFE_HOST_ROOT || host.endsWith(`.${SAFE_HOST_ROOT}`);
}

export function parseLocalHostAllowlist(raw: string | undefined): Set<string> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const result = new Set<string>();
  for (const entry of entries) {
    if (
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(entry)
      || entry.includes("..")
      || !isSafeDatabaseHost(entry)
    ) {
      fail("MANJU_SCHEMA_UPGRADE_LOCAL_ALLOWLIST_INVALID", `Invalid exact host in ${LOCAL_ALLOWLIST_ENV}`);
    }
    result.add(entry);
  }
  return result;
}

export function validateProtectedTarget(input: {
  rawUrl: string;
  serviceRoleJwt: string;
  apply: boolean;
  confirmedTargetHost: string;
  localAllowedHosts: ReadonlySet<string>;
  nowMilliseconds?: number;
}): { host: string; locallyAllowlisted: boolean } {
  let target: URL;
  try {
    target = new URL(input.rawUrl.trim());
  } catch {
    fail("MANJU_SCHEMA_UPGRADE_TARGET_URL_INVALID", "COZE_SUPABASE_URL is invalid");
  }
  const host = target.hostname.toLowerCase();
  if (
    target.protocol !== "https:"
    || (target.port && target.port !== "443")
    || target.username
    || target.password
    || target.search
    || target.hash
    || (target.pathname !== "" && target.pathname !== "/")
    || !isSafeDatabaseHost(host)
  ) {
    fail("MANJU_SCHEMA_UPGRADE_TARGET_REJECTED", "Target must be an allowlisted HTTPS Supabase root host");
  }
  validateServiceRoleJwt(input.serviceRoleJwt, input.nowMilliseconds, host);
  const confirmed = input.confirmedTargetHost.trim().toLowerCase();
  if (confirmed && confirmed !== host) {
    fail("MANJU_SCHEMA_UPGRADE_TARGET_CONFIRMATION_MISMATCH", "Confirmed host does not match COZE_SUPABASE_URL");
  }
  const locallyAllowlisted = input.localAllowedHosts.has(host);
  if (input.apply && confirmed !== host) {
    fail(
      "MANJU_SCHEMA_UPGRADE_TARGET_CONFIRMATION_REQUIRED",
      `--apply requires --confirm-target-host=${host}`,
    );
  }
  if (input.apply && !locallyAllowlisted) {
    fail(
      "MANJU_SCHEMA_UPGRADE_LOCAL_ALLOWLIST_REQUIRED",
      `Add the exact target host to protected ${LOCAL_ALLOWLIST_ENV} before --apply`,
    );
  }
  return { host, locallyAllowlisted };
}

function parseDomain(value: string): ManjuSchemaUpgradeDomain {
  if (!MANJU_SCHEMA_UPGRADE_DOMAINS.includes(value as ManjuSchemaUpgradeDomain)) {
    fail("MANJU_SCHEMA_UPGRADE_DOMAIN_REJECTED", `Unsupported --domain=${value}`);
  }
  return value as ManjuSchemaUpgradeDomain;
}

export function parseUpgradeArguments(argv: readonly string[]): UpgradeArguments {
  let apply = false;
  let confirmedTargetHost = "";
  let selectedDomain: ManjuSchemaUpgradeDomain | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) fail("MANJU_SCHEMA_UPGRADE_ARGUMENT_DUPLICATED", "--apply was provided more than once");
      apply = true;
      continue;
    }
    if (argument.startsWith("--confirm-target-host=")) {
      if (confirmedTargetHost) {
        fail("MANJU_SCHEMA_UPGRADE_ARGUMENT_DUPLICATED", "--confirm-target-host was provided more than once");
      }
      confirmedTargetHost = argument.slice("--confirm-target-host=".length).trim().toLowerCase();
      if (!confirmedTargetHost) fail("MANJU_SCHEMA_UPGRADE_TARGET_CONFIRMATION_INVALID", "Confirmed host is empty");
      continue;
    }
    let domainValue: string | null = null;
    if (argument.startsWith("--domain=")) {
      domainValue = argument.slice("--domain=".length).trim();
    } else if (argument === "--domain") {
      domainValue = argv[index + 1]?.trim() ?? "";
      index += 1;
    }
    if (domainValue !== null) {
      if (selectedDomain) fail("MANJU_SCHEMA_UPGRADE_ARGUMENT_DUPLICATED", "Only one --domain is allowed");
      selectedDomain = parseDomain(domainValue);
      continue;
    }
    fail("MANJU_SCHEMA_UPGRADE_ARGUMENT_REJECTED", `Unsupported argument ${argument}`);
  }
  return {
    apply,
    confirmedTargetHost,
    domains: selectedDomain ? [selectedDomain] : [...MANJU_SCHEMA_UPGRADE_DOMAINS],
  };
}

function fillMissingFields(
  target: JsonObject,
  fallback: JsonObject,
  path: string,
  addedPaths: string[],
): void {
  for (const key of Object.keys(fallback).sort()) {
    const childPath = `${path}.${key}`;
    if (!Object.hasOwn(target, key)) {
      target[key] = cloneJson(fallback[key]);
      addedPaths.push(childPath);
      continue;
    }
    if (isObject(target[key]) && isObject(fallback[key])) {
      fillMissingFields(target[key], fallback[key], childPath, addedPaths);
    }
  }
}

/**
 * Upgrade by addition only. Existing user fields and existing override values
 * are never deleted or overwritten. An existing value that is illegal under
 * 1.1.0 therefore fails validation and requires an operator decision.
 */
export function buildSchema11Payload(
  domain: ManjuSchemaUpgradeDomain,
  currentPayload: unknown,
): SchemaUpgradePayloadResult {
  const current = validateManjuConfigPayload(currentPayload);
  validateManjuDomainContract(domain, current.payload, SOURCE_SCHEMA_VERSION);
  const target = cloneJson(current.payload) as JsonObject;
  const fallback = validateManjuConfigPayload(MANJU_PRODUCTION_SEED[domain]).payload as JsonObject;
  const addedPaths: string[] = [];
  fillMissingFields(target, fallback, "$", addedPaths);
  const validated = validateManjuConfigPayload(target);
  validateManjuDomainContract(domain, validated.payload, TARGET_SCHEMA_VERSION);
  return {
    payload: validated.payload,
    payloadHash: validated.payloadHash,
    addedPaths,
  };
}

function parseRevision(
  value: unknown,
  domain: ManjuSchemaUpgradeDomain,
  scope: string,
): ManjuConfigRevisionRow {
  if (!isObject(value)) fail("MANJU_SCHEMA_UPGRADE_REVISION_INVALID", "Revision must be an object", scope);
  const id = requireUuid(value.id, "MANJU_SCHEMA_UPGRADE_REVISION_ID_INVALID", scope);
  if (value.environment !== ENVIRONMENT || value.domain !== domain) {
    fail("MANJU_SCHEMA_UPGRADE_REVISION_SCOPE_MISMATCH", "Revision scope mismatch", scope);
  }
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) {
    fail("MANJU_SCHEMA_UPGRADE_REVISION_VERSION_INVALID", "Revision version is invalid", scope);
  }
  if (!(value.status === "draft" || value.status === "published" || value.status === "superseded")) {
    fail("MANJU_SCHEMA_UPGRADE_REVISION_STATUS_INVALID", "Revision status is invalid", scope);
  }
  const schemaVersion = requireString(
    value.schema_version,
    "MANJU_SCHEMA_UPGRADE_REVISION_SCHEMA_INVALID",
    scope,
  );
  const validated = validateManjuConfigPayload(value.payload);
  validateManjuDomainContract(domain, validated.payload, schemaVersion);
  const payloadHash = requireString(
    value.payload_hash,
    "MANJU_SCHEMA_UPGRADE_REVISION_HASH_INVALID",
    scope,
  );
  if (payloadHash !== validated.payloadHash) {
    fail("MANJU_SCHEMA_UPGRADE_REVISION_HASH_MISMATCH", "Revision payload hash mismatch", scope);
  }
  const parentRevisionId = requireNullableUuid(
    value.parent_revision_id,
    "MANJU_SCHEMA_UPGRADE_REVISION_PARENT_INVALID",
    scope,
  );
  const createdBy = requireNullableActor(
    value.created_by,
    "MANJU_SCHEMA_UPGRADE_REVISION_ACTOR_INVALID",
    scope,
  );
  const createdAt = requireTimestamp(value.created_at, "MANJU_SCHEMA_UPGRADE_REVISION_CREATED_AT_INVALID", scope);
  const updatedAt = requireTimestamp(value.updated_at, "MANJU_SCHEMA_UPGRADE_REVISION_UPDATED_AT_INVALID", scope);
  const publishedAt = value.published_at === null
    ? null
    : requireTimestamp(value.published_at, "MANJU_SCHEMA_UPGRADE_REVISION_PUBLISHED_AT_INVALID", scope);
  if ((value.status === "draft" && publishedAt !== null) || (value.status !== "draft" && publishedAt === null)) {
    fail("MANJU_SCHEMA_UPGRADE_REVISION_LIFECYCLE_INVALID", "Revision lifecycle is invalid", scope);
  }
  return {
    id,
    environment: ENVIRONMENT,
    domain,
    version: Number(value.version),
    status: value.status,
    payload: validated.payload,
    payload_hash: payloadHash,
    schema_version: schemaVersion,
    parent_revision_id: parentRevisionId,
    created_by: createdBy,
    created_at: createdAt,
    updated_at: updatedAt,
    published_at: publishedAt,
  };
}

function parseRelease(
  value: unknown,
  domain: ManjuSchemaUpgradeDomain,
  scope: string,
): ManjuConfigReleaseRow {
  if (!isObject(value)) fail("MANJU_SCHEMA_UPGRADE_RELEASE_INVALID", "Release must be an object", scope);
  const id = requireUuid(value.id, "MANJU_SCHEMA_UPGRADE_RELEASE_ID_INVALID", scope);
  if (value.environment !== ENVIRONMENT || value.domain !== domain) {
    fail("MANJU_SCHEMA_UPGRADE_RELEASE_SCOPE_MISMATCH", "Release scope mismatch", scope);
  }
  if (!Number.isSafeInteger(value.release_number) || Number(value.release_number) < 1) {
    fail("MANJU_SCHEMA_UPGRADE_RELEASE_NUMBER_INVALID", "Release number is invalid", scope);
  }
  const revisionId = requireUuid(value.revision_id, "MANJU_SCHEMA_UPGRADE_RELEASE_REVISION_INVALID", scope);
  const previousReleaseId = requireNullableUuid(
    value.previous_release_id,
    "MANJU_SCHEMA_UPGRADE_RELEASE_PREVIOUS_INVALID",
    scope,
  );
  if (!(value.release_kind === "publish" || value.release_kind === "rollback")) {
    fail("MANJU_SCHEMA_UPGRADE_RELEASE_KIND_INVALID", "Release kind is invalid", scope);
  }
  const rollbackOfReleaseId = requireNullableUuid(
    value.rollback_of_release_id,
    "MANJU_SCHEMA_UPGRADE_RELEASE_ROLLBACK_INVALID",
    scope,
  );
  if (
    (value.release_kind === "publish" && rollbackOfReleaseId !== null)
    || (value.release_kind === "rollback" && rollbackOfReleaseId === null)
  ) {
    fail("MANJU_SCHEMA_UPGRADE_RELEASE_ROLLBACK_RELATION_INVALID", "Release rollback relation is invalid", scope);
  }
  const etag = requireString(value.etag, "MANJU_SCHEMA_UPGRADE_RELEASE_ETAG_INVALID", scope);
  if (!CURRENT_ETAG_PATTERN.test(etag) && !LEGACY_ETAG_PATTERN.test(etag)) {
    fail("MANJU_SCHEMA_UPGRADE_RELEASE_ETAG_INVALID", "Release ETag does not match a supported contract", scope);
  }
  const releasedBy = requireNullableActor(
    value.released_by,
    "MANJU_SCHEMA_UPGRADE_RELEASE_ACTOR_INVALID",
    scope,
  );
  const createdAt = requireTimestamp(value.created_at, "MANJU_SCHEMA_UPGRADE_RELEASE_CREATED_AT_INVALID", scope);
  return {
    id,
    environment: ENVIRONMENT,
    domain,
    release_number: Number(value.release_number),
    revision_id: revisionId,
    previous_release_id: previousReleaseId,
    release_kind: value.release_kind,
    rollback_of_release_id: rollbackOfReleaseId,
    etag,
    released_by: releasedBy,
    created_at: createdAt,
  };
}

function parsePointer(
  value: unknown,
  domain: ManjuSchemaUpgradeDomain,
  scope: string,
): ManjuConfigActiveRow {
  if (!isObject(value)) fail("MANJU_SCHEMA_UPGRADE_POINTER_INVALID", "Active pointer must be an object", scope);
  if (value.environment !== ENVIRONMENT || value.domain !== domain) {
    fail("MANJU_SCHEMA_UPGRADE_POINTER_SCOPE_MISMATCH", "Active pointer scope mismatch", scope);
  }
  return {
    environment: ENVIRONMENT,
    domain,
    active_release_id: requireUuid(
      value.active_release_id,
      "MANJU_SCHEMA_UPGRADE_POINTER_RELEASE_INVALID",
      scope,
    ),
    active_revision_id: requireUuid(
      value.active_revision_id,
      "MANJU_SCHEMA_UPGRADE_POINTER_REVISION_INVALID",
      scope,
    ),
    etag: requireString(value.etag, "MANJU_SCHEMA_UPGRADE_POINTER_ETAG_INVALID", scope),
    updated_by: requireNullableActor(
      value.updated_by,
      "MANJU_SCHEMA_UPGRADE_POINTER_ACTOR_INVALID",
      scope,
    ),
    updated_at: requireTimestamp(value.updated_at, "MANJU_SCHEMA_UPGRADE_POINTER_UPDATED_AT_INVALID", scope),
  };
}

function validateActiveIdentity(
  pointer: ManjuConfigActiveRow,
  release: ManjuConfigReleaseRow,
  revision: ManjuConfigRevisionRow,
  scope: string,
): ActiveIdentity {
  if (
    pointer.active_release_id !== release.id
    || pointer.active_revision_id !== revision.id
    || release.revision_id !== revision.id
    || pointer.etag !== release.etag
    || !releaseEtagMatches(release, revision)
    || revision.status !== "published"
    || !revision.published_at
  ) {
    fail("MANJU_SCHEMA_UPGRADE_ACTIVE_IDENTITY_INVALID", "Active release/revision identity is inconsistent", scope);
  }
  return { pointer, release, revision };
}

function parseCompatEnvelope(value: unknown, domain: ManjuSchemaUpgradeDomain): CompatEnvelope {
  const scope = scopeName(domain);
  if (!isObject(value)) fail("MANJU_SCHEMA_UPGRADE_COMPAT_ENVELOPE_INVALID", "Compat envelope is invalid", scope);
  if (
    value.format !== "manju-platform-settings-v1"
    || value.environment !== ENVIRONMENT
    || value.domain !== domain
    || !Array.isArray(value.drafts)
    || !Array.isArray(value.history)
  ) {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_ENVELOPE_INVALID", "Compat envelope scope or format is invalid", scope);
  }
  const updatedAt = requireTimestamp(
    value.updated_at,
    "MANJU_SCHEMA_UPGRADE_COMPAT_UPDATED_AT_INVALID",
    scope,
  );
  const revisionIds = new Set<string>();
  const versions = new Set<number>();
  const drafts = value.drafts.map((entry, index) => {
    const revision = parseRevision(entry, domain, `${scope}/draft/${index}`);
    if (revision.status !== "draft") {
      fail("MANJU_SCHEMA_UPGRADE_COMPAT_DRAFT_INVALID", "Compat draft is not a draft", `${scope}/draft/${index}`);
    }
    if (revisionIds.has(revision.id) || versions.has(revision.version)) {
      fail("MANJU_SCHEMA_UPGRADE_COMPAT_REVISION_DUPLICATED", "Compat revision is duplicated", scope);
    }
    revisionIds.add(revision.id);
    versions.add(revision.version);
    return revision;
  });
  const historyValues = value.history;
  const releaseIds = new Set<string>();
  const releaseNumbers = new Set<number>();
  const history = historyValues.map((entry, index) => {
    const entryScope = `${scope}/history/${index}`;
    if (!isObject(entry)) fail("MANJU_SCHEMA_UPGRADE_COMPAT_HISTORY_INVALID", "Compat history is invalid", entryScope);
    const revision = parseRevision(entry.revision, domain, entryScope);
    const release = parseRelease(entry.release, domain, entryScope);
    if (
      revision.status === "draft"
      || release.revision_id !== revision.id
      || !releaseEtagMatches(release, revision)
      || revisionIds.has(revision.id)
      || versions.has(revision.version)
      || releaseIds.has(release.id)
      || releaseNumbers.has(release.release_number)
    ) {
      fail("MANJU_SCHEMA_UPGRADE_COMPAT_HISTORY_RELATION_INVALID", "Compat history relation is invalid", entryScope);
    }
    if (index > 0) {
      const newer = historyValues[index - 1];
      if (!isObject(newer) || !isObject(newer.release)) {
        fail("MANJU_SCHEMA_UPGRADE_COMPAT_HISTORY_INVALID", "Compat history is invalid", entryScope);
      }
      if (
        newer.release.previous_release_id !== release.id
        || Number(newer.release.release_number) <= release.release_number
      ) {
        fail("MANJU_SCHEMA_UPGRADE_COMPAT_HISTORY_CHAIN_INVALID", "Compat history chain is invalid", entryScope);
      }
    }
    revisionIds.add(revision.id);
    versions.add(revision.version);
    releaseIds.add(release.id);
    releaseNumbers.add(release.release_number);
    return { release, revision };
  });
  let active: ActiveIdentity | null = null;
  if (value.active !== null) {
    if (!isObject(value.active)) fail("MANJU_SCHEMA_UPGRADE_COMPAT_ACTIVE_INVALID", "Compat active is invalid", scope);
    active = validateActiveIdentity(
      parsePointer(value.active.pointer, domain, `${scope}/active`),
      parseRelease(value.active.release, domain, `${scope}/active`),
      parseRevision(value.active.revision, domain, `${scope}/active`),
      `${scope}/active`,
    );
    if (
      history.length === 0
      || history[0].release.id !== active.release.id
      || history[0].revision.id !== active.revision.id
      || history[0].release.etag !== active.release.etag
    ) {
      fail("MANJU_SCHEMA_UPGRADE_COMPAT_ACTIVE_HISTORY_MISMATCH", "Compat active is not history head", scope);
    }
  } else if (history.length > 0) {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_ACTIVE_MISSING", "Compat history exists without an active identity", scope);
  }
  return {
    format: "manju-platform-settings-v1",
    environment: ENVIRONMENT,
    domain,
    active,
    drafts,
    history,
    updated_at: updatedAt,
  };
}

async function assertNoNativeControlPlane(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<void> {
  const scope = scopeName(domain);
  const result = await database
    .from("manju_config_revisions")
    .select("id")
    .eq("environment", ENVIRONMENT)
    .eq("domain", domain)
    .limit(1);
  if (result.error) {
    if (isManjuMigrationNotReadyError(result.error)) return;
    databaseFailure("MANJU_SCHEMA_UPGRADE_NATIVE_PROBE_FAILED", scope, result.error);
  }
  if ((result.data ?? []).length > 0) {
    fail(
      "MANJU_SCHEMA_UPGRADE_STORAGE_AUTHORITY_AMBIGUOUS",
      "Native control-plane rows exist without an authoritative storage-state row",
      scope,
    );
  }
}

async function loadLegacyCompatAuthority(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<StorageAuthority> {
  const scope = scopeName(domain);
  await assertNoNativeControlPlane(database, domain);
  const result = await database
    .from("platform_settings")
    .select("setting_key,setting_value,updated_at")
    .eq("setting_key", settingKey(domain))
    .maybeSingle();
  if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_COMPAT_READ_FAILED", scope, result.error);
  if (!result.data || result.data.setting_key !== settingKey(domain)) {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_ACTIVE_MISSING", "Compat setting is missing", scope);
  }
  if (typeof result.data.setting_value !== "string") {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_VALUE_INVALID", "Compat setting is not JSON text", scope);
  }
  const storageRevision = requireTimestamp(
    result.data.updated_at,
    "MANJU_SCHEMA_UPGRADE_COMPAT_STORAGE_REVISION_INVALID",
    scope,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.data.setting_value);
  } catch {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_JSON_INVALID", "Compat setting JSON is invalid", scope);
  }
  const envelope = parseCompatEnvelope(decoded, domain);
  if (!envelope.active) {
    fail("MANJU_SCHEMA_UPGRADE_ACTIVE_MISSING", "Compat scope has no active release", scope);
  }
  return {
    environment: ENVIRONMENT,
    domain,
    mode: "compat",
    generation: 0,
    compatSettingKey: settingKey(domain),
    compatActiveReleaseId: envelope.active.release.id,
    compatActiveRevisionId: envelope.active.revision.id,
    compatPayloadHash: envelope.active.revision.payload_hash,
    nativeActiveReleaseId: null,
    nativeActiveRevisionId: null,
    nativePayloadHash: null,
    updatedAt: storageRevision,
  };
}

async function loadAuthority(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<StorageAuthority> {
  const scope = scopeName(domain);
  const result = await database
    .from("manju_config_storage_state")
    .select(
      "environment,domain,state,generation,compat_setting_key,compat_active_release_id,compat_active_revision_id,compat_payload_hash,native_active_release_id,native_active_revision_id,native_payload_hash,updated_at",
    )
    .eq("environment", ENVIRONMENT)
    .eq("domain", domain)
    .maybeSingle();
  if (result.error) {
    if (isManjuMigrationNotReadyError(result.error)) {
      return loadLegacyCompatAuthority(database, domain);
    }
    databaseFailure("MANJU_SCHEMA_UPGRADE_STORAGE_AUTHORITY_READ_FAILED", scope, result.error);
  }
  if (!result.data) {
    return loadLegacyCompatAuthority(database, domain);
  }
  const row = result.data as JsonObject;
  if (row.environment !== ENVIRONMENT || row.domain !== domain || row.compat_setting_key !== settingKey(domain)) {
    fail("MANJU_SCHEMA_UPGRADE_STORAGE_AUTHORITY_SCOPE_INVALID", "Storage authority scope is invalid", scope);
  }
  if (row.state === "migrating") {
    fail("MANJU_SCHEMA_UPGRADE_STORAGE_MIGRATING", "Storage authority is migrating", scope);
  }
  if (!(row.state === "compat" || row.state === "native")) {
    fail("MANJU_SCHEMA_UPGRADE_STORAGE_AUTHORITY_INVALID", "Storage authority mode is invalid", scope);
  }
  if (!Number.isSafeInteger(row.generation) || Number(row.generation) < 0) {
    fail("MANJU_SCHEMA_UPGRADE_STORAGE_GENERATION_INVALID", "Storage generation must be non-negative", scope);
  }
  return {
    environment: ENVIRONMENT,
    domain,
    mode: row.state,
    generation: Number(row.generation),
    compatSettingKey: settingKey(domain),
    compatActiveReleaseId: row.compat_active_release_id === null
      ? null
      : requireUuid(row.compat_active_release_id, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    compatActiveRevisionId: row.compat_active_revision_id === null
      ? null
      : requireUuid(row.compat_active_revision_id, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    compatPayloadHash: row.compat_payload_hash === null
      ? null
      : requireString(row.compat_payload_hash, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    nativeActiveReleaseId: row.native_active_release_id === null
      ? null
      : requireUuid(row.native_active_release_id, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    nativeActiveRevisionId: row.native_active_revision_id === null
      ? null
      : requireUuid(row.native_active_revision_id, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    nativePayloadHash: row.native_payload_hash === null
      ? null
      : requireString(row.native_payload_hash, "MANJU_SCHEMA_UPGRADE_STORAGE_EVIDENCE_INVALID", scope),
    updatedAt: requireTimestamp(row.updated_at, "MANJU_SCHEMA_UPGRADE_STORAGE_UPDATED_AT_INVALID", scope),
  };
}

async function loadCompatEnvelope(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<LoadedCompatEnvelope> {
  const scope = scopeName(domain);
  const result = await database
    .from("platform_settings")
    .select("setting_key,setting_value,updated_at")
    .eq("setting_key", settingKey(domain))
    .maybeSingle();
  if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_COMPAT_READ_FAILED", scope, result.error);
  if (!result.data || result.data.setting_key !== settingKey(domain)) {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_ACTIVE_MISSING", "Compat setting is missing", scope);
  }
  const storageRevision = requireTimestamp(
    result.data.updated_at,
    "MANJU_SCHEMA_UPGRADE_COMPAT_STORAGE_REVISION_INVALID",
    scope,
  );
  if (typeof result.data.setting_value !== "string") {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_VALUE_INVALID", "Compat setting is not JSON text", scope);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.data.setting_value);
  } catch {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_JSON_INVALID", "Compat setting JSON is invalid", scope);
  }
  return { envelope: parseCompatEnvelope(decoded, domain), storageRevision };
}

async function loadNativeScope(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<{ active: ActiveIdentity; drafts: ManjuConfigRevisionRow[] }> {
  const scope = scopeName(domain);
  const [pointerResult, draftsResult] = await Promise.all([
    database
      .from("manju_config_active")
      .select("environment,domain,active_release_id,active_revision_id,etag,updated_by,updated_at")
      .eq("environment", ENVIRONMENT)
      .eq("domain", domain)
      .maybeSingle(),
    database
      .from("manju_config_revisions")
      .select(
        "id,environment,domain,version,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at",
      )
      .eq("environment", ENVIRONMENT)
      .eq("domain", domain)
      .eq("status", "draft")
      .order("updated_at", { ascending: false })
      .limit(100),
  ]);
  const firstError = pointerResult.error ?? draftsResult.error;
  if (firstError) databaseFailure("MANJU_SCHEMA_UPGRADE_NATIVE_READ_FAILED", scope, firstError);
  if (!pointerResult.data) fail("MANJU_SCHEMA_UPGRADE_NATIVE_ACTIVE_MISSING", "Native active pointer is missing", scope);
  const pointer = parsePointer(pointerResult.data, domain, `${scope}/active`);
  const [releaseResult, revisionResult] = await Promise.all([
    database
      .from("manju_config_releases")
      .select(
        "id,environment,domain,release_number,revision_id,previous_release_id,release_kind,rollback_of_release_id,etag,released_by,created_at",
      )
      .eq("id", pointer.active_release_id)
      .eq("environment", ENVIRONMENT)
      .eq("domain", domain)
      .maybeSingle(),
    database
      .from("manju_config_revisions")
      .select(
        "id,environment,domain,version,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at",
      )
      .eq("id", pointer.active_revision_id)
      .eq("environment", ENVIRONMENT)
      .eq("domain", domain)
      .maybeSingle(),
  ]);
  const activeError = releaseResult.error ?? revisionResult.error;
  if (activeError) databaseFailure("MANJU_SCHEMA_UPGRADE_NATIVE_ACTIVE_READ_FAILED", scope, activeError);
  if (!releaseResult.data || !revisionResult.data) {
    fail("MANJU_SCHEMA_UPGRADE_NATIVE_ACTIVE_INCOMPLETE", "Native active release or revision is missing", scope);
  }
  const active = validateActiveIdentity(
    pointer,
    parseRelease(releaseResult.data, domain, `${scope}/active`),
    parseRevision(revisionResult.data, domain, `${scope}/active`),
    `${scope}/active`,
  );
  const drafts = (draftsResult.data ?? []).map((value, index) => {
    const revision = parseRevision(value, domain, `${scope}/draft/${index}`);
    if (revision.status !== "draft") {
      fail("MANJU_SCHEMA_UPGRADE_NATIVE_DRAFT_INVALID", "Native draft query returned a non-draft", scope);
    }
    return revision;
  });
  return { active, drafts };
}

function assertSameAuthority(expected: StorageAuthority, actual: StorageAuthority): void {
  if (
    expected.environment !== actual.environment
    || expected.domain !== actual.domain
    || expected.mode !== actual.mode
    || expected.generation !== actual.generation
  ) {
    fail(
      "MANJU_SCHEMA_UPGRADE_STORAGE_AUTHORITY_CHANGED",
      "Storage mode or generation changed during the upgrade",
      scopeName(expected.domain),
    );
  }
}

function assertSameActive(expected: ActiveIdentity, actual: ActiveIdentity): void {
  if (
    expected.release.id !== actual.release.id
    || expected.revision.id !== actual.revision.id
    || expected.revision.payload_hash !== actual.revision.payload_hash
    || expected.revision.schema_version !== actual.revision.schema_version
    || expected.pointer.etag !== actual.pointer.etag
  ) {
    fail(
      "MANJU_SCHEMA_UPGRADE_ACTIVE_CHANGED",
      "Active release or revision changed during the upgrade",
      scopeName(expected.revision.domain as ManjuSchemaUpgradeDomain),
    );
  }
}

async function loadScope(database: SupabaseClient, domain: ManjuSchemaUpgradeDomain): Promise<LoadedScope> {
  const authorityBefore = await loadAuthority(database, domain);
  let active: ActiveIdentity;
  let drafts: ManjuConfigRevisionRow[];
  let compat: LoadedCompatEnvelope | null = null;
  if (authorityBefore.mode === "compat") {
    compat = await loadCompatEnvelope(database, domain);
    if (!compat.envelope.active) {
      fail("MANJU_SCHEMA_UPGRADE_ACTIVE_MISSING", "Compat scope has no active release", scopeName(domain));
    }
    active = compat.envelope.active;
    drafts = compat.envelope.drafts;
  } else {
    const native = await loadNativeScope(database, domain);
    active = native.active;
    drafts = native.drafts;
  }
  const authorityAfter = await loadAuthority(database, domain);
  assertSameAuthority(authorityBefore, authorityAfter);
  return { authority: authorityAfter, active, drafts, compat };
}

function publicIdentity(active: ActiveIdentity): JsonObject {
  return {
    release_id: active.release.id,
    release_number: active.release.release_number,
    revision_id: active.revision.id,
    revision_version: active.revision.version,
    schema_version: active.revision.schema_version,
    payload_hash: active.revision.payload_hash,
    etag: active.release.etag,
  };
}

function publicAuthority(authority: StorageAuthority): JsonObject {
  return {
    storage_mode: authority.mode,
    storage_generation: authority.generation,
    authority_updated_at: authority.updatedAt,
    authority_evidence: {
      compat_active_release_id: authority.compatActiveReleaseId,
      compat_active_revision_id: authority.compatActiveRevisionId,
      compat_payload_hash: authority.compatPayloadHash,
      native_active_release_id: authority.nativeActiveReleaseId,
      native_active_revision_id: authority.nativeActiveRevisionId,
      native_payload_hash: authority.nativePayloadHash,
    },
  };
}

function findReusableDraft(
  scope: LoadedScope,
  payloadHash: string,
): ManjuConfigRevisionRow | null {
  const matching = scope.drafts.filter((draft) => (
    draft.status === "draft"
    && draft.schema_version === TARGET_SCHEMA_VERSION
    && draft.payload_hash === payloadHash
    && draft.parent_revision_id === scope.active.revision.id
  ));
  if (matching.length > 1) {
    fail(
      "MANJU_SCHEMA_UPGRADE_REUSABLE_DRAFT_AMBIGUOUS",
      "Multiple exact upgrade drafts exist; an operator must review them",
      scopeName(scope.authority.domain),
    );
  }
  return matching[0] ?? null;
}

async function prepareScope(
  database: SupabaseClient,
  domain: ManjuSchemaUpgradeDomain,
): Promise<PreparedScope> {
  const scope = await loadScope(database, domain);
  if (scope.active.revision.schema_version === TARGET_SCHEMA_VERSION) {
    validateManjuDomainContract(domain, scope.active.revision.payload, TARGET_SCHEMA_VERSION);
    return {
      domain,
      authority: scope.authority,
      previous: scope.active,
      targetPayload: scope.active.revision.payload,
      targetPayloadHash: scope.active.revision.payload_hash,
      addedPaths: [],
      reusableDraftId: null,
      action: "current",
    };
  }
  if (scope.active.revision.schema_version !== SOURCE_SCHEMA_VERSION) {
    fail(
      "MANJU_SCHEMA_UPGRADE_SOURCE_SCHEMA_UNSUPPORTED",
      `Expected active schema ${SOURCE_SCHEMA_VERSION} or ${TARGET_SCHEMA_VERSION}`,
      scopeName(domain),
    );
  }
  const target = buildSchema11Payload(domain, scope.active.revision.payload);
  const reusableDraft = findReusableDraft(scope, target.payloadHash);
  return {
    domain,
    authority: scope.authority,
    previous: scope.active,
    targetPayload: target.payload,
    targetPayloadHash: target.payloadHash,
    addedPaths: target.addedPaths,
    reusableDraftId: reusableDraft?.id ?? null,
    action: reusableDraft ? "publish-existing-draft" : "create-draft-and-publish",
  };
}

function publicPreparedScope(item: PreparedScope): JsonObject {
  return {
    domain: item.domain,
    ...publicAuthority(item.authority),
    action: item.action,
    previous: publicIdentity(item.previous),
    target_schema_version: TARGET_SCHEMA_VERSION,
    target_payload_hash: item.targetPayloadHash,
    added_paths: item.addedPaths,
    reusable_draft_revision_id: item.reusableDraftId,
  };
}

function nextRevisionVersion(envelope: CompatEnvelope): number {
  return Math.max(
    0,
    envelope.active?.revision.version ?? 0,
    ...envelope.drafts.map((revision) => revision.version),
    ...envelope.history.map((entry) => entry.revision.version),
  ) + 1;
}

function nextReleaseNumber(envelope: CompatEnvelope): number {
  return Math.max(0, ...envelope.history.map((entry) => entry.release.release_number)) + 1;
}

async function commitCompatEnvelope(
  database: SupabaseClient,
  scope: LoadedScope,
  envelope: CompatEnvelope,
): Promise<void> {
  if (scope.authority.mode !== "compat" || !scope.compat || scope.authority.generation < 0) {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_WRITE_PRECONDITION_INVALID", "Compat write precondition is invalid", scopeName(scope.authority.domain));
  }
  const validatedEnvelope = parseCompatEnvelope(envelope, scope.authority.domain);
  if (scope.authority.generation === 0) {
    const result = await database
      .from("platform_settings")
      .update({
        setting_value: JSON.stringify(validatedEnvelope),
        updated_at: validatedEnvelope.updated_at,
      })
      .eq("setting_key", settingKey(scope.authority.domain))
      .eq("updated_at", scope.compat.storageRevision)
      .select("updated_at")
      .maybeSingle();
    if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_COMPAT_CAS_FAILED", scopeName(scope.authority.domain), result.error);
    if (!result.data) {
      fail("MANJU_SCHEMA_UPGRADE_COMPAT_CAS_CONFLICT", "Compat setting changed during the upgrade", scopeName(scope.authority.domain));
    }
    requireTimestamp(
      result.data.updated_at,
      "MANJU_SCHEMA_UPGRADE_COMPAT_CAS_STORAGE_REVISION_INVALID",
      scopeName(scope.authority.domain),
    );
    return;
  }
  const result = await database.rpc("commit_manju_config_compat_envelope", {
    p_environment: ENVIRONMENT,
    p_domain: scope.authority.domain,
    p_expected_generation: scope.authority.generation,
    p_expected_storage_revision: scope.compat.storageRevision,
    p_envelope: validatedEnvelope,
  });
  if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_COMPAT_CAS_FAILED", scopeName(scope.authority.domain), result.error);
  const response = normalizeRpcObject(
    result.data,
    "MANJU_SCHEMA_UPGRADE_COMPAT_CAS_RESPONSE_INVALID",
    scopeName(scope.authority.domain),
  );
  if (
    response.ok !== true
    || response.environment !== ENVIRONMENT
    || response.domain !== scope.authority.domain
    || response.storage_mode !== "compat"
    || response.storage_generation !== scope.authority.generation
  ) {
    fail(
      "MANJU_SCHEMA_UPGRADE_COMPAT_CAS_RESPONSE_INVALID",
      "Compat CAS response does not match the requested scope",
      scopeName(scope.authority.domain),
    );
  }
  requireTimestamp(
    response.storage_revision,
    "MANJU_SCHEMA_UPGRADE_COMPAT_CAS_STORAGE_REVISION_INVALID",
    scopeName(scope.authority.domain),
  );
}

async function saveCompatDraft(
  database: SupabaseClient,
  scope: LoadedScope,
  payload: ManjuConfigPayload,
  payloadHash: string,
): Promise<string> {
  if (!scope.compat || scope.authority.mode !== "compat") {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_WRITE_PRECONDITION_INVALID", "Compat scope was not loaded", scopeName(scope.authority.domain));
  }
  const envelope = cloneJson(scope.compat.envelope);
  if (!envelope.active) fail("MANJU_SCHEMA_UPGRADE_ACTIVE_MISSING", "Compat active is missing", scopeName(scope.authority.domain));
  const now = new Date().toISOString();
  const revision: ManjuConfigRevisionRow = {
    id: randomUUID(),
    environment: ENVIRONMENT,
    domain: scope.authority.domain,
    version: nextRevisionVersion(envelope),
    status: "draft",
    payload,
    payload_hash: payloadHash,
    schema_version: TARGET_SCHEMA_VERSION,
    parent_revision_id: envelope.active.revision.id,
    created_by: ACTOR,
    created_at: now,
    updated_at: now,
    published_at: null,
  };
  envelope.drafts = [revision, ...envelope.drafts].slice(0, MAX_COMPAT_DRAFTS);
  envelope.updated_at = now;
  await commitCompatEnvelope(database, scope, envelope);
  return revision.id;
}

async function publishCompatDraft(
  database: SupabaseClient,
  scope: LoadedScope,
  draftRevisionId: string,
): Promise<void> {
  if (!scope.compat || scope.authority.mode !== "compat") {
    fail("MANJU_SCHEMA_UPGRADE_COMPAT_WRITE_PRECONDITION_INVALID", "Compat scope was not loaded", scopeName(scope.authority.domain));
  }
  const envelope = cloneJson(scope.compat.envelope);
  if (!envelope.active) fail("MANJU_SCHEMA_UPGRADE_ACTIVE_MISSING", "Compat active is missing", scopeName(scope.authority.domain));
  const draft = envelope.drafts.find((revision) => revision.id === draftRevisionId);
  if (!draft || draft.status !== "draft" || draft.schema_version !== TARGET_SCHEMA_VERSION) {
    fail("MANJU_SCHEMA_UPGRADE_DRAFT_CHANGED", "Compat upgrade draft is missing or changed", scopeName(scope.authority.domain));
  }
  const now = new Date().toISOString();
  const revision: ManjuConfigRevisionRow = {
    ...draft,
    status: "published",
    updated_at: now,
    published_at: now,
  };
  const releaseNumber = nextReleaseNumber(envelope);
  const release: ManjuConfigReleaseRow = {
    id: randomUUID(),
    environment: ENVIRONMENT,
    domain: scope.authority.domain,
    release_number: releaseNumber,
    revision_id: revision.id,
    previous_release_id: envelope.active.release.id,
    release_kind: "publish",
    rollback_of_release_id: null,
    etag: `${revision.payload_hash}:${releaseNumber}`,
    released_by: ACTOR,
    created_at: now,
  };
  const pointer: ManjuConfigActiveRow = {
    environment: ENVIRONMENT,
    domain: scope.authority.domain,
    active_release_id: release.id,
    active_revision_id: revision.id,
    etag: release.etag,
    updated_by: ACTOR,
    updated_at: now,
  };
  envelope.active = { pointer, release, revision };
  envelope.drafts = envelope.drafts.filter((item) => item.id !== draftRevisionId);
  envelope.history = [{ release, revision }, ...envelope.history].slice(0, MAX_COMPAT_HISTORY);
  envelope.updated_at = now;
  await commitCompatEnvelope(database, scope, envelope);
}

async function saveNativeDraft(
  database: SupabaseClient,
  scope: LoadedScope,
  payload: ManjuConfigPayload,
  payloadHash: string,
): Promise<string> {
  if (scope.authority.mode !== "native" || scope.authority.generation < 1) {
    fail("MANJU_SCHEMA_UPGRADE_NATIVE_WRITE_PRECONDITION_INVALID", "Native write precondition is invalid", scopeName(scope.authority.domain));
  }
  const result = await database.rpc("save_manju_config_draft", {
    p_environment: ENVIRONMENT,
    p_domain: scope.authority.domain,
    p_payload: payload,
    p_payload_hash: payloadHash,
    p_schema_version: TARGET_SCHEMA_VERSION,
    p_revision_id: null,
    p_expected_updated_at: null,
    p_actor_id: ACTOR,
  });
  if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_NATIVE_SAVE_DRAFT_FAILED", scopeName(scope.authority.domain), result.error);
  const response = normalizeRpcObject(
    result.data,
    "MANJU_SCHEMA_UPGRADE_NATIVE_SAVE_DRAFT_RESPONSE_INVALID",
    scopeName(scope.authority.domain),
  );
  if (
    response.ok !== true
    || response.environment !== ENVIRONMENT
    || response.domain !== scope.authority.domain
    || response.status !== "draft"
    || response.schema_version !== TARGET_SCHEMA_VERSION
    || response.payload_hash !== payloadHash
    || response.parent_revision_id !== scope.active.revision.id
  ) {
    fail(
      "MANJU_SCHEMA_UPGRADE_NATIVE_SAVE_DRAFT_RESPONSE_INVALID",
      "Native save-draft response does not match the planned upgrade",
      scopeName(scope.authority.domain),
    );
  }
  return requireUuid(
    response.revision_id,
    "MANJU_SCHEMA_UPGRADE_NATIVE_SAVE_DRAFT_REVISION_INVALID",
    scopeName(scope.authority.domain),
  );
}

async function publishNativeDraft(
  database: SupabaseClient,
  scope: LoadedScope,
  draftRevisionId: string,
): Promise<void> {
  if (scope.authority.mode !== "native" || scope.authority.generation < 1) {
    fail("MANJU_SCHEMA_UPGRADE_NATIVE_WRITE_PRECONDITION_INVALID", "Native write precondition is invalid", scopeName(scope.authority.domain));
  }
  const result = await database.rpc("publish_manju_config_revision", {
    p_revision_id: draftRevisionId,
    p_expected_active_release_id: scope.active.release.id,
    p_actor_id: ACTOR,
  });
  if (result.error) databaseFailure("MANJU_SCHEMA_UPGRADE_NATIVE_PUBLISH_FAILED", scopeName(scope.authority.domain), result.error);
  const response = normalizeRpcObject(
    result.data,
    "MANJU_SCHEMA_UPGRADE_NATIVE_PUBLISH_RESPONSE_INVALID",
    scopeName(scope.authority.domain),
  );
  if (
    response.ok !== true
    || response.environment !== ENVIRONMENT
    || response.domain !== scope.authority.domain
    || response.revision_id !== draftRevisionId
  ) {
    fail(
      "MANJU_SCHEMA_UPGRADE_NATIVE_PUBLISH_RESPONSE_INVALID",
      "Native publish response does not match the planned draft",
      scopeName(scope.authority.domain),
    );
  }
  requireUuid(
    response.release_id,
    "MANJU_SCHEMA_UPGRADE_NATIVE_PUBLISH_RELEASE_INVALID",
    scopeName(scope.authority.domain),
  );
}

function requireExactUpgradeDraft(
  scope: LoadedScope,
  draftRevisionId: string,
  plan: PreparedScope,
): ManjuConfigRevisionRow {
  const draft = scope.drafts.find((revision) => revision.id === draftRevisionId);
  if (
    !draft
    || draft.status !== "draft"
    || draft.schema_version !== TARGET_SCHEMA_VERSION
    || draft.payload_hash !== plan.targetPayloadHash
    || draft.parent_revision_id !== plan.previous.revision.id
  ) {
    fail("MANJU_SCHEMA_UPGRADE_DRAFT_VERIFICATION_FAILED", "Upgrade draft failed the post-save check", scopeName(plan.domain));
  }
  const validated = validateManjuConfigPayload(draft.payload);
  validateManjuDomainContract(plan.domain, validated.payload, TARGET_SCHEMA_VERSION);
  if (validated.payloadHash !== plan.targetPayloadHash) {
    fail("MANJU_SCHEMA_UPGRADE_DRAFT_HASH_MISMATCH", "Upgrade draft payload changed", scopeName(plan.domain));
  }
  return draft;
}

async function executeScope(
  database: SupabaseClient,
  plan: PreparedScope,
  reportStage: (stage: InFlightScope) => void,
): Promise<CompletedScope> {
  const before = await loadScope(database, plan.domain);
  assertSameAuthority(plan.authority, before.authority);
  assertSameActive(plan.previous, before.active);
  if (plan.action === "current") {
    if (before.active.revision.schema_version !== TARGET_SCHEMA_VERSION) {
      fail("MANJU_SCHEMA_UPGRADE_CURRENT_VERIFICATION_FAILED", "Supposedly current scope is not schema 1.1.0", scopeName(plan.domain));
    }
    return {
      domain: plan.domain,
      result: "unchanged",
      previousReleaseId: plan.previous.release.id,
      previousRevisionId: plan.previous.revision.id,
      activeReleaseId: before.active.release.id,
      activeRevisionId: before.active.revision.id,
      activePayloadHash: before.active.revision.payload_hash,
      storageMode: before.authority.mode,
      storageGeneration: before.authority.generation,
    };
  }

  reportStage({ domain: plan.domain, stage: "pre-write", draftRevisionId: plan.reusableDraftId });
  let draftRevisionId = plan.reusableDraftId;
  if (!draftRevisionId) {
    draftRevisionId = before.authority.mode === "compat"
      ? await saveCompatDraft(database, before, plan.targetPayload, plan.targetPayloadHash)
      : await saveNativeDraft(database, before, plan.targetPayload, plan.targetPayloadHash);
  }

  const afterDraft = await loadScope(database, plan.domain);
  assertSameAuthority(plan.authority, afterDraft.authority);
  assertSameActive(plan.previous, afterDraft.active);
  requireExactUpgradeDraft(afterDraft, draftRevisionId, plan);
  reportStage({ domain: plan.domain, stage: "draft-saved", draftRevisionId });

  const beforePublish = await loadScope(database, plan.domain);
  assertSameAuthority(plan.authority, beforePublish.authority);
  assertSameActive(plan.previous, beforePublish.active);
  requireExactUpgradeDraft(beforePublish, draftRevisionId, plan);
  reportStage({ domain: plan.domain, stage: "publishing", draftRevisionId });
  if (beforePublish.authority.mode === "compat") {
    await publishCompatDraft(database, beforePublish, draftRevisionId);
  } else {
    await publishNativeDraft(database, beforePublish, draftRevisionId);
  }

  const afterPublish = await loadScope(database, plan.domain);
  assertSameAuthority(plan.authority, afterPublish.authority);
  if (
    afterPublish.active.revision.id !== draftRevisionId
    || afterPublish.active.revision.schema_version !== TARGET_SCHEMA_VERSION
    || afterPublish.active.revision.payload_hash !== plan.targetPayloadHash
    || afterPublish.active.release.revision_id !== draftRevisionId
    || afterPublish.active.release.previous_release_id !== plan.previous.release.id
    || afterPublish.active.release.etag
      !== `${afterPublish.active.revision.payload_hash}:${afterPublish.active.release.release_number}`
  ) {
    fail("MANJU_SCHEMA_UPGRADE_POSTPUBLISH_VERIFICATION_FAILED", "Published active identity does not match the plan", scopeName(plan.domain));
  }
  validateManjuDomainContract(plan.domain, afterPublish.active.revision.payload, TARGET_SCHEMA_VERSION);
  return {
    domain: plan.domain,
    result: "published",
    previousReleaseId: plan.previous.release.id,
    previousRevisionId: plan.previous.revision.id,
    activeReleaseId: afterPublish.active.release.id,
    activeRevisionId: afterPublish.active.revision.id,
    activePayloadHash: afterPublish.active.revision.payload_hash,
    storageMode: afterPublish.authority.mode,
    storageGeneration: afterPublish.authority.generation,
  };
}

function buildRecoveryPlan(
  prepared: readonly PreparedScope[],
  completed: readonly CompletedScope[],
  inFlight: InFlightScope | null,
): JsonObject {
  const completedByDomain = new Map(completed.map((item) => [item.domain, item] as const));
  return {
    automatic_rollback_attempted: false,
    rule: "Do not reactivate a 1.0.0 revision directly. Recovery is a reviewed upgrade-rollback published as a new 1.1.0 release.",
    first_action: "Stop further domains, reload authority/generation/active identity, and compare them with this checkpoint.",
    in_flight: inFlight,
    domains: prepared.map((item) => {
      const finished = completedByDomain.get(item.domain);
      return {
        domain: item.domain,
        state: finished?.result ?? (inFlight?.domain === item.domain ? inFlight.stage : "not-started"),
        inspect_command: `node ./scripts/run-node-maintenance-tsx.mjs ./scripts/upgrade-manju-config-schema.ts --domain=${item.domain}`,
        previous_release_id: item.previous.release.id,
        previous_revision_id: item.previous.revision.id,
        previous_schema_version: item.previous.revision.schema_version,
        previous_payload_hash: item.previous.revision.payload_hash,
        current_release_id_after_this_run: finished?.activeReleaseId ?? null,
        current_revision_id_after_this_run: finished?.activeRevisionId ?? null,
        required_recovery_workflow: finished?.result === "published"
          ? {
              endpoint: "/api/admin/manju-config",
              steps: [
                "Load the recorded previous revision and current active identity as admin.",
                "Copy the previous payload into a new operator-reviewed schema_version=1.1.0 draft; add required 1.1.0 fields without deleting legal user fields.",
                "Validate the draft, then publish it with expected_storage_generation and expected_active_release_id equal to the freshly re-read values.",
                "Re-read and verify schema_version, payload_hash, release.previous_release_id and active pointer before continuing.",
              ],
            }
          : "Re-run the single-domain dry-run; an exact saved draft is reused idempotently.",
      };
    }),
  };
}

function errorSummary(error: unknown): JsonObject {
  if (error instanceof ManjuSchemaUpgradeError) {
    return { code: error.code, scope: error.scope ?? null, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "MANJU_SCHEMA_UPGRADE_UNEXPECTED_FAILURE", scope: null, message: error.message };
  }
  return { code: "MANJU_SCHEMA_UPGRADE_UNKNOWN_FAILURE", scope: null, message: "Unknown failure" };
}

function writeCheckpoint(input: {
  runId: string;
  sequence: number;
  phase: string;
  host: string;
  prepared: readonly PreparedScope[];
  completed: readonly CompletedScope[];
  inFlight: InFlightScope | null;
  failure?: JsonObject;
}): string {
  const directory = resolve(
    process.cwd(),
    ".codex-task-snapshots",
    "manju-schema-upgrade-recovery",
    input.runId,
  );
  mkdirSync(directory, { recursive: true });
  const sequence = String(input.sequence).padStart(3, "0");
  const destination = resolve(directory, `${sequence}-${input.phase}.json`);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  const document = {
    schema: "manju-schema-upgrade-recovery.v1",
    run_id: input.runId,
    created_at: new Date().toISOString(),
    target_host: input.host,
    source_schema_version: SOURCE_SCHEMA_VERSION,
    target_schema_version: TARGET_SCHEMA_VERSION,
    phase: input.phase,
    plans: input.prepared.map(publicPreparedScope),
    completed: input.completed,
    failure: input.failure ?? null,
    recovery: buildRecoveryPlan(input.prepared, input.completed, input.inFlight),
  };
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, destination);
  return destination;
}

export async function runManjuSchemaUpgrade(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseUpgradeArguments(argv);
  loadEnv({ path: ".env.local", quiet: true });
  const rawUrl = process.env.COZE_SUPABASE_URL?.trim() ?? "";
  const serviceRoleJwt = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!rawUrl || !serviceRoleJwt) {
    fail(
      "MANJU_SCHEMA_UPGRADE_SERVICE_ROLE_NOT_CONFIGURED",
      "COZE_SUPABASE_URL and COZE_SUPABASE_SERVICE_ROLE_KEY are required",
    );
  }
  const localAllowedHosts = parseLocalHostAllowlist(process.env[LOCAL_ALLOWLIST_ENV]);
  const target = validateProtectedTarget({
    rawUrl,
    serviceRoleJwt,
    apply: args.apply,
    confirmedTargetHost: args.confirmedTargetHost,
    localAllowedHosts,
  });
  const database = getSupabaseAdminClient() as SupabaseClient;
  const prepared: PreparedScope[] = [];
  for (const domain of args.domains) prepared.push(await prepareScope(database, domain));

  console.log(JSON.stringify({
    ok: true,
    mode: args.apply ? "apply-preflight" : "dry-run",
    target_host: target.host,
    locally_allowlisted_for_apply: target.locallyAllowlisted,
    source_schema_version: SOURCE_SCHEMA_VERSION,
    target_schema_version: TARGET_SCHEMA_VERSION,
    selected_domains: args.domains,
    apply_command_requires: [
      `${LOCAL_ALLOWLIST_ENV}=${target.host}`,
      `--apply --confirm-target-host=${target.host}`,
    ],
    plan: prepared.map(publicPreparedScope),
  }, null, 2));
  if (!args.apply) return;

  // A second full read closes the gap between plan construction and the first
  // durable recovery checkpoint. No write is attempted unless every selected
  // scope still has the exact planned authority and active identity.
  for (const plan of prepared) {
    const refreshed = await loadScope(database, plan.domain);
    assertSameAuthority(plan.authority, refreshed.authority);
    assertSameActive(plan.previous, refreshed.active);
  }

  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  const completed: CompletedScope[] = [];
  let inFlight: InFlightScope | null = null;
  let sequence = 0;
  let latestCheckpoint = writeCheckpoint({
    runId,
    sequence,
    phase: "prepared",
    host: target.host,
    prepared,
    completed,
    inFlight,
  });

  try {
    for (const plan of prepared) {
      const result = await executeScope(database, plan, (stage) => {
        inFlight = stage;
        sequence += 1;
        latestCheckpoint = writeCheckpoint({
          runId,
          sequence,
          phase: `${stage.domain}-${stage.stage}`,
          host: target.host,
          prepared,
          completed,
          inFlight,
        });
      });
      completed.push(result);
      inFlight = null;
      sequence += 1;
      latestCheckpoint = writeCheckpoint({
        runId,
        sequence,
        phase: `${plan.domain}-verified`,
        host: target.host,
        prepared,
        completed,
        inFlight,
      });
    }
  } catch (error) {
    const failure = errorSummary(error);
    sequence += 1;
    try {
      latestCheckpoint = writeCheckpoint({
        runId,
        sequence,
        phase: "failed",
        host: target.host,
        prepared,
        completed,
        inFlight,
        failure,
      });
    } catch {
      // The prepared checkpoint was completed before every database write.
      // Keep its path and still emit the recovery plan to stderr.
    }
    console.error(JSON.stringify({
      ok: false,
      mode: "apply-failed",
      target_host: target.host,
      failure,
      latest_recovery_checkpoint: latestCheckpoint,
      completed,
      recovery: buildRecoveryPlan(prepared, completed, inFlight),
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "apply-result",
    target_host: target.host,
    source_schema_version: SOURCE_SCHEMA_VERSION,
    target_schema_version: TARGET_SCHEMA_VERSION,
    latest_recovery_checkpoint: latestCheckpoint,
    results: completed,
  }, null, 2));
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isDirectExecution()) {
  runManjuSchemaUpgrade().catch((error) => {
    console.error(JSON.stringify({ ok: false, ...errorSummary(error) }, null, 2));
    process.exitCode = 1;
  });
}
