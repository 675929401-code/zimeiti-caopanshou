import nodemailer from 'nodemailer';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { readPublishedPlatformBranding } from '@/lib/server/brand-authority';
import { normalizeDisplayText } from '@/lib/display-normalization';
import { buildVerificationEmail, type VerificationEmailPurpose } from '@/lib/verification-email-template';

// 邮件发送器缓存
let transporter: nodemailer.Transporter | null = null;
let cachedConfigHash = ''; // 配置变化时重建 transporter

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  from: { name: string; address: string };
}

export function buildEmailSender(emailFrom: string | undefined, user: string, fallbackName: string) {
  const normalized = String(emailFrom || '').replace(/[\r\n]+/gu, ' ').trim();
  const configuredName = normalized.includes('<')
    ? normalized.slice(0, normalized.lastIndexOf('<')).trim()
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
      ? ''
      : normalized;
  const name = normalizeDisplayText(configuredName.replace(/^["']+|["']+$/gu, '').trim(), fallbackName).slice(0, 128);
  return { name, address: user.trim() };
}

function emailLogLabel(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : 'invalid-email';
}

// 数据库配置缓存（5分钟）
let dbConfigCache: EmailConfig | null = null;
let dbConfigCacheTime = 0;
const DB_CONFIG_CACHE_TTL = 5 * 60 * 1000;

async function getPlatformName(): Promise<string> {
  try {
    return normalizeDisplayText((await readPublishedPlatformBranding()).brand.name, '');
  } catch (error) {
    console.warn('[Email] Published platform brand unavailable:', error instanceof Error ? error.message : error);
  }
  return '';
}

/** 从 platform_settings 表读取 SMTP 配置，回退到环境变量 */
async function getEmailConfigFromDB(): Promise<EmailConfig | null> {
  const now = Date.now();
  if (dbConfigCache && now - dbConfigCacheTime < DB_CONFIG_CACHE_TTL) {
    return dbConfigCache;
  }

  try {
    const client = getSupabaseClient();
    const { data } = await client
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', ['email_smtp_host', 'email_smtp_port', 'email_smtp_user', 'email_smtp_pass', 'email_from']);

    if (data && data.length >= 4) {
      const get = (key: string) => data.find((r: { setting_key: string; setting_value: string }) => r.setting_key === key)?.setting_value || '';
      const host = get('email_smtp_host');
      const port = get('email_smtp_port') || '465';
      const user = get('email_smtp_user');
      const pass = get('email_smtp_pass');
      const emailFrom = get('email_from');
      // Keep only the explicit sender label in the cached SMTP configuration.
      // The live published brand is added when each message is sent.
      const from = buildEmailSender(emailFrom, user, '');

      if (host && user && pass) {
        const config: EmailConfig = {
          host,
          port: parseInt(port, 10),
          secure: parseInt(port, 10) === 465,
          auth: { user, pass },
          from,
        };
        dbConfigCache = config;
        dbConfigCacheTime = now;
        return config;
      }
    }
  } catch (err) {
    console.warn('[Email] Failed to read SMTP config from DB:', err);
  }

  return null;
}

/** 获取邮件配置：优先数据库 → 回退环境变量 */
async function getEmailConfig(): Promise<EmailConfig | null> {
  // 优先从数据库读取（三端通用）
  const dbConfig = await getEmailConfigFromDB();
  if (dbConfig) return dbConfig;

  // 回退到环境变量（腾讯云/沙箱 .env.local）
  const host = process.env.EMAIL_SMTP_HOST;
  const port = process.env.EMAIL_SMTP_PORT;
  const user = process.env.EMAIL_SMTP_USER;
  const pass = process.env.EMAIL_SMTP_PASS;
  const emailFrom = process.env.EMAIL_FROM;

  if (!host || !user || !pass) {
    return null;
  }

  const from = buildEmailSender(emailFrom, user, '');

  return {
    host,
    port: parseInt(port || '465', 10),
    secure: parseInt(port || '465', 10) === 465,
    auth: { user, pass },
    from,
  };
}

/** 配置变化时重建 transporter */
function configHash(config: EmailConfig): string {
  return `${config.host}:${config.port}:${config.auth.user}:${config.auth.pass}`;
}

async function getTransporter(): Promise<nodemailer.Transporter | null> {
  const config = await getEmailConfig();
  if (!config) return null;

  const hash = configHash(config);
  if (transporter && cachedConfigHash === hash) {
    return transporter;
  }

  // 配置变化或首次创建
  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
  cachedConfigHash = hash;
  return transporter;
}

export async function isEmailConfigured(): Promise<boolean> {
  return (await getTransporter()) !== null;
}

export async function sendVerificationCode(
  toEmail: string,
  code: string,
  purpose: VerificationEmailPurpose = '身份验证',
): Promise<boolean> {
  const config = await getEmailConfig();
  const transport = await getTransporter();
  if (!transport || !config) {
    console.warn('[Email] SMTP not configured, code not sent');
    return false;
  }

  // 动态获取平台名称
  const platformName = await getPlatformName() || '智能体工作平台';
  const from = { ...config.from, name: normalizeDisplayText(config.from.name, platformName) };
  const message = buildVerificationEmail(platformName, code, purpose);

  try {
    const info = await transport.sendMail({
      from,
      to: toEmail,
      subject: message.subject,
      text: message.text,
      html: message.html,
      textEncoding: 'base64',
      headers: {
        'Content-Language': 'zh-CN',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
      },
    });
    console.log(`[Email] Verification code sent to ${emailLogLabel(toEmail)}, messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    console.error('[Email] Failed to send verification code:', err);
    return false;
  }
}
