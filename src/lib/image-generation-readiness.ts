import {
  probeProductionDatabaseReadiness,
  PRODUCTION_DATABASE_CONTRACT,
  type ProductionDatabaseReadiness,
} from "@/lib/production-database-readiness";
import { storageManager } from "@/storage/object";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const IMAGE_TABLES = new Set(["image_generation_requests", "user_files"]);
const IMAGE_RPCS = new Set([
  "claim_image_generation_request", "claim_image_generation_request_v2",
  "save_image_generation_request", "finalize_image_generation_delivery",
]);
const BILLING_TABLES = new Set(["wallet_operations", "wallet_ledger_entries", "cash_transactions", "cash_debt_records"]);
const BILLING_RPCS = new Set(["apply_wallet_operation_atomic"]);

type ImageStorageReadiness = { initializedProviders: readonly string[] };
export type ImageTableReadCheck = { name: string; ready: boolean; code: string | null };
export type ImageGenerationReadiness = { ready: true } | {
  ready: false;
  code: "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY" | "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE" | "IMAGE_STORAGE_NOT_READY" | "BILLING_LEDGER_UNAVAILABLE";
  error: string;
  missingDependencies: string[];
};

export function imageGenerationRequiredTables(requiresBilling: boolean) {
  return PRODUCTION_DATABASE_CONTRACT.tables.filter((table) => IMAGE_TABLES.has(table.name)
    || (requiresBilling && BILLING_TABLES.has(table.name)));
}

/** GET with limit=0 validates names and required columns without returning business rows. */
export async function readImageGenerationTablePrerequisites(requiresBilling: boolean): Promise<ImageTableReadCheck[]> {
  const db = getSupabaseAdminClient();
  return Promise.all(imageGenerationRequiredTables(requiresBilling).map(async (table) => {
    try {
      const { error } = await db.from(table.name).select(table.columns.join(",")).limit(0);
      return { name: table.name, ready: !error, code: error ? String(error.code || "READ_FAILED") : null };
    } catch {
      return { name: table.name, ready: false, code: "READ_FAILED" };
    }
  }));
}

function missingForDomain(database: ProductionDatabaseReadiness, tables: Set<string>, rpcs: Set<string>) {
  return [
    ...database.missingTables.filter((name) => tables.has(name)),
    ...database.missingColumns.filter((name) => tables.has(name.split(".")[0])),
    ...database.missingRpcs.filter((name) => rpcs.has(name)),
    ...database.missingRpcArguments.filter((name) => rpcs.has(name.split(".")[0])),
  ];
}

/** Only image delivery and its actual billing dependencies are gates for this route. */
export function evaluateImageGenerationReadiness(
  database: ProductionDatabaseReadiness,
  storage: ImageStorageReadiness,
  requiresBilling: boolean,
  tableReads: readonly ImageTableReadCheck[] = [],
): ImageGenerationReadiness {
  if (database.state === "probe-unavailable" || database.missingTables.includes("postgrest-openapi")) {
    return {
      ready: false, code: "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE", missingDependencies: [],
      error: "暂时无法确认图片生成的数据库前置条件，本次不会调用模型或扣费，请稍后重试",
    };
  }
  const failedReads = tableReads.filter((check) => !check.ready && (IMAGE_TABLES.has(check.name)
    || (requiresBilling && BILLING_TABLES.has(check.name))));
  if (failedReads.some((check) => !["PGRST204", "PGRST205", "42P01", "42703"].includes(check.code || ""))) {
    return {
      ready: false, code: "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE", missingDependencies: failedReads.map((check) => check.name),
      error: "暂时无法读取图片生成的必要数据表，本次不会调用模型或扣费，请稍后重试",
    };
  }
  const missingImage = [...new Set([
    ...missingForDomain(database, IMAGE_TABLES, IMAGE_RPCS),
    ...failedReads.filter((check) => IMAGE_TABLES.has(check.name)).map((check) => check.name),
  ])];
  if (missingImage.length > 0) {
    return {
      ready: false, code: "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY", missingDependencies: missingImage,
      error: "图片生成的幂等记录或资产交付迁移尚未完成，本次不会调用模型或扣费，请管理员完成迁移后重试",
    };
  }
  if (requiresBilling) {
    const missingBilling = [...new Set([
      ...missingForDomain(database, BILLING_TABLES, BILLING_RPCS),
      ...failedReads.filter((check) => BILLING_TABLES.has(check.name)).map((check) => check.name),
    ])];
    if (missingBilling.length > 0) {
      return {
        ready: false, code: "BILLING_LEDGER_UNAVAILABLE", missingDependencies: missingBilling,
        error: "图片生成的计费账本尚未就绪，本次不会调用模型或扣费，请管理员完成计费配置后重试",
      };
    }
  }
  if (!storage.initializedProviders.includes("tencent_cos")) {
    return {
      ready: false, code: "IMAGE_STORAGE_NOT_READY", missingDependencies: ["tencent_cos"],
      error: "图片结果存储尚未配置完成，本次不会调用模型或扣费，请管理员检查对象存储配置",
    };
  }
  return { ready: true };
}

/** Metadata GET and provider initialization only: no RPC, asset upload or wallet mutation. */
export async function probeImageGenerationReadiness(requiresBilling: boolean): Promise<ImageGenerationReadiness> {
  try {
    const [database, storage, tableReads] = await Promise.all([
      probeProductionDatabaseReadiness(),
      storageManager.getStatus(),
      readImageGenerationTablePrerequisites(requiresBilling),
    ]);
    return evaluateImageGenerationReadiness(database, storage, requiresBilling, tableReads);
  } catch {
    return {
      ready: false, code: "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE", missingDependencies: [],
      error: "暂时无法确认图片生成的前置条件，本次不会调用模型或扣费，请稍后重试",
    };
  }
}
