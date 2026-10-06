/**
 * 易支付(EPay)集成
 * 协议标准: submit.php 表单提交 + MD5签名
 * 支持微信支付、支付宝、QQ钱包等
 *
 * API参数:
 *   pid          - 商户ID
 *   type         - 支付方式(alipay/wxpay/qqpay)
 *   out_trade_no - 商户订单号
 *   notify_url   - 异步回调地址
 *   return_url   - 同步跳转地址
 *   name         - 商品名称
 *   money        - 金额(元)
 *   sign         - MD5签名
 *   sign_type    - 签名方式(MD5)
 *
 * 签名规则:
 *   1. 参数按key升序排列
 *   2. 空值和sign、sign_type不参与签名
 *   3. 拼接成 URL参数格式 key1=value1&key2=value2
 *   4. 末尾拼接商户密钥: key1=value1&key2=value2{key}
 *   5. MD5取32位小写
 */

import crypto from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ─── 默认值（环境变量回退） ─────────────────────────────
const DEFAULT_PID = process.env.EPAY_PID || '';
const DEFAULT_KEY = process.env.EPAY_KEY || '';
const DEFAULT_GATEWAY = process.env.EPAY_GATEWAY || '';

// ─── 配置缓存（1分钟TTL） ──────────────────────────────
let configCache: EPayConfig | null = null;
let configCacheExpiry = 0;

interface EPayConfig {
  pid: string;
  key: string;
  gateway: string;        // 易支付网关地址，如 https://pay.xxx.cn/
}

/**
 * 获取易支付配置
 * 优先从数据库 platform_settings 读取，环境变量回退
 */
async function getConfig(): Promise<EPayConfig> {
  const now = Date.now();
  if (configCache && now < configCacheExpiry) {
    return configCache;
  }

  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('platform_settings')
      .select('setting_key, setting_value')
      .in('setting_key', [
        'epay_pid', 'epay_key', 'epay_gateway',
      ]);

    const settings: Record<string, string> = {};
    if (data) {
      for (const row of data) {
        if (row.setting_value) {
          settings[row.setting_key] = row.setting_value;
        }
      }
    }

    configCache = {
      pid: settings.epay_pid || DEFAULT_PID,
      key: settings.epay_key || DEFAULT_KEY,
      gateway: settings.epay_gateway || DEFAULT_GATEWAY,
    };
    configCacheExpiry = now + 60_000; // 1分钟缓存
    return configCache;
  } catch (err) {
    console.warn('[易支付] 读取数据库配置失败，使用环境变量:', err);
    return {
      pid: DEFAULT_PID,
      key: DEFAULT_KEY,
      gateway: DEFAULT_GATEWAY,
    };
  }
}

// ─── 类型定义 ──────────────────────────────────────

export interface EPayOrderParams {
  outTradeNo: string;       // 商户订单号
  money: string;            // 金额（元，如 "10.00"）
  name: string;             // 商品名称
  type: 'alipay' | 'wxpay' | 'qqpay'; // 支付方式
  notifyUrl: string;        // 异步回调地址
  returnUrl?: string;       // 同步跳转地址
  clientIp?: string;        // 用户IP（可选）
}

export interface EPayNotifyParams {
  pid: string;              // 商户ID
  trade_no: string;         // 易支付订单号
  out_trade_no: string;     // 商户订单号
  type: string;             // 支付方式
  name: string;             // 商品名称
  money: string;            // 金额
  trade_status: string;     // 交易状态 TRADE_SUCCESS
  sign: string;             // 签名
  sign_type: string;        // 签名类型 MD5
  [key: string]: string;    // 其他参数
}

// ─── 签名算法 ──────────────────────────────────────

/**
 * 生成签名
 * 规则:
 *   1. 参数按key升序排列
 *   2. 空值、sign、sign_type不参与签名
 *   3. 拼接成 URL参数格式
 *   4. 末尾直接拼接商户密钥
 *   5. MD5取32位小写
 */
function generateSign(params: Record<string, string>, key: string): string {
  const sortedKeys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const k of sortedKeys) {
    if (k === 'sign' || k === 'sign_type') continue;
    const val = params[k];
    if (val === '' || val === undefined || val === null) continue;
    parts.push(`${k}=${val}`);
  }
  const stringA = parts.join('&');
  const stringSignTemp = stringA + key;
  return crypto.createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toLowerCase();
}

/**
 * 验证回调签名
 */
export async function verifyNotify(params: EPayNotifyParams): Promise<boolean> {
  const config = await getConfig();
  if (!config.key) {
    console.error('[易支付] 商户密钥未配置，无法验证签名');
    return false;
  }
  const sign = params.sign;
  const filteredParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      filteredParams[key] = value;
    }
  }
  const computed = generateSign(filteredParams, config.key);
  if (typeof sign !== 'string' || sign.length !== computed.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sign), Buffer.from(computed));
}

// ─── 创建支付订单 ──────────────────────────────────

/**
 * 创建支付订单
 * 返回支付页面URL（用户跳转到易支付页面完成支付）
 */
export async function createPayment(params: EPayOrderParams): Promise<{
  payUrl: string;   // 支付页面URL（跳转用）
}> {
  const config = await getConfig();

  if (!config.pid || !config.key || !config.gateway) {
    throw new Error('易支付未配置：请先在管理后台填写商户ID、商户密钥和网关地址');
  }

  const requestParams: Record<string, string> = {
    pid: config.pid,
    type: params.type,
    out_trade_no: params.outTradeNo,
    notify_url: params.notifyUrl,
    name: params.name,
    money: params.money,
  };

  if (params.returnUrl) {
    requestParams.return_url = params.returnUrl;
  }
  if (params.clientIp) {
    requestParams.clientip = params.clientIp;
  }

  // 生成签名
  requestParams.sign = generateSign(requestParams, config.key);
  requestParams.sign_type = 'MD5';

  // 构建支付URL（GET跳转方式）
  const gatewayBase = config.gateway.endsWith('/') ? config.gateway : config.gateway + '/';
  const payUrl = `${gatewayBase}submit.php?${new URLSearchParams(requestParams).toString()}`;

  console.log('[易支付] 创建订单:', params.outTradeNo, '支付方式:', params.type);

  return { payUrl };
}

// ─── 清除配置缓存 ──────────────────────────────────
export function clearConfigCache(): void {
  configCache = null;
  configCacheExpiry = 0;
}

/**
 * 检查易支付是否已配置
 */
export async function isConfigured(): Promise<boolean> {
  const config = await getConfig();
  return !!(config.pid && config.key && config.gateway);
}
