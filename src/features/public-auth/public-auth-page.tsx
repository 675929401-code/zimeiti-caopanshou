"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { KeyRound, LoaderCircle, LogIn, MailCheck, ShieldCheck, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoginForm, type LoginMode } from "@/components/login-form";
import { useApp } from "@/contexts/app-context";
import { ReferralCompatPage } from "@/features/official-compat/official-compat-pages";
import styles from "./public-auth-page.module.css";

export type PublicAuthKind = "login" | "register" | "recover";

const AUTH_COPY: Record<PublicAuthKind, {
  eyebrow: string;
  title: string;
  description: string;
  note: string;
  initialMode: LoginMode;
}> = {
  login: {
    eyebrow: "账号登录",
    title: "继续使用自媒体操盘手",
    description: "继续你的创作项目，查看素材与作品。",
    note: "可使用账号密码或邮箱验证码登录。",
    initialMode: "account",
  },
  register: {
    eyebrow: "注册账号",
    title: "创建你的创作账号",
    description: "准备QQ邮箱、手机号和邀请码，即可注册。",
    note: "请先获取邮箱验证码，再填写注册信息。",
    initialMode: "register",
  },
  recover: {
    eyebrow: "找回访问权限",
    title: "先验证邮箱，再设置新密码",
    description: "使用注册邮箱的验证码登录，再到个人中心修改密码。",
    note: "请使用注册时填写的邮箱。",
    initialMode: "email",
  },
};

export function PublicAuthPage({
  kind,
  redirectTo,
  invitationCode = "",
}: {
  kind: PublicAuthKind;
  redirectTo: string;
  invitationCode?: string;
}) {
  const copy = AUTH_COPY[kind];
  const { state, checkAuth, dispatch } = useApp();
  const router = useAppScopedRouter();
  const redirectingRef = useRef(false);

  const continueAfterAuth = useCallback(async () => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    await checkAuth().catch(() => undefined);
    if (redirectTo === "/") {
      try {
        sessionStorage.setItem("entered_app", "1");
        localStorage.setItem("active_view", "marketplace");
      } catch {}
      dispatch({ type: "SET_VIEW", payload: "marketplace" });
    }
    router.replace(redirectTo);
  }, [checkAuth, dispatch, redirectTo, router]);

  useEffect(() => {
    const handleAuthChanged = () => { void continueAfterAuth(); };
    window.addEventListener("auth-state-changed", handleAuthChanged);
    return () => window.removeEventListener("auth-state-changed", handleAuthChanged);
  }, [continueAfterAuth]);

  useEffect(() => {
    if (state.auth.isAuthenticated && state.auth.user && state.auth.token) {
      void continueAfterAuth();
    }
  }, [continueAfterAuth, state.auth.isAuthenticated, state.auth.token, state.auth.user]);

  return (
    <div className={styles.authPage} data-page={`public-auth-${kind}`}>
      <section className={styles.authIntro}>
        <span className={styles.eyebrow}>{copy.eyebrow}</span>
        <span className={styles.introIcon} aria-hidden="true">
          {kind === "register" ? <UserPlus size={30} /> : kind === "recover" ? <MailCheck size={30} /> : <LogIn size={30} />}
        </span>
        <h1>{copy.title}</h1>
        <p>{copy.description}</p>
        <div className={styles.trustNote}>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>{copy.note}</span>
        </div>
        <nav className={styles.authLinks} aria-label="认证入口">
          {kind !== "login" && <Link href={`/login?redirect=${encodeURIComponent(redirectTo)}`}>返回登录</Link>}
          {kind !== "register" && <Link href={`/register?redirect=${encodeURIComponent(redirectTo)}`}>注册账号</Link>}
          {kind !== "recover" && <Link href="/forgot-password">忘记密码</Link>}
        </nav>
      </section>

      <section className={styles.formSection} aria-label={`${copy.eyebrow}表单`}>
        <LoginForm initialMode={copy.initialMode} initialInvitationCode={kind === "register" ? invitationCode : ""} />
        {kind === "recover" && (
          <p className={styles.recoverHint}>
            <KeyRound size={15} aria-hidden="true" />
            邮箱登录成功后会进入“个人中心 → 修改密码”。
          </p>
        )}
      </section>
    </div>
  );
}

export function ReferralRouteGate() {
  const { state, checkAuth } = useApp();
  const router = useAppScopedRouter();
  const [checked, setChecked] = useState(false);
  const authenticated = state.auth.isAuthenticated && Boolean(state.auth.user && state.auth.token);

  useEffect(() => {
    let active = true;
    void checkAuth()
      .catch(() => undefined)
      .finally(() => {
        if (active) setChecked(true);
      });
    return () => { active = false; };
  }, [checkAuth]);

  useEffect(() => {
    if (checked && !authenticated) {
      router.replace("/login?redirect=%2Freferral");
    }
  }, [authenticated, checked, router]);

  if (!checked || !authenticated) {
    return (
      <div className={styles.authGate} data-page="referral-auth-gate" aria-live="polite">
        <LoaderCircle className={styles.spin} size={22} aria-hidden="true" />
        <span>{checked ? "正在前往登录页面..." : "正在核验登录状态..."}</span>
      </div>
    );
  }

  return <ReferralCompatPage />;
}
