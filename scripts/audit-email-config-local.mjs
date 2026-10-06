import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import addressparser from 'nodemailer/lib/addressparser/index.js';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '');

assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');

const response = await fetch(`${origin}/api/settings/admin`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json();
assert.equal(response.status, 200, `settings endpoint returned ${response.status}`);

const settings = body?.settings || {};
let localEnvironment = {};
try {
  localEnvironment = parseDotenv(await fs.readFile(path.join(process.cwd(), '.env.local'), 'utf8'));
} catch {}

const databaseComplete = Boolean(
  String(settings.email_smtp_host || '').trim()
  && String(settings.email_smtp_user || '').trim()
  && settings.email_smtp_pass_configured === true,
);
const readEnvironment = (key) => String(process.env[key] || localEnvironment[key] || '').trim();
const source = databaseComplete ? 'platform_settings-redacted-api' : 'environment-fallback';
const user = databaseComplete ? String(settings.email_smtp_user || '').trim() : readEnvironment('EMAIL_SMTP_USER');
const from = databaseComplete ? String(settings.email_from || '').trim() : readEnvironment('EMAIL_FROM');
const port = Number(databaseComplete ? settings.email_smtp_port || 465 : readEnvironment('EMAIL_SMTP_PORT') || 465);
const host = databaseComplete ? String(settings.email_smtp_host || '').trim() : readEnvironment('EMAIL_SMTP_HOST');
const passwordConfigured = databaseComplete
  ? settings.email_smtp_pass_configured === true
  : Boolean(readEnvironment('EMAIL_SMTP_PASS'));
const fromKind = !from
  ? 'platform-name-fallback'
  : /<[^<>]+@[^<>]+>/u.test(from)
    ? 'full-mailbox'
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(from)
      ? 'mailbox-only'
      : 'display-name';
const fromMailbox = String(from.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/u)?.[1]
  || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(from) ? from : '')).toLowerCase();
const parsedFrom = addressparser(from);

const report = {
  ok: Boolean(host && user && passwordConfigured && Number.isInteger(port) && port > 0 && port <= 65_535),
  source,
  host,
  port,
  secure: port === 465,
  userConfigured: Boolean(user),
  userDomain: user.includes('@') ? user.slice(user.lastIndexOf('@') + 1) : '',
  passwordConfigured,
  fromConfigured: Boolean(from),
  fromKind,
  fromMailboxMatchesUser: Boolean(fromMailbox) && fromMailbox === user.toLowerCase(),
  parsedMailboxCount: parsedFrom.length,
  parsedMailboxMatchesUser: parsedFrom.length === 1
    && String(parsedFrom[0]?.address || '').toLowerCase() === user.toLowerCase(),
  secretValuesRead: 0,
  emailSends: 0,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
