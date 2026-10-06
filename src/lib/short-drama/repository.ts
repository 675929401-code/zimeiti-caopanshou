import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  ShortDramaEntityDbRowSchema,
  ShortDramaEntitySchema,
  ShortDramaProjectDbRowSchema,
  ShortDramaProjectSchema,
  ShortDramaShotDbRowSchema,
  ShortDramaShotSchema,
  type CreateShortDramaEntityRequest,
  type CreateShortDramaProjectRequest,
  type CreateShortDramaShotRequest,
  type ListShortDramaEntitiesQuery,
  type ListShortDramaProjectsQuery,
  type ListShortDramaShotsQuery,
  type ShortDramaEntity,
  type ShortDramaEntityDbRow,
  type ShortDramaProject,
  type ShortDramaProjectDbRow,
  type ShortDramaShot,
  type ShortDramaShotDbRow,
  type UpdateShortDramaEntityRequest,
  type UpdateShortDramaProjectRequest,
  type UpdateShortDramaShotRequest,
} from "./contracts";
import { canonicalJson } from "./idempotency";
import {
  ShortDramaCompatError,
  ShortDramaCompatRepository,
} from "./compat-repository";
import { probeShortDramaStorageReadiness } from "./readiness";

const PROJECT_SELECT = [
  "id",
  "user_id",
  "client_request_id",
  "request_hash",
  "title",
  "description",
  "project_type",
  "status",
  "source_payload",
  "settings",
  "revision",
  "created_at",
  "updated_at",
  "deleted_at",
].join(", ");

const ENTITY_SELECT = [
  "id",
  "project_id",
  "user_id",
  "entity_type",
  "entity_key",
  "name",
  "description",
  "attributes",
  "reference_asset_uri",
  "revision",
  "created_at",
  "updated_at",
].join(", ");

const SHOT_SELECT = [
  "id",
  "project_id",
  "user_id",
  "sequence",
  "scene_key",
  "title",
  "narration",
  "visual_description",
  "image_prompt",
  "video_prompt",
  "negative_prompt",
  "duration_seconds",
  "aspect_ratio",
  "status",
  "metadata",
  "revision",
  "created_at",
  "updated_at",
].join(", ");

export type ShortDramaRepositoryDatabase = ReturnType<typeof getSupabaseClient>;

export class ShortDramaRepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaRepositoryError";
  }
}

function mapDatabaseError(error: unknown): ShortDramaRepositoryError {
  const databaseError = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  } | null;
  const databaseCode = String(databaseError?.code || "");
  const message = String(databaseError?.message || "");
  const diagnosticText = [
    message,
    String(databaseError?.details || ""),
    String(databaseError?.hint || ""),
  ].join(" ").toLowerCase();

  if (
    databaseCode === "PGRST205"
    || databaseCode === "PGRST204"
    || databaseCode === "PGRST202"
    || databaseCode === "42P01"
    || diagnosticText.includes("short_drama_") && (
      diagnosticText.includes("schema cache")
      || diagnosticText.includes("could not find the table")
      || diagnosticText.includes("could not find the column")
      || diagnosticText.includes("does not exist")
      || diagnosticText.includes("undefined table")
      || diagnosticText.includes("undefined column")
    )
    || diagnosticText.includes("short_drama_") && (
      diagnosticText.includes("could not find the function")
      || diagnosticText.includes("function") && diagnosticText.includes("schema cache")
    )
  ) {
    return new ShortDramaRepositoryError(
      503,
      "MIGRATION_NOT_READY",
      "影视工坊项目服务正在准备中，请稍后重试",
    );
  }
  if (
    databaseCode === "23505"
    && diagnosticText.includes("short_drama_entities_project_key_once")
  ) {
    return new ShortDramaRepositoryError(
      409,
      "ENTITY_KEY_CONFLICT",
      "同一项目中已存在相同类型和标识的实体",
    );
  }
  if (
    databaseCode === "23505"
    && diagnosticText.includes("short_drama_shots_project_sequence_once")
  ) {
    return new ShortDramaRepositoryError(
      409,
      "SHOT_SEQUENCE_CONFLICT",
      "同一项目中已存在相同序号的镜头",
    );
  }
  if (
    databaseCode === "23514"
    && diagnosticText.includes("short_drama_entities")
  ) {
    return new ShortDramaRepositoryError(400, "ENTITY_INPUT_INVALID", "实体数据不符合要求");
  }
  if (
    databaseCode === "23514"
    && diagnosticText.includes("short_drama_shots")
  ) {
    return new ShortDramaRepositoryError(400, "SHOT_INPUT_INVALID", "镜头数据不符合要求");
  }
  if (message.includes("SHORT_DRAMA_PROJECT_NOT_FOUND")) {
    return new ShortDramaRepositoryError(404, "PROJECT_NOT_FOUND", "项目不存在");
  }
  if (message.includes("SHORT_DRAMA_REVISION_CONFLICT")) {
    return new ShortDramaRepositoryError(409, "REVISION_CONFLICT", "项目已被其他请求更新，请刷新后重试");
  }
  if (message.includes("SHORT_DRAMA_IDEMPOTENCY_CONFLICT")) {
    return new ShortDramaRepositoryError(409, "IDEMPOTENCY_CONFLICT", "相同请求标识已用于不同内容");
  }
  if (
    message.includes("SHORT_DRAMA_PROJECT_INVALID") ||
    message.includes("SHORT_DRAMA_PROJECT_PATCH_INVALID")
  ) {
    return new ShortDramaRepositoryError(400, "PROJECT_INPUT_INVALID", "项目数据不符合要求");
  }
  return new ShortDramaRepositoryError(503, "PROJECT_DATABASE_UNAVAILABLE", "影视工坊项目服务暂时不可用");
}

function parseProjectRow(value: unknown): ShortDramaProjectDbRow {
  const parsed = ShortDramaProjectDbRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new ShortDramaRepositoryError(503, "PROJECT_DATA_INVALID", "项目数据暂时不可用");
  }
  return parsed.data;
}

function toPublicProject(value: unknown): ShortDramaProject {
  const row = parseProjectRow(value);
  return ShortDramaProjectSchema.parse({
    id: row.id,
    title: row.title,
    description: row.description || "",
    projectType: row.project_type,
    status: row.status,
    sourcePayload: row.source_payload,
    settings: row.settings,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseEntityRow(value: unknown): ShortDramaEntityDbRow {
  const parsed = ShortDramaEntityDbRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new ShortDramaRepositoryError(503, "ENTITY_DATA_INVALID", "实体数据暂时不可用");
  }
  return parsed.data;
}

function toPublicEntity(value: unknown): ShortDramaEntity {
  const row = parseEntityRow(value);
  return ShortDramaEntitySchema.parse({
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    name: row.name,
    description: row.description || "",
    attributes: row.attributes,
    referenceAssetUri: row.reference_asset_uri,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function parseShotRow(value: unknown): ShortDramaShotDbRow {
  const parsed = ShortDramaShotDbRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new ShortDramaRepositoryError(503, "SHOT_DATA_INVALID", "镜头数据暂时不可用");
  }
  return parsed.data;
}

function toPublicShot(value: unknown): ShortDramaShot {
  const row = parseShotRow(value);
  return ShortDramaShotSchema.parse({
    id: row.id,
    projectId: row.project_id,
    sequence: row.sequence,
    sceneKey: row.scene_key,
    title: row.title || "",
    narration: row.narration || "",
    visualDescription: row.visual_description || "",
    imagePrompt: row.image_prompt || "",
    videoPrompt: row.video_prompt || "",
    negativePrompt: row.negative_prompt || "",
    durationSeconds: row.duration_seconds,
    aspectRatio: row.aspect_ratio,
    status: row.status,
    metadata: row.metadata,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function sameEntityInput(
  entity: ShortDramaEntity,
  input: CreateShortDramaEntityRequest,
): boolean {
  return canonicalJson({
    entityType: entity.entityType,
    entityKey: entity.entityKey,
    name: entity.name,
    description: entity.description,
    attributes: entity.attributes,
    referenceAssetUri: entity.referenceAssetUri,
  }) === canonicalJson({
    entityType: input.entityType,
    entityKey: input.entityKey,
    name: input.name,
    description: input.description || "",
    attributes: input.attributes,
    referenceAssetUri: input.referenceAssetUri,
  });
}

function sameShotInput(
  shot: ShortDramaShot,
  input: CreateShortDramaShotRequest,
): boolean {
  return canonicalJson({
    sequence: shot.sequence,
    sceneKey: shot.sceneKey,
    title: shot.title,
    narration: shot.narration,
    visualDescription: shot.visualDescription,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    negativePrompt: shot.negativePrompt,
    durationSeconds: shot.durationSeconds,
    aspectRatio: shot.aspectRatio,
    metadata: shot.metadata,
  }) === canonicalJson(input);
}

function parseRpcEnvelope(value: unknown): { project: ShortDramaProject; replayed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShortDramaRepositoryError(503, "PROJECT_DATA_INVALID", "项目数据暂时不可用");
  }
  const record = value as Record<string, unknown>;
  return {
    project: toPublicProject(record.project),
    replayed: record.replayed === true,
  };
}

export class ShortDramaProjectRepository {
  private readonly compat: ShortDramaCompatRepository;
  private storageModePromise: Promise<"native" | "compat"> | null = null;

  constructor(private readonly db: ShortDramaRepositoryDatabase = getSupabaseClient()) {
    this.compat = new ShortDramaCompatRepository(db);
  }

  private async storageMode(): Promise<"native" | "compat"> {
    if (!this.storageModePromise) {
      this.storageModePromise = probeShortDramaStorageReadiness(this.db).then((readiness) => {
        if (readiness.ok) return readiness.storageMode;
        throw new ShortDramaRepositoryError(503, readiness.code, readiness.error);
      });
    }
    return this.storageModePromise;
  }

  async getStorageMode(): Promise<"native" | "compat"> {
    return this.storageMode();
  }

  private async compatCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ShortDramaCompatError) {
        throw new ShortDramaRepositoryError(error.status, error.code, error.message);
      }
      throw error;
    }
  }

  async listProjects(
    userId: string,
    query: ListShortDramaProjectsQuery,
  ): Promise<{ projects: ShortDramaProject[]; total: number }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.listProjects(userId, query));
    }
    let request = this.db
      .from("short_drama_projects")
      .select(PROJECT_SELECT, { count: "exact" })
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.status) request = request.eq("status", query.status);

    const { data, error, count } = await request;
    if (error) throw mapDatabaseError(error);

    return {
      projects: (data || []).map(toPublicProject),
      total: Number(count || 0),
    };
  }

  async getProject(userId: string, projectId: string): Promise<ShortDramaProject | null> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.getProject(userId, projectId));
    }
    const { data, error } = await this.db
      .from("short_drama_projects")
      .select(PROJECT_SELECT)
      .eq("id", projectId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    return data ? toPublicProject(data) : null;
  }

  async createProject(
    userId: string,
    input: CreateShortDramaProjectRequest,
    requestHash: string,
  ): Promise<{ project: ShortDramaProject; replayed: boolean }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.createProject(userId, input, requestHash));
    }
    const { data, error } = await this.db.rpc("short_drama_create_project", {
      p_user_id: userId,
      p_client_request_id: input.clientRequestId,
      p_request_hash: requestHash,
      p_title: input.title,
      p_description: input.description || null,
      p_project_type: input.projectType,
      p_source_payload: input.sourcePayload,
      p_settings: input.settings,
    });

    if (error) throw mapDatabaseError(error);
    return parseRpcEnvelope(data);
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: UpdateShortDramaProjectRequest,
  ): Promise<ShortDramaProject> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.updateProject(userId, projectId, input));
    }
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.projectType !== undefined) patch.projectType = input.projectType;
    if (input.status !== undefined) patch.status = input.status;
    if (input.sourcePayload !== undefined) patch.sourcePayload = input.sourcePayload;
    if (input.settings !== undefined) patch.settings = input.settings;

    const { data, error } = await this.db.rpc("short_drama_update_project", {
      p_user_id: userId,
      p_project_id: projectId,
      p_expected_revision: input.expectedRevision,
      p_patch: patch,
    });

    if (error) throw mapDatabaseError(error);
    return parseRpcEnvelope(data).project;
  }

  async deleteProject(
    userId: string,
    projectId: string,
    expectedRevision?: number,
  ): Promise<ShortDramaProject> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.deleteProject(
        userId,
        projectId,
        expectedRevision,
      ));
    }
    const { data, error } = await this.db.rpc("short_drama_delete_project", {
      p_user_id: userId,
      p_project_id: projectId,
      p_expected_revision: expectedRevision ?? null,
    });

    if (error) throw mapDatabaseError(error);
    return parseRpcEnvelope(data).project;
  }

  private async requireOwnedProject(userId: string, projectId: string): Promise<void> {
    const project = await this.getProject(userId, projectId);
    if (!project) {
      throw new ShortDramaRepositoryError(404, "PROJECT_NOT_FOUND", "项目不存在");
    }
  }

  private async getEntityByKey(
    userId: string,
    projectId: string,
    entityType: CreateShortDramaEntityRequest["entityType"],
    entityKey: string,
  ): Promise<ShortDramaEntity | null> {
    const { data, error } = await this.db
      .from("short_drama_entities")
      .select(ENTITY_SELECT)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("entity_type", entityType)
      .eq("entity_key", entityKey)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    return data ? toPublicEntity(data) : null;
  }

  async listEntities(
    userId: string,
    projectId: string,
    query: ListShortDramaEntitiesQuery,
  ): Promise<{ entities: ShortDramaEntity[]; total: number }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.listEntities(userId, projectId, query));
    }
    await this.requireOwnedProject(userId, projectId);
    let request = this.db
      .from("short_drama_entities")
      .select(ENTITY_SELECT, { count: "exact" })
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .order("entity_type", { ascending: true })
      .order("name", { ascending: true });

    if (query.entityType) request = request.eq("entity_type", query.entityType);

    const { data, error, count } = await request;
    if (error) throw mapDatabaseError(error);
    return {
      entities: (data || []).map(toPublicEntity),
      total: Number(count || 0),
    };
  }

  async createEntity(
    userId: string,
    projectId: string,
    input: CreateShortDramaEntityRequest,
  ): Promise<{ entity: ShortDramaEntity; replayed: boolean }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.createEntity(userId, projectId, input));
    }
    await this.requireOwnedProject(userId, projectId);
    const { data, error } = await this.db
      .from("short_drama_entities")
      .insert({
        project_id: projectId,
        user_id: userId,
        entity_type: input.entityType,
        entity_key: input.entityKey,
        name: input.name,
        description: input.description || null,
        attributes: input.attributes,
        reference_asset_uri: input.referenceAssetUri,
      })
      .select(ENTITY_SELECT)
      .single();

    if (error) {
      if (String((error as { code?: unknown }).code || "") === "23505") {
        const existing = await this.getEntityByKey(
          userId,
          projectId,
          input.entityType,
          input.entityKey,
        );
        if (existing && sameEntityInput(existing, input)) {
          return { entity: existing, replayed: true };
        }
      }
      throw mapDatabaseError(error);
    }
    return { entity: toPublicEntity(data), replayed: false };
  }

  async getEntity(
    userId: string,
    projectId: string,
    entityId: string,
  ): Promise<ShortDramaEntity | null> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.getEntity(userId, projectId, entityId));
    }
    const { data, error } = await this.db
      .from("short_drama_entities")
      .select(ENTITY_SELECT)
      .eq("id", entityId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    return data ? toPublicEntity(data) : null;
  }

  async updateEntity(
    userId: string,
    projectId: string,
    entityId: string,
    input: UpdateShortDramaEntityRequest,
  ): Promise<ShortDramaEntity> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.updateEntity(
        userId,
        projectId,
        entityId,
        input,
      ));
    }
    await this.requireOwnedProject(userId, projectId);
    const patch: Record<string, unknown> = { revision: input.expectedRevision + 1 };
    if (input.entityKey !== undefined) patch.entity_key = input.entityKey;
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description || null;
    if (input.attributes !== undefined) patch.attributes = input.attributes;
    if (input.referenceAssetUri !== undefined) {
      patch.reference_asset_uri = input.referenceAssetUri;
    }

    const { data, error } = await this.db
      .from("short_drama_entities")
      .update(patch)
      .eq("id", entityId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("revision", input.expectedRevision)
      .select(ENTITY_SELECT)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    if (data) return toPublicEntity(data);

    const current = await this.getEntity(userId, projectId, entityId);
    if (!current) {
      throw new ShortDramaRepositoryError(404, "ENTITY_NOT_FOUND", "实体不存在");
    }
    throw new ShortDramaRepositoryError(
      409,
      "ENTITY_REVISION_CONFLICT",
      "实体已被其他请求更新，请刷新后重试",
    );
  }

  async deleteEntity(
    userId: string,
    projectId: string,
    entityId: string,
    expectedRevision: number,
  ): Promise<ShortDramaEntity> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.deleteEntity(
        userId,
        projectId,
        entityId,
        expectedRevision,
      ));
    }
    await this.requireOwnedProject(userId, projectId);
    const { data, error } = await this.db
      .from("short_drama_entities")
      .delete()
      .eq("id", entityId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("revision", expectedRevision)
      .select(ENTITY_SELECT)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    if (data) return toPublicEntity(data);

    const current = await this.getEntity(userId, projectId, entityId);
    if (!current) {
      throw new ShortDramaRepositoryError(404, "ENTITY_NOT_FOUND", "实体不存在");
    }
    throw new ShortDramaRepositoryError(
      409,
      "ENTITY_REVISION_CONFLICT",
      "实体已被其他请求更新，请刷新后重试",
    );
  }

  private async getShotBySequence(
    userId: string,
    projectId: string,
    sequence: number,
  ): Promise<ShortDramaShot | null> {
    const { data, error } = await this.db
      .from("short_drama_shots")
      .select(SHOT_SELECT)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("sequence", sequence)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    return data ? toPublicShot(data) : null;
  }

  async listShots(
    userId: string,
    projectId: string,
    query: ListShortDramaShotsQuery,
  ): Promise<{ shots: ShortDramaShot[]; total: number }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.listShots(userId, projectId, query));
    }
    await this.requireOwnedProject(userId, projectId);
    const { data, error, count } = await this.db
      .from("short_drama_shots")
      .select(SHOT_SELECT, { count: "exact" })
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .order("sequence", { ascending: true })
      .range(query.offset, query.offset + query.limit - 1);

    if (error) throw mapDatabaseError(error);
    return {
      shots: (data || []).map(toPublicShot),
      total: Number(count || 0),
    };
  }

  async createShot(
    userId: string,
    projectId: string,
    input: CreateShortDramaShotRequest,
  ): Promise<{ shot: ShortDramaShot; replayed: boolean }> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.createShot(userId, projectId, input));
    }
    await this.requireOwnedProject(userId, projectId);
    const { data, error } = await this.db
      .from("short_drama_shots")
      .insert({
        project_id: projectId,
        user_id: userId,
        sequence: input.sequence,
        scene_key: input.sceneKey,
        title: input.title,
        narration: input.narration || null,
        visual_description: input.visualDescription || null,
        image_prompt: input.imagePrompt || null,
        video_prompt: input.videoPrompt || null,
        negative_prompt: input.negativePrompt || null,
        duration_seconds: input.durationSeconds,
        aspect_ratio: input.aspectRatio,
        status: "draft",
        metadata: input.metadata,
      })
      .select(SHOT_SELECT)
      .single();

    if (error) {
      if (String((error as { code?: unknown }).code || "") === "23505") {
        const existing = await this.getShotBySequence(userId, projectId, input.sequence);
        if (existing && sameShotInput(existing, input)) {
          return { shot: existing, replayed: true };
        }
      }
      throw mapDatabaseError(error);
    }
    return { shot: toPublicShot(data), replayed: false };
  }

  async getShot(
    userId: string,
    projectId: string,
    shotId: string,
  ): Promise<ShortDramaShot | null> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.getShot(userId, projectId, shotId));
    }
    const { data, error } = await this.db
      .from("short_drama_shots")
      .select(SHOT_SELECT)
      .eq("id", shotId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    return data ? toPublicShot(data) : null;
  }

  private assertShotEditable(shot: ShortDramaShot): void {
    if (shot.status === "generating" || shot.status === "completed") {
      throw new ShortDramaRepositoryError(
        409,
        "SHOT_LOCKED",
        "正在生成或已有成片的镜头不可直接修改，请保留生产资产链",
      );
    }
  }

  private async assertNoActiveShotJob(
    userId: string,
    projectId: string,
    shotId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from("short_drama_jobs")
      .select("id")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("shot_id", shotId)
      .in("state", [
        "accepted",
        "queued",
        "running",
        "result_staging",
        "persisting",
        "finalizing",
        "retry_wait",
      ])
      .limit(1);
    if (error) throw mapDatabaseError(error);
    if ((data || []).length > 0) {
      throw new ShortDramaRepositoryError(
        409,
        "SHOT_HAS_ACTIVE_JOB",
        "镜头存在进行中的生产任务，不能修改镜头内容",
      );
    }
  }

  private async assertNoShotProductionHistory(
    userId: string,
    projectId: string,
    shotId: string,
  ): Promise<void> {
    const [jobs, assets] = await Promise.all([
      this.db
        .from("short_drama_jobs")
        .select("id")
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .eq("shot_id", shotId)
        .limit(1),
      this.db
        .from("short_drama_assets")
        .select("id")
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .eq("shot_id", shotId)
        .limit(1),
    ]);
    if (jobs.error) throw mapDatabaseError(jobs.error);
    if (assets.error) throw mapDatabaseError(assets.error);
    if ((jobs.data || []).length > 0 || (assets.data || []).length > 0) {
      throw new ShortDramaRepositoryError(
        409,
        "SHOT_HAS_PRODUCTION_HISTORY",
        "镜头已有任务或资产记录，为保护生产审计链不能删除",
      );
    }
  }

  async updateShot(
    userId: string,
    projectId: string,
    shotId: string,
    input: UpdateShortDramaShotRequest,
  ): Promise<ShortDramaShot> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.updateShot(userId, projectId, shotId, input));
    }
    await this.requireOwnedProject(userId, projectId);
    const current = await this.getShot(userId, projectId, shotId);
    if (!current) throw new ShortDramaRepositoryError(404, "SHOT_NOT_FOUND", "镜头不存在");
    this.assertShotEditable(current);
    if (current.revision !== input.expectedRevision) {
      throw new ShortDramaRepositoryError(409, "SHOT_REVISION_CONFLICT", "镜头已被其他请求更新，请刷新后重试");
    }
    await this.assertNoActiveShotJob(userId, projectId, shotId);

    const patch: Record<string, unknown> = { revision: input.expectedRevision + 1 };
    if (input.sequence !== undefined) patch.sequence = input.sequence;
    if (input.sceneKey !== undefined) patch.scene_key = input.sceneKey;
    if (input.title !== undefined) patch.title = input.title;
    if (input.narration !== undefined) patch.narration = input.narration || null;
    if (input.visualDescription !== undefined) {
      patch.visual_description = input.visualDescription || null;
    }
    if (input.imagePrompt !== undefined) patch.image_prompt = input.imagePrompt || null;
    if (input.videoPrompt !== undefined) patch.video_prompt = input.videoPrompt || null;
    if (input.negativePrompt !== undefined) patch.negative_prompt = input.negativePrompt || null;
    if (input.durationSeconds !== undefined) patch.duration_seconds = input.durationSeconds;
    if (input.aspectRatio !== undefined) patch.aspect_ratio = input.aspectRatio;
    if (input.metadata !== undefined) patch.metadata = input.metadata;

    const { data, error } = await this.db
      .from("short_drama_shots")
      .update(patch)
      .eq("id", shotId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("revision", input.expectedRevision)
      .select(SHOT_SELECT)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    if (data) return toPublicShot(data);
    const latest = await this.getShot(userId, projectId, shotId);
    if (!latest) throw new ShortDramaRepositoryError(404, "SHOT_NOT_FOUND", "镜头不存在");
    throw new ShortDramaRepositoryError(
      409,
      "SHOT_REVISION_CONFLICT",
      "镜头已被其他请求更新，请刷新后重试",
    );
  }

  async deleteShot(
    userId: string,
    projectId: string,
    shotId: string,
    expectedRevision: number,
  ): Promise<ShortDramaShot> {
    if (await this.storageMode() === "compat") {
      return this.compatCall(() => this.compat.deleteShot(
        userId,
        projectId,
        shotId,
        expectedRevision,
      ));
    }
    await this.requireOwnedProject(userId, projectId);
    const current = await this.getShot(userId, projectId, shotId);
    if (!current) throw new ShortDramaRepositoryError(404, "SHOT_NOT_FOUND", "镜头不存在");
    this.assertShotEditable(current);
    if (current.revision !== expectedRevision) {
      throw new ShortDramaRepositoryError(
        409,
        "SHOT_REVISION_CONFLICT",
        "镜头已被其他请求更新，请刷新后重试",
      );
    }
    await this.assertNoShotProductionHistory(userId, projectId, shotId);
    const { data, error } = await this.db
      .from("short_drama_shots")
      .delete()
      .eq("id", shotId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .eq("revision", expectedRevision)
      .select(SHOT_SELECT)
      .maybeSingle();

    if (error) throw mapDatabaseError(error);
    if (data) return toPublicShot(data);
    const latest = await this.getShot(userId, projectId, shotId);
    if (!latest) throw new ShortDramaRepositoryError(404, "SHOT_NOT_FOUND", "镜头不存在");
    throw new ShortDramaRepositoryError(
      409,
      "SHOT_REVISION_CONFLICT",
      "镜头已被其他请求更新，请刷新后重试",
    );
  }
}
