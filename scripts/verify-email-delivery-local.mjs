import assert from 'node:assert/strict';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');
assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json();
assert.equal(identityResponse.status, 200, 'administrator identity probe failed');
const email = String(identity?.user?.email || '').trim();
assert.match(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/u, 'administrator email is unavailable');

const response = await fetch(`${origin}/api/auth/send-email-code`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email }),
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json();
const report = {
  ok: response.ok && body?.success === true,
  route: '/api/auth/send-email-code',
  status: response.status,
  recipientDomain: email.slice(email.lastIndexOf('@') + 1),
  platformAccepted: body?.success === true,
  verificationCodePrinted: 0,
  secretValuesPrinted: 0,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
