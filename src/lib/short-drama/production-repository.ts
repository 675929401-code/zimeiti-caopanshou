import { createHash } from "node:crypto";
import type {
  ShortDramaAuthorizationContext,
  ShortDramaDatabase,
} from "./permissions";
import { ShortDramaHttpError } from "./http";
import type {
  JsonValue,
  ShortDramaJobStage,
  ShortDramaJobState,
} from "./contracts";
import type { ProductionPlanSegment } from "./production-contracts";

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

const JOB_SELECT = [
  "id",
  "public_job_id",
  "project_id",
  "user_id",
  "shot_id",
  "prompt_snapshot_id",
  "client_request_id",
  "input_hash",
  "stage",
  "state",
  "provider",
  "upstream_task_id",
  "model_public_id",
  "request_payload",
  "result_payload",
  "billing_snapshot",
  "attempt_count",
  "max_attempts",
  "progress",
  "error_code",
  "error_message",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
].join(", ");

const ASSET_SELECT = [
  "id",
  "project_id",
  "user_id",
  "shot_id",
  "job_id",
  "asset_role",
  "provider",
  "object_key",
  "stable_uri",
  "mime_type",
  "byte_size",
  "checksum_sha256",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const VIDEO_TASK_SELECT = [
  "id",
  "user_id",
  "model_id",
  "status",
  "task_id_external",
  "video_url",
  "storage_url",
  "price_charged",
  "resolution",
  "duration_seconds",
  "completed_at",
].join(", ");

export class ShortDramaProductionError extends ShortDramaHttpError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly details?: Record<string, JsonValue>,
  ) {
    super(status, code, message);
    this.name = "ShortDramaProductionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  return isRecord(value) ? value as Record<string, JsonValue> : {};
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function databaseErrorDetails(error: unknown): {
  code: string;
  message: string;
  diagnostic: string;
} {
  const value = isRecord(error) ? error : {};
  const code = String(value.code || "");
  const message = String(value.message || "");
  const diagnostic = [message, value.details, value.hint]
    .map((entry) => String(entry || ""))
    .join(" ")
    .toLowerCase();
  return { code, message, diagnostic };
}

function migrationIsMissing(error: unknown): boolean {
  const { code, diagnostic } = databaseErrorDetails(error);
  return code === "PGRST205"
    || code === "PGRST204"
    || code === "42P01"
    || diagnostic.includes("short_drama_") && (
      diagnostic.includes("schema cache")
      || diagnostic.includes("could not find the table")
      || diagnostic.includes("does not exist")
      || diagnostic.includes("undefined table")
      || diagnostic.includes("undefined column")
    );
}

function uniqueViolation(error: unknown): boolean {
  return databaseErrorDetails(error).code === "23505";
}

function throwDatabaseError(error: unknown): never {
  if (migrationIsMissing(error)) {
    throw new ShortDramaProductionError(
      503,
      "MIGRATION_NOT_READY",
      "影视工坊生产服务正在准备中，请稍后重试",
    );
  }
  throw new ShortDramaProductionError(
    503,
    "PRODUCTION_DATABASE_UNAVAILABLE",
    "影视工坊生产数据服务暂时不可用",
  );
}

function requireRow(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShortDramaProductionError(503, code, message);
  return value;
}

export interface ProductionShot {
  id: string;
  sequence: number;
  sceneKey: string | null;
  title: string;
  narration: string;
  visualDescription: string;
  imagePrompt: string;
  videoPrompt: string;
  negativePrompt: string;
  durationSeconds: number;
  aspectRatio: string;
  status: string;
  metadata: Record<string, JsonValue>;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionJob {
  id: string;
  publicJobId: string;
  shotId: string | null;
  promptSnapshotId: string | null;
  clientRequestId: string;
  inputHash: string;
  stage: ShortDramaJobStage;
  state: ShortDramaJobState;
  provider: string | null;
  upstreamTaskId: string | null;
  modelPublicId: string | null;
  requestPayload: Record<string, JsonValue>;
  resultPayload: Record<string, JsonValue>;
  billingSnapshot: Record<string, JsonValue>;
  attemptCount: number;
  maxAttempts: number;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ProductionAsset {
  id: string;
  shotId: string | null;
  jobId: string | null;
  assetRole: string;
  provider: string;
  objectKey: string;
  stableUri: string;
  previewUrl: string;
  mimeType: string | null;
  byteSize: number | null;
  checksumSha256: string | null;
  metadata: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}

export interface OwnedVideoTask {
  id: string;
  modelId: string;
  status: string;
  externalTaskId: string;
  videoUrl: string;
  storageUrl: string;
  priceCharged: number;
  resolution: string | null;
  durationSeconds: number;
  completedAt: string | null;
}

function mapShot(value: unknown): ProductionShot {
  const row = requireRow(value, "PRODUCTION_SHOT_DATA_INVALID", "镜头数据暂时不可用");
  return {
    id: String(row.id || ""),
    sequence: Number(row.sequence) || 0,
    sceneKey: nullableString(row.scene_key),
    title: String(row.title || ""),
    narration: String(row.narration || ""),
    visualDescription: String(row.visual_description || ""),
    imagePrompt: String(row.image_prompt || ""),
    videoPrompt: String(row.video_prompt || ""),
    negativePrompt: String(row.negative_prompt || ""),
    durationSeconds: Number(row.duration_seconds) || 0,
    aspectRatio: String(row.aspect_ratio || "9:16"),
    status: String(row.status || "draft"),
    metadata: jsonObject(row.metadata),
    revision: Number(row.revision) || 1,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function mapJob(value: unknown): ProductionJob {
  const row = requireRow(value, "PRODUCTION_JOB_DATA_INVALID", "生产任务数据暂时不可用");
  return {
    id: String(row.id || ""),
    publicJobId: String(row.public_job_id || ""),
    shotId: nullableString(row.shot_id),
    promptSnapshotId: nullableString(row.prompt_snapshot_id),
    clientRequestId: String(row.client_request_id || ""),
    inputHash: String(row.input_hash || ""),
    stage: String(row.stage || "shot_planning") as ShortDramaJobStage,
    state: String(row.state || "accepted") as ShortDramaJobState,
    provider: nullableString(row.provider),
    upstreamTaskId: nullableString(row.upstream_task_id),
    modelPublicId: nullableString(row.model_public_id),
    requestPayload: jsonObject(row.request_payload),
    resultPayload: jsonObject(row.result_payload),
    billingSnapshot: jsonObject(row.billing_snapshot),
    attemptCount: Number(row.attempt_count) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    progress: Number(row.progress) || 0,
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
  };
}

function mapAsset(value: unknown): ProductionAsset {
  const row = requireRow(value, "PRODUCTION_ASSET_DATA_INVALID", "生产资产数据暂时不可用");
  const metadata = jsonObject(row.metadata);
  return {
    id: String(row.id || ""),
    shotId: nullableString(row.shot_id),
    jobId: nullableString(row.job_id),
    assetRole: String(row.asset_role || ""),
    provider: String(row.provider || ""),
    objectKey: String(row.object_key || ""),
    stableUri: String(row.stable_uri || ""),
    previewUrl: typeof metadata.previewUrl === "string" ? metadata.previewUrl : "",
    mimeType: nullableString(row.mime_type),
    byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
    checksumSha256: nullableString(row.checksum_sha256),
    metadata,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function mapVideoTask(value: unknown): OwnedVideoTask {
  const row = requireRow(value, "VIDEO_TASK_DATA_INVALID", "视频任务数据暂时不可用");
  return {
    id: String(row.id || ""),
    modelId: String(row.model_id || ""),
    status: String(row.status || ""),
    externalTaskId: String(row.task_id_external || ""),
    videoUrl: String(row.video_url || ""),
    storageUrl: String(row.storage_url || ""),
    priceCharged: Math.max(0, Number(row.price_charged) || 0),
    resolution: nullableString(row.resolution),
    durationSeconds: Number(row.duration_seconds) || 0,
    completedAt: nullableString(row.completed_at),
  };
}

function publicJobId(userId: string, clientRequestId: string): string {
  const digest = createHash("sha256")
    .update(`${userId}:${clientRequestId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `sdj_${digest}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export interface CreateProductionJobInput {
  projectId: string;
  shotId?: string | null;
  promptSnapshotId?: string | null;
  clientRequestId: string;
  inputHash: string;
  stage: ShortDramaJobStage;
  modelPublicId?: string | null;
  requestPayload: Record<string, JsonValue>;
  billingSnapshot?: Record<string, JsonValue>;
}

export interface ProductionJobPatch {
  state?: ShortDramaJobState;
  provider?: string | null;
  upstreamTaskId?: string | null;
  resultPayload?: Record<string, JsonValue>;
  billingSnapshot?: Record<string, JsonValue>;
  attemptCount?: number;
  progress?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export class ShortDramaProductionRepository {
  constructor(private readonly db: ShortDramaDatabase) {}

  static fromAuth(auth: ShortDramaAuthorizationContext): ShortDramaProductionRepository {
    return new ShortDramaProductionRepository(auth.db);
  }

  async assertProductionMigrationReady(userId: string, projectId: string): Promise<void> {
    // A partially deployed migration is more dangerous than a completely
    // missing one: a media request could otherwise be charged before the
    // settlement or durable-asset table failure becomes visible. Validate all
    // tables/columns required by the paid path with read-only, owner-scoped
    // queries before any image/video route is invoked.
    const checks = await Promise.all([
      this.db
        .from("short_drama_shots")
        .select(SHOT_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .limit(1),
      this.db
        .from("short_drama_prompt_snapshots")
        .select("id, project_id, user_id, stage, prompt_hash, model_public_id")
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .limit(1),
      this.db
        .from("short_drama_jobs")
        .select(JOB_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .limit(1),
      this.db
        .from("short_drama_assets")
        .select(ASSET_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .limit(1),
      this.db
        .from("short_drama_settlements")
        .select("job_id, project_id, user_id, public_job_id, billing_mode, cash_charged, credits_charged")
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .limit(1),
    ]);
    for (const check of checks) {
      if (check.error) throwDatabaseError(check.error);
    }
  }

  async listProduction(userId: string, projectId: string): Promise<{
    shots: ProductionShot[];
    jobs: ProductionJob[];
    assets: ProductionAsset[];
  }> {
    const [shotsResult, jobsResult, assetsResult] = await Promise.all([
      this.db
        .from("short_drama_shots")
        .select(SHOT_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .order("sequence", { ascending: true }),
      this.db
        .from("short_drama_jobs")
        .select(JOB_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
      this.db
        .from("short_drama_assets")
        .select(ASSET_SELECT)
        .eq("user_id", userId)
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
    ]);
    if (shotsResult.error) throwDatabaseError(shotsResult.error);
    if (jobsResult.error) throwDatabaseError(jobsResult.error);
    if (assetsResult.error) throwDatabaseError(assetsResult.error);
    return {
      shots: (shotsResult.data || []).map(mapShot),
      jobs: (jobsResult.data || []).map(mapJob),
      assets: (assetsResult.data || []).map(mapAsset),
    };
  }

  async assertNoActiveProjectJobs(userId: string, projectId: string): Promise<void> {
    const result = await this.db
      .from("short_drama_jobs")
      .select("id")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .in("state", ["accepted", "queued", "running", "result_staging", "persisting", "finalizing", "retry_wait"])
      .limit(1);
    if (result.error) throwDatabaseError(result.error);
    if ((result.data || []).length > 0) {
      throw new ShortDramaProductionError(
        409,
        "PROJECT_HAS_ACTIVE_JOB",
        "项目仍有进行中的生产任务，请等待任务进入终态后再删除",
      );
    }
  }

  async listShots(userId: string, projectId: string): Promise<ProductionShot[]> {
    const { data, error } = await this.db
      .from("short_drama_shots")
      .select(SHOT_SELECT)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .order("sequence", { ascending: true });
    if (error) throwDatabaseError(error);
    return (data || []).map(mapShot);
  }

  async createPlanShots(
    userId: string,
    projectId: string,
    segments: ProductionPlanSegment[],
  ): Promise<{ shots: ProductionShot[]; replayed: boolean }> {
    const existing = await this.listShots(userId, projectId);
    if (existing.length > 0) return { shots: existing, replayed: true };

    const rows = segments.map((segment, index) => ({
      project_id: projectId,
      user_id: userId,
      sequence: index + 1,
      scene_key: segment.segmentId,
      title: segment.title,
      narration: segment.narration || null,
      visual_description: segment.visualDescription || null,
      image_prompt: segment.imagePrompt,
      video_prompt: segment.videoPrompt,
      negative_prompt: segment.negativePrompt || null,
      duration_seconds: segment.durationSeconds,
      aspect_ratio: segment.aspectRatio,
      status: "ready",
      metadata: segment.metadata,
    }));
    const { error } = await this.db.from("short_drama_shots").insert(rows);
    if (error && !uniqueViolation(error)) throwDatabaseError(error);
    return {
      shots: await this.listShots(userId, projectId),
      replayed: Boolean(error),
    };
  }

  async getShot(userId: string, projectId: string, shotId: string): Promise<ProductionShot> {
    const { data, error } = await this.db
      .from("short_drama_shots")
      .select(SHOT_SELECT)
      .eq("id", shotId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) {
      throw new ShortDramaProductionError(404, "SHOT_NOT_FOUND", "镜头不存在或不属于当前项目");
    }
    return mapShot(data);
  }

  async updateShotMetadata(
    userId: string,
    projectId: string,
    shotId: string,
    expectedRevision: number,
    metadata: Record<string, JsonValue>,
  ): Promise<ProductionShot> {
    const { data, error } = await this.db
      .from("short_drama_shots")
      .update({ metadata, revision: expectedRevision + 1 })
      .eq("id", shotId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("revision", expectedRevision)
      .select(SHOT_SELECT)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    if (data) return mapShot(data);
    const current = await this.getShot(userId, projectId, shotId);
    throw new ShortDramaProductionError(
      409,
      "SHOT_REVISION_CONFLICT",
      "镜头已被其他操作更新，请刷新后重试",
      { expectedRevision, currentRevision: current.revision },
    );
  }

  async updateShotStatus(
    userId: string,
    projectId: string,
    shotId: string,
    status: "ready" | "generating" | "completed" | "failed" | "cancelled",
  ): Promise<void> {
    const { error } = await this.db
      .from("short_drama_shots")
      .update({ status })
      .eq("id", shotId)
      .eq("user_id", userId)
      .eq("project_id", projectId);
    if (error) throwDatabaseError(error);
  }

  async getJobByClientRequestId(userId: string, clientRequestId: string): Promise<ProductionJob | null> {
    const { data, error } = await this.db
      .from("short_drama_jobs")
      .select(JOB_SELECT)
      .eq("user_id", userId)
      .eq("client_request_id", clientRequestId)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    return data ? mapJob(data) : null;
  }

  async getJob(userId: string, projectId: string, lookupId: string): Promise<ProductionJob> {
    let query = this.db
      .from("short_drama_jobs")
      .select(JOB_SELECT)
      .eq("user_id", userId)
      .eq("project_id", projectId);
    query = isUuid(lookupId) ? query.eq("id", lookupId) : query.eq("public_job_id", lookupId);
    const { data, error } = await query.maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) {
      throw new ShortDramaProductionError(404, "PRODUCTION_JOB_NOT_FOUND", "生产任务不存在");
    }
    return mapJob(data);
  }

  async createJob(
    userId: string,
    input: CreateProductionJobInput,
  ): Promise<{ job: ProductionJob; replayed: boolean }> {
    const existing = await this.getJobByClientRequestId(userId, input.clientRequestId);
    if (existing) {
      if (
        existing.inputHash !== input.inputHash
        || existing.stage !== input.stage
        || existing.shotId !== (input.shotId || null)
        || existing.requestPayload.projectId !== input.projectId
      ) {
        throw new ShortDramaProductionError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "相同 clientRequestId 已用于不同生产请求",
        );
      }
      return { job: existing, replayed: true };
    }

    const row = {
      public_job_id: publicJobId(userId, input.clientRequestId),
      project_id: input.projectId,
      user_id: userId,
      shot_id: input.shotId || null,
      prompt_snapshot_id: input.promptSnapshotId || null,
      client_request_id: input.clientRequestId,
      input_hash: input.inputHash,
      stage: input.stage,
      state: "accepted",
      model_public_id: input.modelPublicId || null,
      request_payload: input.requestPayload,
      result_payload: {},
      billing_snapshot: input.billingSnapshot || {},
      attempt_count: 0,
      max_attempts: 3,
      progress: 0,
    };
    const { data, error } = await this.db
      .from("short_drama_jobs")
      .insert(row)
      .select(JOB_SELECT)
      .single();
    if (!error && data) return { job: mapJob(data), replayed: false };
    if (!uniqueViolation(error)) throwDatabaseError(error);

    const raced = await this.getJobByClientRequestId(userId, input.clientRequestId);
    if (!raced || raced.inputHash !== input.inputHash || raced.stage !== input.stage) {
      throw new ShortDramaProductionError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "相同 clientRequestId 已用于不同生产请求",
      );
    }
    return { job: raced, replayed: true };
  }

  async updateJob(
    userId: string,
    projectId: string,
    jobId: string,
    patch: ProductionJobPatch,
  ): Promise<ProductionJob> {
    const databasePatch: Record<string, unknown> = {};
    if (patch.state !== undefined) databasePatch.state = patch.state;
    if (patch.provider !== undefined) databasePatch.provider = patch.provider;
    if (patch.upstreamTaskId !== undefined) databasePatch.upstream_task_id = patch.upstreamTaskId;
    if (patch.resultPayload !== undefined) databasePatch.result_payload = patch.resultPayload;
    if (patch.billingSnapshot !== undefined) databasePatch.billing_snapshot = patch.billingSnapshot;
    if (patch.attemptCount !== undefined) databasePatch.attempt_count = patch.attemptCount;
    if (patch.progress !== undefined) databasePatch.progress = Math.max(0, Math.min(100, patch.progress));
    if (patch.errorCode !== undefined) databasePatch.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) databasePatch.error_message = patch.errorMessage;
    if (patch.startedAt !== undefined) databasePatch.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) databasePatch.completed_at = patch.completedAt;

    const execute = () => this.db
      .from("short_drama_jobs")
      .update(databasePatch)
      .eq("id", jobId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .select(JOB_SELECT)
      .maybeSingle();
    let result = await execute();
    if (result.error && !migrationIsMissing(result.error)) result = await execute();
    if (result.error) throwDatabaseError(result.error);
    if (!result.data) {
      throw new ShortDramaProductionError(404, "PRODUCTION_JOB_NOT_FOUND", "生产任务不存在");
    }
    return mapJob(result.data);
  }

  async claimJobPersistence(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<ProductionJob | null> {
    const { data, error } = await this.db
      .from("short_drama_jobs")
      .update({
        state: "persisting",
        progress: 85,
        error_code: null,
        error_message: null,
      })
      .eq("id", jobId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .in("state", ["accepted", "queued", "running", "result_staging", "retry_wait"])
      .select(JOB_SELECT)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    return data ? mapJob(data) : null;
  }

  async claimLocalJobExecution(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<ProductionJob | null> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from("short_drama_jobs")
      .update({
        state: "running",
        progress: 5,
        attempt_count: 1,
        started_at: now,
        error_code: null,
        error_message: null,
      })
      .eq("id", jobId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .in("state", ["accepted", "retry_wait"])
      .select(JOB_SELECT)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    return data ? mapJob(data) : null;
  }

  async getOrCreatePromptSnapshot(input: {
    userId: string;
    projectId: string;
    stage: "entity_design" | "image_generation" | "video_generation";
    prompt: string;
    modelPublicId: string;
    variables: Record<string, JsonValue>;
  }): Promise<string> {
    const promptHash = createHash("sha256").update(input.prompt, "utf8").digest("hex");
    const lookup = () => this.db
      .from("short_drama_prompt_snapshots")
      .select("id")
      .eq("project_id", input.projectId)
      .eq("user_id", input.userId)
      .eq("stage", input.stage)
      .eq("prompt_hash", promptHash)
      .maybeSingle();
    const existing = await lookup();
    if (existing.error) throwDatabaseError(existing.error);
    if (existing.data?.id) return String(existing.data.id);

    const { data, error } = await this.db
      .from("short_drama_prompt_snapshots")
      .insert({
        project_id: input.projectId,
        user_id: input.userId,
        stage: input.stage,
        agent_id: "short-drama-production-facade",
        prompt_version: "production.v1",
        prompt_hash: promptHash,
        template_text: input.prompt,
        variables: input.variables,
        model_public_id: input.modelPublicId,
      })
      .select("id")
      .single();
    if (!error && data?.id) return String(data.id);
    if (!uniqueViolation(error)) throwDatabaseError(error);
    const raced = await lookup();
    if (raced.error) throwDatabaseError(raced.error);
    if (!raced.data?.id) throwDatabaseError(error);
    return String(raced.data.id);
  }

  async listAssetsForJob(
    userId: string,
    projectId: string,
    jobId: string,
  ): Promise<ProductionAsset[]> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .select(ASSET_SELECT)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("job_id", jobId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throwDatabaseError(error);
    return (data || []).map(mapAsset);
  }

  async getAsset(
    userId: string,
    projectId: string,
    assetId: string,
  ): Promise<ProductionAsset> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .select(ASSET_SELECT)
      .eq("id", assetId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) {
      throw new ShortDramaProductionError(404, "PRODUCTION_ASSET_NOT_FOUND", "TAKE 不存在或已删除");
    }
    return mapAsset(data);
  }

  async listShotAssets(
    userId: string,
    projectId: string,
    shotId: string,
    roles: readonly string[] = ["image", "storyboard", "video"],
  ): Promise<ProductionAsset[]> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .select(ASSET_SELECT)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("shot_id", shotId)
      .in("asset_role", [...roles])
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throwDatabaseError(error);
    return (data || []).map(mapAsset);
  }

  async updateAssetMetadata(
    userId: string,
    projectId: string,
    assetId: string,
    metadata: Record<string, JsonValue>,
  ): Promise<ProductionAsset> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .update({ metadata })
      .eq("id", assetId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .select(ASSET_SELECT)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) throw new ShortDramaProductionError(404, "PRODUCTION_ASSET_NOT_FOUND", "TAKE 不存在或已删除");
    return mapAsset(data);
  }

  async softDeleteAsset(userId: string, projectId: string, assetId: string): Promise<void> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", assetId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) throwDatabaseError(error);
    if (!data) throw new ShortDramaProductionError(404, "PRODUCTION_ASSET_NOT_FOUND", "TAKE 不存在或已删除");
  }

  async findLatestShotAsset(
    userId: string,
    projectId: string,
    shotId: string,
    roles: readonly string[],
  ): Promise<ProductionAsset | null> {
    const { data, error } = await this.db
      .from("short_drama_assets")
      .select(ASSET_SELECT)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("shot_id", shotId)
      .in("asset_role", [...roles])
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throwDatabaseError(error);
    return data?.[0] ? mapAsset(data[0]) : null;
  }

  async createAsset(input: {
    userId: string;
    projectId: string;
    shotId: string | null;
    jobId: string;
    assetRole:
      | "source"
      | "character_reference"
      | "scene_reference"
      | "storyboard"
      | "image"
      | "video"
      | "audio"
      | "subtitle"
      | "export";
    provider: string;
    objectKey: string;
    stableUri: string;
    mimeType?: string | null;
    byteSize?: number | null;
    checksumSha256?: string | null;
    metadata: Record<string, JsonValue>;
  }): Promise<ProductionAsset> {
    const findExisting = () => this.db
      .from("short_drama_assets")
      .select(ASSET_SELECT)
      .eq("provider", input.provider)
      .eq("object_key", input.objectKey)
      .is("deleted_at", null)
      .maybeSingle();
    const existing = await findExisting();
    if (existing.error) throwDatabaseError(existing.error);
    if (existing.data) {
      const mapped = mapAsset(existing.data);
      if (mapped.jobId !== input.jobId || mapped.shotId !== input.shotId) {
        throw new ShortDramaProductionError(
          409,
          "ASSET_OWNERSHIP_CONFLICT",
          "该稳定资产已经登记到其他生产任务",
        );
      }
      return mapped;
    }

    const { data, error } = await this.db
      .from("short_drama_assets")
      .insert({
        project_id: input.projectId,
        user_id: input.userId,
        shot_id: input.shotId,
        job_id: input.jobId,
        asset_role: input.assetRole,
        provider: input.provider,
        object_key: input.objectKey,
        stable_uri: input.stableUri,
        mime_type: input.mimeType || null,
        byte_size: input.byteSize ?? null,
        checksum_sha256: input.checksumSha256 || null,
        metadata: input.metadata,
      })
      .select(ASSET_SELECT)
      .single();
    if (!error && data) return mapAsset(data);
    if (!uniqueViolation(error)) throwDatabaseError(error);
    const raced = await findExisting();
    if (raced.error) throwDatabaseError(raced.error);
    if (!raced.data) throwDatabaseError(error);
    const mapped = mapAsset(raced.data);
    if (mapped.jobId !== input.jobId || mapped.shotId !== input.shotId) {
      throw new ShortDramaProductionError(409, "ASSET_OWNERSHIP_CONFLICT", "该稳定资产已经登记到其他生产任务");
    }
    return mapped;
  }

  async createSettlement(input: {
    userId: string;
    projectId: string;
    job: ProductionJob;
    cashCharged: number;
    creditsCharged?: number;
    costAmount?: number;
    ledgerReference?: string | null;
    pricingSnapshot: Record<string, JsonValue>;
  }): Promise<void> {
    const { data: existing, error: lookupError } = await this.db
      .from("short_drama_settlements")
      .select("job_id")
      .eq("job_id", input.job.id)
      .maybeSingle();
    if (lookupError) throwDatabaseError(lookupError);
    if (existing) return;

    const cashCharged = Math.max(0, input.cashCharged || 0);
    const creditsCharged = Math.max(0, input.creditsCharged || 0);
    const { error } = await this.db.from("short_drama_settlements").insert({
      job_id: input.job.id,
      project_id: input.projectId,
      user_id: input.userId,
      public_job_id: input.job.publicJobId,
      billing_mode: cashCharged > 0 ? "cash" : creditsCharged > 0 ? "credits" : "free",
      credits_charged: creditsCharged,
      cash_charged: cashCharged,
      cost_amount: Math.max(0, input.costAmount || 0),
      ledger_reference: input.ledgerReference || null,
      pricing_snapshot: input.pricingSnapshot,
    });
    if (error && !uniqueViolation(error)) throwDatabaseError(error);
  }

  async findOwnedVideoTask(userId: string, taskId: string): Promise<OwnedVideoTask | null> {
    const byExternal = await this.db
      .from("video_tasks")
      .select(VIDEO_TASK_SELECT)
      .eq("user_id", userId)
      .eq("task_id_external", taskId)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (byExternal.error) {
      throw new ShortDramaProductionError(503, "VIDEO_TASK_DATABASE_UNAVAILABLE", "视频任务追踪服务暂时不可用");
    }
    if (byExternal.data?.[0]) return mapVideoTask(byExternal.data[0]);

    const byLocal = await this.db
      .from("video_tasks")
      .select(VIDEO_TASK_SELECT)
      .eq("user_id", userId)
      .eq("id", taskId)
      .maybeSingle();
    if (byLocal.error) {
      throw new ShortDramaProductionError(503, "VIDEO_TASK_DATABASE_UNAVAILABLE", "视频任务追踪服务暂时不可用");
    }
    return byLocal.data ? mapVideoTask(byLocal.data) : null;
  }

  async getVideoPersistenceConfig(modelId: string): Promise<{
    protocolType: string;
    apiEndpoint: string;
    persistResultImmediately: boolean;
  }> {
    const { data, error } = await this.db
      .from("video_models")
      .select("protocol_type, api_endpoint, api_protocol_config")
      .eq("id", modelId)
      .maybeSingle();
    if (error) {
      throw new ShortDramaProductionError(503, "VIDEO_MODEL_DATABASE_UNAVAILABLE", "视频模型配置暂时不可用");
    }
    return {
      protocolType: String(data?.protocol_type || ""),
      apiEndpoint: String(data?.api_endpoint || ""),
      persistResultImmediately: Boolean(
        data?.api_protocol_config
        && typeof data.api_protocol_config === "object"
        && !Array.isArray(data.api_protocol_config)
        && (data.api_protocol_config as Record<string, unknown>).persist_result_immediately === true
      ),
    };
  }

  async updateVideoTaskStorage(userId: string, taskId: string, storageUrl: string): Promise<void> {
    const { error } = await this.db
      .from("video_tasks")
      .update({ storage_url: storageUrl, needs_proxy: false })
      .eq("id", taskId)
      .eq("user_id", userId);
    if (error) {
      throw new ShortDramaProductionError(503, "VIDEO_TASK_DATABASE_UNAVAILABLE", "视频稳定存储状态暂时无法登记");
    }
  }
}
