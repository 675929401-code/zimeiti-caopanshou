"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Download,
  Gift,
  Link2,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserPlus2,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import {
  MemberPackageAssignmentDialog,
  type MemberPackageAssignmentReceipt,
} from "@/components/admin/member-package-assignment-dialog";

type Person = {
  username?: string | null;
  display_name?: string | null;
  phone?: string | null;
  email?: string | null;
  member_status?: string | null;
  credits?: number | null;
  cash_balance?: number | null;
};

type RewardStage = "registration" | "invitee_welcome" | "activation";
type ReferralRewardStage = Exclude<RewardStage, "invitee_welcome">;
type RewardStatus = "pending" | "draft" | "sent" | "skipped";
type RewardFilter = "all" | "pending" | "inactive" | "active" | "completed";

type RewardGrant = {
  id: string;
  reward_stage: RewardStage;
  recipient_user_id: string;
  status: RewardStatus;
  eligibility_at: string | null;
  credits: number;
  cash_amount: number;
  note: string;
  drafted_at: string | null;
  sent_at: string | null;
  notification_id: string | null;
  package_assignment_id?: string | null;
};

type InvitationRecord = {
  record_id: string;
  inviter_id: string;
  invitee_id: string;
  invitation_code: string | null;
  invitation_code_id?: string | null;
  invitation_code_status?: "consumed" | "open" | "historical";
  invitation_code_used_at?: string | null;
  attribution_status?: "exact" | "legacy-derived";
  invitee_activated: boolean;
  invited_at: string;
  activated_at: string | null;
  activation_method?: string | null;
  activation_fee?: number | null;
  activation_note?: string | null;
  risk_status?: "clear" | "review" | "cleared" | "blocked";
  risk_reasons?: string[];
  automatic_trial_eligible?: boolean;
  risk_reviewed_at?: string | null;
  risk_review_note?: string | null;
  inviter: Person;
  invitee: Person;
  rewards: RewardGrant[];
  package_assignment?: MemberPackageAssignmentReceipt | null;
  workflow: {
    immediatePending: boolean;
    pendingActions: Array<"risk_review" | "invitee_package" | "registration_reward" | "activation_reward">;
    registrationStageCompleted: boolean;
    waitingForActivation: boolean;
    completed: boolean;
    state: "pending" | "waiting_activation" | "completed" | "blocked";
  };
};

type InvitationStats = {
  totalRecords: number;
  activatedCount: number;
  totalInviters: number;
  rewardPending?: number;
  pendingRecordCount?: number;
  pendingActionCount?: number;
  completedCount?: number;
  inactiveCount?: number;
  registrationPending?: number;
  welcomePending?: number;
  activationPending?: number;
  riskPending?: number;
};

type InvitationSecurityPolicy = {
  monthlyCodeLimit: number;
  riskWindowDays: number;
  inviterBurstThreshold: number;
  revision: number;
  updatedAt: string | null;
};

type ActiveTask = { recordId: string; stage: ReferralRewardStage };

const MAX_REWARD_AMOUNT = 100_000_000;
const RISK_REASON_LABELS: Record<string, string> = {
  SAME_IP_RECENT: "同一网络近期出现其他受邀注册",
  SAME_DEVICE_RECENT: "同一浏览器设备近期出现其他受邀注册",
  SAME_IP_AS_INVITER: "新人注册网络与邀请人当前登录网络一致",
  INVITER_BURST_24H: "同一邀请人 24 小时内注册较集中",
};
type RewardMessageTemplateId = "concise" | "thanks";

const REWARD_MESSAGE_TEMPLATE_OPTIONS: Array<{
  id: RewardMessageTemplateId;
  label: string;
  description: string;
}> = [
  { id: "concise", label: "简洁到账", description: "直接说明邀请结果、奖励金额和到账位置。" },
  { id: "thanks", label: "感谢邀请", description: "在到账信息之外，增加感谢与继续推荐的表达。" },
];

function rewardMessageTemplate(id: RewardMessageTemplateId, stage: ReferralRewardStage) {
  const event = stage === "registration" ? "完成注册" : "完成正式会员激活";
  if (id === "thanks") {
    return `感谢您成功邀请新会员${event}！本次奖励为 {{积分}} 积分和 ¥{{现金}} 现金，现已自动发放至您的账户。感谢您的推荐与支持。`;
  }
  return `您邀请的新会员已${event}，平台已向您的账户发放 {{积分}} 积分和 ¥{{现金}} 现金奖励。奖励已自动到账，无需领取，可前往个人中心查看。`;
}

function formatRewardCredits(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(Number.isFinite(value) ? value : 0);
}

function renderRewardMessage(template: string, credits: number, cashAmount: number) {
  return template
    .replaceAll("{{积分}}", formatRewardCredits(credits))
    .replaceAll("{{现金}}", (Number.isFinite(cashAmount) ? cashAmount : 0).toFixed(2));
}

function personName(person: Person) {
  return person.display_name || person.username || person.phone || person.email || "未知账号";
}

function formatBeijing(value?: string | null) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function activationMethodLabel(method?: string | null) {
  if (method === "admin_manual") return "人工确认付款";
  if (method === "cami") return "会员卡密兑换";
  if (method === "legacy") return "历史激活";
  return "尚未激活";
}

function rewardFor(record: InvitationRecord, stage: RewardStage) {
  return record.rewards?.find((reward) => reward.reward_stage === stage);
}

function RewardStatusBadge({
  reward,
  stage,
  packageAssignment,
}: {
  reward?: RewardGrant;
  stage: RewardStage;
  packageAssignment?: MemberPackageAssignmentReceipt | null;
}) {
  if (stage === "invitee_welcome" && packageAssignment) {
    return <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-600">套餐已开通</span>;
  }
  if (!reward) {
    return <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-bold text-rose-600">节点缺失</span>;
  }
  if (!reward.eligibility_at) {
    return <span className="rounded-full bg-slate-500/10 px-2.5 py-1 text-[11px] font-bold text-slate-500">{stage === "activation" ? "等待正式激活" : "尚未开放"}</span>;
  }
  const pendingLabel = stage === "registration" ? "待发注册奖励" : stage === "activation" ? "待发正式奖励" : "待选择套餐";
  const sentLabel = stage === "registration" ? "注册奖励已入账" : stage === "activation" ? "正式奖励已入账" : "套餐已开通";
  const labels: Record<RewardStatus, string> = {
    pending: pendingLabel,
    draft: "额度已保存，待派发",
    sent: sentLabel,
    skipped: "已处理（本次不发）",
  };
  const tones: Record<RewardStatus, string> = {
    pending: "bg-amber-500/10 text-amber-600",
    draft: "bg-blue-500/10 text-blue-600",
    sent: "bg-emerald-500/10 text-emerald-600",
    skipped: "bg-slate-500/10 text-slate-500",
  };
  return <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${tones[reward.status]}`}>{labels[reward.status]}</span>;
}

function RewardDecisionEditor({
  token,
  record,
  stage,
  reward,
  onChanged,
}: {
  token: string;
  record: InvitationRecord;
  stage: ReferralRewardStage;
  reward?: RewardGrant;
  onChanged: (message: string) => Promise<void>;
}) {
  const [credits, setCredits] = useState(String(Number(reward?.credits || 0)));
  const [cashAmount, setCashAmount] = useState(String(Number(reward?.cash_amount || 0)));
  const [selectedTemplateId, setSelectedTemplateId] = useState<RewardMessageTemplateId | null>(reward?.note ? null : "concise");
  const [messageTemplate, setMessageTemplate] = useState(reward?.note || rewardMessageTemplate("concise", stage));
  const [busy, setBusy] = useState<"skip" | "send" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setCredits(String(Number(reward?.credits || 0)));
    setCashAmount(String(Number(reward?.cash_amount || 0)));
    setSelectedTemplateId(reward?.note ? null : "concise");
    setMessageTemplate(reward?.note || rewardMessageTemplate("concise", stage));
    setError("");
  }, [reward?.id, reward?.credits, reward?.cash_amount, reward?.note, reward?.status, stage]);

  const eligible = Boolean(reward?.eligibility_at);
  const sent = reward?.status === "sent";
  const stageLabel = stage === "registration" ? "邀请人注册奖励" : "邀请人正式会员奖励";
  const numericCredits = Number(credits || 0);
  const numericCash = Number(cashAmount || 0);
  const validAmounts = Number.isFinite(numericCredits)
    && Number.isFinite(numericCash)
    && numericCredits >= 0
    && numericCash >= 0
    && numericCredits <= MAX_REWARD_AMOUNT
    && numericCash <= MAX_REWARD_AMOUNT;
  const hasAmount = numericCredits > 0 || numericCash > 0;
  const hasBothVariables = messageTemplate.includes("{{积分}}") && messageTemplate.includes("{{现金}}");
  const renderedMessage = renderRewardMessage(messageTemplate.trim(), numericCredits, numericCash);
  const validMessage = hasBothVariables && renderedMessage.length > 0 && renderedMessage.length <= 2000;
  const draftMatchesSaved = reward?.status === "draft"
    && numericCredits === Number(reward.credits || 0)
    && numericCash === Number(reward.cash_amount || 0)
    && renderedMessage === (reward.note || "");

  const skipReward = async () => {
    if (!reward || !eligible || sent || busy) return;
    if (!confirm(`确认本次暂不发放“${stageLabel}”？以后仍可重新填写并发放。`)) return;
    setBusy("skip");
    setError("");
    try {
      const response = await fetch("/api/admin/invitations/rewards", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          recordId: record.record_id,
          stage,
          decision: "skip",
          credits: 0,
          cashAmount: 0,
          note: "",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "奖励决策保存失败");
      await onChanged(`${stageLabel}已记录为“本次暂不发”`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "奖励决策保存失败");
    } finally {
      setBusy(null);
    }
  };

  const sendReward = async () => {
    if (!reward || !eligible || sent || busy) return;
    if (!validAmounts || !hasAmount) {
      setError("请填写大于 0 的积分或现金；本次不发请使用“本次不发”。");
      return;
    }
    if (!validMessage) {
      setError("通知文案必须保留 {{积分}} 和 {{现金}} 两个变量，且不能超过 2000 字。");
      return;
    }
    const amountCopy = [
      numericCredits > 0 ? `${numericCredits.toLocaleString()} 积分` : "",
      numericCash > 0 ? `¥${numericCash.toFixed(2)} 现金` : "",
    ].filter(Boolean).join("、");
    if (!confirm(`确认向邀请人“${personName(record.inviter)}”发放“${stageLabel}”：${amountCopy}？\n确认后将立即入账并推送站内通知，不能撤销或重复发放。`)) return;
    const idempotencyKey = `invitation-reward:${reward.id}:${crypto.randomUUID()}`;
    setBusy("send");
    setError("");
    try {
      if (!draftMatchesSaved) {
        const saveResponse = await fetch("/api/admin/invitations/rewards", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            recordId: record.record_id,
            stage,
            decision: "draft",
            credits: numericCredits,
            cashAmount: numericCash,
            note: renderedMessage,
          }),
        });
        const savePayload = await saveResponse.json().catch(() => ({}));
        if (!saveResponse.ok) throw new Error(savePayload.error || "奖励额度保存失败");
      }
      const response = await fetch("/api/admin/invitations/rewards", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ recordId: record.record_id, stage, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "奖励发放失败");
      const receipt = payload.reward || {};
      const receiptCopy = [
        Number(receipt.credits || 0) > 0 ? `${Number(receipt.credits).toLocaleString()} 积分` : "",
        Number(receipt.cash_amount || 0) > 0 ? `¥${Number(receipt.cash_amount).toFixed(2)} 现金` : "",
      ].filter(Boolean).join("、");
      await onChanged(`${stageLabel}已给 ${personName(record.inviter)} 入账并推送通知：${receiptCopy}`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "奖励发放失败");
    } finally {
      setBusy(null);
    }
  };

  if (!reward) {
    return <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/8 p-4 text-sm font-semibold text-rose-600">奖励节点没有初始化。本次不能发放，请先修复数据后重试。</div>;
  }

  if (!eligible) {
    return (
      <div data-testid="invitation-activation-opening-rules" className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--muted)]/20 p-4 text-sm text-[var(--muted-foreground)]">
        <p className="font-bold text-[var(--foreground)]">尚未开放派发</p>
        <p className="mt-1">受邀学员还不是正式会员。直接配置“正式会员 / 超级 VIP”会立即激活并把本节点转为“待决定”；体验包不算正式激活；发送激活卡后，要等学员兑换才会开放。</p>
        <p className="mt-2 text-xs">无论哪条路径，系统都只开放奖励节点，不会自动发放；积分和现金仍由管理员确认。</p>
      </div>
    );
  }

  if (sent) {
    return (
      <div data-testid="invitation-reward-receipt" className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 p-4 text-sm">
        <div className="flex items-center gap-2 font-bold text-emerald-700"><BadgeCheck className="h-4 w-4" />派发回执</div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-[var(--muted-foreground)]">已入账</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{Number(reward.credits || 0).toLocaleString()} 积分 · ¥{Number(reward.cash_amount || 0).toFixed(2)}</dd></div>
          <div><dt className="text-[var(--muted-foreground)]">完成时间</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{formatBeijing(reward.sent_at)}</dd></div>
          <div><dt className="text-[var(--muted-foreground)]">礼包流水</dt><dd className="mt-1 break-all font-mono text-[11px] text-[var(--foreground)]">{reward.id}</dd></div>
          <div><dt className="text-[var(--muted-foreground)]">用户通知</dt><dd className="mt-1 break-all font-mono text-[11px] text-[var(--foreground)]">{reward.notification_id || "已入账，通知编号待回读"}</dd></div>
        </dl>
        {reward.note && <p className="mt-3 border-t border-emerald-500/15 pt-3 text-xs text-[var(--secondary-foreground)]">通知文案：{reward.note}</p>}
      </div>
    );
  }

  return (
      <div data-testid={`invitation-reward-editor-${stage}`}>
      <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-[var(--secondary-foreground)]">
        <strong className="text-blue-700">只需填数后确认：</strong> 系统会自动保存额度、写入邀请人余额、生成审计流水并推送通知，不需要再点第二次。
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="text-xs font-semibold text-[var(--muted-foreground)]">积分
          <input data-testid="invitation-reward-credits" type="number" min={0} max={MAX_REWARD_AMOUNT} step="0.01" value={credits} onChange={(event) => setCredits(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
        </label>
        <label className="text-xs font-semibold text-[var(--muted-foreground)]">现金（元）
          <input data-testid="invitation-reward-cash" type="number" min={0} max={MAX_REWARD_AMOUNT} step="0.01" value={cashAmount} onChange={(event) => setCashAmount(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
        </label>
      </div>
      <div data-testid="invitation-reward-variable-map" className="mt-3 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded-lg border border-sky-500/20 bg-sky-500/6 px-2.5 py-1.5 text-sky-700"><strong>{"{{积分}}"}</strong> 发送时替换为 <strong>{formatRewardCredits(numericCredits)} 积分</strong></span>
        <span className="rounded-lg border border-emerald-500/20 bg-emerald-500/6 px-2.5 py-1.5 text-emerald-700"><strong>{"{{现金}}"}</strong> 发送时替换为 <strong>¥{numericCash.toFixed(2)} 现金</strong></span>
      </div>
      <div className="mt-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><p className="text-xs font-semibold text-[var(--foreground)]">选择通知模板</p><p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">只有积分和现金是变量；选择后仍可编辑文字。</p></div>
          <span className="text-[10px] text-[var(--muted-foreground)]">双花括号是变量标记，不会原样发给会员</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {REWARD_MESSAGE_TEMPLATE_OPTIONS.map((template) => {
            const selected = selectedTemplateId === template.id;
            return (
              <button
                key={template.id}
                data-testid={`invitation-reward-template-${template.id}`}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  setSelectedTemplateId(template.id);
                  setMessageTemplate(rewardMessageTemplate(template.id, stage));
                  setError("");
                }}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${selected ? "border-[var(--primary)] bg-[var(--primary)]/8" : "border-[var(--border)] bg-[var(--background)]/45 hover:border-[var(--primary)]/40"}`}
              >
                <span className="block text-xs font-bold text-[var(--foreground)]">{template.label}</span>
                <span className="mt-1 block text-[10px] leading-4 text-[var(--muted-foreground)]">{template.description}</span>
              </button>
            );
          })}
        </div>
      </div>
      <label className="mt-3 block text-xs font-semibold text-[var(--muted-foreground)]">通知模板原文（变量会在发送前替换，可手动编辑）
        <textarea
          data-testid="invitation-reward-message-template"
          value={messageTemplate}
          maxLength={2000}
          onChange={(event) => { setMessageTemplate(event.target.value); setSelectedTemplateId(null); }}
          rows={4}
          className="mt-1.5 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
        />
      </label>
      <div data-testid="invitation-reward-message-preview" className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/6 p-3">
        <p className="text-[11px] font-bold text-emerald-700">实际发送内容（变量已替换为本次数字）</p>
        <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-[var(--secondary-foreground)]">{renderedMessage || "请填写通知文案"}</p>
      </div>
      {!validAmounts && <p role="alert" className="mt-2 text-xs font-semibold text-rose-600">金额必须在 0 至 1 亿元之间。</p>}
      {!hasBothVariables && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">请保留 {"{{积分}}"} 和 {"{{现金}}"}，系统才能保证预览与实际到账金额一致。</p>}
      {renderedMessage.length > 2000 && <p role="alert" className="mt-2 text-xs font-semibold text-rose-600">实际通知不能超过 2000 字。</p>}
      {reward.status === "draft" && <p className="mt-2 text-xs font-semibold text-blue-600">上次填写的额度已保存；可以直接确认发放，也可以修改后按新数字发放。</p>}
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-rose-600">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={() => void skipReward()} className="rounded-xl border border-[var(--border)] px-3.5 py-2 text-xs font-bold text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/35 disabled:opacity-40">{busy === "skip" ? "保存中…" : "本次不发"}</button>
        <button data-testid="invitation-reward-send" type="button" disabled={Boolean(busy) || !validAmounts || !hasAmount || !validMessage} onClick={() => void sendReward()} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-4 py-2 text-xs font-bold text-[var(--primary-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-35"><Send className="h-3.5 w-3.5" />{busy === "send" ? "入账并推送中…" : `确认发给 ${personName(record.inviter)}`}</button>
      </div>
    </div>
  );
}

export function InvitationAttributionPanel({
  token,
  focusUserId = "",
  focusUserLabel = "",
  onClearFocus,
  canManagePackages = false,
  canExportBilling = false,
}: {
  token: string;
  focusUserId?: string;
  focusUserLabel?: string;
  onClearFocus?: () => void;
  canManagePackages?: boolean;
  canExportBilling?: boolean;
}) {
  const [records, setRecords] = useState<InvitationRecord[]>([]);
  const [stats, setStats] = useState<InvitationStats>({ totalRecords: 0, activatedCount: 0, totalInviters: 0, rewardPending: 0 });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RewardFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null);
  const [packageRecordId, setPackageRecordId] = useState<string | null>(null);
  const [registrationPackageAutoEnabled, setRegistrationPackageAutoEnabled] = useState<boolean | null>(null);
  const [securityPolicy, setSecurityPolicy] = useState<InvitationSecurityPolicy>({
    monthlyCodeLimit: 6,
    riskWindowDays: 30,
    inviterBurstThreshold: 3,
    revision: 1,
    updatedAt: null,
  });
  const [policyBusy, setPolicyBusy] = useState(false);
  const [riskBusyId, setRiskBusyId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [hoveredRecordId, setHoveredRecordId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [response, automationResponse] = await Promise.all([
        fetch("/api/admin/invitations", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }),
        canManagePackages
          ? fetch("/api/admin/member-packages/automation", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
          : Promise.resolve(null),
      ]);
      const [payload, automationPayload] = await Promise.all([
        response.json().catch(() => ({})),
        automationResponse?.json().catch(() => ({})) ?? Promise.resolve({}),
      ]);
      if (!response.ok) throw new Error(payload.error || "邀请归属读取失败");
      setRecords(Array.isArray(payload.records) ? payload.records : []);
      setStats(payload.stats || { totalRecords: 0, activatedCount: 0, totalInviters: 0, rewardPending: 0 });
      if (payload.policy) setSecurityPolicy(payload.policy);
      setRegistrationPackageAutoEnabled(
        automationResponse?.ok ? automationPayload.automation?.enabled === true : null,
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "邀请归属读取失败");
    } finally {
      setLoading(false);
    }
  }, [canManagePackages, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!canManagePackages) setPackageRecordId(null);
  }, [canManagePackages]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let result = focusUserId
      ? records.filter((record) => record.inviter_id === focusUserId || record.invitee_id === focusUserId)
      : records;
    if (needle) {
      result = result.filter((record) => [
        record.invitation_code,
        record.inviter_id,
        record.invitee_id,
        record.inviter.display_name,
        record.inviter.username,
        record.inviter.phone,
        record.inviter.email,
        record.invitee.display_name,
        record.invitee.username,
        record.invitee.phone,
        record.invitee.email,
      ].some((value) => String(value || "").toLowerCase().includes(needle)));
    }
    if (filter === "pending") {
      result = result.filter((record) => record.workflow.immediatePending);
    } else if (filter === "inactive") {
      result = result.filter((record) => !record.invitee_activated);
    } else if (filter === "active") {
      result = result.filter((record) => record.invitee_activated);
    } else if (filter === "completed") {
      result = result.filter((record) => record.workflow.completed);
    }
    return result;
  }, [filter, focusUserId, query, records]);

  useEffect(() => {
    if (filtered.length === 0) {
      setExpandedRecordId(null);
      return;
    }
    setExpandedRecordId((current) => (
      current && filtered.some((record) => record.record_id === current)
        ? current
        : filtered[0].record_id
    ));
  }, [filtered]);

  const activeRecord = activeTask ? records.find((record) => record.record_id === activeTask.recordId) : undefined;
  const activeReward = activeTask && activeRecord ? rewardFor(activeRecord, activeTask.stage) : undefined;
  const packageRecord = packageRecordId ? records.find((record) => record.record_id === packageRecordId) : undefined;

  const handleChanged = async (message: string) => {
    setActiveTask(null);
    setPackageRecordId(null);
    await load();
    setNotice(message);
    window.setTimeout(() => setNotice(""), 6000);
  };

  const downloadLedger = async () => {
    if (!token || exporting || !canExportBilling) return;
    setExporting(true);
    setError("");
    try {
      const response = await fetch("/api/admin/invitations?format=csv", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "邀请关系账单下载失败");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `邀请关系账单-${new Date().toLocaleDateString("sv-SE")}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setNotice("邀请关系账单已下载：包含注册人数、正式会员数、套餐、奖励、风险与当前待办明细");
      window.setTimeout(() => setNotice(""), 6000);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "邀请关系账单下载失败");
    } finally {
      setExporting(false);
    }
  };

  const saveMonthlyLimit = async () => {
    if (policyBusy) return;
    setPolicyBusy(true);
    setError("");
    try {
      const idempotencyKey = `invitation-policy:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/invitations", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ monthlyCodeLimit: securityPolicy.monthlyCodeLimit, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "月度额度保存失败");
      if (payload.policy) setSecurityPolicy(payload.policy);
      setNotice(`已保存：每位会员每月最多生成 ${securityPolicy.monthlyCodeLimit} 枚一次性邀请码`);
      window.setTimeout(() => setNotice(""), 6000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "月度额度保存失败");
    } finally {
      setPolicyBusy(false);
    }
  };

  const reviewRisk = async (record: InvitationRecord, decision: "cleared" | "blocked") => {
    if (riskBusyId) return;
    const action = decision === "cleared" ? "确认属于真实新人注册" : "确认为异常注册";
    if (!confirm(`${action}？\n\n通过后可人工派发体验包；标记异常后将禁止派发体验包。IP 仅作为风险信号，本操作才是最终判定。`)) return;
    const note = window.prompt("复核备注（可选，例如：已电话核实／公司共用网络）", "") || "";
    const idempotencyKey = `invitation-risk:${record.record_id}:${crypto.randomUUID()}`;
    setRiskBusyId(record.record_id);
    setError("");
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ recordId: record.record_id, decision, note, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "风险复核保存失败");
      await handleChanged(decision === "cleared" ? "风险复核已通过；该新人可由管理员人工派发体验包" : "已确认为异常注册；体验包派发已禁止");
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "风险复核保存失败");
    } finally {
      setRiskBusyId(null);
    }
  };

  const cards = [
    { label: "累计邀请注册", value: stats.totalRecords, icon: UserPlus2, tone: "text-sky-600 bg-sky-500/10" },
    { label: "产生邀请的会员", value: stats.totalInviters, icon: Users, tone: "text-violet-600 bg-violet-500/10" },
    { label: "受邀人已正式激活", value: stats.activatedCount, icon: CheckCircle2, tone: "text-emerald-600 bg-emerald-500/10" },
    { label: "当前待处理关系", value: stats.pendingRecordCount ?? stats.rewardPending ?? 0, icon: WalletCards, tone: "text-amber-600 bg-amber-500/10" },
  ];

  const workflow = [
    { title: "新人用一次性码注册", detail: "一枚码只供一人，系统自动锁定邀请人和新人。", icon: Link2 },
    ...(canManagePackages ? [{
      title: "给新人配置会员套餐",
      detail: registrationPackageAutoEnabled === true
        ? "注册体验包已开启即发；正式会员与 VIP 仍由你确认。"
        : registrationPackageAutoEnabled === false
          ? "新人进入待处理后，由你选择套餐、权限和赠送额度。"
          : "开关状态暂不可用；系统不会冒充已开启，请到权益与礼包检查。",
      icon: UserPlus2,
    }] : []),
    { title: "给邀请人发奖励", detail: "注册奖励可立即发；正式/VIP 套餐开通或激活卡兑换后，正式会员奖励转为待决定。", icon: ClipboardCheck },
    { title: "系统自动到账并通知", detail: "用户无需领取；登录弹窗、右下角提醒和个人中心都能查看。", icon: BellRing },
  ];

  const filters: Array<{ key: RewardFilter; label: string }> = [
    { key: "all", label: "全部关系" },
    { key: "pending", label: "待处理" },
    { key: "inactive", label: "注册未激活" },
    { key: "active", label: "已正式激活" },
    { key: "completed", label: "已闭环" },
  ];

  return (
    <section data-testid="admin-invitation-attribution" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-[var(--foreground)]">邀请关系与奖励派发</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            {canManagePackages
              ? "核对新人套餐与邀请归因，分别处理注册奖励和正式会员奖励。"
              : "核对邀请归因、注册风险与邀请人奖励；套餐配置由对应岗位单独处理。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canExportBilling && <button data-testid="download-invitation-ledger" type="button" onClick={() => void downloadLedger()} disabled={exporting} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 text-sm font-semibold text-[var(--foreground)] hover:border-[var(--primary)]/45 disabled:opacity-60"><Download className="h-4 w-4" />{exporting ? "生成账单中…" : "下载全部关系账单"}</button>}
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 text-sm font-semibold text-[var(--foreground)] hover:border-[var(--primary)]/45 disabled:opacity-60"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新真实数据</button>
        </div>
      </div>

      <div data-testid="invitation-workflow" className="rounded-2xl border border-[var(--primary)]/25 bg-[var(--card)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-[var(--primary)]" /><h2 className="font-bold text-[var(--foreground)]">一条邀请如何闭环</h2></div>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">邀请关系与奖励分别留痕，收件人、阶段和到账记录不会串账或重复发放。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManagePackages && <a data-testid="open-benefit-packages" href="/admin?tab=benefit-packages" className={`rounded-full px-3 py-1.5 text-xs font-bold ${registrationPackageAutoEnabled === true ? "bg-emerald-500/10 text-emerald-700" : registrationPackageAutoEnabled === false ? "bg-amber-500/10 text-amber-700" : "bg-slate-500/10 text-slate-600"}`}>新人体验包：{registrationPackageAutoEnabled === true ? "注册即发" : registrationPackageAutoEnabled === false ? "待你选择礼包" : "状态待检查"}</a>}
            {(stats.riskPending || 0) > 0 && <span className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-700">待风险复核 {stats.riskPending}</span>}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-3">
          {workflow.map(({ title, detail, icon: Icon }, index) => (
            <div key={title} className="relative rounded-xl border border-[var(--border)] bg-[var(--background)]/55 p-3.5">
              <div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--primary)]/10 text-xs font-black text-[var(--primary)]">{index + 1}</span><Icon className="h-4 w-4 text-[var(--primary)]" /></div>
              <p className="mt-2 text-sm font-bold text-[var(--foreground)]">{title}</p>
              <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{detail}</p>
              {index < workflow.length - 1 && <ChevronRight className="absolute -right-2.5 top-1/2 z-10 h-5 w-5 -translate-y-1/2 rounded-full bg-[var(--card)] text-[var(--muted-foreground)]" />}
            </div>
          ))}
        </div>
        <div data-testid="invitation-security-policy" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-[var(--foreground)]">防滥用规则</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">每枚码只能成功注册一次；同 IP、同设备或短时集中注册只进入人工复核，不会仅凭 IP 自动封号。</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold text-[var(--muted-foreground)]">每人每月
              <select data-testid="invitation-monthly-limit" value={securityPolicy.monthlyCodeLimit} onChange={(event) => setSecurityPolicy((current) => ({ ...current, monthlyCodeLimit: Number(event.target.value) }))} className="ml-2 h-9 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm font-bold text-[var(--foreground)]">
                {[4, 5, 6].map((value) => <option key={value} value={value}>{value} 枚</option>)}
              </select>
            </label>
            <button data-testid="save-invitation-monthly-limit" type="button" disabled={policyBusy} onClick={() => void saveMonthlyLimit()} className="h-9 rounded-lg bg-sky-600 px-3 text-xs font-bold text-white disabled:opacity-50">{policyBusy ? "保存中…" : "保存限额"}</button>
          </div>
        </div>
      </div>

      {focusUserId && (
        <div className="flex items-center justify-between rounded-xl border border-blue-500/20 bg-blue-500/8 px-4 py-3 text-sm text-blue-700">
          <span>当前只看：<strong>{focusUserLabel || focusUserId}</strong> 作为邀请人或受邀人的关系与奖励</span>
          <button type="button" onClick={onClearFocus} className="font-semibold hover:underline">查看全部关系</button>
        </div>
      )}

      {notice && <div role="status" data-testid="invitation-reward-success" className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-4 py-3 text-sm font-semibold text-emerald-700"><CheckCircle2 className="h-4 w-4" />{notice}</div>}

      <div className="grid grid-cols-4 gap-4">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">
            <div className={`grid h-9 w-9 place-items-center rounded-xl ${tone}`}><Icon className="h-4 w-4" /></div>
            <p className="mt-4 text-2xl font-black text-[var(--foreground)]">{Number(value || 0).toLocaleString()}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--muted-foreground)]">{label}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
        <div className="border-b border-[var(--border)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="relative block w-full max-w-md"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" /><input data-testid="invitation-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索邀请码、邀请人或受邀学员" className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] pl-10 pr-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" /></label>
            <span className="text-xs text-[var(--muted-foreground)]">当前显示 {filtered.length} 条</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {filters.map((item) => (
              <button key={item.key} type="button" onClick={() => setFilter(item.key)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${filter === item.key ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/35"}`}>{item.label}</button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--muted-foreground)]">“待处理”只保留此刻需要你操作的关系：注册阶段完成后自动移出；新人正式激活时自动回到待处理；正式奖励处理后进入“已闭环”。历史关系不会删除，可在“全部关系”{canExportBilling ? "和下载账单" : ""}中追溯。</p>
        </div>

        {error ? (
          <div role="alert" className="m-4 rounded-xl border border-rose-500/25 bg-rose-500/8 p-4 text-sm font-semibold text-rose-600">{error}</div>
        ) : loading && records.length === 0 ? (
          <div className="p-12 text-center text-sm text-[var(--muted-foreground)]">正在读取真实邀请关系…</div>
        ) : filtered.length === 0 && records.length === 0 ? (
          <div data-testid="invitation-empty-state" className="px-6 py-10 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-amber-500/10 text-amber-600"><Gift className="h-6 w-6" /></div>
            <h3 className="mt-4 text-base font-bold text-[var(--foreground)]">当前没有可处理的邀请关系</h3>
            <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">{canManagePackages ? "真实邀请注册成功后，这里会出现新人套餐与邀请人奖励；新人正式激活后，再开放邀请人的正式会员奖励。" : "真实邀请注册成功后，这里会出现邀请关系、风险状态与邀请人奖励；新人正式激活后，再开放正式会员邀请奖励。"}</p>
            <div className={`mx-auto mt-5 grid max-w-3xl gap-3 text-left text-xs ${canManagePackages ? "grid-cols-3" : "grid-cols-2"}`}>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--background)]/60 p-3"><strong className="text-[var(--foreground)]">从哪里发码</strong><p className="mt-1 leading-5 text-[var(--muted-foreground)]">会员个人中心 → 邀请码 → 生成并分享。</p></div>
              {canManagePackages && <div data-testid="invitation-package-empty-guide" className="rounded-xl border border-[var(--border)] bg-[var(--background)]/60 p-3"><strong className="text-[var(--foreground)]">新人得到什么</strong><p className="mt-1 leading-5 text-[var(--muted-foreground)]">管理员选择套餐，权限、会员状态和赠送额度一次生效。</p></div>}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--background)]/60 p-3"><strong className="text-[var(--foreground)]">邀请人得到什么</strong><p className="mt-1 leading-5 text-[var(--muted-foreground)]">注册奖励和正式会员奖励分开决定、分开到账。</p></div>
            </div>
            <div className="mt-5 flex justify-center gap-2">
              <button type="button" onClick={() => window.location.assign("/admin?tab=users")} className="rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-bold text-[var(--primary-foreground)]">去学员管理</button>
              <button type="button" onClick={() => window.open("/register", "_blank", "noopener,noreferrer")} className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-bold text-[var(--foreground)]">查看受邀注册入口</button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-sm text-[var(--muted-foreground)]">没有符合当前搜索或筛选条件的邀请关系。</div>
        ) : (
          <div className="space-y-3 bg-[var(--muted)]/10 p-3" data-testid="invitation-person-rows">
            <div className="flex items-center justify-between px-2 pb-1 text-[11px] text-[var(--muted-foreground)]">
              <span>每一行代表一位受邀学员及其完整奖励链</span>
              <span>点击整行展开或收起</span>
            </div>
            {filtered.map((record) => {
              const registrationReward = rewardFor(record, "registration");
              const welcomeReward = rewardFor(record, "invitee_welcome");
              const activationReward = rewardFor(record, "activation");
              const isExpanded = expandedRecordId === record.record_id;
              const isHovered = hoveredRecordId === record.record_id;
              const pendingLabels = {
                risk_review: "风险复核",
                invitee_package: "给新人选套餐",
                registration_reward: "发邀请注册奖励",
                activation_reward: "发正式会员邀请奖励",
              } as const;
              const visiblePendingActions = record.workflow.pendingActions.filter(
                (action) => canManagePackages || action !== "invitee_package",
              );
              return (
                <article
                  key={record.record_id}
                  data-testid="invitation-attribution-row"
                  data-expanded={isExpanded ? "true" : "false"}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  onMouseEnter={() => setHoveredRecordId(record.record_id)}
                  onMouseLeave={() => setHoveredRecordId((current) => current === record.record_id ? null : current)}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button,a,input,select,textarea")) return;
                    setExpandedRecordId(isExpanded ? null : record.record_id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setExpandedRecordId(isExpanded ? null : record.record_id);
                  }}
                  className={`cursor-pointer rounded-2xl border bg-[var(--card)] p-5 shadow-sm outline-none transition-all focus-visible:ring-2 focus-visible:ring-[var(--primary)]/35 ${isExpanded ? "border-[var(--primary)]/45 shadow-md ring-1 ring-[var(--primary)]/10" : "border-[var(--border)] hover:border-[var(--primary)]/35"}`}
                  style={isHovered && !isExpanded ? { transform: "translateY(-2px)", boxShadow: "0 14px 28px rgba(15, 23, 42, 0.12)" } : undefined}
                >
                  <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-8">
                      <div className="flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)]/10 px-2.5 py-1 font-mono text-xs font-bold text-[var(--primary)]"><Link2 className="h-3.5 w-3.5" />{record.invitation_code || "历史未留存"}</span><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-700">一次性码 · 已消费</span><span className="text-[10px] text-[var(--muted-foreground)]">{record.attribution_status === "exact" ? "注册时精确归因" : "历史关系推导"}</span></div>
                      <div className="mt-3 flex items-center gap-5 text-sm"><div><p className="text-[10px] text-[var(--muted-foreground)]">老会员 · 邀请奖励收件人</p><p className="mt-0.5 font-bold text-[var(--foreground)]">{personName(record.inviter)}</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{record.inviter.phone || record.inviter.email || record.inviter_id}</p></div><ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" /><div><p className="text-[10px] text-[var(--muted-foreground)]">新人 · 会员套餐收件人</p><p className="mt-0.5 font-bold text-[var(--foreground)]">{personName(record.invitee)}</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{record.invitee.phone || record.invitee.email || record.invitee_id}</p></div></div>
                      <p className="mt-3 text-[11px] text-[var(--muted-foreground)]">注册时间：{formatBeijing(record.invited_at)}</p>
                      {record.risk_status && record.risk_status !== "clear" && (
                        <div data-testid="invitation-risk-review" className={`mt-3 rounded-xl border p-3 text-xs ${record.risk_status === "blocked" ? "border-rose-500/25 bg-rose-500/6" : record.risk_status === "cleared" ? "border-emerald-500/25 bg-emerald-500/6" : "border-amber-500/25 bg-amber-500/6"}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-bold text-[var(--foreground)]">{record.risk_status === "review" ? "需人工复核：自动体验包已暂缓" : record.risk_status === "cleared" ? "已人工核验为真实注册" : "已确认为异常注册"}</p>
                            {record.risk_status === "review" && (
                              <div className="flex gap-2">
                                <button type="button" disabled={riskBusyId === record.record_id} onClick={() => void reviewRisk(record, "cleared")} className="rounded-lg bg-emerald-600 px-2.5 py-1.5 font-bold text-white disabled:opacity-50">核验通过</button>
                                <button type="button" disabled={riskBusyId === record.record_id} onClick={() => void reviewRisk(record, "blocked")} className="rounded-lg border border-rose-500/30 px-2.5 py-1.5 font-bold text-rose-600 disabled:opacity-50">确认异常</button>
                              </div>
                            )}
                          </div>
                          {(record.risk_reasons || []).length > 0 && <p className="mt-1.5 leading-5 text-[var(--muted-foreground)]">风险信号：{(record.risk_reasons || []).map((reason) => RISK_REASON_LABELS[reason] || reason).join("；")}</p>}
                          {record.risk_review_note && <p className="mt-1 text-[var(--muted-foreground)]">复核备注：{record.risk_review_note}</p>}
                        </div>
                      )}
                    </div>
                    <div className="relative col-span-4 border-l border-[var(--border)] pl-5 pr-9">
                      <p className="text-[10px] font-semibold text-[var(--muted-foreground)]">新人当前状态</p>
                      <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${record.invitee_activated ? "bg-emerald-500/10 text-emerald-600" : record.package_assignment?.membership_status === "trial" ? "bg-blue-500/10 text-blue-600" : "bg-slate-500/10 text-slate-500"}`}>{record.invitee_activated ? "正式会员" : record.package_assignment?.membership_status === "trial" ? "试用会员" : "注册未开套餐"}</span>
                      <p className="mt-2 text-xs font-semibold text-[var(--foreground)]">{record.package_assignment?.package_name || activationMethodLabel(record.activation_method)}</p>
                      <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{record.invitee_activated ? formatBeijing(record.activated_at) : record.package_assignment ? `有效期：${formatBeijing(record.package_assignment.member_expires_at)}` : canManagePackages ? "请在下方给新人选择套餐" : "新人权益状态等待更新"}</p>
                      {record.activation_fee != null && <p className="mt-1 text-xs font-bold text-emerald-700">实收 ¥{Number(record.activation_fee).toFixed(2)}</p>}
                      <span className="absolute right-0 top-1 grid h-8 w-8 place-items-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--muted-foreground)]" aria-hidden="true">
                        <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                      </span>
                      <p className="mt-2 text-[10px] font-semibold text-[var(--primary)]">{isExpanded ? "点击收起此学员" : "点击查看此学员完整链路"}</p>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-4 border-t border-dashed border-[var(--border)] pt-4" data-testid="invitation-row-details">
                  <div data-testid="invitation-workflow-state" className={`mt-4 rounded-xl border px-3.5 py-2.5 text-xs ${record.workflow.completed ? "border-emerald-500/20 bg-emerald-500/6 text-emerald-700" : record.workflow.waitingForActivation ? "border-blue-500/20 bg-blue-500/6 text-blue-700" : record.workflow.state === "blocked" ? "border-rose-500/20 bg-rose-500/6 text-rose-700" : "border-amber-500/20 bg-amber-500/6 text-amber-700"}`}>
                    <strong>{record.workflow.completed ? "已闭环：" : record.workflow.waitingForActivation ? "注册阶段已完成：" : record.workflow.state === "blocked" ? "风险已拦截：" : "当前待处理："}</strong>
                    {record.workflow.completed
                      ? "套餐、注册奖励和正式会员奖励均已处理，本关系已自动移出待处理。"
                      : record.workflow.waitingForActivation
                        ? "当前无需操作；新人正式激活后会自动回到待处理，提醒你决定正式会员邀请奖励。"
                        : record.workflow.state === "blocked"
                          ? `不派发奖励；记录保留在全部关系${canExportBilling ? "和账单" : ""}中供审计。`
                          : visiblePendingActions.length > 0
                            ? visiblePendingActions.map((action) => pendingLabels[action]).join("、")
                            : "当前岗位暂无可执行操作；关系记录继续保留。"}
                  </div>

                  <div className={`mt-5 grid gap-3 ${canManagePackages ? "grid-cols-3" : "grid-cols-2"}`}>
                    {canManagePackages && <div data-testid="invitation-package-workflow-card" className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4">
                      <div className="flex items-center justify-between gap-2"><p className="text-sm font-black text-[var(--foreground)]">① 新人会员套餐</p><RewardStatusBadge reward={welcomeReward} stage="invitee_welcome" packageAssignment={record.package_assignment} /></div>
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">收件人：<strong className="text-[var(--foreground)]">{personName(record.invitee)}</strong></p>
                      <p className="mt-1 min-h-5 text-xs font-semibold text-[var(--foreground)]">{record.package_assignment ? `${record.package_assignment.package_name} · ${Number(record.package_assignment.credits || 0).toLocaleString()} 积分` : "选择试用／正式／超级 VIP，或手动配置"}</p>
                      <button data-testid="open-member-package" type="button" onClick={() => setPackageRecordId(record.record_id)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700"><Gift className="h-3.5 w-3.5" />{record.package_assignment ? "查看新人套餐回执" : "给新人选套餐"}</button>
                    </div>}
                    <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
                      <div className="flex items-center justify-between gap-2"><p className="text-sm font-black text-[var(--foreground)]">{canManagePackages ? "②" : "①"} 邀请注册奖励</p><RewardStatusBadge reward={registrationReward} stage="registration" /></div>
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">收件人：<strong className="text-[var(--foreground)]">{personName(record.inviter)}</strong></p>
                      <p className="mt-1 min-h-5 text-xs font-semibold text-[var(--foreground)]">{registrationReward && (registrationReward.status === "draft" || registrationReward.status === "sent") ? `${Number(registrationReward.credits || 0).toLocaleString()} 积分 · ¥${Number(registrationReward.cash_amount || 0).toFixed(2)}` : "新人注册成功后即可人工发放"}</p>
                      <button type="button" onClick={() => setActiveTask({ recordId: record.record_id, stage: "registration" })} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-sky-500/35 px-3 py-2 text-xs font-bold text-sky-700 hover:bg-sky-500/8"><CircleDollarSign className="h-3.5 w-3.5" />{registrationReward?.status === "sent" ? "查看注册奖励回执" : "发给邀请人"}</button>
                    </div>
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                      <div className="flex items-center justify-between gap-2"><p className="text-sm font-black text-[var(--foreground)]">{canManagePackages ? "③" : "②"} 正式会员邀请奖励</p><RewardStatusBadge reward={activationReward} stage="activation" /></div>
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">收件人：<strong className="text-[var(--foreground)]">{personName(record.inviter)}</strong></p>
                      <p className="mt-1 min-h-5 text-xs font-semibold text-[var(--foreground)]">{activationReward && (activationReward.status === "draft" || activationReward.status === "sent") ? `${Number(activationReward.credits || 0).toLocaleString()} 积分 · ¥${Number(activationReward.cash_amount || 0).toFixed(2)}` : activationReward?.eligibility_at ? "已开放，可人工决定额度" : "体验包不开放；正式套餐立即开放，激活卡兑换后开放"}</p>
                      <button type="button" onClick={() => setActiveTask({ recordId: record.record_id, stage: "activation" })} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/35 px-3 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-500/8"><Gift className="h-3.5 w-3.5" />{activationReward?.status === "sent" ? "查看正式奖励回执" : activationReward?.eligibility_at ? "发给邀请人" : "查看开放条件"}</button>
                    </div>
                  </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {canManagePackages && packageRecord && (
        <div data-testid="invitation-package-assignment-dialog">
          <MemberPackageAssignmentDialog
            open
            token={token}
            recordId={packageRecord.record_id}
            userId={packageRecord.invitee_id}
            userName={personName(packageRecord.invitee)}
            existingAssignment={packageRecord.package_assignment}
            onClose={() => setPackageRecordId(null)}
            onChanged={handleChanged}
          />
        </div>
      )}

      {activeTask && activeRecord && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveTask(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="invitation-reward-dialog-title" data-testid="invitation-reward-dialog" className="max-h-[calc(100vh-48px)] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--border)] bg-[var(--card)] px-5 py-4">
              <div><p className="text-xs font-semibold text-[var(--primary)]">老会员邀请奖励</p><h2 id="invitation-reward-dialog-title" className="mt-1 text-lg font-black text-[var(--foreground)]">{activeTask.stage === "registration" ? "发放邀请注册奖励" : "发放正式会员邀请奖励"}</h2></div>
              <button type="button" aria-label="关闭礼包派发窗口" onClick={() => setActiveTask(null)} className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)]/35"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5">
              <div className="mb-5 grid grid-cols-3 gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)]/60 p-4 text-xs">
                <div><p className="text-[var(--muted-foreground)]">奖励接收人（老会员）</p><p className="mt-1 font-bold text-[var(--foreground)]">{personName(activeRecord.inviter)}</p></div>
                <div><p className="text-[var(--muted-foreground)]">对应受邀学员</p><p className="mt-1 font-bold text-[var(--foreground)]">{personName(activeRecord.invitee)}</p></div>
                <div><p className="text-[var(--muted-foreground)]">邀请码</p><p className="mt-1 font-mono font-bold text-[var(--foreground)]">{activeRecord.invitation_code || "历史未留存"}</p></div>
              </div>
              <div className="mb-5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]"><strong className="text-emerald-700">怎么发：</strong>填积分或现金后只点一次确认。系统会直接写入老会员钱包并推送通知；会员只需查看，不存在再次领取步骤。</div>
              <RewardDecisionEditor key={`${activeRecord.record_id}:${activeTask.stage}:${activeReward?.status || "missing"}`} token={token} record={activeRecord} stage={activeTask.stage} reward={activeReward} onChanged={handleChanged} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
