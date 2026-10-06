import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAdminTokenAuthorizer, type CurrentAdminUser } from '../src/lib/admin-auth';

async function main() {
type FixtureRole = 'admin' | 'student';
const users: Record<string, CurrentAdminUser> = {
  admin: { id: 'admin', username: 'admin', email: null, role: 'admin', status: 'active', is_active: true, display_name: '管理员', member_status: 'active', credits: 0, cash_balance: 0, allowed_categories: null, session_id: 'session-admin' },
  ordinary: { id: 'ordinary', username: 'ordinary', email: null, role: 'student', status: 'active', is_active: true, display_name: '普通用户', member_status: 'active', credits: 0, cash_balance: 0, allowed_categories: null, session_id: 'session-ordinary' },
  disabled: { id: 'disabled', username: 'disabled', email: null, role: 'admin', status: 'disabled', is_active: false, display_name: '停用管理员', member_status: 'active', credits: 0, cash_balance: 0, allowed_categories: null, session_id: 'session-disabled' },
};

let signatureReads = 0;
let currentUserReads = 0;
const authorize = createAdminTokenAuthorizer({
  async verifySignature(token) {
    signatureReads += 1;
    if (token === 'invalid') return null;
    const id = token.replace(/^token:/u, '');
    return { userId: id, username: id, displayName: id, role: (id === 'ordinary' ? 'admin' : 'student') as FixtureRole, sessionId: `session-${id}` };
  },
  async findCurrentUser(userId) {
    currentUserReads += 1;
    if (userId === 'database-error') throw new Error('fixture database unavailable');
    return users[userId] || null;
  },
});

const anonymous = await authorize(null);
assert.deepEqual(anonymous, { ok: false, status: 401, code: 'AUTH_REQUIRED', error: '请先登录' });
assert.equal(signatureReads, 0);
assert.equal(currentUserReads, 0);

const invalid = await authorize('invalid');
assert.equal(invalid.ok, false);
assert.equal(invalid.ok ? 0 : invalid.status, 401);
assert.equal(currentUserReads, 0);

const ordinary = await authorize('token:ordinary');
assert.equal(ordinary.ok, false);
assert.equal(ordinary.ok ? 0 : ordinary.status, 403);
assert.equal(ordinary.ok ? '' : ordinary.code, 'ADMIN_REQUIRED');

const disabled = await authorize('token:disabled');
assert.equal(disabled.ok, false);
assert.equal(disabled.ok ? 0 : disabled.status, 403);
assert.equal(disabled.ok ? '' : disabled.code, 'ACCOUNT_DISABLED');

const unavailable = await authorize('token:database-error');
assert.equal(unavailable.ok, false);
assert.equal(unavailable.ok ? 0 : unavailable.status, 503);
assert.equal(unavailable.ok ? '' : unavailable.code, 'ADMIN_AUTH_UNAVAILABLE');

const admin = await authorize('token:admin');
assert.equal(admin.ok, true);
assert.equal(admin.ok ? admin.actor.role : '', 'admin');

const read = (relative: string) => fs.readFileSync(path.resolve(relative), 'utf8');
const settingsPage = read('src/app/commerce/settings/page.tsx');
const authorizationPosition = settingsPage.indexOf('authorizeAdminToken(');
const rejectionPosition = settingsPage.indexOf('if(!authorization.ok)notFound()');
const redirectPosition = settingsPage.indexOf("redirect('/admin?tab=commerce')");
assert.ok(settingsPage.includes("import { headers } from 'next/headers'"));
assert.ok(settingsPage.includes('getTokenFromHeaders(new Headers(await headers()))'));
assert.ok(authorizationPosition >= 0 && rejectionPosition > authorizationPosition && redirectPosition > rejectionPosition);

const adminPage = read('src/app/admin/page.tsx');
assert.match(adminPage, /type Tab = [^\n]*"workspace-models"/u);
assert.match(adminPage, /const WORKSPACE_PROJECT_IDS:[\s\S]*"commerce"/u);
assert.match(adminPage, /projects\.push\("commerce"\)/u);
assert.match(adminPage, /CommerceAgentAdminTab/u);
assert.match(adminPage, /searchParams\.get\("tab"\)/u);

const adminApiRoot = path.resolve('src/app/api/admin/commerce');
const adminRoutes: string[] = [];
function collect(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name === 'route.ts') adminRoutes.push(full);
  }
}
collect(adminApiRoot);
assert.equal(adminRoutes.length, 10);
for (const route of adminRoutes) {
  const source = fs.readFileSync(route, 'utf8');
  assert.match(source, /requireCommerceAdmin\(request/u, `${path.relative(process.cwd(), route)} must authorize before business access`);
  if (/export async function POST/u.test(source)) {
    const mutationGuard=/requireCommerceAdmin\(request,true\)/u.test(source)
      || /requireCommerceAdmin\(request,\{[\s\S]*?mutation:\s*true/u.test(source)
      || /context\(request,true\)/u.test(source)&&/requireCommerceAdmin\(request,\{mutation,/u.test(source);
    assert.equal(mutationGuard, true, `${path.relative(process.cwd(), route)} mutations must enforce origin and current admin`);
  }
}

const retiredApi = read('src/app/api/commerce/admin/route.ts');
assert.match(retiredApi, /COMMERCE_ADMIN_MOVED/u);
assert.match(retiredApi, /status:410/u);

const modelsRoute = read('src/app/api/commerce/models/route.ts');
assert.match(modelsRoute, /\['agent','image','video'\]\.includes\(kind\)/u);
assert.match(modelsRoute, /filterModelsByVisibility\(kind,values\)/u);
for (const privateField of ['costPrice', 'billingUnit', 'configHash', 'verifiedAt', 'endpoint', 'protocol', 'modelName', 'internalModelId', 'provider', 'enabled', 'secret']) {
  assert.ok(modelsRoute.includes(`${privateField}:`), `public model catalog must strip ${privateField}`);
}

const operationsRoute = read('src/app/api/commerce/operations/route.ts');
assert.match(operationsRoute, /\{modelId:_,promptId:__,fallbackModelIds:___,capabilityRequirements:____,/u);

const jobsSource = read('src/commerce/server/jobs.ts');
assert.match(jobsSource, /const \{compiledPrompt:_,providerUrl:__,owner:___,pollPath:____,/u);
assert.match(jobsSource, /model\.kind==='video'\?\{id:model\.id\}:\{\}/u);

const ordinaryUiFiles = [
  'src/commerce/components/commerce-agent/workspace.tsx',
  'src/commerce/components/commerce-agent/agent-execution.tsx',
  'src/commerce/components/commerce-agent/canvas-live.tsx',
  'src/commerce/components/commerce-agent/detail-set-studio.tsx',
  'src/commerce/components/commerce-agent/prompt-assist-flow.tsx',
];
const ordinaryUi = ordinaryUiFiles.map(read).join('\n');
assert.doesNotMatch(ordinaryUi, /后台创作能力|后台配置的智能创作能力|后台默认/u);
assert.doesNotMatch(ordinaryUi, /previewStep\?\.modelLabel|model\?\.displayName\|\|'默认'/u);
assert.doesNotMatch(ordinaryUi, /\/commerce\/settings/u);
const workspace = read('src/commerce/components/commerce-agent/workspace.tsx');
assert.match(workspace, /video:videoModelCatalogUrl\(/u);
assert.match(workspace, /image:`\/api\/commerce\/models\?kind=image/u);
assert.match(workspace, /agent:'\/api\/commerce\/models\?kind=agent/u);

console.log(JSON.stringify({
  passed: 58,
  adminRoutes: adminRoutes.length,
  identities: { anonymous: 401, invalid: 401, ordinary: 403, disabledAdmin: 403, authUnavailable: 503, currentAdmin: 200 },
  settings: { unauthorized: 'server-not-found', currentAdmin: '/admin?tab=commerce' },
  ordinaryUi: { internalModelDetailsVisible: false, selectableCatalogKinds: ['agent', 'image', 'video'] },
  networkCalls: 0,
  paidCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
}));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
