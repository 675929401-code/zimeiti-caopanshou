import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import nodemailer from 'nodemailer';

const values = parseDotenv(await fs.readFile(path.join(process.cwd(), '.env.local'), 'utf8'));
const host = String(process.env.EMAIL_SMTP_HOST || values.EMAIL_SMTP_HOST || '').trim();
const port = Number(process.env.EMAIL_SMTP_PORT || values.EMAIL_SMTP_PORT || 465);
const user = String(process.env.EMAIL_SMTP_USER || values.EMAIL_SMTP_USER || '').trim();
const pass = String(process.env.EMAIL_SMTP_PASS || values.EMAIL_SMTP_PASS || '').trim();

assert.ok(host && user && pass, 'SMTP environment fallback is incomplete');

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: { user, pass },
  connectionTimeout: 12_000,
  greetingTimeout: 12_000,
  socketTimeout: 15_000,
});

try {
  await transport.verify();
  console.log(JSON.stringify({
    ok: true,
    host,
    port,
    secure: port === 465,
    userDomain: user.includes('@') ? user.slice(user.lastIndexOf('@') + 1) : '',
    authenticated: true,
    emailSends: 0,
    secretValuesPrinted: 0,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    host,
    port,
    secure: port === 465,
    authenticated: false,
    code: String(error?.code || 'SMTP_VERIFY_FAILED'),
    command: String(error?.command || ''),
    responseCode: Number(error?.responseCode || 0) || null,
    emailSends: 0,
    secretValuesPrinted: 0,
  }, null, 2));
  process.exitCode = 1;
} finally {
  transport.close();
}
