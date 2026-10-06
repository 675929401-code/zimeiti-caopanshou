export type PublicSkillSource = "builtin" | "open_source" | "community" | "custom";
export type PublicSkillRuntimeKind = "prompt" | "tool" | "workflow" | "hybrid";

export interface PublicSkillPermission {
  capability: string;
  description: string;
  required: boolean;
}

export interface PublicSkillResource {
  id: string;
  kind: "reference" | "template" | "example" | "schema" | "asset";
  title: string;
  mediaType: string;
  version: string;
  description: string;
  checksum?: string;
}

export interface PublicSkillProvenance {
  kind: "oss_public_source" | "public_contract_reimplementation" | "internal_original";
  sourceName: string;
  sourceUrl?: string;
  license: string;
  attribution: string;
  publicBehaviorReference: string;
}

export interface PublicSkillPackage {
  id: string;
  packageId: string;
  slug: string;
  source: PublicSkillSource;
  visibility: "private" | "tenant" | "public";
  runtimeKind: PublicSkillRuntimeKind;
  title: string;
  commandName: string;
  description: string;
  summary: string;
  category: string;
  tags: string[];
  version: string;
  schemaVersion: string;
  priceCredits: number;
  featured: boolean;
  installed: boolean;
  enabled: boolean;
  agentAutoInvokeEnabled: boolean;
  installCount: number;
  purchaseCount: number;
  author: string;
  coverUrl?: string;
  permissions: PublicSkillPermission[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  executionType: PublicSkillRuntimeKind;
  resources: PublicSkillResource[];
  provenance: PublicSkillProvenance;
  publishedAt: string;
}

export class SkillCatalogApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly operation?: string;

  constructor(message: string, options: { code: string; status: number; operation?: string }) {
    super(message);
    this.name = "SkillCatalogApiError";
    this.code = options.code;
    this.status = options.status;
    this.operation = options.operation;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSource(value: unknown): PublicSkillSource {
  return value === "open_source" || value === "community" || value === "custom"
    ? value
    : "builtin";
}

function parseRuntimeKind(value: unknown): PublicSkillRuntimeKind {
  return value === "tool" || value === "workflow" || value === "hybrid" ? value : "prompt";
}

function parsePermissions(value: unknown): PublicSkillPermission[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.capability !== "string") return [];
    return [{
      capability: item.capability,
      description: stringValue(item.description),
      required: booleanValue(item.required, true),
    }];
  });
}

function parseResources(value: unknown): PublicSkillResource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string") return [];
    const kind = item.kind === "template" || item.kind === "example" || item.kind === "schema" || item.kind === "asset"
      ? item.kind
      : "reference";
    return [{
      id: item.id,
      kind,
      title: item.title,
      mediaType: stringValue(item.mediaType, "text/plain"),
      version: stringValue(item.version, "1"),
      description: stringValue(item.description),
      checksum: typeof item.checksum === "string" ? item.checksum : undefined,
    }];
  });
}

function parseProvenance(value: unknown): PublicSkillProvenance {
  const record = isRecord(value) ? value : {};
  const kind = record.kind === "oss_public_source" || record.kind === "public_contract_reimplementation"
    ? record.kind
    : "internal_original";
  return {
    kind,
    sourceName: stringValue(record.sourceName, "漫剧工作台"),
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    license: stringValue(record.license, "Internal"),
    attribution: stringValue(record.attribution),
    publicBehaviorReference: stringValue(record.publicBehaviorReference),
  };
}

function parsePublicSkill(value: unknown): PublicSkillPackage | null {
  if (!isRecord(value)) return null;
  const packageId = stringValue(value.packageId);
  const commandName = stringValue(value.commandName);
  const title = stringValue(value.title);
  if (!packageId || !commandName || !title) return null;
  return {
    id: stringValue(value.id, packageId),
    packageId,
    slug: stringValue(value.slug, commandName.replace(/^\//u, "")),
    source: parseSource(value.source),
    visibility: value.visibility === "private" || value.visibility === "tenant" ? value.visibility : "public",
    runtimeKind: parseRuntimeKind(value.runtimeKind),
    title,
    commandName,
    description: stringValue(value.description),
    summary: stringValue(value.summary, stringValue(value.description)),
    category: stringValue(value.category, "productivity"),
    tags: stringList(value.tags),
    version: stringValue(value.version, "0.0.0"),
    schemaVersion: stringValue(value.schemaVersion, "1"),
    priceCredits: numberValue(value.priceCredits),
    featured: booleanValue(value.featured),
    installed: booleanValue(value.installed),
    enabled: booleanValue(value.enabled),
    agentAutoInvokeEnabled: booleanValue(value.agentAutoInvokeEnabled),
    installCount: numberValue(value.installCount),
    purchaseCount: numberValue(value.purchaseCount),
    author: stringValue(value.author, "漫剧工作台"),
    coverUrl: typeof value.coverUrl === "string" ? value.coverUrl : undefined,
    permissions: parsePermissions(value.permissions),
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : {},
    outputSchema: isRecord(value.outputSchema) ? value.outputSchema : {},
    executionType: parseRuntimeKind(value.executionType),
    resources: parseResources(value.resources),
    provenance: parseProvenance(value.provenance),
    publishedAt: stringValue(value.publishedAt),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SkillCatalogApiError("Skill 包服务返回了无法解析的响应", {
      code: "INVALID_RESPONSE",
      status: response.status,
    });
  }
  if (!isRecord(payload)) {
    throw new SkillCatalogApiError("Skill 包服务返回格式不正确", {
      code: "INVALID_RESPONSE",
      status: response.status,
    });
  }
  if (!response.ok || payload.ok !== true) {
    throw new SkillCatalogApiError(stringValue(payload.error, "Skill 包服务请求失败"), {
      code: stringValue(payload.code, `HTTP_${response.status}`),
      status: response.status,
      operation: typeof payload.operation === "string" ? payload.operation : undefined,
    });
  }
  return payload;
}

function requestHeaders(token: string | null, json = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export async function listPublishedSkills(
  token: string | null,
  signal?: AbortSignal,
): Promise<PublicSkillPackage[]> {
  const response = await fetch("/api/youcai/skills?limit=100", {
    method: "GET",
    headers: requestHeaders(token),
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const payload = await readJson(response);
  const packageStore = isRecord(payload.package_store) ? payload.package_store : null;
  if (packageStore?.state === "migration_not_ready" || packageStore?.code === "MIGRATION_NOT_READY") {
    // The endpoint can serve the built-in directory with HTTP 200 while the
    // package store is unavailable. Keep the UI's existing fallback warning.
    throw new SkillCatalogApiError("在线 Skill 列表暂时不可用", {
      code: "MIGRATION_NOT_READY",
      status: response.status,
      operation: typeof packageStore.operation === "string" ? packageStore.operation : undefined,
    });
  }
  if (!Array.isArray(payload.skills)) {
    throw new SkillCatalogApiError("Skill 包目录缺少 skills 列表", {
      code: "INVALID_RESPONSE",
      status: response.status,
    });
  }
  const skills = payload.skills.flatMap((item) => {
    const parsed = parsePublicSkill(item);
    return parsed ? [parsed] : [];
  });
  if (payload.skills.length > 0 && skills.length !== payload.skills.length) {
    throw new SkillCatalogApiError("Skill 包目录含有不兼容的发布数据", {
      code: "INVALID_RESPONSE",
      status: response.status,
    });
  }
  return skills;
}

export async function installPublishedSkill(packageId: string, token: string): Promise<void> {
  if (!token) {
    throw new SkillCatalogApiError("请先登录后安装 Skill", { code: "AUTH_REQUIRED", status: 401 });
  }
  const response = await fetch("/api/youcai/skills/install", {
    method: "POST",
    headers: requestHeaders(token, true),
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ packageId, enabled: true, priority: 0, installConfig: {} }),
  });
  await readJson(response);
}

export async function uninstallPublishedSkill(packageId: string, token: string): Promise<void> {
  if (!token) {
    throw new SkillCatalogApiError("请先登录后卸载 Skill", { code: "AUTH_REQUIRED", status: 401 });
  }
  const response = await fetch(`/api/youcai/skills/${encodeURIComponent(packageId)}/uninstall`, {
    method: "DELETE",
    headers: requestHeaders(token),
    credentials: "same-origin",
    cache: "no-store",
  });
  await readJson(response);
}

export function describeSkillApiError(error: unknown): {
  code: string;
  message: string;
  fallbackToBuiltin: boolean;
} {
  if (error instanceof SkillCatalogApiError) {
    if (error.code === "MIGRATION_NOT_READY") {
      return {
        code: error.code,
        message: "在线 Skill 列表暂时不可用；当前展示内置内容，安装功能稍后恢复。",
        fallbackToBuiltin: true,
      };
    }
    if (error.code === "AUTH_REQUIRED" || error.code === "UNAUTHENTICATED") {
      return {
        code: error.code,
        message: error.code === "AUTH_REQUIRED" ? "请先登录后安装或卸载 Skill。" : "登录状态已失效，请重新登录后再操作。",
        fallbackToBuiltin: error.code === "UNAUTHENTICATED",
      };
    }
    if (error.code === "SKILL_STORE_UNAVAILABLE") {
      return {
        code: error.code,
        message: "Skill 包服务暂时不可用；当前仅展示内置 Skill 目录，未写入安装状态。",
        fallbackToBuiltin: true,
      };
    }
    return { code: error.code, message: error.message, fallbackToBuiltin: false };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "ABORTED", message: "Skill 包目录加载已取消。", fallbackToBuiltin: false };
  }
  return {
    code: "NETWORK_ERROR",
    message: "无法连接 Skill 包服务；当前仅展示内置 Skill 目录，未写入安装状态。",
    fallbackToBuiltin: true,
  };
}
