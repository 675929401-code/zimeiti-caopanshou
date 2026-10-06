import fs from "node:fs";
import {
  LOCAL_PREVIEW_RUNTIME_FILE,
  validateLocalPreviewRuntime,
} from "./start-local-data-preview.mjs";

const ACTIVE_STATE = "running";

export async function inspectActiveLocalLlmRequests(input = {}) {
  const fetchImpl = input.fetchImpl || fetch;
  const now = input.now instanceof Date ? input.now : new Date();
  const runtime = input.runtime || validateLocalPreviewRuntime(
    JSON.parse(fs.readFileSync(input.runtimeFile || LOCAL_PREVIEW_RUNTIME_FILE, "utf8").replace(/^\uFEFF/u, "")),
  );
  const endpoint = new URL("/rest/v1/llm_request_attempts", runtime.supabaseUrl);
  endpoint.searchParams.set("select", "record_id,provider_call_started_at,lease_expires_at,created_at");
  endpoint.searchParams.set("state", `eq.${ACTIVE_STATE}`);
  endpoint.searchParams.set("provider_call_started_at", "not.is.null");
  endpoint.searchParams.set("lease_expires_at", `gt.${now.toISOString()}`);
  endpoint.searchParams.set("order", "created_at.asc");
  endpoint.searchParams.set("limit", "25");

  const response = await fetchImpl(endpoint, {
    headers: {
      apikey: runtime.serviceRoleKey,
      Authorization: `Bearer ${runtime.serviceRoleKey}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`[run-build] Active LLM request check failed with HTTP ${response.status}; build stopped before changing the source version.`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("[run-build] Active LLM request check returned an invalid payload; build stopped before changing the source version.");
  }
  return rows.map((row) => ({
    recordSuffix: String(row?.record_id || "").slice(-8),
    providerStartedAt: String(row?.provider_call_started_at || ""),
    leaseExpiresAt: String(row?.lease_expires_at || ""),
    createdAt: String(row?.created_at || ""),
  }));
}

export async function assertNoActiveLocalLlmRequests(input = {}) {
  let active;
  try {
    active = await inspectActiveLocalLlmRequests(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[run-build] Unable to prove that local chat is drained: ${message}`);
  }
  if (active.length === 0) {
    console.log("[run-build] Local chat drain check passed: no active provider-dispatched LLM request.");
    return active;
  }
  const evidence = active
    .map((item) => `${item.recordSuffix || "unknown"}@${item.providerStartedAt || item.createdAt || "unknown"}`)
    .join(", ");
  throw new Error(
    `[run-build] Refusing to build while ${active.length} provider-dispatched LLM request(s) are active (${evidence}). Wait for completion or terminate/reconcile the original request before rebuilding.`,
  );
}
