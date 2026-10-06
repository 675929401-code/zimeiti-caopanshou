import "server-only";

import {
  SkillAdminActionSchema,
  SkillAdminQuerySchema,
  SkillListQuerySchema,
  SkillPayloadValidationError,
  ReplaceSkillInstallationsSchema,
  sanitizeSkillAdminPayload,
  sanitizeSkillAdminValue,
  skillPayloadHash,
  stableSkillJson,
  toPublicSkillPackage,
  validateSkillInstallConfig,
  validateSkillPackagePayload,
  type PublicSkillPackage,
  type ResolvedSkillPackage,
  type SkillActor,
  type SkillAdminAction,
  type SkillJsonObject,
  type SkillListQuery,
  type SkillPackageRow,
  type SkillVersionRow,
  type UserSkillInstallationRow,
} from "@/lib/server/skill-package-contract";
import { isSkillAvailableForActor } from "@/lib/server/skill-policy";
import { restoreSkillAdminRedactedValues } from "@/lib/server/skill-admin-edit-preservation";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export type SkillRepositoryErrorCode =
  | "MIGRATION_NOT_READY"
  | "SKILL_STORE_UNAVAILABLE"
  | "SKILL_NOT_FOUND"
  | "SKILL_NOT_PUBLISHED"
  | "SKILL_ACCESS_DENIED"
  | "SKILL_CONFLICT"
  | "SKILL_OPERATION_INVALID"
  | "SKILL_PACKAGE_CORRUPT"
  | "SERVICE_ROLE_REQUIRED";

export class SkillRepositoryError extends Error {
  readonly code: SkillRepositoryErrorCode;
  readonly status: number;
  readonly operation: string;

  constructor(code: SkillRepositoryErrorCode, message: string, status: number, operation: string) {
    super(message);
    this.name = "SkillRepositoryError";
    this.code = code;
    this.status = status;
    this.operation = operation;
  }
}

export interface SkillDatabaseErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

const PACKAGE_SELECT =
  "id,slug,display_name,summary,origin,visibility,runtime_kind,lifecycle,active_version_id,latest_version_number,metadata,created_by,updated_by,created_at,updated_at";
const VERSION_SELECT =
  "id,package_id,version_number,semver,status,payload,payload_hash,schema_version,parent_version_id,created_by,updated_by,created_at,updated_at,published_at";
const INSTALLATION_SELECT =
  "user_id,package_id,version_id,enabled,priority,install_config,installed_by,created_at,updated_at";

const MIGRATION_ERROR_CODES = new Set(["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"]);
const CONFLICT_ERROR_CODES = new Set(["23505", "40001", "40P01", "P0001"]);
const VALIDATION_ERROR_CODES = new Set(["22023", "23503", "23514"]);

export function isSkillMigrationNotReadyError(error: SkillDatabaseErrorLike | null | undefined): boolean {
  const code = String(error?.code ?? "").toUpperCase();
  const text = `${error?.message ?? ""} ${error?.details ?? ""} ${error?.hint ?? ""}`.toLowerCase();
  return (
    MIGRATION_ERROR_CODES.has(code) ||
    /skill_packages|skill_versions|skill_invocations|skill_installations/.test(text) &&
      /does not exist|schema cache|could not find|unknown column|function/.test(text)
  );
}

export function normalizeSkillRepositoryError(error: unknown, operation: string): SkillRepositoryError {
  if (error instanceof SkillRepositoryError) return error;
  if (error instanceof SkillPayloadValidationError) {
    return new SkillRepositoryError("SKILL_OPERATION_INVALID", error.message, 400, operation);
  }
  const databaseError = (error ?? {}) as SkillDatabaseErrorLike;
  const code = String(databaseError.code ?? "").toUpperCase();
  const message = String(databaseError.message ?? "");
  if (code === "42501" && message.includes("SKILL_ARCHIVE_OWNER_REQUIRED")) {
    return new SkillRepositoryError("SKILL_ACCESS_DENIED", "仅可归档自己创建的私有非内置 Skill 包", 403, operation);
  }
  if (code === "55000" && message.includes("SKILL_ARCHIVE_IN_USE")) {
    return new SkillRepositoryError("SKILL_CONFLICT", "此 Skill 仍有启用的安装或执行中的任务，请先卸载并等待任务结束", 409, operation);
  }
  if (code === "55000" && /SKILL_PACKAGE_ARCHIVED|SKILL_VERSION_NOT_PUBLISHABLE/u.test(message)) {
    return new SkillRepositoryError("SKILL_OPERATION_INVALID", "此 Skill 已归档或版本不可发布，历史记录仅供查看", 409, operation);
  }
  if (isSkillMigrationNotReadyError(databaseError)) {
    return new SkillRepositoryError(
      "MIGRATION_NOT_READY",
      "Skill 包控制面迁移尚未部署",
      503,
      operation,
    );
  }
  if (CONFLICT_ERROR_CODES.has(code)) {
    return new SkillRepositoryError("SKILL_CONFLICT", "Skill 已被并发更新，请刷新后重试", 409, operation);
  }
  if (VALIDATION_ERROR_CODES.has(code)) {
    return new SkillRepositoryError("SKILL_OPERATION_INVALID", "Skill 状态或引用不合法", 400, operation);
  }
  return new SkillRepositoryError("SKILL_STORE_UNAVAILABLE", "Skill 服务暂时不可用", 503, operation);
}

function getSkillPackageDatabase(): ReturnType<typeof getSupabaseAdminClient> {
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new SkillRepositoryError(
      "SERVICE_ROLE_REQUIRED",
      "Skill 服务端持久化需要 service role",
      503,
      "connect",
    );
  }
  return getSupabaseAdminClient();
}

function safeMetadata(value: unknown): SkillJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  stableSkillJson(value);
  return value as SkillJsonObject;
}

function packageRow(value: unknown): SkillPackageRow {
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    slug: String(row.slug ?? ""),
    display_name: String(row.display_name ?? ""),
    summary: String(row.summary ?? ""),
    origin: row.origin as SkillPackageRow["origin"],
    visibility: row.visibility as SkillPackageRow["visibility"],
    runtime_kind: row.runtime_kind as SkillPackageRow["runtime_kind"],
    lifecycle: row.lifecycle as SkillPackageRow["lifecycle"],
    active_version_id: row.active_version_id ? String(row.active_version_id) : null,
    latest_version_number: Number(row.latest_version_number ?? 0),
    metadata: safeMetadata(row.metadata),
    created_by: String(row.created_by ?? ""),
    updated_by: String(row.updated_by ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function versionRow(value: unknown): SkillVersionRow {
  const row = value as Record<string, unknown>;
  const payload = validateSkillPackagePayload(row.payload);
  const storedHash = String(row.payload_hash ?? "");
  const calculatedHash = skillPayloadHash(payload);
  if (!/^[a-f0-9]{64}$/i.test(storedHash) || storedHash.toLowerCase() !== calculatedHash) {
    throw new SkillRepositoryError(
      "SKILL_PACKAGE_CORRUPT",
      "Skill 版本完整性校验失败",
      503,
      "verify-version",
    );
  }
  return {
    id: String(row.id ?? ""),
    package_id: String(row.package_id ?? ""),
    version_number: Number(row.version_number ?? 0),
    semver: String(row.semver ?? ""),
    status: row.status as SkillVersionRow["status"],
    payload,
    payload_hash: storedHash,
    schema_version: String(row.schema_version ?? ""),
    parent_version_id: row.parent_version_id ? String(row.parent_version_id) : null,
    created_by: String(row.created_by ?? ""),
    updated_by: String(row.updated_by ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    published_at: row.published_at ? String(row.published_at) : null,
  };
}

function installationRow(value: unknown): UserSkillInstallationRow {
  const row = value as Record<string, unknown>;
  return {
    user_id: String(row.user_id ?? ""),
    package_id: String(row.package_id ?? ""),
    version_id: String(row.version_id ?? ""),
    enabled: row.enabled === true,
    priority: Number(row.priority ?? 0),
    install_config: validateSkillInstallConfig(row.install_config ?? {}),
    installed_by: String(row.installed_by ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

function canReadPackage(row: SkillPackageRow, actor?: SkillActor | null): boolean {
  if (row.visibility === "public") return true;
  if (row.visibility === "tenant") return Boolean(actor);
  return Boolean(actor && row.created_by === actor.userId);
}

async function loadInstallations(userId: string | undefined, packageIds?: string[]): Promise<UserSkillInstallationRow[]> {
  if (!userId) return [];
  const database = getSkillPackageDatabase();
  let query = database
    .from("user_skill_installations")
    .select(INSTALLATION_SELECT)
    .eq("user_id", userId);
  if (packageIds?.length) query = query.in("package_id", packageIds);
  const result = await query;
  if (result.error) throw normalizeSkillRepositoryError(result.error, "load-installations");
  return (result.data ?? []).map(installationRow);
}

async function resolvePackages(
  rows: SkillPackageRow[],
  actor?: SkillActor | null,
): Promise<ResolvedSkillPackage[]> {
  const visibleRows = rows.filter((row) => canReadPackage(row, actor));
  const versionIds = Array.from(
    new Set(visibleRows.map((row) => row.active_version_id).filter((id): id is string => Boolean(id))),
  );
  if (versionIds.length === 0) return [];
  const database = getSkillPackageDatabase();
  const [versionsResult, installations] = await Promise.all([
    database.from("skill_versions").select(VERSION_SELECT).in("id", versionIds),
    loadInstallations(actor?.userId, visibleRows.map((row) => row.id)),
  ]);
  if (versionsResult.error) throw normalizeSkillRepositoryError(versionsResult.error, "load-versions");

  const versions = new Map<string, SkillVersionRow>();
  for (const raw of versionsResult.data ?? []) {
    const version = versionRow(raw);
    versions.set(version.id, version);
  }
  const installationByPackage = new Map(installations.map((row) => [row.package_id, row]));
  const resolved: ResolvedSkillPackage[] = [];
  for (const packageItem of visibleRows) {
    const version = packageItem.active_version_id ? versions.get(packageItem.active_version_id) : undefined;
    if (
      !version ||
      version.package_id !== packageItem.id ||
      version.status !== "released" ||
      !version.published_at
    ) {
      continue;
    }
    const installation = installationByPackage.get(packageItem.id) ?? null;
    if (installation && installation.version_id !== version.id) {
      // A stale installation must never silently execute another version. The catalog
      // remains visible, but the stale install is reported as absent until reinstalled.
      resolved.push({ package: packageItem, version, installation: null });
    } else {
      resolved.push({ package: packageItem, version, installation });
    }
  }
  return resolved;
}

function matchesQuery(skill: ResolvedSkillPackage, query: SkillListQuery): boolean {
  const payload = skill.version.payload;
  if (query.source && skill.package.origin !== query.source) return false;
  if (query.category && payload.manifest.category !== query.category) return false;
  if (query.tag && !payload.manifest.tags.includes(query.tag)) return false;
  if (!query.q) return true;
  const needle = query.q.toLocaleLowerCase("zh-CN");
  return [
    skill.package.slug,
    skill.package.display_name,
    skill.package.summary,
    payload.manifest.commandName,
    payload.manifest.description,
    payload.manifest.category,
    ...payload.manifest.tags,
  ].some((entry) => entry.toLocaleLowerCase("zh-CN").includes(needle));
}

export async function listResolvedPublishedSkillPackages(options: {
  actor?: SkillActor | null;
  query?: Partial<SkillListQuery>;
} = {}): Promise<ResolvedSkillPackage[]> {
  const query = SkillListQuerySchema.parse(options.query ?? {});
  const database = getSkillPackageDatabase();
  const result = await database
    .from("skill_packages")
    .select(PACKAGE_SELECT)
    .eq("lifecycle", "published")
    .not("active_version_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(Math.min(query.limit * 4, 400));
  if (result.error) throw normalizeSkillRepositoryError(result.error, "list-published");
  const resolved = await resolvePackages((result.data ?? []).map(packageRow), options.actor);
  return resolved.filter((skill) => matchesQuery(skill, query)).slice(0, query.limit);
}

export async function listPublishedSkillPackages(options: {
  actor?: SkillActor | null;
  query?: Partial<SkillListQuery>;
} = {}): Promise<PublicSkillPackage[]> {
  const skills = await listResolvedPublishedSkillPackages(options);
  return skills.map(toPublicSkillPackage);
}

export async function listAvailableSkillsForActor(
  actor: SkillActor,
  query: Partial<SkillListQuery> = {},
): Promise<ResolvedSkillPackage[]> {
  const skills = await listResolvedPublishedSkillPackages({ actor, query });
  return skills.filter((skill) => isSkillAvailableForActor(skill, actor));
}

export async function getPublishedSkillPackageBySlug(
  slug: string,
  actor?: SkillActor | null,
): Promise<ResolvedSkillPackage> {
  const database = getSkillPackageDatabase();
  const result = await database
    .from("skill_packages")
    .select(PACKAGE_SELECT)
    .eq("slug", slug)
    .eq("lifecycle", "published")
    .maybeSingle();
  if (result.error) throw normalizeSkillRepositoryError(result.error, "get-published");
  if (!result.data) {
    throw new SkillRepositoryError("SKILL_NOT_FOUND", "Skill 不存在", 404, "get-published");
  }
  const row = packageRow(result.data);
  if (!canReadPackage(row, actor)) {
    throw new SkillRepositoryError("SKILL_NOT_FOUND", "Skill 不存在", 404, "get-published");
  }
  const resolved = await resolvePackages([row], actor);
  if (!resolved[0]) {
    throw new SkillRepositoryError("SKILL_NOT_PUBLISHED", "Skill 暂无可用发布版本", 404, "get-published");
  }
  return resolved[0];
}

export async function listUserSkillInstallations(userId: string): Promise<UserSkillInstallationRow[]> {
  return loadInstallations(userId);
}

async function loadInstallTarget(
  actor: SkillActor,
  packageId: string,
  requestedVersionId?: string,
): Promise<{ package: SkillPackageRow; version: SkillVersionRow }> {
  const database = getSkillPackageDatabase();
  const packageResult = await database
    .from("skill_packages")
    .select(PACKAGE_SELECT)
    .eq("id", packageId)
    .eq("lifecycle", "published")
    .maybeSingle();
  if (packageResult.error) throw normalizeSkillRepositoryError(packageResult.error, "install-target");
  if (!packageResult.data) {
    throw new SkillRepositoryError("SKILL_NOT_FOUND", "Skill 不存在", 404, "install-target");
  }
  const packageItem = packageRow(packageResult.data);
  if (!canReadPackage(packageItem, actor)) {
    throw new SkillRepositoryError("SKILL_ACCESS_DENIED", "无权安装该 Skill", 403, "install-target");
  }
  const versionId = requestedVersionId ?? packageItem.active_version_id;
  if (!versionId) {
    throw new SkillRepositoryError("SKILL_NOT_PUBLISHED", "Skill 暂无可安装版本", 409, "install-target");
  }
  if (versionId !== packageItem.active_version_id) {
    throw new SkillRepositoryError(
      "SKILL_NOT_PUBLISHED",
      "只能安装当前发布版本",
      409,
      "install-target",
    );
  }
  const versionResult = await database
    .from("skill_versions")
    .select(VERSION_SELECT)
    .eq("id", versionId)
    .eq("package_id", packageId)
    .eq("status", "released")
    .maybeSingle();
  if (versionResult.error) throw normalizeSkillRepositoryError(versionResult.error, "install-version");
  if (!versionResult.data) {
    throw new SkillRepositoryError("SKILL_NOT_PUBLISHED", "Skill 版本不可安装", 409, "install-version");
  }
  const version = versionRow(versionResult.data);
  if (!version.published_at) {
    throw new SkillRepositoryError("SKILL_NOT_PUBLISHED", "Skill 版本尚未发布", 409, "install-version");
  }
  return { package: packageItem, version };
}

export async function installUserSkill(input: {
  actor: SkillActor;
  packageId: string;
  versionId?: string;
  enabled?: boolean;
  priority?: number;
  installConfig?: unknown;
}): Promise<UserSkillInstallationRow> {
  const installConfig = validateSkillInstallConfig(input.installConfig ?? {});
  const target = await loadInstallTarget(input.actor, input.packageId, input.versionId);
  const database = getSkillPackageDatabase();
  const result = await database
    .from("user_skill_installations")
    .upsert(
      {
        user_id: input.actor.userId,
        package_id: target.package.id,
        version_id: target.version.id,
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
        install_config: installConfig,
        installed_by: input.actor.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,package_id" },
    )
    .select(INSTALLATION_SELECT)
    .single();
  if (result.error) throw normalizeSkillRepositoryError(result.error, "install");
  return installationRow(result.data);
}

export async function uninstallUserSkill(input: {
  actor: SkillActor;
  packageId: string;
}): Promise<void> {
  const database = getSkillPackageDatabase();
  const result = await database
    .from("user_skill_installations")
    .delete()
    .eq("user_id", input.actor.userId)
    .eq("package_id", input.packageId)
    .select("package_id");
  if (result.error) throw normalizeSkillRepositoryError(result.error, "uninstall");
  if (!result.data?.length) {
    throw new SkillRepositoryError("SKILL_NOT_FOUND", "尚未安装该 Skill", 404, "uninstall");
  }
}

function actorIdentifier(value: string, operation: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SkillRepositoryError("SKILL_OPERATION_INVALID", "身份标识不合法", 400, operation);
  }
  return normalized;
}

function installationReplacementEnvelope(value: unknown, operation: string): SkillJsonObject {
  const envelope = rpcObject(value);
  if (envelope.ok !== true) {
    throw new SkillRepositoryError("SKILL_STORE_UNAVAILABLE", "Skill 安装状态替换失败", 503, operation);
  }
  return envelope;
}

export async function replaceAgentSkillInstallations(input: {
  agentId: string;
  actorId: string;
  installations: unknown;
}): Promise<SkillJsonObject> {
  const agentId = actorIdentifier(input.agentId, "replace-agent-installations");
  const actorId = actorIdentifier(input.actorId, "replace-agent-installations");
  const installations = ReplaceSkillInstallationsSchema.parse(input.installations).map((item) => {
    stableSkillJson(item.config);
    return item;
  });
  const database = getSkillPackageDatabase();
  const result = await database.rpc("replace_agent_skill_installations", {
    p_agent_id: agentId,
    p_installations: installations,
    p_actor_id: actorId,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "replace-agent-installations");
  return installationReplacementEnvelope(result.data, "replace-agent-installations");
}

export async function replaceUserSkillInstallations(input: {
  userId: string;
  actorId: string;
  installations: unknown;
}): Promise<SkillJsonObject> {
  const userId = actorIdentifier(input.userId, "replace-user-installations");
  const actorId = actorIdentifier(input.actorId, "replace-user-installations");
  const installations = ReplaceSkillInstallationsSchema.parse(input.installations).map((item) => ({
    ...item,
    config: validateSkillInstallConfig(item.config),
  }));
  const database = getSkillPackageDatabase();
  const result = await database.rpc("replace_user_skill_installations", {
    p_user_id: userId,
    p_installations: installations,
    p_actor_id: actorId,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "replace-user-installations");
  return installationReplacementEnvelope(result.data, "replace-user-installations");
}

export interface AdminSkillPackageView {
  package: SkillPackageRow;
  versions: Array<Omit<SkillVersionRow, "payload"> & { payload: ReturnType<typeof sanitizeSkillAdminPayload> }>;
}

export async function listAdminSkillPackages(rawQuery: unknown): Promise<AdminSkillPackageView[]> {
  const query = SkillAdminQuerySchema.parse(rawQuery);
  const database = getSkillPackageDatabase();
  let packageQuery = database
    .from("skill_packages")
    .select(PACKAGE_SELECT)
    .order("updated_at", { ascending: false })
    .limit(query.limit);
  if (query.lifecycle) packageQuery = packageQuery.eq("lifecycle", query.lifecycle);
  const packageResult = await packageQuery;
  if (packageResult.error) throw normalizeSkillRepositoryError(packageResult.error, "admin-list");
  let packages: SkillPackageRow[] = (packageResult.data ?? []).map(packageRow);
  if (query.q) {
    const needle = query.q.toLocaleLowerCase("zh-CN");
    packages = packages.filter((row) =>
      [row.slug, row.display_name, row.summary].some((entry) => entry.toLocaleLowerCase("zh-CN").includes(needle)),
    );
  }
  if (packages.length === 0) return [];
  const versionsResult = await database
    .from("skill_versions")
    .select(VERSION_SELECT)
    .in("package_id", packages.map((row) => row.id))
    .order("version_number", { ascending: false });
  if (versionsResult.error) throw normalizeSkillRepositoryError(versionsResult.error, "admin-versions");
  const versionsByPackage = new Map<string, SkillVersionRow[]>();
  for (const raw of versionsResult.data ?? []) {
    const version = versionRow(raw);
    const list = versionsByPackage.get(version.package_id) ?? [];
    list.push(version);
    versionsByPackage.set(version.package_id, list);
  }
  return packages.map((packageItem) => ({
    package: {
      ...packageItem,
      metadata: sanitizeSkillAdminValue(packageItem.metadata) as SkillJsonObject,
    },
    versions: (versionsByPackage.get(packageItem.id) ?? []).map((version) => ({
      ...version,
      payload: sanitizeSkillAdminPayload(version.payload),
    })),
  }));
}

function rpcObject(value: unknown): SkillJsonObject {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new SkillRepositoryError("SKILL_STORE_UNAVAILABLE", "Skill 原子操作返回异常", 503, "rpc");
  }
  return row as SkillJsonObject;
}

async function resolveAdminSkillDraftInput(action: Extract<SkillAdminAction, { action: "validate" | "save-draft" }>) {
  let originalPayload: unknown;
  let originalMetadata: unknown;
  if (action.baseVersionId) {
    if (!action.packageId || !action.expectedUpdatedAt || (action.versionId && action.versionId !== action.baseVersionId)) {
      throw new SkillRepositoryError("SKILL_OPERATION_INVALID", "编辑基线必须匹配当前包、草稿和更新时间", 400, action.action);
    }
    const database = getSkillPackageDatabase();
    const [versionResult, packageResult] = await Promise.all([
      database.from("skill_versions").select(VERSION_SELECT).eq("id", action.baseVersionId).eq("package_id", action.packageId).maybeSingle(),
      database.from("skill_packages").select("id,metadata,updated_at").eq("id", action.packageId).maybeSingle(),
    ]);
    if (versionResult.error) throw normalizeSkillRepositoryError(versionResult.error, "edit-base-version");
    if (packageResult.error) throw normalizeSkillRepositoryError(packageResult.error, "edit-base-package");
    if (!versionResult.data || !packageResult.data) {
      throw new SkillRepositoryError("SKILL_OPERATION_INVALID", "编辑基线不属于当前 Skill 包或已不可读取", 400, action.action);
    }
    if (Date.parse(packageResult.data.updated_at) !== Date.parse(action.expectedUpdatedAt)) {
      throw new SkillRepositoryError("SKILL_CONFLICT", "Skill 已被并发更新，请重新载入后处理", 409, action.action);
    }
    originalPayload = versionRow(versionResult.data).payload;
    originalMetadata = safeMetadata(packageResult.data.metadata);
  }
  const payload = validateSkillPackagePayload(restoreSkillAdminRedactedValues(action.payload, originalPayload, "payload"));
  const metadata = restoreSkillAdminRedactedValues(action.metadata, originalMetadata, "metadata") as SkillJsonObject;
  stableSkillJson(metadata);
  return { payload, metadata };
}

export async function executeAdminSkillAction(rawAction: unknown, actorId: string): Promise<SkillJsonObject> {
  const action = SkillAdminActionSchema.parse(rawAction);
  const normalizedActorId = actorIdentifier(actorId, action.action);
  if (action.action === "validate") {
    const { payload } = await resolveAdminSkillDraftInput(action);
    return {
      ok: true,
      action: "validate",
      payload_hash: skillPayloadHash(payload),
      schema_version: action.schemaVersion,
    };
  }

  const database = getSkillPackageDatabase();
  if (action.action === "archive") {
    const result = await database.rpc("archive_skill_package", {
      p_package_id: action.packageId,
      p_expected_updated_at: action.expectedUpdatedAt,
      p_expected_active_version_id: action.expectedActiveVersionId,
      p_actor_id: normalizedActorId,
    });
    if (result.error) throw normalizeSkillRepositoryError(result.error, "archive");
    return rpcObject(result.data);
  }
  if (action.action === "save-draft") {
    const { payload, metadata } = await resolveAdminSkillDraftInput(action);
    const nextDraftFromReleasedVersion = Boolean(action.baseVersionId && !action.versionId);
    const result = await database.rpc(nextDraftFromReleasedVersion ? "create_skill_package_next_draft" : "save_skill_package_draft", {
      p_slug: action.slug,
      p_display_name: action.displayName,
      p_summary: action.summary,
      p_origin: action.origin,
      p_visibility: action.visibility,
      p_runtime_kind: action.runtimeKind,
      p_payload: payload,
      p_payload_hash: skillPayloadHash(payload),
      p_semver: action.semver,
      p_schema_version: action.schemaVersion,
      p_metadata: metadata,
      p_package_id: action.packageId ?? null,
      ...(nextDraftFromReleasedVersion ? {
        p_base_version_id: action.baseVersionId,
        p_expected_package_updated_at: action.expectedUpdatedAt,
      } : {
        p_version_id: action.versionId ?? null,
        p_expected_updated_at: action.expectedUpdatedAt ?? null,
      }),
      p_actor_id: normalizedActorId,
    });
    if (result.error) throw normalizeSkillRepositoryError(result.error, "save-draft");
    return rpcObject(result.data);
  }
  if (action.action === "publish") {
    const result = await database.rpc("publish_skill_version", {
      p_version_id: action.versionId,
      p_expected_active_version_id: action.expectedActiveVersionId ?? null,
      p_actor_id: normalizedActorId,
    });
    if (result.error) throw normalizeSkillRepositoryError(result.error, "publish");
    return rpcObject(result.data);
  }
  const result = await database.rpc("rollback_skill_package_version", {
    p_package_id: action.packageId,
    p_target_version_id: action.targetVersionId,
    p_expected_active_version_id: action.expectedActiveVersionId ?? null,
    p_actor_id: normalizedActorId,
  });
  if (result.error) throw normalizeSkillRepositoryError(result.error, "rollback");
  return rpcObject(result.data);
}

export function getSkillInvocationDatabase(): ReturnType<typeof getSupabaseAdminClient> {
  return getSkillPackageDatabase();
}

export async function requirePublishedSkillVersion(input: {
  actor: SkillActor;
  packageId: string;
  versionId: string;
}): Promise<ResolvedSkillPackage> {
  const database = getSkillPackageDatabase();
  const packageResult = await database
    .from("skill_packages")
    .select(PACKAGE_SELECT)
    .eq("id", input.packageId)
    .eq("lifecycle", "published")
    .maybeSingle();
  if (packageResult.error) throw normalizeSkillRepositoryError(packageResult.error, "invoke-package");
  if (!packageResult.data) {
    throw new SkillRepositoryError("SKILL_NOT_FOUND", "Skill 不存在", 404, "invoke-package");
  }
  const packageItem = packageRow(packageResult.data);
  if (!canReadPackage(packageItem, input.actor)) {
    throw new SkillRepositoryError("SKILL_ACCESS_DENIED", "无权调用该 Skill", 403, "invoke-package");
  }
  const versionResult = await database
    .from("skill_versions")
    .select(VERSION_SELECT)
    .eq("id", input.versionId)
    .eq("package_id", input.packageId)
    .eq("status", "released")
    .maybeSingle();
  if (versionResult.error) throw normalizeSkillRepositoryError(versionResult.error, "invoke-version");
  if (!versionResult.data) {
    throw new SkillRepositoryError("SKILL_NOT_PUBLISHED", "Skill 版本不可调用", 409, "invoke-version");
  }
  const version = versionRow(versionResult.data);
  const installations = await loadInstallations(input.actor.userId, [input.packageId]);
  const resolved = { package: packageItem, version, installation: installations[0] ?? null };
  if (!isSkillAvailableForActor(resolved, input.actor)) {
    throw new SkillRepositoryError("SKILL_ACCESS_DENIED", "Skill 未安装、已禁用或不可调用", 403, "invoke-version");
  }
  return resolved;
}
