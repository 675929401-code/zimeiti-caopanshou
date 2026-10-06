// Server-only by construction: this repository uses node:crypto and the
// service-role Supabase client, and is imported only by short-drama API code.
import { createHash, randomUUID } from "node:crypto";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  ShortDramaEntitySchema,
  ShortDramaProjectSchema,
  ShortDramaShotSchema,
  type CreateShortDramaEntityRequest,
  type CreateShortDramaProjectRequest,
  type CreateShortDramaShotRequest,
  type ListShortDramaEntitiesQuery,
  type ListShortDramaProjectsQuery,
  type ListShortDramaShotsQuery,
  type ShortDramaEntity,
  type ShortDramaProject,
  type ShortDramaShot,
  type UpdateShortDramaEntityRequest,
  type UpdateShortDramaProjectRequest,
  type UpdateShortDramaShotRequest,
} from "./contracts";
import { canonicalJson } from "./idempotency";

export const SHORT_DRAMA_COMPAT_CONTRACT = "short-drama-platform-settings-v1";
export const SHORT_DRAMA_COMPAT_KEY_PREFIX = "sd.compat.v1";

type CompatDatabase = ReturnType<typeof getSupabaseClient>;
type CompatKind = "project" | "entity" | "shot";

interface PlatformSettingRow {
  setting_key: string;
  setting_value: string;
  updated_at: string | null;
}

interface CompatEnvelope<T> {
  contract: typeof SHORT_DRAMA_COMPAT_CONTRACT;
  kind: CompatKind;
  ownerId: string;
  projectId: string;
  deletedAt: string | null;
  value: T;
}

interface LoadedCompat<T> {
  key: string;
  envelope: CompatEnvelope<T>;
  storageRevision: string | null;
}

export type ShortDramaCompatReadiness =
  | {
      readonly ok: true;
      readonly status: "ready";
      readonly contract: typeof SHORT_DRAMA_COMPAT_CONTRACT;
      readonly writeVerification: "not-run-read-only" | "insert-read-enumerate-update-cas-delete-read";
    }
  | {
      readonly ok: false;
      readonly status: "unavailable" | "self-check-failed";
      readonly code: "COMPAT_STORAGE_UNAVAILABLE" | "COMPAT_SELF_CHECK_FAILED";
      readonly error: string;
    };

export class ShortDramaCompatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaCompatError";
  }
}

let writeReadinessCache:
  | { expiresAt: number; result: ShortDramaCompatReadiness }
  | null = null;
let writeReadinessPromise: Promise<ShortDramaCompatReadiness> | null = null;

function ownerSegment(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 24);
}

function userPrefix(userId: string): string {
  return `${SHORT_DRAMA_COMPAT_KEY_PREFIX}.u.${ownerSegment(userId)}`;
}

export function compatProjectKey(userId: string, projectId: string): string {
  return `${userPrefix(userId)}.p.${projectId}`;
}

export function compatEntityKey(userId: string, projectId: string, entityId: string): string {
  return `${compatProjectKey(userId, projectId)}.e.${entityId}`;
}

export function compatShotKey(userId: string, projectId: string, shotId: string): string {
  return `${compatProjectKey(userId, projectId)}.s.${shotId}`;
}

function projectPrefix(userId: string): string {
  return `${userPrefix(userId)}.p.`;
}

function entityPrefix(userId: string, projectId: string): string {
  return `${compatProjectKey(userId, projectId)}.e.`;
}

function shotPrefix(userId: string, projectId: string): string {
  return `${compatProjectKey(userId, projectId)}.s.`;
}

function exactProjectKeyPattern(userId: string): RegExp {
  return new RegExp(`^${escapeRegExp(projectPrefix(userId))}[0-9a-f-]{36}$`, "i");
}

function exactEntityKeyPattern(userId: string, projectId: string): RegExp {
  return new RegExp(`^${escapeRegExp(entityPrefix(userId, projectId))}[0-9a-f-]{36}$`, "i");
}

function exactShotKeyPattern(userId: string, projectId: string): RegExp {
  return new RegExp(`^${escapeRegExp(shotPrefix(userId, projectId))}[0-9a-f-]{36}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function storageError(
  code: string,
  message: string,
  status = 503,
): ShortDramaCompatError {
  return new ShortDramaCompatError(status, code, message);
}

function nextUpdatedAt(previous: string | null): string {
  const previousTime = previous ? new Date(previous).getTime() : 0;
  const now = Date.now();
  return new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : now)).toISOString();
}

function parseSettingValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw storageError("COMPAT_DATA_INVALID", "兼容存储中的影视项目数据无法解析");
  }
}

function parseEnvelope<T>(
  row: PlatformSettingRow,
  expected: { ownerId: string; kind: CompatKind; projectId?: string },
  parseValue: (value: unknown) => T,
): LoadedCompat<T> {
  const raw = parseSettingValue(String(row.setting_value || ""));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw storageError("COMPAT_DATA_INVALID", "兼容存储中的影视项目数据不符合合同");
  }
  const envelope = raw as Record<string, unknown>;
  if (
    envelope.contract !== SHORT_DRAMA_COMPAT_CONTRACT
    || envelope.kind !== expected.kind
    || envelope.ownerId !== expected.ownerId
    || typeof envelope.projectId !== "string"
    || expected.projectId && envelope.projectId !== expected.projectId
    || !(envelope.deletedAt === null || typeof envelope.deletedAt === "string")
  ) {
    throw storageError("COMPAT_OWNER_CONTRACT_MISMATCH", "兼容存储的归属合同校验失败", 403);
  }
  return {
    key: row.setting_key,
    storageRevision: row.updated_at,
    envelope: {
      contract: SHORT_DRAMA_COMPAT_CONTRACT,
      kind: expected.kind,
      ownerId: expected.ownerId,
      projectId: envelope.projectId,
      deletedAt: envelope.deletedAt as string | null,
      value: parseValue(envelope.value),
    },
  };
}

function parseProjectValue(value: unknown): ShortDramaProject {
  const parsed = ShortDramaProjectSchema.safeParse(value);
  if (!parsed.success) {
    throw storageError("COMPAT_PROJECT_DATA_INVALID", "兼容存储中的项目数据不符合合同");
  }
  return parsed.data;
}

function parseEntityValue(value: unknown): ShortDramaEntity {
  const parsed = ShortDramaEntitySchema.safeParse(value);
  if (!parsed.success) {
    throw storageError("COMPAT_ENTITY_DATA_INVALID", "兼容存储中的实体数据不符合合同");
  }
  return parsed.data;
}

function parseShotValue(value: unknown): ShortDramaShot {
  const parsed = ShortDramaShotSchema.safeParse(value);
  if (!parsed.success) {
    throw storageError("COMPAT_SHOT_DATA_INVALID", "兼容存储中的镜头数据不符合合同");
  }
  return parsed.data;
}

async function readExact(
  db: CompatDatabase,
  key: string,
): Promise<PlatformSettingRow | null> {
  const { data, error } = await db
    .from("platform_settings")
    .select("setting_key, setting_value, updated_at")
    .eq("setting_key", key)
    .maybeSingle();
  if (error) throw storageError("COMPAT_STORAGE_UNAVAILABLE", "影视工坊兼容存储暂时不可用");
  return data ? data as PlatformSettingRow : null;
}

async function verifyReadback(
  db: CompatDatabase,
  key: string,
  serialized: string,
): Promise<PlatformSettingRow> {
  const readback = await readExact(db, key);
  if (!readback || canonicalJson(parseSettingValue(readback.setting_value)) !== canonicalJson(parseSettingValue(serialized))) {
    throw storageError("COMPAT_WRITE_VERIFY_FAILED", "影视工坊兼容存储写后校验失败");
  }
  return readback;
}

async function insertVerified(
  db: CompatDatabase,
  key: string,
  envelope: CompatEnvelope<unknown>,
): Promise<PlatformSettingRow> {
  const serialized = JSON.stringify(envelope);
  const updatedAt = nextUpdatedAt(null);
  const { error } = await db.from("platform_settings").insert({
    setting_key: key,
    setting_value: serialized,
    updated_at: updatedAt,
  });
  if (error) {
    if (String(error.code || "") === "23505") {
      throw storageError("COMPAT_REVISION_CONFLICT", "影视项目已被其他请求创建，请刷新后重试", 409);
    }
    throw storageError("COMPAT_STORAGE_UNAVAILABLE", "影视工坊兼容存储暂时不可用");
  }
  return verifyReadback(db, key, serialized);
}

async function updateVerified(
  db: CompatDatabase,
  key: string,
  envelope: CompatEnvelope<unknown>,
  expectedStorageRevision: string | null,
): Promise<PlatformSettingRow> {
  const serialized = JSON.stringify(envelope);
  const updatedAt = nextUpdatedAt(expectedStorageRevision);
  let query = db
    .from("platform_settings")
    .update({ setting_value: serialized, updated_at: updatedAt })
    .eq("setting_key", key);
  query = expectedStorageRevision
    ? query.eq("updated_at", expectedStorageRevision)
    : query.is("updated_at", null);
  const { data, error } = await query.select("setting_key").maybeSingle();
  if (error) throw storageError("COMPAT_STORAGE_UNAVAILABLE", "影视工坊兼容存储暂时不可用");
  if (!data) {
    throw storageError("COMPAT_REVISION_CONFLICT", "影视项目已被其他请求更新，请刷新后重试", 409);
  }
  return verifyReadback(db, key, serialized);
}

async function enumerateRows(
  db: CompatDatabase,
  prefix: string,
): Promise<PlatformSettingRow[]> {
  const rows: PlatformSettingRow[] = [];
  const pageSize = 500;
  const maximumRows = 10_000;
  for (let offset = 0; offset < maximumRows; offset += pageSize) {
    const { data, error } = await db
      .from("platform_settings")
      .select("setting_key, setting_value, updated_at")
      .like("setting_key", `${prefix}%`)
      .order("updated_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw storageError("COMPAT_STORAGE_UNAVAILABLE", "影视工坊兼容存储暂时不可用");
    const page = (data || []) as PlatformSettingRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
  throw storageError(
    "COMPAT_ENUMERATION_LIMIT",
    "影视工坊兼容存储条目过多，已停止返回不完整数据",
    503,
  );
}

async function runCompatSelfCheck(db: CompatDatabase): Promise<ShortDramaCompatReadiness> {
  const nonce = randomUUID();
  const key = `${SHORT_DRAMA_COMPAT_KEY_PREFIX}.probe.${nonce}`;
  const initialValue = JSON.stringify({ contract: SHORT_DRAMA_COMPAT_CONTRACT, nonce, revision: 1 });
  const updatedValue = JSON.stringify({ contract: SHORT_DRAMA_COMPAT_CONTRACT, nonce, revision: 2 });
  let inserted = false;
  try {
    const readProbe = await db
      .from("platform_settings")
      .select("setting_key, setting_value, updated_at")
      .limit(1);
    if (readProbe.error) {
      return {
        ok: false,
        status: "unavailable",
        code: "COMPAT_STORAGE_UNAVAILABLE",
        error: "影视工坊兼容存储合同不可用",
      };
    }

    const insert = await db.from("platform_settings").insert({
      setting_key: key,
      setting_value: initialValue,
      updated_at: new Date().toISOString(),
    });
    if (insert.error) throw insert.error;
    inserted = true;

    const readback = await readExact(db, key);
    if (!readback || readback.setting_value !== initialValue || !readback.updated_at) {
      throw new Error("compat readback mismatch");
    }

    const enumerated = await enumerateRows(db, `${SHORT_DRAMA_COMPAT_KEY_PREFIX}.probe.`);
    if (enumerated.filter((row) => row.setting_key === key).length !== 1) {
      throw new Error("compat enumeration mismatch");
    }

    const duplicate = await db.from("platform_settings").insert({
      setting_key: key,
      setting_value: initialValue,
      updated_at: new Date().toISOString(),
    });
    if (!duplicate.error || String(duplicate.error.code || "") !== "23505") {
      throw new Error("compat unique-key contract missing");
    }

    const updateTimestamp = nextUpdatedAt(readback.updated_at);
    const updated = await db
      .from("platform_settings")
      .update({ setting_value: updatedValue, updated_at: updateTimestamp })
      .eq("setting_key", key)
      .eq("updated_at", readback.updated_at)
      .select("setting_key")
      .maybeSingle();
    if (updated.error || !updated.data) throw updated.error || new Error("compat update failed");

    const updatedReadback = await readExact(db, key);
    if (!updatedReadback || updatedReadback.setting_value !== updatedValue) {
      throw new Error("compat update readback mismatch");
    }

    const staleCas = await db
      .from("platform_settings")
      .update({ setting_value: initialValue, updated_at: nextUpdatedAt(updatedReadback.updated_at) })
      .eq("setting_key", key)
      .eq("updated_at", readback.updated_at)
      .select("setting_key")
      .maybeSingle();
    if (staleCas.error || staleCas.data) {
      throw staleCas.error || new Error("compat stale CAS unexpectedly succeeded");
    }

    const removed = await db
      .from("platform_settings")
      .delete()
      .eq("setting_key", key)
      .eq("setting_value", updatedValue)
      .eq("updated_at", updatedReadback.updated_at)
      .select("setting_key")
      .maybeSingle();
    if (removed.error || !removed.data) throw removed.error || new Error("compat cleanup failed");
    inserted = false;

    if (await readExact(db, key)) throw new Error("compat cleanup verification failed");
    return {
      ok: true,
      status: "ready",
      contract: SHORT_DRAMA_COMPAT_CONTRACT,
      writeVerification: "insert-read-enumerate-update-cas-delete-read",
    };
  } catch {
    return {
      ok: false,
      status: "self-check-failed",
      code: "COMPAT_SELF_CHECK_FAILED",
      error: "影视工坊兼容存储完整自检未通过",
    };
  } finally {
    if (inserted) {
      await db.from("platform_settings").delete().eq("setting_key", key).catch(() => undefined);
    }
  }
}

/**
 * Read-only compatibility probe used by health checks and GET repositories.
 * It proves that the backing table can be queried without creating a probe
 * row. Mutation routes run the stronger write contract below before changing
 * user data.
 */
export async function probeShortDramaCompatReadiness(
  db: CompatDatabase = getSupabaseClient(),
): Promise<ShortDramaCompatReadiness> {
  const probe = await db
    .from("platform_settings")
    .select("setting_key, setting_value, updated_at")
    .limit(1);
  if (probe.error) {
    return {
      ok: false,
      status: "unavailable",
      code: "COMPAT_STORAGE_UNAVAILABLE",
      error: "影视工坊兼容存储合同不可用",
    };
  }
  return {
    ok: true,
    status: "ready",
    contract: SHORT_DRAMA_COMPAT_CONTRACT,
    writeVerification: "not-run-read-only",
  };
}

export async function verifyShortDramaCompatWriteReadiness(
  db: CompatDatabase = getSupabaseClient(),
): Promise<ShortDramaCompatReadiness> {
  const now = Date.now();
  if (writeReadinessCache && writeReadinessCache.expiresAt > now) return writeReadinessCache.result;
  if (writeReadinessPromise) return writeReadinessPromise;

  writeReadinessPromise = runCompatSelfCheck(db).then((result) => {
    writeReadinessCache = { expiresAt: Date.now() + 5 * 60_000, result };
    return result;
  }).finally(() => {
    writeReadinessPromise = null;
  });
  return writeReadinessPromise;
}

interface CompatProjectEnvelopeValue {
  project: ShortDramaProject;
  clientRequestId: string;
  requestHash: string;
}

function parseCompatProjectValue(value: unknown): CompatProjectEnvelopeValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw storageError("COMPAT_PROJECT_DATA_INVALID", "兼容存储中的项目数据不符合合同");
  }
  const record = value as Record<string, unknown>;
  return {
    project: parseProjectValue(record.project),
    clientRequestId: String(record.clientRequestId || ""),
    requestHash: String(record.requestHash || ""),
  };
}

export class ShortDramaCompatRepository {
  constructor(private readonly db: CompatDatabase = getSupabaseClient()) {}

  private async assertReady(write = false): Promise<void> {
    const readiness = write
      ? await verifyShortDramaCompatWriteReadiness(this.db)
      : await probeShortDramaCompatReadiness(this.db);
    if (!readiness.ok) {
      throw storageError(readiness.code, readiness.error);
    }
  }

  private async loadProjectRecord(
    userId: string,
    projectId: string,
  ): Promise<LoadedCompat<CompatProjectEnvelopeValue> | null> {
    const row = await readExact(this.db, compatProjectKey(userId, projectId));
    return row
      ? parseEnvelope(
        row,
        { ownerId: userId, projectId, kind: "project" },
        parseCompatProjectValue,
      )
      : null;
  }

  private async loadEntityRecord(
    userId: string,
    projectId: string,
    entityId: string,
  ): Promise<LoadedCompat<ShortDramaEntity> | null> {
    const row = await readExact(this.db, compatEntityKey(userId, projectId, entityId));
    return row
      ? parseEnvelope(
        row,
        { ownerId: userId, projectId, kind: "entity" },
        parseEntityValue,
      )
      : null;
  }

  private async loadShotRecord(
    userId: string,
    projectId: string,
    shotId: string,
  ): Promise<LoadedCompat<ShortDramaShot> | null> {
    const row = await readExact(this.db, compatShotKey(userId, projectId, shotId));
    return row
      ? parseEnvelope(
        row,
        { ownerId: userId, projectId, kind: "shot" },
        parseShotValue,
      )
      : null;
  }

  private async loadProjectShots(userId: string, projectId: string): Promise<ShortDramaShot[]> {
    const pattern = exactShotKeyPattern(userId, projectId);
    return (await enumerateRows(this.db, shotPrefix(userId, projectId)))
      .filter((row) => pattern.test(row.setting_key))
      .map((row) => parseEnvelope(
        row,
        { ownerId: userId, projectId, kind: "shot" },
        parseShotValue,
      ))
      .filter((record) => record.envelope.deletedAt === null)
      .map((record) => record.envelope.value)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async listProjects(
    userId: string,
    query: ListShortDramaProjectsQuery,
  ): Promise<{ projects: ShortDramaProject[]; total: number }> {
    await this.assertReady();
    const pattern = exactProjectKeyPattern(userId);
    const loaded = (await enumerateRows(this.db, projectPrefix(userId)))
      .filter((row) => pattern.test(row.setting_key))
      .map((row) => parseEnvelope(
        row,
        { ownerId: userId, kind: "project" },
        parseCompatProjectValue,
      ))
      .filter((record) => record.envelope.deletedAt === null)
      .map((record) => record.envelope.value.project)
      .filter((project) => !query.status || project.status === query.status)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    return {
      projects: loaded.slice(query.offset, query.offset + query.limit),
      total: loaded.length,
    };
  }

  async getProject(userId: string, projectId: string): Promise<ShortDramaProject | null> {
    await this.assertReady();
    const record = await this.loadProjectRecord(userId, projectId);
    return record && record.envelope.deletedAt === null
      ? record.envelope.value.project
      : null;
  }

  async createProject(
    userId: string,
    input: CreateShortDramaProjectRequest,
    requestHash: string,
  ): Promise<{ project: ShortDramaProject; replayed: boolean }> {
    await this.assertReady(true);
    const pattern = exactProjectKeyPattern(userId);
    const existing = (await enumerateRows(this.db, projectPrefix(userId)))
      .filter((row) => pattern.test(row.setting_key))
      .map((row) => parseEnvelope(
        row,
        { ownerId: userId, kind: "project" },
        parseCompatProjectValue,
      ));
    for (const record of existing) {
      if (record.envelope.value.clientRequestId !== input.clientRequestId) continue;
      if (record.envelope.value.requestHash !== requestHash) {
        throw storageError(
          "IDEMPOTENCY_CONFLICT",
          "相同请求标识已用于不同内容",
          409,
        );
      }
      return { project: record.envelope.value.project, replayed: true };
    }

    const now = new Date().toISOString();
    const project = ShortDramaProjectSchema.parse({
      id: randomUUID(),
      title: input.title,
      description: input.description || "",
      projectType: input.projectType,
      status: "draft",
      sourcePayload: input.sourcePayload,
      settings: input.settings,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope: CompatEnvelope<CompatProjectEnvelopeValue> = {
      contract: SHORT_DRAMA_COMPAT_CONTRACT,
      kind: "project",
      ownerId: userId,
      projectId: project.id,
      deletedAt: null,
      value: { project, clientRequestId: input.clientRequestId, requestHash },
    };
    await insertVerified(this.db, compatProjectKey(userId, project.id), envelope);
    return { project, replayed: false };
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: UpdateShortDramaProjectRequest,
  ): Promise<ShortDramaProject> {
    await this.assertReady(true);
    const loaded = await this.loadProjectRecord(userId, projectId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const current = loaded.envelope.value.project;
    if (current.revision !== input.expectedRevision) {
      throw storageError("REVISION_CONFLICT", "项目已被其他请求更新，请刷新后重试", 409);
    }
    const project = ShortDramaProjectSchema.parse({
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description || "" } : {}),
      ...(input.projectType !== undefined ? { projectType: input.projectType } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sourcePayload !== undefined ? { sourcePayload: input.sourcePayload } : {}),
      ...(input.settings !== undefined
        ? { settings: { ...current.settings, ...input.settings } }
        : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<CompatProjectEnvelopeValue> = {
      ...loaded.envelope,
      value: { ...loaded.envelope.value, project },
    };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return project;
  }

  async deleteProject(
    userId: string,
    projectId: string,
    expectedRevision?: number,
  ): Promise<ShortDramaProject> {
    await this.assertReady(true);
    const loaded = await this.loadProjectRecord(userId, projectId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const current = loaded.envelope.value.project;
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw storageError("REVISION_CONFLICT", "项目已被其他请求更新，请刷新后重试", 409);
    }
    const project = ShortDramaProjectSchema.parse({
      ...current,
      status: "archived",
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<CompatProjectEnvelopeValue> = {
      ...loaded.envelope,
      deletedAt: new Date().toISOString(),
      value: { ...loaded.envelope.value, project },
    };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return project;
  }

  async listEntities(
    userId: string,
    projectId: string,
    query: ListShortDramaEntitiesQuery,
  ): Promise<{ entities: ShortDramaEntity[]; total: number }> {
    await this.assertReady();
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const pattern = exactEntityKeyPattern(userId, projectId);
    const entities = (await enumerateRows(this.db, entityPrefix(userId, projectId)))
      .filter((row) => pattern.test(row.setting_key))
      .map((row) => parseEnvelope(
        row,
        { ownerId: userId, projectId, kind: "entity" },
        parseEntityValue,
      ))
      .filter((record) => record.envelope.deletedAt === null)
      .map((record) => record.envelope.value)
      .filter((entity) => !query.entityType || entity.entityType === query.entityType)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return { entities, total: entities.length };
  }

  async createEntity(
    userId: string,
    projectId: string,
    input: CreateShortDramaEntityRequest,
  ): Promise<{ entity: ShortDramaEntity; replayed: boolean }> {
    await this.assertReady(true);
    const existing = await this.listEntities(userId, projectId, { entityType: input.entityType });
    const sameKey = existing.entities.find((entity) => entity.entityKey === input.entityKey);
    if (sameKey) {
      const sameInput = canonicalJson({
        entityType: sameKey.entityType,
        entityKey: sameKey.entityKey,
        name: sameKey.name,
        description: sameKey.description,
        attributes: sameKey.attributes,
        referenceAssetUri: sameKey.referenceAssetUri,
      }) === canonicalJson(input);
      if (!sameInput) {
        throw storageError("ENTITY_KEY_CONFLICT", "同一项目中已存在相同类型和标识的实体", 409);
      }
      return { entity: sameKey, replayed: true };
    }
    const now = new Date().toISOString();
    const entity = ShortDramaEntitySchema.parse({
      id: randomUUID(),
      projectId,
      entityType: input.entityType,
      entityKey: input.entityKey,
      name: input.name,
      description: input.description || "",
      attributes: input.attributes,
      referenceAssetUri: input.referenceAssetUri,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope: CompatEnvelope<ShortDramaEntity> = {
      contract: SHORT_DRAMA_COMPAT_CONTRACT,
      kind: "entity",
      ownerId: userId,
      projectId,
      deletedAt: null,
      value: entity,
    };
    await insertVerified(this.db, compatEntityKey(userId, projectId, entity.id), envelope);
    return { entity, replayed: false };
  }

  async getEntity(
    userId: string,
    projectId: string,
    entityId: string,
  ): Promise<ShortDramaEntity | null> {
    await this.assertReady();
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const record = await this.loadEntityRecord(userId, projectId, entityId);
    return record && record.envelope.deletedAt === null ? record.envelope.value : null;
  }

  async updateEntity(
    userId: string,
    projectId: string,
    entityId: string,
    input: UpdateShortDramaEntityRequest,
  ): Promise<ShortDramaEntity> {
    await this.assertReady(true);
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const loaded = await this.loadEntityRecord(userId, projectId, entityId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("ENTITY_NOT_FOUND", "实体不存在", 404);
    }
    const current = loaded.envelope.value;
    if (current.revision !== input.expectedRevision) {
      throw storageError("ENTITY_REVISION_CONFLICT", "实体已被其他请求更新，请刷新后重试", 409);
    }
    if (input.entityKey !== undefined && input.entityKey !== current.entityKey) {
      const sameType = await this.listEntities(userId, projectId, { entityType: current.entityType });
      if (sameType.entities.some((entity) => entity.id !== entityId && entity.entityKey === input.entityKey)) {
        throw storageError("ENTITY_KEY_CONFLICT", "同一项目中已存在相同类型和标识的实体", 409);
      }
    }
    const entity = ShortDramaEntitySchema.parse({
      ...current,
      ...(input.entityKey !== undefined ? { entityKey: input.entityKey } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || "" } : {}),
      ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
      ...(input.referenceAssetUri !== undefined
        ? { referenceAssetUri: input.referenceAssetUri }
        : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<ShortDramaEntity> = { ...loaded.envelope, value: entity };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return entity;
  }

  async deleteEntity(
    userId: string,
    projectId: string,
    entityId: string,
    expectedRevision: number,
  ): Promise<ShortDramaEntity> {
    await this.assertReady(true);
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const loaded = await this.loadEntityRecord(userId, projectId, entityId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("ENTITY_NOT_FOUND", "实体不存在", 404);
    }
    const current = loaded.envelope.value;
    if (current.revision !== expectedRevision) {
      throw storageError("ENTITY_REVISION_CONFLICT", "实体已被其他请求更新，请刷新后重试", 409);
    }
    const entity = ShortDramaEntitySchema.parse({
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<ShortDramaEntity> = {
      ...loaded.envelope,
      deletedAt: new Date().toISOString(),
      value: entity,
    };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return entity;
  }

  async listShots(
    userId: string,
    projectId: string,
    query: ListShortDramaShotsQuery,
  ): Promise<{ shots: ShortDramaShot[]; total: number }> {
    await this.assertReady();
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const shots = await this.loadProjectShots(userId, projectId);
    return {
      shots: shots.slice(query.offset, query.offset + query.limit),
      total: shots.length,
    };
  }

  async createShot(
    userId: string,
    projectId: string,
    input: CreateShortDramaShotRequest,
  ): Promise<{ shot: ShortDramaShot; replayed: boolean }> {
    await this.assertReady(true);
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const existing = await this.loadProjectShots(userId, projectId);
    const sameSequence = existing.find((shot) => shot.sequence === input.sequence);
    if (sameSequence) {
      const sameInput = canonicalJson({
        sequence: sameSequence.sequence,
        sceneKey: sameSequence.sceneKey,
        title: sameSequence.title,
        narration: sameSequence.narration,
        visualDescription: sameSequence.visualDescription,
        imagePrompt: sameSequence.imagePrompt,
        videoPrompt: sameSequence.videoPrompt,
        negativePrompt: sameSequence.negativePrompt,
        durationSeconds: sameSequence.durationSeconds,
        aspectRatio: sameSequence.aspectRatio,
        metadata: sameSequence.metadata,
      }) === canonicalJson(input);
      if (!sameInput) {
        throw storageError("SHOT_SEQUENCE_CONFLICT", "同一项目中已存在相同序号的镜头", 409);
      }
      return { shot: sameSequence, replayed: true };
    }

    const now = new Date().toISOString();
    const shot = ShortDramaShotSchema.parse({
      id: randomUUID(),
      projectId,
      sequence: input.sequence,
      sceneKey: input.sceneKey,
      title: input.title,
      narration: input.narration,
      visualDescription: input.visualDescription,
      imagePrompt: input.imagePrompt,
      videoPrompt: input.videoPrompt,
      negativePrompt: input.negativePrompt,
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
      status: "draft",
      metadata: input.metadata,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const envelope: CompatEnvelope<ShortDramaShot> = {
      contract: SHORT_DRAMA_COMPAT_CONTRACT,
      kind: "shot",
      ownerId: userId,
      projectId,
      deletedAt: null,
      value: shot,
    };
    await insertVerified(this.db, compatShotKey(userId, projectId, shot.id), envelope);
    return { shot, replayed: false };
  }

  async getShot(
    userId: string,
    projectId: string,
    shotId: string,
  ): Promise<ShortDramaShot | null> {
    await this.assertReady();
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const record = await this.loadShotRecord(userId, projectId, shotId);
    return record && record.envelope.deletedAt === null ? record.envelope.value : null;
  }

  private assertShotEditable(shot: ShortDramaShot): void {
    if (shot.status === "generating" || shot.status === "completed") {
      throw storageError(
        "SHOT_LOCKED",
        "正在生成或已有成片的镜头不可直接修改，请保留生产资产链",
        409,
      );
    }
  }

  async updateShot(
    userId: string,
    projectId: string,
    shotId: string,
    input: UpdateShortDramaShotRequest,
  ): Promise<ShortDramaShot> {
    await this.assertReady(true);
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const loaded = await this.loadShotRecord(userId, projectId, shotId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("SHOT_NOT_FOUND", "镜头不存在", 404);
    }
    const current = loaded.envelope.value;
    this.assertShotEditable(current);
    if (current.revision !== input.expectedRevision) {
      throw storageError("SHOT_REVISION_CONFLICT", "镜头已被其他请求更新，请刷新后重试", 409);
    }
    if (input.sequence !== undefined && input.sequence !== current.sequence) {
      const shots = await this.loadProjectShots(userId, projectId);
      if (shots.some((shot) => shot.id !== shotId && shot.sequence === input.sequence)) {
        throw storageError("SHOT_SEQUENCE_CONFLICT", "同一项目中已存在相同序号的镜头", 409);
      }
    }
    const shot = ShortDramaShotSchema.parse({
      ...current,
      ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      ...(input.sceneKey !== undefined ? { sceneKey: input.sceneKey } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.narration !== undefined ? { narration: input.narration } : {}),
      ...(input.visualDescription !== undefined
        ? { visualDescription: input.visualDescription }
        : {}),
      ...(input.imagePrompt !== undefined ? { imagePrompt: input.imagePrompt } : {}),
      ...(input.videoPrompt !== undefined ? { videoPrompt: input.videoPrompt } : {}),
      ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<ShortDramaShot> = { ...loaded.envelope, value: shot };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return shot;
  }

  async deleteShot(
    userId: string,
    projectId: string,
    shotId: string,
    expectedRevision: number,
  ): Promise<ShortDramaShot> {
    await this.assertReady(true);
    if (!await this.getProject(userId, projectId)) {
      throw storageError("PROJECT_NOT_FOUND", "项目不存在", 404);
    }
    const loaded = await this.loadShotRecord(userId, projectId, shotId);
    if (!loaded || loaded.envelope.deletedAt !== null) {
      throw storageError("SHOT_NOT_FOUND", "镜头不存在", 404);
    }
    const current = loaded.envelope.value;
    this.assertShotEditable(current);
    if (current.revision !== expectedRevision) {
      throw storageError("SHOT_REVISION_CONFLICT", "镜头已被其他请求更新，请刷新后重试", 409);
    }
    const shot = ShortDramaShotSchema.parse({
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const envelope: CompatEnvelope<ShortDramaShot> = {
      ...loaded.envelope,
      deletedAt: new Date().toISOString(),
      value: shot,
    };
    await updateVerified(this.db, loaded.key, envelope, loaded.storageRevision);
    return shot;
  }
}
