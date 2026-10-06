import dotenv from "dotenv";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import { isPersistentVideoUri, resolvePersistentVideoUri } from "../src/lib/video-persistence";
import { SafeFetchError, validateSafeUrl } from "../src/lib/safe-fetch";
import { trustedRelayHostnamesFromEnv } from "../src/lib/safe-media-fetch";

dotenv.config({ path: ".env.local", quiet: true });

async function main() {
  const taskId = String(process.env.H3_DIAGNOSTIC_TASK_ID || "").trim();
  if (!/^h3_[a-f0-9]+$/u.test(taskId)) throw new Error("H3_DIAGNOSTIC_TASK_ID_INVALID");

  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("video_tasks")
    .select("status,storage_url,video_url,model_id")
    .eq("task_id_external", taskId)
    .maybeSingle();
  if (error) throw new Error("H3_DIAGNOSTIC_TASK_LOOKUP_FAILED");
  if (!data) throw new Error("H3_DIAGNOSTIC_TASK_MISSING");

  const storageUri = String(data.storage_url || "");
  if (!isPersistentVideoUri(storageUri)) throw new Error("H3_DIAGNOSTIC_STORAGE_NOT_PERSISTENT");
  const resolved = await resolvePersistentVideoUri(storageUri);
  const parsed = new URL(resolved);

  let validation: { ok: true } | { ok: false; code: string };
  try {
    await validateSafeUrl(parsed, { trustedHostnames: trustedRelayHostnamesFromEnv() });
    validation = { ok: true };
  } catch (caught) {
    validation = {
      ok: false,
      code: caught instanceof SafeFetchError ? caught.code : "VIDEO_SOURCE_URL_INVALID",
    };
  }

  console.log(JSON.stringify({
    status: String(data.status || ""),
    model_id: String(data.model_id || ""),
    storage_persistent: true,
    storage_provider: storageUri.split("://", 1)[0] || "unknown",
    resolved_protocol: parsed.protocol,
    resolved_hostname: parsed.hostname,
    resolved_port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    signed_query_present: parsed.search.length > 1,
    validation,
    credentials_printed: false,
    signed_url_printed: false,
  }, null, 2));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : "H3_DIAGNOSTIC_FAILED",
    credentials_printed: false,
    signed_url_printed: false,
  }));
  process.exitCode = 1;
});
