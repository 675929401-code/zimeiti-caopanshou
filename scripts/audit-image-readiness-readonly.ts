import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { toPublicModelId } from "@/lib/public-model-dto";
import { getImageModelCapabilities } from "@/lib/image-model-capabilities";
import { storageManager } from "@/storage/object";
import { evaluateImageGenerationReadiness, readImageGenerationTablePrerequisites } from "@/lib/image-generation-readiness";
import { validateProductionDatabaseOpenApi, type ProductionDatabaseReadiness } from "@/lib/production-database-readiness";

const baseUrl = "http://127.0.0.1:5000";
const evidenceDirectory = path.resolve(".codex-evidence/phase2-image-20260902");

function safeEndpoint(value: unknown) {
  try {
    const parsed = new URL(String(value || ""));
    return { configured: true, scheme: parsed.protocol, origin: parsed.origin, pathname: parsed.pathname };
  } catch {
    return { configured: false, scheme: null, origin: null, pathname: null };
  }
}

async function main() {
  const db = getSupabaseClient();
  const [modelsRead, schemaResponse, publicResponse, storageStatus, tableReads] = await Promise.all([
    db.from("cover_models")
      .select("id,name,model_name,provider,api_endpoint,api_key,selling_price,cost_price,supports_image_input,sort_order")
      .eq("is_active", true).eq("is_hidden", false).order("sort_order", { ascending: true }),
    fetch(`${process.env.COZE_SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || "",
        Authorization: `Bearer ${process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || ""}`,
        Accept: "application/openapi+json",
      },
      signal: AbortSignal.timeout(20_000),
    }),
    fetch(`${baseUrl}/api/cover-models?surface=image-workbench`, { signal: AbortSignal.timeout(20_000) }),
    storageManager.getStatus(),
    readImageGenerationTablePrerequisites(true),
  ]);
  if (modelsRead.error) throw new Error(`MODEL_METADATA_READ_FAILED:${modelsRead.error.code || "UNKNOWN"}`);
  const schema = await schemaResponse.json() as { paths?: Record<string, unknown>; definitions?: Record<string, { properties?: Record<string, unknown> }> };
  const publicPayload = await publicResponse.json() as { models?: Array<Record<string, unknown>> };
  const contractCheck = validateProductionDatabaseOpenApi(schema);
  const databaseReadiness: ProductionDatabaseReadiness = schemaResponse.ok
    ? contractCheck.ok ? { ...contractCheck, ok: true, state: "ready" }
      : { ...contractCheck, ok: false, state: "migration-not-ready", code: "PRODUCTION_SCHEMA_MIGRATION_NOT_READY", error: "schema mismatch" }
    : { ...contractCheck, ok: false, state: "probe-unavailable", code: "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE", error: "schema probe unavailable" };
  const preflightDecision = evaluateImageGenerationReadiness(databaseReadiness, storageStatus, true, tableReads);
  const tables = ["image_generation_requests", "user_files", "wallet_operations", "wallet_ledger_entries", "cash_transactions", "cash_debt_records"];
  const rpcs = ["claim_image_generation_request", "claim_image_generation_request_v2", "save_image_generation_request", "finalize_image_generation_delivery", "apply_wallet_operation_atomic"];
  const schemaChecks = {
    httpStatus: schemaResponse.status,
    tables: tables.map((table) => ({ name: table, exists: Boolean(schema.paths?.[`/${table}`] || schema.definitions?.[table]) })),
    rpcs: rpcs.map((rpc) => ({ name: rpc, exists: Boolean(schema.paths?.[`/rpc/${rpc}`]) })),
    deliveryColumns: ["delivery_state", "delivery_asset_id"].map((column) => ({
      name: column, exists: Boolean(schema.definitions?.image_generation_requests?.properties?.[column]),
    })),
  };
  const rows = (modelsRead.data || []) as Array<Record<string, unknown>>;
  const models = rows.map((row) => {
    let secretResolvable = false;
    try { secretResolvable = resolveProviderSecret(row.api_key).trim().length >= 8; } catch { /* Report boolean only. */ }
    const endpoint = safeEndpoint(row.api_endpoint);
    const secureSkill = typeof endpoint.origin === "string" && /secure-skill/i.test(endpoint.origin);
    const publicId = toPublicModelId("cover", String(row.id));
    return {
      id: row.id, publicId, name: row.name, upstreamModel: row.model_name, provider: row.provider,
      endpoint,
      secretConfigured: typeof row.api_key === "string" && row.api_key.trim().length > 0,
      secretKind: typeof row.api_key === "string" && row.api_key.startsWith("env://") ? "environment-reference"
        : typeof row.api_key === "string" && row.api_key.startsWith("secret://") ? "secret-reference" : "database-value",
      secretResolvable,
      textToImageProtocol: secureSkill && row.provider === "secure_skill_chat" ? "chat-completions-image"
        : secureSkill ? "secure-skill-images" : "openai-images-generations",
      sellingPrice: Number(row.selling_price), costPrice: Number(row.cost_price),
      capabilities: getImageModelCapabilities(row),
      publicDto: publicPayload.models?.find((model) => model.id === publicId) || null,
    };
  });
  const report = {
    checkedAt: new Date().toISOString(), baseUrl,
    databaseWrites: 0, paidGenerationCalls: 0, providerCatalogCalls: 0, authTokensCreated: 0,
    credentialValuesPersisted: false,
    publicModelsHttpStatus: publicResponse.status, activeVisibleModelCount: models.length,
    publicModelCount: publicPayload.models?.length ?? 0, models, schemaChecks, tableReads, preflightDecision,
    storage: {
      defaultProvider: storageStatus.defaultProvider, initializedProviders: storageStatus.initializedProviders,
      tencentCosInitialized: storageStatus.initializedProviders.includes("tencent_cos"),
      configuredOnly: true, objectUploadVerified: false,
    },
    canaryPrerequisitesReady: preflightDecision.ready
      && models.some((model) => model.secretResolvable && model.endpoint.configured && model.sellingPrice > 0),
    realGenerationVerifiedThisRun: false,
  };
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, "image-readiness-readonly.json");
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, "[endpoint]") : "IMAGE_READONLY_AUDIT_FAILED");
  process.exitCode = 1;
});
