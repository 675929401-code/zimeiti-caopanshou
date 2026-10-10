"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useApp } from "@/contexts/app-context";
import { reportAuthLoginFailed } from "@/lib/diagnostic-sentry";
import { Eye, EyeOff } from "lucide-react";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";
import { isQqEmail, normalizeQqEmail } from "@/lib/qq-email";
import {
  handlePlatformBrandLogoError,
  platformBrandAssetUrl,
  platformBrandLogoUrl,
  usePlatformBranding,
} from "@/hooks/use-platform-branding";

export type LoginMode = "account" | "email" | "register";

const ALL_LOGIN_MODES: readonly LoginMode[] = ["account", "email", "register"];

function getOrCreateRegistrationDeviceId() {
  const storageKey = "registration_device_id";
  try {
    const current = localStorage.getItem(storageKey)?.trim();
    if (current && /^[A-Za-z0-9._:-]{16,128}$/u.test(current)) return current;
    const next = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(storageKey, next);
    return next;
  } catch {
    return "";
  }
}

export function LoginForm({
  initialMode,
  initialInvitationCode = "",
  allowedModes,
  title,
  subtitle,
  footerNote,
  footerTextColor,
}: {
  initialMode?: LoginMode;
  initialInvitationCode?: string;
  allowedModes?: readonly LoginMode[];
  title?: string;
  subtitle?: string;
  footerNote?: string;
  footerTextColor?: string;
} = {}) {
  const { login, register } = useApp();
  const publicBranding = usePlatformBranding();
  const platformName = publicBranding.brand.name
    || (publicBranding.displayScope === "white_label" ? "品牌服务" : "自媒体操盘手");
  const platformLogo = platformBrandLogoUrl(publicBranding, "square");
  const loginBackground = platformBrandAssetUrl(publicBranding, "login_background");
  const publishedContact = publicBranding.brand.contact.wechat.trim()
    ? `微信：${publicBranding.brand.contact.wechat.trim()}`
    : publicBranding.brand.contact.phone.trim()
      ? `电话：${publicBranding.brand.contact.phone.trim()}`
      : publicBranding.brand.contact.email.trim()
        ? `邮箱：${publicBranding.brand.contact.email.trim()}`
        : "";
  const enabledModes: readonly LoginMode[] = allowedModes?.length ? allowedModes : ALL_LOGIN_MODES;
  const modeEnabled = useCallback((value: LoginMode) => enabledModes.includes(value), [enabledModes]);
  const [mode, setMode] = useState<LoginMode>(() => initialMode && enabledModes.includes(initialMode) ? initialMode : enabledModes[0]);

  // 倒计时 timer ref（组件卸载时清理）
  const countdownTimersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());

  // 组件卸载时清理所有倒计时 timer
  useEffect(() => {
    const timers = countdownTimersRef.current;
    return () => {
      timers.forEach(id => clearInterval(id));
      timers.clear();
    };
  }, []);

  // 密码可见性控制
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegPassword, setShowRegPassword] = useState(false);

  // 账号登录 — 从 localStorage 恢复上次输入
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");

  // 邮箱登录
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeCountdown, setCodeCountdown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);

  // 注册表单
  const [regEmail, setRegEmail] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regDisplayName, setRegDisplayName] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regInvitationCode, setRegInvitationCode] = useState(() => initialInvitationCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8));
  const [regCodeCountdown, setRegCodeCountdown] = useState(0);
  const [regCodeSent, setRegCodeSent] = useState(false);
  const [regSendingCode, setRegSendingCode] = useState(false);

  // ── Hydration备份：原生事件监听器 ──
  // React在慢速网络下hydration可能不完整，导致onSubmit不生效
  // 用原生addEventListener作为备份，确保登录始终可用
  const accountFormRef = useRef<HTMLFormElement>(null);
  const emailFormRef = useRef<HTMLFormElement>(null);
  const securityFormRef = useRef<HTMLFormElement>(null);

  // 通用状态
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);

  // ── 安全问题验证状态 ──
  const [needSecurityVerify, setNeedSecurityVerify] = useState(false);
  const [securityQuestion, setSecurityQuestion] = useState("");
  const [securityAnswer, setSecurityAnswer] = useState("");
  const [regionInfo, setRegionInfo] = useState<{ province: string; city: string } | null>(null);


  // 挂载时恢复上次输入的账号
  useEffect(() => {
    if (initialMode && modeEnabled(initialMode)) {
      setMode(initialMode);
      return;
    }
    try {
      const savedAccount = localStorage.getItem("last_login_account") || localStorage.getItem("last_login_phone");
      const savedEmail = localStorage.getItem("last_login_email");
      const savedMode = localStorage.getItem("last_login_mode") as LoginMode | "phone" | null;
      if (savedAccount) setAccount(savedAccount);
      if (savedEmail) setEmail(savedEmail);
      // 兼容旧模式: "phone" → "account"
      if ((savedMode === "account" || savedMode === "email" || savedMode === "register") && modeEnabled(savedMode)) setMode(savedMode);
      else if (savedMode === "phone" && modeEnabled("account")) setMode("account");
      else setMode(enabledModes[0]);
    } catch {}
  }, [enabledModes, initialMode, modeEnabled]);

  useEffect(() => {
    const normalized = initialInvitationCode.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (normalized) setRegInvitationCode(normalized);
  }, [initialInvitationCode]);

  // 发送验证码（登录用）
  const handleSendCode = useCallback(async () => {
    if (!email || codeCountdown > 0) return;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("请输入正确的邮箱地址");
      return;
    }

    setSendingCode(true);
    setError("");

    try {
      const res = await fetch("/api/auth/send-email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "发送验证码失败");
        reportAuthLoginFailed("发送邮箱验证码", data.error || "发送验证码失败");
        return;
      }

      setCodeSent(true);
      setCodeCountdown(60);

      const timer = setInterval(() => {
        setCodeCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            countdownTimersRef.current.delete(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      countdownTimersRef.current.add(timer);
    } catch {
      setError("网络错误，请稍后重试");
      reportAuthLoginFailed("邮箱验证码登录", "网络错误");
    } finally {
      setSendingCode(false);
    }
  }, [email, codeCountdown]);

  // 发送注册验证码
  const handleSendRegCode = useCallback(async () => {
    if (!regEmail || regCodeCountdown > 0) return;

    if (!isQqEmail(regEmail)) {
      setError("请输入QQ邮箱（例如 123456789@qq.com）");
      return;
    }

    setRegSendingCode(true);
    setError("");

    try {
      const res = await fetch("/api/auth/register/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeQqEmail(regEmail) }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "发送验证码失败");
        reportAuthLoginFailed("发送注册验证码", data.error || "发送验证码失败");
        return;
      }

      setRegCodeSent(true);
      setRegCodeCountdown(60);

      const timer = setInterval(() => {
        setRegCodeCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            countdownTimersRef.current.delete(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      countdownTimersRef.current.add(timer);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setRegSendingCode(false);
    }
  }, [regEmail, regCodeCountdown]);

  // ── 原生submit备份处理函数（hydration不完整时由原生事件调用）──
  // 这些函数从DOM直接读取输入值，不依赖React状态（hydration不完整时状态可能未同步）
  const handleAccountSubmit = () => {
    const form = accountFormRef.current;
    if (!form) return;
    const accountInput = form.querySelector<HTMLInputElement>('input[name="account"]');
    const passwordInput = form.querySelector<HTMLInputElement>('input[name="password"]');
    if (accountInput) setAccount(accountInput.value);
    if (passwordInput) setPassword(passwordInput.value);
    // 使用setTimeout确保setState生效后再执行登录
    setTimeout(() => {
      login(accountInput?.value || account, passwordInput?.value || password).then(result => {
        if (result.success) {
          localStorage.setItem("last_login_account", accountInput?.value || account);
          localStorage.setItem("last_login_mode", "account");
          // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用
          window.dispatchEvent(new Event("auth-state-changed"));
        } else if (result.code === "REGION_VERIFY_REQUIRED") {
          setNeedSecurityVerify(true);
          setSecurityQuestion(result.securityQuestion || "");
          setRegionInfo(result.region || null);
        } else if (result.code === "NO_PASSWORD_SET") {
          setError(modeEnabled("email") ? (result.error || "该账号未设置密码，请使用邮箱登录") : "该后台账号尚未设置登录密码，请联系超级管理员处理");
          if (modeEnabled("email")) setMode("email");
        } else {
          setError(result.error || "账号或密码错误");
        }
        setLoading(false);
      }).catch(() => {
        setError("网络错误，请稍后重试");
        setLoading(false);
      });
    }, 0);
    setLoading(true);
    setError("");
  };

  const handleEmailSubmit = () => {
    const form = emailFormRef.current;
    if (!form) return;
    const emailInput = form.querySelector<HTMLInputElement>('input[name="email"]');
    const codeInput = form.querySelector<HTMLInputElement>('input[name="emailCode"]');
    const emailVal = emailInput?.value || email;
    const codeVal = codeInput?.value || emailCode;
    if (emailInput) setEmail(emailVal);
    if (codeInput) setEmailCode(codeVal);
    if (!emailVal) { setError("请输入邮箱地址"); return; }
    if (!codeVal) { setError("请输入验证码"); return; }
    setLoading(true);
    setError("");
    fetch("/api/auth/login-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailVal, code: codeVal }),
    }).then(res => res.json()).then(data => {
      if (!data.success) {
        setError(data.error || "登录失败");
        setLoading(false);
        return;
      }
      // 登录成功 - 更新全局状态
      if (data.token && data.user) {
        localStorage.setItem("auth_token", data.token);
        localStorage.setItem("auth_user", JSON.stringify(data.user));
        window.dispatchEvent(new Event("auth-state-changed"));
        localStorage.setItem("last_login_email", emailVal);
        localStorage.setItem("last_login_mode", "email");
      }
      setLoading(false);
    }).catch(() => {
      setError("网络错误，请稍后重试");
      setLoading(false);
    });
  };

  const handleSecuritySubmit = () => {
    const form = securityFormRef.current;
    if (!form) return;
    const answerInput = form.querySelector<HTMLInputElement>('input[name="securityAnswer"]');
    if (answerInput) setSecurityAnswer(answerInput.value);
    setTimeout(() => {
      login(account, password, answerInput?.value || securityAnswer).then(result => {
        if (result.success) {
          localStorage.setItem("last_login_account", account);
          localStorage.setItem("last_login_mode", "account");
          // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用
          window.dispatchEvent(new Event("auth-state-changed"));
        } else if (result.code === "SECURITY_ANSWER_WRONG") {
          setError(result.error || "安全验证答案错误");
        } else {
          setError(result.error || "验证失败");
        }
        setLoading(false);
      }).catch(() => {
        setError("网络错误，请稍后重试");
        setLoading(false);
      });
    }, 0);
    setLoading(true);
    setError("");
  };

  // 账号密码登录（支持手机号和用户名）
  const handleAccountLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    // 通知 FormGuard：React 已接管此 submit，无需原生备份
    (window as unknown as Record<string, unknown>).__reactSubmitHandled = true;
    if (loading) return;

    if (!account.trim()) {
      setError("请输入手机号、用户名或邮箱");
      return;
    }
    if (!password) {
      setError("请输入密码");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result = await login(account, password, needSecurityVerify ? securityAnswer : undefined);
      if (result.success) {
        // 记住账号（不记住密码）
        localStorage.setItem("last_login_account", account);
        localStorage.setItem("last_login_mode", "account");
        // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用
        window.dispatchEvent(new Event("auth-state-changed"));
      } else if (result.code === "REGION_VERIFY_REQUIRED") {
        // 非贵州IP触发安全问题验证
        setNeedSecurityVerify(true);
        setSecurityQuestion(result.securityQuestion || "");
        setRegionInfo(result.region || null);
        setError("");
      } else if (result.code === "NO_PASSWORD_SET") {
        // 未设置密码，引导用户使用邮箱登录
        setError(modeEnabled("email") ? (result.error || "该账号未设置密码，请使用邮箱登录") : "该后台账号尚未设置登录密码，请联系超级管理员处理");
        if (modeEnabled("email")) setMode("email"); // 管理员专用入口不降级为验证码登录
      } else if (result.code === "SECURITY_ANSWER_WRONG") {
        setError(result.error || "安全验证答案错误");
      } else {
        setError(result.error || "账号或密码错误");
        reportAuthLoginFailed("账号密码登录", result.error || "账号或密码错误");
      }
    } catch {
      setError("登录异常，请刷新页面重试");
    } finally {
      setLoading(false);
    }
  };

  // 安全问题验证提交
  const handleSecurityVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    (window as unknown as Record<string, unknown>).__reactSubmitHandled = true;
    setError("");
    setLoading(true);
    try {
      const result = await login(account, password, securityAnswer);
      if (result.success) {
        localStorage.setItem("last_login_account", account);
        localStorage.setItem("last_login_mode", "account");
        // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用
        window.dispatchEvent(new Event("auth-state-changed"));
      } else if (result.code === "SECURITY_ANSWER_WRONG") {
        setError(result.error || "安全验证答案错误");
      } else {
        setError(result.error || "验证失败");
        reportAuthLoginFailed("安全问题验证", result.error || "验证失败");
      }
    } catch {
      setError("验证异常，请刷新页面重试");
    } finally {
      setLoading(false);
    }
  };

  // 邮箱验证码登录
  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    (window as unknown as Record<string, unknown>).__reactSubmitHandled = true;
    setError("");

    if (!email) {
      setError("请输入邮箱地址");
      return;
    }
    if (!emailCode) {
      setError("请输入验证码");
      return;
    }

    setLoading(true);

    try {
      const controller = new AbortController();
      const loginTimeout = setTimeout(() => controller.abort(), 45000);
      const res = await fetch("/api/auth/login-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: emailCode }),
        signal: controller.signal,
      });
      clearTimeout(loginTimeout);
      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || "登录失败");
        reportAuthLoginFailed("邮箱验证码登录", data.error || "登录失败");
        return;
      }

      localStorage.setItem("auth_token", data.token);
      localStorage.setItem("auth_user", JSON.stringify(data.user));
      localStorage.setItem("last_login_email", email);
      localStorage.setItem("last_login_mode", "email");
      // 清除旧的 view，确保刷新后默认进入应用广场
      localStorage.removeItem("active_view");
      // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用（比 reload 更平滑）
      window.dispatchEvent(new Event("auth-state-changed"));
    } catch {
      setError("网络错误或请求超时，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  // 注册
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    (window as unknown as Record<string, unknown>).__reactSubmitHandled = true;
    setError("");

    if (!regEmail) {
      setError("请输入QQ邮箱");
      return;
    }
    if (!isQqEmail(regEmail)) {
      setError("请输入QQ邮箱（例如 123456789@qq.com）");
      return;
    }
    if (!regPhone) {
      setError("请输入手机号码");
      return;
    }
    if (!/^1[3-9]\d{9}$/.test(regPhone)) {
      setError("请输入正确的手机号码");
      return;
    }
    if (!regCode) {
      setError("请输入验证码");
      return;
    }
    if (!regPassword || regPassword.length < 8 || !/[A-Za-z]/.test(regPassword) || !/\d/.test(regPassword)) {
      setError("密码至少8位，且需同时包含字母和数字");
      return;
    }
    if (!regInvitationCode || regInvitationCode.trim().length < 8) {
      setError("请输入8位邀请码（联系现有学员获取）");
      return;
    }

    setLoading(true);

    try {
      const normalizedEmail = normalizeQqEmail(regEmail);
      const result = await register(
        normalizedEmail,
        regPhone,
        regCode,
        regDisplayName || undefined,
        regPassword,
        regInvitationCode.trim(),
        getOrCreateRegistrationDeviceId(),
      );
      if (result.success) {
        localStorage.setItem("last_login_email", normalizedEmail);
        localStorage.setItem("last_login_mode", "email");
        // 清除旧的 view，确保刷新后默认进入应用广场
        localStorage.removeItem("active_view");
        // 通知 LandingPage 登录成功，触发 onEnterApp 进入应用
        window.dispatchEvent(new Event("auth-state-changed"));
      } else {
        setError(result.error || "注册失败");
        reportAuthLoginFailed("注册", result.error || "注册失败");
      }
    } catch {
      setError("网络错误，请稍后重试");
      reportAuthLoginFailed("注册", "网络错误");
    } finally {
      setLoading(false);
    }
  };

  // ── Hydration 备份登录 ──
  // FormGuard（layout.tsx SSR <script>）在 React hydration 不完整时直接调用 API
  // 这里暴露 handlers 供 FormGuard 可选调用（双重保险）
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__loginFormHandlers = {
      handleAccountSubmit: () => { handleAccountSubmit(); },
      handleEmailSubmit: () => { handleEmailSubmit(); },
      handleSecuritySubmit: () => { handleSecuritySubmit(); },
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__loginFormHandlers;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-form-shell relative w-full max-w-[420px] px-4" data-testid="login-form-shell">
      {/* Glass Card */}
      <div className="login-panel relative rounded-3xl bg-slate-900/85 backdrop-blur-2xl border border-white/20 shadow-2xl shadow-black/40 p-6 sm:p-8 overflow-hidden supports-[backdrop-filter]:bg-white/[0.08]">
        {loginBackground ? (
          <img
            src={loginBackground}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.14]"
          />
        ) : null}
        {/* Subtle inner glow */}
        <div className="login-panel-sheen absolute inset-0 rounded-3xl bg-gradient-to-br from-white/6 via-transparent to-white/2 pointer-events-none" />
        <div className="absolute right-3 top-3 z-20">
          <UserThemeSwitcher />
        </div>
        
        <div className="relative z-10">
          {/* Logo & Title */}
          <div className="mb-8 text-center">
            {platformLogo ? (
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl overflow-hidden bg-[var(--primary)]/20 backdrop-blur-sm shadow-lg shadow-[var(--primary)]/20">
                <img
                  src={platformLogo}
                  alt=""
                  className="h-16 w-16 scale-[1.025] rounded-2xl object-cover"
                  onError={(event) => handlePlatformBrandLogoError(event, publicBranding)}
                />
              </div>
            ) : (
              <div className="login-brand-mark mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--primary)]/80 backdrop-blur-sm shadow-lg shadow-[var(--primary)]/30">
                <svg className="login-brand-icon h-8 w-8 text-[var(--primary-foreground)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                </svg>
              </div>
            )}
            <h1 className="login-form-title text-2xl font-bold text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
              {title || platformName || "自媒体文案操盘手"}
            </h1>
            <p className="login-form-subtitle mt-2 text-xs text-white/60 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">
              {subtitle || (mode === "register" ? "创建新账号" : "请登录您的账号")}
            </p>
          </div>

          {/* ── 安全问题验证弹层 ── */}
          {needSecurityVerify ? (
            <div className="space-y-4">
              {/* 区域提示 */}
              <div className="login-security-notice rounded-xl bg-amber-500/15 backdrop-blur-sm border border-amber-400/20 px-4 py-3">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <div className="text-sm text-amber-200">
                    <p className="font-medium">异地登录验证</p>
                    <p className="mt-1 text-amber-200/70">
                      检测到您当前登录地：<span className="text-amber-200 font-medium">{regionInfo?.province || '未知'} {regionInfo?.city || ''}</span>
                    </p>
                    <p className="text-amber-200/70">非贵州省登录需完成额外验证</p>
                  </div>
                </div>
              </div>

              {/* 安全问题 */}
              <form ref={securityFormRef} onSubmit={handleSecurityVerify} action="#" method="post" data-react-managed className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-white/80">{securityQuestion}</label>
                  <input
                    name="securityAnswer"
                    type="text"
                    value={securityAnswer}
                    onChange={(e) => setSecurityAnswer(e.target.value)}
                    placeholder="请输入答案"
                    className="w-full rounded-xl bg-white/[0.08] backdrop-blur-sm border border-white/15 px-4 py-3 text-sm text-white placeholder:text-white/30 transition-all focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                    autoFocus
                  />
                </div>

                {error && (
                  <div className="login-form-error rounded-lg bg-red-500/15 backdrop-blur-sm px-4 py-3 text-sm text-red-200 border border-red-400/20">
                    {error}
                  </div>
                )}

                {modeEnabled("account") && <button
                  type="submit"
                  disabled={loading || !securityAnswer.trim()}
                  className="login-security-action w-full rounded-xl bg-amber-500 hover:bg-amber-400 px-4 py-3 text-sm font-semibold text-slate-900 shadow-lg shadow-amber-500/30 transition-all hover:shadow-amber-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      验证中...
                    </span>
                  ) : "验证并登录"}
                </button>}

                <button
                  type="button"
                  onClick={() => {
                    setNeedSecurityVerify(false);
                    setSecurityAnswer("");
                    setRegionInfo(null);
                    setError("");
                  }}
                  className="login-secondary-action w-full py-2.5 bg-white/[0.06] backdrop-blur-sm border border-white/10 hover:border-white/30 text-white/50 hover:text-white/80 rounded-xl text-sm transition-all"
                >
                  返回重新登录
                </button>
              </form>
            </div>
          ) : (
            <>
              {/* Login Mode Tabs */}
              <div className="login-mode-tabs mb-5 flex rounded-xl bg-white/[0.10] backdrop-blur-sm border border-white/15 p-1" role="tablist" aria-label="登录方式">
                {modeEnabled("account") && <button
                  type="button"
                  onClick={() => { setMode("account"); setError(""); }}
                  className={`login-mode-tab flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
                    mode === "account"
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md shadow-[var(--primary)]/30"
                      : "text-white/60 hover:text-white/90"
                  }`}
                  role="tab"
                  aria-selected={mode === "account"}
                >
                  账号登录
                </button>}
                {modeEnabled("email") && <button
                  type="button"
                  onClick={() => { setMode("email"); setError(""); }}
                  className={`login-mode-tab flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
                    mode === "email"
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md shadow-[var(--primary)]/30"
                      : "text-white/60 hover:text-white/90"
                  }`}
                  role="tab"
                  aria-selected={mode === "email"}
                >
                  邮箱登录
                </button>}
                {modeEnabled("register") && <button
                  type="button"
                  onClick={() => { setMode("register"); setError(""); }}
                  className={`login-mode-tab flex-1 rounded-lg py-2 text-sm font-medium transition-all ${
                    mode === "register"
                      ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md shadow-[var(--primary)]/30"
                      : "text-white/60 hover:text-white/90"
                  }`}
                  role="tab"
                  aria-selected={mode === "register"}
                >
                  注册
                </button>}
              </div>

              {/* 账号登录 */}
              {mode === "account" ? (
                <form ref={accountFormRef} onSubmit={handleAccountLogin} action="#" method="post" data-react-managed className="space-y-4">
                  <div>
                    <label htmlFor="login-account" className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">账号</label>
                    <input
                      id="login-account"
                      name="account"
                      type="text"
                      autoComplete="username"
                      value={account}
                      onChange={(e) => setAccount(e.target.value.trim())}
                      placeholder="请输入手机号、用户名或邮箱"
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">密码</label>
                    <div className="relative">
                      <input
                        id="login-password"
                        name="password"
                        type={showLoginPassword ? "text" : "password"}
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="请输入密码"
                        className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 pr-12 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowLoginPassword(!showLoginPassword)}
                        className="login-password-toggle absolute top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                        aria-label={showLoginPassword ? "隐藏密码" : "显示密码"}
                        aria-controls="login-password"
                        aria-pressed={showLoginPassword}
                        title={showLoginPassword ? "隐藏密码" : "显示密码"}
                      >
                        {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="login-form-error rounded-lg bg-red-500/15 backdrop-blur-sm px-4 py-3 text-sm text-red-200 border border-red-400/20">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="login-primary-action w-full rounded-xl bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] shadow-lg shadow-[var(--primary)]/30 transition-all hover:brightness-110 hover:shadow-[var(--primary)]/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        登录中...
                      </span>
                    ) : (
                      "登 录"
                    )}
                  </button>
                </form>
              ) : mode === "email" ? (
                /* 邮箱验证码登录 */
                <form ref={emailFormRef} onSubmit={handleEmailLogin} action="#" method="post" data-react-managed className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">邮箱地址</label>
                    <input
                      name="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value.trim())}
                      placeholder="请输入注册邮箱"
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                      required
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">验证码</label>
                    <div className="flex gap-3">
                      <input
                        name="emailCode"
                        type="text"
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="6位验证码"
                        maxLength={6}
                        className="flex-1 rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                        required
                      />
                      <button
                        type="button"
                        onClick={handleSendCode}
                        disabled={codeCountdown > 0 || sendingCode || !email}
                        className="login-primary-action shrink-0 rounded-xl bg-[var(--primary)]/80 px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] shadow-lg shadow-[var(--primary)]/20 transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {sendingCode ? "发送中..." : codeCountdown > 0 ? `${codeCountdown}s` : codeSent ? "重新发送" : "获取验证码"}
                      </button>
                    </div>
                    {codeSent && (
                      <div className="login-form-hint mt-2 flex items-start gap-1.5 text-[11px] text-white/45 leading-relaxed">
                        <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                        <span>验证码已发送至邮箱，5分钟内有效。如未收到请检查垃圾邮件/广告邮件文件夹</span>
                      </div>
                    )}
                  </div>

                  {error && (
                    <div className="login-form-error rounded-lg bg-red-500/15 backdrop-blur-sm px-4 py-3 text-sm text-red-200 border border-red-400/20">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="login-primary-action w-full rounded-xl bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] shadow-lg shadow-[var(--primary)]/30 transition-all hover:brightness-110 hover:shadow-[var(--primary)]/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        登录中...
                      </span>
                    ) : (
                      "登 录"
                    )}
                  </button>
                </form>
              ) : (
                /* 注册表单 */
                <form onSubmit={handleRegister} action="#" method="post" data-react-managed className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">QQ邮箱 <span className="text-red-300">*</span></label>
                    <input
                      name="regEmail"
                      type="email"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value.trim())}
                      placeholder="例如 123456789@qq.com"
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                      required
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">邮箱验证码 <span className="text-red-300">*</span></label>
                    <div className="flex gap-3">
                      <input
                        name="regCode"
                        type="text"
                        value={regCode}
                        onChange={(e) => setRegCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="6位验证码"
                        maxLength={6}
                        className="flex-1 rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                        required
                      />
                      <button
                        type="button"
                        onClick={handleSendRegCode}
                        disabled={regCodeCountdown > 0 || regSendingCode || !regEmail}
                        className="login-primary-action shrink-0 rounded-xl bg-[var(--primary)]/80 px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] shadow-lg shadow-[var(--primary)]/20 transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {regSendingCode ? "发送中..." : regCodeCountdown > 0 ? `${regCodeCountdown}s` : regCodeSent ? "重新发送" : "获取验证码"}
                      </button>
                    </div>
                    {regCodeSent && (
                      <div className="login-form-hint mt-2 flex items-start gap-1.5 text-[11px] text-white/45 leading-relaxed">
                        <svg className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                        </svg>
                        <span>验证码已发送至邮箱，5分钟内有效。如未收到请检查垃圾邮件/广告邮件文件夹</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">手机号 <span className="text-red-300">*</span></label>
                    <input
                      name="regPhone"
                      type="tel"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value.replace(/\D/g, ""))}
                      placeholder="请输入11位手机号"
                      maxLength={11}
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="register-password" className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">设置密码 <span className="text-red-300">*</span></label>
                    <div className="relative">
                      <input
                        id="register-password"
                        name="regPassword"
                        type={showRegPassword ? "text" : "password"}
                        autoComplete="new-password"
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="至少8位，包含字母和数字"
                        minLength={8}
                        className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 pr-12 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegPassword(!showRegPassword)}
                        className="login-password-toggle absolute top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70 transition-colors"
                        aria-label={showRegPassword ? "隐藏密码" : "显示密码"}
                        aria-controls="register-password"
                        aria-pressed={showRegPassword}
                        title={showRegPassword ? "隐藏密码" : "显示密码"}
                      >
                        {showRegPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">邀请码 <span className="text-red-300">*</span></label>
                    <input
                      name="regInvitationCode"
                      type="text"
                      value={regInvitationCode}
                      onChange={(e) => setRegInvitationCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                      placeholder="请输入邀请码（联系现有学员获取）"
                      maxLength={8}
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
                      required
                    />
                    <p className="login-form-invitation-hint mt-1.5 text-[11px] text-amber-300/60">{initialInvitationCode ? "已从邀请链接安全填入；每枚邀请码只能成功注册一人" : "注册需邀请码，请联系平台学员获取"}</p>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-white/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]">昵称（选填）</label>
                    <input
                      type="text"
                      value={regDisplayName}
                      onChange={(e) => setRegDisplayName(e.target.value)}
                      placeholder="给自己取个名字吧"
                      className="w-full rounded-xl bg-white/[0.12] backdrop-blur-sm border border-white/20 px-4 py-3 text-sm text-white placeholder:text-white/35 transition-all focus:border-[var(--primary)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20"
                    />
                  </div>

                  {error && (
                    <div className="login-form-error rounded-lg bg-red-500/15 backdrop-blur-sm px-4 py-3 text-sm text-red-200 border border-red-400/20">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading}
                    className="login-primary-action w-full rounded-xl bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] shadow-lg shadow-[var(--primary)]/30 transition-all hover:brightness-110 hover:shadow-[var(--primary)]/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        注册中...
                      </span>
                    ) : (
                      "注 册"
                    )}
                  </button>

                  {!footerNote && (
                    <p className="login-form-footer px-2 text-center text-xs leading-5 text-white/50">
                      {`注册即表示同意平台使用条款${publishedContact ? ` · ${publishedContact}` : ""}`}
                    </p>
                  )}
                </form>
              )}
            </>
          )}
        </div>
      </div>

      {footerNote && (
        <p
          className="login-form-footer mt-5 text-center text-xs text-white/50"
          style={footerTextColor ? { color: footerTextColor } : undefined}
        >
          {footerNote}
        </p>
      )}

      {/* 备案号已隐藏 */}
    </div>
  );
}
