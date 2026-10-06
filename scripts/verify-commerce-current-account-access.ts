import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CommerceMainAccountAccessError,
  createCommerceMainAccountAccess,
  type CurrentCommerceMainAccount,
} from '../src/commerce/server/main-account-access';
import { requireIdentity } from '../src/commerce/server/auth';
import { errorResponse } from '../src/commerce/server/http';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('UNEXPECTED_NETWORK_CALL');
};

const fixedNow = new Date('2026-09-15T10:00:00.000Z');
const activeMember: CurrentCommerceMainAccount = {
  id: 'member-001',
  username: 'fixture-member',
  display_name: '普通会员',
  role: 'student',
  status: 'active',
  is_active: true,
  member_status: 'active',
  member_expires_at: '2026-09-16T10:00:00.000Z',
};

async function expectAccessError(operation: Promise<unknown>, code: string, status: number) {
  await assert.rejects(operation, (error) => {
    return error instanceof CommerceMainAccountAccessError
      && error.code === code
      && error.status === status;
  });
}

async function main() {
try {
  let account: CurrentCommerceMainAccount | null = activeMember;
  let accountReads = 0;
  const bindings = new Map<string, { mainUserId?: string; mainRole?: 'admin' | 'user'; exempt?: boolean }>([
    ['ordinary-owner', { mainUserId: activeMember.id, exempt: false }],
  ]);
  const access = createCommerceMainAccountAccess({
    async findCurrentAccount(mainUserId) {
      accountReads += 1;
      return account?.id === mainUserId ? account : null;
    },
    findBinding(owner) {
      return bindings.get(owner) || null;
    },
    now: () => fixedNow,
  });

  assert.throws(
    () => requireIdentity(new Request('http://127.0.0.1:5000/api/commerce/jobs')),
    /UNAUTHORIZED/u,
    'anonymous requests must fail before a database lookup',
  );

  const ordinary = await access.authorizeIdentity({
    id: 'ordinary-owner',
    mainUserId: activeMember.id,
    role: 'user',
  });
  assert.equal(ordinary.role, 'user');
  assert.equal(ordinary.memberStatus, 'active');

  account = { ...activeMember, member_expires_at: null };
  assert.equal((await access.authorizeMainAccount(activeMember.id)).memberStatus, 'active');

  account = { ...activeMember, member_status: 'inactive' };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_MEMBERSHIP_REQUIRED',
    403,
  );

  account = { ...activeMember, member_expires_at: fixedNow.toISOString() };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_MEMBERSHIP_REQUIRED',
    403,
  );

  account = { ...activeMember, member_expires_at: 'not-a-date' };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_MEMBERSHIP_REQUIRED',
    403,
  );

  account = { ...activeMember, is_active: false };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_ACCOUNT_DISABLED',
    403,
  );

  account = { ...activeMember, status: 'suspended' };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_ACCOUNT_DISABLED',
    403,
  );

  account = {
    ...activeMember,
    id: 'admin-001',
    username: 'fixture-admin',
    role: 'admin',
    member_status: 'inactive',
    member_expires_at: '2020-01-01T00:00:00.000Z',
  };
  bindings.set('admin-owner', { mainUserId: account.id, mainRole: 'admin', exempt: false });
  const admin = await access.authorizeIdentity({
    id: 'admin-owner',
    mainUserId: account.id,
    role: 'user',
  });
  assert.equal(admin.role, 'admin');
  assert.equal(admin.memberStatus, 'admin');

  account = { ...activeMember, id: 'admin-001' };
  await expectAccessError(
    access.authorizeIdentity({ id: 'admin-owner', mainUserId: 'admin-001', role: 'user' }),
    'COMMERCE_ACCOUNT_ROLE_CHANGED',
    403,
  );

  account = { ...activeMember, id: 'member-001', role: 'admin' };
  await expectAccessError(
    access.authorizeIdentity({ id: 'ordinary-owner', mainUserId: activeMember.id, role: 'user' }),
    'COMMERCE_ACCOUNT_ROLE_CHANGED',
    403,
  );

  await expectAccessError(
    access.authorizeIdentity({ id: 'unbound-owner', mainUserId: 'missing-user', role: 'user' }),
    'COMMERCE_MAIN_BINDING_REQUIRED',
    403,
  );

  account = {
    ...activeMember,
    id: 'admin-002',
    username: 'fixture-admin-two',
    role: 'admin',
    member_status: 'inactive',
  };
  bindings.set('admin-owner', { mainUserId: account.id, mainRole: 'admin', exempt: false });
  const readsBeforeStaleSession = accountReads;
  await expectAccessError(
    access.authorizeIdentity({ id: 'admin-owner', mainUserId: 'admin-001', role: 'user' }),
    'COMMERCE_SESSION_BINDING_CHANGED',
    403,
  );
  assert.equal(
    accountReads,
    readsBeforeStaleSession,
    'a stale shared-owner session must fail before reading or charging the newly bound account',
  );
  const replacementAdmin = await access.authorizeIdentity({
    id: 'admin-owner',
    mainUserId: 'admin-002',
    role: 'user',
  });
  assert.equal(replacementAdmin.mainUserId, 'admin-002');

  account = null;
  await expectAccessError(
    access.authorizeMainAccount('missing-user'),
    'COMMERCE_ACCOUNT_NOT_FOUND',
    401,
  );

  const unavailable = createCommerceMainAccountAccess({
    async findCurrentAccount() {
      throw new Error('fixture database unavailable');
    },
    findBinding() {
      return { mainUserId: activeMember.id };
    },
    now: () => fixedNow,
  });
  await expectAccessError(
    unavailable.authorizeMainAccount(activeMember.id),
    'COMMERCE_ACCOUNT_ACCESS_UNAVAILABLE',
    503,
  );

  account = activeMember;
  const beforeRevalidation = accountReads;
  await access.authorizeMainAccount(activeMember.id);
  account = { ...activeMember, status: 'suspended' };
  await expectAccessError(
    access.authorizeMainAccount(activeMember.id),
    'COMMERCE_ACCOUNT_DISABLED',
    403,
  );
  assert.equal(accountReads, beforeRevalidation + 2, 'current access must not cache account authorization');

  const mapped = errorResponse(new CommerceMainAccountAccessError(
    403,
    'COMMERCE_MEMBERSHIP_REQUIRED',
    '需要有效会员才能使用带货 Agent',
  ));
  assert.equal(mapped.status, 403);
  assert.deepEqual(await mapped.json(), {
    error: '需要有效会员才能使用带货 Agent',
    code: 'COMMERCE_MEMBERSHIP_REQUIRED',
  });

  const sessionSource = fs.readFileSync('src/app/api/commerce/session/route.ts', 'utf8');
  const authSource = fs.readFileSync('src/commerce/server/auth.ts', 'utf8');
  const accountAccessSource = fs.readFileSync('src/commerce/server/main-account-access.ts', 'utf8');
  const quotesSource = fs.readFileSync('src/app/api/commerce/quotes/route.ts', 'utf8');
  const jobsSource = fs.readFileSync('src/app/api/commerce/jobs/route.ts', 'utf8');

  assert.match(sessionSource, /await authorizeCurrentCommerceIdentity\(user\)/u);
  assert.match(
    sessionSource,
    /authorizeCommerceMainAccount\(mainPayload\.userId\)[\s\S]*ensureSessionForMainUser\(\{[\s\S]*role: current\.role/u,
    'the GET bridge must revalidate the main account before creating its isolated product owner',
  );
  assert.match(
    sessionSource,
    /authorizeCommerceMainAccount\(payload\.userId\)[\s\S]*ensureSessionForMainUser\(\{[\s\S]*role: current\.role/u,
    'main-bind must use the current database role when creating an isolated product owner',
  );
  assert.match(authSource, /session\.role!=='user'/u, 'legacy admin Commerce cookies must be invalidated');
  assert.match(
    authSource,
    /createHash\('sha256'\)\.update\(mainUserId\)\.digest\('hex'\)\.slice\(0,40\)/u,
    'each main account must receive a deterministic isolated Commerce owner',
  );
  assert.match(authSource, /mainRole,exempt:false/u, 'main role must be audit-only and never grant free product use');
  assert.doesNotMatch(authSource, /get<[^\n]+local-operator/u, 'the shared local-operator must not be reused');
  assert.match(accountAccessSource, /identity\.role !== 'user'/u, 'Commerce product sessions must remain ordinary user sessions');
  assert.doesNotMatch(accountAccessSource, /identity\.role !== current\.role/u, 'main admin role must not become a Commerce admin role');
  assert.match(quotesSource, /await authorizeCurrentCommerceIdentity\(user\)[\s\S]*createCommerceQuote/u);
  assert.ok(
    jobsSource.indexOf("body.action === 'retry-save'") < jobsSource.indexOf('await authorizeCurrentCommerceIdentity(user)'),
    'original-result recovery must remain available without opening a new paid operation',
  );
  assert.ok(
    jobsSource.indexOf('await authorizeCurrentCommerceIdentity(user)') < jobsSource.indexOf('confirmCommerceQuote(user.id'),
    'job creation must revalidate membership immediately before quote confirmation',
  );

  console.log(JSON.stringify({
    passed: true,
    checks: [
      'anonymous request rejected',
      'active ordinary member accepted',
      'active membership without an expiry accepted',
      'inactive and expired membership rejected',
      'inactive and suspended accounts rejected',
      'current administrators use an ordinary isolated product identity while main role is revalidated',
      'legacy shared local-operator administrator bridge is retired',
      'demoted admin and promoted ordinary stale sessions rejected',
      'legacy admin binding evaluation remains pinned to its original main account',
      'a stale legacy shared-owner binding fails before the replacement account is read',
      'missing binding, missing account and database outage fail closed',
      'authorization is re-read without a process cache',
      'session creation, quote creation and paid job confirmation boundaries are wired',
      'recovery and reconciliation remain reachable for original tasks',
    ],
    networkCalls: 0,
    providerCalls: 0,
    walletCalls: 0,
    databaseWrites: 0,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
