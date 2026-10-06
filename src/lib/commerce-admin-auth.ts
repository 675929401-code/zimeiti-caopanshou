import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getTokenFromHeaders, type JWTPayload } from '@/lib/auth';
import { authorizeAdminToken } from '@/lib/admin-auth';
import { sameOrigin } from '@/commerce/server/auth';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';

export type CommerceAdminAuthorization = { actor: JWTPayload } | { response: NextResponse };

export interface CommerceAdminAuthorizationOptions {
  mutation?: boolean;
  requiredPermissions?: readonly string[];
  stepUpPermissions?: readonly string[];
  operation?: string;
}

/**
 * Commerce has several distinct administrative surfaces.  A valid admin JWT
 * identifies the actor, while every requested capability must still be
 * granted by the durable admin authority.  Route-level composite checks are
 * deliberate defense in depth because the central middleware can express one
 * primary capability only.
 */
export async function requireCommerceAdmin(
  request: NextRequest,
  optionsOrMutation: CommerceAdminAuthorizationOptions | boolean = {},
): Promise<CommerceAdminAuthorization> {
  const options = typeof optionsOrMutation === 'boolean'
    ? { mutation: optionsOrMutation }
    : optionsOrMutation;
  if (options.mutation) {
    try { sameOrigin(request); } catch { return { response: NextResponse.json({ ok: false, code: 'ORIGIN_REJECTED', error: '请求来源无效' }, { status: 403 }) }; }
  }
  const requiredPermissions = [...new Set(options.requiredPermissions || [])];
  const stepUpPermissions = new Set(options.stepUpPermissions || []);
  let actor: JWTPayload | null = null;
  for (const permissionKey of requiredPermissions) {
    const authorization = await authorizeAdminCapability(request, permissionKey, {
      requireStepUp: stepUpPermissions.has(permissionKey),
      operation: options.operation || 'commerce_admin',
    });
    if (!authorization.ok) return { response: authorization.response };
    actor ||= authorization.actor;
  }
  if (actor) return { actor };
  const token = getTokenFromHeaders(request.headers);
  const result = await authorizeAdminToken(token);
  if (!result.ok) return { response: NextResponse.json({ ok: false, code: result.code, error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } }) };
  return { actor: result.actor };
}
