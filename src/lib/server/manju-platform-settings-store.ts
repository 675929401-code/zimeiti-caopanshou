import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANJU_CONFIG_DOMAINS,
  MANJU_CONFIG_LATEST_SCHEMA_VERSION,
  isManjuConflictError,
  isManjuMigrationNotReadyError,
  sanitizeManjuPublicPayload,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigActiveRow,
  type ManjuConfigDomain,
  type ManjuConfigEnvironment,
  type ManjuConfigPayload,
  type ManjuConfigReleaseRow,
  type ManjuConfigRevisionRow,
} from "@/lib/server/manju-runtime-config";

const KEY_PREFIX = "manju.config.v1";
const MAX_HISTORY = 50;
const CURRENT_ETAG_PATTERN = /^[0-9a-f]{64}:[1-9][0-9]*$/u;
const LEGACY_ETAG_PATTERN = /^"manju-[0-9a-f]{64}"$/u;

export type ManjuConfigStorageMode = "compat" | "native";
export interface ManjuConfigStorageSelection {
  mode: ManjuConfigStorageMode;
  generation: number;
}

interface StorageStateRow {
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  state: "compat" | "migrating" | "native";
  generation: number;
}

interface CompatReleaseSnapshot {
  release: ManjuConfigReleaseRow;
  revision: ManjuConfigRevisionRow;
}

interface CompatEnvelope {
  format: "manju-platform-settings-v1";
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  active: {
    pointer: ManjuConfigActiveRow;
    release: ManjuConfigReleaseRow;
    revision: ManjuConfigRevisionRow;
  } | null;
  drafts: ManjuConfigRevisionRow[];
  history: CompatReleaseSnapshot[];
  updated_at: string;
}

interface LoadedCompatEnvelope {
  envelope: CompatEnvelope;
  persisted: boolean;
  storageRevision: string | null;
}

export interface ManjuCompatAdminView {
  ok: true;
  storage_mode: "compat";
  environment: ManjuConfigEnvironment;
  domain: ManjuConfigDomain;
  active: CompatEnvelope["active"];
  drafts: ManjuConfigRevisionRow[];
  history: CompatReleaseSnapshot[];
  storage_revision: string | null;
  generated_at: string;
}

export class ManjuCompatConflictError extends Error {
  constructor(message = "配置已被其他操作更新，请刷新后重试") {
    super(message);
    this.name = "ManjuCompatConflictError";
  }
}

export class ManjuCompatStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManjuCompatStoreError";
    this.code = code;
  }
}

function settingKey(environment: ManjuConfigEnvironment, domain: ManjuConfigDomain): string {
  return `${KEY_PREFIX}.${environment}.${domain}`;
}

function currentReleaseEtag(revision: Pick<ManjuConfigRevisionRow, "payload_hash">, releaseNumber: number): string {
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

async function assertLegacyCompatHasNoNativeControlPlane(
  client: SupabaseClient,
  environment: ManjuConfigEnvironment,
  domains: readonly ManjuConfigDomain[],
): Promise<void> {
  if (domains.length === 0) return;
  const nativeResult = await client
    .from("manju_config_revisions")
    .select("domain")
    .eq("environment", environment)
    .in("domain", [...domains])
    .limit(1);
  if (nativeResult.error) {
    if (isManjuMigrationNotReadyError(nativeResult.error)) return;
    throw new ManjuCompatStoreError("CONFIG_STORE_UNAVAILABLE", nativeResult.error.message);
  }
  throw new ManjuCompatStoreError(
    "CONFIG_STORAGE_AMBIGUOUS",
    "原生配置控制面已存在但缺少权威存储状态，已拒绝猜测读写来源",
  );
}

/**
 * Resolve the authoritative storage backend for each scope.
 *
 * The dedicated state table is authoritative. Missing rows mean `compat` only
 * when the same scope has no native state at all. `migrating` always fails
 * closed, and a future reviewed cutover transaction writes `native` last.
 */
export async function loadManjuStorageStates(
  client: SupabaseClient,
  environment: ManjuConfigEnvironment,
  requestedDomains: readonly ManjuConfigDomain[],
): Promise<Record<ManjuConfigDomain, ManjuConfigStorageSelection>> {
  const domains = Array.from(new Set(requestedDomains));
  const states = Object.fromEntries(
    MANJU_CONFIG_DOMAINS.map((domain) => [domain, { mode: "compat", generation: 0 }]),
  ) as Record<ManjuConfigDomain, ManjuConfigStorageSelection>;
  if (domains.length === 0) return states;

  const result = await client
    .from("manju_config_storage_state")
    .select("environment,domain,state,generation")
    .eq("environment", environment)
    .in("domain", domains);
  if (result.error) {
    if (isManjuMigrationNotReadyError(result.error)) {
      await assertLegacyCompatHasNoNativeControlPlane(client, environment, domains);
      return states;
    }
    throw new ManjuCompatStoreError("CONFIG_STORE_UNAVAILABLE", result.error.message);
  }

  const seen = new Set<ManjuConfigDomain>();
  for (const rawRow of result.data ?? []) {
    const row = rawRow as Partial<StorageStateRow>;
    const domain = row.domain;
    if (
      !domain ||
      !domains.includes(domain) ||
      row.environment !== environment ||
      seen.has(domain) ||
      !Number.isSafeInteger(row.generation) ||
      Number(row.generation) < 1
    ) {
      throw new ManjuCompatStoreError("CONFIG_STORAGE_MODE_CORRUPT", "配置存储切换标记重复或超出请求范围");
    }
    if (row.state === "migrating") {
      throw new ManjuCompatStoreError("CONFIG_STORAGE_MIGRATING", "配置域正在执行受控迁移，请稍后重试");
    }
    if (row.state !== "compat" && row.state !== "native") {
      throw new ManjuCompatStoreError("CONFIG_STORAGE_MODE_CORRUPT", "配置存储状态不合法");
    }
    states[domain] = { mode: row.state, generation: Number(row.generation) };
    seen.add(domain);
  }
  const missingDomains = domains.filter((domain) => !seen.has(domain));
  if (missingDomains.length > 0) {
    throw new ManjuCompatStoreError(
      "CONFIG_STORAGE_STATE_MISSING",
      `配置存储状态缺失: ${missingDomains.join(", ")}`,
    );
  }
  return states;
}

function emptyEnvelope(
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
  now = new Date().toISOString(),
): CompatEnvelope {
  return {
    format: "manju-platform-settings-v1",
    environment,
    domain,
    active: null,
    drafts: [],
    history: [],
    updated_at: now,
  };
}

function parseRevision(value: unknown, expectedEnvironment: ManjuConfigEnvironment, expectedDomain: ManjuConfigDomain): ManjuConfigRevisionRow {
  if (!value || typeof value !== "object") {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置修订记录不是对象");
  }
  const row = value as Partial<ManjuConfigRevisionRow>;
  if (
    typeof row.id !== "string" ||
    row.environment !== expectedEnvironment ||
    row.domain !== expectedDomain ||
    typeof row.version !== "number" ||
    !Number.isInteger(row.version) ||
    row.version < 1 ||
    typeof row.status !== "string" ||
    typeof row.payload_hash !== "string" ||
    typeof row.schema_version !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置修订记录字段不完整");
  }
  const validated = validateManjuConfigPayload(row.payload);
  validateManjuDomainContract(expectedDomain, validated.payload, row.schema_version, "stored");
  if (validated.payloadHash !== row.payload_hash) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置修订内容哈希不一致");
  }
  return { ...row, payload: validated.payload } as ManjuConfigRevisionRow;
}

function parseRelease(value: unknown, expectedEnvironment: ManjuConfigEnvironment, expectedDomain: ManjuConfigDomain): ManjuConfigReleaseRow {
  if (!value || typeof value !== "object") {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置发布记录不是对象");
  }
  const row = value as Partial<ManjuConfigReleaseRow>;
  if (
    typeof row.id !== "string" ||
    row.environment !== expectedEnvironment ||
    row.domain !== expectedDomain ||
    typeof row.release_number !== "number" ||
    !Number.isInteger(row.release_number) ||
    row.release_number < 1 ||
    typeof row.revision_id !== "string" ||
    (row.release_kind !== "publish" && row.release_kind !== "rollback") ||
    (row.previous_release_id !== null && typeof row.previous_release_id !== "string") ||
    (row.rollback_of_release_id !== null && typeof row.rollback_of_release_id !== "string") ||
    (row.release_kind === "publish" && row.rollback_of_release_id !== null) ||
    (row.release_kind === "rollback" && typeof row.rollback_of_release_id !== "string") ||
    typeof row.etag !== "string" ||
    (!CURRENT_ETAG_PATTERN.test(row.etag) && !LEGACY_ETAG_PATTERN.test(row.etag)) ||
    (row.released_by !== null && typeof row.released_by !== "string") ||
    typeof row.created_at !== "string"
  ) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置发布记录字段不完整");
  }
  return row as ManjuConfigReleaseRow;
}

function parseEnvelope(
  value: unknown,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
): CompatEnvelope {
  if (!value || typeof value !== "object") {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置存储不是对象");
  }
  const source = value as Partial<CompatEnvelope>;
  if (
    source.format !== "manju-platform-settings-v1" ||
    source.environment !== environment ||
    source.domain !== domain ||
    typeof source.updated_at !== "string" ||
    !Array.isArray(source.drafts) ||
    !Array.isArray(source.history)
  ) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置存储格式或作用域不合法");
  }

  const drafts = source.drafts.map((row) => parseRevision(row, environment, domain));
  const releaseIds = new Set<string>();
  const releaseNumbers = new Set<number>();
  let previousReleaseNumber = Number.POSITIVE_INFINITY;
  const history = source.history.slice(0, MAX_HISTORY).map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置历史记录不合法");
    }
    const snapshot = entry as Partial<CompatReleaseSnapshot>;
    const release = parseRelease(snapshot.release, environment, domain);
    const revision = parseRevision(snapshot.revision, environment, domain);
    if (
      release.revision_id !== revision.id
      || !releaseEtagMatches(release, revision)
      || releaseIds.has(release.id)
      || releaseNumbers.has(release.release_number)
      || release.release_number >= previousReleaseNumber
    ) {
      throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置发布记录与修订记录不一致");
    }
    releaseIds.add(release.id);
    releaseNumbers.add(release.release_number);
    previousReleaseNumber = release.release_number;
    return { release, revision };
  });

  for (let index = 0; index < history.length - 1; index += 1) {
    if (history[index].release.previous_release_id !== history[index + 1].release.id) {
      throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置发布历史链不连续");
    }
  }

  let active: CompatEnvelope["active"] = null;
  if (source.active) {
    const pointer = source.active.pointer as ManjuConfigActiveRow;
    const release = parseRelease(source.active.release, environment, domain);
    const revision = parseRevision(source.active.revision, environment, domain);
    if (
      pointer?.environment !== environment ||
      pointer?.domain !== domain ||
      pointer.active_release_id !== release.id ||
      pointer.active_revision_id !== revision.id ||
      release.revision_id !== revision.id ||
      pointer.etag !== release.etag ||
      !releaseEtagMatches(release, revision) ||
      revision.status !== "published" ||
      !revision.published_at ||
      history.length === 0 ||
      history[0].release.id !== release.id ||
      history[0].revision.id !== revision.id ||
      history[0].release.etag !== release.etag
    ) {
      throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置活动指针不一致");
    }
    active = { pointer, release, revision };
  }

  if (!source.active && history.length > 0) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置历史存在但活动指针缺失");
  }

  return { ...source, active, drafts, history } as CompatEnvelope;
}

function storageRevision(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const exactDatabaseValue = value.trim();
  const date = new Date(exactDatabaseValue);
  return Number.isNaN(date.getTime()) ? null : exactDatabaseValue;
}

async function loadEnvelope(
  client: SupabaseClient,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
): Promise<LoadedCompatEnvelope> {
  const result = await client
    .from("platform_settings")
    .select("setting_value,updated_at")
    .eq("setting_key", settingKey(environment, domain))
    .maybeSingle();
  if (result.error) throw new ManjuCompatStoreError("CONFIG_STORE_UNAVAILABLE", result.error.message);
  if (!result.data?.setting_value) {
    return { envelope: emptyEnvelope(environment, domain), persisted: false, storageRevision: null };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(String(result.data.setting_value));
  } catch {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "配置存储 JSON 无法解析");
  }
  return {
    envelope: parseEnvelope(decoded, environment, domain),
    persisted: true,
    storageRevision: storageRevision(result.data.updated_at),
  };
}

function committedStorageRevision(value: unknown, message: string): string {
  const revision = storageRevision(value);
  if (!revision) {
    throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", message);
  }
  return revision;
}

async function persistLegacyEnvelope(
  client: SupabaseClient,
  loaded: LoadedCompatEnvelope,
  envelope: CompatEnvelope,
): Promise<string> {
  const now = new Date().toISOString();
  const nextEnvelope = { ...envelope, updated_at: now };
  const settingValue = JSON.stringify(nextEnvelope);
  const key = settingKey(envelope.environment, envelope.domain);

  if (loaded.persisted) {
    if (!loaded.storageRevision) {
      throw new ManjuCompatStoreError("CONFIG_STORE_CORRUPT", "兼容配置缺少可校验的存储版本");
    }
    const committed = await client
      .from("platform_settings")
      .update({ setting_value: settingValue, updated_at: now })
      .eq("setting_key", key)
      .eq("updated_at", loaded.storageRevision)
      .select("updated_at")
      .maybeSingle();
    if (committed.error) {
      if (isManjuConflictError(committed.error)) throw new ManjuCompatConflictError();
      throw new ManjuCompatStoreError("CONFIG_STORE_UNAVAILABLE", committed.error.message);
    }
    if (!committed.data) throw new ManjuCompatConflictError();
    return committedStorageRevision(committed.data.updated_at, "兼容配置提交未返回有效存储版本");
  }

  const committed = await client
    .from("platform_settings")
    .insert({ setting_key: key, setting_value: settingValue, updated_at: now })
    .select("updated_at")
    .single();
  if (committed.error) {
    if (isManjuConflictError(committed.error)) throw new ManjuCompatConflictError();
    throw new ManjuCompatStoreError("CONFIG_STORE_UNAVAILABLE", committed.error.message);
  }
  return committedStorageRevision(committed.data?.updated_at, "兼容配置初始化未返回有效存储版本");
}

async function persistEnvelope(
  client: SupabaseClient,
  loaded: LoadedCompatEnvelope,
  envelope: CompatEnvelope,
  expectedStorageGeneration: number,
): Promise<string> {
  if (!Number.isSafeInteger(expectedStorageGeneration) || expectedStorageGeneration < 0) {
    throw new ManjuCompatStoreError(
      "CONFIG_STORAGE_MODE_CORRUPT",
      "Manju 配置存储代次不合法",
    );
  }
  if (expectedStorageGeneration === 0) {
    return persistLegacyEnvelope(client, loaded, envelope);
  }
  const now = new Date().toISOString();
  const nextEnvelope = { ...envelope, updated_at: now };
  const committed = await client.rpc("commit_manju_config_compat_envelope", {
    p_environment: envelope.environment,
    p_domain: envelope.domain,
    p_expected_generation: expectedStorageGeneration,
    p_expected_storage_revision: loaded.storageRevision,
    p_envelope: nextEnvelope,
  });
  if (committed.error) {
    if (isManjuConflictError(committed.error)) throw new ManjuCompatConflictError();
    throw new ManjuCompatStoreError(
      isManjuMigrationNotReadyError(committed.error) ? "MIGRATION_NOT_READY" : "CONFIG_STORE_UNAVAILABLE",
      committed.error.message,
    );
  }
  const result = Array.isArray(committed.data) ? committed.data[0] : committed.data;
  const revision = storageRevision(
    result && typeof result === "object"
      ? (result as { storage_revision?: unknown }).storage_revision
      : null,
  );
  return committedStorageRevision(revision, "兼容配置原子提交未返回有效存储版本");
}

function nextVersion(envelope: CompatEnvelope): number {
  return Math.max(
    0,
    envelope.active?.revision.version ?? 0,
    ...envelope.drafts.map((item) => item.version),
    ...envelope.history.map((item) => item.revision.version),
  ) + 1;
}

function nextReleaseNumber(envelope: CompatEnvelope): number {
  return Math.max(0, ...envelope.history.map((item) => item.release.release_number)) + 1;
}

export async function loadManjuCompatAdmin(
  client: SupabaseClient,
  environment: ManjuConfigEnvironment,
  domain: ManjuConfigDomain,
): Promise<ManjuCompatAdminView> {
  const loaded = await loadEnvelope(client, environment, domain);
  return {
    ok: true,
    storage_mode: "compat",
    environment,
    domain,
    active: loaded.envelope.active,
    drafts: loaded.envelope.drafts,
    history: loaded.envelope.history,
    storage_revision: loaded.storageRevision,
    generated_at: new Date().toISOString(),
  };
}

export async function saveManjuCompatDraft(
  client: SupabaseClient,
  input: {
    environment: ManjuConfigEnvironment;
    domain: ManjuConfigDomain;
    payload: ManjuConfigPayload;
    schemaVersion: string;
    revisionId?: string | null;
    expectedUpdatedAt?: string | null;
    actorId: string;
    expectedStorageGeneration: number;
  },
): Promise<ManjuConfigRevisionRow> {
  const loaded = await loadEnvelope(client, input.environment, input.domain);
  const envelope = loaded.envelope;
  const validated = validateManjuConfigPayload(input.payload);
  validateManjuDomainContract(input.domain, validated.payload, input.schemaVersion);
  const now = new Date().toISOString();
  let revision: ManjuConfigRevisionRow;

  if (input.revisionId) {
    const existing = envelope.drafts.find((item) => item.id === input.revisionId);
    if (!existing || existing.status !== "draft") throw new ManjuCompatConflictError("草稿不存在或已经发布");
    if (!input.expectedUpdatedAt || existing.updated_at !== input.expectedUpdatedAt) {
      throw new ManjuCompatConflictError("草稿已变化，请刷新后重试");
    }
    revision = {
      ...existing,
      payload: validated.payload,
      payload_hash: validated.payloadHash,
      schema_version: input.schemaVersion,
      updated_at: now,
    };
    envelope.drafts = envelope.drafts.map((item) => item.id === revision.id ? revision : item);
  } else {
    if (input.expectedUpdatedAt) throw new ManjuCompatConflictError("新草稿不能携带旧修订时间");
    revision = {
      id: randomUUID(),
      environment: input.environment,
      domain: input.domain,
      version: nextVersion(envelope),
      status: "draft",
      payload: validated.payload,
      payload_hash: validated.payloadHash,
      schema_version: input.schemaVersion,
      parent_revision_id: envelope.active?.revision.id ?? null,
      created_by: input.actorId,
      created_at: now,
      updated_at: now,
      published_at: null,
    };
    envelope.drafts = [revision, ...envelope.drafts].slice(0, 10);
  }

  await persistEnvelope(client, loaded, envelope, input.expectedStorageGeneration);
  return revision;
}

export async function publishManjuCompatRevision(
  client: SupabaseClient,
  input: {
    environment: ManjuConfigEnvironment;
    domain: ManjuConfigDomain;
    revisionId: string;
    expectedActiveReleaseId?: string | null;
    actorId: string;
    expectedStorageGeneration: number;
  },
): Promise<ManjuConfigReleaseRow> {
  const loaded = await loadEnvelope(client, input.environment, input.domain);
  const envelope = loaded.envelope;
  const draft = envelope.drafts.find((item) => item.id === input.revisionId);
  if (!draft) throw new ManjuCompatConflictError("草稿不存在或已发布");
  validateManjuDomainContract(input.domain, draft.payload, draft.schema_version);
  const currentReleaseId = envelope.active?.release.id ?? null;
  if ((input.expectedActiveReleaseId ?? null) !== currentReleaseId) {
    throw new ManjuCompatConflictError("活动版本已变化，请刷新后重试");
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
    environment: revision.environment,
    domain: revision.domain,
    release_number: releaseNumber,
    revision_id: revision.id,
    previous_release_id: currentReleaseId,
    release_kind: "publish",
    rollback_of_release_id: null,
    etag: `${revision.payload_hash}:${releaseNumber}`,
    released_by: input.actorId,
    created_at: now,
  };
  const pointer: ManjuConfigActiveRow = {
    environment: revision.environment,
    domain: revision.domain,
    active_release_id: release.id,
    active_revision_id: revision.id,
    etag: release.etag,
    updated_by: input.actorId,
    updated_at: now,
  };
  envelope.active = { pointer, release, revision };
  envelope.drafts = envelope.drafts.filter((item) => item.id !== revision.id);
  envelope.history = [{ release, revision }, ...envelope.history].slice(0, MAX_HISTORY);
  await persistEnvelope(client, loaded, envelope, input.expectedStorageGeneration);
  return release;
}

export async function rollbackManjuCompatRelease(
  client: SupabaseClient,
  input: {
    environment: ManjuConfigEnvironment;
    domain: ManjuConfigDomain;
    targetReleaseId: string;
    expectedActiveReleaseId: string;
    actorId: string;
    expectedStorageGeneration: number;
  },
): Promise<ManjuConfigReleaseRow> {
  const loaded = await loadEnvelope(client, input.environment, input.domain);
  const envelope = loaded.envelope;
  if (!envelope.active || envelope.active.release.id !== input.expectedActiveReleaseId) {
    throw new ManjuCompatConflictError("活动版本已变化，请刷新后重试");
  }
  const target = envelope.history.find((item) => item.release.id === input.targetReleaseId);
  if (!target) throw new ManjuCompatConflictError("目标历史版本不存在");
  validateManjuDomainContract(input.domain, target.revision.payload, target.revision.schema_version);
  const now = new Date().toISOString();
  const revision: ManjuConfigRevisionRow = {
    ...target.revision,
    id: randomUUID(),
    version: nextVersion(envelope),
    status: "published",
    parent_revision_id: envelope.active.revision.id,
    created_by: input.actorId,
    created_at: now,
    updated_at: now,
    published_at: now,
  };
  const releaseNumber = nextReleaseNumber(envelope);
  const release: ManjuConfigReleaseRow = {
    id: randomUUID(),
    environment: input.environment,
    domain: input.domain,
    release_number: releaseNumber,
    revision_id: revision.id,
    previous_release_id: envelope.active.release.id,
    release_kind: "rollback",
    rollback_of_release_id: target.release.id,
    etag: `${revision.payload_hash}:${releaseNumber}`,
    released_by: input.actorId,
    created_at: now,
  };
  const pointer: ManjuConfigActiveRow = {
    environment: input.environment,
    domain: input.domain,
    active_release_id: release.id,
    active_revision_id: revision.id,
    etag: release.etag,
    updated_by: input.actorId,
    updated_at: now,
  };
  envelope.active = { pointer, release, revision };
  envelope.history = [{ release, revision }, ...envelope.history].slice(0, MAX_HISTORY);
  await persistEnvelope(client, loaded, envelope, input.expectedStorageGeneration);
  return release;
}

export async function loadManjuCompatPublic(
  client: SupabaseClient,
  requestedDomains: readonly ManjuConfigDomain[] = MANJU_CONFIG_DOMAINS,
): Promise<{
  domains: Partial<Record<ManjuConfigDomain, ManjuConfigPayload>>;
  domainEtags: Partial<Record<ManjuConfigDomain, string>>;
  missingDomains: ManjuConfigDomain[];
}> {
  const pairs = await Promise.all(
    requestedDomains.map(async (domain) => ({ domain, loaded: await loadEnvelope(client, "production", domain) })),
  );
  const domains: Partial<Record<ManjuConfigDomain, ManjuConfigPayload>> = {};
  const domainEtags: Partial<Record<ManjuConfigDomain, string>> = {};
  const missingDomains: ManjuConfigDomain[] = [];
  for (const { domain, loaded } of pairs) {
    const active = loaded.envelope.active;
    if (!active) {
      missingDomains.push(domain);
      continue;
    }
    try {
      if (active.revision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION) {
        throw new Error("public schema upgrade required");
      }
      domains[domain] = sanitizeManjuPublicPayload(active.revision.payload);
      domainEtags[domain] = active.release.etag;
    } catch {
      missingDomains.push(domain);
    }
  }
  return { domains, domainEtags, missingDomains };
}
