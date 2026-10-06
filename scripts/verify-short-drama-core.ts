import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CreateShortDramaEntityRequestSchema,
  CreateShortDramaProjectRequestSchema,
  CreateShortDramaShotRequestSchema,
  DeleteShortDramaShotRequestSchema,
  ShortDramaShotDbRowSchema,
  ShortDramaShotSchema,
  ShortDramaJobStateSchema,
  UpdateShortDramaEntityRequestSchema,
  UpdateShortDramaProjectRequestSchema,
  UpdateShortDramaShotRequestSchema,
} from "../src/lib/short-drama/contracts";
import { canonicalJson, hashShortDramaRequest } from "../src/lib/short-drama/idempotency";
import {
  clearConfirmedClientSubmissionIdentity,
  fingerprintClientSubmission,
  resolveClientSubmissionIdentity,
} from "../src/lib/short-drama/client-submission-identity";
import {
  SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT,
  SHORT_DRAMA_TABLE_CONTRACT,
  shortDramaReadinessFromOpenApi,
  validateShortDramaOpenApiContract,
} from "../src/lib/short-drama/readiness";
import {
  assertShortDramaJobTransition,
  canTransitionShortDramaJob,
  isShortDramaJobTerminal,
  transitionShortDramaJob,
} from "../src/lib/short-drama/state-machine";

const projectRoot = process.cwd();
const migrationPath = resolve(
  projectRoot,
  "supabase/migrations/20260823043000_short_drama_core.sql",
);
const migrationDirectoryPath = resolve(projectRoot, "supabase/migrations");
const rollbackPath = resolve(
  projectRoot,
  "supabase/rollbacks/20260823043000_short_drama_core.rollback.sql",
);
const applyMigrationPath = resolve(projectRoot, "scripts/apply-short-drama-core-migration.ts");
const repositoryPath = resolve(projectRoot, "src/lib/short-drama/repository.ts");
const compatRepositoryPath = resolve(projectRoot, "src/lib/short-drama/compat-repository.ts");
const readinessPath = resolve(projectRoot, "src/lib/short-drama/readiness.ts");
const healthRoutePath = resolve(projectRoot, "src/app/api/short-drama/health/route.ts");
const entitiesRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/projects/[projectId]/entities/route.ts",
);
const entityRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/projects/[projectId]/entities/[entityId]/route.ts",
);
const shotsRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/projects/[projectId]/shots/route.ts",
);
const shotRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/projects/[projectId]/shots/[shotId]/route.ts",
);
const workbenchPath = resolve(
  projectRoot,
  "src/features/film-studio-project/film-studio-project-workbench.tsx",
);
const entityPanelPath = resolve(
  projectRoot,
  "src/features/film-studio-project/film-studio-entity-panel.tsx",
);
const shotPanelPath = resolve(
  projectRoot,
  "src/features/film-studio-project/film-studio-shot-panel.tsx",
);
const generalScriptPath = resolve(
  projectRoot,
  "src/features/youcai-general-script/youcai-general-script.tsx",
);
const uploadScriptPath = resolve(
  projectRoot,
  "src/features/youcai-upload-script/youcai-upload-script.tsx",
);
const dramaScriptRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/drama-script/route.ts",
);
const generalScriptRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/script/route.ts",
);
const uploadStandardizeRoutePath = resolve(
  projectRoot,
  "src/app/api/short-drama/upload-script/standardize/route.ts",
);
const paidRequestIdempotencyPath = resolve(
  projectRoot,
  "src/lib/short-drama/paid-request-idempotency.ts",
);

function verifyContracts(): void {
  const parsed = CreateShortDramaProjectRequestSchema.parse({
    clientRequestId: "verify:project:0001",
    title: "无付费验证项目",
    projectType: "narrated_animation",
    sourcePayload: { script: "仅用于合同验证，不会调用模型。" },
    settings: {
      aspectRatio: "9:16",
      noCharacterSpeech: true,
      defaultShotDurationSeconds: 5,
    },
  });
  assert.equal(parsed.title, "无付费验证项目");
  assert.equal(parsed.settings.noCharacterSpeech, true);

  assert.equal(
    CreateShortDramaProjectRequestSchema.safeParse({
      clientRequestId: "short",
      title: "x",
    }).success,
    false,
  );
  assert.equal(
    UpdateShortDramaProjectRequestSchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );
  assert.equal(ShortDramaJobStateSchema.safeParse("succeeded").success, true);
  assert.equal(ShortDramaJobStateSchema.safeParse("unknown").success, false);

  const entity = CreateShortDramaEntityRequestSchema.parse({
    entityType: "character",
    entityKey: "source-character-1",
    name: "林岚",
  });
  assert.equal(entity.attributes && Object.keys(entity.attributes).length, 0);
  assert.equal(
    UpdateShortDramaEntityRequestSchema.safeParse({ expectedRevision: 1 }).success,
    false,
  );

  const shot = CreateShortDramaShotRequestSchema.parse({
    sequence: 1,
    title: "雨夜重逢",
    durationSeconds: 5.25,
    aspectRatio: "9:16",
    visualDescription: "雨幕中的中景。",
  });
  assert.equal(shot.sceneKey, null);
  assert.equal(shot.metadata && Object.keys(shot.metadata).length, 0);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 0, title: "x" }).success, false);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 1, title: "x", durationSeconds: 0 }).success, false);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 1, title: "x", durationSeconds: 121 }).success, false);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 1, title: "x", aspectRatio: "2:1" }).success, false);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 1, title: "x", status: "completed" }).success, false);
  assert.equal(CreateShortDramaShotRequestSchema.safeParse({ sequence: 1, title: "x", userId: "forbidden" }).success, false);
  assert.equal(UpdateShortDramaShotRequestSchema.safeParse({ expectedRevision: 1 }).success, false);
  assert.equal(UpdateShortDramaShotRequestSchema.safeParse({ expectedRevision: 1, status: "ready" }).success, false);
  assert.equal(DeleteShortDramaShotRequestSchema.parse({ expectedRevision: "2" }).expectedRevision, 2);

  const shotRow = ShortDramaShotDbRowSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "22222222-2222-4222-8222-222222222222",
    user_id: "owner-1",
    sequence: 1,
    scene_key: null,
    title: null,
    narration: null,
    visual_description: null,
    image_prompt: null,
    video_prompt: null,
    negative_prompt: null,
    duration_seconds: "5.25",
    aspect_ratio: "9:16",
    status: "draft",
    metadata: {},
    revision: 1,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  });
  assert.equal(shotRow.duration_seconds, 5.25);
  assert.equal(ShortDramaShotSchema.safeParse({
    id: shotRow.id,
    projectId: shotRow.project_id,
    sequence: shotRow.sequence,
    sceneKey: shotRow.scene_key,
    title: "",
    narration: "",
    visualDescription: "",
    imagePrompt: "",
    videoPrompt: "",
    negativePrompt: "",
    durationSeconds: shotRow.duration_seconds,
    aspectRatio: shotRow.aspect_ratio,
    status: shotRow.status,
    metadata: shotRow.metadata,
    revision: shotRow.revision,
    createdAt: shotRow.created_at,
    updatedAt: shotRow.updated_at,
  }).success, true);
}

function verifyIdempotency(): void {
  const left = { title: "A", settings: { b: 2, a: 1 } };
  const right = { settings: { a: 1, b: 2 }, title: "A" };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(hashShortDramaRequest(left), hashShortDramaRequest(right));
  assert.match(hashShortDramaRequest(left), /^[0-9a-f]{64}$/);
  assert.notEqual(hashShortDramaRequest(left), hashShortDramaRequest({ title: "B" }));
}

function mockShortDramaOpenApi(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const definitions: Record<string, unknown> = {};
  for (const table of SHORT_DRAMA_TABLE_CONTRACT) {
    paths[`/${table.name}`] = { get: {} };
    definitions[table.name] = {
      properties: Object.fromEntries(table.columns.map((column) => [column, { type: "string" }])),
    };
  }
  paths[`/rpc/${SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.name}`] = {
    post: {
      parameters: [
        {
          name: "args",
          in: "body",
          schema: {
            properties: Object.fromEntries(
              SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.arguments.map((argument) => [
                argument,
                { type: "string" },
              ]),
            ),
          },
        },
      ],
    },
  };
  return { swagger: "2.0", paths, definitions };
}

function cloneMock<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function verifyReadinessContractProbe(): void {
  const complete = mockShortDramaOpenApi();
  assert.deepEqual(validateShortDramaOpenApiContract(complete), { ok: true });
  assert.deepEqual(shortDramaReadinessFromOpenApi(complete), {
    ok: true,
    migrationStatus: "ready",
  });

  const missingTable = cloneMock(complete);
  delete (missingTable.paths as Record<string, unknown>)["/short_drama_jobs"];
  assert.deepEqual(shortDramaReadinessFromOpenApi(missingTable), {
    ok: false,
    migrationStatus: "missing",
    code: "MIGRATION_NOT_READY",
    error: "影视工坊项目数据库迁移不完整，请管理员完成核心迁移后重试",
  });

  const missingColumn = cloneMock(complete);
  const definitions = missingColumn.definitions as Record<
    string,
    { properties: Record<string, unknown> }
  >;
  delete definitions.short_drama_settlements.properties.pricing_snapshot;
  const columnCheck = validateShortDramaOpenApiContract(missingColumn);
  assert.equal(columnCheck.ok, false);
  if (!columnCheck.ok) {
    assert.equal(columnCheck.missing, "column:short_drama_settlements.pricing_snapshot");
  }

  const missingRpc = cloneMock(complete);
  delete (missingRpc.paths as Record<string, unknown>)["/rpc/short_drama_create_project"];
  const rpcCheck = validateShortDramaOpenApiContract(missingRpc);
  assert.equal(rpcCheck.ok, false);
  if (!rpcCheck.ok) assert.equal(rpcCheck.missing, "rpc:short_drama_create_project");

  const missingRpcArgument = cloneMock(complete);
  const rpc = (missingRpcArgument.paths as Record<string, {
    post: { parameters: Array<{ schema: { properties: Record<string, unknown> } }> };
  }>)["/rpc/short_drama_create_project"];
  delete rpc.post.parameters[0].schema.properties.p_settings;
  const argumentCheck = validateShortDramaOpenApiContract(missingRpcArgument);
  assert.equal(argumentCheck.ok, false);
  if (!argumentCheck.ok) {
    assert.equal(argumentCheck.missing, "rpc-argument:short_drama_create_project.p_settings");
  }

  const readinessSource = readFileSync(readinessPath, "utf8");
  assert.match(readinessSource, /method:\s*"GET"/);
  assert.match(readinessSource, /application\/openapi\+json/);
  assert.doesNotMatch(readinessSource, /\.from\s*\(/);
  assert.doesNotMatch(readinessSource, /\.rpc\s*\(/);

  const healthSource = readFileSync(healthRoutePath, "utf8");
  assert.match(healthSource, /healthPayload\(false\)/);
  assert.match(healthSource, /status:\s*503/);
}

function verifyCompatibilityPersistenceContract(): void {
  const compat = readFileSync(compatRepositoryPath, "utf8");
  assert.match(compat, /SHORT_DRAMA_COMPAT_CONTRACT\s*=\s*"short-drama-platform-settings-v1"/);
  assert.match(compat, /SHORT_DRAMA_COMPAT_KEY_PREFIX\s*=\s*"sd\.compat\.v1"/);
  assert.match(compat, /type CompatKind = "project" \| "entity" \| "shot"/);
  assert.match(compat, /createHash\("sha256"\).*\.slice\(0, 24\)/);
  assert.match(compat, /compatShotKey/);
  assert.match(compat, /\.s\.\$\{shotId\}/);
  assert.match(compat, /exactShotKeyPattern/);
  assert.match(compat, /\[0-9a-f-\]\{36\}/);
  assert.match(compat, /\.from\("platform_settings"\)/);
  assert.match(compat, /\.eq\("updated_at", expectedStorageRevision\)/);
  assert.match(compat, /verifyReadback/);
  assert.match(compat, /writeVerification:\s*"insert-read-enumerate-update-cas-delete-read"/);
  assert.match(compat, /writeVerification:\s*"not-run-read-only"/);
  assert.match(compat, /export async function verifyShortDramaCompatWriteReadiness/);
  assert.match(compat, /private async assertReady\(write = false\)/);
  assert.match(compat, /await this\.assertReady\(true\)/);
  const readProbeStart = compat.indexOf("export async function probeShortDramaCompatReadiness");
  const writeProbeStart = compat.indexOf("export async function verifyShortDramaCompatWriteReadiness");
  assert.ok(readProbeStart >= 0 && writeProbeStart > readProbeStart);
  const readProbe = compat.slice(readProbeStart, writeProbeStart);
  assert.doesNotMatch(readProbe, /\.insert\(|\.update\(|\.delete\(/);
  assert.match(compat, /compat unique-key contract missing/);
  assert.match(compat, /compat stale CAS unexpectedly succeeded/);
  assert.match(compat, /COMPAT_OWNER_CONTRACT_MISMATCH/);
  assert.match(compat, /deletedAt:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(compat, /kind:\s*"shot"/);
  assert.match(compat, /SHOT_SEQUENCE_CONFLICT/);
  assert.match(compat, /SHOT_REVISION_CONFLICT/);
  assert.doesNotMatch(
    compat,
    /\.from\("short_drama_(?:jobs|assets|settlements|prompt_snapshots)"\)/,
  );

  const ownerSegment = "a".repeat(24);
  const projectId = "11111111-1111-4111-8111-111111111111";
  const shotId = "22222222-2222-4222-8222-222222222222";
  const maximumShotKey = `sd.compat.v1.u.${ownerSegment}.p.${projectId}.s.${shotId}`;
  assert.equal(maximumShotKey.length, 117);
  assert.ok(maximumShotKey.length <= 128);

  const readiness = readFileSync(readinessPath, "utf8");
  assert.match(readiness, /probeShortDramaStorageReadiness/);
  assert.match(readiness, /await import\("\.\/compat-repository"\)/);
  assert.match(readiness, /storageMode:\s*"native"/);
  assert.match(readiness, /storageMode:\s*"compat"/);
  assert.match(readiness, /paidModelCallsEnabled:\s*false/);
  assert.match(readiness, /assertShortDramaReadyForPaidModelCall/);

  const health = readFileSync(healthRoutePath, "utf8");
  assert.match(health, /productionReady:\s*false/);
  assert.match(health, /code:\s*"MIGRATION_NOT_READY"/);
  assert.match(health, /分镜草稿可真实保存/);
  assert.match(health, /付费生成、任务、资产和结算继续关闭/);
}

function verifyProjectEntityShotCrudSources(): void {
  const repository = readFileSync(repositoryPath, "utf8");
  for (const marker of [
    "listEntities", "createEntity", "updateEntity", "deleteEntity",
    "listShots", "createShot", "updateShot", "deleteShot",
    "SHOT_SEQUENCE_CONFLICT", "SHOT_REVISION_CONFLICT", "SHOT_HAS_ACTIVE_JOB",
    "SHOT_HAS_PRODUCTION_HISTORY",
  ]) assert.ok(repository.includes(marker), `missing repository marker: ${marker}`);
  assert.match(repository, /\.eq\("project_id", projectId\)/);
  assert.match(repository, /\.eq\("user_id", userId\)/);
  assert.match(repository, /\.eq\("revision", input\.expectedRevision\)/);
  assert.match(repository, /\.eq\("revision", expectedRevision\)/);
  assert.match(repository, /\.from\("short_drama_jobs"\)/);
  assert.match(repository, /\.from\("short_drama_assets"\)/);
  assert.match(repository, /assertNoActiveShotJob/);
  assert.match(repository, /assertNoShotProductionHistory/);
  assert.match(repository, /status:\s*"draft"/);

  for (const routePath of [entitiesRoutePath, entityRoutePath, shotsRoutePath, shotRoutePath]) {
    const source = readFileSync(routePath, "utf8");
    assert.match(source, /authorizeShortDramaRequest\(request\)/);
    assert.match(source, /X-Short-Drama-Storage-Mode/);
    assert.match(source, /storageMode/);
    assert.match(source, /Cache-Control/);
    assert.doesNotMatch(source, /generateProduction|callJsonRoute|billing|settlement/i);
  }
  assert.match(readFileSync(shotsRoutePath, "utf8"), /CreateShortDramaShotRequestSchema/);
  assert.match(readFileSync(shotsRoutePath, "utf8"), /ListShortDramaShotsQuerySchema/);
  assert.match(readFileSync(shotRoutePath, "utf8"), /UpdateShortDramaShotRequestSchema/);
  assert.match(readFileSync(shotRoutePath, "utf8"), /DeleteShortDramaShotRequestSchema/);

  const workbench = readFileSync(workbenchPath, "utf8");
  const entityPanel = readFileSync(entityPanelPath, "utf8");
  const shotPanel = readFileSync(shotPanelPath, "utf8");
  assert.match(workbench, /FilmStudioEntityPanel/);
  assert.match(workbench, /FilmStudioShotPanel/);
  assert.match(workbench, /projectStorageMode === "native"/);
  assert.match(workbench, /CompatProductionGate/);
  assert.match(workbench, /只开放项目、实体与分镜草稿 CRUD/);
  assert.doesNotMatch(workbench, /独立编辑 API 尚未接通/);
  assert.match(entityPanel, /\/entities/);
  assert.match(entityPanel, /兼容持久层/);
  assert.match(entityPanel, /写后读回校验/);
  assert.match(shotPanel, /\/shots/);
  assert.match(shotPanel, /method:\s*editing \? "PATCH" : "POST"/);
  assert.match(shotPanel, /method:\s*"DELETE"/);
  assert.match(shotPanel, /SHOT_REVISION_CONFLICT/);
  assert.match(shotPanel, /job、asset 与 settlement/);
  assert.doesNotMatch(shotPanel, /\/production/);
}

function verifyStableClientSubmissionIdentity(): void {
  let issued = 0;
  const createRequestId = () => `request-${++issued}`;
  const firstFingerprint = fingerprintClientSubmission({ text: "same", settings: { b: 2, a: 1 } });
  const sameFingerprint = fingerprintClientSubmission({ settings: { a: 1, b: 2 }, text: "same" });
  const changedFingerprint = fingerprintClientSubmission({ text: "changed", settings: { a: 1, b: 2 } });

  const first = resolveClientSubmissionIdentity(null, firstFingerprint, createRequestId);
  const ambiguousRetry = resolveClientSubmissionIdentity(first, sameFingerprint, createRequestId);
  assert.equal(ambiguousRetry.requestId, first.requestId);
  assert.equal(issued, 1);

  const changedInput = resolveClientSubmissionIdentity(first, changedFingerprint, createRequestId);
  assert.notEqual(changedInput.requestId, first.requestId);
  assert.equal(issued, 2);
  assert.equal(clearConfirmedClientSubmissionIdentity(first, "another-request"), first);
  assert.equal(clearConfirmedClientSubmissionIdentity(first, first.requestId), null);

  const generalSource = readFileSync(generalScriptPath, "utf8");
  assert.match(generalSource, /generationIdentityRef\.current\s*=\s*submissionIdentity/);
  assert.match(generalSource, /"Idempotency-Key":\s*requestId/);
  const generalParseIndex = generalSource.indexOf("parseGeneralScriptResult(payload.result)");
  assert.ok(
    generalParseIndex >= 0
      && generalParseIndex < generalSource.indexOf(
        "clearConfirmedClientSubmissionIdentity(",
        generalParseIndex,
      ),
  );

  const uploadSource = readFileSync(uploadScriptPath, "utf8");
  assert.match(uploadSource, /standardizeIdentityRef\.current\s*=\s*identity/);
  assert.match(uploadSource, /"Idempotency-Key":\s*identity\.requestId/);
  assert.match(uploadSource, /clearConfirmedClientSubmissionIdentity/);
}

function verifyPaidModelGuardOrdering(): void {
  const paidRequestSource = readFileSync(paidRequestIdempotencyPath, "utf8");
  assert.match(paidRequestSource, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(paidRequestSource, /headerClientRequestId !== normalizedBodyClientRequestId/);
  assert.match(paidRequestSource, /LLM_IDEMPOTENCY_CONFLICT/);
  assert.match(paidRequestSource, /LLM_IDEMPOTENCY_KEY_INVALID/);
  assert.match(paidRequestSource, /validateLlmClientRequestId\(clientRequestId\)/);

  const dramaRoute = readFileSync(dramaScriptRoutePath, "utf8");
  const dramaGuard = dramaRoute.indexOf("await assertShortDramaReadyForPaidModelCall();");
  const dramaRequestIdentity = dramaRoute.indexOf(
    "requireShortDramaPaidRequestId(request, task.clientRequestId)",
    dramaGuard,
  );
  assert.ok(dramaGuard >= 0);
  assert.ok(dramaRequestIdentity > dramaGuard);
  assert.ok(dramaRequestIdentity < dramaRoute.indexOf('if (task.operation === "optimize")', dramaGuard));
  assert.ok(dramaRequestIdentity < dramaRoute.indexOf("const scriptResponse = await fetch", dramaGuard));
  assert.doesNotMatch(dramaRoute, /"Idempotency-Key":\s*task\.clientRequestId/);

  for (const routePath of [generalScriptRoutePath, uploadStandardizeRoutePath]) {
    const source = readFileSync(routePath, "utf8");
    const guard = source.indexOf("await assertShortDramaReadyForPaidModelCall();");
    const requestIdentity = source.indexOf("requireShortDramaPaidRequestId(request)", guard);
    const modelSelection = source.indexOf("selectShortDramaTextModel", requestIdentity);
    const paidFetch = source.indexOf("const upstream = await fetch", guard);
    assert.ok(guard >= 0);
    assert.ok(requestIdentity > guard);
    assert.ok(modelSelection > requestIdentity);
    assert.ok(paidFetch > requestIdentity);
    assert.match(source, /"Idempotency-Key":\s*clientRequestId/);
    assert.match(source, /client_request_id:\s*clientRequestId/);
    assert.doesNotMatch(source, /clientRequestId \? \{ "Idempotency-Key"/);
  }
}

function verifyStateMachine(): void {
  assert.equal(canTransitionShortDramaJob("accepted", "queued"), true);
  assert.equal(transitionShortDramaJob("queued", "running"), "running");
  assert.equal(canTransitionShortDramaJob("running", "succeeded"), false);
  assert.equal(isShortDramaJobTerminal("succeeded"), true);
  assert.equal(isShortDramaJobTerminal("running"), false);
  assert.throws(
    () => assertShortDramaJobTransition("succeeded", "queued"),
    /不允许从 succeeded 转换到 queued/,
  );
}

function verifyMigrationContract(): void {
  const sql = readFileSync(migrationPath, "utf8");
  const requiredTables = [
    "short_drama_projects",
    "short_drama_project_versions",
    "short_drama_entities",
    "short_drama_shots",
    "short_drama_jobs",
    "short_drama_assets",
    "short_drama_prompt_snapshots",
    "short_drama_settlements",
  ];

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE ${table} FROM anon, authenticated`));
    assert.match(sql, new RegExp(`GRANT ALL ON TABLE ${table} TO service_role`));
  }

  for (const table of SHORT_DRAMA_TABLE_CONTRACT) {
    const block = sql.match(new RegExp(
      `CREATE TABLE IF NOT EXISTS ${table.name}\\s*\\(([\\s\\S]*?)\\n\\);`,
    ));
    assert.ok(block, `missing table definition for ${table.name}`);
    const migrationColumns = Array.from(
      block[1].matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s+/gm),
      (match) => match[1],
    );
    assert.deepEqual(migrationColumns, [...table.columns]);
    assert.match(
      block[1],
      /^\s{2}user_id\s+varchar\(36\)\s+NOT NULL REFERENCES public\.users\(id\)/m,
      `${table.name}.user_id must match public.users.id character varying(36)`,
    );
  }

  assert.doesNotMatch(sql, /^\s{2}user_id\s+uuid\b/m);

  const createProjectSignature = sql.match(
    /CREATE OR REPLACE FUNCTION short_drama_create_project\(([\s\S]*?)\)\s*RETURNS jsonb/,
  );
  assert.ok(createProjectSignature, "missing short_drama_create_project signature");
  const createProjectArguments = Array.from(
    createProjectSignature[1].matchAll(/^\s{2}(p_[a-z0-9_]+)\s+/gm),
    (match) => match[1],
  );
  assert.deepEqual(createProjectArguments, [...SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.arguments]);
  assert.match(createProjectSignature[1], /^\s{2}p_user_id\s+varchar\s*,/m);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION short_drama_update_project\(\s*p_user_id varchar,/,
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION short_drama_delete_project\(\s*p_user_id varchar,/,
  );

  assert.match(sql, /short_drama_projects_user_request_once_idx/);
  assert.match(sql, /short_drama_jobs_user_request_once/);
  assert.match(sql, /short_drama_jobs_provider_task_once_idx/);
  assert.match(sql, /short_drama_settlements_ledger_once_idx/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION short_drama_create_project/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION short_drama_update_project/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION short_drama_delete_project/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION short_drama_create_project\(varchar, text, text, text, text, text, jsonb, jsonb\)/,
  );
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE).*\sTO\s+(?:anon|authenticated)/i);
}

function verifyGuardedRollbackContract(): void {
  const sql = readFileSync(rollbackPath, "utf8");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /SHORT_DRAMA_ROLLBACK_REFUSED_NONEMPTY/);
  assert.match(sql, /SELECT count\(\*\) FROM public\.%I/);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.short_drama_create_project\(/);
  assert.match(sql, /DROP TABLE IF EXISTS public\.short_drama_projects;/);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|FUNCTION)[^;\n]*\bCASCADE\b/i);
  assert.match(sql, /COMMIT;\s*$/);
}

function verifyMigrationDirectorySafety(): void {
  const migrationFiles = readdirSync(migrationDirectoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const canonicalMigration = /^(\d{14})_[a-z0-9][a-z0-9_-]*\.sql$/iu;
  const rollbackLikeMigration = /(?:^|[._-])(?:rollback|down)(?:[._-]|$)/iu;

  assert.equal(
    migrationFiles.some((fileName) => rollbackLikeMigration.test(fileName)),
    false,
    "rollback/down SQL must never be stored in the CLI-scanned migrations directory",
  );
  assert.deepEqual(
    migrationFiles.filter((fileName) => !canonicalMigration.test(fileName)),
    [],
    "every forward migration must have one canonical timestamped filename",
  );

  const versions = migrationFiles.map((fileName) => canonicalMigration.exec(fileName)?.[1]);
  assert.equal(
    new Set(versions).size,
    versions.length,
    "Supabase migration versions must be unique",
  );
  assert.equal(
    dirname(rollbackPath) === migrationDirectoryPath,
    false,
    "guarded rollback must live outside the CLI-scanned migrations directory",
  );

  const applySource = readFileSync(applyMigrationPath, "utf8");
  assert.match(applySource, /validateMigrationDirectorySafety/u);
  assert.match(applySource, /SHORT_DRAMA_MIGRATION_DIRECTORY_ROLLBACK_FILE_REJECTED/u);
  assert.match(applySource, /SHORT_DRAMA_MIGRATION_DIRECTORY_DUPLICATE_VERSION_REJECTED/u);
  assert.match(
    applySource,
    /supabase\/rollbacks\/20260823043000_short_drama_core\.rollback\.sql/u,
  );
}

function verifyOwnerScopedRepository(): void {
  const source = readFileSync(repositoryPath, "utf8");
  assert.match(source, /\.eq\("user_id", userId\)/);
  assert.match(source, /p_user_id:\s*userId/);
  assert.doesNotMatch(source, /api[_-]?key|secret:\/\//i);
}

function main(): void {
  verifyContracts();
  verifyIdempotency();
  verifyReadinessContractProbe();
  verifyCompatibilityPersistenceContract();
  verifyProjectEntityShotCrudSources();
  verifyStableClientSubmissionIdentity();
  verifyPaidModelGuardOrdering();
  verifyStateMachine();
  verifyMigrationContract();
  verifyGuardedRollbackContract();
  verifyMigrationDirectorySafety();
  verifyOwnerScopedRepository();
  console.log("short-drama core verification passed (no network, no database writes, no paid model calls)");
}

main();
