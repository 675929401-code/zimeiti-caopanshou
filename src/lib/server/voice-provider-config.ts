import { resolveProviderSecret } from '@/lib/provider-secret';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type VoiceProviderPluginRow = {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  subtype?: unknown;
  is_active?: unknown;
  sort_order?: unknown;
  config?: unknown;
};

type ProviderConfigDependencies = {
  listActivePlugins?: () => Promise<VoiceProviderPluginRow[]>;
  resolveSecret?: (value: unknown) => string;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type VolcanoVoiceProviderConfig = {
  apiKey: string;
  source: 'plugins' | 'environment';
  bindingId?: string;
};

const PROVIDER_ALIASES = new Set(['volcano', 'volcengine', 'bytedance', 'doubao']);
const VOICE_MARKER = /(voice|speech|tts|语音|配音|音色|火山)/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalized(value: unknown): string {
  return String(value || '').trim();
}

export function getVolcanoVoiceCredentialReference(row: VoiceProviderPluginRow): string {
  if (row.is_active !== true) return '';
  const config = asRecord(row.config);
  const provider = normalized(config.provider || config.vendor || config.channel).toLowerCase();
  if (!PROVIDER_ALIASES.has(provider)) return '';
  const identity = [row.name, row.role, row.subtype, config.capability, config.service]
    .map(normalized)
    .join(' ');
  if (!VOICE_MARKER.test(identity)) return '';
  return normalized(config.api_key || config.apiKey || config.token || config.access_token);
}

async function listActivePlugins(): Promise<VoiceProviderPluginRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('plugins')
    .select('id,name,role,subtype,is_active,sort_order,config')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error('VOICE_PROVIDER_CONFIG_READ_FAILED');
  return Array.isArray(data) ? data as VoiceProviderPluginRow[] : [];
}

/** Server-only resolver. It never returns a credential reference to the client. */
export async function loadVolcanoVoiceProviderConfig(
  dependencies: ProviderConfigDependencies = {},
): Promise<VolcanoVoiceProviderConfig | null> {
  let rows: VoiceProviderPluginRow[] = [];
  try {
    rows = await (dependencies.listActivePlugins || listActivePlugins)();
  } catch {
    // A protected server environment credential remains an explicit fallback
    // when the unified configuration store is temporarily unavailable.
    rows = [];
  }
  const secretResolver = dependencies.resolveSecret || resolveProviderSecret;
  for (const row of rows) {
    const reference = getVolcanoVoiceCredentialReference(row);
    if (!reference) continue;
    const apiKey = secretResolver(reference).trim();
    if (apiKey.length < 8) continue;
    return {
      apiKey,
      source: 'plugins',
      bindingId: normalized(row.id) || undefined,
    };
  }

  const environment = dependencies.environment || process.env;
  const envKey = normalized(environment.VOLCENGINE_API_KEY_1 || environment.VOLC_TOKEN);
  if (envKey.length >= 8) {
    return { apiKey: envKey, source: 'environment' };
  }
  return null;
}

export async function inspectVolcanoVoiceProviderConfig(): Promise<{
  configured: boolean;
  source: 'plugins' | 'environment' | 'none';
}> {
  const config = await loadVolcanoVoiceProviderConfig();
  return { configured: Boolean(config?.apiKey), source: config?.source || 'none' };
}
