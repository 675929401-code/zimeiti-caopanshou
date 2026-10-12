import { probeProductionDatabaseReadiness, type ProductionDatabaseReadiness } from "@/lib/production-database-readiness";

export type AutodlH3ProviderDeliveryReadiness = {
  ready: boolean;
  code: "H3_PROVIDER_DELIVERY_READY" | "H3_PROVIDER_DELIVERY_MIGRATION_NOT_READY" | "H3_PROVIDER_DELIVERY_PROBE_UNAVAILABLE";
  missingDependencies: string[];
};

const RPC = "autodl_h3_finalize_video_provider_url";

/** Only evaluates read-only OpenAPI metadata. Never invokes any settlement RPC. */
export function evaluateAutodlH3ProviderDeliveryReadiness(database: ProductionDatabaseReadiness): AutodlH3ProviderDeliveryReadiness {
  if (database.state === "probe-unavailable" || database.missingTables.includes("postgrest-openapi")) {
    return { ready: false, code: "H3_PROVIDER_DELIVERY_PROBE_UNAVAILABLE", missingDependencies: [] };
  }
  const missingDependencies = [
    ...database.missingRpcs.filter(name => [RPC, "autodl_h3_provider_delivery_v1_ready"].includes(name)),
    ...database.missingRpcArguments.filter(name => name.startsWith(`${RPC}.`)),
    ...database.missingColumns.filter(name => ["video_tasks.provider_result_url", "video_tasks.video_url", "video_tasks.storage_url", "video_tasks.needs_proxy"].includes(name)),
    ...database.missingTables.filter(name => ["video_tasks", "users", "cash_transactions", "revenue_records"].includes(name)),
  ];
  return { ready: missingDependencies.length === 0,
    code: missingDependencies.length ? "H3_PROVIDER_DELIVERY_MIGRATION_NOT_READY" : "H3_PROVIDER_DELIVERY_READY", missingDependencies };
}

export async function probeAutodlH3ProviderDeliveryReadiness(
  probe: () => Promise<ProductionDatabaseReadiness> = probeProductionDatabaseReadiness,
): Promise<AutodlH3ProviderDeliveryReadiness> {
  try { return evaluateAutodlH3ProviderDeliveryReadiness(await probe()); }
  catch { return { ready: false, code: "H3_PROVIDER_DELIVERY_PROBE_UNAVAILABLE", missingDependencies: [] }; }
}
