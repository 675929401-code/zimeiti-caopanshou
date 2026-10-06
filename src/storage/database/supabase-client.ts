// Database client - unified Supabase cloud database.
// Business data must be selected only through protected runtime environment
// variables. Do not store production database credentials in Git/release code.

import { ensureServerRuntimeEnvLoaded } from "@/lib/server-runtime-env";
import { createDatabaseFetch } from "./database-transport";

import { sharedConfigurationConnection, routeConfigurationTables } from './configuration-source';

let supabaseClient: any = null;
let envLoadAttempted = false;

function ensureLocalEnvLoaded() {
  if (envLoadAttempted) return;
  envLoadAttempted = true;

  try {
    // Next normally loads .env.local, but long-running/local launcher contexts
    // can start from the release root or from .next/standalone.
    ensureServerRuntimeEnvLoaded();
  } catch {
    // If dotenv is unavailable or the file is absent, fall through to the
    // existing environment-variable checks below.
  }
}

function getSupabaseConfig() {
  ensureLocalEnvLoaded();

  const url = process.env.COZE_SUPABASE_URL || "";
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || "";

  if (!url || !key) {
    throw new Error(
      "Supabase not configured. Set COZE_SUPABASE_URL and COZE_SUPABASE_SERVICE_ROLE_KEY in the protected server env file.",
    );
  }

  return {
    url,
    key,
    isServiceRole: Boolean(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY),
  };
}

export function getSupabaseClient() {
  if (!supabaseClient) {
    const { createClient } = require("@supabase/supabase-js");
    const { url, key, isServiceRole } = getSupabaseConfig();

    const businessClient = createClient(url, key, {
      auth: isServiceRole ? { autoRefreshToken: false, persistSession: false } : undefined,
      global: { fetch: createDatabaseFetch(url) },
    });
    const shared = sharedConfigurationConnection();
    if (shared) {
      const configurationClient = createClient(shared.url, shared.key, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { fetch: createDatabaseFetch(shared.url, (input, init) => fetch(input, { ...init, cache: "no-store" })) },
      });
      supabaseClient = routeConfigurationTables(businessClient, configurationClient);
    } else {
      supabaseClient = businessClient;
    }
  }

  return supabaseClient;
}

// Reset the cached client (useful after schema changes that require PostgREST cache reload)
export function resetSupabaseClient() {
  supabaseClient = null;
}

// Admin client - uses service_role when COZE_SUPABASE_SERVICE_ROLE_KEY is present.
export function getSupabaseAdminClient() {
  return getSupabaseClient();
}

export function isSupabaseAvailable(): boolean {
  ensureLocalEnvLoaded();

  return Boolean(
    process.env.COZE_SUPABASE_URL &&
      (process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY),
  );
}
