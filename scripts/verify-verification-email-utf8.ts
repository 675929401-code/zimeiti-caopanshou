#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { buildVerificationEmail } from '@/lib/verification-email-template';

const evidenceDir = path.resolve('.codex-evidence/verification-email-template');
async function main() {
  const content = buildVerificationEmail('智能体操盘手', '482913', '更换安全手机');

  assert.equal(content.subject, '【智能体操盘手】更换安全手机验证码');
  assert.match(content.text, /智能体操盘手 · 更换安全手机/u);
  assert.match(content.text, /482913/u);
  assert.match(content.html, /<meta charset="UTF-8">/u);
  assert.match(content.html, /lang="zh-CN"/u);
  assert.match(content.html, /5 分钟内有效/u);
  assert.match(content.html, /平台工作人员不会/u);

  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
  const serialized = await transport.sendMail({
  from: { name: '智能体操盘手', address: 'service@example.test' },
  to: 'reader@example.test',
  subject: content.subject,
  text: content.text,
  html: content.html,
  textEncoding: 'base64',
  headers: { 'Content-Language': 'zh-CN' },
  });
  const raw = Buffer.isBuffer(serialized.message)
    ? serialized.message.toString('utf8')
    : String(serialized.message || '');

  assert.match(raw, /Subject: =\?UTF-8\?B\?/iu, '邮件主题必须使用UTF-8编码字');
  assert.match(raw, /From: =\?UTF-8\?B\?/iu, '中文发件人名必须使用UTF-8编码字');
  assert.ok((raw.match(/charset=utf-8/giu) || []).length >= 2, '纯文本和HTML都必须声明UTF-8');
  assert.ok((raw.match(/Content-Transfer-Encoding: base64/giu) || []).length >= 2, '纯文本和HTML都必须使用稳定传输编码');

  const decodedParts = Array.from(raw.matchAll(/Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)(?=\r?\n--)/gu))
    .map(match => Buffer.from(match[1].replace(/\s+/gu, ''), 'base64').toString('utf8'));
  assert.ok(decodedParts.some(part => part.includes('您的验证码：482913')), '纯文本MIME正文必须可还原中文');
  assert.ok(decodedParts.some(part => part.includes('请完成本次安全验证')), 'HTML MIME正文必须可还原中文');
  assert.ok(decodedParts.every(part => !/[�]|(?:Ã|Â|â|ï¼)/u.test(part)), '解码后的邮件正文不能包含乱码特征');

  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'preview.html'), content.html, 'utf8');
  await fs.writeFile(path.join(evidenceDir, 'message.eml'), raw, 'utf8');
  await fs.writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify({
    passed: true,
    checkedAt: new Date().toISOString(),
    subjectUtf8Encoded: true,
    fromUtf8Encoded: true,
    utf8MimeParts: decodedParts.length,
    plainTextRecovered: decodedParts.some(part => part.includes('您的验证码：482913')),
    htmlRecovered: decodedParts.some(part => part.includes('请完成本次安全验证')),
    externalMessagesSent: 0,
  }, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ passed: true, decodedParts: decodedParts.length, externalMessagesSent: 0 }, null, 2));
}

void main();
