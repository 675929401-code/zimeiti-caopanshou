"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

function PaymentResultContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "failed" | "pending" | "checking" | "invalid" | "reconciliation">("loading");
  const [orderInfo, setOrderInfo] = useState<{ amount: number; type: string; tradeOrderId: string } | null>(null);

  useEffect(() => {
    // 创建订单时 returnUrl 格式: ${baseUrl}/payment/result?order=${tradeOrderId}
    // 迅虎支付回调也会带上 order_id 参数，需要兼容
    const tradeOrderId = searchParams.get("order") || searchParams.get("order_id");
    if (!tradeOrderId) {
      setStatus("invalid");
      return;
    }

    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 90; // 最多轮询90次，约3分钟（2秒间隔）

    const checkStatus = async () => {
      if (cancelled) return;
      retryCount++;

      try {
        const token = localStorage.getItem("auth_token") || "";
        const res = await fetch(`/api/payment/status?order=${tradeOrderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();

        // API 返回格式: { success: true, order: { status, amount, type, trade_order_id, ... } }
        const order = data.order;

        if (order?.status === "paid" && order?.balance_credited === true) {
          if (!cancelled) {
            setStatus("success");
            setOrderInfo({
              amount: Number(order.amount) || 0,
              type: order.type,
              tradeOrderId: order.trade_order_id,
            });
          }
        } else if (order?.status === "reconciliation_required"
          || order?.settlement_status === "reconciliation_required") {
          if (!cancelled) {
            setStatus("reconciliation");
            setOrderInfo({
              amount: Number(order.amount) || 0,
              type: order.type || "",
              tradeOrderId: order.trade_order_id || tradeOrderId,
            });
          }
        } else if (order?.status === "pending") {
          // 还在处理中，继续轮询
          if (!cancelled && retryCount < maxRetries) {
            setTimeout(checkStatus, 2000);
          } else if (!cancelled) {
            // 超时，但不是失败——让用户可以手动刷新
            setStatus("pending");
          }
        } else {
          if (!cancelled) {
            setStatus("failed");
            setOrderInfo({
              amount: Number(order?.amount) || 0,
              type: order?.type || "",
              tradeOrderId: order?.trade_order_id || tradeOrderId,
            });
          }
        }
      } catch {
        if (!cancelled && retryCount < maxRetries) {
          setTimeout(checkStatus, 2000);
        } else if (!cancelled) {
          setStatus("failed");
        }
      }
    };

    checkStatus();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  // 手动刷新余额检查
  const handleManualCheck = () => {
    setStatus("checking");
    const tradeOrderId = searchParams.get("order") || searchParams.get("order_id");
    if (!tradeOrderId) { setStatus("invalid"); return; }

    (async () => {
      try {
        const token = localStorage.getItem("auth_token") || "";
        const res = await fetch(`/api/payment/status?order=${tradeOrderId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        const order = data.order;

        if (order?.status === "paid" && order?.balance_credited === true) {
          setStatus("success");
          setOrderInfo({
            amount: Number(order.amount) || 0,
            type: order.type,
            tradeOrderId: order.trade_order_id,
          });
        } else if (order?.status === "reconciliation_required"
          || order?.settlement_status === "reconciliation_required") {
          setStatus("reconciliation");
          setOrderInfo({
            amount: Number(order.amount) || 0,
            type: order.type || "",
            tradeOrderId: order.trade_order_id || tradeOrderId,
          });
        } else if (order?.status === "pending") {
          setStatus("pending");
        } else {
          setStatus("failed");
        }
      } catch {
        setStatus("failed");
      }
    })();
  };

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
              <p className="text-green-400 text-sm mb-1">余额已自动到账</p>
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
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-2">支付确认中</h2>
              <p className="text-[var(--muted-foreground)] text-sm mb-2">如已完成支付，余额会自动到账</p>
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
                onClick={() => router.push("/video")}
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
