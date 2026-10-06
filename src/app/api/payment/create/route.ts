// 🔒 核心底层代码 — 锁定保护
//
// 本文件是支付订单创建 API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { createPayment as createXunhuPayment } from "@/lib/xunhupay";
import { createPayment as createEPayPayment } from "@/lib/epay";
import { getBillingConfig } from "@/lib/billing";
import {
  claimPaymentOrderCreation,
  finalizePaymentOrderCreation,
  markPaymentOrderCreationProviderStarted,
  markPaymentOrderCreationRecoveryRequired,
  paymentCreationTradeOrderId,
  paymentOrderCreationFingerprint,
  PaymentOrderCreationError,
  validatePaymentCreationIdempotencyKey,
} from "@/lib/payment-order-creation";
import { runPaymentOrderCreation } from "@/lib/payment-order-creation-machine";

type RechargeType = "credits" | "cash";
type PaymentProvider = "xunhupay" | "epay";

interface PaymentMethodRow {
  id: string;
  code: string;
  provider: string;
}

interface ProviderOrderResult {
  paymentUrl: string;
  qrcodeUrl: string;
  platformOrderId: string | null;
}

function normalizeAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-8) return null;
  return cents / 100;
}

function normalizeCallbackBaseUrl(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;
  const raw = rawValue.trim();
  if (!raw || raw.length > 2048) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(candidate);
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    const protocolAllowed = parsed.protocol === "https:"
      || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && isLoopback);
    if (!protocolAllowed || !parsed.hostname || parsed.username || parsed.password) return null;
    if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function isSafeProviderUrl(rawValue: string): boolean {
  if (!rawValue || rawValue.length > 8192) return false;
  try {
    const parsed = new URL(rawValue);
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    return parsed.protocol === "https:"
      || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:" && isLoopback);
  } catch {
    return false;
  }
}

function isSafeProviderOrderId(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
}

async function createProviderOrder(params: {
  paymentProvider: PaymentProvider;
  normalizedMethod: string;
  tradeOrderId: string;
  normalizedAmount: number;
  title: string;
  notifyUrl: string;
  returnUrl: string;
  type: RechargeType;
  userId: string;
}): Promise<ProviderOrderResult> {
  if (params.paymentProvider === "epay") {
    const epayType = params.normalizedMethod === "wechat" || params.normalizedMethod === "wxpay" || params.normalizedMethod === "wechat_epay"
      ? "wxpay"
      : params.normalizedMethod === "alipay" || params.normalizedMethod === "alipay_epay"
        ? "alipay"
        : params.normalizedMethod === "qqpay"
          ? "qqpay"
          : null;
    if (!epayType) throw new Error("EPAY_METHOD_UNSUPPORTED");

    const result = await createEPayPayment({
      outTradeNo: params.tradeOrderId,
      money: params.normalizedAmount.toFixed(2),
      name: params.title,
      type: epayType,
      notifyUrl: params.notifyUrl,
      returnUrl: params.returnUrl,
    });
    if (!isSafeProviderUrl(result.payUrl)) throw new Error("EPAY_RESULT_INVALID");
    return { paymentUrl: result.payUrl, qrcodeUrl: "", platformOrderId: null };
  }

  const xunhuType = params.normalizedMethod === "wechat" || params.normalizedMethod === "wxpay"
    ? "Wechat"
    : params.normalizedMethod === "alipay"
      ? "Alipay"
      : null;
  if (!xunhuType) throw new Error("XUNHU_METHOD_UNSUPPORTED");

  const result = await createXunhuPayment({
    tradeOrderId: params.tradeOrderId,
    totalFee: params.normalizedAmount.toFixed(2),
    title: params.title,
    type: xunhuType,
    notifyUrl: params.notifyUrl,
    returnUrl: params.returnUrl,
    callbackUrl: params.returnUrl,
    attach: JSON.stringify({
      type: params.type,
      userId: params.userId,
      amount: params.normalizedAmount,
    }),
  });

  const paymentUrl = String(result.url ?? "").trim();
  const qrcodeUrl = String(result.url_qrcode ?? "").trim();
  const platformOrderId = String(result.order_id ?? "").trim();
  if ((!paymentUrl && !qrcodeUrl)
    || (paymentUrl && !isSafeProviderUrl(paymentUrl))
    || (qrcodeUrl && !isSafeProviderUrl(qrcodeUrl))
    || !isSafeProviderOrderId(platformOrderId)) {
    throw new Error("XUNHU_RESULT_INVALID");
  }
  return { paymentUrl, qrcodeUrl, platformOrderId };
}

// POST /api/payment/create - 创建支付订单（支持迅虎+易支付多通道）
export async function POST(request: NextRequest) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const payload = await verifyToken(token);
    if (!payload?.userId) {
      return NextResponse.json({ error: "无效的登录状态" }, { status: 401 });
    }
    const userId = payload.userId as string;
    const idempotencyKey = validatePaymentCreationIdempotencyKey(
      request.headers.get("idempotency-key"),
    );

    const body = await request.json() as Record<string, unknown>;
    const type = body.type;
    const normalizedAmount = normalizeAmount(body.amount);
    const paymentMethodId = typeof body.paymentMethodId === "string" ? body.paymentMethodId.trim() : "";
    const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod.trim() : "";
    const requestedProvider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";

    if ((type !== "credits" && type !== "cash") || normalizedAmount == null || !paymentMethod) {
      return NextResponse.json({ error: "缺少或无效的必要参数" }, { status: 400 });
    }
    if (paymentMethodId.length > 128 || paymentMethod.length > 64 || (requestedProvider && !["xunhupay", "epay"].includes(requestedProvider))) {
      return NextResponse.json({ error: "无效的支付方式" }, { status: 400 });
    }
    if (type === "credits" && normalizedAmount < 100) {
      return NextResponse.json({ error: "积分充值最低100元起充" }, { status: 400 });
    }
    if (type === "cash" && normalizedAmount < 10) {
      return NextResponse.json({ error: "现金充值最低10元起充" }, { status: 400 });
    }
    if (normalizedAmount > 50000) {
      return NextResponse.json({ error: "单笔充值金额不能超过5万元，如有大额需求请联系管理员" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const { data: methodData, error: methodError } = await supabase
      .from("payment_methods")
      .select("id, code, provider")
      .eq("is_active", true);
    if (methodError) {
      console.error("[支付] 读取支付方式配置失败:", methodError);
      return NextResponse.json({ error: "支付配置暂不可用" }, { status: 503 });
    }

    const normalizedMethod = paymentMethod.toLowerCase();
    const matchedMethods = ((methodData as PaymentMethodRow[] | null) || []).filter((method) => {
      const methodCode = String(method.code ?? "").trim().toLowerCase();
      const methodProvider = String(method.provider ?? "").trim().toLowerCase();
      const methodIdMatches = !paymentMethodId || String(method.id ?? "") === paymentMethodId;
      return methodIdMatches && methodCode === normalizedMethod && (!requestedProvider || methodProvider === requestedProvider);
    });
    if (!paymentMethodId && matchedMethods.length > 1) {
      return NextResponse.json({ error: "支付方式不明确，请刷新页面后重新选择" }, { status: 409 });
    }
    const matchedMethod = matchedMethods.length === 1 ? matchedMethods[0] : null;
    if (!matchedMethod) {
      return NextResponse.json({ error: "该支付方式暂不可用" }, { status: 400 });
    }

    const paymentProvider = String(matchedMethod.provider ?? "").trim().toLowerCase();
    if (paymentProvider !== "xunhupay" && paymentProvider !== "epay") {
      console.error("[支付] 支付方式绑定了未支持的 provider:", paymentProvider);
      return NextResponse.json({ error: "支付渠道配置异常" }, { status: 503 });
    }

    const billingConfig = await getBillingConfig();
    const creditsPerYuan = Number(billingConfig.creditsPerYuan);
    if (!Number.isFinite(creditsPerYuan) || creditsPerYuan <= 0) {
      console.error("[支付] creditsPerYuan 配置无效");
      return NextResponse.json({ error: "积分计费配置异常" }, { status: 503 });
    }
    let creditsAmount: number | null = null;
    if (type === "credits") {
      const computedCredits = Math.floor(normalizedAmount * creditsPerYuan);
      if (!Number.isSafeInteger(computedCredits) || computedCredits <= 0) {
        console.error("[支付] creditsAmount 计算结果无效");
        return NextResponse.json({ error: "积分计费配置异常" }, { status: 503 });
      }
      creditsAmount = computedCredits;
    }

    const { data: callbackSetting, error: callbackSettingError } = await supabase
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", "xunhu_wap_url")
      .maybeSingle();
    if (callbackSettingError) {
      console.error("[支付] 读取回调域名配置失败:", callbackSettingError);
      return NextResponse.json({ error: "支付回调配置暂不可用" }, { status: 503 });
    }
    const callbackSource = callbackSetting?.setting_value
      || process.env.XUNHU_WAP_URL
      || process.env.COZE_PROJECT_DOMAIN_DEFAULT
      || "";
    const baseUrl = normalizeCallbackBaseUrl(callbackSource);
    if (!baseUrl) {
      console.error("[支付] 回调域名缺失或不安全");
      return NextResponse.json({ error: "支付配置异常：回调域名无效，请联系管理员" }, { status: 503 });
    }

    const tradeOrderId = paymentCreationTradeOrderId({ userId, idempotencyKey, type });
    const notifyUrl = `${baseUrl}/api/payment/notify`;
    const expireAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const requestFingerprint = paymentOrderCreationFingerprint({
      type,
      amount: normalizedAmount,
      creditsAmount,
      paymentMethodId: matchedMethod.id,
      paymentMethod: normalizedMethod,
      paymentProvider,
      callbackOrigin: baseUrl,
    });
    const leaseOwner = `payment-create:${crypto.randomUUID()}`;

    // Durable order intent and provider-start evidence are committed before the
    // external request. A retry with the same key can only replay/recover this
    // merchant order; it cannot create a second provider order.
    const outcome = await runPaymentOrderCreation({
      claim: () => claimPaymentOrderCreation({
        userId,
        idempotencyKey,
        requestFingerprint,
        tradeOrderId,
        type,
        amount: normalizedAmount,
        creditsAmount,
        paymentMethod: normalizedMethod,
        paymentProvider,
        expireAt,
        leaseOwner,
      }),
      markProviderStarted: markPaymentOrderCreationProviderStarted,
      createProviderOrder: (record) => createProviderOrder({
        paymentProvider: record.paymentProvider,
        normalizedMethod: record.paymentMethod,
        tradeOrderId: record.tradeOrderId,
        normalizedAmount: record.amount,
        title: record.type === "credits"
          ? `积分充值 ${record.creditsAmount}积分`
          : `现金充值 ¥${record.amount}`,
        notifyUrl,
        returnUrl: `${baseUrl}/payment/result?order=${encodeURIComponent(record.tradeOrderId)}`,
        type: record.type,
        userId: record.userId,
      }),
      finalize: finalizePaymentOrderCreation,
      markRecoveryRequired: markPaymentOrderCreationRecoveryRequired,
    });

    if (outcome.kind === "in_progress") {
      return NextResponse.json({
        success: false,
        code: "PAYMENT_CREATE_IN_PROGRESS",
        error: "订单正在创建，请稍后重试",
        tradeOrderId: outcome.record.tradeOrderId,
        retryAfterMs: 1500,
      }, { status: 202 });
    }
    if (outcome.kind === "reconciliation_required") {
      console.error("[支付] 订单创建结果需要恢复核对:", {
        tradeOrderId: outcome.record.tradeOrderId,
        paymentProvider: outcome.record.paymentProvider,
        providerSucceeded: outcome.providerSucceeded,
        recoveryPersisted: outcome.recoveryPersisted,
        reason: outcome.reason,
      });
      return NextResponse.json({
        success: false,
        code: "PAYMENT_CREATE_RECONCILIATION_REQUIRED",
        error: "订单结果正在核对，请保留当前页面并使用原请求重试",
        tradeOrderId: outcome.record.tradeOrderId,
        retryAfterMs: 2000,
      }, { status: 202 });
    }

    const providerOrder = outcome.record.providerResult;
    if (!providerOrder) {
      throw new PaymentOrderCreationError(
        "PAYMENT_CREATE_RESULT_INVALID",
        "支付订单缺少支付地址",
        503,
      );
    }
    console.log(`[支付] 订单已就绪 ${outcome.record.tradeOrderId}，provider=${paymentProvider}，callback=${new URL(baseUrl).hostname}，replayed=${outcome.replayed}`);
    return NextResponse.json({
      success: true,
      tradeOrderId: outcome.record.tradeOrderId,
      paymentUrl: providerOrder.paymentUrl,
      qrcodeUrl: providerOrder.qrcodeUrl,
      provider: paymentProvider,
      creditsAmount: outcome.record.creditsAmount,
      idempotencyReplayed: outcome.replayed,
      recovered: outcome.recovered,
    });
  } catch (error) {
    if (error instanceof PaymentOrderCreationError) {
      return NextResponse.json({
        success: false,
        code: error.code,
        error: error.message,
      }, { status: error.status });
    }
    console.error("创建支付订单失败:", error);
    return NextResponse.json({ error: "创建订单失败" }, { status: 500 });
  }
}
