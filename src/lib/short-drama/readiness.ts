import { getSupabaseClient } from "@/storage/database/supabase-client";

export const SHORT_DRAMA_SCHEMA_VERSION = "20260823043000";

export const SHORT_DRAMA_TABLE_CONTRACT = [
  {
    name: "short_drama_projects",
    columns: [
      "id", "user_id", "client_request_id", "request_hash", "title", "description",
      "project_type", "status", "source_payload", "settings", "revision", "created_at",
      "updated_at", "deleted_at",
    ],
  },
  {
    name: "short_drama_project_versions",
    columns: [
      "id", "project_id", "user_id", "version", "change_kind", "snapshot", "created_at",
    ],
  },
  {
    name: "short_drama_entities",
    columns: [
      "id", "project_id", "user_id", "entity_type", "entity_key", "name", "description",
      "attributes", "reference_asset_uri", "revision", "created_at", "updated_at",
    ],
  },
  {
    name: "short_drama_shots",
    columns: [
      "id", "project_id", "user_id", "sequence", "scene_key", "title", "narration",
      "visual_description", "image_prompt", "video_prompt", "negative_prompt",
      "duration_seconds", "aspect_ratio", "status", "metadata", "revision", "created_at",
      "updated_at",
    ],
  },
  {
    name: "short_drama_prompt_snapshots",
    columns: [
      "id", "project_id", "user_id", "stage", "agent_id", "prompt_version", "prompt_hash",
      "template_text", "variables", "model_public_id", "created_at",
    ],
  },
  {
    name: "short_drama_jobs",
    columns: [
      "id", "public_job_id", "project_id", "user_id", "shot_id", "prompt_snapshot_id",
      "client_request_id", "input_hash", "stage", "state", "provider", "upstream_task_id",
      "model_public_id", "model_id_snapshot", "request_payload", "result_payload",
      "billing_snapshot", "attempt_count", "max_attempts", "not_before", "lease_owner",
      "lease_token", "lease_expires_at", "progress", "error_code", "error_message",
      "created_at", "updated_at", "started_at", "completed_at",
    ],
  },
  {
    name: "short_drama_assets",
    columns: [
      "id", "project_id", "user_id", "shot_id", "job_id", "asset_role", "provider",
      "object_key", "stable_uri", "mime_type", "byte_size", "checksum_sha256", "metadata",
      "created_at", "updated_at", "deleted_at",
    ],
  },
  {
    name: "short_drama_settlements",
    columns: [
      "job_id", "project_id", "user_id", "public_job_id", "billing_mode", "credits_charged",
      "cash_charged", "cost_amount", "ledger_reference", "pricing_snapshot", "created_at",
    ],
  },
] as const;

export const SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT = {
  name: "short_drama_create_project",
  arguments: [
    "p_user_id",
    "p_client_request_id",
    "p_request_hash",
    "p_title",
    "p_description",
    "p_project_type",
    "p_source_payload",
    "p_settings",
  ],
} as const;

export type ShortDramaReadiness =
  | { readonly ok: true; readonly migrationStatus: "ready" }
  | {
      readonly ok: false;
      readonly migrationStatus: "missing" | "probe-failed" | "unknown";
      readonly code: "MIGRATION_NOT_READY" | "PROJECT_DATABASE_UNAVAILABLE";
      readonly error: string;
    };

export type ShortDramaStorageReadiness =
  | {
      readonly ok: true;
      readonly storageMode: "native";
      readonly migrationStatus: "ready";
      readonly nativeSchemaReady: true;
      readonly paidModelCallsEnabled: true;
      readonly compatibilityStatus: "not-needed";
    }
  | {
      readonly ok: true;
      readonly storageMode: "compat";
      readonly migrationStatus: "missing" | "probe-failed" | "unknown";
      readonly nativeSchemaReady: false;
      readonly paidModelCallsEnabled: false;
      readonly compatibilityStatus: "ready";
      readonly compatibilityContract: "short-drama-platform-settings-v1";
      readonly nativeBlockerCode: "MIGRATION_NOT_READY" | "PROJECT_DATABASE_UNAVAILABLE";
      readonly nativeBlocker: string;
    }
  | {
      readonly ok: false;
      readonly storageMode: "unavailable";
      readonly migrationStatus: "missing" | "probe-failed" | "unknown";
      readonly nativeSchemaReady: false;
      readonly paidModelCallsEnabled: false;
      readonly compatibilityStatus: "unavailable" | "self-check-failed";
      readonly code: "MIGRATION_NOT_READY" | "PROJECT_DATABASE_UNAVAILABLE" | "COMPAT_STORAGE_UNAVAILABLE" | "COMPAT_SELF_CHECK_FAILED";
      readonly error: string;
      readonly nativeBlockerCode: "MIGRATION_NOT_READY" | "PROJECT_DATABASE_UNAVAILABLE";
      readonly nativeBlocker: string;
    };

export type ShortDramaOpenApiContractCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: string };

export class ShortDramaReadinessError extends Error {
  constructor(
    readonly status: 503,
    readonly code: "MIGRATION_NOT_READY" | "PROJECT_DATABASE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaReadinessError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part) => isRecord(current) ? current[part] : undefined, document);
}

function schemaForTable(document: Record<string, unknown>, table: string): unknown {
  const definitions = isRecord(document.definitions) ? document.definitions : null;
  if (definitions && table in definitions) return definitions[table];

  const components = isRecord(document.components) ? document.components : null;
  const schemas = components && isRecord(components.schemas) ? components.schemas : null;
  return schemas?.[table];
}

function collectSchemaNames(
  document: unknown,
  value: unknown,
  names: Set<string>,
  seenRefs = new Set<string>(),
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSchemaNames(document, item, names, seenRefs));
    return;
  }
  if (!isRecord(value)) return;

  if (typeof value.name === "string") names.add(value.name);
  if (isRecord(value.properties)) {
    Object.keys(value.properties).forEach((name) => names.add(name));
  }
  if (typeof value.$ref === "string" && !seenRefs.has(value.$ref)) {
    seenRefs.add(value.$ref);
    collectSchemaNames(document, resolveJsonPointer(document, value.$ref), names, seenRefs);
  }
  Object.values(value).forEach((child) => collectSchemaNames(document, child, names, seenRefs));
}

/**
 * Validate the complete PostgREST-visible contract without selecting user rows
 * and without executing the write-capable project RPC.
 */
export function validateShortDramaOpenApiContract(
  document: unknown,
): ShortDramaOpenApiContractCheck {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return { ok: false, missing: "postgrest-openapi" };
  }

  for (const table of SHORT_DRAMA_TABLE_CONTRACT) {
    const path = document.paths[`/${table.name}`];
    if (!isRecord(path) || !isRecord(path.get)) {
      return { ok: false, missing: `table:${table.name}` };
    }

    const schema = schemaForTable(document, table.name);
    if (!isRecord(schema) || !isRecord(schema.properties)) {
      return { ok: false, missing: `schema:${table.name}` };
    }
    for (const column of table.columns) {
      if (!(column in schema.properties)) {
        return { ok: false, missing: `column:${table.name}.${column}` };
      }
    }
  }

  const rpcPath = document.paths[`/rpc/${SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.name}`];
  if (!isRecord(rpcPath) || !isRecord(rpcPath.post)) {
    return { ok: false, missing: `rpc:${SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.name}` };
  }

  const rpcNames = new Set<string>();
  collectSchemaNames(document, rpcPath.post, rpcNames);
  for (const argument of SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.arguments) {
    if (!rpcNames.has(argument)) {
      return {
        ok: false,
        missing: `rpc-argument:${SHORT_DRAMA_CREATE_PROJECT_RPC_CONTRACT.name}.${argument}`,
      };
    }
  }

  return { ok: true };
}

export function shortDramaReadinessFromOpenApi(
  document: unknown,
): ShortDramaReadiness {
  const contract = validateShortDramaOpenApiContract(document);
  if (!contract.ok) {
    return {
      ok: false,
      migrationStatus: "missing",
      code: "MIGRATION_NOT_READY",
      error: "影视工坊项目服务正在准备中，请稍后重试",
    };
  }
  return { ok: true, migrationStatus: "ready" };
}

function shortDramaOpenApiConfig(): { readonly endpoint: string; readonly key: string } | null {
  const baseUrl = process.env.COZE_SUPABASE_URL?.trim() || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!baseUrl || !key) return null;

  try {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return { endpoint: new URL("rest/v1/", normalizedBase).toString(), key };
  } catch {
    return null;
  }
}

/**
 * Metadata-only readiness probe. GET /rest/v1/ returns the PostgREST OpenAPI
 * schema for the current role; it does not read business rows, execute an RPC,
 * create a project, write the database or call a model.
 */
export async function probeShortDramaReadiness(): Promise<ShortDramaReadiness> {
  try {
    // This also performs the project's protected dotenv bootstrap. It does not
    // make a database request until a query/RPC is invoked.
    getSupabaseClient();
  } catch {
    return {
      ok: false,
      migrationStatus: "unknown",
      code: "PROJECT_DATABASE_UNAVAILABLE",
      error: "影视工坊数据库连接尚未配置或当前不可用",
    };
  }

  const config = shortDramaOpenApiConfig();
  if (!config) {
    return {
      ok: false,
      migrationStatus: "unknown",
      code: "PROJECT_DATABASE_UNAVAILABLE",
      error: "影视工坊数据库服务端连接尚未配置或当前不可用",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(config.endpoint, {
      method: "GET",
      headers: {
        Accept: "application/openapi+json",
        "Accept-Profile": "public",
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        migrationStatus: "probe-failed",
        code: "PROJECT_DATABASE_UNAVAILABLE",
        error: "影视工坊数据库合同检查当前不可用",
      };
    }

    const document: unknown = await response.json();
    return shortDramaReadinessFromOpenApi(document);
  } catch {
    return {
      ok: false,
      migrationStatus: "probe-failed",
      code: "PROJECT_DATABASE_UNAVAILABLE",
      error: "影视工坊数据库合同检查当前不可用",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Project/entity/shot CRUD may use the namespaced platform_settings compatibility
 * store only after its insert/read/delete/read self-check passes. Paid model,
 * job, asset and settlement routes never consume this result and still require
 * the complete native migration through assertShortDramaReadyForPaidModelCall.
 */
export async function probeShortDramaStorageReadiness(
  db?: ReturnType<typeof getSupabaseClient>,
): Promise<ShortDramaStorageReadiness> {
  const native = await probeShortDramaReadiness();
  if (native.ok) {
    return {
      ok: true,
      storageMode: "native",
      migrationStatus: "ready",
      nativeSchemaReady: true,
      paidModelCallsEnabled: true,
      compatibilityStatus: "not-needed",
    };
  }

  try {
    const {
      probeShortDramaCompatReadiness,
      SHORT_DRAMA_COMPAT_CONTRACT,
    } = await import("./compat-repository");
    const compat = await probeShortDramaCompatReadiness(db || getSupabaseClient());
    if (compat.ok) {
      return {
        ok: true,
        storageMode: "compat",
        migrationStatus: native.migrationStatus,
        nativeSchemaReady: false,
        paidModelCallsEnabled: false,
        compatibilityStatus: "ready",
        compatibilityContract: SHORT_DRAMA_COMPAT_CONTRACT,
        nativeBlockerCode: native.code,
        nativeBlocker: native.error,
      };
    }
    return {
      ok: false,
      storageMode: "unavailable",
      migrationStatus: native.migrationStatus,
      nativeSchemaReady: false,
      paidModelCallsEnabled: false,
      compatibilityStatus: compat.status,
      code: compat.code,
      error: compat.error,
      nativeBlockerCode: native.code,
      nativeBlocker: native.error,
    };
  } catch {
    return {
      ok: false,
      storageMode: "unavailable",
      migrationStatus: native.migrationStatus,
      nativeSchemaReady: false,
      paidModelCallsEnabled: false,
      compatibilityStatus: "unavailable",
      code: native.code,
      error: native.error,
      nativeBlockerCode: native.code,
      nativeBlocker: native.error,
    };
  }
}

export async function assertShortDramaReadyForPaidModelCall(): Promise<void> {
  const readiness = await probeShortDramaReadiness();
  if (!readiness.ok) {
    throw new ShortDramaReadinessError(503, readiness.code, readiness.error);
  }
}
