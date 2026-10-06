"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Crown, Loader2, Plus, RefreshCw, Save, ShieldCheck, Sparkles } from "lucide-react";

type PackageTemplate = {
  key: string;
  version: number;
  name: string;
  description: string;
  membershipStatus: "trial" | "active";
  durationDays: number;
  credits: number;
  cashAmount: number;
  featureNavigationKeys: string[];
  agentNavigationKeys: string[];
  updatedAt?: string | null;
};

type ResourceOption = {
  key: string;
  label: string;
  route?: string | null;
  description?: string;
};

type TemplateDraft = {
  name: string;
  description: string;
  membershipStatus: "trial" | "active";
  durationDays: string;
  credits: string;
  cashAmount: string;
  featureNavigationKeys: string[];
  agentNavigationKeys: string[];
};

type RegistrationAutomation = {
  enabled: boolean;
  revision: number;
  updatedAt?: string | null;
  profileKey: string;
  profileVersion: number;
  packageName: string;
  durationDays: number;
  credits: number;
  cashAmount: number;
  featureCount: number;
  agentCount: number;
};

function draftFromTemplate(template: PackageTemplate): TemplateDraft {
  return {
    name: template.name,
    description: template.description,
    membershipStatus: template.membershipStatus,
    durationDays: String(template.durationDays),
    credits: String(template.credits),
    cashAmount: String(template.cashAmount),
    featureNavigationKeys: [...template.featureNavigationKeys],
    agentNavigationKeys: [...template.agentNavigationKeys],
  };
}

function emptyTemplateDraft(): TemplateDraft {
  return {
    name: "",
    description: "",
    membershipStatus: "trial",
    durationDays: "7",
    credits: "0",
    cashAmount: "0",
    featureNavigationKeys: [],
    agentNavigationKeys: [],
  };
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function formatUpdatedAt(value?: string | null) {
  if (!value) return "初始版本";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间未知";
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

export function MemberPackageTemplateManager({ token }: { token: string | null }) {
  const [templates, setTemplates] = useState<PackageTemplate[]>([]);
  const [features, setFeatures] = useState<ResourceOption[]>([]);
  const [agents, setAgents] = useState<ResourceOption[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [automation, setAutomation] = useState<RegistrationAutomation | null>(null);
  const [automationRuns, setAutomationRuns] = useState({ total: 0, sent: 0, failed: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automationBusy, setAutomationBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async (preferredKey?: string) => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [response, automationResponse] = await Promise.all([
        fetch("/api/admin/member-packages", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        }),
        fetch("/api/admin/member-packages/automation", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        }),
      ]);
      const [payload, automationPayload] = await Promise.all([
        response.json().catch(() => ({})),
        automationResponse.json().catch(() => ({})),
      ]);
      if (!response.ok) throw new Error(payload.error || "套餐模板读取失败");
      if (!automationResponse.ok) throw new Error(automationPayload.error || "新人体验包开关读取失败");
      const nextTemplates = Array.isArray(payload.templates) ? payload.templates as PackageTemplate[] : [];
      const nextFeatures = Array.isArray(payload.resources?.features) ? payload.resources.features as ResourceOption[] : [];
      const nextAgents = Array.isArray(payload.resources?.agents) ? payload.resources.agents as ResourceOption[] : [];
      setTemplates(nextTemplates);
      setFeatures(nextFeatures);
      setAgents(nextAgents);
      setAutomation(automationPayload.automation || null);
      setAutomationRuns(automationPayload.recentRuns || { total: 0, sent: 0, failed: 0 });
      const selected = nextTemplates.find((item) => item.key === preferredKey)
        || nextTemplates.find((item) => item.key === selectedKey)
        || nextTemplates[0];
      if (selected) {
        setSelectedKey(selected.key);
        setDraft(draftFromTemplate(selected));
        setCreating(false);
      } else {
        setSelectedKey("");
        setDraft(null);
        setCreating(false);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "套餐模板读取失败");
    } finally {
      setLoading(false);
    }
  }, [selectedKey, token]);

  useEffect(() => {
    void load();
    // Only the administrator session should trigger the initial catalog sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const selectedTemplate = templates.find((item) => item.key === selectedKey) || null;
  const durationDays = Number(draft?.durationDays || 0);
  const credits = Number(draft?.credits || 0);
  const cashAmount = Number(draft?.cashAmount || 0);
  const valid = Boolean(draft?.name.trim())
    && Number.isInteger(durationDays) && durationDays >= 0 && durationDays <= 36_500
    && (draft?.membershipStatus !== "trial" || durationDays > 0)
    && Number.isFinite(credits) && credits >= 0 && credits <= 1_000_000_000
    && Number.isFinite(cashAmount) && cashAmount >= 0 && cashAmount <= 100_000_000;
  const unchanged = Boolean(selectedTemplate && draft
    && selectedTemplate.name === draft.name.trim()
    && selectedTemplate.description === draft.description.trim()
    && selectedTemplate.membershipStatus === draft.membershipStatus
    && selectedTemplate.durationDays === durationDays
    && selectedTemplate.credits === credits
    && selectedTemplate.cashAmount === cashAmount
    && sameKeys(selectedTemplate.featureNavigationKeys, draft.featureNavigationKeys)
    && sameKeys(selectedTemplate.agentNavigationKeys, draft.agentNavigationKeys));

  const newlyDiscoveredCount = useMemo(() => {
    if (!selectedTemplate) return creating ? features.length + agents.length : 0;
    return features.filter((item) => !selectedTemplate.featureNavigationKeys.includes(item.key)).length
      + agents.filter((item) => !selectedTemplate.agentNavigationKeys.includes(item.key)).length;
  }, [agents, creating, features, selectedTemplate]);

  const selectTemplate = (template: PackageTemplate) => {
    if (saving) return;
    setSelectedKey(template.key);
    setDraft(draftFromTemplate(template));
    setCreating(false);
    setError("");
    setMessage("");
  };

  const startCreating = () => {
    if (saving) return;
    setSelectedKey("");
    setDraft(emptyTemplateDraft());
    setCreating(true);
    setError("");
    setMessage("");
  };

  const cancelEditing = () => {
    if (saving) return;
    if (creating) {
      const first = templates[0];
      if (first) selectTemplate(first);
      else {
        setCreating(false);
        setDraft(null);
      }
      return;
    }
    if (selectedTemplate) selectTemplate(selectedTemplate);
  };

  const toggleKey = (field: "featureNavigationKeys" | "agentNavigationKeys", key: string) => {
    setDraft((current) => current ? {
      ...current,
      [field]: current[field].includes(key)
        ? current[field].filter((item) => item !== key)
        : [...current[field], key],
    } : current);
  };

  const save = async () => {
    if (!token || !draft || !valid || saving || (!creating && (!selectedTemplate || unchanged))) return;
    const profileKey = selectedTemplate?.key || `custom_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const confirmation = creating
      ? `确认创建套餐“${draft.name.trim()}”？\n创建后可在邀请关系或学员管理中手动选择并派发。`
      : `确认把当前配置保存为“${selectedTemplate?.name}”的新版本？\n已经开通的会员保留原权限；新版只用于以后派发。`;
    if (!confirm(confirmation)) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const idempotencyKey = `member-package-template:${profileKey}:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/member-packages", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          profileKey,
          name: draft.name.trim(),
          description: draft.description.trim(),
          membershipStatus: draft.membershipStatus,
          durationDays,
          credits,
          cashAmount,
          featureNavigationKeys: draft.featureNavigationKeys,
          agentNavigationKeys: draft.agentNavigationKeys,
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "套餐模板保存失败");
      const savedKey = String(payload.receipt?.profile_key || profileKey);
      const version = Number(payload.receipt?.version || (selectedTemplate?.version || 0) + 1);
      setMessage(creating
        ? `已创建“${draft.name.trim()}”第 ${version} 版，现在可手动选择并派发。`
        : `已保存“${draft.name.trim()}”第 ${version} 版；旧会员权限没有变化。`);
      await load(savedKey);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "套餐模板保存失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleRegistrationPackage = async () => {
    if (!token || !automation || automationBusy || saving) return;
    const nextEnabled = !automation.enabled;
    const confirmation = nextEnabled
      ? `确认开启“新人注册即发体验包”？\n以后通过邀请码完成注册的新人，将立即获得当前“${automation.packageName}”并收到到账通知；正式会员、超级 VIP 和邀请人奖励仍不会自动发放。`
      : "确认关闭“新人注册即发体验包”？\n关闭后，新注册关系会保留在邀请关系中，等你手动选择套餐。";
    if (!confirm(confirmation)) return;
    setAutomationBusy(true);
    setError("");
    setMessage("");
    try {
      const idempotencyKey = `invited-registration-package-toggle:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/member-packages/automation", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ enabled: nextEnabled, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "新人体验包开关保存失败");
      setMessage(nextEnabled
        ? "已开启：以后通过邀请码注册的新人会立即收到体验包；其他套餐和邀请人奖励仍由你决定。"
        : "已关闭：以后注册的新人会进入待处理列表，由你手动选择套餐。");
      await load(selectedKey);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "新人体验包开关保存失败");
    } finally {
      setAutomationBusy(false);
    }
  };

  if (!token) {
    return <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-center text-sm text-[var(--muted-foreground)]">请先登录管理员账号。</div>;
  }

  return (
    <div className="space-y-5" data-testid="member-package-template-manager">
      <section className="rounded-3xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-violet-500/10 text-violet-600"><Crown className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-black text-[var(--foreground)]">会员权益与邀请礼包</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">这里只管理邀请码与管理员赠送的权益，不发起支付，也不修改用户购买的套餐。派发时可临时改积分、现金、期限和权限；保存采用版本制，不会回写或扩大旧会员权限。</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button data-testid="create-member-package-template" type="button" onClick={startCreating} disabled={loading || saving} className="inline-flex h-10 items-center gap-2 rounded-xl border border-violet-500/35 bg-violet-500/8 px-4 text-sm font-bold text-violet-700 disabled:opacity-40"><Plus className="h-4 w-4" />新增权益礼包</button>
            <a href="/admin?tab=invitations" className="inline-flex h-10 items-center rounded-xl bg-[var(--primary)] px-4 text-sm font-bold text-[var(--primary-foreground)]">去邀请关系派发</a>
            <button type="button" onClick={() => void load(selectedKey)} disabled={loading || saving} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-bold text-[var(--foreground)] disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />同步权限目录</button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/7 p-4"><strong className="text-emerald-700">新增能力自动发现</strong><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">导航与智能体分类从运行时统一目录同步。</p></div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/7 p-4"><strong className="text-amber-700">新增能力默认关闭</strong><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">管理员勾选并保存新版后，才进入以后派发的套餐。</p></div>
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/7 p-4"><strong className="text-blue-700">派发一次完整到账</strong><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">会员状态、期限、权限、积分/现金和通知同一事务完成。</p></div>
        </div>
      </section>

      {automation && (
        <section className={`rounded-3xl border p-6 shadow-sm ${automation.enabled ? "border-emerald-500/35 bg-emerald-500/7" : "border-[var(--border)] bg-[var(--card)]"}`} data-testid="invited-registration-package-toggle">
          <div className="flex items-center gap-5">
            <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl ${automation.enabled ? "bg-emerald-500/15 text-emerald-700" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}><Sparkles className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-black text-[var(--foreground)]">新人注册即发体验包</h3>
                <span className={`rounded-full px-2.5 py-1 text-xs font-black ${automation.enabled ? "bg-emerald-500/15 text-emerald-700" : "bg-[var(--muted)] text-[var(--muted-foreground)]"}`}>{automation.enabled ? "已开启" : "已关闭"}</span>
              </div>
              <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">只有这一枚开关：关闭时新人进入待派发列表；开启时邀请码注册成功后立即发放当前体验包。正式会员、超级 VIP 和邀请人奖励始终另行确认。</p>
              <p className="mt-2 text-xs font-semibold text-[var(--secondary-foreground)]">当前体验包：{automation.packageName} V{automation.profileVersion} · {automation.durationDays} 天 · {automation.credits.toLocaleString()} 积分 · ¥{automation.cashAmount.toFixed(2)} · {automation.featureCount} 项业务功能 · {automation.agentCount} 个智能体分类</p>
              <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">开关版本 R{automation.revision} · 已执行 {automationRuns.total} 次{automationRuns.failed > 0 ? `（最近失败 ${automationRuns.failed} 次，仍可手动补发）` : ""}。修改“试用套餐”并保存新版后，下一位新人使用最新版本。</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={automation.enabled}
              data-testid="toggle-invited-registration-package"
              onClick={() => void toggleRegistrationPackage()}
              disabled={automationBusy || saving}
              className={`relative h-9 w-16 shrink-0 rounded-full border transition ${automation.enabled ? "border-emerald-600 bg-emerald-600" : "border-[var(--border)] bg-[var(--muted)]"} disabled:cursor-not-allowed disabled:opacity-45`}
              aria-label={automation.enabled ? "关闭新人注册即发体验包" : "开启新人注册即发体验包"}
            >
              <span className={`absolute top-1 h-7 w-7 rounded-full bg-white shadow transition-all ${automation.enabled ? "left-8" : "left-1"}`} />
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className="grid min-h-64 place-items-center rounded-3xl border border-[var(--border)] bg-[var(--card)]"><span className="inline-flex items-center gap-2 text-sm text-[var(--muted-foreground)]"><Loader2 className="h-4 w-4 animate-spin" />正在读取真实权益礼包与权限目录…</span></div>
      ) : (
        <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-5">
          <aside className="space-y-3">
            <button data-testid="new-member-package-template" type="button" onClick={startCreating} className={`flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed p-4 text-sm font-black transition ${creating ? "border-violet-500 bg-violet-500/8 text-violet-700 ring-2 ring-violet-500/10" : "border-violet-500/35 bg-[var(--card)] text-violet-700 hover:bg-violet-500/5"}`}><Plus className="h-4 w-4" />自定义新礼包</button>
            {templates.map((template) => {
              const selected = template.key === selectedKey;
              return (
                <button key={template.key} type="button" onClick={() => selectTemplate(template)} className={`w-full rounded-2xl border p-4 text-left transition ${selected ? "border-violet-500 bg-violet-500/8 ring-2 ring-violet-500/10" : "border-[var(--border)] bg-[var(--card)] hover:border-violet-500/35"}`}>
                  <div className="flex items-center justify-between gap-2"><strong className="text-sm text-[var(--foreground)]">{template.name}</strong><span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-bold text-[var(--muted-foreground)]">V{template.version}</span></div>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--muted-foreground)]">{template.description}</p>
                  <p className="mt-3 text-xs font-bold text-violet-600">{template.membershipStatus === "trial" ? `${template.durationDays} 天试用` : template.durationDays > 0 ? `${template.durationDays} 天正式会员` : "长期正式会员"}</p>
                  <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{template.credits.toLocaleString()} 积分 · ¥{template.cashAmount.toFixed(2)} · {template.featureNavigationKeys.length + template.agentNavigationKeys.length} 项权限</p>
                </button>
              );
            })}
            {templates.length === 0 && <p className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 text-xs leading-5 text-[var(--muted-foreground)]">当前没有套餐。点击上方按钮创建第一套。</p>}
          </aside>

          {draft && (selectedTemplate || creating) && (
            <section className="rounded-3xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div><h3 className="text-lg font-black text-[var(--foreground)]">{creating ? "创建自定义套餐" : "编辑固定模板"}</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">{creating ? "命名并设置会员类型、赠送额度和访问权限；创建后即可手动派发。" : `当前 V${selectedTemplate?.version} · ${formatUpdatedAt(selectedTemplate?.updatedAt)} · 下方可直接修改后保存为新版。`}</p></div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-700"><ShieldCheck className="h-3.5 w-3.5" />{creating ? "默认不开放任何权限" : "旧会员不受影响"}</span>
              </div>

              <div className="mt-5 grid grid-cols-6 gap-3">
                <label className="col-span-2 text-xs font-semibold text-[var(--muted-foreground)]">套餐名称<input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]" /></label>
                <label className="text-xs font-semibold text-[var(--muted-foreground)]">会员类型<select value={draft.membershipStatus} onChange={(event) => setDraft({ ...draft, membershipStatus: event.target.value as "trial" | "active", durationDays: event.target.value === "trial" && Number(draft.durationDays) <= 0 ? "7" : draft.durationDays })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]"><option value="trial">试用会员</option><option value="active">正式会员</option></select></label>
                <label className="text-xs font-semibold text-[var(--muted-foreground)]">有效天数<input type="number" min={0} max={36500} step={1} value={draft.durationDays} onChange={(event) => setDraft({ ...draft, durationDays: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]" /></label>
                <label className="text-xs font-semibold text-[var(--muted-foreground)]">赠送积分<input type="number" min={0} max={1_000_000_000} step="0.01" value={draft.credits} onChange={(event) => setDraft({ ...draft, credits: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]" /></label>
                <label className="text-xs font-semibold text-[var(--muted-foreground)]">赠送现金（元）<input type="number" min={0} max={100_000_000} step="0.01" value={draft.cashAmount} onChange={(event) => setDraft({ ...draft, cashAmount: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]" /></label>
                <label className="col-span-6 text-xs font-semibold text-[var(--muted-foreground)]">套餐说明<input value={draft.description} maxLength={1000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 text-sm text-[var(--foreground)]" /></label>
              </div>

              <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--background)]/35 p-5">
                <div className="flex items-start justify-between gap-3"><div><h4 className="font-black text-[var(--foreground)]">业务功能权限</h4><p className="mt-1 text-xs text-[var(--muted-foreground)]">{draft.featureNavigationKeys.length}/{features.length} 项已开通；未勾选项目在用户页面隐藏，直达页面和对应接口也会拒绝。</p></div><Sparkles className="h-5 w-5 text-emerald-600" /></div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {features.map((option) => {
                    const checked = draft.featureNavigationKeys.includes(option.key);
                    return <button key={option.key} type="button" onClick={() => toggleKey("featureNavigationKeys", option.key)} className={`rounded-xl border px-3 py-2.5 text-left text-xs transition ${checked ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700" : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-emerald-500/30"}`}><span className="flex items-center justify-between gap-2 font-bold">{option.label}{checked && <Check className="h-3.5 w-3.5" />}</span><span className="mt-0.5 block truncate font-mono text-[10px] opacity-70">{option.route}</span></button>;
                  })}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--background)]/35 p-5">
                <h4 className="font-black text-[var(--foreground)]">智能体分类权限</h4>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">{draft.agentNavigationKeys.length}/{agents.length} 个分类已开通。新增分类同步后默认不勾选，避免系统更新造成越权。</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {agents.map((option) => {
                    const checked = draft.agentNavigationKeys.includes(option.key);
                    return <button key={option.key} type="button" onClick={() => toggleKey("agentNavigationKeys", option.key)} className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition ${checked ? "border-violet-500/35 bg-violet-500/10 text-violet-700" : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-violet-500/30"}`}>{option.label}{checked && <Check className="h-3.5 w-3.5" />}</button>;
                  })}
                </div>
              </div>

              <div className="mt-5 flex items-center gap-3">
                <p className="mr-auto text-xs leading-5 text-[var(--muted-foreground)]">当前目录中有 {newlyDiscoveredCount} 个未包含在该模板的项目；它们保持关闭，直到你主动勾选并保存。</p>
                <button type="button" onClick={cancelEditing} disabled={saving || (!creating && unchanged)} className="h-10 rounded-xl border border-[var(--border)] px-4 text-sm font-bold text-[var(--muted-foreground)] disabled:opacity-35">{creating ? "取消新增" : "撤销修改"}</button>
                <button data-testid="save-member-package-template" type="button" onClick={() => void save()} disabled={saving || (!creating && unchanged) || !valid} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-5 text-sm font-bold text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-35"><Save className="h-4 w-4" />{saving ? (creating ? "创建中…" : "保存新版中…") : (creating ? "创建套餐" : "保存为新版本")}</button>
              </div>
              {!valid && <p role="alert" className="mt-3 text-sm font-semibold text-rose-600">请检查套餐名称、会员类型、有效天数和赠送额度。</p>}
            </section>
          )}
        </div>
      )}

      {message && <p role="status" className="rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/8 px-4 py-3 text-sm font-semibold text-rose-600">{error}</p>}
    </div>
  );
}
