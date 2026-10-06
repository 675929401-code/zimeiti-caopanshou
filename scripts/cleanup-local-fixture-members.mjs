import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeStamp() {
  return new Date().toISOString().replaceAll(/[-:.]/gu, '');
}

async function readMembers(origin, token) {
  const response = await fetch(`${origin}/api/admin/users?page_size=500`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, body?.error || 'MEMBER_LIST_FAILED');
  assert.ok(Array.isArray(body.users));
  return body.users;
}

export async function main(args = []) {
  const apply = args.includes('--apply');
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
  const deletionVerification = String(process.env.LOCAL_ADMIN_USER_DELETE_REAUTH || '');
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, 'LOCAL_ORIGIN_REQUIRED');
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');
  if (apply) assert.ok(deletionVerification, 'LOCAL_ADMIN_USER_DELETE_REAUTH_REQUIRED_FOR_APPLY');

  const users = await readMembers(origin, token);
  const candidates = users.filter((user) =>
    user.role !== 'admin'
    && user.accountKind === 'fixture'
    && user.accountFlags?.isFixture === true,
  );
  assert.ok(candidates.every((user) => user.role !== 'admin'), 'ADMIN_DELETE_FORBIDDEN');

  const evidenceDir = path.resolve('.codex-evidence/r277-member-cleanup');
  await fs.mkdir(evidenceDir, { recursive: true });
  const runId = safeStamp();
  const before = candidates.map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    email: user.email || '',
    phone: user.phone || '',
    reasons: user.accountFlagReasons || [],
    credits: Number(user.credits || 0),
    cashBalance: Number(user.cashBalance || 0),
    totalRecharge: Number(user.totalRecharge || 0),
    totalConsume: Number(user.totalConsume || 0),
  }));
  await fs.writeFile(path.join(evidenceDir, `${runId}-before.json`), JSON.stringify({ origin, apply, candidates: before }, null, 2) + '\n');

  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', candidateCount: candidates.length, evidenceDir, writes: 0 }, null, 2));
    return;
  }

  const results = [];
  for (const user of candidates) {
    const response = await fetch(`${origin}/api/admin/users?id=${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-admin-user-delete-reauth': deletionVerification,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    results.push({ id: user.id, name: user.name, status: response.status, deleted: response.ok && body.success === true, error: response.ok ? '' : String(body.error || 'DELETE_FAILED') });
  }

  const remainingUsers = await readMembers(origin, token);
  const remainingFixtures = remainingUsers.filter((user) => user.role !== 'admin' && user.accountKind === 'fixture');
  const report = {
    mode: 'apply',
    attempted: candidates.length,
    deleted: results.filter((result) => result.deleted).length,
    failed: results.filter((result) => !result.deleted),
    remainingFixtureCount: remainingFixtures.length,
    protectedAccountCount: remainingUsers.length - remainingFixtures.length,
  };
  await fs.writeFile(path.join(evidenceDir, `${runId}-result.json`), JSON.stringify({ ...report, results }, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidenceDir }, null, 2));
}
