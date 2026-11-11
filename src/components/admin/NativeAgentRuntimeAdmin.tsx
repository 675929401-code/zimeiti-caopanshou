"use client";

import { useCallback, useEffect, useState } from "react";
import { NativeAgentRuntimeConfigSchema, NATIVE_AGENT_RUNTIME_ROLES, type NativeAgentRuntimeAdminState,
  type NativeAgentRuntimeConfig, type NativeAgentRuntimeRole } from "@/lib/native-agent-runtime-contract";

const endpoint = "/api/admin/native-agent-runtime";
const panel = "rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5";
const input = "w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-60";
const button = "rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium disabled:opacity-50";
const roleLabels: Record<NativeAgentRuntimeRole, string> = { default: "应用默认模型", background: "后台角色模型（仅保存，暂未启用）", think: "深度思考角色模型（仅保存，暂未启用）" };
class RequestError extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message); } }
async function request(token: string, body?: unknown, signal?: AbortSignal): Promise<NativeAgentRuntimeAdminState> {
  const response = await fetch(endpoint, { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", signal,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(typeof value.error === "string" ? value.error : "运行配置请求失败", response.status, String(value.code ?? ""));
  if (value.ok !== true || !NativeAgentRuntimeConfigSchema.safeParse(value.config).success || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.choices) || typeof value.readiness?.ready !== "boolean") throw new RequestError("配置响应不完整，请重新读取", 503, "NATIVE_AGENT_RUNTIME_RESPONSE_INVALID");
  return value as NativeAgentRuntimeAdminState;
}

export function NativeAgentRuntimeAdmin({ token, permissionKeys, stepUpReady, onDirtyChange }: { token: string; permissionKeys: readonly string[]; stepUpReady?: boolean; onDirtyChange?: (dirty: boolean) => void }) {
  const [state, setState] = useState<NativeAgentRuntimeAdminState | null>(null);
  const [draft, setDraft] = useState<NativeAgentRuntimeConfig | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [conflict, setConflict] = useState(false);
  const canView = permissionKeys.includes("models.view"), canManage = permissionKeys.includes("models.manage");
  const dirty = Boolean(state && draft && JSON.stringify(state.config) !== JSON.stringify(draft));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!canView) { setLoading(false); return; }
    setLoading(true); setError(""); setNotice("");
    try {
      const current = await request(token, undefined, signal);
      if (signal?.aborted) return;
      setState(current); setDraft(current.config); setConflict(false);
    } catch (caught) { if (!signal?.aborted) setError(caught instanceof Error ? caught.message : "读取失败"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [token, canView]);
  useEffect(() => {
    setState(null); setDraft(null); setConflict(false);
    const abort = new AbortController(); void load(abort.signal); return () => abort.abort();
  }, [load]);

  function update<K extends keyof NativeAgentRuntimeConfig>(key: K, value: NativeAgentRuntimeConfig[K]) {
    setDraft(current => current ? { ...current, [key]: value } : current); setNotice("");
  }
  function selectRole(role: NativeAgentRuntimeRole, id: string) {
    if (!draft) return;
    if (id && !draft.allowedModelIds.includes(id) && draft.allowedModelIds.length >= 16) { setError("允许列表最多 16 项，请先移除其他模型"); return; }
    setDraft({ ...draft, modelIds: { ...draft.modelIds, [role]: id || null }, allowedModelIds: id && !draft.allowedModelIds.includes(id) ? [...draft.allowedModelIds, id] : draft.allowedModelIds });
    setError(""); setNotice("");
  }
  function toggleAllowed(id: string, checked: boolean) {
    if (!draft) return;
    if (checked && draft.allowedModelIds.length >= 16) { setError("允许列表最多 16 项"); return; }
    update("allowedModelIds", checked ? [...draft.allowedModelIds, id] : draft.allowedModelIds.filter(item => item !== id)); setError("");
  }
  async function save() {
    if (!draft || !state || saving || !canManage || conflict) return;
    const parsed = NativeAgentRuntimeConfigSchema.safeParse(draft);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join("；")); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      const saved = await request(token, { expectedRevision: state.revision, config: parsed.data });
      const readback = await request(token);
      if (readback.revision !== saved.revision || readback.configHash !== saved.configHash) throw new RequestError("保存后版本已变化，请重新读取并合并改动", 409, "NATIVE_AGENT_RUNTIME_READBACK_CONFLICT");
      setState(readback); setDraft(readback.config); setConflict(false);
      setNotice(`配置版本 ${readback.revision} 已保存并读回。${readback.config.enabled ? "默认角色将由执行时按此配置继续核验；后台和深度思考角色仍未启用。" : "当前为禁用候选，不会启动 Agent。"}`);
    } catch (caught) {
      if (caught instanceof RequestError && caught.status === 409) setConflict(true);
      setError(caught instanceof Error ? caught.message : "保存未获确认，请先重新读取");
    } finally { setSaving(false); }
  }

  if (!canView) return <section className={panel}>当前管理员没有模型查看权限。</section>;
  return <section data-testid="native-agent-runtime-admin" className="space-y-5 text-[var(--foreground)]">
    <div className={panel}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-lg font-semibold">原生智能体运行配置</h2>
          <p className="mt-2 max-w-4xl text-sm leading-6 text-[var(--muted-foreground)]">统一设置此应用的默认模型、模型允许列表和每轮预算。会员直接提交业务内容。模型资源复用主站资源池；首批仅接入 Anthropic Messages 原协议。</p></div>
        <button type="button" className={button} disabled={loading || saving} onClick={() => void load()}>{dirty ? "放弃本地改动并重新读取" : "重新读取"}</button>
      </div>
      {loading && <p role="status" className="mt-4 text-sm">正在读取实际保存配置与模型资源池…</p>}
      {error && <div role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {notice && <p role="status" className="mt-4 text-sm text-emerald-700">{notice}</p>}
      {conflict && <p className="mt-3 text-sm text-amber-700">本地改动已保留。请记录需要保留的内容，再点击“放弃本地改动并重新读取”，核对新版本后重新编辑。当前禁止覆盖保存。</p>}
      {state && <div className="mt-4 space-y-2 text-sm">
        <p>存储状态：{state.configured ? `已保存 · 版本 ${state.revision}` : "尚未配置"} · {dirty ? "有未保存改动" : "与读回版本一致"}</p>
        <p className="leading-6">运行配置：{state.readiness.message}</p>
        {state.updatedAt && <p className="text-xs text-[var(--muted-foreground)]">最后保存时间：{new Date(state.updatedAt).toLocaleString("zh-CN")}</p>}
      </div>}
    </div>
    {state && draft && <>
      <fieldset disabled={!canManage || loading || saving} className={`${panel} space-y-5`}>
        <legend className="sr-only">模型与运行开关</legend>
        <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={draft.enabled} onChange={event => update("enabled", event.target.checked)} />允许默认角色运行</label>
        <p className="text-sm leading-6 text-[var(--muted-foreground)]">禁用时可先保存不完整候选。启用时，三项角色模型及允许列表须通过配置校验。后台和深度思考角色当前仅保留配置，执行链尚未使用这两项。</p>
        <div className="grid grid-cols-3 gap-4">{NATIVE_AGENT_RUNTIME_ROLES.map(role => <label key={role} className="space-y-2 text-sm">
          <span className="block font-medium">{roleLabels[role]}</span>
          <select className={input} value={draft.modelIds[role] ?? ""} onChange={event => selectRole(role, event.target.value)}>
            <option value="">尚未选择</option>
            {draft.modelIds[role] && !state.choices.some(choice => choice.id === draft.modelIds[role]) && <option value={draft.modelIds[role]!}>原配置模型（已不在资源池）</option>}
            {state.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.displayName}{choice.available ? "" : " · 当前不可运行"}</option>)}
          </select>
        </label>)}</div>
        <div><h3 className="text-sm font-semibold">模型允许列表（{draft.allowedModelIds.length}/16）</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">选择角色模型会自动加入列表；删除列表项不会改写角色选择。不可运行的资源仍保留显示，禁用候选可先保存，启用时会阻止提交。</p>
          <div className="mt-3 grid grid-cols-2 gap-3">{state.choices.map(choice => <label key={choice.id} className="flex items-start gap-3 rounded-xl border border-[var(--border)] p-3 text-sm">
            <input type="checkbox" className="mt-1" checked={draft.allowedModelIds.includes(choice.id)} onChange={event => toggleAllowed(choice.id, event.target.checked)} />
            <span className="min-w-0"><span className="block font-medium">{choice.displayName}</span><span className={`mt-1 block text-xs leading-5 ${choice.available ? "text-emerald-700" : "text-amber-700"}`}>{choice.available ? "配置兼容 · 执行时继续校验准入" : choice.reasons.join("；")}</span></span>
          </label>)}</div>
          {state.choices.length === 0 && <p className="mt-3 text-sm text-amber-700">主站模型资源池为空，当前无法启用运行。</p>}
          {draft.allowedModelIds.filter(id => !state.choices.some(choice => choice.id === id)).map(id => <div key={id} className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-300 p-3 text-sm"><span>允许列表中有已离开资源池的模型</span><button type="button" className={button} onClick={() => toggleAllowed(id, false)}>移除失效项</button></div>)}
        </div>
      </fieldset>
      <fieldset disabled={!canManage || loading || saving} className={`${panel} space-y-4`}>
        <legend className="sr-only">任务预算</legend><h3 className="font-semibold">每轮任务预算</h3>
        <div className="grid grid-cols-4 gap-4">
          <label className="space-y-2 text-sm"><span className="block">最大模型调用数（1–24）</span><input className={input} type="number" min={1} max={24} step={1} value={draft.maxCallsPerTurn} onChange={event => update("maxCallsPerTurn", Number(event.target.value))} /></label>
          <label className="space-y-2 text-sm"><span className="block">单次最大输出 Token</span><input className={input} type="number" min={512} max={8192} step={1} value={draft.maxOutputTokens} onChange={event => update("maxOutputTokens", Number(event.target.value))} /></label>
          <label className="space-y-2 text-sm"><span className="block">单次输入上限（字节）</span><input className={input} type="number" min={16384} max={1048576} step={1} value={draft.maxInputBytes} onChange={event => update("maxInputBytes", Number(event.target.value))} /></label>
          <label className="space-y-2 text-sm"><span className="block">每轮最大现金积分</span><input className={input} type="text" inputMode="decimal" value={draft.maxCreditsPerTurn} onChange={event => update("maxCreditsPerTurn", event.target.value)} /></label>
        </div><p className="text-xs leading-5 text-[var(--muted-foreground)]">积分支持最多 6 位小数；实际费用沿用主站模型计价与账务。预算是任务执行上限，保存配置不会发起模型调用或扣费。</p>
      </fieldset>
      <div className={`${panel} flex flex-wrap items-center justify-between gap-4`}>
        <p className="text-sm text-[var(--muted-foreground)]">{!canManage ? "当前只有查看权限。" : stepUpReady === false ? "请先在主站管理页完成敏感操作二次验证。" : "保存需要模型管理权限和主站敏感操作二次验证；成功后读取保存版本。"}</p>
        <button type="button" className="rounded-xl bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50" disabled={!canManage || stepUpReady === false || loading || saving || conflict || !dirty && state.configured} onClick={() => void save()}>{saving ? "正在保存并读回…" : draft.enabled ? "保存运行配置" : "保存禁用候选"}</button>
      </div>
    </>}
  </section>;
}
