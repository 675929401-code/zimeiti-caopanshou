import { getSupabaseClient } from "../src/storage/database/supabase-client";
import { resolveProviderSecret } from "../src/lib/provider-secret";
import { toPublicModelId } from "../src/lib/public-model-dto";
import { evaluateVideoChannelCircuit, sanitizeVideoChannelError } from "../src/lib/video-channel-health-circuit";

async function main() {
  const db = getSupabaseClient();
  const [modelsResult, healthResult, taskSchema, walletSchema, ledgerSchema, tasksResult] = await Promise.all([
    db.from("video_models").select("id,name,protocol_type,api_endpoint,api_key,is_active,is_hidden,requires_image,supports_image_input,price_per_use,cost_price,duration_seconds,api_protocol_config").eq("is_active", true),
    db.from("video_channel_health").select("channel_id,is_healthy,consecutive_failures,last_success_at,last_fail_at,updated_at,last_error"),
    db.from("video_tasks").select("id,client_request_id,request_fingerprint,billing_state,billing_price_yuan,billing_cost_price_yuan").limit(0),
    db.from("wallet_operations").select("id").limit(0),
    db.from("wallet_ledger_entries").select("id").limit(0),
    db.from("video_tasks").select("id,model_id,status,created_at").order("created_at", { ascending: false }).limit(8),
  ]);
  if (modelsResult.error) throw new Error(`VIDEO_METADATA_UNAVAILABLE:${modelsResult.error.code}`);
  const healthById = new Map((healthResult.data || []).map((row: Record<string, unknown>) => [row.channel_id, row]));
  const models = (modelsResult.data || []).map((row: Record<string, unknown>) => {
    let secretReady = false;
    try { secretReady = Boolean(resolveProviderSecret(row.api_key)); } catch { /* report boolean only */ }
    const config = row.api_protocol_config && typeof row.api_protocol_config === "object" ? row.api_protocol_config as Record<string, unknown> : {};
    let endpointHost = "";
    try { endpointHost = new URL(String(row.api_endpoint || "")).host; } catch { /* invalid endpoint */ }
    const health = healthById.get(row.id) as Record<string, unknown> | undefined;
    const circuit = evaluateVideoChannelCircuit(health);
    return {
      id: row.id, publicId: toPublicModelId("video", String(row.id)), name: row.name,
      protocol: row.protocol_type, endpointHost, endpointConfigured: Boolean(row.api_endpoint), secretReady,
      visible: row.is_hidden === false, requiresImage: row.requires_image === true, supportsImage: row.supports_image_input === true,
      price: row.price_per_use, cost: row.cost_price, duration: row.duration_seconds,
      workflowInputMode: config.workflow_input_mode || config.reference_input_mode || "",
      requiresSourceVideo: config.requires_source_video === true, requiresFirstFrame: config.requires_first_frame === true,
      requiresLastFrame: config.requires_last_frame === true, minReferenceImages: config.min_reference_images ?? null,
      maxReferenceImages: config.max_reference_images ?? null, minReferenceAudios: config.min_reference_audios ?? null,
      supportsPrompt: config.supports_prompt !== false, autoGenerateReference: config.auto_generate_reference ?? null,
      healthState: circuit.state, lastSuccessAt: circuit.lastSuccessAt, lastFailAt: circuit.lastFailAt,
      lastErrorCode: sanitizeVideoChannelError(health?.last_error).code,
    };
  });
  const databaseKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || "";
  const schemaResponse = await fetch(`${process.env.COZE_SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: databaseKey, Authorization: `Bearer ${databaseKey}`, Accept: "application/openapi+json" },
    signal: AbortSignal.timeout(15000),
  });
  const openApi = schemaResponse.ok ? await schemaResponse.json() : null;
  const requiredRpcs = ["reserve_video_generation_task_atomic", "bind_video_provider_task_atomic", "fail_video_generation_submission_atomic", "finalize_video_generation_task_atomic", "apply_wallet_operation_atomic"];
  console.log(JSON.stringify({
    readOnly: true, observedAt: new Date().toISOString(),
    schema: {
      videoTerminalColumnsReady: !taskSchema.error, videoSchemaErrorCode: taskSchema.error?.code || null,
      videoSchemaMissingColumn: /column .* does not exist/u.test(taskSchema.error?.message || ""),
      walletOperationsReady: !walletSchema.error, walletLedgerReady: !ledgerSchema.error,
      healthReadable: !healthResult.error,
      schemaIndexReadable: schemaResponse.ok,
      rpcs: Object.fromEntries(requiredRpcs.map(name => [name, Boolean(openApi?.paths?.[`/rpc/${name}`])])),
    },
    models,
    recentTasks: (tasksResult.data || []).map((row: Record<string, unknown>) => ({
      id: row.id, modelId: row.model_id, status: row.status, createdAt: row.created_at,
    })),
  }, null, 2));
}

main().catch(() => { console.error("Video read-only metadata inspection failed; sensitive error details suppressed."); process.exitCode = 1; });
