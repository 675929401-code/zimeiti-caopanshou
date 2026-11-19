"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { notifyPaymentCredited, readPaymentWallet, type PaymentWallet } from "@/lib/payment-wallet-client";
import { useApp } from "@/contexts/app-context";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

function PaymentResultContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "failed" | "pending" | "checking" | "invalid" | "expired" | "reconciliation">("loading");
  const [attempt, setAttempt] = useState(0);
  const [wallet, setWallet] = useState<PaymentWallet | null>(null);
  const [walletPending, setWalletPending] = useState(false);
  const [orderInfo, setOrderInfo] = useState<{ amount: number; type: string; tradeOrderId: string } | null>(null);

  const tradeOrderId = searchParams.get("order") || searchParams.get("order_id");
  const { state: { auth } } = useApp();
  const actorToken = auth.token || "";
  const actorId = auth.user?.id;
  useEffect(() => {
    setOrderInfo(null);
    setWallet(null);
    setWalletPending(false);
    if (!tradeOrderId) { setStatus("invalid"); return; }
    if (!actorToken || !actorId) { setStatus("failed"); return; }
    setStatus(attempt ? "checking" : "loading");
    let active = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const current = () => active && localStorage.getItem("auth_token") === actorToken;
    const check = async () => {
      if (!current()) return;
      tries++;
      try {
        const response = await fetch(`/api/payment/status?order=${encodeURIComponent(tradeOrderId)}`, {
          headers: { Authorization: `Bearer ${actorToken}` }, cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!current()) return;
        if (response.status >= 500) throw new Error("Status unavailable");
        const { order } = await response.json();
        if (!current()) return;
        if (!response.ok || order?.trade_order_id !== tradeOrderId) { setStatus("failed"); return; }
        setOrderInfo({ amount: Number(order.amount), type: order.type, tradeOrderId });
        if (order?.status === "paid" && order?.balance_credited === true) {
          setStatus("success");
          setWalletPending(true);
          notifyPaymentCredited(actorToken);
          const balance = await readPaymentWallet(actorToken);
          if (current()) { setWallet(balance); setWalletPending(false); }
          return;
        }
        if (order.status === "reconciliation_required" || order.settlement_status === "reconciliation_required") {
          setStatus("reconciliation");
          return;
        }
        if (order.status === "expired") { setStatus("expired"); return; }
        if (order.status !== "pending") { setStatus("failed"); return; }
      } catch {
        if (!current()) return;
        if (tries >= (attempt ? 1 : 90)) { setStatus("failed"); return; }
      }
      if (tries < (attempt ? 1 : 90)) timer = setTimeout(check, 2000);
      else setStatus("pending");
    };
    void check();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [tradeOrderId, attempt, actorToken, actorId]);

  const handleManualCheck = () => setAttempt(value => value + 1);

  return (
    <div className="min-h-screen bg-[var(--background)] flex items-center justify-center p-4">
      <Card className="bg-[var(--card)] border-[var(--border)] w-full max-w-md">
        <CardContent className="p-8 text-center">
          {status === "loading" && (
            <>
              <Loader2 className="w-16 h-16 text-[var(--primary)] mx-auto mb-4 animate-spin" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">支付结果确认中</h2>
              <p className="text-[var(--muted-foreground)] text-sm">正在查询支付结果，请稍候...</p>
            </>
          )}
          {status === "success" && (
            <>
              <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">充值成功</h2>
              {orderInfo && (
                <p className="text-[var(--muted-foreground)] text-sm mb-1">
                  {orderInfo.type === "credits" ? "积分充值" : "现金充值"} ¥{orderInfo.amount}
                </p>
              )}
              <p className="text-sm mb-2 text-[var(--foreground)]" aria-live="polite">{walletPending ? "正在刷新钱包余额…" : wallet
                ? orderInfo?.type === "credits" ? `当前可用积分 ${wallet.credits.toLocaleString("zh-CN")}` : `当前现金余额 ¥${wallet.cashBalance.toFixed(2)}`
                : "订单已到账，钱包余额暂未读取。"}</p>
              {!walletPending && !wallet && <Button variant="outline" onClick={handleManualCheck}>重新读取余额</Button>}
              <p className="text-[var(--muted-foreground)] text-xs mb-6">订单号：{orderInfo?.tradeOrderId}</p>
              <div className="flex gap-3 justify-center">
                <Button
                  onClick={() => router.push("/")}
                  className="bg-[var(--primary)] text-white hover:opacity-90"
                >
                  返回主页
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/video")}
                  className="border-[var(--border)] text-[var(--foreground)]"
                >
                  去生成视频
                </Button>
              </div>
            </>
          )}
          {status === "failed" && (
            <>
              <XCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">暂未确认订单</h2>
              <p className="text-[var(--muted-foreground)] text-sm mb-2">请使用下单时的账号查询；如已付款，请勿重复支付。</p>
              <p className="text-[var(--muted-foreground)] text-xs mb-6">可点击下方按钮手动确认支付结果</p>
              <div className="flex flex-col gap-3 justify-center">
                <Button
                  onClick={handleManualCheck}
                  className="bg-[var(--primary)] text-white hover:opacity-90"
                >
                  刷新支付结果
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/")}
                  className="border-[var(--border)] text-[var(--foreground)]"
                >
                  返回首页
                </Button>
              </div>
            </>
          )}
          {status === "expired" && <>
            <h2 className="text-xl font-semibold mb-2">订单已过期</h2>
            <p className="text-sm mb-4">如已付款，请保留订单号联系管理员核对。</p>
            <p className="text-xs mb-4">{orderInfo?.tradeOrderId}</p>
            <Button variant="outline" onClick={() => router.push("/recharge")}>返回充值页</Button>
          </>}
          {status === "invalid" && (
            <>
              <XCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">缺少订单号</h2>
              <p className="text-[var(--muted-foreground)] text-sm mb-6">当前链接无法查询支付结果，请从订单页重新进入。</p>
              <Button
                variant="outline"
                onClick={() => router.push("/")}
                className="border-[var(--border)] text-[var(--foreground)]"
              >
                返回首页
              </Button>
            </>
          )}
          {status === "pending" && (
            <>
              <Loader2 className="w-16 h-16 text-yellow-500 mx-auto mb-4 animate-spin" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">支付处理中</h2>
              <p className="text-[var(--muted-foreground)] text-sm mb-4">支付正在处理，如已支付成功，余额会自动到账</p>
              <Button
                onClick={handleManualCheck}
                className="bg-[var(--primary)] text-white hover:opacity-90 mb-3"
              >
                刷新支付结果
              </Button>
              <Button
                variant="outline"
                onClick={() => router.push("/")}
                className="border-[var(--border)] text-[var(--foreground)]"
              >
                返回首页
              </Button>
            </>
          )}
          {status === "reconciliation" && (
            <>
              <Loader2 className="w-16 h-16 text-amber-500 mx-auto mb-4 animate-spin" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">到账核对中</h2>
              {orderInfo && (
                <p className="text-[var(--muted-foreground)] text-sm mb-2">
                  {orderInfo.type === "credits" ? "积分充值" : "现金充值"} ¥{orderInfo.amount}
                </p>
              )}
              <p className="text-amber-600 text-sm mb-2">支付记录已收到，但余额到账证据尚不完整</p>
              <p className="text-[var(--muted-foreground)] text-xs mb-2">请勿重复支付，管理员会按供应商回执与钱包账本核对</p>
              <p className="text-[var(--muted-foreground)] text-xs mb-6">订单号：{orderInfo?.tradeOrderId}</p>
              <div className="flex flex-col gap-3 justify-center">
                <Button
                  onClick={handleManualCheck}
                  className="bg-[var(--primary)] text-white hover:opacity-90"
                >
                  刷新到账结果
                </Button>
                <Button
                  variant="outline"
                  onClick={() => router.push("/")}
                  className="border-[var(--border)] text-[var(--foreground)]"
                >
                  返回首页
                </Button>
              </div>
            </>
          )}
          {status === "checking" && (
            <>
              <Loader2 className="w-16 h-16 text-[var(--primary)] mx-auto mb-4 animate-spin" />
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">正在查询支付结果</h2>
              <p className="text-[var(--muted-foreground)] text-sm">请稍候...</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function PaymentResultPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--primary)]" />
      </div>
    }>
      <PaymentResultContent />
    </Suspense>
  );
}
