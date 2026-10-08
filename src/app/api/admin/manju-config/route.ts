import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { manjuAdminCapability } from "@/lib/admin-manju-capabilities";
import { getTokenFromHeaders, type JWTPayload } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  ManjuAdminQuerySchema,
  MANJU_CONFIG_LATEST_SCHEMA_VERSION,
  MANJU_RUNTIME_LATEST_SCHEMA_DOMAINS,
  ManjuConfigActionSchema,
  ManjuConfigPayloadError,
  isManjuConflictError,
  isManjuDatabaseValidationError,
  isManjuMigrationNotReadyError,
  normalizeRpcRow,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigActiveRow,
  type ManjuConfigReleaseRow,
  type ManjuConfigRevisionRow,
  type ManjuDatabaseErrorLike,
} from "@/lib/server/manju-runtime-config";
import {
  ManjuCompatConflictError,
  ManjuCompatStoreError,
  type ManjuConfigStorageSelection,
  loadManjuCompatAdmin,
  loadManjuStorageStates,
  publishManjuCompatRevision,
  rollbackManjuCompatRelease,
  saveManjuCompatDraft,
} from "@/lib/server/manju-platform-settings-store";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function requiresLatestRuntimeSchema(domain: string): boolean {
  return MANJU_RUNTIME_LATEST_SCHEMA_DOMAINS.includes(
    domain as (typeof MANJU_RUNTIME_LATEST_SCHEMA_DOMAINS)[number],
  );
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

type AdminAuthResult =
  | { ok: true; actor: JWTPayload }
  | { ok: false; response: NextResponse };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function requireAdmin(request: NextRequest): Promise<AdminAuthResult> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return { ok: false, response: json({ ok: false, code: "AUTH_REQUIRED", error: "未登录" }, 401) };
  }
  const actor = await verifyAdminToken(token);
  if (!actor || actor.role !== "admin") {
    return { ok: false, response: json({ ok: false, code: "ADMIN_REQUIRED", error: "无权限" }, 403) };
  }
  return { ok: true, actor };
}

function getAdminDatabase() {
  const database = getSupabaseAdminClient();
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("MANJU_SERVICE_ROLE_REQUIRED");
  }
  return database;
}

function databaseFailure(
  error: ManjuDatabaseErrorLike | null | undefined,
  operation: string,
): NextResponse {
  if (isManjuMigrationNotReadyError(error)) {
    return json(
      {
        ok: false,
        code: "MIGRATION_NOT_READY",
        error: "漫剧配置表或原子发布函数尚未部署",
        operation,
      },
      503,
    );
  }
  if (isManjuConflictError(error)) {
    return json(
      {
        ok: false,
        code: "CONFIG_CONFLICT",
        error: "配置已被其他操作更新，请刷新后重试",
        operation,
      },
      409,
    );
  }
  if (isManjuDatabaseValidationError(error)) {
    return json(
      {
        ok: false,
        code: "CONFIG_OPERATION_INVALID",
        error: "配置操作的状态、指针或范围不合法",
        operation,
      },
      400,
    );
  }
  return json(
    {
      ok: false,
      code: "CONFIG_STORE_UNAVAILABLE",
      error: "漫剧配置存储暂时不可用",
      operation,
    },
    503,
  );
}

function payloadFailure(error: ManjuConfigPayloadError): NextResponse {
  return json(
    {
      ok: false,
      code: error.code,
      error: error.message,
      path: error.path,
    },
    400,
  );
}

function compatFailure(error: unknown, operation: string): NextResponse {
  if (error instanceof ManjuConfigPayloadError) return payloadFailure(error);
  if (error instanceof ManjuCompatConflictError) {
    return json({ ok: false, code: "CONFIG_CONFLICT", error: error.message, operation }, 409);
  }
  if (error instanceof ManjuCompatStoreError) {
    return json({ ok: false, code: error.code, error: error.message, operation }, 503);
  }
  return json(
    { ok: false, code: "CONFIG_STORE_UNAVAILABLE", error: "漫剧配置兼容存储暂时不可用", operation },
    503,
  );
}

function invalidRequest(error: z.ZodError): NextResponse {
  return json(
    {
      ok: false,
      code: "INVALID_REQUEST",
      error: "请求参数不合法",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
    400,
  );
}

function actorIdentifier(actor: JWTPayload): string | NextResponse {
  const actorId = actor.userId.trim();
  if (!actorId || actorId.length > 128 || /[\u0000-\u001F\u007F]/.test(actorId)) {
    return json(
      {
        ok: false,
        code: "CONFIG_ACTOR_ID_INVALID",
        error: "当前管理员账号缺少有效标识，不能写入可审计配置",
      },
      400,
    );
  }
  return actorId;
}

async function loadRevisionMap(database: ReturnType<typeof getSupabaseAdminClient>, ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { rows: new Map<string, ManjuConfigRevisionRow>(), error: null };
  }
  const result = await database
    .from("manju_config_revisions")
    .select(
      "id,environment,domain,version,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at",
    )
    .in("id", uniqueIds);
  const rows = new Map<string, ManjuConfigRevisionRow>();
  for (const row of (result.data ?? []) as ManjuConfigRevisionRow[]) rows.set(row.id, row);
  return { rows, error: result.error as ManjuDatabaseErrorLike | null };
}

function revisionPayloadIsValid(revision: ManjuConfigRevisionRow): boolean {
  try {
    const validated = validateManjuConfigPayload(revision.payload);
    validateManjuDomainContract(revision.domain, validated.payload, revision.schema_version);
    return validated.payloadHash === revision.payload_hash;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const parsed = ManjuAdminQuerySchema.safeParse({
    environment: url.searchParams.get("environment") ?? undefined,
    domain: url.searchParams.get("domain") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return invalidRequest(parsed.error);

  let database: ReturnType<typeof getSupabaseAdminClient>;
  try {
    database = getAdminDatabase();
  } catch {
    return databaseFailure(null, "load");
  }

  const { environment, domain, limit } = parsed.data;
  const capability = manjuAdminCapability(domain, "read");
  const domainAccess = await authorizeAdminCapability(request, capability.permission, {
    requireStepUp: capability.requireStepUp,
    operation: capability.operation,
  });
  if (!domainAccess.ok) return domainAccess.response;

  let storage: ManjuConfigStorageSelection;
  try {
    storage = (await loadManjuStorageStates(database, environment, [domain]))[domain];
  } catch (error) {
    return compatFailure(error, "resolve-storage");
  }

  if (storage.mode === "compat") {
    try {
      const compat = await loadManjuCompatAdmin(database, environment, domain);
      return json({ ...compat, storage_generation: storage.generation });
    } catch (error) {
      return compatFailure(error, "load-compat");
    }
  }

  const [activeResult, draftsResult, historyResult] = await Promise.all([
    database
      .from("manju_config_active")
      .select("environment,domain,active_release_id,active_revision_id,etag,updated_by,updated_at")
      .eq("environment", environment)
      .eq("domain", domain)
      .maybeSingle(),
    database
      .from("manju_config_revisions")
      .select(
        "id,environment,domain,version,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at",
      )
      .eq("environment", environment)
      .eq("domain", domain)
      .eq("status", "draft")
      .order("updated_at", { ascending: false })
      .limit(limit),
    database
      .from("manju_config_releases")
      .select(
        "id,environment,domain,release_number,revision_id,previous_release_id,release_kind,rollback_of_release_id,etag,released_by,created_at",
      )
      .eq("environment", environment)
      .eq("domain", domain)
      .order("release_number", { ascending: false })
      .limit(limit),
  ]);

  const firstError = activeResult.error ?? draftsResult.error ?? historyResult.error;
  if (firstError) return databaseFailure(firstError, "load-native");

  const activePointer = (activeResult.data ?? null) as ManjuConfigActiveRow | null;
  const history = (historyResult.data ?? []) as ManjuConfigReleaseRow[];
  const activeReleaseResult = activePointer
    ? await database
        .from("manju_config_releases")
        .select(
          "id,environment,domain,release_number,revision_id,previous_release_id,release_kind,rollback_of_release_id,etag,released_by,created_at",
        )
        .eq("id", activePointer.active_release_id)
        .maybeSingle()
    : { data: null, error: null };
  if (activeReleaseResult.error) return databaseFailure(activeReleaseResult.error, "load-active-release");

  const activeRelease = (activeReleaseResult.data ?? null) as ManjuConfigReleaseRow | null;
  const revisionsResult = await loadRevisionMap(database, [
    ...(activePointer ? [activePointer.active_revision_id] : []),
    ...history.map((release) => release.revision_id),
  ]);
  if (revisionsResult.error) return databaseFailure(revisionsResult.error, "load-revisions");

  const activeRevision = activePointer
    ? revisionsResult.rows.get(activePointer.active_revision_id) ?? null
    : null;
  const activeIsConsistent = activePointer === null
    ? activeRelease === null && activeRevision === null && history.length === 0
    : Boolean(
        activeRelease &&
          activeRevision &&
          activePointer.environment === environment &&
          activePointer.domain === domain &&
          activeRelease.environment === environment &&
          activeRelease.domain === domain &&
          activeRelease.id === activePointer.active_release_id &&
          activeRelease.revision_id === activePointer.active_revision_id &&
          activeRelease.etag === activePointer.etag &&
          releaseEtagMatches(activeRelease, activeRevision) &&
          activeRevision.environment === environment &&
          activeRevision.domain === domain &&
          activeRevision.id === activePointer.active_revision_id &&
          activeRevision.status === "published" &&
          Boolean(activeRevision.published_at) &&
          revisionPayloadIsValid(activeRevision),
      );
  const historyIsConsistent = history.every((release) => {
    const revision = revisionsResult.rows.get(release.revision_id);
    return Boolean(
      revision &&
        release.environment === environment &&
        release.domain === domain &&
        revision.environment === environment &&
        revision.domain === domain &&
        releaseEtagMatches(release, revision) &&
        revisionPayloadIsValid(revision),
    );
  });
  if (!activeIsConsistent || !historyIsConsistent) {
    return json(
      {
        ok: false,
        code: "CONFIG_STORE_CORRUPT",
        error: "原生配置活动指针、发布记录或修订内容不一致，已拒绝返回半残状态",
        environment,
        domain,
      },
      503,
    );
  }

  return json({
    ok: true,
    storage_mode: "native",
    storage_generation: storage.generation,
    environment,
    domain,
    active: activePointer
      ? {
          pointer: activePointer,
          release: activeRelease,
          revision: activeRevision,
        }
      : null,
    drafts: (draftsResult.data ?? []) as ManjuConfigRevisionRow[],
    history: history.map((release) => ({
      release,
      revision: revisionsResult.rows.get(release.revision_id) ?? null,
    })),
    generated_at: new Date().toISOString(),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_JSON", error: "请求体必须是 JSON" }, 400);
  }
  const parsed = ManjuConfigActionSchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequest(parsed.error);
  const action = parsed.data;
  const capability = manjuAdminCapability(action.domain, action.action);
  const domainAccess = await authorizeAdminCapability(request, capability.permission, {
    requireStepUp: capability.requireStepUp,
    operation: capability.operation,
  });
  if (!domainAccess.ok) return domainAccess.response;

  if (action.action === "validate") {
    try {
      const validated = validateManjuConfigPayload(action.payload);
      validateManjuDomainContract(action.domain, validated.payload, action.schema_version);
      return json({
        ok: true,
        action: "validate",
        environment: action.environment,
        domain: action.domain,
        schema_version: action.schema_version,
        payload_hash: validated.payloadHash,
        payload_bytes: validated.byteSize,
        max_depth: validated.maxDepth,
      });
    } catch (error) {
      if (error instanceof ManjuConfigPayloadError) return payloadFailure(error);
      return json({ ok: false, code: "CONFIG_VALIDATION_FAILED", error: "配置验证失败" }, 400);
    }
  }

  const actorId = actorIdentifier(auth.actor);
  if (actorId instanceof NextResponse) return actorId;

  let database: ReturnType<typeof getSupabaseAdminClient>;
  try {
    database = getAdminDatabase();
  } catch {
    return databaseFailure(null, action.action);
  }

  if (action.expected_storage_generation === undefined) {
    return json(
      {
        ok: false,
        code: "CONFIG_STORAGE_GENERATION_REQUIRED",
        error: "写入配置前必须先读取当前存储代次，请刷新后台后重试",
      },
      428,
    );
  }
  let storage: ManjuConfigStorageSelection;
  try {
    storage = (await loadManjuStorageStates(database, action.environment, [action.domain]))[action.domain];
  } catch (error) {
    return compatFailure(error, "resolve-storage");
  }
  if (storage.generation !== action.expected_storage_generation) {
    return json(
      {
        ok: false,
        code: "CONFIG_STORAGE_MODE_CHANGED",
        error: "配置存储链路已经切换，请刷新后再操作",
        expected_storage_generation: action.expected_storage_generation,
        actual_storage_generation: storage.generation,
      },
      409,
    );
  }

  if (action.action === "save-draft") {
    let validated: ReturnType<typeof validateManjuConfigPayload>;
    try {
      validated = validateManjuConfigPayload(action.payload);
      validateManjuDomainContract(action.domain, validated.payload, action.schema_version);
    } catch (error) {
      if (error instanceof ManjuConfigPayloadError) return payloadFailure(error);
      return json({ ok: false, code: "CONFIG_VALIDATION_FAILED", error: "配置验证失败" }, 400);
    }
    if (action.revision_id && !action.expected_updated_at) {
      return json(
        {
          ok: false,
          code: "CONFIG_EXPECTED_UPDATED_AT_REQUIRED",
          error: "更新草稿必须携带最近一次读取的 updated_at",
        },
        400,
      );
    }
    if (!action.revision_id && action.expected_updated_at) {
      return json(
        {
          ok: false,
          code: "CONFIG_NEW_DRAFT_EXPECTATION_FORBIDDEN",
          error: "新建草稿不应携带 expected_updated_at",
        },
        400,
      );
    }

    if (storage.mode === "compat") {
      try {
        const revision = await saveManjuCompatDraft(database, {
          environment: action.environment,
          domain: action.domain,
          payload: validated.payload,
          schemaVersion: action.schema_version,
          revisionId: action.revision_id ?? null,
          expectedUpdatedAt: action.expected_updated_at ?? null,
          actorId,
          expectedStorageGeneration: storage.generation,
        });
        return json({
          ok: true,
          action: "save-draft",
          storage_mode: "compat",
          storage_generation: storage.generation,
          revision,
        });
      } catch (error) {
        return compatFailure(error, "save-draft-compat");
      }
    }

    const result = await database.rpc("save_manju_config_draft", {
      p_environment: action.environment,
      p_domain: action.domain,
      p_payload: validated.payload,
      p_payload_hash: validated.payloadHash,
      p_schema_version: action.schema_version,
      p_revision_id: action.revision_id ?? null,
      p_expected_updated_at: action.expected_updated_at ?? null,
      p_actor_id: actorId,
    });
    if (result.error) {
      return databaseFailure(result.error, "save-draft");
    }
    return json({
      ok: true,
      action: "save-draft",
      storage_mode: "native",
      storage_generation: storage.generation,
      revision: normalizeRpcRow(result.data),
    });
  }

  if (action.action === "publish") {
    if (storage.mode === "compat") {
      try {
        const view = await loadManjuCompatAdmin(database, action.environment, action.domain);
        const draft = view.drafts.find((item) => item.id === action.revision_id);
        if (
          draft
          && requiresLatestRuntimeSchema(action.domain)
          && draft.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION
        ) {
          return json(
            {
              ok: false,
              code: "CONFIG_PUBLIC_SCHEMA_UPGRADE_REQUIRED",
              error: `公开配置必须升级为 schema ${MANJU_CONFIG_LATEST_SCHEMA_VERSION} 后才能发布`,
            },
            409,
          );
        }
        const release = await publishManjuCompatRevision(database, {
          environment: action.environment,
          domain: action.domain,
          revisionId: action.revision_id,
          expectedActiveReleaseId: action.expected_active_release_id ?? null,
          actorId,
          expectedStorageGeneration: storage.generation,
        });
        return json({
          ok: true,
          action: "publish",
          storage_mode: "compat",
          storage_generation: storage.generation,
          release,
        });
      } catch (error) {
        return compatFailure(error, "publish-compat");
      }
    }

    const revisionScopeResult = await database
      .from("manju_config_revisions")
      .select("id,environment,domain,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at,version")
      .eq("id", action.revision_id)
      .maybeSingle();
    if (revisionScopeResult.error) return databaseFailure(revisionScopeResult.error, "publish-scope");
    if (
      !revisionScopeResult.data ||
      revisionScopeResult.data.environment !== action.environment ||
      revisionScopeResult.data.domain !== action.domain
    ) {
      return json(
        {
          ok: false,
          code: "CONFIG_REVISION_SCOPE_MISMATCH",
          error: "草稿不属于当前环境或配置域",
        },
        400,
      );
    }
    const revision = revisionScopeResult.data as ManjuConfigRevisionRow;
    if (!revisionPayloadIsValid(revision) || revision.status !== "draft") {
      return json(
        {
          ok: false,
          code: "CONFIG_REVISION_INVALID",
          error: "草稿未通过当前 schema 与内容哈希校验",
        },
        409,
      );
    }
    if (
      requiresLatestRuntimeSchema(action.domain)
      && revision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION
    ) {
      return json(
        {
          ok: false,
          code: "CONFIG_PUBLIC_SCHEMA_UPGRADE_REQUIRED",
          error: `公开配置必须升级为 schema ${MANJU_CONFIG_LATEST_SCHEMA_VERSION} 后才能发布`,
        },
        409,
      );
    }

    const result = await database.rpc("publish_manju_config_revision", {
      p_revision_id: action.revision_id,
      p_expected_active_release_id: action.expected_active_release_id ?? null,
      p_actor_id: actorId,
    });
    if (result.error) {
      return databaseFailure(result.error, "publish");
    }
    return json({
      ok: true,
      action: "publish",
      storage_mode: "native",
      storage_generation: storage.generation + 1,
      release: normalizeRpcRow(result.data),
    });
  }

  if (storage.mode === "compat") {
    try {
      const view = await loadManjuCompatAdmin(database, action.environment, action.domain);
      const target = view.history.find((item) => item.release.id === action.target_release_id);
      if (
        target
        && requiresLatestRuntimeSchema(action.domain)
        && target.revision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION
      ) {
        return json(
          {
            ok: false,
            code: "CONFIG_ROLLBACK_SCHEMA_UPGRADE_REQUIRED",
            error: `旧版本仅供审计；请将其内容升级为 schema ${MANJU_CONFIG_LATEST_SCHEMA_VERSION} 后作为新草稿发布`,
          },
          409,
        );
      }
      const release = await rollbackManjuCompatRelease(database, {
        environment: action.environment,
        domain: action.domain,
        targetReleaseId: action.target_release_id,
        expectedActiveReleaseId: action.expected_active_release_id,
        actorId,
        expectedStorageGeneration: storage.generation,
      });
      return json({
        ok: true,
        action: "rollback",
        storage_mode: "compat",
        storage_generation: storage.generation,
        release,
      });
    } catch (error) {
      return compatFailure(error, "rollback-compat");
    }
  }

  const targetReleaseResult = await database
    .from("manju_config_releases")
    .select("id,environment,domain,revision_id")
    .eq("id", action.target_release_id)
    .maybeSingle();
  if (targetReleaseResult.error) return databaseFailure(targetReleaseResult.error, "rollback-target-release");
  if (
    !targetReleaseResult.data
    || targetReleaseResult.data.environment !== action.environment
    || targetReleaseResult.data.domain !== action.domain
  ) {
    return json(
      { ok: false, code: "CONFIG_ROLLBACK_TARGET_NOT_FOUND", error: "回滚目标不属于当前配置域" },
      404,
    );
  }
  const targetRevisionResult = await database
    .from("manju_config_revisions")
    .select("id,environment,domain,status,payload,payload_hash,schema_version,parent_revision_id,created_by,created_at,updated_at,published_at,version")
    .eq("id", targetReleaseResult.data.revision_id)
    .maybeSingle();
  if (targetRevisionResult.error) return databaseFailure(targetRevisionResult.error, "rollback-target-revision");
  const targetRevision = (targetRevisionResult.data ?? null) as ManjuConfigRevisionRow | null;
  if (!targetRevision || !revisionPayloadIsValid(targetRevision)) {
    return json(
      { ok: false, code: "CONFIG_ROLLBACK_TARGET_INVALID", error: "回滚目标未通过 schema 与内容哈希校验" },
      409,
    );
  }
  if (
    requiresLatestRuntimeSchema(action.domain)
    && targetRevision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION
  ) {
    return json(
      {
        ok: false,
        code: "CONFIG_ROLLBACK_SCHEMA_UPGRADE_REQUIRED",
        error: `旧版本仅供审计；请将其内容升级为 schema ${MANJU_CONFIG_LATEST_SCHEMA_VERSION} 后作为新草稿发布`,
      },
      409,
    );
  }

  const result = await database.rpc("rollback_manju_config_release", {
    p_environment: action.environment,
    p_domain: action.domain,
    p_target_release_id: action.target_release_id,
    p_expected_active_release_id: action.expected_active_release_id ?? null,
    p_actor_id: actorId,
  });
  if (result.error) {
    return databaseFailure(result.error, "rollback");
  }
  return json({
    ok: true,
    action: "rollback",
    storage_mode: "native",
    storage_generation: storage.generation + 1,
    release: normalizeRpcRow(result.data),
  });
}
