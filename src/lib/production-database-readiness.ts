import databaseContract from "@/lib/generated/database-contract";

const OPENAPI_TIMEOUT_MS = 10_000;
const OPENAPI_MAX_BYTES = 16 * 1024 * 1024;

type ContractTable = {
  readonly name: string;
  readonly feature: string;
  readonly columns: readonly string[];
};

type ContractRpc = {
  readonly name: string;
  readonly feature: string;
  readonly arguments: readonly string[];
};

type DatabaseContract = {
  readonly schemaVersion: number;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly openApiProfile: string;
  readonly probeMode: string;
  readonly requiredProbeRole: "service_role";
  readonly tables: readonly ContractTable[];
  readonly rpcs: readonly ContractRpc[];
  readonly forbiddenRpcs: readonly { readonly name: string; readonly reason: string }[];
};

export const PRODUCTION_DATABASE_CONTRACT = databaseContract as DatabaseContract;

export type ProductionDatabaseContractCheck = {
  readonly ok: boolean;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly tableCount: number;
  readonly rpcCount: number;
  readonly missingTables: readonly string[];
  readonly missingColumns: readonly string[];
  readonly missingRpcs: readonly string[];
  readonly missingRpcArguments: readonly string[];
  readonly forbiddenRpcsPresent: readonly string[];
};

export type ProductionDatabaseReadiness =
  | ({ readonly ok: true; readonly state: "ready" } & ProductionDatabaseContractCheck)
  | ({
      readonly ok: false;
      readonly state: "migration-not-ready" | "probe-unavailable";
      readonly code: "PRODUCTION_SCHEMA_MIGRATION_NOT_READY" | "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE";
      readonly error: string;
    } & ProductionDatabaseContractCheck);

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

function emptyContractCheck(): ProductionDatabaseContractCheck & { readonly ok: false } {
  return {
    ok: false,
    contractId: PRODUCTION_DATABASE_CONTRACT.contractId,
    contractVersion: PRODUCTION_DATABASE_CONTRACT.contractVersion,
    tableCount: PRODUCTION_DATABASE_CONTRACT.tables.length,
    rpcCount: PRODUCTION_DATABASE_CONTRACT.rpcs.length,
    missingTables: [],
    missingColumns: [],
    missingRpcs: [],
    missingRpcArguments: [],
    forbiddenRpcsPresent: [],
  };
}

/**
 * Validate only PostgREST OpenAPI metadata. This function does not select any
 * business row and never executes a database RPC.
 */
export function validateProductionDatabaseOpenApi(
  document: unknown,
): ProductionDatabaseContractCheck {
  if (!isRecord(document) || !isRecord(document.paths)) {
    return {
      ...emptyContractCheck(),
      missingTables: ["postgrest-openapi"],
    };
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  const missingRpcs: string[] = [];
  const missingRpcArguments: string[] = [];
  const forbiddenRpcsPresent: string[] = [];

  for (const table of PRODUCTION_DATABASE_CONTRACT.tables) {
    const tablePath = document.paths[`/${table.name}`];
    if (!isRecord(tablePath) || !isRecord(tablePath.get)) {
      missingTables.push(table.name);
      continue;
    }
    const tableSchema = schemaForTable(document, table.name);
    const properties = isRecord(tableSchema) && isRecord(tableSchema.properties)
      ? tableSchema.properties
      : null;
    if (!properties) {
      missingColumns.push(`${table.name}.*`);
      continue;
    }
    for (const column of table.columns) {
      if (!(column in properties)) missingColumns.push(`${table.name}.${column}`);
    }
  }

  for (const rpc of PRODUCTION_DATABASE_CONTRACT.rpcs) {
    const rpcPath = document.paths[`/rpc/${rpc.name}`];
    if (!isRecord(rpcPath) || !isRecord(rpcPath.post)) {
      missingRpcs.push(rpc.name);
      continue;
    }
    const argumentNames = new Set<string>();
    collectSchemaNames(document, rpcPath.post, argumentNames);
    for (const argument of rpc.arguments) {
      if (!argumentNames.has(argument)) missingRpcArguments.push(`${rpc.name}.${argument}`);
    }
  }

  for (const rpc of PRODUCTION_DATABASE_CONTRACT.forbiddenRpcs) {
    const rpcPath = document.paths[`/rpc/${rpc.name}`];
    if (isRecord(rpcPath) && (isRecord(rpcPath.post) || isRecord(rpcPath.get))) {
      forbiddenRpcsPresent.push(rpc.name);
    }
  }

  const ok = missingTables.length === 0
    && missingColumns.length === 0
    && missingRpcs.length === 0
    && missingRpcArguments.length === 0
    && forbiddenRpcsPresent.length === 0;
  return {
    ok,
    contractId: PRODUCTION_DATABASE_CONTRACT.contractId,
    contractVersion: PRODUCTION_DATABASE_CONTRACT.contractVersion,
    tableCount: PRODUCTION_DATABASE_CONTRACT.tables.length,
    rpcCount: PRODUCTION_DATABASE_CONTRACT.rpcs.length,
    missingTables,
    missingColumns,
    missingRpcs,
    missingRpcArguments,
    forbiddenRpcsPresent,
  };
}

function openApiConfig(): { readonly endpoint: string; readonly key: string } | null {
  if (PRODUCTION_DATABASE_CONTRACT.requiredProbeRole !== "service_role") return null;
  const rawUrl = process.env.COZE_SUPABASE_URL?.trim() || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!rawUrl || !key) return null;
  try {
    const normalizedBase = rawUrl.endsWith("/") ? rawUrl : `${rawUrl}/`;
    return { endpoint: new URL("rest/v1/", normalizedBase).toString(), key };
  } catch {
    return null;
  }
}

export async function probeProductionDatabaseReadiness(): Promise<ProductionDatabaseReadiness> {
  const config = openApiConfig();
  if (!config) {
    return {
      ...emptyContractCheck(),
      state: "probe-unavailable",
      code: "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE",
      error: "production database OpenAPI probe is not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAPI_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint, {
      method: "GET",
      headers: {
        Accept: "application/openapi+json",
        "Accept-Profile": PRODUCTION_DATABASE_CONTRACT.openApiProfile,
        Authorization: `Bearer ${config.key}`,
        apikey: config.key,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ...emptyContractCheck(),
        state: "probe-unavailable",
        code: "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE",
        error: `production database OpenAPI probe failed with HTTP ${response.status}`,
      };
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > OPENAPI_MAX_BYTES) {
      throw new Error("production database OpenAPI document is too large");
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > OPENAPI_MAX_BYTES) {
      throw new Error("production database OpenAPI document is too large");
    }
    const check = validateProductionDatabaseOpenApi(JSON.parse(body) as unknown);
    if (!check.ok) {
      return {
        ...check,
        ok: false,
        state: "migration-not-ready",
        code: "PRODUCTION_SCHEMA_MIGRATION_NOT_READY",
        error: "production database schema does not match the release contract",
      };
    }
    return { ...check, ok: true, state: "ready" };
  } catch {
    return {
      ...emptyContractCheck(),
      state: "probe-unavailable",
      code: "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE",
      error: "production database OpenAPI probe is unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}
