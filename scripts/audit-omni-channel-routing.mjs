import { createHash, createHmac } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const databaseUrl = process.env.COZE_SUPABASE_URL;
const databaseKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
const publicIdSecret = process.env.PUBLIC_MODEL_ID_SECRET || process.env.JWT_SECRET?.trim() ?? '';

if (!databaseUrl || !databaseKey) throw new Error("Missing database configuration");

const db = createClient(databaseUrl, databaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fingerprint(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function publicModelId(internalId) {
  const digest = createHmac("sha256", publicIdSecret)
    .update(`video:${internalId}`)
    .digest("base64url")
    .slice(0, 24);
  return `pm_${digest}`;
}

function endpointSummary(value) {
  try {
    const parsed = new URL(String(value || ""));
    return { host: parsed.host, pathname: parsed.pathname };
  } catch {
    return { host: "invalid", pathname: "" };
  }
}

function safeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const allowed = [
    "supports_duration", "duration_options", "min_duration", "max_duration",
    "min_submit_duration", "resolution_options", "default_resolution", "resolution",
    "aspect_ratios", "supported_aspect_ratios", "requires_image", "supports_image_input",
  ];
  return Object.fromEntries(allowed.filter((key) => key in source).map((key) => [key, source[key]]));
}

async function probe(model) {
  const endpoint = String(model.api_endpoint || "").replace(/\/+$/, "");
  const baseUrl = endpoint.replace(/\/v1\/?$/, "");
  const candidates = [`${baseUrl}/v1/models`, `${baseUrl}/v1/videos`];
  const results = [];
  for (const url of candidates) {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${model.api_key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      const text = await response.text().catch(() => "");
      results.push({
        path: new URL(url).pathname,
        status: response.status,
        ok: response.ok,
        latency_ms: Date.now() - started,
        response_fingerprint: fingerprint(text),
        response_bytes: Buffer.byteLength(text),
      });
    } catch (error) {
      results.push({
        path: new URL(url).pathname,
        status: 0,
        ok: false,
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

const { data: modelRows, error: modelError } = await db
  .from("video_models")
  .select("*")
  .ilike("id", "%omni%")
  .order("id");
if (modelError) throw modelError;

const ids = (modelRows || []).map((row) => row.id);
const { data: healthRows, error: healthError } = ids.length
  ? await db
      .from("video_channel_health")
      .select("channel_id,total_requests,success_count,fail_count,consecutive_failures,last_success_at,last_fail_at,last_error,is_healthy,updated_at")
      .in("channel_id", ids)
  : { data: [], error: null };
if (healthError) throw healthError;

const healthById = new Map((healthRows || []).map((row) => [row.channel_id, row]));
const models = [];
for (const row of modelRows || []) {
  models.push({
    id: row.id,
    public_id: publicModelId(row.id),
    name: row.name,
    public_name: row.public_name || null,
    variant_label: row.variant_label || null,
    provider: row.provider,
    channel_name: row.channel_name,
    endpoint: endpointSummary(row.api_endpoint),
    key_fingerprint: fingerprint(row.api_key),
    model_name: row.model_name,
    protocol_type: row.protocol_type,
    is_active: row.is_active,
    is_hidden: row.is_hidden,
    price_per_use: row.price_per_use,
    cost_price: row.cost_price,
    duration_seconds: row.duration_seconds,
    max_duration: row.max_duration,
    model_counters: {
      total_requests: row.total_requests,
      success_count: row.success_count,
      fail_count: row.fail_count,
      last_success_at: row.last_success_at,
      last_tested_at: row.last_tested_at,
    },
    health: healthById.get(row.id) || null,
    public_capabilities: safeConfig(row.api_protocol_config),
    probes: await probe(row),
  });
}

console.log(JSON.stringify({
  schema: "omni_channel_routing_audit.v1",
  generated_at: new Date().toISOString(),
  paid_generation_calls: 0,
  model_count: models.length,
  models,
}, null, 2));
