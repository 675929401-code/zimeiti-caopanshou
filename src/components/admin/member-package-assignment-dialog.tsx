"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Check, Crown, Gift, Loader2, PackageCheck, Save, ShieldCheck, X } from "lucide-react";

export type MemberPackageAssignmentReceipt = {
  id: string;
  profile_key: string | null;
  profile_version: number | null;
  package_name: string;
  membership_status: "trial" | "active";
  duration_days: number;
  member_expires_at: string | null;
  credits: number;
  cash_amount: number;
  feature_navigation_keys: string[];
  agent_navigation_keys: string[];
  permission_revision: number;
  notification_id: string;
  created_at: string;
};

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
};

type ResourceOption = { key: string; label: string; route?: string; description?: string };
type PermissionSnapshot = { revision?: number; integrityValid?: boolean; authorityStatus?: string };

type PackageForm = {
  name: string;
  description: string;
  membershipStatus: "trial" | "active";
  durationDays: string;
  credits: string;
  cashAmount: string;
  featureNavigationKeys: string[];
  agentNavigationKeys: string[];
  note: string;
};

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function formatBeijing(value?: string | null) {
  if (!value) return "长期有效";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
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

function formFromTemplate(template: PackageTemplate): PackageForm {
  return {
    name: template.name,
    description: template.description,
    membershipStatus: template.membershipStatus,
    durationDays: String(template.durationDays),
    credits: String(template.credits),
    cashAmount: String(template.cashAmount),
    featureNavigationKeys: [...template.featureNavigationKeys],
    agentNavigationKeys: [...template.agentNavigationKeys],
    note: "",
  };
}

export function MemberPackageAssignmentDialog({
  open,
  token,
  recordId,
  userId,
  userName,
  existingAssignment,
  onClose,
  onChanged,
}: {
  open: boolean;
  token: string;
  recordId?: string | null;
  userId: string;
  userName: string;
  existingAssignment?: MemberPackageAssignmentReceipt | null;
  onClose: () => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<PackageTemplate[]>([]);
  const [features, setFeatures] = useState<ResourceOption[]>([]);
  const [agents, setAgents] = useState<ResourceOption[]>([]);
  const [permission, setPermission] = useState<PermissionSnapshot | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [form, setForm] = useState<PackageForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"assign" | "template" | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (preferredKey?: string) => {
    if (!token || !userId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/member-packages?user_id=${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "套餐模板读取失败");
      const nextTemplates = Array.isArray(payload.templates) ? payload.templates as PackageTemplate[] : [];
      setTemplates(nextTemplates);
      setFeatures(Array.isArray(payload.resources?.features) ? payload.resources.features : []);
      setAgents(Array.isArray(payload.resources?.agents) ? payload.resources.agents : []);
      setPermission(payload.permission || null);
      const preferred = nextTemplates.find((item) => item.key === preferredKey)
        || nextTemplates.find((item) => item.key === "trial_member")
        || nextTemplates[0];
      if (preferred) {
        setSelectedKey(preferred.key);
        setForm(formFromTemplate(preferred));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "套餐模板读取失败");
    } finally {
      setLoading(false);
    }
  }, [token, userId]);

  useEffect(() => {
    if (!open || existingAssignment) return;
    void load();
  }, [existingAssignment, load, open]);

  const selectedTemplate = templates.find((item) => item.key === selectedKey) || null;
  const numericDuration = Number(form?.durationDays || 0);
  const numericCredits = Number(form?.credits || 0);
  const numericCash = Number(form?.cashAmount || 0);
  const valid = Boolean(form?.name.trim())
    && Number.isInteger(numericDuration)
    && numericDuration >= 0
    && numericDuration <= 36_500
    && (form?.membershipStatus !== "trial" || numericDuration > 0)
    && Number.isFinite(numericCredits) && numericCredits >= 0 && numericCredits <= 1_000_000_000
    && Number.isFinite(numericCash) && numericCash >= 0 && numericCash <= 100_000_000
    && permission?.integrityValid === true;
  const exactTemplate = Boolean(selectedTemplate && form
    && selectedTemplate.name === form.name.trim()
    && selectedTemplate.description === form.description.trim()
    && selectedTemplate.membershipStatus === form.membershipStatus
    && selectedTemplate.durationDays === numericDuration
    && selectedTemplate.credits === numericCredits
    && selectedTemplate.cashAmount === numericCash
    && sameKeys(selectedTemplate.featureNavigationKeys, form.featureNavigationKeys)
    && sameKeys(selectedTemplate.agentNavigationKeys, form.agentNavigationKeys));

  const chooseTemplate = (template: PackageTemplate) => {
    if (busy) return;
    setSelectedKey(template.key);
    setForm(formFromTemplate(template));
    setError("");
  };

  const toggleKey = (field: "featureNavigationKeys" | "agentNavigationKeys", key: string) => {
    setForm((current) => current ? {
      ...current,
      [field]: current[field].includes(key)
        ? current[field].filter((item) => item !== key)
        : [...current[field], key],
    } : current);
  };

  const saveTemplateVersion = async () => {
    if (!form || !selectedTemplate || !valid || busy) return;
    if (!confirm(`把当前配置保存为“${selectedTemplate.name}”的新版本？\n已开通会员仍保留原权限，新版本只影响以后选择该模板的操作。`)) return;
    setBusy("template");
    setError("");
    try {
      const idempotencyKey = `member-package-template:${selectedTemplate.key}:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/member-packages", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          profileKey: selectedTemplate.key,
          name: form.name.trim(),
          description: form.description.trim(),
          membershipStatus: form.membershipStatus,
          durationDays: numericDuration,
          credits: numericCredits,
          cashAmount: numericCash,
          featureNavigationKeys: form.featureNavigationKeys,
          agentNavigationKeys: form.agentNavigationKeys,
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "模板保存失败");
      await load(selectedTemplate.key);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "模板保存失败");
    } finally {
      setBusy(null);
    }
  };

  const assignPackage = async () => {
    if (!form || !valid || busy) return;
    const benefit = [
      numericCredits > 0 ? `${numericCredits.toLocaleString()} 积分` : "",
      numericCash > 0 ? `¥${numericCash.toFixed(2)} 现金` : "",
    ].filter(Boolean).join("、") || "不赠送积分或现金";
    if (!confirm(`确认给“${userName}”开通“${form.name.trim()}”？\n${benefit}；${form.featureNavigationKeys.length} 项业务功能、${form.agentNavigationKeys.length} 个智能体分类。\n确认后立即生效并推送通知，不能重复领取。`)) return;
    setBusy("assign");
    setError("");
    try {
      const idempotencyKey = `member-package-assignment:${recordId || userId}:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/member-packages/assign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          userId,
          invitationRecordId: recordId || null,
          profileKey: exactTemplate ? selectedTemplate?.key : null,
          profileVersion: exactTemplate ? selectedTemplate?.version : null,
          packageName: form.name.trim(),
          membershipStatus: form.membershipStatus,
          durationDays: numericDuration,
          credits: numericCredits,
          cashAmount: numericCash,
          featureNavigationKeys: form.featureNavigationKeys,
          agentNavigationKeys: form.agentNavigationKeys,
          expectedPermissionRevision: Number(permission?.revision || 0),
          note: form.note.trim(),
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "套餐开通失败");
      const receipt = payload.receipt || {};
      await onChanged(`已给 ${userName} 开通“${receipt.package_name || form.name.trim()}”，权限与资产已生效，到账通知已推送`);
      onClose();
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : "套餐开通失败");
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[150] grid place-items-center bg-black/45 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="member-package-dialog-title">
      <div className="flex max-h-[calc(100vh-64px)] w-[min(1040px,calc(100vw-96px))] flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
        <header className="flex items-start gap-4 border-b border-[var(--border)] px-7 py-5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-violet-500/12 text-violet-600"><Crown className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-violet-600">配置会员套餐 · 权益一次生效</p>
            <h2 id="member-package-dialog-title" className="mt-1 text-xl font-black text-[var(--foreground)]">给 {userName} 配置会员套餐</h2>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">确认一次，系统同步保存会员状态、访问权限、积分/现金并推送到账通知；用户无需再次领取。</p>
            <p data-testid="member-package-activation-rules" className="mt-2 text-xs font-semibold text-amber-700">体验包仅进入试用；正式会员或超级 VIP 确认后立即激活，并开放邀请人的正式会员奖励。发送激活卡属于另一条路径，只有学员兑换后才激活。</p>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(busy)} className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40" aria-label="关闭套餐窗口"><X className="h-4 w-4" /></button>
        </header>

        <div className="overflow-y-auto px-7 py-6">
          {existingAssignment ? (
            <div data-testid="member-package-receipt" className="rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-6">
              <div className="flex items-center gap-2 text-lg font-black text-emerald-700"><BadgeCheck className="h-5 w-5" />会员套餐已开通</div>
              <p className="mt-2 text-sm text-[var(--secondary-foreground)]">该邀请码关系的新人套餐已经完成，不能从这里重复发放；需要升级时请到会员管理操作。</p>
              <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">套餐</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{existingAssignment.package_name}</dd></div>
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">有效期</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{formatBeijing(existingAssignment.member_expires_at)}</dd></div>
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">到账权益</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{Number(existingAssignment.credits || 0).toLocaleString()} 积分 · ¥{Number(existingAssignment.cash_amount || 0).toFixed(2)}</dd></div>
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">业务功能</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{existingAssignment.feature_navigation_keys.length} 项</dd></div>
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">智能体分类</dt><dd className="mt-1 font-bold text-[var(--foreground)]">{existingAssignment.agent_navigation_keys.length} 个</dd></div>
                <div className="rounded-xl bg-[var(--card)]/80 p-3"><dt className="text-xs text-[var(--muted-foreground)]">通知回执</dt><dd className="mt-1 truncate font-mono text-xs text-[var(--foreground)]">{existingAssignment.notification_id}</dd></div>
              </dl>
            </div>
          ) : loading || !form ? (
            <div className="grid min-h-[360px] place-items-center text-sm text-[var(--muted-foreground)]"><span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />正在读取套餐和当前权限…</span></div>
          ) : (
            <div className="space-y-6">
              <section>
                <div className="flex items-end justify-between gap-3">
                  <div><h3 className="font-black text-[var(--foreground)]">1. 先选一个模板</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">模板只是起点；改动任意数字或权限后，本次会按自定义配置开通。</p></div>
                  {!exactTemplate && <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-600">当前为自定义配置</span>}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3">
                  {templates.map((template) => {
                    const selected = template.key === selectedKey;
                    return (
                      <button key={`${template.key}:${template.version}`} type="button" onClick={() => chooseTemplate(template)} className={`rounded-2xl border p-4 text-left transition ${selected ? "border-violet-500 bg-violet-500/8 ring-2 ring-violet-500/10" : "border-[var(--border)] bg-[var(--background)]/30 hover:border-violet-500/40"}`}>
                        <div className="flex items-center justify-between gap-2"><strong className="text-sm text-[var(--foreground)]">{template.name}</strong>{selected && <Check className="h-4 w-4 text-violet-600" />}</div>
                        <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-5 text-[var(--muted-foreground)]">{template.description}</p>
                        <p className="mt-3 text-xs font-semibold text-violet-600">{template.membershipStatus === "trial" ? `${template.durationDays} 天试用` : template.durationDays > 0 ? `${template.durationDays} 天会员` : "长期正式会员"} · {template.credits.toLocaleString()} 积分</p>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/28 p-5">
                <div className="flex items-center justify-between gap-3"><div><h3 className="font-black text-[var(--foreground)]">2. 核对套餐内容</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">积分可填 0；正式会员有效期填 0 表示长期。试用套餐必须填写天数。</p></div><PackageCheck className="h-5 w-5 text-[var(--primary)]" /></div>
                <div className="mt-4 grid grid-cols-5 gap-3">
                  <label className="col-span-2 text-xs font-semibold text-[var(--muted-foreground)]">套餐名称<input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]" /></label>
                  <label className="text-xs font-semibold text-[var(--muted-foreground)]">会员类型<select value={form.membershipStatus} onChange={(event) => setForm({ ...form, membershipStatus: event.target.value as "trial" | "active", durationDays: event.target.value === "trial" && Number(form.durationDays) <= 0 ? "7" : form.durationDays })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]"><option value="trial">试用会员</option><option value="active">正式会员</option></select></label>
                  <label className="text-xs font-semibold text-[var(--muted-foreground)]">有效天数<input type="number" min={0} max={36500} step={1} value={form.durationDays} onChange={(event) => setForm({ ...form, durationDays: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]" /></label>
                  <label className="text-xs font-semibold text-[var(--muted-foreground)]">赠送积分<input type="number" min={0} max={1_000_000_000} step="0.01" value={form.credits} onChange={(event) => setForm({ ...form, credits: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]" /></label>
                  <label className="text-xs font-semibold text-[var(--muted-foreground)]">赠送现金（元）<input type="number" min={0} max={100_000_000} step="0.01" value={form.cashAmount} onChange={(event) => setForm({ ...form, cashAmount: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]" /></label>
                  <label className="col-span-4 text-xs font-semibold text-[var(--muted-foreground)]">套餐说明<input value={form.description} maxLength={1000} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1.5 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)]" /></label>
                </div>
              </section>

              <section className="rounded-2xl border border-[var(--border)] bg-[var(--background)]/28 p-5">
                <div className="flex items-start justify-between gap-4"><div><h3 className="font-black text-[var(--foreground)]">3. 勾选可用权限</h3><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">系统新增导航或智能体分类会自动出现在这里，但默认不勾选；旧会员和旧模板不会被系统升级偷偷扩权。</p></div><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" /></div>
                <p className="mt-4 text-xs font-bold text-[var(--secondary-foreground)]">业务功能（{form.featureNavigationKeys.length}/{features.length}）</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {features.map((option) => <button key={option.key} type="button" onClick={() => toggleKey("featureNavigationKeys", option.key)} className={`rounded-xl border px-3 py-2.5 text-left text-xs transition ${form.featureNavigationKeys.includes(option.key) ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-700" : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-emerald-500/30"}`}><span className="font-bold">{option.label}</span><span className="mt-0.5 block truncate font-mono text-[10px] opacity-70">{option.route}</span></button>)}
                </div>
                <p className="mt-4 text-xs font-bold text-[var(--secondary-foreground)]">智能体分类（{form.agentNavigationKeys.length}/{agents.length}）</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agents.map((option) => <button key={option.key} type="button" onClick={() => toggleKey("agentNavigationKeys", option.key)} className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${form.agentNavigationKeys.includes(option.key) ? "border-violet-500/35 bg-violet-500/10 text-violet-700" : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-violet-500/30"}`}>{option.label}</button>)}
                </div>
              </section>

              <label className="block text-xs font-semibold text-[var(--muted-foreground)]">给学员的说明（选填）<textarea value={form.note} maxLength={2000} rows={2} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="会一并写入学员的到账通知" className="mt-1.5 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-sm text-[var(--foreground)]" /></label>
              {permission?.integrityValid !== true && <p role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/8 p-3 text-sm font-semibold text-rose-600">当前学员的权限快照不可验证，已阻止开通，避免产生半套权限。</p>}
              {!valid && permission?.integrityValid === true && <p role="alert" className="text-xs font-semibold text-rose-600">请检查套餐名称、有效天数和赠送额度。</p>}
            </div>
          )}
          {error && <p role="alert" className="mt-4 rounded-xl border border-rose-500/25 bg-rose-500/8 p-3 text-sm font-semibold text-rose-600">{error}</p>}
        </div>

        <footer className="flex items-center gap-3 border-t border-[var(--border)] px-7 py-4">
          <p className="mr-auto text-xs text-[var(--muted-foreground)]">通知位置：学员登录弹窗、网页右下角提醒、个人中心「账号消息」。</p>
          {!existingAssignment && form && <button type="button" onClick={() => void saveTemplateVersion()} disabled={!selectedTemplate || !valid || Boolean(busy)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-bold text-[var(--foreground)] hover:bg-[var(--muted)] disabled:cursor-not-allowed disabled:opacity-35"><Save className="h-4 w-4" />{busy === "template" ? "保存模板中…" : "保存为模板新版"}</button>}
          <button type="button" onClick={onClose} disabled={Boolean(busy)} className="h-10 rounded-xl border border-[var(--border)] px-4 text-sm font-bold text-[var(--muted-foreground)] disabled:opacity-40">{existingAssignment ? "关闭" : "取消"}</button>
          {!existingAssignment && form && <button data-testid="member-package-assign" type="button" onClick={() => void assignPackage()} disabled={!valid || Boolean(busy)} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--primary)] px-5 text-sm font-bold text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-35"><Gift className="h-4 w-4" />{busy === "assign" ? "开通并推送中…" : form.membershipStatus === "trial" ? "确认发放体验包并通知" : "确认正式开通并通知"}</button>}
        </footer>
      </div>
    </div>
  );
}
