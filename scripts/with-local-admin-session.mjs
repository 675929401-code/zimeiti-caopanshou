import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SignJWT } from 'jose';
import { parse as parseDotenv } from 'dotenv';

// Local acceptance launcher. It mints a short-lived token in memory from the
// local runtime, never prints or writes it, then imports the requested script.
const projectRoot = process.cwd();
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const target = process.argv[2];
assert.ok(target && target.startsWith('scripts/') && !target.includes('..'), 'A workspace acceptance script is required');
process.argv.splice(2, 1);

const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
const supabase = new URL(runtime.supabaseUrl);
assert.equal(supabase.origin, 'http://127.0.0.1:54321');
const localEnvironment = parseDotenv(await fs.readFile(path.join(projectRoot, '.env.local'), 'utf8'));
// Keep every script launched by this local acceptance wrapper on the same
// verified loopback data source as the preview it is inspecting. This prevents
// a read-only verifier from silently mixing local UI state with cloud catalog
// rows inherited from .env.local.
Object.assign(process.env, {
  COZE_SUPABASE_URL: runtime.supabaseUrl,
  COZE_SUPABASE_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
  COZE_SUPABASE_ANON_KEY: runtime.anonKey,
  JWT_SECRET: runtime.jwtSecret,
  DATABASE_URL: runtime.databaseUrl,
  SHARED_CONFIGURATION_ENABLED: '1',
  SHARED_CONFIGURATION_SUPABASE_URL: runtime.supabaseUrl,
  SHARED_CONFIGURATION_SERVICE_ROLE_KEY: runtime.serviceRoleKey,
  LOCAL_ACCEPTANCE_PREVIEW: 'true',
});
const originArgument = process.argv.find(argument => argument.startsWith('--origin='));
const origin = String(originArgument?.slice('--origin='.length) || process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
assert.ok(['http://127.0.0.1:5000', 'http://127.0.0.1:5002', 'http://127.0.0.1:5010'].includes(origin), 'Local acceptance origin is required');

const serviceHeaders = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
const superAdminProfiles = new URL('/rest/v1/admin_access_profiles', supabase);
superAdminProfiles.searchParams.set('select', 'user_id');
superAdminProfiles.searchParams.set('admin_level', 'eq.super_admin');
superAdminProfiles.searchParams.set('is_active', 'eq.true');
superAdminProfiles.searchParams.set('limit', '20');
const profilesResponse = await fetch(superAdminProfiles, {
  headers: serviceHeaders,
  signal: AbortSignal.timeout(10_000),
});
const profiles = await profilesResponse.json();
const superAdminIds = profilesResponse.ok && Array.isArray(profiles)
  ? profiles.map(profile => String(profile?.user_id || '').trim()).filter(Boolean)
  : [];

const users = new URL('/rest/v1/users', supabase);
users.searchParams.set('select', 'id,username,display_name,role,session_id,status,is_active');
users.searchParams.set('role', 'eq.admin');
users.searchParams.set('is_active', 'eq.true');
users.searchParams.set('session_id', 'not.is.null');
users.searchParams.set('status', 'not.eq.blocked');
if (superAdminIds.length > 0) users.searchParams.set('id', `in.(${superAdminIds.join(',')})`);
users.searchParams.set('limit', '1');
const response = await fetch(users, {
  headers: serviceHeaders,
  signal: AbortSignal.timeout(10_000),
});
const rows = await response.json();
assert.ok(response.ok && Array.isArray(rows) && rows.length === 1, 'One active local administrator is required');
const actor = rows[0];
assert.equal(actor.is_active, true, 'The local administrator must be active');
assert.notEqual(actor.status, 'blocked', 'The local administrator must not be blocked');
assert.ok(typeof actor.session_id === 'string' && actor.session_id.trim(), 'The local administrator session is unavailable');
const readOnlyIdentity = {
  user: {
    id: String(actor.id),
    username: String(actor.username || ''),
    displayName: String(actor.display_name || actor.username || ''),
    display_name: String(actor.display_name || actor.username || ''),
    role: 'admin',
    sessionId: String(actor.session_id),
    session_id: String(actor.session_id),
  },
};
const secrets = [...new Set([process.env.JWT_SECRET, runtime.jwtSecret, localEnvironment.JWT_SECRET]
  .map(value => String(value || '').trim()).filter(value => value.length >= 16))];
assert.ok(secrets.length > 0, 'Local JWT secret is unavailable');

// Existing previews may have been started before the isolated runtime was
// activated. Select the key through the protected history read endpoint. Do
// not probe /api/auth/me here: its GET handler may reconcile local account
// state, which would invalidate a business-read-only acceptance run.
let verifiedToken = '';
for (const secret of secrets) {
  const candidate = await new SignJWT({
    userId: actor.id,
    username: actor.username,
    role: 'admin',
    displayName: actor.display_name || actor.username,
    sessionId: actor.session_id,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(secret));
  const identity = await fetch(`${origin}/api/media-history?limit=1&offset=0&category=all&kind=all&q=&includeTotal=true`, {
    headers: { Authorization: `Bearer ${candidate}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (identity.ok) {
    verifiedToken = candidate;
    break;
  }
}
assert.ok(verifiedToken, 'Local preview administrator session could not be verified');
process.env.LOCAL_NAV_ADMIN_TOKEN = verifiedToken;
process.env.LOCAL_NAV_ORIGIN = origin;
process.env.READONLY_UI_EXPECTED_USERNAME ||= String(actor.username || "");
process.env.LOCAL_NAV_READONLY_IDENTITY = JSON.stringify(readOnlyIdentity);

try {
  const targetModule = await import(pathToFileURL(path.resolve(projectRoot, target)).href);
  if (typeof targetModule.main === 'function') {
    await targetModule.main(process.argv.slice(2));
  }
} finally {
  delete process.env.LOCAL_NAV_ADMIN_TOKEN;
  delete process.env.LOCAL_NAV_ORIGIN;
  delete process.env.READONLY_UI_EXPECTED_USERNAME;
  delete process.env.LOCAL_NAV_READONLY_IDENTITY;
}
