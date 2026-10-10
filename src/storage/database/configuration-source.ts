/** Shared administrative configuration. User records and billing keep their own database. */
export const SHARED_CONFIGURATION_TABLES = [
  'agents',
  'llm_models',
  'categories',
  'prompt_versions',
  'agent_skills',
  'commerce_cards',
  'commerce_card_versions',
  'commerce_prompt_versions',
  'commerce_knowledge_documents',
  'commerce_operation_routes',
  'commerce_config_releases',
  'model_pool_config_releases',
  'workspace_model_config_releases',
  'commerce_model_acceptance_evidence',
  'commerce_card_acceptance_evidence',
] as const;

export function sharedConfigurationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SHARED_CONFIGURATION_ENABLED === '1';
}

function isExactLocalAcceptanceConfiguration(env: Record<string, string | undefined>): boolean {
  if (
    env.LOCAL_RUNTIME_PROFILE !== 'local-acceptance'
    || env.LOCAL_ACCEPTANCE_PREVIEW !== 'true'
    || env.SHARED_CONFIGURATION_ID !== 'local-acceptance'
  ) return false;
  try {
    const shared = new URL(env.SHARED_CONFIGURATION_SUPABASE_URL || '');
    const business = new URL(env.COZE_SUPABASE_URL || '');
    const database = new URL(env.DATABASE_URL || '');
    const exactLoopbackRestUrl = (parsed: URL) => parsed.origin === 'http://127.0.0.1:54321'
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && !parsed.username
      && !parsed.password;
    return exactLoopbackRestUrl(shared)
      && exactLoopbackRestUrl(business)
      && database.protocol === 'postgresql:'
      && database.hostname === '127.0.0.1'
      && database.port === '54322'
      && database.pathname === '/zimeiti_local';
  } catch {
    return false;
  }
}

function sharedConfigurationId(env: Record<string, string | undefined>, localAcceptance: boolean): string {
  if (localAcceptance) return 'local-acceptance';
  const id = String(env.SHARED_CONFIGURATION_ID || '').trim();
  if (!id) throw new Error('SHARED_CONFIGURATION_ID_MISSING');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) throw new Error('SHARED_CONFIGURATION_ID_INVALID');
  return id;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '0.0.0.0'
    || normalized === '::'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:0'
    || normalized === '0:0:0:0:0:0:0:1'
    || /^127(?:\.|$)/u.test(normalized)
    || /^::ffff:127(?:\.|$)/u.test(normalized)
    || /^::ffff:7f[0-9a-f]{2}(?::|$)/u.test(normalized);
}

export function sharedConfigurationConnection(env: Record<string, string | undefined> = process.env) {
  if (!sharedConfigurationEnabled(env)) return null;
  const url = env.SHARED_CONFIGURATION_SUPABASE_URL || '';
  const key = env.SHARED_CONFIGURATION_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SHARED_CONFIGURATION_CREDENTIALS_MISSING');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SHARED_CONFIGURATION_URL_INVALID');
  }
  const exactLocalAcceptance = isExactLocalAcceptanceConfiguration(env);
  sharedConfigurationId(env, exactLocalAcceptance);
  if (!exactLocalAcceptance && (!parsed.hostname || parsed.protocol !== 'https:' || parsed.username || parsed.password || isLoopbackHostname(parsed.hostname))) {
    throw new Error('SHARED_CONFIGURATION_REQUIRES_CLOUD_HTTPS');
  }
  return { url, key };
}

/** REST callers must use the same configuration source as the query client. */
export function restDatabaseConnection(table: string, env: Record<string, string | undefined> = process.env) {
  if ((SHARED_CONFIGURATION_TABLES as readonly string[]).includes(table)) {
    const shared = sharedConfigurationConnection(env);
    if (shared) return shared;
  }
  return {
    url: env.COZE_SUPABASE_URL || '',
    key: env.COZE_SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

export function routeConfigurationTables<T extends object>(business: T, configuration: T): T {
  const tables = new Set<string>(SHARED_CONFIGURATION_TABLES);
  return new Proxy(business, {
    get(target, property) {
      if (property === 'from') return (table: string) => {
        const client = (tables.has(table) ? configuration : business) as T & { from(name: string): unknown };
        return client.from(table);
      };
      if (property === 'storage') {
        const localStorage = Reflect.get(target, property, target) as { from(bucket: string): unknown } | undefined;
        const cloudStorage = Reflect.get(configuration, property, configuration) as { from(bucket: string): unknown } | undefined;
        if (!localStorage || !cloudStorage) return localStorage;
        return new Proxy(localStorage, {
          get(storage, key) {
            if (key === 'from') return (bucket: string) => (bucket === 'avatars' ? cloudStorage : localStorage).from(bucket);
            const value = Reflect.get(storage, key, storage);
            return typeof value === 'function' ? value.bind(storage) : value;
          },
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function configurationSourceStatus(env: Record<string, string | undefined> = process.env) {
  const businessIsLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(env.COZE_SUPABASE_URL || '');
  const sharedEnabled = sharedConfigurationEnabled(env);
  const localAcceptance = sharedEnabled && isExactLocalAcceptanceConfiguration(env);
  if (sharedEnabled) sharedConfigurationConnection(env);
  return {
    configuration: localAcceptance ? 'local-acceptance' : sharedEnabled ? 'shared-cloud' : businessIsLocal ? 'local' : 'cloud',
    businessData: businessIsLocal ? 'local' : 'cloud',
    sharedTables: sharedEnabled ? [...SHARED_CONFIGURATION_TABLES] : [],
    automaticCodeDeployment: false,
  };
}
