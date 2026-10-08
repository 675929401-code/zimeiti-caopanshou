"use client";

/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是充值弹窗组件，积分/现金双模式 + 轮询 + 余额刷新。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #12 支付系统"。
 *
 * 锁定范围：整个文件
 * 锁定原因：充值链路涉及资金安全，积分/现金双模式必须隔离
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { reportPaymentCreateFailed, reportPaymentCallbackMissing } from "@/lib/diagnostic-sentry";
import { Input } from "@/components/ui/input";
import { Coins, Wallet, CreditCard, Loader2, CheckCircle2, XCircle, ArrowLeft, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

interface RechargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credits: number;
  cashBalance: number;
  /** credits=仅积分充值, cash=仅现金充值, both=同时显示(默认) */
  mode?: "credits" | "cash" | "both";
  onCreditsUpdated?: (newCredits: number) => void;
  onCashUpdated?: (newCash: number) => void;
}

// 积分充值默认值（动态从API读取覆盖）
const DEFAULT_CREDITS_PER_YUAN = 50; // 1元=50积分 → 100元=5000积分
const CREDITS_MIN_YUAN = 100; // 最低100元起充

// 现金充值：最低10元
const CASH_MIN_YUAN = 10;

// 支付方式类型
interface PaymentMethodConfig {
  id: string;
  label: string;
  icon: string;
  available: boolean;
  code: string;
  provider?: string;
}

// 默认支付方式只用于占位展示。支付配置必须由服务端确认后才允许下单。
const DEFAULT_PAYMENT_METHODS: PaymentMethodConfig[] = [
  { id: "wechat", label: "微信支付", icon: "wechat", available: false, code: "wechat", provider: "xunhupay" },
  { id: "alipay", label: "支付宝", icon: "alipay", available: false, code: "alipay", provider: "xunhupay" },
];

type PaymentMethod = "Wechat" | "Alipay" | string;

// 支付视图状态
type PaymentView = "form" | "qrcode" | "success";

type StoredPaymentCreateAttempt = {
  intent: string;
  idempotencyKey: string;
  createdAt: number;
};

const PAYMENT_CREATE_ATTEMPT_STORAGE_KEY = "payment-create-attempt.v1";
const PAYMENT_CREATE_ATTEMPT_TTL_MS = 35 * 60 * 1000;

function createPaymentIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return `recharge-${crypto.randomUUID()}`;
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return `recharge-${Array.from(random, value => value.toString(16).padStart(2, "0")).join("")}`;
}

function getOrCreatePaymentIdempotencyKey(intent: string): string {
  const now = Date.now();
  try {
    const raw = sessionStorage.getItem(PAYMENT_CREATE_ATTEMPT_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Partial<StoredPaymentCreateAttempt> : null;
    if (stored?.intent === intent
      && typeof stored.idempotencyKey === "string"
      && /^recharge-[A-Za-z0-9-]{16,120}$/u.test(stored.idempotencyKey)
      && typeof stored.createdAt === "number"
      && now - stored.createdAt >= 0
      && now - stored.createdAt < PAYMENT_CREATE_ATTEMPT_TTL_MS) {
      return stored.idempotencyKey;
    }
  } catch {
    // A privacy mode may disable sessionStorage. The in-memory click lock still
    // protects the current render, while the server remains the final guard.
  }

  const idempotencyKey = createPaymentIdempotencyKey();
  try {
    sessionStorage.setItem(PAYMENT_CREATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      intent,
      idempotencyKey,
      createdAt: now,
    } satisfies StoredPaymentCreateAttempt));
  } catch {
    // See the storage note above.
  }
  return idempotencyKey;
}

function clearPaymentIdempotencyKey(idempotencyKey: string): void {
  try {
    const raw = sessionStorage.getItem(PAYMENT_CREATE_ATTEMPT_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Partial<StoredPaymentCreateAttempt> : null;
    if (stored?.idempotencyKey === idempotencyKey) {
      sessionStorage.removeItem(PAYMENT_CREATE_ATTEMPT_STORAGE_KEY);
    }
  } catch {
    // Storage cleanup is best effort; expiry prevents stale reuse.
  }
}

function currentPaymentIdempotencyKey(): string | undefined {
  try {
    const raw = sessionStorage.getItem(PAYMENT_CREATE_ATTEMPT_STORAGE_KEY);
    const stored = raw ? JSON.parse(raw) as Partial<StoredPaymentCreateAttempt> : null;
    return typeof stored?.idempotencyKey === "string" ? stored.idempotencyKey : undefined;
  } catch {
    return undefined;
  }
}

export function RechargeDialog({
  open,
  onOpenChange,
  credits,
  cashBalance,
  mode = "both",
  onCreditsUpdated,
  onCashUpdated,
}: RechargeDialogProps) {
  // 决定显示哪些 tab
  const showCreditsTab = mode === "credits" || mode === "both";
  const showCashTab = mode === "cash" || mode === "both";
  const defaultTab = mode === "cash" ? "cash" : "credits";

  const [tab, setTab] = useState<"credits" | "cash">(defaultTab);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("wechat");
  const [customAmount, setCustomAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [creditsPerYuan, setCreditsPerYuan] = useState(DEFAULT_CREDITS_PER_YUAN);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodConfig[]>(DEFAULT_PAYMENT_METHODS);
  const [creditsConfigReady, setCreditsConfigReady] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [paymentConfigReady, setPaymentConfigReady] = useState(false);

  // 二维码支付相关状态
  const [paymentView, setPaymentView] = useState<PaymentView>("form");
  const [qrcodeData, setQrcodeData] = useState<{
    tradeOrderId: string;
    paymentUrl: string;
    qrcodeUrl: string;
    payAmount: number;
    payType: string;
    methodLabel: string;
    idempotencyKey: string;
  } | null>(null);
  const [pollingStatus, setPollingStatus] = useState<"polling" | "paid" | "expired" | "timeout" | "reconciliation">("polling");
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStoppedRef = useRef(false);
  // React state alone cannot stop two clicks in the same render frame. Keep a
  // synchronous lock so one user action can create at most one provider order.
  const createInFlightRef = useRef(false);

  // Read the same public exchange rate and payment configuration as checkout.
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setConfigLoading(true);
    setCreditsConfigReady(false);
    setPaymentConfigReady(false);
    setPaymentMethods(DEFAULT_PAYMENT_METHODS);
    const rulesRequest = fetch('/api/credits/rules')
      .then(res => { if (!res.ok) throw new Error('积分规则加载失败'); return res.json(); })
      .then(data => {
        if (disposed) return;
        const value = Number(data.creditsPerYuan ?? data.rules?.creditsPerYuan);
        if (!Number.isFinite(value) || value <= 0) throw new Error('积分规则无效');
        setCreditsPerYuan(value); setCreditsConfigReady(true);
      }).catch(() => { if (!disposed) setCreditsConfigReady(false); });
    const methodsRequest = fetch('/api/payment/methods')
      .then(res => { if (!res.ok) throw new Error('支付方式加载失败'); return res.json(); })
      .then(data => {
        if (disposed) return;
        if (!Array.isArray(data.methods) || !data.methods.length) throw new Error('没有可用支付方式');
        const methods = data.methods.map((m: { id: string; name: string; code: string; icon: string; provider: string; is_active: boolean; sort_order: number }) => ({
          id: m.id, label: m.name, icon: m.icon || 'wallet', available: m.is_active !== false, code: m.code, provider: m.provider || 'xunhupay',
        }));
        setPaymentMethods(methods); setPaymentConfigReady(methods.some((method: PaymentMethodConfig) => method.available));
      }).catch(() => { if (!disposed) { setPaymentMethods(DEFAULT_PAYMENT_METHODS); setPaymentConfigReady(false); } });
    void Promise.allSettled([rulesRequest, methodsRequest]).then(() => { if (!disposed) setConfigLoading(false); });
    return () => { disposed = true; };
  }, [open]);

  // 当支付方式列表变化时，确保当前选择有效
  useEffect(() => {
    const activeMethods = paymentMethods.filter(m => m.available);
    if (activeMethods.length > 0 && !activeMethods.some(m => m.id === paymentMethod)) {
      setPaymentMethod(activeMethods[0].id);
    }
  }, [paymentMethods, paymentMethod]);

  // 弹窗关闭时重置状态
  useEffect(() => {
    if (!open) {
      setPaymentView("form");
      setQrcodeData(null);
      setResult(null);
      setPollingStatus("polling");
      pollStoppedRef.current = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
  }, [open]);

  const activeTab = tab;

  // 积分充值：金额选项（元），100元=5000积分
  const creditPresets = [100, 200, 500, 1000];
  // 现金充值：金额选项（元）
  const cashPresets = [10, 50, 100, 200, 500, 1000];

  // 计算实际支付金额（元）
  const getPayAmount = (): number => {
    if (!customAmount) return 0;
    const val = parseFloat(customAmount);
    if (isNaN(val) || val <= 0) return 0;
    if (activeTab === "credits") {
      if (val < CREDITS_MIN_YUAN) return 0;
      return val;
    }
    if (val < CASH_MIN_YUAN) return 0;
    return val;
  };

  // 根据支付金额计算获得的积分
  const getCreditsFromYuan = (yuan: number): number => yuan * creditsPerYuan;

  const handlePresetClick = (amount: number) => {
    setCustomAmount(String(amount));
    setResult(null);
  };

  const handleTabChange = (newTab: "credits" | "cash") => {
    setTab(newTab);
    setCustomAmount("");
    setResult(null);
  };

  // 从服务器刷新余额（含重试机制）
  const refreshBalance = useCallback(async (type: string) => {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const token = localStorage.getItem("auth_token");
        const authUser = localStorage.getItem("auth_user");
        const userId = authUser ? JSON.parse(authUser).id : null;
        if (!userId || !token) {
          console.warn("[refreshBalance] 缺少认证信息，跳过刷新");
          return;
        }

        const res = await fetch(`/api/credits?user_id=${userId}&include_transactions=0`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        
        if (!res.ok) {
          console.warn(`[refreshBalance] API返回${res.status}，第${attempt}次重试`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
          }
          return;
        }
        
        const data = await res.json();
        // 严格按充值类型刷新对应余额，双轨计费系统隔离
        if (type === "credits") {
          if (onCreditsUpdated && data.credits !== undefined) {
            onCreditsUpdated(data.credits);
          }
        } else if (type === "cash") {
          if (onCashUpdated && data.cashBalance !== undefined) {
            onCashUpdated(data.cashBalance);
          }
        }
        return; // 成功，退出重试循环
      } catch (err) {
        console.warn(`[refreshBalance] 第${attempt}次刷新失败:`, err);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    }
  }, [onCreditsUpdated, onCashUpdated]);

  // 轮询订单状态
  const startPolling = useCallback((tradeOrderId: string, type: string, idempotencyKey?: string) => {
    const stableIdempotencyKey = idempotencyKey || currentPaymentIdempotencyKey();
    let tries = 0;
    const maxTries = 60; // 最多轮询60次，约3分钟
    pollStoppedRef.current = false;

    const poll = async () => {
      if (pollStoppedRef.current || tries >= maxTries) {
        if (!pollStoppedRef.current) {
          setPollingStatus("timeout");
        }
        return;
      }
      tries++;

      try {
        const token = localStorage.getItem("auth_token");
        const res = await fetch(
          `/api/payment/status?order=${tradeOrderId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await res.json();

        if (data.order?.status === "paid" && data.order?.balance_credited === true) {
          pollStoppedRef.current = true;
          if (stableIdempotencyKey) clearPaymentIdempotencyKey(stableIdempotencyKey);
          setPollingStatus("paid");
          setPaymentView("success");
          refreshBalance(type);
          // 2秒后自动关闭弹窗返回主界面
          setTimeout(() => {
            onOpenChange(false);
          }, 2000);
          return;
        }

        if (data.order?.status === "reconciliation_required"
          || data.order?.settlement_status === "reconciliation_required") {
          pollStoppedRef.current = true;
          setPollingStatus("reconciliation");
          return;
        }

        if (data.order?.status === "failed" || data.order?.status === "expired") {
          pollStoppedRef.current = true;
          if (stableIdempotencyKey) clearPaymentIdempotencyKey(stableIdempotencyKey);
          setPollingStatus("expired");
          reportPaymentCallbackMissing(tradeOrderId, type);
          return;
        }
      } catch {
        // 轮询出错继续
      }

      pollTimerRef.current = setTimeout(poll, 3000);
    };

    // 首次轮询2秒后发起（加速主动检测介入），后续3秒间隔
    pollTimerRef.current = setTimeout(poll, 2000);
  }, [refreshBalance, onOpenChange]);

  const handleRecharge = async () => {
    if (createInFlightRef.current) return;

    const payAmount = getPayAmount();
    const selectedMethod = paymentMethods.find(m => m.id === paymentMethod && m.available);
    if (payAmount <= 0 || !paymentConfigReady || !selectedMethod || (activeTab === "credits" && !creditsConfigReady)) {
      setResult({ success: false, message: "充值配置尚未就绪，请稍后重试或联系管理员" });
      return;
    }

    createInFlightRef.current = true;
    setLoading(true);
    setResult(null);

    try {
      // 从当前选中的支付方式获取 code 和 provider
      const payCode = selectedMethod.code;
      const provider = selectedMethod.provider;
      const methodLabel = selectedMethod.label;

      const token = localStorage.getItem("auth_token");
      const authUser = localStorage.getItem("auth_user");
      let userId = "unknown";
      try {
        userId = String(authUser ? JSON.parse(authUser).id || "unknown" : "unknown");
      } catch {
        userId = "unknown";
      }
      const paymentIntent = [
        userId,
        activeTab,
        payAmount.toFixed(2),
        selectedMethod.id,
        payCode,
        provider || "",
      ].join("|");
      const idempotencyKey = getOrCreatePaymentIdempotencyKey(paymentIntent);
      const res = await fetch("/api/payment/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          type: activeTab,
          amount: payAmount,
          paymentMethodId: selectedMethod.id,
          paymentMethod: payCode,
          provider,
        }),
      });

      const data = await res.json();

      if (data.paymentUrl || data.qrcodeUrl) {
        // 切换到二维码支付视图
        setQrcodeData({
          tradeOrderId: data.tradeOrderId,
          paymentUrl: data.paymentUrl || "",
          qrcodeUrl: data.qrcodeUrl || "",
          payAmount,
          payType: activeTab,
          methodLabel,
          idempotencyKey,
        });
        setPaymentView("qrcode");
        setPollingStatus("polling");
        // 开始轮询订单状态
        startPolling(data.tradeOrderId, activeTab, idempotencyKey);
      } else {
        if (data.code === "PAYMENT_CREATE_IDEMPOTENCY_CONFLICT") {
          clearPaymentIdempotencyKey(idempotencyKey);
        }
        setResult({
          success: false,
          message: data.error || "创建订单失败",
        });
        reportPaymentCreateFailed(activeTab || "credits", data.error || "创建订单失败");
      }
    } catch {
      setResult({ success: false, message: "网络错误，请重试" });
      reportPaymentCreateFailed(activeTab || "credits", "网络错误，创建订单异常");
    } finally {
      createInFlightRef.current = false;
      setLoading(false);
    }
  };

  // 手动刷新余额检查（二维码页面的刷新按钮）
  const handleManualCheck = async () => {
    if (!qrcodeData) return;
    setCheckingBalance(true);
    try {
      const token = localStorage.getItem("auth_token");
      // 先查订单状态；后端按支付渠道核验回调或平台订单证据。
      const res = await fetch(`/api/payment/status?order=${qrcodeData.tradeOrderId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.order?.status === "paid" && data.order?.balance_credited === true) {
        clearPaymentIdempotencyKey(qrcodeData.idempotencyKey);
        setPollingStatus("paid");
        setPaymentView("success");
        void refreshBalance(qrcodeData.payType);
        setTimeout(() => {
          onOpenChange(false);
        }, 2000);
        return;
      }
      if (data.order?.status === "reconciliation_required"
        || data.order?.settlement_status === "reconciliation_required") {
        pollStoppedRef.current = true;
        setPollingStatus("reconciliation");
        return;
      }
      // 订单证据是唯一成功依据。不能用“余额增加”推断当前订单成功，
      // 因为管理员加款或另一笔充值也会改变余额并造成错误归因。
      setPollingStatus("polling");
      if (data.order?.status === "pending") {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        startPolling(qrcodeData.tradeOrderId, qrcodeData.payType);
      }
    } catch {
      // 查询失败
    } finally {
      setCheckingBalance(false);
    }
  };

  // 返回充值表单
  const handleBackToForm = () => {
    pollStoppedRef.current = true;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setPaymentView("form");
    setQrcodeData(null);
    setPollingStatus("polling");
  };

  const payAmount = getPayAmount();

  // 获取当前选中支付方式的标签
  const selectedMethodObj = paymentMethods.find(m => m.id === paymentMethod);
  const currentMethodIcon = selectedMethodObj?.icon || "wechat";
  const canCreatePayment = paymentConfigReady
    && Boolean(selectedMethodObj?.available)
    && (activeTab === "cash" || creditsConfigReady);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px] p-0 overflow-hidden">
        {/* ========== 表单视图 ========== */}
        {paymentView === "form" && (
          <>
            {/* Header */}
            <DialogHeader className="px-6 pt-6 pb-0">
              <DialogTitle className="flex items-center gap-2 text-lg">
                <CreditCard className="w-5 h-5 text-[var(--primary)]" />
                充值中心
              </DialogTitle>
            </DialogHeader>

            {/* Tab 切换 - 积分/现金 */}
            {showCreditsTab && showCashTab && (
              <div className="px-6 pt-3">
                <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
                  <button
                    className={`flex-1 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
                      activeTab === "credits"
                        ? "bg-[var(--primary)] text-white"
                        : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--foreground)]"
                    }`}
                    onClick={() => handleTabChange("credits")}
                  >
                    <Coins className="w-3.5 h-3.5" />
                    积分充值
                  </button>
                  <button
                    className={`flex-1 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1.5 ${
                      activeTab === "cash"
                        ? "bg-[var(--primary)] text-white"
                        : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--foreground)]"
                    }`}
                    onClick={() => handleTabChange("cash")}
                  >
                    <Wallet className="w-3.5 h-3.5" />
                    现金充值
                  </button>
                </div>
              </div>
            )}

            {/* 余额展示 — 统一卡片 */}
            <div className="px-6 pt-3">
              <div className="rounded-xl p-3 border border-[var(--border)]"
                style={{ background: "color-mix(in srgb, var(--primary) 8%, transparent)" }}>
                <div className="flex items-center gap-4">
                  {showCreditsTab && (
                    <div className={`flex-1 ${showCashTab ? "border-r border-[var(--border)] pr-4" : ""}`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Coins className="w-3.5 h-3.5 text-[var(--primary)]" />
                        <span className="text-xs text-[var(--text-secondary)]">积分余额</span>
                      </div>
                      <span className="text-xl font-bold text-[var(--primary)]">{credits.toLocaleString()}</span>
                    </div>
                  )}
                  {showCashTab && (
                    <div className={`flex-1 ${showCreditsTab ? "pl-4" : ""}`}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <Wallet className="w-3.5 h-3.5 text-[var(--primary)]" />
                        <span className="text-xs text-[var(--text-secondary)]">现金余额</span>
                      </div>
                      <span className="text-xl font-bold text-[var(--primary)]">¥{cashBalance.toFixed(2)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 充值说明 */}
            <div className="px-6 pt-2">
              <p className="text-xs text-[var(--text-secondary)]">
                {activeTab === "credits"
                  ? `积分用于智能体对话、配音等服务，100元 = ${getCreditsFromYuan(100).toLocaleString()}积分，最低${CREDITS_MIN_YUAN}元起充`
                  : `现金用于视频/封面生成，最低${CASH_MIN_YUAN}元起充`}
              </p>
            </div>

            {/* 快捷金额 */}
            <div className="px-6 pt-3">
              <div className="grid grid-cols-2 gap-2">
                {(activeTab === "credits" ? creditPresets : cashPresets).map((preset) => (
                  <button
                    key={preset}
                    className={`py-2.5 rounded-lg text-sm font-medium border transition-all ${
                      customAmount === String(preset)
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : "border-[var(--border)] hover:border-[var(--primary)]/50 text-[var(--foreground)]"
                    }`}
                    onClick={() => handlePresetClick(preset)}
                  >
                    {activeTab === "credits"
                      ? `¥${preset} → ${getCreditsFromYuan(preset).toLocaleString()}积分`
                      : `¥${preset}`}
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义金额 */}
            <div className="px-6 pt-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-secondary)]">
                  ¥
                </span>
                <Input
                  type="number"
                  placeholder="输入金额（元）"
                  value={customAmount}
                  onChange={(e) => { setCustomAmount(e.target.value); setResult(null); }}
                  className="pl-8 pr-12 h-10"
                  min={activeTab === "credits" ? CREDITS_MIN_YUAN : CASH_MIN_YUAN}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-secondary)]">
                  元
                </span>
              </div>
              {customAmount && payAmount > 0 && (
                <p className="text-xs mt-1.5 text-[var(--text-secondary)]">
                  {activeTab === "credits"
                    ? <>需支付：<span className="font-semibold text-[var(--primary)]">¥{payAmount.toFixed(2)}</span>，获得 <span className="font-semibold text-[var(--primary)]">{getCreditsFromYuan(payAmount).toLocaleString()}</span> 积分</>
                    : <>需支付：<span className="font-semibold text-[var(--primary)]">¥{payAmount.toFixed(2)}</span></>}
                </p>
              )}
              {customAmount && payAmount <= 0 && (
                <p className="text-xs mt-1.5 text-red-500">
                  {activeTab === "credits" ? `最低${CREDITS_MIN_YUAN}元起充` : `最低${CASH_MIN_YUAN}元起充`}
                </p>
              )}
            </div>

            {/* 支付方式选择 */}
            <div className="px-6 pt-3">
              <p className="text-xs text-[var(--text-secondary)] mb-2">支付方式</p>
              <div className="flex gap-2">
                {paymentMethods.map((method) => (
                  <button
                    key={method.id}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                      paymentMethod === method.id
                        ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]"
                        : method.available
                        ? "border-[var(--border)] hover:border-[var(--primary)]/50 text-[var(--foreground)]"
                        : "border-[var(--border)] text-[var(--text-secondary)] opacity-50 cursor-not-allowed"
                    }`}
                    onClick={() => method.available && setPaymentMethod(method.id)}
                    disabled={!method.available}
                  >
                    {/* 微信图标 */}
                    {method.icon === "wechat" && (
                      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                        <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.158 6.158 0 0 1-.235-1.676c0-3.793 3.527-6.87 7.879-6.87.243 0 .482.012.718.031C17.084 4.635 13.227 2.188 8.691 2.188zm-2.87 4.401a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988zm5.742 0a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988zM16.88 9.188c-3.868 0-7.005 2.666-7.005 5.953 0 3.286 3.137 5.952 7.005 5.952.78 0 1.54-.113 2.27-.316a.717.717 0 0 1 .586.078l1.478.869a.264.264 0 0 0 .137.044c.131 0 .24-.108.24-.24 0-.059-.023-.117-.039-.174l-.305-1.147a.488.488 0 0 1 .175-.546C23.016 18.553 24 16.932 24 15.14c0-3.287-3.137-5.953-7.12-5.953zm-2.79 3.338a.823.823 0 1 1 0 1.646.823.823 0 0 1 0-1.646zm5.58 0a.823.823 0 1 1 0 1.646.823.823 0 0 1 0-1.646z"/>
                      </svg>
                    )}
                    {/* 支付宝图标 */}
                    {method.icon === "alipay" && (
                      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                        <path d="M21.422 15.358c-1.585-.697-3.455-1.428-3.455-1.428s1.265-2.398 1.576-4.236H13.88V8.013h6.27V6.87h-6.27V3.5h-2.19s-.062.015-.062.073V6.87H5.46v1.143h6.168v1.681H7.16v1.084h9.223c-.244 1.187-.913 2.754-.913 2.754s-3.166-1.143-5.232-1.143c-3.166 0-4.89 1.681-4.89 3.362 0 2.108 1.944 3.627 5.03 3.627 2.559 0 4.677-1.252 6.229-3.088 2.3 1.143 6.412 2.754 6.412 2.754V24H2.4A2.4 2.4 0 0 1 0 21.6V2.4A2.4 2.4 0 0 1 2.4 0h19.2A2.4 2.4 0 0 1 24 2.4v19.2a2.4 2.4 0 0 1-.634 1.602c-.008.008-1.944-2.376-1.944-2.376v-5.468zM8.972 17.943c-2.743 0-3.965-1.18-3.965-2.643 0-1.464 1.467-2.602 3.728-2.602 1.952 0 3.905.72 3.905.72-1.22 2.522-2.258 4.525-3.668 4.525z"/>
                      </svg>
                    )}
                    {/* QQ钱包图标 */}
                    {method.icon === "qqpay" && (
                      <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current text-sky-400">
                        <circle cx="12" cy="12" r="10"/><text x="12" y="16" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">Q</text>
                      </svg>
                    )}
                    {method.label}
                    {!method.available && (
                      <span className="text-[10px] opacity-60 ml-0.5">暂未开通</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* 结果提示 */}
            {result && (
              <div className={`mx-6 p-3 rounded-lg flex items-start gap-2 ${
                result.success
                  ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                  : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
              }`}>
                {result.success ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
                )}
                <div className="flex-1">
                  <span className="text-sm">{result.message}</span>
                </div>
              </div>
            )}

            {/* 充值按钮 */}
            <div className="px-6 pb-6 pt-3">
              <Button
                className="w-full h-11 text-base font-semibold"
                onClick={handleRecharge}
                disabled={loading || payAmount <= 0 || !canCreatePayment}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    正在创建订单...
                  </>
                ) : configLoading ? (
                  "正在读取充值配置…"
                ) : !canCreatePayment ? (
                  "充值配置暂不可用"
                ) : payAmount > 0 ? (
                  <>
                    <CreditCard className="w-4 h-4 mr-2" />
                    立即充值 ¥{payAmount.toFixed(2)}
                  </>
                ) : (
                  `选择充值金额`
                )}
              </Button>
            </div>
          </>
        )}

        {/* ========== 二维码支付视图 ========== */}
        {paymentView === "qrcode" && qrcodeData && (
          <>
            {/* Header with back button */}
            <DialogHeader className="px-6 pt-6 pb-0">
              <DialogTitle className="flex items-center gap-2 text-lg">
                <button
                  onClick={handleBackToForm}
                  className="p-1 rounded-md hover:bg-[var(--border)] transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                {qrcodeData.methodLabel}
              </DialogTitle>
            </DialogHeader>

            <div className="px-6 pt-4 pb-6">
              {/* 支付金额 */}
              <div className="text-center mb-4">
                <p className="text-sm text-[var(--text-secondary)]">
                  {qrcodeData.payType === "credits" ? "积分充值" : "现金充值"}
                </p>
                <p className="text-3xl font-bold text-[var(--foreground)] mt-1">
                  ¥{qrcodeData.payAmount.toFixed(2)}
                </p>
              </div>

              {/* 二维码区域 */}
              <div className="flex justify-center mb-4">
                <div className="relative bg-white rounded-xl p-4 shadow-sm">
                  {/* 如果有qrcodeUrl(迅虎支付返回的图片)，使用图片；否则用QRCodeSVG生成 */}
                  {qrcodeData.qrcodeUrl ? (
                    <img
                      src={qrcodeData.qrcodeUrl}
                      alt="支付二维码"
                      className="w-[200px] h-[200px]"
                    />
                  ) : (
                    <QRCodeSVG
                      value={qrcodeData.paymentUrl}
                      size={200}
                      level="H"
                      includeMargin={false}
                      imageSettings={
                        currentMethodIcon === "wechat"
                          ? {
                              src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIj48cGF0aCBkPSJNOC42OTEgMi4xODhDMy44OTEgMi4xODggMCA1LjQ3NiAwIDkuNTNjMCAyLjIxMiAxLjE3IDQuMjAzIDMuMDAyIDUuNTVhLjU5LjU5IDAgMCAxIC4yMTMuNjY1bC0uMzkgMS40OGMtLjAxOS4wNy0uMDQ4LjE0MS0uMDQ4LjIxMyAwIC4xNjMuMTMuMjk1LjI5LjI5NWEuMzI2LjMyNiAwIDAgMCAuMTY3LS4wNTRsMS45MDMtMS4xMTRhLjg2NC44NjQgMCAwIDEgLjcxNy0uMDk4IDEwLjE2IDEwLjE2IDAgMCAwIDIuODM3LjQwM2MuMjc2IDAgLjU0My0uMDI3LjgxMS0uMDVhNi4xNTggNi4xNTggMCAwIDEtLjIzNS0xLjY3NmMwLTMuNzkzIDMuNTI3LTYuODcgNy44NzktNi44Ny4yNDMgMCAuNDgyLjAxMi43MTguMDMxQzE3LjA4NCA0LjYzNSAxMy4yMjcgMi4xODggOC42OTEgMi4xODh6bS0yLjg3IDQuNDAxYS45OTQuOTk0IDAgMSAxIDAgMS45ODguOTk0Ljk5NCAwIDAgMSAwLTEuOTg4em01Ljc0MiAwYS45OTQuOTk0IDAgMSAxIDAgMS45ODguOTk0Ljk5NCAwIDAgMSAwLTEuOTg4ek0xNi44OCA5LjE4OGMtMy44NjggMC03LjAwNSAyLjY2Ni03LjAwNSA1Ljk1MyAwIDMuMjg2IDMuMTM3IDUuOTUyIDcuMDA1IDUuOTUyLjc4IDAgMS41NC0uMTEzIDIuMjctLjMxNmEuNzE3LjcxNyAwIDAgMSAuNTg2LjA3OGwxLjQ3OC44NjlhLjI2NC4yNjQgMCAwIDAgLjEzNy4wNDRjLjEzMSAwIC4yNC0uMTA4LjI0LS4yNCAwLS4wNTktLjAyMy0uMTE3LS4wMzktLjE3NGwtLjMwNS0xLjE0N2EuNDg4LjQ4OCAwIDAgMSAuMTc1LS41NDZDMjMuMDE2IDE4LjU1MyAyNCAxNi45MzIgMjQgMTUuMTRjMC0zLjI4Ny0zLjEzNy01Ljk1My03LjEyLTUuOTUzem0tMi43OSAzLjMzOGEuODIzLjgyMyAwIDEgMSAwIDEuNjQ2LjgyMy44MjMgMCAwIDEgMC0xLjY0NnptNS41OCAwYS44MjMuODIzIDAgMSAxIDAgMS42NDYuODIzLjgyMyAwIDAgMSAwLTEuNjQ2eiIgZmlsbD0iIzA3YzE2MiIvPjwvc3ZnPg==",
                              height: 32,
                              width: 32,
                              excavate: true,
                            }
                          : undefined
                      }
                    />
                  )}
                  {/* 支付方式图标叠加 */}
                  {qrcodeData.qrcodeUrl && currentMethodIcon === "wechat" && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-white rounded-lg flex items-center justify-center shadow-sm border border-gray-100">
                      <svg viewBox="0 0 24 24" className="w-6 h-6 fill-[#07c160]">
                        <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.158 6.158 0 0 1-.235-1.676c0-3.793 3.527-6.87 7.879-6.87.243 0 .482.012.718.031C17.084 4.635 13.227 2.188 8.691 2.188zm-2.87 4.401a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988zm5.742 0a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988z"/>
                      </svg>
                    </div>
                  )}
                </div>
              </div>

              {/* 扫码提示 */}
              <div className="text-center mb-3">
                <p className="text-sm font-medium text-[var(--foreground)]">
                  请使用{qrcodeData.methodLabel === "微信支付" ? "微信" : "支付宝"}扫描二维码完成支付
                </p>
              </div>

              {/* 扫码说明 */}
              <div className="bg-[var(--muted)]/50 rounded-lg p-3 mb-3">
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                  {currentMethodIcon === "wechat" ? (
                    <>
                      请打开微信 → 右上角「+」→ 扫一扫，扫描上方二维码完成支付。
                      微信不支持长按识别相册二维码，请直接扫码或在微信内打开本站。
                    </>
                  ) : (
                    <>
                      请打开支付宝 → 首页「扫一扫」，扫描上方二维码完成支付。
                    </>
                  )}
                </p>
              </div>

              {/* 轮询状态 */}
              <div className="flex items-center justify-center gap-2 mb-3">
                {pollingStatus === "polling" && (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--primary)]" />
                    <span className="text-xs text-[var(--text-secondary)]">等待支付确认中...</span>
                  </>
                )}
                {pollingStatus === "expired" && (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-red-500" />
                    <span className="text-xs text-red-500">订单已过期，请重新创建</span>
                  </>
                )}
                {pollingStatus === "timeout" && (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-yellow-500" />
                    <span className="text-xs text-yellow-600">确认超时，如已支付请点击下方按钮查询到账结果</span>
                  </>
                )}
                {pollingStatus === "reconciliation" && (
                  <>
                    <XCircle className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-xs text-amber-600">支付记录已收到，但到账证据仍在核对，请勿重复支付</span>
                  </>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex gap-2">
                {(pollingStatus === "timeout" || pollingStatus === "expired") && (
                  <Button
                    variant="outline"
                    className="flex-1 h-9 text-sm"
                    onClick={handleBackToForm}
                  >
                    重新充值
                  </Button>
                )}
                <Button
                  className="flex-1 h-9 text-sm"
                  onClick={handleManualCheck}
                  disabled={checkingBalance || pollingStatus === "paid"}
                  variant={pollingStatus === "polling" ? "outline" : "default"}
                >
                  {checkingBalance ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      查询中...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                      刷新支付结果
                    </>
                  )}
                </Button>
              </div>

              {/* 客服联系方式 */}
              <div className="mt-4 pt-3 border-t border-[var(--border)] text-center">
                <p className="text-xs text-[var(--text-secondary)]">
                  充值遇到问题请联系管理员
                </p>
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                  微信：<span className="text-[var(--primary)] font-medium">Yuange1991xx</span>
                </p>
              </div>
            </div>
          </>
        )}

        {/* ========== 支付成功视图 ========== */}
        {paymentView === "success" && (
          <div className="px-6 py-10 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">充值成功</h2>
            {qrcodeData && (
              <p className="text-[var(--text-secondary)] text-sm mb-1">
                {qrcodeData.payType === "credits" ? "积分充值" : "现金充值"} ¥{qrcodeData.payAmount.toFixed(2)}
              </p>
            )}
            <p className="text-green-400 text-sm mb-4">余额已自动到账，即将返回主页面...</p>
            <Button
              className="bg-[var(--primary)] text-white hover:opacity-90"
              onClick={() => onOpenChange(false)}
            >
              返回
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
