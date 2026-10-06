import assert from 'node:assert/strict';

function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at < 1) return email ? '***' : '';
  return `${email.slice(0, Math.min(3, at))}***${email.slice(at)}`;
}

function maskPhone(value) {
  const phone = String(value || '').trim();
  return phone.length >= 7 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone ? '***' : '';
}

export async function main() {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || '').replace(/\/$/u, '');
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
  assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u);
  assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN_REQUIRED');

  const response = await fetch(`${origin}/api/admin/users?page_size=500`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, payload?.error || 'MEMBER_LIST_FAILED');
  assert.ok(Array.isArray(payload.users));

  const summarized = payload.users.map((user) => ({
    id: String(user.id || ''),
    name: String(user.name || ''),
    email: maskEmail(user.email),
    phone: maskPhone(user.phone),
    role: String(user.role || ''),
    accountKind: String(user.accountKind || 'normal'),
    reasons: Array.isArray(user.accountFlagReasons) ? user.accountFlagReasons : [],
    credits: Number(user.credits || 0),
    cashBalance: Number(user.cashBalance || 0),
    totalRecharge: Number(user.totalRecharge || 0),
    totalConsume: Number(user.totalConsume || 0),
    memberStatus: String(user.memberStatus || ''),
    lastActive: String(user.lastActive || ''),
  }));
  const fixtureCandidates = summarized.filter((user) => user.role !== 'admin' && user.accountKind === 'fixture');
  const suspiciousOnly = summarized.filter((user) => user.role !== 'admin' && user.accountKind === 'suspicious');
  const protectedAccounts = summarized.filter((user) => user.role === 'admin' || user.accountKind === 'normal');

  console.log(JSON.stringify({
    mode: 'read-only',
    total: summarized.length,
    fixtureCandidateCount: fixtureCandidates.length,
    suspiciousOnlyCount: suspiciousOnly.length,
    protectedCount: protectedAccounts.length,
    fixtureCandidates,
    suspiciousOnly,
    writes: 0,
  }, null, 2));
}

