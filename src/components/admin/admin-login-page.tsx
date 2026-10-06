"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { LoginForm, type LoginMode } from "@/components/login-form";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";

const ADMIN_LOGIN_MODES: readonly LoginMode[] = ["account"];

export function AdminLoginPage({ redirectTo }: { redirectTo: string }) {
  const router = useAppScopedRouter();
  const [checking, setChecking] = useState(true);
  const [deniedAccount, setDeniedAccount] = useState("");

  const verifyAndEnter = useCallback(async () => {
    const token = localStorage.getItem("auth_token")?.trim() || "";
    if (!token) {
      setChecking(false);
      setDeniedAccount("");
      return;
    }
    try {
      const response = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      const user = payload.user || payload;
      if (response.ok && user?.role === "admin") {
        sessionStorage.setItem("entered_app", "1");
        router.replace(redirectTo);
        return;
      }
      setDeniedAccount(response.ok ? String(user?.displayName || user?.username || "当前账号") : "");
    } catch {
      setDeniedAccount("");
    } finally {
      setChecking(false);
    }
  }, [redirectTo, router]);

  useEffect(() => {
    void verifyAndEnter();
    const onAuthChanged = () => { setChecking(true); void verifyAndEnter(); };
    window.addEventListener("auth-state-changed", onAuthChanged);
    return () => window.removeEventListener("auth-state-changed", onAuthChanged);
  }, [verifyAndEnter]);

  const clearCurrentAccount = async () => {
    const token = localStorage.getItem("auth_token")?.trim() || "";
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => undefined);
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    sessionStorage.removeItem("entered_app");
    setDeniedAccount("");
  };

  return (
    <main className="min-h-screen bg-[#f5f7f6] px-8 py-10 text-[#101828]" data-testid="admin-login-page">
      <div className="mx-auto grid min-h-[calc(100vh-80px)] max-w-6xl grid-cols-[minmax(0,1fr)_460px] items-center gap-16">
        <section>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700"><ShieldCheck className="h-4 w-4" />自媒体操盘手管理后台</div>
          <h1 className="mt-6 max-w-2xl text-5xl font-black leading-[1.12] tracking-[-0.04em]" style={{ color: "#101828" }}>欢迎回来，继续管理平台业务</h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-[#667085]">在这里统一处理会员服务、内容配置、经营数据和平台运营事务。</p>
          <div className="mt-8 grid grid-cols-3 gap-3">
            {["会员与学员服务", "内容与模型配置", "经营数据与操作记录"].map((label, index) => <div key={label} className="rounded-2xl border border-[#d0d5dd] bg-white p-4 shadow-sm"><span className="grid h-8 w-8 place-items-center rounded-lg bg-[#ecfdf3] text-sm font-black text-[#067647]">{index + 1}</span><p className="mt-3 text-sm font-bold">{label}</p></div>)}
          </div>
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><strong>使用提醒：</strong>请使用已授权的管理账号登录；请勿与他人共享账号，离开公共设备时及时退出。</div>
          <button type="button" onClick={() => router.push("/")} className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[#475467] hover:text-[#101828]"><ArrowLeft className="h-4 w-4" />返回平台首页</button>
        </section>

        <section className="relative">
          {checking && <div className="absolute inset-0 z-20 grid place-items-center rounded-3xl bg-[#101828]/80 text-white backdrop-blur-sm"><div className="flex items-center gap-2 text-sm font-bold"><LoaderCircle className="h-5 w-5 animate-spin" />正在确认登录状态</div></div>}
          {deniedAccount && <div role="alert" className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800"><p className="font-black">“{deniedAccount}”没有后台管理员身份</p><p className="mt-1">你可以直接在下方换用管理员账号，或先退出当前账号。</p><button type="button" onClick={() => void clearCurrentAccount()} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-white px-3 py-2 text-xs font-bold"><KeyRound className="h-4 w-4" />退出并切换账号</button></div>}
          <LoginForm
            initialMode="account"
            allowedModes={ADMIN_LOGIN_MODES}
            title="登录管理后台"
            subtitle="请输入管理账号和密码"
            footerNote="如需开通后台权限，请联系平台负责人"
            footerTextColor="#475467"
          />
        </section>
      </div>
    </main>
  );
}
