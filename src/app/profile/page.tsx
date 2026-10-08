"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Wallet, Coins, TrendingUp, TrendingDown, ArrowDownUp, Zap, Video, BarChart3, Layers, QrCode, Copy, Check, Gift, Users, UserPlus, Send, Sparkles, Eye, EyeOff, Upload, ShieldCheck, Mail, Smartphone, Camera, ChevronRight, BellRing } from "lucide-react";
import { RechargeDialog } from "@/components/recharge-dialog";
import { useApp } from "@/contexts/app-context";
import { normalizeDisplayText } from "@/lib/display-normalization";
import { buildInvitationShareText } from "@/lib/invitation-share";
import { isQqEmail, normalizeQqEmail } from "@/lib/qq-email";
import { USER_PROFILE_AVATAR_PRESETS } from "@/lib/user-profile-avatar";

interface UserInfo {
  id: string;
  username: string;
  display_name: string;
  phone: string;
  email: string;
  role: string;
  credits: number;
  memberStatus?: string;
  hasPassword?: boolean;
  avatarUrl?: string;
}

interface Transaction {
  id: string;
  type: string;
  amount: number;
  description: string;
  timestamp: number;
  balanceAfter: number;
  metadata?: {
    agent_name?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    actual_cost_rmb?: number;
    credits_per_1k_input?: number;
    credits_per_1k_output?: number;
    total_tokens?: number;
  };
}

interface Announcement {
  id: string;
  title: string;
  content: string;
  is_pinned: boolean;
  created_at: string;
  summary?: string | null;
  priority?: "normal" | "important" | "urgent";
}

interface UserAssets {
  credits: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
  cash: {
    balance: number;
    totalRecharged: number;
    totalConsumed: number;
  };
  recentCreditTransactions: CreditTxRecord[];
  recentCashTransactions: CashTxRecord[];
}

interface CreditTxRecord {
  id: string;
  type: string;
  amount: number;
  description: string;
  balance_after: number;
  created_at: string;
  metadata?: {
    agent_name?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
    actual_cost_rmb?: number;
  };
}

interface CashTxRecord {
  id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string;
  reference_id?: string;
  created_at: string;
}

function remainingAssetPercent(balance: number, consumed: number): number {
  const safeBalance = Math.max(0, Number(balance) || 0);
  const capacity = safeBalance + Math.max(0, Number(consumed) || 0);
  return capacity > 0 ? Math.min(100, (safeBalance / capacity) * 100) : 0;
}

function maskSecurityEmail(email: string): string {
  const [local, domain] = normalizeQqEmail(email).split("@");
  if (!local || !domain) return "未绑定";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(3, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function AssetAvailabilityBar({
  label,
  balance,
  consumed,
  format,
}: {
  label: string;
  balance: number;
  consumed: number;
  format: (value: number) => string;
}) {
  const safeBalance = Math.max(0, Number(balance) || 0);
  const safeConsumed = Math.max(0, Number(consumed) || 0);
  const capacity = safeBalance + safeConsumed;
  const percent = remainingAssetPercent(safeBalance, safeConsumed);
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/55 p-4" data-testid={`asset-availability-${label}`}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">{label}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">可用 {format(safeBalance)} · 已使用 {format(safeConsumed)}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-[var(--primary)]">{percent.toFixed(1)}%</p>
          <p className="text-[11px] text-[var(--muted-foreground)]">当前可用</p>
        </div>
      </div>
      <div
        className="h-3 overflow-hidden rounded-full"
        style={{ backgroundColor: "color-mix(in srgb, var(--muted-foreground) 18%, transparent)" }}
        role="progressbar"
        aria-label={`${label}当前可用比例`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(percent.toFixed(1))}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${percent}%`, backgroundColor: "var(--primary)" }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-[var(--muted-foreground)]">
        <span>当前容量 {format(capacity)}</span>
        <span>消耗后进度会按实际余额递减</span>
      </div>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-[var(--foreground)]">加载中...</div>}>
      <ProfilePageContent />
    </Suspense>
  );
}

function ProfilePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { dispatch, fetchAgents, checkAuth } = useApp();
  // 组件卸载时清理所有倒计时 timer
  const emailTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phoneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const passwordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    return () => {
      if (emailTimerRef.current) clearInterval(emailTimerRef.current);
      if (phoneTimerRef.current) clearInterval(phoneTimerRef.current);
      if (passwordTimerRef.current) clearInterval(passwordTimerRef.current);
    };
  }, []);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [assets, setAssets] = useState<UserAssets | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "cami" | "records" | "password" | "phone" | "email" | "announcements" | "invitation" | "notifications">("overview");

  // 监听 URL 参数变化，同步 activeTab
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'recharge' || tab === 'cami') setActiveTab('cami');
    else if (tab === 'records') setActiveTab('records');
    else if (tab === 'password') setActiveTab('password');
    else if (tab === 'phone') setActiveTab('phone');
    else if (tab === 'email') setActiveTab('email');
    else if (tab === 'announcements') setActiveTab('announcements');
    else if (tab === 'invitation') setActiveTab('invitation');
    else if (tab === 'notifications') setActiveTab('notifications');
  }, [searchParams]);

  // 卡密兑换相关
  const [camiCode, setCamiCode] = useState("");
  const [camiRedeeming, setCamiRedeeming] = useState(false);
  const [camiResult, setCamiResult] = useState<{
    success: boolean;
    message: string;
    credits?: number;
    cash_balance?: number;
    duration_days?: number;
    plan_name?: string;
    allowed_categories?: string[];
  } | null>(null);
  const [cashBalance, setCashBalance] = useState(0);
  const [rechargeOpen, setRechargeOpen] = useState(false);

  const displayText = (value: unknown, fallback = "记录") => normalizeDisplayText(value, fallback);

  // 刷新资产数据（充值成功后调用）
  const refreshAssets = useCallback(async () => {
    const token = localStorage.getItem("auth_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const userId = user?.id || JSON.parse(localStorage.getItem("auth_user") || "{}").id;
      const [creditsRes, assetsRes] = await Promise.all([
        userId ? fetch(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, { headers }) : Promise.resolve(null),
        fetch("/api/user/assets", { headers }),
      ]);
      if (creditsRes && creditsRes.ok) {
        const creditsData = await creditsRes.json();
        setCashBalance(creditsData.cashBalance ?? 0);
        setTransactions(creditsData.transactions || []);
      }
      if (assetsRes.ok) {
        const assetsData = await assetsRes.json();
        setAssets(assetsData);
      }
    } catch {}
  }, [user?.id]);

  // 充值记录相关
  const [txData, setTxData] = useState<{
    transactions: any[];
    summary: {
      totalCreditsRecharged: number;
      totalCreditsConsumed: number;
      creditBalance: number;
      totalCashRecharged: number;
      totalCashConsumed: number;
      cashBalance: number;
    };
    pagination: { page: number; pageSize: number; total: number; creditTotal: number; cashTotal: number; videoTotal: number; paymentTotal: number };
  } | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txPage, setTxPage] = useState(1);
  const [txType, setTxType] = useState<"all" | "credits" | "cash">("all");

  // 修改密码
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [passwordEmailCode, setPasswordEmailCode] = useState("");
  const [passwordCodeCountdown, setPasswordCodeCountdown] = useState(0);
  const [sendingPasswordCode, setSendingPasswordCode] = useState(false);
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // 绑定手机
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneMsg, setPhoneMsg] = useState("");
  const [phoneEmailCode, setPhoneEmailCode] = useState("");
  const [phoneCodeCountdown, setPhoneCodeCountdown] = useState(0);
  const [sendingPhoneCode, setSendingPhoneCode] = useState(false);

  // 绑定邮箱
  const [emailInput, setEmailInput] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const [emailCodeCountdown, setEmailCodeCountdown] = useState(0);
  const [sendingEmailCode, setSendingEmailCode] = useState(false);

  // 头像
  const avatarFileRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState("");
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "success" | "error">("idle");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);

  // 邀请码相关
  const [inviteCodes, setInviteCodes] = useState<Array<{ id: string; code: string; is_used: boolean; used_at: string | null; created_at: string }>>([]);
  const [inviteRecords, setInviteRecords] = useState<Array<{ id: string; invitee: { display_name: string; phone: string; member_status: string }; invitee_activated: boolean; invited_at: string; activated_at: string | null }>>([]);
  const [inviteStats, setInviteStats] = useState({ totalInvited: 0, activatedCount: 0 });
  const [inviteQuota, setInviteQuota] = useState({
    monthlyLimit: 6,
    issuedThisMonth: 0,
    remainingThisMonth: 6,
    resetsAt: "",
    canGenerate: true,
  });
  const [inviteBenefits, setInviteBenefits] = useState<Array<{ id: string; title: string; content: string; created_at: string }>>([]);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const inviteOwnerEligible = user?.role === "admin" || user?.memberStatus === "active";

  // 通知中心
  const [userNotifications, setUserNotifications] = useState<Array<{
    id: string; type: string; title: string; content: string;
    has_cami_code: boolean; is_read: boolean; created_at: string;
  }>>([]);

  const getToken = () => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("auth_token") || "";
    }
    return "";
  };

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push("/");
      return;
    }
    loadData(token);
  }, []);

  const loadData = async (token: string) => {
    try {
      setLoading(true);
      const headers = { Authorization: `Bearer ${token}` };

      // 先获取用户信息（包含积分）
      const meRes = await fetch("/api/auth/me", { headers });

      let userData: Record<string, unknown> | null = null;
      if (meRes.ok) {
        const meData = await meRes.json();
        userData = meData.user;
        if (userData) {
          setUser({
            id: userData.id as string,
            username: userData.username as string,
            display_name: (userData.displayName || userData.display_name || userData.username) as string,
            phone: (userData.phone || "") as string,
            email: (userData.email || "") as string,
            role: userData.role as string,
            credits: userData.credits as number,
            memberStatus: (userData.memberStatus || userData.member_status) as string | undefined,
            hasPassword: userData.hasPassword as boolean | undefined,
            avatarUrl: (userData.avatarUrl || "") as string,
          });
          setPhoneInput("");
          setEmailInput((userData.email || "") as string);
        }
      } else {
        router.push("/");
        return;
      }

      // 并行加载积分流水和公告
      const userId = userData?.id || JSON.parse(localStorage.getItem("auth_user") || "{}").id;
      const [creditsRes, announceRes] = await Promise.all([
        userId ? fetch(`/api/credits?user_id=${encodeURIComponent(userId)}&include_transactions=0`, { headers }) : Promise.resolve(null),
        fetch("/api/announcements"),
      ]);

      // /api/credits 同时返回 credits + cashBalance + transactions
      if (creditsRes && creditsRes.ok) {
        const creditsData = await creditsRes.json();
        setCashBalance(creditsData.cashBalance ?? 0);
        setTransactions(creditsData.transactions || []);
      }

      // 获取用户资产概览（充值/消耗/余额统计）
      try {
        const assetsRes = await fetch("/api/user/assets", { headers });
        if (assetsRes.ok) {
          const assetsData = await assetsRes.json();
          setAssets(assetsData);
        }
      } catch {}

      if (announceRes.ok) {
        const announceData = await announceRes.json();
        setAnnouncements(announceData.announcements || []);
      }
    } catch (err) {
      console.error("Failed to load profile data:", err);
    } finally {
      setLoading(false);
    }
  };

  // 加载充值记录（仅充值记录）
  const loadTransactions = async (page: number = 1, append: boolean = false) => {
    try {
      setTxLoading(true);
      const token = getToken();
      const params = new URLSearchParams({
        type: txType,
        page: page.toString(),
        pageSize: "20",
        transactionType: "recharge",
      });
      const res = await fetch(`/api/user/transactions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          if (append && txData) {
            setTxData({
              ...data.data,
              transactions: [...txData.transactions, ...data.data.transactions],
            });
          } else {
            setTxData(data.data);
          }
          setTxPage(page);
        }
      }
    } catch (err) {
      console.error("加载充值记录失败:", err);
    } finally {
      setTxLoading(false);
    }
  };

  // 当筛选条件变化时重新加载
  useEffect(() => {
    if (activeTab === "records") {
      loadTransactions(1, false);
    }
    if (activeTab === "invitation") {
      loadInvitationData();
    }
    if (activeTab === "notifications") {
      loadUserNotifications();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // 加载邀请码数据
  const loadInvitationData = async () => {
    const token = getToken();
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const [codesRes, recordsRes, benefitsRes] = await Promise.all([
        fetch("/api/invitation/my-codes", { headers }),
        fetch("/api/invitation/records", { headers }),
        fetch("/api/invitation/benefits"),
      ]);
      if (codesRes.ok) {
        const codesData = await codesRes.json();
        if (codesData.success) {
          setInviteCodes(codesData.codes);
          if (codesData.quota) setInviteQuota(codesData.quota);
        }
      }
      if (recordsRes.ok) {
        const recordsData = await recordsRes.json();
        if (recordsData.success) {
          setInviteRecords(recordsData.records);
          setInviteStats(recordsData.stats);
        }
      }
      if (benefitsRes.ok) {
        const benefitsData = await benefitsRes.json();
        if (benefitsData.success) setInviteBenefits(benefitsData.benefits);
      }
    } catch (err) {
      console.error("加载邀请码数据失败:", err);
    }
  };

  // 加载用户通知
  const loadUserNotifications = async () => {
    const token = getToken();
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const res = await fetch("/api/notifications/user", { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.success) setUserNotifications(data.notifications);
      }
    } catch (err) {
      console.error("加载通知失败:", err);
    }
  };

  // 凭通知 ID 兑换已绑定的激活卡；卡密明文永不进入浏览器。
  const handleRedeemCamiFromNotification = async (notificationId: string) => {
    try {
      const token = getToken();
      const res = await fetch("/api/cami", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `cami-notification:${notificationId}`,
        },
        body: JSON.stringify({ notificationId, client_request_id: `cami-notification:${notificationId}` }),
      });
      const data = await res.json();
      if (data.success) {
        alert("会员激活成功！");
        // 标记通知已读
        await fetch("/api/notifications/user", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ notificationId }),
        });
        loadUserNotifications();
        refreshAssets();
      } else {
        alert(data.error || "卡密兑换失败");
      }
    } catch {
      alert("网络错误，请重试");
    }
  };

  const handleMarkUserNotificationRead = async (notificationId: string) => {
    const token = getToken();
    try {
      const response = await fetch("/api/notifications/user", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notificationId }),
      });
      if (!response.ok) throw new Error("已读状态保存失败");
      setUserNotifications((current) => current.map((notification) => notification.id === notificationId
        ? { ...notification, is_read: true }
        : notification));
      window.dispatchEvent(new Event("refresh-account-notifications"));
    } catch {
      alert("已读状态保存失败，请稍后重试");
    }
  };

  const handleGenerateCode = async () => {
    if (!inviteOwnerEligible) {
      alert("邀请码仅向有效期内的正式会员开放；体验会员或未激活账号不能生成邀请码。");
      return;
    }
    if (inviteCodes.some((code) => !code.is_used)) {
      alert("当前一次性邀请码尚未使用；好友注册成功后才能生成下一枚。");
      return;
    }
    setGeneratingCode(true);
    try {
      const token = getToken();
      const res = await fetch("/api/invitation/generate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        if (data.quota) setInviteQuota(data.quota);
        await loadInvitationData();
      } else {
        if (data.quota) setInviteQuota(data.quota);
        alert(data.error || "生成邀请码失败");
      }
    } catch {
      alert("网络错误，请重试");
    } finally {
      setGeneratingCode(false);
    }
  };

  // 复制完整邀请说明，好友打开链接后邀请码会自动填入注册表单。
  const handleCopyCode = (code: string) => {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const shareText = buildInvitationShareText({ code, origin });
    navigator.clipboard.writeText(shareText).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    }).catch(() => {
      alert("复制失败，请检查浏览器剪贴板权限");
    });
  };

  const handleSendPasswordCode = async () => {
    setPasswordMsg("");
    if (!user?.email || !isQqEmail(user.email)) {
      setPasswordMsg("请先绑定已验证的QQ邮箱");
      return;
    }
    if (passwordCodeCountdown > 0) return;
    setSendingPasswordCode(true);
    try {
      const token = getToken();
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "send_code" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPasswordMsg(data.error || "验证码发送失败");
        return;
      }
      setPasswordCodeCountdown(60);
      const timer = setInterval(() => {
        setPasswordCodeCountdown((previous) => {
          if (previous <= 1) {
            clearInterval(timer);
            passwordTimerRef.current = null;
            return 0;
          }
          return previous - 1;
        });
      }, 1000);
      passwordTimerRef.current = timer;
      setPasswordMsg("验证码发送成功，请查收当前QQ邮箱");
    } catch {
      setPasswordMsg("网络错误");
    } finally {
      setSendingPasswordCode(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordMsg("");
    if (!newPassword || !confirmPassword) {
      setPasswordMsg("请填写所有字段");
      return;
    }
    // 已有密码时需要验证旧密码
    if ((user as any)?.hasPassword !== false && !oldPassword) {
      setPasswordMsg("请输入当前密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg("两次输入的新密码不一致");
      return;
    }
    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setPasswordMsg("新密码至少8位，且需同时包含字母和数字");
      return;
    }
    if (!passwordEmailCode) {
      setPasswordMsg("请输入QQ邮箱验证码");
      return;
    }

    try {
      const token = getToken();
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "change", oldPassword, newPassword, emailCode: passwordEmailCode }),
      });
      const data = await res.json();
      if (data.success) {
        setPasswordMsg("密码修改成功");
        setOldPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setPasswordEmailCode("");
      } else {
        setPasswordMsg(data.error || "修改失败");
      }
    } catch {
      setPasswordMsg("网络错误");
    }
  };

  const handleSendPhoneCode = async () => {
    setPhoneMsg("");
    if (!phoneInput || !/^1[3-9]\d{9}$/.test(phoneInput)) {
      setPhoneMsg("请输入正确的手机号");
      return;
    }
    if (!user?.email || !isQqEmail(user.email)) {
      setPhoneMsg("请先绑定QQ安全邮箱");
      return;
    }
    if (phoneCodeCountdown > 0) return;

    setSendingPhoneCode(true);
    try {
      const token = getToken();
      const res = await fetch("/api/auth/change-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "send_code", phone: phoneInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhoneMsg(data.error || "验证码发送失败");
        return;
      }
      setPhoneMsg(data.message || "验证码已发送至当前安全邮箱");
      setPhoneCodeCountdown(60);
      const timer = setInterval(() => {
        setPhoneCodeCountdown(previous => {
          if (previous <= 1) {
            clearInterval(timer);
            phoneTimerRef.current = null;
            return 0;
          }
          return previous - 1;
        });
      }, 1000);
      phoneTimerRef.current = timer;
    } catch {
      setPhoneMsg("网络错误");
    } finally {
      setSendingPhoneCode(false);
    }
  };

  const handleBindPhone = async () => {
    setPhoneMsg("");
    if (!phoneInput || !/^1[3-9]\d{9}$/.test(phoneInput)) {
      setPhoneMsg("请输入正确的手机号");
      return;
    }
    if (phoneEmailCode.length !== 6) {
      setPhoneMsg("请输入6位QQ邮箱验证码");
      return;
    }

    try {
      const token = getToken();
      const res = await fetch("/api/auth/change-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "change", phone: phoneInput, emailCode: phoneEmailCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPhoneMsg(data.error || "手机号更新失败");
        return;
      }
      setUser(prev => prev ? { ...prev, phone: phoneInput } : prev);
      setPhoneEmailCode("");
      setPhoneMsg("手机号更新成功");
      await checkAuth();
    } catch {
      setPhoneMsg("网络错误");
    }
  };

  // 发送邮箱验证码
  const handleSendEmailCode = async () => {
    setEmailMsg("");
    if (!emailInput) {
      setEmailMsg("请输入QQ邮箱");
      return;
    }
    if (!isQqEmail(emailInput)) {
      setEmailMsg("请输入QQ邮箱（例如 123456789@qq.com）");
      return;
    }
    if (emailCodeCountdown > 0) return;

    setSendingEmailCode(true);
    try {
      const token = getToken();
      const res = await fetch("/api/auth/bind-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "send_code", email: normalizeQqEmail(emailInput) }),
      });
      const data = await res.json();

      if (!res.ok) {
        setEmailMsg(data.error || "发送失败");
        return;
      }

      setEmailCodeCountdown(60);
      const timer = setInterval(() => {
        setEmailCodeCountdown(prev => {
          if (prev <= 1) {
            clearInterval(timer);
            emailTimerRef.current = null;
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      emailTimerRef.current = timer;
    } catch {
      setEmailMsg("网络错误");
    } finally {
      setSendingEmailCode(false);
    }
  };

  // 绑定邮箱
  const handleBindEmail = async () => {
    setEmailMsg("");
    if (!emailInput) {
      setEmailMsg("请输入QQ邮箱");
      return;
    }
    if (!isQqEmail(emailInput)) {
      setEmailMsg("请输入QQ邮箱（例如 123456789@qq.com）");
      return;
    }
    if (!emailCode) {
      setEmailMsg("请输入验证码");
      return;
    }

    try {
      const token = getToken();
      const res = await fetch("/api/auth/bind-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "bind",
          email: normalizeQqEmail(emailInput),
          code: emailCode,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setUser(prev => prev ? { ...prev, email: normalizeQqEmail(emailInput) } : prev);
        setEmailMsg("QQ邮箱验证并绑定成功");
        setEmailCode("");
      } else {
        setEmailMsg(data.error || "绑定失败");
      }
    } catch {
      setEmailMsg("网络错误");
    }
  };

  const saveAvatarPreset = async (presetUrl: string) => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setAvatarMsg("");
    setAvatarStatus("idle");
    try {
      const res = await fetch("/api/auth/avatar", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ presetUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAvatarMsg(data.error || "头像保存失败");
        setAvatarStatus("error");
        return;
      }
      setUser(previous => previous ? { ...previous, avatarUrl: data.avatarUrl } : previous);
      setAvatarMsg("预设头像已保存");
      setAvatarStatus("success");
      await checkAuth();
    } catch {
      setAvatarMsg("网络错误，请稍后重试");
      setAvatarStatus("error");
    } finally {
      setAvatarBusy(false);
    }
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file || avatarBusy) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAvatarMsg("仅支持 PNG、JPEG 或 WebP 图片");
      setAvatarStatus("error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarMsg("头像图片必须在5MB以内");
      setAvatarStatus("error");
      return;
    }
    setAvatarBusy(true);
    setAvatarMsg("正在安全上传并自动裁切…");
    setAvatarStatus("idle");
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/auth/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setAvatarMsg(data.error || "头像上传失败");
        setAvatarStatus("error");
        return;
      }
      setUser(previous => previous ? { ...previous, avatarUrl: data.avatarUrl } : previous);
      setAvatarMsg("图片已自动裁成 512×512 并保存");
      setAvatarStatus("success");
      await checkAuth();
    } catch {
      setAvatarMsg("网络错误，请稍后重试");
      setAvatarStatus("error");
    } finally {
      setAvatarBusy(false);
      if (avatarFileRef.current) avatarFileRef.current.value = "";
    }
  };

  const formatTime = (ts: number | string) => {
    const d = new Date(typeof ts === "number" ? ts : ts);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // 卡密兑换
  const handleCamiRedeem = async () => {
    if (!camiCode.trim()) return;
    setCamiRedeeming(true);
    setCamiResult(null);
    try {
      const token = getToken();
      const requestId = `cami-profile:${crypto.randomUUID()}`;
      const resp = await fetch("/api/cami", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({ code: camiCode.trim().toUpperCase(), client_request_id: requestId }),
      });
      const data = await resp.json();
      setCamiResult(data);
      if (data.success) {
        setCamiCode("");
        // 刷新用户数据
        loadData(getToken());
        // 刷新全局 auth 状态（会员状态 + 分类权限等）
        await checkAuth();
        // 刷新智能体列表（后端会根据新的 allowed_categories 过滤）
        await fetchAgents();
      }
    } catch {
      setCamiResult({ success: false, message: "网络错误，请重试" });
    } finally {
      setCamiRedeeming(false);
    }
  };

  const tabs = [
    { key: "overview" as const, label: "总览" },
    { key: "invitation" as const, label: "邀请码" },
    { key: "cami" as const, label: "卡密兑换" },
    { key: "records" as const, label: "充值记录" },
    { key: "password" as const, label: user?.hasPassword === false ? "设置密码" : "修改密码" },
    { key: "phone" as const, label: "安全手机" },
    { key: "email" as const, label: "安全邮箱" },
    { key: "announcements" as const, label: "公告中心" },
    { key: "notifications" as const, label: "通知中心" },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-[var(--foreground)]">加载中...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-center">
          <p className="text-[var(--foreground)] mb-4">请先登录</p>
          <Button onClick={() => { dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" }); router.push("/"); }} className="bg-[var(--primary)] text-black hover:bg-[var(--primary)]/80">
            去登录
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen min-w-0 overflow-x-hidden bg-[var(--background)]" data-testid="profile-page">
      {/* 顶部导航 */}
      <div className="border-b border-[var(--border)] bg-[var(--sidebar)]/95 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => { dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" }); router.push("/"); }} className="text-[var(--foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]">
              ← 返回
            </Button>
            <div>
              <h1 className="text-lg font-semibold text-[var(--foreground)]">个人中心</h1>
              <p className="text-xs text-[var(--muted-foreground)]">账户、资产与安全设置</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <ShieldCheck className="h-4 w-4 text-[var(--primary)]" />
            账户保护已启用
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-7">
        {/* Tab 导航 */}
        <div className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--sidebar)] p-2 shadow-sm" data-testid="profile-tab-navigation">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`min-w-max flex-1 rounded-xl px-4 py-2.5 text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--card)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 总览 - 资产可视化面板 */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            <Card className="gap-0 overflow-hidden border-[var(--border)] bg-[var(--card)] py-0 shadow-sm" data-testid="profile-identity-card">
              <div className="h-1 bg-[var(--primary)]" />
              <CardContent className="p-5">
                <div className="flex min-w-0 items-center justify-between gap-5">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-sm">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="个人头像" className="block h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-[var(--primary)] text-xl font-bold text-[var(--primary-foreground)]">
                          {user.display_name?.[0] || user.username[0]}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-xl font-bold text-[var(--foreground)]">{user.display_name || user.username}</h2>
                        <span className="rounded-full bg-[var(--primary)]/10 px-2.5 py-1 text-xs font-semibold text-[var(--primary)]">
                          {user.role === "admin" ? "管理员" : "学员"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">账号 {user.username}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--text-secondary)]">
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
                          <span className="truncate">{maskSecurityEmail(user.email)}</span>
                        </span>
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          <Smartphone className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
                          <span className="truncate">{user.phone || "未绑定手机"}</span>
                        </span>
                      </div>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAvatarMsg("");
                      setAvatarStatus("idle");
                      setAvatarPickerOpen(true);
                    }}
                    className="h-10 shrink-0 gap-2 border-[var(--border)] bg-[var(--background)] px-4 text-[var(--foreground)] hover:border-[var(--primary)] hover:bg-[var(--primary)]/5"
                    data-testid="profile-open-avatar-settings"
                  >
                    <Camera className="h-4 w-4" />
                    设置头像
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* 核心资产卡片 — 积分 + 现金并排 */}
            <div className="grid grid-cols-2 gap-4">
              {/* 积分资产卡片 */}
              <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
                <div className="h-1 bg-gradient-to-r from-blue-500 to-cyan-400" />
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center">
                        <Coins className="w-5 h-5 text-blue-500" />
                      </div>
                      <span className="text-[var(--foreground)] text-sm font-medium">积分资产</span>
                    </div>
                    <Button
                      onClick={() => setActiveTab("cami")}
                      size="sm"
                      className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 h-7 text-xs"
                    >
                      卡密兑换
                    </Button>
                  </div>
                  <p className="text-3xl font-bold text-blue-500 mb-4">
                    {assets ? assets.credits.balance.toLocaleString() : user.credits.toLocaleString()}
                    <span className="text-sm font-normal text-[var(--text-secondary)] ml-1">积分</span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--background)] rounded-lg p-3">
                      <div className="flex items-center gap-1.5 mb-1">
                        <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                        <span className="text-[var(--text-secondary)] text-xs">累计充值</span>
                      </div>
                      <p className="text-[var(--foreground)] text-sm font-semibold">
                        {assets ? assets.credits.totalRecharged.toLocaleString() : "—"}
                      </p>
                    </div>
                    <div className="bg-[var(--background)] rounded-lg p-3">
                      <div className="flex items-center gap-1.5 mb-1">
                        <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                        <span className="text-[var(--text-secondary)] text-xs">累计消耗</span>
                      </div>
                      <p className="text-[var(--foreground)] text-sm font-semibold">
                        {assets ? assets.credits.totalConsumed.toLocaleString() : "—"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 现金资产卡片 */}
              <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
                <div className="h-1 bg-gradient-to-r from-orange-500 to-amber-400" />
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-xl bg-orange-500/10 flex items-center justify-center">
                        <Wallet className="w-5 h-5 text-orange-500" />
                      </div>
                      <span className="text-[var(--foreground)] text-sm font-medium">现金资产</span>
                    </div>
                    <Button
                      onClick={() => setActiveTab("cami")}
                      size="sm"
                      className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 h-7 text-xs"
                    >
                      卡密兑换
                    </Button>
                  </div>
                  <p className="text-3xl font-bold text-orange-500 mb-4">
                    ¥{assets ? assets.cash.balance.toFixed(2) : cashBalance.toFixed(2)}
                    <span className="text-sm font-normal text-[var(--text-secondary)] ml-1">元</span>
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--background)] rounded-lg p-3">
                      <div className="flex items-center gap-1.5 mb-1">
                        <TrendingUp className="w-3.5 h-3.5 text-green-500" />
                        <span className="text-[var(--text-secondary)] text-xs">累计充值</span>
                      </div>
                      <p className="text-[var(--foreground)] text-sm font-semibold">
                        ¥{assets ? assets.cash.totalRecharged.toFixed(2) : "—"}
                      </p>
                    </div>
                    <div className="bg-[var(--background)] rounded-lg p-3">
                      <div className="flex items-center gap-1.5 mb-1">
                        <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                        <span className="text-[var(--text-secondary)] text-xs">累计消耗</span>
                      </div>
                      <p className="text-[var(--foreground)] text-sm font-semibold">
                        ¥{assets ? assets.cash.totalConsumed.toFixed(2) : "—"}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 资产变化可视化条 */}
            {assets && (
              <Card className="bg-[var(--card)] border-[var(--border)]">
                <CardHeader className="pb-3">
                  <CardTitle className="text-[var(--foreground)] text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-[var(--primary)]" />
                    资产构成概览
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 lg:grid-cols-2">
                  <AssetAvailabilityBar
                    label="积分可用量"
                    balance={assets.credits.balance}
                    consumed={assets.credits.totalConsumed}
                    format={value => `${value.toLocaleString()} 积分`}
                  />
                  <AssetAvailabilityBar
                    label="现金可用量（视频 / 封面）"
                    balance={assets.cash.balance}
                    consumed={assets.cash.totalConsumed}
                    format={value => `¥${value.toFixed(2)}`}
                  />
                </CardContent>
              </Card>
            )}

            {/* 个人信息卡片 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base text-[var(--foreground)]">
                  <ShieldCheck className="h-4 w-4 text-[var(--primary)]" /> 账户与安全
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 lg:grid-cols-2">
                {[
                  { label: "登录账号", value: user.username, detail: "唯一账号标识" },
                  { label: "账户角色", value: user.role === "admin" ? "管理员" : "学员", detail: "由平台权限策略管理" },
                  { label: "QQ安全邮箱", value: maskSecurityEmail(user.email), detail: user.email ? "永久身份凭据，不可更改" : "请尽快完成一次性绑定" },
                  { label: "安全手机", value: user.phone || "未绑定", detail: "更换必须验证当前QQ邮箱" },
                ].map(item => (
                  <div key={item.label} className="flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--background)]/55 px-4 py-3.5">
                    <div>
                      <p className="text-xs font-medium text-[var(--muted-foreground)]">{item.label}</p>
                      <p className="mt-1 text-sm font-semibold text-[var(--foreground)]">{item.value}</p>
                    </div>
                    <span className="text-xs text-[var(--muted-foreground)]">{item.detail}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* 最近动态 — 积分+现金合并时间线 */}
            {assets && (assets.recentCreditTransactions.length > 0 || assets.recentCashTransactions.length > 0) && (
              <Card className="bg-[var(--card)] border-[var(--border)]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-[var(--foreground)] text-base flex items-center gap-2">
                      <ArrowDownUp className="w-4 h-4 text-[var(--primary)]" />
                      最近动态
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setActiveTab("records")}
                      className="text-[var(--primary)] text-xs h-7"
                    >
                      查看全部
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {/* 合并最近5条流水（积分+现金） */}
                    {[...assets.recentCreditTransactions.map(t => ({ ...t, assetType: "credits" as const })), ...assets.recentCashTransactions.map(t => ({ ...t, assetType: "cash" as const }))]
                      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                      .slice(0, 8)
                      .map((t) => {
                        const isRecharge = t.type === "recharge" || t.type === "topup";
                        const isCredits = t.assetType === "credits";
                        const amount = Math.abs(Number(t.amount));
                        return (
                          <div key={`${t.assetType}-${t.id}`} className="bg-[var(--background)] rounded-lg p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm ${
                                  isRecharge ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                                }`}>
                                  {isRecharge ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                </div>
                                <div>
                                  <p className="text-[var(--foreground)] text-sm">
                                    {isCredits && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5" />}
                                    {!isCredits && <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-500 mr-1.5" />}
                                    {displayText(t.description, isRecharge ? "充值到账" : isCredits ? "积分消耗" : "现金消耗")}
                                  </p>
                                  <p className="text-[var(--text-secondary)] text-xs">{formatTime(t.created_at)}</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p className={`text-sm font-medium ${isRecharge ? "text-green-400" : "text-red-400"}`}>
                                  {isRecharge ? "+" : "-"}{isCredits ? `${amount} 积分` : `¥${amount.toFixed(2)}`}
                                </p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 最新公告 */}
            {announcements.length > 0 && (
              <Card className="bg-[var(--sidebar)] border-[var(--border)]">
                <CardHeader className="pb-3">
                  <CardTitle className="text-[var(--foreground)] text-base">最新公告</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {announcements.slice(0, 2).map(a => (
                    <div key={a.id} className="bg-[var(--background)] rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        {a.is_pinned && <span className="text-[11px] bg-[var(--primary)]/20 text-[var(--primary)] px-1.5 py-0.5 rounded">置顶</span>}
                        <span className="text-[var(--foreground)] text-sm font-medium">{a.title}</span>
                      </div>
                      <p className="text-[var(--text-secondary)] text-xs">{a.content}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* 卡密兑换 */}
        {activeTab === "cami" && (
          <div className="space-y-6">
            {/* 卡密兑换核心区域 */}
            <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-violet-500 to-fuchsia-500" />
              <CardHeader className="pb-3">
                <CardTitle className="text-[var(--foreground)] text-base flex items-center gap-2">
                  <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                  </svg>
                  卡密兑换
                </CardTitle>
                <p className="text-[var(--muted-foreground)] text-xs mt-1">
                  输入管理员绑定给你的会员卡密，兑换后激活会员；邀请礼包由管理员另行确认
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 卡密输入框 */}
                <div>
                  <label className="text-sm font-medium text-[var(--foreground)] mb-1.5 block">卡密代码</label>
                  <input
                    className="w-full px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 uppercase tracking-[0.15em] text-center font-mono placeholder:tracking-normal placeholder:font-sans placeholder:normal-case"
                    placeholder="输入卡密码（支持粘贴自动清理）"
                    value={camiCode}
                    onChange={(e) => setCamiCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === "Enter" && handleCamiRedeem()}
                    maxLength={35}
                    autoFocus
                  />
                </div>

                {/* 兑换按钮 */}
                <Button
                  onClick={handleCamiRedeem}
                  disabled={camiRedeeming || !camiCode.trim()}
                  className="w-full bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:opacity-90 h-11 text-sm font-medium"
                >
                  {camiRedeeming ? "兑换中..." : "立即兑换"}
                </Button>

                {/* 兑换结果 */}
                {camiResult && (
                  <div className={`p-4 rounded-xl ${camiResult.success ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
                    <p className={`text-sm font-medium ${camiResult.success ? "text-emerald-400" : "text-red-400"}`}>
                      {camiResult.message}
                    </p>
                    {camiResult.success && (
                      <div className="mt-3 space-y-2">
                        <p className="text-xs text-[var(--text-secondary)]">已获得以下权益：</p>
                        <div className="flex flex-wrap gap-2">
                          {Number(camiResult.credits) > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-sm">
                              <Coins className="w-3.5 h-3.5" />
                              +{camiResult.credits} 积分
                            </span>
                          )}
                          {Number(camiResult.cash_balance) > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500/10 text-orange-400 text-sm">
                              <Wallet className="w-3.5 h-3.5" />
                              +¥{Number(camiResult.cash_balance).toFixed(2)} 现金
                            </span>
                          )}
                          {camiResult.duration_days === 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
                              <Zap className="w-3.5 h-3.5" />
                              永久会员
                            </span>
                          )}
                          {Number(camiResult.duration_days) > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">
                              <Zap className="w-3.5 h-3.5" />
                              +{camiResult.duration_days} 天会员
                            </span>
                          )}
                          {camiResult.plan_name && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 text-violet-400 text-sm">
                              套餐：{camiResult.plan_name}
                            </span>
                          )}
                          {Array.isArray(camiResult.allowed_categories) && camiResult.allowed_categories.length > 0 && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 text-sm">
                              <Layers className="w-3.5 h-3.5" />
                              已开通智能体导航栏
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 扫码充值 */}
            <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-blue-500 to-cyan-500" />
              <CardHeader className="pb-3">
                <CardTitle className="text-[var(--foreground)] text-base flex items-center gap-2">
                  <QrCode className="w-5 h-5 text-blue-500" />
                  扫码充值
                </CardTitle>
                <p className="text-[var(--muted-foreground)] text-xs mt-1">
                  通过微信/支付宝扫码在线充值积分或现金
                </p>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setRechargeOpen(true)}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border border-blue-500/20 bg-blue-500/5 hover:bg-blue-500/10 transition-colors"
                  >
                    <Coins className="w-6 h-6 text-blue-500" />
                    <span className="text-sm font-medium text-[var(--foreground)]">充值积分</span>
                    <span className="text-xs text-[var(--muted-foreground)]">用于智能体对话</span>
                  </button>
                  <button
                    onClick={() => setRechargeOpen(true)}
                    className="flex flex-col items-center gap-2 p-4 rounded-xl border border-orange-500/20 bg-orange-500/5 hover:bg-orange-500/10 transition-colors"
                  >
                    <Wallet className="w-6 h-6 text-orange-500" />
                    <span className="text-sm font-medium text-[var(--foreground)]">充值现金</span>
                    <span className="text-xs text-[var(--muted-foreground)]">用于视频/封面生成</span>
                  </button>
                </div>
              </CardContent>
            </Card>

            {/* 卡密边界说明 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardHeader className="pb-3">
                <CardTitle className="text-[var(--foreground)] text-base">会员卡密说明</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-[var(--background)] rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Zap className="w-4 h-4 text-emerald-500" />
                      <span className="text-sm font-medium text-[var(--foreground)]">会员卡密</span>
                    </div>
                    <p className="text-[var(--text-secondary)] text-xs leading-relaxed">激活会员权益，解锁平台功能，限时或永久有效</p>
                  </div>
                  <div className="bg-[var(--background)] rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Layers className="w-4 h-4 text-cyan-500" />
                      <span className="text-sm font-medium text-[var(--foreground)]">智能体导航栏权限卡密</span>
                    </div>
                    <p className="text-[var(--text-secondary)] text-xs leading-relaxed">兑换后开通指定智能体导航栏，对应智能体可见可用</p>
                  </div>
                  <div className="col-span-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-600">
                    新卡密不捆绑积分或现金。邀请注册礼包、正式会员礼包均由管理员在邀请关系中分别确认，兑换卡密不会自动发礼包。
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 当前余额快速查看 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardContent className="p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                      <Coins className="w-5 h-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-[var(--text-secondary)] text-xs">积分余额</p>
                      <p className="text-blue-500 text-lg font-bold">{assets ? assets.credits.balance.toLocaleString() : user?.credits?.toLocaleString() ?? "0"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
                      <Wallet className="w-5 h-5 text-orange-500" />
                    </div>
                    <div>
                      <p className="text-[var(--text-secondary)] text-xs">现金余额</p>
                      <p className="text-orange-500 text-lg font-bold">¥{cashBalance.toFixed(2)}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 充值记录 */}
        {activeTab === "records" && (
          <div className="space-y-4">
            {/* 汇总统计卡片 */}
            {txData && (
              <div className="grid grid-cols-2 gap-4">
                <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
                  <div className="h-1 bg-gradient-to-r from-blue-500 to-cyan-400" />
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Coins className="w-4 h-4 text-blue-500" />
                      <span className="text-[var(--foreground)] text-sm font-medium">积分</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">余额</p>
                        <p className="text-blue-500 text-sm font-bold">{txData.summary.creditBalance.toLocaleString()}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">累计充值</p>
                        <p className="text-green-500 text-sm font-bold">+{txData.summary.totalCreditsRecharged.toLocaleString()}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">累计消耗</p>
                        <p className="text-red-400 text-sm font-bold">-{txData.summary.totalCreditsConsumed.toLocaleString()}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
                  <div className="h-1 bg-gradient-to-r from-orange-500 to-amber-400" />
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Wallet className="w-4 h-4 text-orange-500" />
                      <span className="text-[var(--foreground)] text-sm font-medium">现金</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">余额</p>
                        <p className="text-orange-500 text-sm font-bold">¥{txData.summary.cashBalance.toFixed(2)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">累计充值</p>
                        <p className="text-green-500 text-sm font-bold">+¥{txData.summary.totalCashRecharged.toFixed(2)}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-[var(--foreground)] text-[11px] mb-0.5">累计消耗</p>
                        <p className="text-red-400 text-sm font-bold">-¥{txData.summary.totalCashConsumed.toFixed(2)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* 筛选栏 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  {/* 类型筛选 */}
                  <div className="flex bg-[var(--background)] rounded-lg p-0.5">
                    {[
                      { value: "all" as const, label: "全部" },
                      { value: "credits" as const, label: "积分" },
                      { value: "cash" as const, label: "现金" },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => { setTxType(opt.value); setTxPage(1); }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                          txType === opt.value
                            ? "bg-[var(--primary)] text-black"
                            : "text-[var(--text-secondary)] hover:text-[var(--foreground)]"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 交易列表 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardContent className="p-4">
                {txLoading && !txData ? (
                  <div className="text-center py-12 text-[var(--foreground)]">加载中...</div>
                ) : !txData || txData.transactions.length === 0 ? (
                  <div className="text-center py-12 text-[var(--foreground)]">暂无充值记录</div>
                ) : (
                  <div className="space-y-2">
                    {txData.transactions.map((t: any) => {
                      // 确定图标和颜色
                      const isRecharge = t.type === "recharge" || t.type === "topup" || t.type === "admin_adjust" || t.category === "payment";
                      const isCredits = t.category === "credits";
                      const isVideo = t.category === "video";
                      const isPayment = t.category === "payment";
                      const amount = Math.abs(Number(t.amount));

                      // 分类标签
                      const getCategoryTag = () => {
                        if (isVideo) return { text: "视频", color: "bg-purple-500/20 text-purple-400" };
                        if (isPayment) return { text: "支付", color: "bg-cyan-500/20 text-cyan-400" };
                        if (isCredits) return { text: "积分", color: "bg-blue-500/20 text-blue-400" };
                        return { text: "现金", color: "bg-orange-500/20 text-orange-400" };
                      };
                      const tag = getCategoryTag();

                      // 描述文本
                      const getDescription = () => {
                        if (isVideo) {
                          const statusText = t.status === "completed" ? "完成" : t.status === "failed" ? "失败" : t.status === "processing" ? "生成中" : t.status;
                          return `视频生成（${displayText(t.modelName || t.modelId, "未知模型")}）- ${statusText}`;
                        }
                        if (isPayment) {
                          const payType = t.type === "credits" ? "积分" : "现金";
                          const statusText = t.status === "paid" ? "已支付" : t.status === "expired" ? "已过期" : "待支付";
                          return `在线充值${payType} - ${statusText}`;
                        }
                        return displayText(t.description, isRecharge ? "充值" : "消耗");
                      };

                      // 金额显示
                      const getAmountDisplay = () => {
                        if (isVideo) {
                          if (t.status === "completed") {
                            return { text: `-¥${amount.toFixed(2)}`, className: "text-red-400" };
                          }
                          if (t.status === "failed") {
                            return { text: "未扣费", className: "text-[var(--foreground)]" };
                          }
                          return { text: "待扣费", className: "text-yellow-400" };
                        }
                        if (isPayment) {
                          if (t.status === "paid") {
                            const payAmount = t.creditsAmount || t.cashAmount || amount;
                            return { text: `+${isCredits ? payAmount : `¥${Number(payAmount).toFixed(2)}`}`, className: "text-green-400" };
                          }
                          return { text: `¥${amount.toFixed(2)}`, className: "text-[var(--foreground)]" };
                        }
                        if (isRecharge) {
                          return { text: `+${isCredits ? amount : `¥${amount.toFixed(2)}`}`, className: "text-green-400" };
                        }
                        return { text: `-${isCredits ? amount : `¥${amount.toFixed(2)}`}`, className: "text-red-400" };
                      };
                      const amountDisplay = getAmountDisplay();

                      return (
                        <div key={`${t.category}-${t.id}`} className="bg-[var(--background)] rounded-lg p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                isRecharge ? "bg-green-500/20 text-green-400" : isVideo ? "bg-purple-500/20 text-purple-400" : "bg-red-500/20 text-red-400"
                              }`}>
                                {isVideo ? <Video className="w-4 h-4" /> : isRecharge ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                              </div>
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${tag.color}`}>{tag.text}</span>
                                  <p className="text-[var(--foreground)] text-sm">{getDescription()}</p>
                                </div>
                                <p className="text-[var(--foreground)] text-xs mt-0.5">{formatTime(t.createdAt)}</p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className={`text-sm font-medium ${amountDisplay.className}`}>{amountDisplay.text}</p>
                              {t.balanceAfter != null && (
                                <p className="text-[var(--text-secondary)] text-xs">
                                  余额 {isCredits ? `${Number(t.balanceAfter).toLocaleString()} 积分` : `¥${Number(t.balanceAfter).toFixed(2)}`}
                                </p>
                              )}
                            </div>
                          </div>
                          {/* 积分消耗详情：展示Token和成本 */}
                          {!isRecharge && isCredits && t.metadata && (t.metadata.prompt_tokens || t.metadata.completion_tokens) && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                              {t.metadata.agent_name && <span>智能体: {t.metadata.agent_name}</span>}
                              {t.metadata.model && <span>模型: {t.metadata.model}</span>}
                              {t.metadata.prompt_tokens ? <span>输入 {t.metadata.prompt_tokens.toLocaleString()} token</span> : null}
                              {t.metadata.completion_tokens ? <span>输出 {t.metadata.completion_tokens.toLocaleString()} token</span> : null}
                              {t.metadata.cached_tokens ? <span>缓存 {t.metadata.cached_tokens.toLocaleString()} token</span> : null}
                              {t.metadata.actual_cost_rmb ? <span>成本 ¥{Number(t.metadata.actual_cost_rmb).toFixed(4)}</span> : null}
                              {t.metadata.sell_price_rmb ? <span>售价 ¥{Number(t.metadata.sell_price_rmb).toFixed(4)}</span> : null}
                            </div>
                          )}
                          {/* 视频任务详情 */}
                          {isVideo && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                              {t.aspectRatio && <span>比例 {t.aspectRatio}</span>}
                              {t.durationSeconds && <span>时长 {t.durationSeconds}s</span>}
                              {t.prompt && <span>提示词: {t.prompt}{t.prompt.length >= 100 ? "..." : ""}</span>}
                              {t.errorMessage && <span className="text-red-400">错误: {t.errorMessage}</span>}
                            </div>
                          )}
                          {/* 支付订单详情 */}
                          {isPayment && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                              {t.tradeOrderId && <span>订单号: {t.tradeOrderId}</span>}
                              {t.paidAt && <span>支付时间: {formatTime(t.paidAt)}</span>}
                            </div>
                          )}
                          {/* 现金消耗详情 */}
                          {!isRecharge && !isVideo && !isPayment && t.category === "cash" && t.metadata && (
                            <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted-foreground)]">
                              {t.metadata?.model_name && <span>模型: {t.metadata.model_name}</span>}
                              {t.metadata?.cost_price != null && <span>成本 ¥{Number(t.metadata.cost_price).toFixed(4)}</span>}
                              {t.metadata?.selling_price != null && <span>售价 ¥{Number(t.metadata.selling_price).toFixed(4)}</span>}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* 加载更多 */}
                    {txData.pagination.total > txPage * 20 && (
                      <div className="text-center pt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => loadTransactions(txPage + 1, true)}
                          disabled={txLoading}
                          className="text-[var(--primary)] text-xs"
                        >
                          {txLoading ? "加载中..." : "加载更多"}
                        </Button>
                      </div>
                    )}
                    <p className="text-center text-[var(--foreground)] text-xs pt-2">
                      共 {txData.pagination.total} 条记录
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* 修改密码 */}
        {activeTab === "password" && (
          <Card className="bg-[var(--sidebar)] border-[var(--border)]">
            <CardHeader>
              <CardTitle className="text-[var(--foreground)] text-base">{(user as any)?.hasPassword === false ? '设置登录密码' : '修改登录密码'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {(user as any)?.hasPassword !== false && (
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-1.5 block">当前密码</label>
                <div className="relative">
                  <Input
                    type={showOldPassword ? "text" : "password"}
                    value={oldPassword}
                    onChange={e => setOldPassword(e.target.value)}
                    className="bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] pr-10"
                    placeholder="输入当前密码"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOldPassword(!showOldPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    tabIndex={-1}
                  >
                    {showOldPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              )}
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-1.5 block">新密码</label>
                <div className="relative">
                  <Input
                    type={showNewPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] pr-10"
                    placeholder="至少8位，包含字母和数字"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword(!showNewPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    tabIndex={-1}
                  >
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-1.5 block">确认新密码</label>
                <div className="relative">
                  <Input
                    type={showConfirmPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] pr-10"
                    placeholder="再次输入新密码"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                    tabIndex={-1}
                  >
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-[var(--text-secondary)] text-sm mb-1.5 block">QQ邮箱验证码</label>
                <p className="mb-2 text-xs text-[var(--muted-foreground)]">
                  验证码将发送到当前已绑定QQ邮箱：{user.email || "尚未绑定"}
                </p>
                <div className="flex gap-3">
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={passwordEmailCode}
                    onChange={e => setPasswordEmailCode(e.target.value.replace(/\D/g, ""))}
                    className="bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] flex-1"
                    placeholder="6位验证码"
                    maxLength={6}
                  />
                  <Button
                    type="button"
                    onClick={handleSendPasswordCode}
                    disabled={passwordCodeCountdown > 0 || sendingPasswordCode || !isQqEmail(user.email)}
                    className="shrink-0 bg-[var(--primary)] text-black hover:bg-[var(--primary)]/80 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {sendingPasswordCode ? "发送中..." : passwordCodeCountdown > 0 ? `${passwordCodeCountdown}s` : "获取验证码"}
                  </Button>
                </div>
              </div>
              {passwordMsg && (
                <p className={`text-sm ${passwordMsg.includes("成功") ? "text-green-400" : "text-red-400"}`}>{passwordMsg}</p>
              )}
              <Button onClick={handleChangePassword} className="bg-[var(--primary)] text-black hover:bg-[var(--primary)]/80">
                {(user as any)?.hasPassword === false ? '确认设置' : '确认修改'}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* 安全手机 */}
        {activeTab === "phone" && (
          <Card className="overflow-hidden border-[var(--border)] bg-[var(--card)]" data-testid="phone-security-card">
            <CardHeader className="border-b border-[var(--border)]">
              <CardTitle className="flex items-center gap-2 text-base text-[var(--foreground)]">
                <Smartphone className="h-4 w-4 text-[var(--primary)]" /> {user.phone ? "更换安全手机" : "绑定安全手机"}
              </CardTitle>
              <p className="text-sm text-[var(--muted-foreground)]">为防止账号被接管，更换手机号必须验证当前不可更改的QQ安全邮箱。</p>
            </CardHeader>
            <CardContent className="space-y-5 p-6">
              <div className="flex items-center justify-between rounded-2xl border border-[var(--border)] bg-[var(--background)]/60 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--primary)]/10 text-[var(--primary)]"><Mail className="h-5 w-5" /></div>
                  <div>
                    <p className="text-xs text-[var(--muted-foreground)]">验证码接收邮箱</p>
                    <p className="mt-0.5 text-sm font-semibold text-[var(--foreground)]">{maskSecurityEmail(user.email)}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-500"><ShieldCheck className="h-3.5 w-3.5" /> 已验证</span>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">新手机号</label>
                <Input
                  type="tel"
                  value={phoneInput}
                  onChange={e => setPhoneInput(e.target.value.replace(/\D/g, ""))}
                  className="bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
                  placeholder="输入11位手机号"
                  maxLength={11}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">QQ邮箱验证码</label>
                <div className="flex gap-3">
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={phoneEmailCode}
                    onChange={event => setPhoneEmailCode(event.target.value.replace(/\D/g, ""))}
                    className="flex-1 border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
                    placeholder="6位验证码"
                    maxLength={6}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSendPhoneCode()}
                    disabled={sendingPhoneCode || phoneCodeCountdown > 0 || !/^1[3-9]\d{9}$/.test(phoneInput) || !isQqEmail(user.email)}
                    className="min-w-28 border-[var(--border)]"
                  >
                    {sendingPhoneCode ? "发送中..." : phoneCodeCountdown > 0 ? `${phoneCodeCountdown}s` : "获取验证码"}
                  </Button>
                </div>
              </div>
              {user.phone && <p className="text-xs text-[var(--muted-foreground)]">当前手机号：{user.phone}</p>}
              {phoneMsg && (
                <p className={`text-sm ${phoneMsg.includes("成功") || phoneMsg.includes("已发送") ? "text-emerald-500" : "text-red-500"}`}>{phoneMsg}</p>
              )}
              <Button
                onClick={() => void handleBindPhone()}
                disabled={!/^1[3-9]\d{9}$/.test(phoneInput) || phoneEmailCode.length !== 6}
                className="bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85 disabled:opacity-40"
              >
                验证邮箱并{user.phone ? "更换" : "绑定"}手机号
              </Button>
            </CardContent>
          </Card>
        )}

        {/* QQ安全邮箱 */}
        {activeTab === "email" && (
          <Card className="overflow-hidden border-[var(--border)] bg-[var(--card)]" data-testid="immutable-security-email-card">
            <CardHeader className="border-b border-[var(--border)]">
              <CardTitle className="flex items-center gap-2 text-base text-[var(--foreground)]"><Mail className="h-4 w-4 text-[var(--primary)]" /> QQ安全邮箱</CardTitle>
              <p className="text-sm text-[var(--muted-foreground)]">用于登录验证、修改密码和更换手机号。绑定后成为永久身份凭据，不支持自助或后台改写。</p>
            </CardHeader>
            <CardContent className="p-6">
              {user.email ? (
                <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
                  <div className="flex items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--background)]/60 p-5">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--primary)]/10 text-[var(--primary)]"><ShieldCheck className="h-6 w-6" /></div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted-foreground)]">Verified identity email</p>
                      <p className="mt-1 text-lg font-bold text-[var(--foreground)]">{user.email}</p>
                      <p className="mt-1 text-xs text-[var(--muted-foreground)]">已验证 · 永久锁定 · 不可更改</p>
                    </div>
                  </div>
                  <div className="max-w-sm rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-[var(--text-secondary)]">
                    如邮箱已无法使用，请联系平台人工核验身份；系统不会通过普通资料编辑入口改写邮箱。
                  </div>
                </div>
              ) : (
                <div className="max-w-2xl space-y-4">
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-[var(--text-secondary)]">当前是历史未绑定账号。你可以完成一次QQ邮箱验证；绑定成功后将永久锁定。</div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">QQ邮箱</label>
                    <Input type="email" value={emailInput} onChange={e => setEmailInput(e.target.value.trim())} className="border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]" placeholder="例如 123456789@qq.com" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[var(--text-secondary)]">邮箱验证码</label>
                    <div className="flex gap-3">
                      <Input type="text" inputMode="numeric" value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, ""))} className="flex-1 border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]" placeholder="6位验证码" maxLength={6} />
                      <Button type="button" onClick={() => void handleSendEmailCode()} disabled={emailCodeCountdown > 0 || sendingEmailCode || !isQqEmail(emailInput)} variant="outline" className="min-w-28 border-[var(--border)]">
                        {sendingEmailCode ? "发送中..." : emailCodeCountdown > 0 ? `${emailCodeCountdown}s` : "获取验证码"}
                      </Button>
                    </div>
                  </div>
                  {emailMsg && <p className={`text-sm ${emailMsg.includes("成功") ? "text-emerald-500" : "text-red-500"}`}>{emailMsg}</p>}
                  <Button onClick={() => void handleBindEmail()} disabled={!isQqEmail(emailInput) || emailCode.length !== 6} className="bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[var(--primary)]/85 disabled:opacity-40">验证并永久绑定QQ邮箱</Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 平台公告 */}
        {activeTab === "announcements" && (
          <Card className="overflow-hidden border-[var(--border)] bg-[var(--card)]" data-testid="profile-announcement-center">
            <CardHeader className="border-b border-[var(--border)] bg-[var(--sidebar)]/70">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg text-[var(--foreground)]"><BellRing className="h-5 w-5 text-[var(--primary)]" /> 公告中心</CardTitle>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">平台规则、服务动态与重要运营通知</p>
                </div>
                <Button variant="outline" onClick={() => router.push("/announcements")} className="border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]">进入完整公告中心 <ChevronRight className="ml-1 h-4 w-4" /></Button>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              {announcements.length === 0 ? (
                <div className="grid place-items-center rounded-2xl border border-dashed border-[var(--border)] py-16 text-sm text-[var(--muted-foreground)]">暂无公告</div>
              ) : (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]">
                  <button
                    type="button"
                    onClick={() => router.push(`/announcements?id=${encodeURIComponent(announcements[0].id)}`)}
                    className="group min-h-56 rounded-3xl border border-[var(--primary)]/20 bg-[var(--primary)]/6 p-6 text-left transition hover:border-[var(--primary)]/45 hover:shadow-lg"
                  >
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--primary)]">
                      <span className="rounded-full bg-[var(--primary)]/12 px-2.5 py-1">{announcements[0].is_pinned ? "置顶公告" : "最新公告"}</span>
                      <span>{formatTime(announcements[0].created_at)}</span>
                    </div>
                    <h3 className="mt-5 text-2xl font-bold leading-tight text-[var(--foreground)] group-hover:text-[var(--primary)]">{announcements[0].title}</h3>
                    <p className="mt-3 line-clamp-3 text-sm leading-7 text-[var(--text-secondary)]">{announcements[0].summary || announcements[0].content}</p>
                    <span className="mt-6 inline-flex items-center text-sm font-semibold text-[var(--primary)]">阅读完整公告 <ChevronRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-1" /></span>
                  </button>
                  <div className="space-y-2">
                    {announcements.slice(1, 6).map(a => (
                      <button key={a.id} type="button" onClick={() => router.push(`/announcements?id=${encodeURIComponent(a.id)}`)} className="group flex w-full items-start gap-3 rounded-2xl border border-transparent px-3 py-3 text-left transition hover:border-[var(--border)] hover:bg-[var(--background)]">
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-[var(--foreground)] group-hover:text-[var(--primary)]">{a.title}</span>
                            {a.is_pinned && <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">置顶</span>}
                          </span>
                          <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--muted-foreground)]">{a.summary || a.content}</span>
                          <span className="mt-1.5 block text-[11px] text-[var(--muted-foreground)]">{formatTime(a.created_at)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 通知中心 */}
        {activeTab === "notifications" && (
          <Card className="bg-[var(--sidebar)] border-[var(--border)]">
            <CardHeader>
              <CardTitle className="text-[var(--foreground)] text-base">通知中心</CardTitle>
            </CardHeader>
            <CardContent>
              {userNotifications.length === 0 ? (
                <p className="text-[var(--foreground)] text-center py-8">暂无通知</p>
              ) : (
                <div className="space-y-3">
                  {userNotifications.map(n => (
                    <div key={n.id} className={`bg-[var(--background)] rounded-lg p-4 border ${n.is_read ? "border-[var(--border)]" : "border-violet-500/30 ring-1 ring-violet-500/10"}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {!n.is_read && <span className="w-2 h-2 rounded-full bg-violet-500" />}
                        <span className="text-[var(--foreground)] font-medium text-sm">{n.title}</span>
                        <span className="text-[var(--text-secondary)] text-xs ml-auto">{formatTime(n.created_at)}</span>
                      </div>
                      {n.content && (
                        <p className="text-[var(--text-secondary)] text-sm leading-relaxed mb-2">{n.content}</p>
                      )}
                      {n.has_cami_code && (
                        <div className="mt-3 pt-3 border-t border-[var(--border)]">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-2">
                              <Gift className="w-4 h-4 text-violet-500" />
                              <span className="text-[var(--foreground)] text-xs">激活凭证：</span>
                              <code className="bg-violet-500/10 text-violet-500 px-2 py-0.5 rounded font-mono text-sm tracking-[0.22em]">••••••••</code>
                              <span className="text-[var(--text-secondary)] text-xs">已安全绑定，无需复制</span>
                            </div>
                            <Button
                              size="sm"
                              data-testid="notification-cami-redeem-link"
                              className="bg-violet-500 hover:bg-violet-600 text-white text-xs h-7 px-3"
                              onClick={() => handleRedeemCamiFromNotification(n.id)}
                            >
                              一键激活
                            </Button>
                          </div>
                        </div>
                      )}
                      {!n.is_read && !n.has_cami_code && (
                        <div className="mt-3 flex justify-end border-t border-[var(--border)] pt-3">
                          <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={() => void handleMarkUserNotificationRead(n.id)}>
                            标记已读
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 邀请码 */}
        {activeTab === "invitation" && (
          <div className="space-y-6">
            {/* 邀请福利推送 */}
            {inviteBenefits.length > 0 && (
              <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
                <div className="h-1 bg-gradient-to-r from-amber-500 to-orange-400" />
                <CardContent className="p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
                      <Gift className="w-5 h-5 text-amber-500" />
                    </div>
                    <span className="text-[var(--foreground)] text-base font-semibold">邀请福利</span>
                  </div>
                  <div className="space-y-3">
                    {inviteBenefits.map(b => (
                      <div key={b.id} className="bg-[var(--background)] rounded-lg p-4 border border-amber-500/10">
                        <p className="text-[var(--foreground)] text-sm leading-relaxed whitespace-pre-wrap">{b.content}</p>
                        <p className="text-[var(--text-secondary)] text-xs mt-2">{formatTime(b.created_at)}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 生成邀请码 */}
            <Card className="bg-[var(--card)] border-[var(--border)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-violet-500 to-purple-400" />
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center">
                      <Sparkles className="w-5 h-5 text-violet-500" />
                    </div>
                    <span className="text-[var(--foreground)] text-base font-semibold">我的邀请码</span>
                  </div>
                  <Button
                    onClick={handleGenerateCode}
                    disabled={!inviteOwnerEligible || generatingCode || inviteCodes.some((code) => !code.is_used) || inviteQuota.remainingThisMonth <= 0}
                    className="bg-violet-500 hover:bg-violet-600 text-white h-8 text-xs"
                  >
                    <UserPlus className="w-3.5 h-3.5 mr-1" />
                    {!inviteOwnerEligible ? "正式会员可生成" : generatingCode ? "生成中..." : inviteCodes.some((code) => !code.is_used) ? "已有可用码" : inviteQuota.remainingThisMonth <= 0 ? "本月额度已用完" : inviteCodes.length > 0 ? "生成下一枚" : "生成邀请码"}
                  </Button>
                </div>

                <div className="mb-4 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3 text-xs leading-5 text-[var(--text-secondary)]">
                  <strong className="text-violet-500">一人一码：</strong>每枚邀请码只允许一位好友成功注册；注册后立即失效。本月可生成 {inviteQuota.monthlyLimit} 枚，已生成 {inviteQuota.issuedThisMonth} 枚，剩余 {inviteQuota.remainingThisMonth} 枚。复制时会自动带上官网注册链接、邀请码和注册说明。邀请奖励由管理员确认后直接到账，通知只是回执，无需再次领取。
                </div>
                {!inviteOwnerEligible && <p className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-xs font-semibold text-amber-700">为防止反复注册领取体验包，只有有效期内的正式会员可以生成和分享新邀请码。</p>}

                {inviteCodes.length === 0 ? (
                  <div className="text-center py-8">
                    <QrCode className="w-12 h-12 text-[var(--text-secondary)] mx-auto mb-3 opacity-40" />
                    <p className="text-[var(--text-secondary)] text-sm">您还没有邀请码</p>
                    <p className="text-[var(--text-secondary)] text-xs mt-1">点击上方按钮生成一枚一次性邀请码</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {inviteCodes.map(ic => (
                      <div key={ic.id} data-testid="invitation-code-row" className={`rounded-lg p-4 flex items-center justify-between ${ic.is_used ? "bg-[var(--background)] opacity-60" : "bg-violet-500/5 border border-violet-500/20"}`}>
                        <div className="flex items-center gap-3">
                          <div className={`font-mono text-lg tracking-widest font-bold ${ic.is_used ? "text-[var(--text-secondary)]" : "text-violet-500"}`}>
                            {ic.code}
                          </div>
                          {ic.is_used ? (
                            <span className="text-xs bg-gray-500/20 text-gray-400 px-2 py-0.5 rounded">已使用</span>
                          ) : (
                            <span className="text-xs bg-green-500/20 text-green-500 px-2 py-0.5 rounded">可用</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-secondary)] text-xs">{formatTime(ic.created_at)}</span>
                          {!ic.is_used && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopyCode(ic.code)}
                              className="h-7 text-xs text-violet-500 hover:text-violet-400 hover:bg-violet-500/10"
                            >
                              {copiedCode === ic.code ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                              {copiedCode === ic.code ? "邀请说明已复制" : "复制邀请说明"}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 邀请统计 */}
            <div className="grid grid-cols-2 gap-4">
              <Card className="bg-[var(--card)] border-[var(--border)]">
                <CardContent className="p-5 text-center">
                  <p className="text-3xl font-bold text-violet-500">{inviteStats.totalInvited}</p>
                  <p className="text-[var(--text-secondary)] text-sm mt-1">累计邀请人数</p>
                </CardContent>
              </Card>
              <Card className="bg-[var(--card)] border-[var(--border)]">
                <CardContent className="p-5 text-center">
                  <p className="text-3xl font-bold text-green-500">{inviteStats.activatedCount}</p>
                  <p className="text-[var(--text-secondary)] text-sm mt-1">已激活会员</p>
                </CardContent>
              </Card>
            </div>

            {/* 邀请人列表 */}
            <Card className="bg-[var(--card)] border-[var(--border)]">
              <CardHeader className="pb-3">
                <CardTitle className="text-[var(--foreground)] text-base flex items-center gap-2">
                  <Users className="w-4 h-4 text-violet-500" />
                  我邀请的人
                </CardTitle>
              </CardHeader>
              <CardContent>
                {inviteRecords.length === 0 ? (
                  <div className="text-center py-8">
                    <Users className="w-12 h-12 text-[var(--text-secondary)] mx-auto mb-3 opacity-40" />
                    <p className="text-[var(--text-secondary)] text-sm">暂无邀请记录</p>
                    <p className="text-[var(--text-secondary)] text-xs mt-1">分享邀请码给好友，邀请他们加入吧</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {inviteRecords.map(r => (
                      <div key={r.id} className="bg-[var(--background)] rounded-lg p-3 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-violet-500/10 flex items-center justify-center">
                            <span className="text-violet-500 text-sm font-bold">{r.invitee.display_name?.[0] || "?"}</span>
                          </div>
                          <div>
                            <p className="text-[var(--foreground)] text-sm font-medium">{r.invitee.display_name}</p>
                            <p className="text-[var(--text-secondary)] text-xs">{r.invitee.phone || "未绑定手机"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="text-[var(--text-secondary)] text-xs">{formatTime(r.invited_at)}</p>
                            {r.invitee_activated ? (
                              <span className="text-xs text-green-500">已激活会员</span>
                            ) : (
                              <span className="text-xs text-amber-500">未激活</span>
                            )}
                          </div>
                          <div className={`w-2 h-2 rounded-full ${r.invitee_activated ? "bg-green-500" : "bg-amber-500"}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      <Dialog open={avatarPickerOpen} onOpenChange={setAvatarPickerOpen}>
        <DialogContent
          className="w-[min(760px,calc(100vw-96px))] max-w-none overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] p-0 shadow-2xl"
          style={{ width: "min(760px, calc(100vw - 96px))", maxWidth: "none" }}
          data-testid="profile-avatar-settings-dialog"
        >
          <div className="border-b border-[var(--border)] bg-[var(--background)]/55 px-6 py-5">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl font-bold text-[var(--foreground)]">
                <Camera className="h-5 w-5 text-[var(--primary)]" />
                设置个人头像
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-[var(--muted-foreground)]">
                选择平台卡通头像，或上传自己的照片。系统会自动校正方向并裁成清晰方形头像。
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="grid min-w-0 grid-cols-[176px_minmax(0,1fr)] gap-6 px-6 py-5">
            <aside className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/55 p-4 text-center">
              <p className="mb-3 text-xs font-semibold tracking-wide text-[var(--muted-foreground)]">当前头像</p>
              <div className="mx-auto h-32 w-32 overflow-hidden rounded-3xl border-2 border-[var(--border)] bg-[var(--card)] shadow-sm">
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="当前个人头像" className="block h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[var(--primary)] text-4xl font-bold text-[var(--primary-foreground)]">
                    {user.display_name?.[0] || user.username[0]}
                  </div>
                )}
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">所有页面会使用同一头像</p>
            </aside>

            <div className="min-w-0 space-y-5">
              <section aria-labelledby="preset-avatar-heading">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h3 id="preset-avatar-heading" className="text-sm font-bold text-[var(--foreground)]">平台卡通头像</h3>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">参考应用广场气质重新设计的原创动画人物</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-[var(--primary)]">8 款</span>
                </div>
                <div className="grid min-w-0 grid-cols-4 gap-3" data-testid="profile-avatar-preset-grid">
                  {USER_PROFILE_AVATAR_PRESETS.map(preset => {
                    const selected = user.avatarUrl === preset.src;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={avatarBusy}
                        aria-label={`选择${preset.label}`}
                        aria-pressed={selected}
                        onClick={() => void saveAvatarPreset(preset.src)}
                        className={`group relative min-w-0 overflow-hidden rounded-2xl border-2 bg-[var(--background)] p-1.5 text-left transition hover:-translate-y-0.5 hover:border-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:cursor-wait disabled:opacity-55 ${selected ? "border-[var(--primary)] shadow-[0_8px_24px_color-mix(in_srgb,var(--primary)_20%,transparent)]" : "border-[var(--border)]"}`}
                        data-testid="profile-avatar-preset"
                      >
                        <span className="relative block aspect-square overflow-hidden rounded-xl">
                          <img src={preset.src} alt="" className="block h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]" />
                          {selected && (
                            <span className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] shadow-md">
                              <Check className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </span>
                        <span className="mt-1.5 block truncate px-0.5 text-center text-[11px] font-semibold text-[var(--text-secondary)]">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-dashed border-[var(--primary)]/45 bg-[var(--primary)]/5 p-4" data-testid="profile-avatar-upload-panel">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[var(--foreground)]">上传自己的图片</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">PNG、JPEG、WebP，5MB 内；自动裁成 512×512 WebP，不拉伸。</p>
                  </div>
                  <Button
                    type="button"
                    disabled={avatarBusy}
                    onClick={() => avatarFileRef.current?.click()}
                    className="h-10 shrink-0 gap-2 bg-[var(--primary)] px-4 text-[var(--primary-foreground)] hover:bg-[var(--primary)]/90"
                    data-testid="profile-avatar-upload-button"
                  >
                    <Upload className="h-4 w-4" />
                    {avatarBusy ? "处理中…" : "选择图片"}
                  </Button>
                  <input
                    ref={avatarFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={event => void uploadAvatar(event.target.files?.[0])}
                    data-testid="profile-avatar-file-input"
                  />
                </div>
              </section>
            </div>
          </div>

          <DialogFooter className="min-h-16 items-center border-t border-[var(--border)] bg-[var(--background)]/45 px-6 py-4 sm:justify-between">
            <div className="min-w-0 text-left">
              {avatarMsg ? (
                <p
                  role={avatarStatus === "error" ? "alert" : "status"}
                  className={`text-sm font-medium ${avatarStatus === "success" ? "text-emerald-500" : avatarStatus === "error" ? "text-red-500" : "text-[var(--muted-foreground)]"}`}
                  data-testid="profile-avatar-status"
                >
                  {avatarMsg}
                </p>
              ) : (
                <p className="text-xs text-[var(--muted-foreground)]">选择后立即保存，可随时再次更换。</p>
              )}
            </div>
            <Button type="button" variant="outline" onClick={() => setAvatarPickerOpen(false)} disabled={avatarBusy} className="h-9 px-5">
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 扫码充值弹窗 */}
      <RechargeDialog
        open={rechargeOpen}
        onOpenChange={setRechargeOpen}
        credits={assets ? assets.credits.balance : (user?.credits ?? 0)}
        cashBalance={cashBalance}
        mode="both"
        onCreditsUpdated={(newCredits) => {
          // 同步到 AppContext 全局状态（侧边栏积分显示会实时更新）
          dispatch({ type: "SET_CREDITS", payload: { total: newCredits, used: 0, remaining: newCredits, costPerMessage: 0 } });
          refreshAssets();
        }}
        onCashUpdated={(newCash) => {
          setCashBalance(newCash);
          // 同步到 AppContext 全局状态
          dispatch({ type: "SET_CASH_BALANCE", payload: newCash });
          refreshAssets();
        }}
      />

    </div>
  );
}
