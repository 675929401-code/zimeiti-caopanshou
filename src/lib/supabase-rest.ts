// Direct REST API for Supabase - bypasses supabase-js schema cache issues
// Similar to the approach used in cami/route.ts

import { restDatabaseConnection } from '@/storage/database/configuration-source';
import { ensureServerRuntimeEnvLoaded } from '@/lib/server-runtime-env';

interface RestApiOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

// Cache the schema reload state - once successfully reloaded, no need to retry
const schemaReloaded = new Set<string>();

async function reloadSchemaCache(supabaseUrl: string, supabaseKey: string): Promise<void> {
  if (schemaReloaded.has(supabaseUrl)) return;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    // Send a request with schema-cache-reload header to force PostgREST to refresh
    await fetch(`${supabaseUrl}/rest/v1/users?select=id&limit=1`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'schema-cache-reload',
      },
    });
    schemaReloaded.add(supabaseUrl);
  } catch {
    // Ignore errors - this is just a warmup
  }
}

export async function supabaseRestApi(
  options: RestApiOptions
): Promise<{ data: unknown; error: string | null }> {
  let connection: ReturnType<typeof restDatabaseConnection>;
  try {
    ensureServerRuntimeEnvLoaded();
    connection = restDatabaseConnection(options.path);
  } catch {
    return { data: null, error: '配置数据源不可用' };
  }
  const { url: supabaseUrl, key: supabaseKey } = connection;
  if (!supabaseUrl || !supabaseKey) {
    return { data: null, error: '数据库配置缺失' };
  }

  const headers: Record<string, string> = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  let url = `${supabaseUrl}/rest/v1/${options.path}`;
  if (options.query) {
    const params = new URLSearchParams(options.query);
    url += `?${params.toString()}`;
  }

  const fetchOptions: RequestInit = { method: options.method, headers, cache: 'no-store' };

  if (options.body && (options.method === 'POST' || options.method === 'PATCH')) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    if (!response.ok) {
      // If schema cache miss, force reload and retry
      if (text.includes('schema cache')) {
        // First attempt: add schema-cache-reload header
        headers.Prefer = 'schema-cache-reload,return=representation';
        const retryResponse = await fetch(url, { ...fetchOptions, headers });
        const retryText = await retryResponse.text();
        if (retryResponse.ok) {
          schemaReloaded.add(supabaseUrl);
          try {
            return { data: JSON.parse(retryText), error: null };
          } catch {
            return { data: retryText, error: null };
          }
        }

        // Second attempt: warmup schema cache then retry
        await reloadSchemaCache(supabaseUrl, supabaseKey);
        // Wait a moment for the cache to refresh
        await new Promise(resolve => setTimeout(resolve, 1000));

        headers.Prefer = 'return=representation';
        const retry2Response = await fetch(url, { ...fetchOptions, headers });
        const retry2Text = await retry2Response.text();
        if (retry2Response.ok) {
          schemaReloaded.add(supabaseUrl);
          try {
            return { data: JSON.parse(retry2Text), error: null };
          } catch {
            return { data: retry2Text, error: null };
          }
        }

        return { data: null, error: retry2Text };
      }
      return { data: null, error: text };
    }

    try {
      return { data: JSON.parse(text), error: null };
    } catch {
      return { data: text || null, error: null };
    }
  } catch (err) {
    return { data: null, error: (err as Error).message };
  }
}
