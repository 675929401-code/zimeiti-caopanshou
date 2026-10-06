"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildAdminPluginPayload, createAdminPluginForm, type AdminPluginForm, type AdminPluginRecord, type AdminPluginType } from "@/lib/admin-plugin-form";
import { pluginSecretFieldNames } from "@/lib/plugin-metadata";

interface SystemRole { label: string; type: AdminPluginType; subtype: string; desc: string }
const typeLabels: Record<AdminPluginType, string> = {
  coze: "扣子插件", third_party: "第三方 API", page_embed: "页面嵌入", knowledge_base: "知识库", workflow: "工作流",
};
const fieldClass = "w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]";
const buttonClass = "rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--accent)] disabled:opacity-50";

export function PluginManagementTab({ token }: { token: string | null }) {
  const [plugins, setPlugins] = useState<AdminPluginRecord[]>([]);
  const [roles, setRoles] = useState<Record<string, SystemRole>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<AdminPluginForm | null>(null);
  const [editing, setEditing] = useState<AdminPluginRecord | undefined>();
  const [saving, setSaving] = useState(false);
  const [unknownSave, setUnknownSave] = useState(false);
  const mutationLock = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    if (!token) { setLoading(false); setError("请先登录管理员账户"); return false; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/plugins", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.plugins)) throw new Error("PLUGIN_LIST_FAILED");
      setPlugins(body.plugins); setRoles(body.systemRoles || {}); return true;
    } catch { setError("插件列表暂时无法读取，请重试。"); return false; }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const open = (plugin?: AdminPluginRecord) => {
    if (saving || unknownSave) return;
    setEditing(plugin); setForm(createAdminPluginForm(plugin)); setError(""); setNotice("");
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const patch = (values: Partial<AdminPluginForm>) => setForm((current) => current ? { ...current, ...values } : current);
  const refresh = async () => {
    if (saving) return;
    if (await load() && unknownSave) { setUnknownSave(false); setForm(null); setEditing(undefined); setNotice("已重新读取列表，请核对刚才的保存结果。"); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || !token || mutationLock.current || unknownSave) return;
    let payload: Record<string, unknown>;
    try { payload = buildAdminPluginPayload(form, editing); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "请检查输入内容"); return; }
    mutationLock.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/plugins", { method: editing ? "PUT" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status >= 500) throw new Error("SAVE_OUTCOME_UNKNOWN");
        setError(typeof body.error === "string" ? body.error : "保存未通过，请检查配置"); return;
      }
      if (!body.plugin?.id || (editing && body.plugin.id !== editing.id)) throw new Error("SAVE_RECEIPT_INVALID");
      setForm(null); setEditing(undefined); setNotice("插件已保存。");
      await load();
    } catch { setUnknownSave(true); setError("保存结果尚未确认，请刷新插件列表核对后再操作。"); }
    finally { mutationLock.current = false; setSaving(false); }
  };
  const remove = async (plugin: AdminPluginRecord) => {
    if (!token || mutationLock.current || unknownSave || !confirm(`删除插件“${plugin.name}”？此操作会移除它的配置。`)) return;
    mutationLock.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/admin/plugins?id=${encodeURIComponent(plugin.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      if (!response.ok || body.success !== true) throw new Error("DELETE_UNCONFIRMED");
      if (editing?.id === plugin.id) { setEditing(undefined); setForm(null); }
      setNotice("插件已删除。"); await load();
    } catch { setUnknownSave(true); setError("删除结果尚未确认，请刷新插件列表核对。"); }
    finally { mutationLock.current = false; setSaving(false); }
  };
  const existingSecrets = pluginSecretFieldNames(editing?.config);

  return (
    <section className="space-y-5" data-admin-section="plugin-management">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-lg font-bold">插件管理</h3><p className="mt-1 text-sm text-[var(--muted-foreground)]">配置扣子、抖音等平台的提取接口，以及页面、知识库和工作流插件。</p></div>
        <div className="flex gap-2"><button type="button" className={buttonClass} disabled={loading || saving} onClick={() => void refresh()}>刷新插件</button><button type="button" className={buttonClass} disabled={saving || unknownSave} onClick={() => open()}>添加插件</button></div>
      </div>
      <p className="text-sm text-[var(--muted-foreground)]">提取插件在此添加和设置价格，再到<a className="ml-1 underline" href="/admin?tab=models">模型管理 → 文案提取</a>选择使用。</p>
      {error && <div role="alert" className="rounded-lg border border-red-300 p-3 text-sm text-red-600">{error}</div>}
      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {form && <form ref={formRef} onSubmit={save} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5" aria-label={editing ? "编辑插件" : "添加插件"}>
        <h4 className="font-semibold">{editing ? "编辑插件" : "添加插件"}</h4>
        <fieldset disabled={saving || unknownSave} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">插件名称<input className={fieldClass} value={form.name} onChange={(event) => patch({ name: event.target.value })} required /></label>
          <label className="space-y-1 text-sm">插件类型<select className={fieldClass} value={form.type} onChange={(event) => patch({ type: event.target.value as AdminPluginType })}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="space-y-1 text-sm">系统用途<select className={fieldClass} value={form.role} onChange={(event) => { const role = event.target.value; const preset = roles[role]; patch({ role, ...(preset ? { type: preset.type, subtype: preset.subtype } : {}) }); }}><option value="">通用插件</option>{form.role && !roles[form.role] && <option value={form.role}>{form.role}</option>}{Object.entries(roles).map(([value, role]) => <option key={value} value={value}>{role.label}</option>)}</select></label>
          <label className="space-y-1 text-sm">子类型<input className={fieldClass} value={form.subtype} onChange={(event) => patch({ subtype: event.target.value })} /></label>
          {form.type !== "page_embed" && <label className="space-y-1 text-sm sm:col-span-2">API 地址<input className={fieldClass} type="url" value={form.apiBaseUrl} onChange={(event) => patch({ apiBaseUrl: event.target.value })} placeholder="https://api.example.com/workflow/run" required={form.type === "coze" || form.type === "third_party"} /></label>}
          {form.type === "page_embed" && <label className="space-y-1 text-sm sm:col-span-2">页面地址<input className={fieldClass} type="url" value={form.embedUrl} onChange={(event) => patch({ embedUrl: event.target.value })} required /></label>}
          {Object.entries(form.secretValues).map(([key, value]) => <div key={key} className="space-y-1 text-sm"><label className="block">{key === "api_token" ? "API Token" : key === "api_key" ? "API Key" : key}<input className={fieldClass} type="password" autoComplete="new-password" value={value} disabled={form.clearSecretFields.includes(key)} placeholder={editing?.config[key] ? "已配置，留空保留原凭据" : "未配置"} onChange={(event) => patch({ secretValues: { ...form.secretValues, [key]: event.target.value } })} /></label>{existingSecrets.includes(key) && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.clearSecretFields.includes(key)} onChange={(event) => patch({ clearSecretFields: event.target.checked ? [...form.clearSecretFields, key] : form.clearSecretFields.filter((item) => item !== key) })} />清除 {key} 凭据</label>}</div>)}
          <label className="space-y-1 text-sm">工作流 ID<input className={fieldClass} value={form.workflowId} onChange={(event) => patch({ workflowId: event.target.value })} /></label>
          <label className="space-y-1 text-sm">应用 ID<input className={fieldClass} value={form.appId} onChange={(event) => patch({ appId: event.target.value })} /></label>
          <label className="space-y-1 text-sm">售价（元）<input className={fieldClass} inputMode="decimal" value={form.price} onChange={(event) => patch({ price: event.target.value })} required /></label>
          <label className="space-y-1 text-sm">成本价（元）<input className={fieldClass} inputMode="decimal" value={form.cost} onChange={(event) => patch({ cost: event.target.value })} required /></label>
          <label className="space-y-1 text-sm">计价单位<input className={fieldClass} value={form.priceUnit} onChange={(event) => patch({ priceUnit: event.target.value })} /></label>
          <label className="space-y-1 text-sm">排序<input className={fieldClass} type="number" min="0" step="1" value={form.sortOrder} onChange={(event) => patch({ sortOrder: event.target.value })} /></label>
          <label className="space-y-1 text-sm sm:col-span-2">插件说明<textarea className={fieldClass} rows={2} value={form.description} onChange={(event) => patch({ description: event.target.value })} /></label>
          <label className="space-y-1 text-sm sm:col-span-2">高级配置（JSON）<textarea className={fieldClass + " font-mono"} rows={5} value={form.advancedConfig} onChange={(event) => patch({ advancedConfig: event.target.value })} spellCheck={false} /></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.isActive} onChange={(event) => patch({ isActive: event.target.checked })} />启用插件</label>
          <p className="text-xs text-[var(--muted-foreground)] sm:col-span-2">新增插件默认未启用。启用有系统用途的插件后，同用途插件按平台规则切换。</p>
        </fieldset>
        <div className="flex gap-2"><button className={buttonClass} type="submit" disabled={saving || unknownSave}>{saving ? "保存中…" : "保存插件"}</button><button className={buttonClass} type="button" disabled={saving || unknownSave} onClick={() => { setForm(null); setEditing(undefined); }}>取消编辑</button></div>
      </form>}
      {loading ? <p role="status">正在读取插件…</p> : plugins.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-sm">暂无插件，点击“添加插件”开始配置。</p> : <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{plugins.map((plugin) => <article key={plugin.id} data-plugin-id={plugin.id} className="min-w-0 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-words font-semibold">{plugin.name}</h4><span className="text-xs text-[var(--muted-foreground)]">{plugin.is_active ? "已启用" : "未启用"}</span></div>
        <p className="text-sm text-[var(--muted-foreground)]">{typeLabels[plugin.type] || plugin.type} · {roles[plugin.role]?.label || "通用插件"}</p>
        {plugin.description && <p className="break-words text-sm">{plugin.description}</p>}
        <p className="text-sm">售价 ¥{plugin.price_per_use} / {plugin.price_unit} · 成本 ¥{plugin.cost_price} · 排序 {plugin.sort_order}</p>
        <div className="flex gap-2"><button type="button" className={buttonClass} disabled={saving || unknownSave} onClick={() => open(plugin)}>编辑插件</button><button type="button" className={buttonClass} disabled={saving || unknownSave} onClick={() => void remove(plugin)}>删除插件</button></div>
      </article>)}</div>}
    </section>
  );
}
