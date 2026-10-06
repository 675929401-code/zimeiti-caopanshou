"use client";

import { useEffect, useState } from "react";

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const labelCls = "block text-sm text-[var(--secondary-foreground)] mb-1.5";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnPrimary = "px-4 py-2.5 bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-xl text-sm font-semibold hover:bg-[var(--accent)] hover:border-[var(--primary)]/30 transition-colors";

export function PaymentConfigAdminTab({
  token,
  sensitiveUnlocked,
  canViewBilling,
  onRequestUnlock,
}: {
  token: string | null;
  sensitiveUnlocked: boolean;
  canViewBilling: boolean;
  onRequestUnlock: () => void;
}) {
  // 支付方式状态
  const [methods, setMethods] = useState<Array<{
    id: string; name: string; code: string; icon: string; provider: string;
    is_active: boolean; sort_order: number;
    created_at: string; updated_at: string;
  }>>([]);
  const [methodStats, setMethodStats] = useState<Record<string, { total: number; success: number; totalAmount: number }>>({});
  const [methodsLoading, setMethodsLoading] = useState(true);
  const [showMethodForm, setShowMethodForm] = useState(false);
  const [editingMethod, setEditingMethod] = useState<typeof methods[0] | null>(null);
  const [methodForm, setMethodForm] = useState({ name: "", code: "", icon: "wallet", provider: "xunhupay", is_active: true, sort_order: 0 });
  const [methodSaving, setMethodSaving] = useState(false);

  // 订单状态
  const [orders, setOrders] = useState<Array<{
    id: string; user_id: string; trade_order_id: string; type: string;
    amount: number; credits_amount: number | null; status: string;
    payment_method: string; platform_order_id: string | null;
    payment_url: string | null; expire_at: string | null;
    paid_at: string | null; created_at: string;
  }>>([]);
  const [orderSummary, setOrderSummary] = useState<{
    totalOrders: number; totalAmount: number; successAmount: number;
    successCount: number; pendingCount: number;
    byPayType: Record<string, { count: number; amount: number }>;
  }>({ totalOrders: 0, totalAmount: 0, successAmount: 0, successCount: 0, pendingCount: 0, byPayType: {} });
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [orderPage, setOrderPage] = useState(1);
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderStatusFilter, setOrderStatusFilter] = useState("");

  // 迅虎配置
  const [xunhuConfig, setXunhuConfig] = useState({
    xunhu_appid: "", xunhu_secret: "", xunhu_gateway: "",
    xunhu_gateway_backup: "", xunhu_wap_url: "",
    xunhu_refund_gateway: "", xunhu_refund_gateway_backup: "",
    xunhu_secret_configured: false,
  });
  // 易支付配置
  const [epayConfig, setEpayConfig] = useState({
    epay_pid: "", epay_key: "", epay_gateway: "",
    epay_key_configured: false,
  });
  const [configSaving, setConfigSaving] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState("");

  const loadMethods = async () => {
    if (!token || !sensitiveUnlocked) {
      setMethods([]);
      setMethodStats({});
      setShowMethodForm(false);
      setEditingMethod(null);
      setMethodsLoading(false);
      return;
    }
    try {
      setMethodsLoading(true);
      const res = await fetch("/api/admin/payment-methods", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMethods(data.methods || []);
        setMethodStats(data.stats || {});
      }
    } catch (err) {
      console.error("加载支付方式失败:", err);
    } finally {
      setMethodsLoading(false);
    }
  };

  const loadOrders = async (page: number = 1, status: string = "") => {
    if (!token || !canViewBilling) {
      setOrdersLoading(false);
      return;
    }
    try {
      setOrdersLoading(true);
      let url = `/api/admin/payment-orders?page=${page}&pageSize=20`;
      if (status) url += `&status=${status}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setOrders(data.orders || []);
        setOrderTotal(data.total || 0);
        setOrderPage(page);
        setOrderSummary(data.summary || { totalOrders: 0, totalAmount: 0, successAmount: 0, successCount: 0, pendingCount: 0, byPayType: {} });
      }
    } catch (err) {
      console.error("加载订单失败:", err);
    } finally {
      setOrdersLoading(false);
    }
  };

  // 加载支付渠道配置
  const loadPaymentConfig = async () => {
    if (!token || !sensitiveUnlocked) {
      setConfigLoaded(false);
      setConfigError("");
      setXunhuConfig({
        xunhu_appid: "", xunhu_secret: "", xunhu_gateway: "",
        xunhu_gateway_backup: "", xunhu_wap_url: "",
        xunhu_refund_gateway: "", xunhu_refund_gateway_backup: "",
        xunhu_secret_configured: false,
      });
      setEpayConfig({
        epay_pid: "", epay_key: "", epay_gateway: "",
        epay_key_configured: false,
      });
      return;
    }
    setConfigLoading(true);
    setConfigError("");
    try {
      const res = await fetch("/api/admin/payment-config", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "支付密钥配置读取失败");
      }
      setXunhuConfig({
        xunhu_appid: data.settings?.xunhu_appid || "",
        xunhu_secret: "",
        xunhu_gateway: data.settings?.xunhu_gateway || "",
        xunhu_gateway_backup: data.settings?.xunhu_gateway_backup || "",
        xunhu_wap_url: data.settings?.xunhu_wap_url || "",
        xunhu_refund_gateway: data.settings?.xunhu_refund_gateway || "",
        xunhu_refund_gateway_backup: data.settings?.xunhu_refund_gateway_backup || "",
        xunhu_secret_configured: data.settings?.xunhu_secret_configured === true,
      });
      setEpayConfig({
        epay_pid: data.settings?.epay_pid || "",
        epay_key: "",
        epay_gateway: data.settings?.epay_gateway || "",
        epay_key_configured: data.settings?.epay_key_configured === true,
      });
      setConfigLoaded(true);
    } catch (err) {
      console.error("加载支付配置失败:", err);
      setConfigLoaded(false);
      setConfigError(err instanceof Error ? err.message : "支付密钥配置读取失败");
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    if (canViewBilling) loadOrders();
    else setOrdersLoading(false);
  // Preserve the original one-shot ledger bootstrap; later paging and filters call loadOrders explicitly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadMethods();
  // Payment methods share the payment.settings.manage step-up boundary. A lock
  // transition must clear the protected snapshot; an unlock transition reads it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensitiveUnlocked, token]);

  useEffect(() => {
    void loadPaymentConfig();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensitiveUnlocked, token]);

  // 保存支付方式
  const handleSaveMethod = async () => {
    if (!token) return;
    if (!sensitiveUnlocked) {
      onRequestUnlock();
      return;
    }
    setMethodSaving(true);
    try {
      const url = editingMethod ? "/api/admin/payment-methods" : "/api/admin/payment-methods";
      const body = editingMethod
        ? { id: editingMethod.id, ...methodForm }
        : methodForm;
      const res = await fetch(url, {
        method: editingMethod ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setShowMethodForm(false);
        setEditingMethod(null);
        setMethodForm({ name: "", code: "", icon: "wallet", provider: "xunhupay", is_active: true, sort_order: 0 });
        loadMethods();
      } else {
        alert(data.error || "保存失败");
      }
    } catch (err) {
      console.error("保存支付方式失败:", err);
      alert("保存失败");
    } finally {
      setMethodSaving(false);
    }
  };

  // 切换启用/禁用
  const handleToggleActive = async (method: typeof methods[0]) => {
    if (!token) return;
    if (!sensitiveUnlocked) {
      onRequestUnlock();
      return;
    }
    const res = await fetch("/api/admin/payment-methods", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: method.id, is_active: !method.is_active }),
    });
    if (res.ok) loadMethods();
  };

  // 删除支付方式
  const handleDeleteMethod = async (id: string) => {
    if (!sensitiveUnlocked) {
      onRequestUnlock();
      return;
    }
    if (!confirm("确定删除该支付方式？")) return;
    const res = await fetch(`/api/admin/payment-methods?id=${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) loadMethods();
  };

  // 编辑支付方式
  const handleEditMethod = (method: typeof methods[0]) => {
    if (!sensitiveUnlocked) {
      onRequestUnlock();
      return;
    }
    setEditingMethod(method);
    setMethodForm({
      name: method.name,
      code: method.code,
      icon: method.icon || "wallet",
      provider: method.provider || "xunhupay",
      is_active: method.is_active,
      sort_order: method.sort_order || 0,
    });
    setShowMethodForm(true);
  };

  // 保存支付渠道配置
  const handleSavePaymentConfig = async (configType: "xunhu" | "epay") => {
    if (!token) return;
    if (!sensitiveUnlocked) {
      setConfigError("请先验证管理员密码，再修改支付密钥配置");
      onRequestUnlock();
      return;
    }
    if (!configLoaded || configLoading) {
      setConfigError("支付配置尚未成功读取，请重新读取后再保存");
      return;
    }
    setConfigSaving(true);
    setConfigError("");
    try {
      const body = configType === "xunhu"
        ? {
            xunhu_appid: xunhuConfig.xunhu_appid,
            xunhu_secret: xunhuConfig.xunhu_secret,
            xunhu_gateway: xunhuConfig.xunhu_gateway,
            xunhu_gateway_backup: xunhuConfig.xunhu_gateway_backup,
            xunhu_wap_url: xunhuConfig.xunhu_wap_url,
            xunhu_refund_gateway: xunhuConfig.xunhu_refund_gateway,
            xunhu_refund_gateway_backup: xunhuConfig.xunhu_refund_gateway_backup,
          }
        : {
            epay_pid: epayConfig.epay_pid,
            epay_key: epayConfig.epay_key,
            epay_gateway: epayConfig.epay_gateway,
          };
      const res = await fetch("/api/admin/payment-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `payment-config-${configType}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        alert(data.warning || (configType === "xunhu" ? "迅虎支付配置已保存" : "易支付配置已保存"));
        if (configType === "xunhu") {
          setXunhuConfig((current) => ({
            ...current,
            xunhu_secret: "",
            xunhu_secret_configured: Boolean(current.xunhu_secret.trim()) || current.xunhu_secret_configured,
          }));
        } else {
          setEpayConfig((current) => ({
            ...current,
            epay_key: "",
            epay_key_configured: Boolean(current.epay_key.trim()) || current.epay_key_configured,
          }));
        }
        await loadPaymentConfig();
      } else {
        if (res.status === 428 || data.code === "ADMIN_STEP_UP_REQUIRED") onRequestUnlock();
        throw new Error(data.error || "保存失败");
      }
    } catch (err) {
      console.error("保存支付配置失败:", err);
      const message = err instanceof Error ? err.message : "保存失败";
      setConfigError(message);
      alert(message);
    } finally {
      setConfigSaving(false);
    }
  };

  // 支付图标映射
  const getPayMethodLabel = (paymentMethod: string) => {
    const pm = paymentMethod?.toLowerCase() || "";
    if (pm === "wechat" || pm === "wxpay") return "微信支付";
    if (pm === "alipay" || pm === "alipay_epay") return "支付宝";
    if (pm === "qqpay") return "QQ钱包";
    return paymentMethod;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "paid": return <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-xs">已支付</span>;
      case "pending": return <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs">待支付</span>;
      case "failed": return <span className="px-2 py-0.5 bg-red-500/20 text-red-400 rounded text-xs">失败</span>;
      case "expired": return <span className="px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded text-xs">已过期</span>;
      default: return <span className="px-2 py-0.5 bg-gray-500/20 text-gray-400 rounded text-xs">{status}</span>;
    }
  };

  return (
    <div className="space-y-6" data-testid="payment-system-control-plane">
      <section className="rounded-2xl border border-[#d0d5dd] bg-white p-5 shadow-sm" data-testid="payment-key-status">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#175cd3]">Payment Control Plane</p>
            <h2 className="mt-1 text-xl font-black text-[#172033]">支付系统</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#667085]">支付方式、商户密钥、下单接口、异步回调和订单对账使用同一套服务端配置。密钥不会回传到浏览器，只显示是否已配置。</p>
          </div>
          <div className={`rounded-full px-3 py-1.5 text-xs font-bold ${sensitiveUnlocked ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            {sensitiveUnlocked ? "密钥配置已临时解锁" : "密钥配置已锁定"}
          </div>
        </div>

        {!sensitiveUnlocked && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3" data-testid="payment-key-step-up-required">
            <div>
              <p className="text-sm font-bold text-amber-900">支付配置没有丢失，需要先验证管理员密码</p>
              <p className="mt-1 text-xs leading-5 text-amber-800">验证后读取商户号、网关地址和密钥配置状态；原密钥始终只保存在服务端。</p>
            </div>
            <button type="button" onClick={onRequestUnlock} className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-bold text-white hover:bg-amber-800">验证密码并读取</button>
          </div>
        )}

        {sensitiveUnlocked && configLoading && (
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-800">正在读取服务端支付配置…</div>
        )}
        {configError && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" data-testid="payment-config-error">
            <span>{configError}</span>
            {sensitiveUnlocked && <button type="button" onClick={() => void loadPaymentConfig()} className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-bold">重新读取</button>}
          </div>
        )}
        {sensitiveUnlocked && configLoaded && !configError && (
          <div className="mt-4 grid gap-3 md:grid-cols-2" data-testid="payment-config-ready">
            <div className="rounded-xl border border-[#eaecf0] bg-[#f9fafb] px-4 py-3"><p className="text-xs text-[#667085]">迅虎支付</p><p className={`mt-1 text-sm font-bold ${xunhuConfig.xunhu_secret_configured ? "text-emerald-700" : "text-amber-700"}`}>{xunhuConfig.xunhu_secret_configured ? "商户密钥已配置" : "商户密钥未配置"}</p></div>
            <div className="rounded-xl border border-[#eaecf0] bg-[#f9fafb] px-4 py-3"><p className="text-xs text-[#667085]">易支付</p><p className={`mt-1 text-sm font-bold ${epayConfig.epay_key_configured ? "text-emerald-700" : "text-amber-700"}`}>{epayConfig.epay_key_configured ? "商户密钥已配置" : "商户密钥未配置"}</p></div>
          </div>
        )}
      </section>

      {/* 迅虎支付配置 */}
      <div className={cardCls}>
        <div className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-[var(--foreground)]">迅虎支付（虎皮椒）配置</h3>
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${xunhuConfig.xunhu_secret_configured ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>{sensitiveUnlocked ? (xunhuConfig.xunhu_secret_configured ? "密钥已配置" : "密钥未配置") : "解锁后读取状态"}</span>
          </div>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">服务端下单、支付回调和退款共用该配置；保存后立即刷新服务端配置缓存。</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>App ID</label>
            <input className={inputCls} value={xunhuConfig.xunhu_appid} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_appid: e.target.value }))} placeholder={sensitiveUnlocked ? "迅虎支付 App ID" : "验证管理员密码后读取"} disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>App Secret</label>
            <input className={inputCls} type="password" value={xunhuConfig.xunhu_secret} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_secret: e.target.value }))} placeholder={!sensitiveUnlocked ? "验证管理员密码后编辑" : xunhuConfig.xunhu_secret_configured ? "已配置；留空保留原密钥" : "输入迅虎支付密钥"} disabled={!sensitiveUnlocked || configLoading} autoComplete="new-password" />
          </div>
          <div>
            <label className={labelCls}>正式网关</label>
            <input className={inputCls} value={xunhuConfig.xunhu_gateway} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_gateway: e.target.value }))} placeholder="https://api.xunhupay.com/payment/do.html" disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>备用网关</label>
            <input className={inputCls} value={xunhuConfig.xunhu_gateway_backup} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_gateway_backup: e.target.value }))} placeholder="https://api.dpweixin.com/payment/do.html" disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>WAP URL（微信H5支付备案域名）</label>
            <input className={inputCls} value={xunhuConfig.xunhu_wap_url} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_wap_url: e.target.value }))} placeholder="https://your-domain.com" disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>退款网关</label>
            <input className={inputCls} value={xunhuConfig.xunhu_refund_gateway} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_refund_gateway: e.target.value }))} placeholder="https://api.xunhupay.com/payment/refund.html" disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>备用退款网关</label>
            <input className={inputCls} value={xunhuConfig.xunhu_refund_gateway_backup} onChange={e => setXunhuConfig(c => ({ ...c, xunhu_refund_gateway_backup: e.target.value }))} placeholder="可选，仅用于明确的人工灾备配置" disabled={!sensitiveUnlocked || configLoading} />
          </div>
        </div>
        <button onClick={() => sensitiveUnlocked ? handleSavePaymentConfig("xunhu") : onRequestUnlock()} disabled={configSaving || configLoading || (sensitiveUnlocked && !configLoaded)} className={`${btnPrimary} mt-4 ${(configSaving || configLoading || (sensitiveUnlocked && !configLoaded)) ? 'opacity-50' : ''}`} data-testid="save-xunhu-payment-config">
          {!sensitiveUnlocked ? "验证密码后配置" : !configLoaded ? "读取配置后保存" : configSaving ? "保存中..." : "保存迅虎配置"}
        </button>
      </div>

      {/* 易支付(EPay)配置 */}
      <div className={cardCls}>
        <div className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-[var(--foreground)]">易支付（EPay）配置</h3>
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${epayConfig.epay_key_configured ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>{sensitiveUnlocked ? (epayConfig.epay_key_configured ? "密钥已配置" : "密钥未配置") : "解锁后读取状态"}</span>
          </div>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">支持微信、支付宝和 QQ 钱包等支付方式；服务端签名和回调验签只读取已保存的密钥。</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>商户PID</label>
            <input className={inputCls} value={epayConfig.epay_pid} onChange={e => setEpayConfig(c => ({ ...c, epay_pid: e.target.value }))} placeholder={sensitiveUnlocked ? "易支付商户 ID" : "验证管理员密码后读取"} disabled={!sensitiveUnlocked || configLoading} />
          </div>
          <div>
            <label className={labelCls}>商户密钥(Key)</label>
            <input className={inputCls} type="password" value={epayConfig.epay_key} onChange={e => setEpayConfig(c => ({ ...c, epay_key: e.target.value }))} placeholder={!sensitiveUnlocked ? "验证管理员密码后编辑" : epayConfig.epay_key_configured ? "已配置；留空保留原密钥" : "输入易支付商户密钥"} disabled={!sensitiveUnlocked || configLoading} autoComplete="new-password" />
          </div>
          <div>
            <label className={labelCls}>网关地址</label>
            <input className={inputCls} value={epayConfig.epay_gateway} onChange={e => setEpayConfig(c => ({ ...c, epay_gateway: e.target.value }))} placeholder="如：https://pay.example.com" disabled={!sensitiveUnlocked || configLoading} />
          </div>
        </div>
        <button onClick={() => sensitiveUnlocked ? handleSavePaymentConfig("epay") : onRequestUnlock()} disabled={configSaving || configLoading || (sensitiveUnlocked && !configLoaded)} className={`${btnPrimary} mt-4 ${(configSaving || configLoading || (sensitiveUnlocked && !configLoaded)) ? 'opacity-50' : ''}`} data-testid="save-epay-payment-config">
          {!sensitiveUnlocked ? "验证密码后配置" : !configLoaded ? "读取配置后保存" : configSaving ? "保存中..." : "保存易支付配置"}
        </button>
      </div>

      {/* 支付方式管理 */}
      <div className={cardCls}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-bold text-[var(--foreground)]">支付方式管理</h3>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">管理可用的支付方式，配置支付渠道参数</p>
          </div>
          <button
            onClick={() => {
              if (!sensitiveUnlocked) {
                onRequestUnlock();
                return;
              }
              setEditingMethod(null);
              setMethodForm({ name: "", code: "", icon: "wallet", provider: "xunhupay", is_active: true, sort_order: 0 });
              setShowMethodForm(!showMethodForm);
            }}
            className={btnPrimary}
          >
            {!sensitiveUnlocked ? "解锁后管理" : showMethodForm ? "收起" : "添加支付方式"}
          </button>
        </div>

        {/* 新增/编辑表单 */}
        {sensitiveUnlocked && showMethodForm && (
          <div className="p-4 bg-[var(--border)]/20 rounded-xl mb-6 space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>名称 *</label>
                <input className={inputCls} value={methodForm.name} onChange={e => setMethodForm(f => ({ ...f, name: e.target.value }))} placeholder="如：微信支付" />
              </div>
              <div>
                <label className={labelCls}>编码 *</label>
                <input className={inputCls} value={methodForm.code} onChange={e => setMethodForm(f => ({ ...f, code: e.target.value }))} placeholder="如：wechat" disabled={!!editingMethod} />
              </div>
              <div>
                <label className={labelCls}>图标</label>
                <select className={inputCls} value={methodForm.icon} onChange={e => setMethodForm(f => ({ ...f, icon: e.target.value }))}>
                  <option value="wechat">微信</option>
                  <option value="alipay">支付宝</option>
                  <option value="qqpay">QQ钱包</option>
                  <option value="wallet">钱包</option>
                  <option value="credit_card">信用卡</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>支付提供商</label>
                <select className={inputCls} value={methodForm.provider} onChange={e => setMethodForm(f => ({ ...f, provider: e.target.value }))}>
                  <option value="xunhupay">迅虎支付(虎皮椒)</option>
                  <option value="epay">易支付(EPay)</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>排序</label>
                <input className={inputCls} type="number" min={0} value={methodForm.sort_order} onChange={e => setMethodForm(f => ({ ...f, sort_order: parseInt(e.target.value) || 0 }))} />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={methodForm.is_active} onChange={e => setMethodForm(f => ({ ...f, is_active: e.target.checked }))} className="w-4 h-4 rounded border-[var(--border)]" />
                  <span className="text-sm text-[var(--secondary-foreground)]">启用</span>
                </label>
              </div>
            </div>
            <button onClick={handleSaveMethod} disabled={methodSaving || !methodForm.name || !methodForm.code} className={`${btnPrimary} ${methodSaving ? 'opacity-50' : ''}`}>
              {methodSaving ? '保存中...' : editingMethod ? '更新' : '添加'}
            </button>
          </div>
        )}

        {/* 支付方式列表 */}
        {!sensitiveUnlocked ? (
          <div data-testid="payment-methods-step-up-required" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-5 text-center">
            <p className="text-sm font-semibold text-amber-900">支付方式配置已锁定</p>
            <p className="mt-1 text-xs leading-5 text-amber-700">验证管理员密码后才会读取支付方式与订单统计，锁定状态不会预取受保护配置。</p>
            <button type="button" onClick={onRequestUnlock} className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100">
              验证密码后读取
            </button>
          </div>
        ) : methodsLoading ? (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">加载中...</div>
        ) : methods.length === 0 ? (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无支付方式，请添加</div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--border)]/30">
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">支付方式</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">编码</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">提供商</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">订单/成功</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">成功金额</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">状态</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">排序</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {methods.map(m => (
                  <tr key={m.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/10">
                    <td className="py-2 px-3">
                      <div className="flex items-center gap-2">
                        {m.icon === "wechat" && (
                          <svg viewBox="0 0 24 24" className="w-5 h-5 text-green-500 fill-current">
                            <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05a6.158 6.158 0 0 1-.235-1.676c0-3.793 3.527-6.87 7.879-6.87.243 0 .482.012.718.031C17.084 4.635 13.227 2.188 8.691 2.188zm-2.87 4.401a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988zm5.742 0a.994.994 0 1 1 0 1.988.994.994 0 0 1 0-1.988zM16.88 9.188c-3.868 0-7.005 2.666-7.005 5.953 0 3.286 3.137 5.952 7.005 5.952.78 0 1.54-.113 2.27-.316a.717.717 0 0 1 .586.078l1.478.869a.264.264 0 0 0 .137.044c.131 0 .24-.108.24-.24 0-.059-.023-.117-.039-.174l-.305-1.147a.488.488 0 0 1 .175-.546C23.016 18.553 24 16.932 24 15.14c0-3.287-3.137-5.953-7.12-5.953zm-2.79 3.338a.823.823 0 1 1 0 1.646.823.823 0 0 1 0-1.646zm5.58 0a.823.823 0 1 1 0 1.646.823.823 0 0 1 0-1.646z"/>
                          </svg>
                        )}
                        {m.icon === "alipay" && (
                          <svg viewBox="0 0 24 24" className="w-5 h-5 text-blue-500 fill-current">
                            <path d="M21.422 15.358c-1.585-.697-3.455-1.428-3.455-1.428s1.265-2.398 1.576-4.236H13.88V8.013h6.27V6.87h-6.27V3.5h-2.19s-.062.015-.062.073V6.87H5.46v1.143h6.168v1.681H7.16v1.084h9.223c-.244 1.187-.913 2.754-.913 2.754s-3.166-1.143-5.232-1.143c-3.166 0-4.89 1.681-4.89 3.362 0 2.108 1.944 3.627 5.03 3.627 2.559 0 4.677-1.252 6.229-3.088 2.3 1.143 6.412 2.754 6.412 2.754V24H2.4A2.4 2.4 0 0 1 0 21.6V2.4A2.4 2.4 0 0 1 2.4 0h19.2A2.4 2.4 0 0 1 24 2.4v19.2a2.4 2.4 0 0 1-.634 1.602c-.008.008-1.944-2.376-1.944-2.376v-5.468zM8.972 17.943c-2.743 0-3.965-1.18-3.965-2.643 0-1.464 1.467-2.602 3.728-2.602 1.952 0 3.905.72 3.905.72-1.22 2.522-2.258 4.525-3.668 4.525z"/>
                          </svg>
                        )}
                        {m.icon === "qqpay" && (
                          <svg viewBox="0 0 24 24" className="w-5 h-5 text-sky-400 fill-current">
                            <circle cx="12" cy="12" r="10"/>
                            <text x="12" y="16" textAnchor="middle" fontSize="10" fill="white" fontWeight="bold">Q</text>
                          </svg>
                        )}
                        {m.icon !== "wechat" && m.icon !== "alipay" && m.icon !== "qqpay" && (
                          <svg className="w-5 h-5 text-[var(--muted-foreground)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>
                          </svg>
                        )}
                        <span className="font-medium text-[var(--foreground)]">{m.name}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-xs text-[var(--muted-foreground)] font-mono">{m.code}</td>
                    <td className="py-2 px-3 text-xs text-[var(--muted-foreground)]">{m.provider === "xunhupay" ? "迅虎支付" : m.provider === "epay" ? "易支付" : m.provider}</td>
                    <td className="py-2 px-3 text-xs">
                      <span className="text-[var(--foreground)]">{methodStats[m.id]?.total || 0}</span>
                      <span className="text-[var(--muted-foreground)]"> / </span>
                      <span className="text-emerald-400">{methodStats[m.id]?.success || 0}</span>
                    </td>
                    <td className="py-2 px-3 text-xs text-emerald-400">¥{methodStats[m.id]?.totalAmount?.toFixed(2) || "0.00"}</td>
                    <td className="py-2 px-3">
                      <button
                        onClick={() => handleToggleActive(m)}
                        className={`px-2 py-0.5 rounded text-xs cursor-pointer ${
                          m.is_active
                            ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
                            : "bg-gray-500/20 text-gray-400 hover:bg-gray-500/30"
                        }`}
                      >
                        {m.is_active ? "已启用" : "已禁用"}
                      </button>
                    </td>
                    <td className="py-2 px-3 text-xs text-[var(--muted-foreground)]">{m.sort_order}</td>
                    <td className="py-2 px-3">
                      <div className="flex gap-2">
                        <button onClick={() => handleEditMethod(m)} className="text-xs text-blue-400 hover:text-blue-300">编辑</button>
                        <button onClick={() => handleDeleteMethod(m.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 支付订单列表 */}
      {canViewBilling ? (
      <div className={cardCls} data-testid="payment-order-ledger">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-bold text-[var(--foreground)]">支付订单</h3>
            <p className="text-xs text-[var(--muted-foreground)] mt-1">查看所有支付订单记录</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className={`${inputCls} !w-auto !py-1.5 text-xs`}
              value={orderStatusFilter}
              onChange={e => { setOrderStatusFilter(e.target.value); loadOrders(1, e.target.value); }}
            >
              <option value="">全部状态</option>
              <option value="pending">待支付</option>
              <option value="paid">已支付</option>
              <option value="failed">失败</option>
              <option value="expired">已过期</option>
            </select>
          </div>
        </div>

        {/* 统计概览 */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div className="p-3 bg-[var(--border)]/20 rounded-xl text-center">
            <div className="text-xs text-[var(--muted-foreground)]">总订单</div>
            <div className="text-lg font-bold text-[var(--foreground)]">{orderSummary.totalOrders}</div>
          </div>
          <div className="p-3 bg-[var(--border)]/20 rounded-xl text-center">
            <div className="text-xs text-[var(--muted-foreground)]">总金额</div>
            <div className="text-lg font-bold text-[var(--foreground)]">¥{orderSummary.totalAmount.toFixed(2)}</div>
          </div>
          <div className="p-3 bg-[var(--border)]/20 rounded-xl text-center">
            <div className="text-xs text-[var(--muted-foreground)]">成功金额</div>
            <div className="text-lg font-bold text-emerald-400">¥{orderSummary.successAmount.toFixed(2)}</div>
          </div>
          <div className="p-3 bg-[var(--border)]/20 rounded-xl text-center">
            <div className="text-xs text-[var(--muted-foreground)]">成功/待付</div>
            <div className="text-lg font-bold">
              <span className="text-emerald-400">{orderSummary.successCount}</span>
              <span className="text-[var(--muted-foreground)]"> / </span>
              <span className="text-amber-400">{orderSummary.pendingCount}</span>
            </div>
          </div>
          <div className="p-3 bg-[var(--border)]/20 rounded-xl text-center">
            <div className="text-xs text-[var(--muted-foreground)]">成功率</div>
            <div className="text-lg font-bold text-[var(--foreground)]">
              {orderSummary.totalOrders > 0 ? Math.round(orderSummary.successCount / orderSummary.totalOrders * 100) : 0}%
            </div>
          </div>
        </div>

        {/* 订单表格 */}
        {ordersLoading ? (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">加载中...</div>
        ) : orders.length === 0 ? (
          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无订单</div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm min-w-[800px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--border)]/30">
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">订单号</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">类型</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">金额</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">积分</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">支付方式</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">状态</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">创建时间</th>
                  <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium whitespace-nowrap">支付时间</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/10">
                    <td className="py-2 px-3 font-mono text-xs text-[var(--foreground)] whitespace-nowrap">{o.trade_order_id?.slice(0, 25)}...</td>
                    <td className="py-2 px-3 text-xs">
                      {o.type === "credits" ? (
                        <span className="text-blue-400">积分</span>
                      ) : (
                        <span className="text-emerald-400">现金</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs font-medium text-[var(--foreground)]">¥{o.amount?.toFixed(2)}</td>
                    <td className="py-2 px-3 text-xs text-blue-400">{o.credits_amount || "-"}</td>
                    <td className="py-2 px-3 text-xs">{getPayMethodLabel(o.payment_method)}</td>
                    <td className="py-2 px-3">{getStatusBadge(o.status)}</td>
                    <td className="py-2 px-3 text-xs text-[var(--muted-foreground)] whitespace-nowrap">{new Date(o.created_at).toLocaleString()}</td>
                    <td className="py-2 px-3 text-xs text-[var(--muted-foreground)] whitespace-nowrap">{o.paid_at ? new Date(o.paid_at).toLocaleString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {orderTotal > 20 && (
          <div className="flex items-center justify-center gap-3 mt-4">
            <button onClick={() => loadOrders(orderPage - 1, orderStatusFilter)} disabled={orderPage <= 1} className="text-xs px-3 py-1.5 bg-[var(--border)]/30 rounded-lg disabled:opacity-50">上一页</button>
            <span className="text-xs text-[var(--muted-foreground)]">{orderPage} / {Math.ceil(orderTotal / 20)}</span>
            <button onClick={() => loadOrders(orderPage + 1, orderStatusFilter)} disabled={orderPage >= Math.ceil(orderTotal / 20)} className="text-xs px-3 py-1.5 bg-[var(--border)]/30 rounded-lg disabled:opacity-50">下一页</button>
          </div>
        )}
      </div>
      ) : (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900" data-testid="payment-orders-permission-required">
          <p className="font-bold">支付订单需要“账务查看”权限</p>
          <p className="mt-1 text-xs leading-5">当前管理员仍可维护支付渠道；订单流水和金额统计不会在缺少财务权限时读取。</p>
        </section>
      )}
    </div>
  );
}
