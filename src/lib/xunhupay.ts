/**
 * 迅虎支付（虎皮椒）集成
 * 协议文档: /docs/xunhupay-protocol.md
 * 支持微信支付 + 支付宝
 *
 * 网关地址配置优先级：platform_settings 数据库 > 环境变量 > 默认值
 * 正式环境：https://api.xunhupay.com/payment/do.html
 * 备用平台：https://api.dpweixin.com/payment/do.html
 */

import crypto from 'crypto';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// ─── 默认值（环境变量回退） ─────────────────────────────
const DEFAULT_APPID = process.env.XUNHU_APPID?.trim() || '';
const DEFAULT_SECRET = process.env.XUNHU_SECRET?.trim() || '';
const DEFAULT_GATEWAY = 'https://api.xunhupay.com/payment/do.html';
const DEFAULT_GATEWAY_BACKUP = 'https://api.dpweixin.com/payment/do.html';
const DEFAULT_REFUND_GATEWAY = 'https://api.xunhupay.com/payment/refund.html';
const DEFAULT_REFUND_GATEWAY_BACKUP = 'https://api.dpweixin.com/payment/refund.html';
// 微信 H5 支付必须使用当前站点已备案域名；不得把历史域名编译为兜底值。
const DEFAULT_WAP_URL = process.env.XUNHU_WAP_URL?.trim() || '';

// ─── 配置缓存（1分钟TTL，与 coze-api.ts 保持一致） ──────────
let configCache: XunhuConfig | null = null;
let configCacheExpiry = 0;

interface XunhuConfig {
  appid: string;
  secret: string;
  gateway: string;
  gatewayBackup: string;
  refundGateway: string;
  refundGatewayBackup: string;
  wapUrl: string;
}

export class XunhuConfigError extends Error {
  readonly code = 'XUNHU_PAYMENT_NOT_CONFIGURED';

  constructor(message = '迅虎支付尚未完成商户配置') {
    super(message);
    this.name = 'XunhuConfigError';
  }
}

class XunhuIntegrityError extends Error {
  readonly code = 'XUNHU_RESPONSE_INTEGRITY_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'XunhuIntegrityError';
  }
}

function requireConfigured(config: XunhuConfig): XunhuConfig {
  const normalized: XunhuConfig = {
    appid: config.appid.trim(),
    secret: config.secret.trim(),
    gateway: config.gateway.trim(),
    gatewayBackup: config.gatewayBackup.trim(),
    refundGateway: config.refundGateway.trim(),
    refundGatewayBackup: config.refundGatewayBackup.trim(),
    wapUrl: config.wapUrl.trim(),
  };
  if (!normalized.appid || !normalized.secret) throw new XunhuConfigError();
  return normalized;
}

function normalizePositiveMoney(value: string, field: string): string {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new XunhuIntegrityError(`${field} 不是有效的正数金额`);
  }
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new XunhuIntegrityError(`${field} 不是有效的正数金额`);
  }
  return amount.toFixed(2);
}

/**
 * 获取支付配置
 * 优先从数据库 platform_settings 读取，环境变量回退
 */
async function getConfig(): Promise<XunhuConfig> {
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
        'xunhu_appid', 'xunhu_secret',
        'xunhu_gateway', 'xunhu_gateway_backup',
        'xunhu_refund_gateway', 'xunhu_refund_gateway_backup',
        'xunhu_wap_url',
      ]);

    const settings: Record<string, string> = {};
    if (data) {
      for (const row of data) {
        if (row.setting_value) {
          settings[row.setting_key] = row.setting_value;
        }
      }
    }

    configCache = requireConfigured({
      appid: settings.xunhu_appid || DEFAULT_APPID,
      secret: settings.xunhu_secret || DEFAULT_SECRET,
      gateway: settings.xunhu_gateway || process.env.XUNHU_GATEWAY || DEFAULT_GATEWAY,
      gatewayBackup: settings.xunhu_gateway_backup || process.env.XUNHU_GATEWAY_BACKUP || DEFAULT_GATEWAY_BACKUP,
      refundGateway: settings.xunhu_refund_gateway || DEFAULT_REFUND_GATEWAY,
      refundGatewayBackup: settings.xunhu_refund_gateway_backup || DEFAULT_REFUND_GATEWAY_BACKUP,
      wapUrl: settings.xunhu_wap_url || DEFAULT_WAP_URL,
    });
    configCacheExpiry = now + 60_000; // 1分钟缓存
    return configCache;
  } catch (err) {
    console.warn('[迅虎支付] 读取数据库配置失败，使用环境变量:', err);
    return requireConfigured({
      appid: DEFAULT_APPID,
      secret: DEFAULT_SECRET,
      gateway: process.env.XUNHU_GATEWAY || DEFAULT_GATEWAY,
      gatewayBackup: process.env.XUNHU_GATEWAY_BACKUP || DEFAULT_GATEWAY_BACKUP,
      refundGateway: DEFAULT_REFUND_GATEWAY,
      refundGatewayBackup: DEFAULT_REFUND_GATEWAY_BACKUP,
      wapUrl: DEFAULT_WAP_URL,
    });
  }
}

// ─── 类型定义 ──────────────────────────────────────

export interface XunhuOrderParams {
  tradeOrderId: string;    // 商户订单号
  totalFee: string;        // 金额（元，如 "10.00"）
  title: string;           // 商品标题
  type?: 'Alipay' | 'Wechat'; // 支付方式
  notifyUrl: string;       // 异步回调地址
  returnUrl?: string;      // 同步跳转地址（支付成功后跳转）
  callbackUrl?: string;    // 商品网址（用户取消支付后引导跳转重新支付）
  attach?: string;         // 备注，回调时原样返回
}

export interface XunhuNotifyParams {
  trade_order_id: string;
  total_fee: string;
  transaction_id: string;
  time: string;
  status: string;  // OD=成功
  hash: string;
  attach?: string;  // 原样返回的备注
  [key: string]: string | undefined;
}

export interface XunhuRefundParams {
  tradeOrderId?: string;   // 商户订单号（与openOrderId二选一）
  openOrderId?: string;    // 虎皮椒内部订单号（与tradeOrderId二选一）
  reason?: string;         // 退款原因（可选，微信退款消息中体现）
}

export interface XunhuRefundResult {
  tradeOrderId: string;    // 商户订单号
  transactionId: string;   // 交易号
  outRefundNo: string;     // 退款单号
  refundFee: string;       // 退款金额
  reason: string;          // 退款原因
  refundStatus: string;    // OD已支付，CD已退款，RD退款中，UD退款失败
  refundTime: string;      // 退款时间
}

// ─── 签名算法 ──────────────────────────────────────

/**
 * 生成签名
 * 官方规则:
 *   1. 参数按key升序排列(字典序/ASCII码序)
 *   2. 空值不参与签名，hash不参与签名
 *   3. 拼接成URL参数格式 key1=value1&key2=value2...
 *   4. 末尾直接拼接APPSECRET（不加&key=，无任何连接符）
 *   5. MD5取32位小写
 * 参考: /docs/xunhupay-protocol.md 签名算法章节
 */
function generateSign(params: Record<string, string>, secret: string): string {
  if (!secret.trim()) throw new XunhuConfigError();
  const sortedKeys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const key of sortedKeys) {
    if (key === 'hash') continue;
    const val = params[key];
    if (val === '' || val === undefined || val === null) continue;
    parts.push(`${key}=${val}`);
  }
  const stringA = parts.join('&');
  const stringSignTemp = stringA + secret;
  return crypto.createHash('md5').update(stringSignTemp, 'utf8').digest('hex').toLowerCase();
}

/**
 * 验证回调签名
 */
export async function verifyNotify(params: XunhuNotifyParams): Promise<boolean> {
  const config = await getConfig();
  const hash = params.hash;
  // 过滤掉 undefined 值以兼容 Record<string, string>
  const filteredParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      filteredParams[key] = value;
    }
  }
  const computed = generateSign(filteredParams, config.secret);
  if (typeof hash !== 'string' || hash.length !== computed.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
}

/**
 * 验证响应签名（创建订单/退款返回的hash）
 */
function verifyResponseSign(params: Record<string, string>, secret: string): boolean {
  const hash = params.hash;
  if (!hash) return false;
  const computed = generateSign(params, secret);
  return hash === computed;
}

// ─── 通用网关请求 ──────────────────────────────────

const MAX_GATEWAY_RESPONSE_BYTES = 64 * 1024;
const XUNHU_QUERY_TIMEOUT_MS = 10_000;

async function readBoundedGatewayResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') || '0');
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_GATEWAY_RESPONSE_BYTES) {
    throw new XunhuIntegrityError('迅虎支付响应体积无效');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_GATEWAY_RESPONSE_BYTES) {
        throw new XunhuIntegrityError('迅虎支付响应体积无效');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function postToGateway<T>(
  gateway: string,
  requestParams: Record<string, string>,
  secret: string,
  parseResult: (result: Record<string, string>) => T
): Promise<T> {
  const response = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(requestParams).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await readBoundedGatewayResponse(response);
  let result: Record<string, string>;

  try {
    result = JSON.parse(text);
  } catch {
    throw new XunhuIntegrityError('迅虎支付返回格式错误');
  }

  const errcode = String(result.errcode ?? '');
  if (errcode !== '' && errcode !== '0') {
    const errmsg = String(result.errmsg || '支付网关返回业务错误').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
    throw new Error(`迅虎支付错误[${result.errcode}]: ${errmsg}`);
  }

  // 验证响应签名（防篡改）
  if (result.hash && !verifyResponseSign(result, secret)) {
    console.error('[迅虎支付] 响应签名验证失败', { responseKeys: Object.keys(result).sort().slice(0, 32) });
    throw new XunhuIntegrityError('迅虎支付响应签名验证失败');
  }

  return parseResult(result);
}

// ─── 创建支付订单 ──────────────────────────────────

/**
 * 创建支付订单
 * 返回支付URL或二维码URL
 * 正式网关失败时自动降级到备用网关
 */
export async function createPayment(params: XunhuOrderParams): Promise<{
  url_qrcode: string;   // 支付二维码(PC端使用，5分钟有效)
  url: string;          // 支付页面URL(手机端跳转)
  order_id: string;     // 平台订单号
}> {
  const config = await getConfig();
  const totalFee = normalizePositiveMoney(params.totalFee, 'totalFee');

  const nonceStr = crypto.randomBytes(16).toString('hex');
  const time = Math.floor(Date.now() / 1000).toString();

  const requestParams: Record<string, string> = {
    version: '1.1',
    appid: config.appid,
    trade_order_id: params.tradeOrderId,
    total_fee: totalFee,
    title: params.title,
    time,
    notify_url: params.notifyUrl,
    nonce_str: nonceStr,
  };

  // type参数：微信H5支付填"WAP"，微信小程序填"JSAPI"，支付宝不需要type参数
  const isWechat = params.type === 'Wechat';
  if (isWechat) {
    if (!config.wapUrl) {
      throw new XunhuConfigError('迅虎微信 H5 支付尚未配置备案域名');
    }
    requestParams.type = 'WAP';
    requestParams.wap_url = config.wapUrl;
    requestParams.wap_name = '智能体工作台';
  }
  // Alipay不传type参数

  // 可选参数：return_url（支付成功跳转）
  if (params.returnUrl) {
    requestParams.return_url = params.returnUrl;
  }

  // 可选参数：callback_url（用户取消支付后引导跳转重新支付）
  if (params.callbackUrl) {
    requestParams.callback_url = params.callbackUrl;
  }

  // 可选参数：attach（备注，回调时原样返回）
  if (params.attach) {
    requestParams.attach = params.attach;
  }

  // 生成签名
  requestParams.hash = generateSign(requestParams, config.secret);

  const parsePaymentResult = (result: Record<string, string>) => {
    if (!result.hash) {
      throw new XunhuIntegrityError('迅虎支付创建响应缺少签名');
    }
    // 协议返回字段：oderid（历史遗留拼写错误，字段名可能是 oderid 或 openid）
    const orderId = result.oderid || result.openid || result.order_id || '';
    return {
      url_qrcode: result.url_qrcode || '',
      url: result.url || '',
      order_id: String(orderId),
    };
  };

  // 提交订单：先走正式网关，失败自动降级到备用网关
  try {
    console.log('[迅虎支付] 使用正式网关:', config.gateway);
    return await postToGateway(config.gateway, requestParams, config.secret, parsePaymentResult);
  } catch (primaryError) {
    console.warn('[迅虎支付] 正式网关失败，尝试备用网关:', primaryError instanceof Error ? primaryError.message : primaryError);

    try {
      console.log('[迅虎支付] 使用备用网关:', config.gatewayBackup);
      return await postToGateway(config.gatewayBackup, requestParams, config.secret, parsePaymentResult);
    } catch (backupError) {
      console.error('[迅虎支付] 备用网关也失败:', backupError instanceof Error ? backupError.message : backupError);
      throw primaryError instanceof Error ? primaryError : new Error(String(primaryError));
    }
  }
}

// ─── 退款 ──────────────────────────────────────────

/**
 * 发起退款。
 *
 * A transport failure after POST is ambiguous: the provider may already have
 * accepted the refund. Never retry the refund against a backup gateway here;
 * the caller must persist reconciliation_required and inspect the original
 * provider receipt instead of risking a second monetary operation.
 */
export async function refundPayment(params: XunhuRefundParams): Promise<XunhuRefundResult> {
  const config = await getConfig();

  if (!params.tradeOrderId && !params.openOrderId) {
    throw new Error('tradeOrderId 和 openOrderId 至少提供一个');
  }

  const nonceStr = crypto.randomBytes(16).toString('hex');
  const time = Math.floor(Date.now() / 1000).toString();

  const requestParams: Record<string, string> = {
    appid: config.appid,
    time,
    nonce_str: nonceStr,
  };

  // trade_order_id 和 open_order_id 二选一
  if (params.tradeOrderId) {
    requestParams.trade_order_id = params.tradeOrderId;
  }
  if (params.openOrderId) {
    requestParams.open_order_id = params.openOrderId;
  }

  // 可选参数：退款原因
  if (params.reason) {
    requestParams.reason = params.reason;
  }

  // 生成签名
  requestParams.hash = generateSign(requestParams, config.secret);

  const requestedTradeOrderId = params.tradeOrderId?.trim() || '';
  const parseRefundResult = (result: Record<string, string>): XunhuRefundResult => {
    if (!result.hash || !verifyResponseSign(result, config.secret)) {
      throw new XunhuIntegrityError('迅虎退款响应缺少有效签名');
    }
    const tradeOrderId = String(result.trade_order_id || '').trim();
    const refundStatus = String(result.refund_status || '').trim().toUpperCase();
    const outRefundNo = String(result.out_refund_no || '').trim();
    const refundFee = String(result.refund_fee || '').trim();
    if (requestedTradeOrderId && tradeOrderId !== requestedTradeOrderId) {
      throw new XunhuIntegrityError('迅虎退款响应的商户订单号不匹配');
    }
    if (!['OD', 'CD', 'RD', 'UD'].includes(refundStatus)) {
      throw new XunhuIntegrityError('迅虎退款响应状态无效');
    }
    if ((refundStatus === 'CD' || refundStatus === 'RD') && !outRefundNo) {
      throw new XunhuIntegrityError('迅虎退款响应缺少退款单号');
    }
    if (refundFee && !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(refundFee)) {
      throw new XunhuIntegrityError('迅虎退款响应金额无效');
    }
    return {
      tradeOrderId,
      transactionId: String(result.transaction_id || '').trim(),
      outRefundNo,
      refundFee,
      reason: String(result.reason || '').slice(0, 200),
      refundStatus,
      refundTime: String(result.refund_time || '').slice(0, 80),
    };
  };

  console.log('[迅虎支付] 提交单次退款请求');
  return postToGateway(config.refundGateway, requestParams, config.secret, parseRefundResult);
}

// ─── 订单查询 ──────────────────────────────────────

/**
 * 查询迅虎订单状态
 * API文档: https://api.xunhupay.com/payment/query.html
 * 
 * 迅虎回调经常不到达服务器，此接口作为主动查询的兜底机制。
 * 在 status/route.ts 的轮询中，当订单 pending >60秒 且回调未到时调用。
 */
export async function queryOrderStatus(tradeOrderId: string): Promise<{
  status: 'OD' | 'WP' | 'CD' | 'NOT_FOUND';  // OD=已支付, WP=待支付, CD=已退款
  tradeOrderId?: string;
  totalAmount?: string;
  paidDate?: string | null;
  transactionId?: string | null;
  openOrderId?: string | null;
} | null> {
  try {
    if (!tradeOrderId?.trim() || tradeOrderId.trim().length > 240) {
      throw new XunhuIntegrityError('tradeOrderId 无效');
    }
    const normalizedTradeOrderId = tradeOrderId.trim();
    const config = await getConfig();

    const params: Record<string, string> = {
      appid: config.appid,
      out_trade_order: normalizedTradeOrderId,
      time: String(Math.floor(Date.now() / 1000)),
      nonce_str: crypto.randomBytes(16).toString('hex'),
    };

    params.hash = generateSign(params, config.secret);

    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const queryUrl = `https://api.xunhupay.com/payment/query.html?${qs}`;

    const response = await fetch(queryUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(XUNHU_QUERY_TIMEOUT_MS),
    });
    const text = await readBoundedGatewayResponse(response);
    if (!response.ok) {
      console.warn('[迅虎支付] 查询订单 HTTP 失败:', response.status);
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new XunhuIntegrityError('迅虎支付查询返回格式错误');
    }
    const result = parsed as Record<string, unknown>;

    const signedResult: Record<string, string> = {};
    for (const [key, value] of Object.entries(result)) {
      if (value != null && typeof value !== 'object') signedResult[key] = String(value);
    }
    if (!signedResult.hash || !verifyResponseSign(signedResult, config.secret)) {
      throw new XunhuIntegrityError('迅虎支付查询响应签名验证失败');
    }

    if (result.errcode !== 0 && result.errcode !== '0') {
      const errorMessage = String(result.errmsg || 'unknown').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 160);
      if (errorMessage.toLowerCase().includes('not found') || errorMessage.includes('不存在')) {
        return { status: 'NOT_FOUND' };
      }
      console.warn('[迅虎支付] 查询订单失败:', errorMessage);
      return null;
    }

    const data = (result.data && typeof result.data === 'object'
      ? result.data
      : {}) as Record<string, unknown>;
    const status = String(data.status || 'WP').toUpperCase();
    if (!['OD', 'WP', 'CD'].includes(status)) {
      throw new XunhuIntegrityError(`迅虎支付返回未知订单状态: ${status}`);
    }
    const totalAmount = status === 'OD'
      ? normalizePositiveMoney(String(data.total_amount ?? ''), 'totalAmount')
      : data.total_amount == null
        ? undefined
        : normalizePositiveMoney(String(data.total_amount), 'totalAmount');
    const providerTradeOrderId = String(
      data.trade_order_id
      ?? data.out_trade_order
      ?? data.out_trade_no
      ?? data.merchant_order_id
      ?? '',
    ).trim();
    const transactionId = String(data.transaction_id ?? '').trim();

    if (status === 'OD') {
      if (!providerTradeOrderId || providerTradeOrderId !== normalizedTradeOrderId) {
        throw new XunhuIntegrityError('迅虎支付查询返回的商户订单号缺失或不匹配');
      }
      if (!transactionId || transactionId.length > 240 || /[\u0000-\u001f\u007f]/.test(transactionId)) {
        throw new XunhuIntegrityError('迅虎支付查询返回的平台交易号缺失或无效');
      }
    }
    return {
      status: status as 'OD' | 'WP' | 'CD',
      tradeOrderId: providerTradeOrderId || undefined,
      totalAmount,
      paidDate: data.paid_date ? String(data.paid_date).slice(0, 80) : null,
      transactionId: transactionId || null,
      openOrderId: data.open_order_id ? String(data.open_order_id).slice(0, 240) : null,
    };
  } catch (err) {
    if (err instanceof XunhuConfigError || err instanceof XunhuIntegrityError) throw err;
    console.warn('[迅虎支付] 查询订单异常:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── 清除配置缓存 ──────────────────────────────────
export function clearConfigCache(): void {
  configCache = null;
  configCacheExpiry = 0;
}
