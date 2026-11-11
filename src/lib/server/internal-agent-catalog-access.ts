import 'server-only';

import { getTokenFromHeaders } from '@/lib/auth';
import { authorizeAdminToken } from '@/lib/admin-auth';
import { readAdminAccessSnapshot } from '@/lib/server/admin-governance-authority';

async function isCurrentInternalAgentOwner(request: Request): Promise<boolean> {
  try {
    // Check the current database role, active account and live session. A JWT
    // role, a browser override or the legacy admin fallback is not owner proof.
    const principal = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!principal.ok) return false;
    const access = await readAdminAccessSnapshot(principal.actor.userId);
    return access.authorityStatus === 'ready'
      && access.integrityValid
      && access.profileActive
      && access.adminLevel === 'super_admin'
      && access.revision > 0
      && Boolean(access.checksum)
      && access.checksum !== 'legacy-schema-absent'
      && access.permissionKeys.includes('agents.view')
      && access.permissionKeys.includes('internal_tools.manage');
  } catch {
    return false;
  }
}

/** Only the owner's two front-end DTO reads use this bounded read policy. */
export async function canReadOwnerInternalAgentCatalog(request: Request): Promise<boolean> {
  if (request.method !== 'GET'
    || !['/api/bots', '/api/categories'].includes(new URL(request.url).pathname)) return false;
  return isCurrentInternalAgentOwner(request);
}

/**
 * The owner may favorite the same internal agents the owner catalog exposes to them.
 * This is a favorites-only eligibility check: it grants no navigation, dispatch,
 * billing or administrative mutation rights.
 */
export async function canFavoriteOwnerInternalAgents(request: Request): Promise<boolean> {
  if (request.method !== 'POST'
    || new URL(request.url).pathname !== '/api/agent-favorites') return false;
  return isCurrentInternalAgentOwner(request);
}

/**
 * Only the owner may dispatch a server-classified self-use or hidden Agent. This check
 * grants no navigation, model or billing exemption; the route continues its
 * existing admission policy. Administrative mutations still require step-up.
 */
export async function canUseOwnerInternalAgent(request: Request): Promise<boolean> {
  if (request.method !== 'POST'
    || !['/api/llm', '/api/chat'].includes(new URL(request.url).pathname)) return false;
  return isCurrentInternalAgentOwner(request);
}

type DispatchRow = Record<string, unknown>;
type DispatchRead = { data: DispatchRow | null; error?: unknown };

/** Keep large prompt payloads cached, but never take dispatch authorization from a cache or a different database. */
export async function readCurrentAgentForDispatch(
  cached: DispatchRow | null,
  readAccess: () => PromiseLike<DispatchRead>,
  readFull: () => PromiseLike<DispatchRead>,
): Promise<DispatchRead> {
  if (!cached || !Number.isSafeInteger(Number(cached.config_revision)) || Number(cached.config_revision) < 1) return readFull();
  const current = await readAccess();
  if (current.error || !current.data || current.data.deleted_at != null) return current;
  if (current.data.id !== cached.id || current.data.config_revision !== cached.config_revision) return readFull();
  return { data: { ...cached, ...current.data } };
}
