"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  FileWarning,
  Loader2,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminSensitiveUnlockControl,
  useAdminStepUpReady,
} from "@/components/admin/admin-sensitive-unlock-control";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-entry";
import type { AdminAccessClientState } from "@/lib/admin-governance";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeLocalStorageGet } from "@/lib/utils";

type JsonObject = Record<string, unknown>;
type TargetState = "failed_unknown" | "failed" | "succeeded";
type ExplicitBoolean = "unknown" | "true" | "false";

interface ReconciliationRecord {
  record_id: string;
  user_id: string;
  client_request_id: string;
  request_kind: string;
  payload_fingerprint: string;
  state: string;
  http_status: number | null;
  provider_task_id: string | null;
  provider_evidence: JsonObject | null;
  billing_evidence: JsonObject | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ReconciliationForm {
  targetState: TargetState;
  httpStatus: string;
  responseJson: string;
  reason: string;
  providerTaskId: string;
  providerEvidenceSource: string;
  providerStatus: string;
  terminalState: string;
  providerCallStarted: ExplicitBoolean;
  providerNotes: string;
  billingEvidenceSource: string;
  walletState: string;
  charged: ExplicitBoolean;
  refunded: ExplicitBoolean;
  creditsCharged: string;
  creditsRefunded: string;
  errorCode: string;
  errorMessage: string;
  confirmation: string;
}

const TARGET_OPTIONS: Array<{ value: TargetState; label: string; description: string }> = [
  { value: "failed_unknown", label: "仍然未知", description: "只补充证据，不产生可交付结果，也不自动重试。" },
  { value: "failed", label: "确认失败", description: "已取得明确失败证据，不应交付内容。" },
  { value: "succeeded", label: "确认成功", description: "已取得完整可回放响应和成功证据。" },
];

const EVIDENCE_SOURCES = [
  ["provider_api_readback", "供应商接口回读"],
  ["provider_console", "供应商控制台"],
  ["provider_support", "供应商人工支持"],
  ["finance_ledger", "财务账本"],
  ["internal_audit", "平台内部审计"],
] as const;

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

function compactId(value: string | null | undefined, head = 10, tail = 8) {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function explicitBoolean(value: ExplicitBoolean): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function initialForm(record: ReconciliationRecord): ReconciliationForm {
  return {
    targetState: "failed_unknown",
    httpStatus: record.http_status == null ? "" : String(record.http_status),
    responseJson: "",
    reason: "",
    providerTaskId: record.provider_task_id || "",
    providerEvidenceSource: "",
    providerStatus: "",
    terminalState: "",
    providerCallStarted: "unknown",
    providerNotes: "",
    billingEvidenceSource: "",
    walletState: "",
    charged: "unknown",
    refunded: "unknown",
    creditsCharged: "",
    creditsRefunded: "",
    errorCode: record.error_code || "",
    errorMessage: record.error_message || "",
    confirmation: "",
  };
}

function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function buildEvidence(source: string, values: JsonObject): JsonObject {
  return Object.fromEntries([
    ["evidence_source", source.trim()],
    ...Object.entries(values),
  ].filter(([, value]) => value !== "" && value !== undefined));
}

function validateForm(record: ReconciliationRecord, form: ReconciliationForm): string | null {
  if (form.reason.trim().length < 8) return "请填写至少 8 个字的对账依据。";
  if (!form.providerEvidenceSource) return "请选择供应商证据来源。";
  if (!form.billingEvidenceSource) return "请选择财务证据来源。";
  if (!form.providerStatus.trim() && !form.terminalState.trim() && !form.providerNotes.trim()) {
    return "请填写供应商状态、终态或证据说明。";
  }
  if (!form.walletState.trim()) return "请填写钱包账本状态。";
  if (form.charged === "unknown" || form.refunded === "unknown") {
    return "扣费与退款必须明确选择“是”或“否”。";
  }

  if (form.targetState !== "failed_unknown") {
    const status = Number(form.httpStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) return "确认终态必须填写有效 HTTP 状态码。";
    let response: JsonObject | null = null;
    try {
      response = jsonObject(JSON.parse(form.responseJson));
    } catch {
      return "可回放响应不是有效 JSON。";
    }
    if (!response) return "可回放响应必须是 JSON 对象。";
    if (form.targetState === "succeeded" && (status < 200 || status > 299)) {
      return "确认成功必须使用 2xx 状态码。";
    }
    if (form.targetState === "failed" && status >= 200 && status <= 299) {
      if (response.success !== false || response.upstream_completed !== true || response.charged !== false) {
        return "2xx 业务失败必须明确包含 success=false、upstream_completed=true、charged=false。";
      }
    }
  } else if (form.responseJson.trim()) {
    return "仍然未知时不得附带可交付响应。";
  }

  const expected = `确认 ${record.record_id.slice(-8)}`;
  if (form.confirmation.trim() !== expected) return `请输入“${expected}”完成最终确认。`;
  return null;
}

function StateBadge({ state }: { state: string }) {
  const running = state === "running";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold ${running ? "border-amber-200 bg-amber-50 text-amber-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
      {running ? <Clock3 className="h-3.5 w-3.5" /> : <FileWarning className="h-3.5 w-3.5" />}
      {running ? "超时运行中" : "结果未知"}
    </span>
  );
}

function SelectBoolean({ value, onChange }: { value: ExplicitBoolean; onChange: (value: ExplicitBoolean) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as ExplicitBoolean)} className="h-11 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm text-[#344054] outline-none focus:border-[#079455]">
      <option value="unknown">请选择</option>
      <option value="false">否</option>
      <option value="true">是</option>
    </select>
  );
}

export function ExtractionReconciliationPanel() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [access, setAccess] = useState<AdminAccessClientState | null>(null);
  const [authState, setAuthState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [records, setRecords] = useState<ReconciliationRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [forceUnlock, setForceUnlock] = useState(false);
  const selected = records.find((record) => record.record_id === selectedId) || null;
  const [form, setForm] = useState<ReconciliationForm | null>(null);

  const permissions = useMemo(() => new Set(access?.access.permissionKeys || []), [access]);
  const canView = permissions.has("billing.view");
  const canCommit = permissions.has("wallet.adjust");
  const unlocked = useAdminStepUpReady(access?.stepUp.status, access?.stepUp.expiresAt);

  const loadAccess = useCallback(async (currentToken: string) => {
    const response = await fetch("/api/admin/access-control/self", {
      headers: { Authorization: `Bearer ${currentToken}` },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "后台权限状态读取失败");
    const next = payload as AdminAccessClientState;
    setAccess(next);
    return next;
  }, []);

  const loadRecords = useCallback(async (currentToken = token) => {
    if (!currentToken) return;
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/extract/reconciliation?limit=100", {
        headers: { Authorization: `Bearer ${currentToken}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "未知终态记录读取失败");
      const nextRecords = Array.isArray(payload.records) ? payload.records as ReconciliationRecord[] : [];
      setRecords(nextRecords);
      setSelectedId((current) => nextRecords.some((record) => record.record_id === current)
        ? current
        : nextRecords[0]?.record_id || "");
    } catch (error) {
      setRecords([]);
      setSelectedId("");
      setMessage({ type: "error", text: error instanceof Error ? error.message : "未知终态记录读取失败" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      const currentToken = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || "";
      if (!currentToken) {
        router.replace(`${ADMIN_LOGIN_PATH}?redirect=${encodeURIComponent("/admin/extraction-reconciliation")}`);
        return;
      }
      setToken(currentToken);
      try {
        const identityResponse = await fetch("/api/auth/me", {
          headers: { Authorization: `Bearer ${currentToken}` },
          cache: "no-store",
        });
        const identityPayload = await identityResponse.json().catch(() => ({}));
        const user = identityPayload.user || identityPayload;
        if (!identityResponse.ok || user?.role !== "admin") {
          router.replace(`${ADMIN_LOGIN_PATH}?redirect=${encodeURIComponent("/admin/extraction-reconciliation")}`);
          return;
        }
        const nextAccess = await loadAccess(currentToken);
        if (!active) return;
        if (!nextAccess.access.permissionKeys.includes("billing.view")) {
          setAuthState("denied");
          return;
        }
        setAuthState("ready");
        await loadRecords(currentToken);
      } catch (error) {
        if (!active) return;
        setAuthState("error");
        setMessage({ type: "error", text: error instanceof Error ? error.message : "后台身份校验失败" });
      }
    };
    void initialize();
    return () => { active = false; };
  }, [loadAccess, loadRecords, router]);

  useEffect(() => {
    setForm(selected ? initialForm(selected) : null);
  }, [selected]);

  const submit = async () => {
    if (!selected || !form || submitting) return;
    if (!canCommit) {
      setMessage({ type: "error", text: "当前管理员没有“钱包调账”权限，只能查看。" });
      return;
    }
    if (!unlocked) {
      setForceUnlock(true);
      setMessage({ type: "info", text: "提交对账属于高风险写操作，请先完成二次验证。" });
      return;
    }
    const validationError = validateForm(selected, form);
    if (validationError) {
      setMessage({ type: "error", text: validationError });
      return;
    }

    let response: JsonObject | null = null;
    if (form.targetState !== "failed_unknown") response = JSON.parse(form.responseJson) as JsonObject;
    const providerEvidence = buildEvidence(form.providerEvidenceSource, {
      provider_status: form.providerStatus.trim(),
      terminal_state: form.terminalState.trim(),
      provider_call_started: explicitBoolean(form.providerCallStarted),
      provider_task_id: form.providerTaskId.trim(),
      notes: form.providerNotes.trim(),
      reconciled_at: new Date().toISOString(),
    });
    const billingEvidence = buildEvidence(form.billingEvidenceSource, {
      wallet_state: form.walletState.trim(),
      charged: explicitBoolean(form.charged),
      refunded: explicitBoolean(form.refunded),
      credits_charged: optionalNumber(form.creditsCharged),
      credits_refunded: optionalNumber(form.creditsRefunded),
      reconciled_at: new Date().toISOString(),
    });

    setSubmitting(true);
    setMessage(null);
    try {
      const result = await fetch("/api/extract/reconciliation", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          record_id: selected.record_id,
          expected_updated_at: selected.updated_at,
          target_state: form.targetState,
          http_status: form.httpStatus.trim() ? Number(form.httpStatus) : null,
          response,
          provider_task_id: form.providerTaskId.trim() || null,
          provider_evidence: providerEvidence,
          billing_evidence: billingEvidence,
          error_code: form.errorCode.trim() || null,
          error_message: form.errorMessage.trim() || null,
          reason: form.reason.trim(),
        }),
      });
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) throw new Error(payload.error || "对账提交失败");
      await loadRecords(token);
      setMessage({ type: "success", text: "对账证据已原子写入并生成审计记录；平台没有重试上游任务。" });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "对账提交失败" });
    } finally {
      setSubmitting(false);
    }
  };

  if (authState === "loading") {
    return <div className="admin-light-shell grid min-h-screen place-items-center bg-[#f5f7fa] text-[#475467]" data-admin-theme="soft-white" data-theme="soft-white" data-mode="light"><span className="inline-flex items-center gap-2 text-sm font-bold"><Loader2 className="h-4 w-4 animate-spin" />正在核验后台身份与权限…</span></div>;
  }

  if (authState === "denied" || (authState === "ready" && !canView)) {
    return <div className="admin-light-shell grid min-h-screen place-items-center bg-[#f5f7fa] p-8" data-admin-theme="soft-white" data-theme="soft-white" data-mode="light"><div className="w-full max-w-xl rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-sm"><AlertTriangle className="mx-auto h-10 w-10 text-amber-600" /><h1 className="mt-4 text-xl font-black text-[#172033]">无权查看提取对账</h1><p className="mt-2 text-sm leading-6 text-[#667085]">该页面包含供应商终态和账本证据，需要“查看资金与账单”权限。</p><Link href="/admin" className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl bg-[#079455] px-4 text-sm font-bold text-white"><ArrowLeft className="h-4 w-4" />返回管理后台</Link></div></div>;
  }

  return (
    <div className="admin-light-shell min-h-screen bg-[#f5f7fa] text-[#172033]" data-admin-theme="soft-white" data-theme="soft-white" data-mode="light">
      <header className="border-b border-[#e4e7ec] bg-white px-6 py-4">
        <div className="mx-auto flex w-full max-w-[1760px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/admin" aria-label="返回管理后台" className="grid h-10 w-10 place-items-center rounded-xl border border-[#d0d5dd] text-[#475467] hover:bg-[#f9fafb]"><ArrowLeft className="h-4 w-4" /></Link>
            <div><p className="text-xs font-bold text-[#067647]">资金与对账</p><h1 className="text-xl font-black">提取任务人工对账</h1></div>
          </div>
          <div className="flex items-center gap-2">
            {token && access && canCommit && <AdminSensitiveUnlockControl token={token} state={access} onChanged={async () => { await loadAccess(token); }} forceOpen={forceUnlock} onForceOpenHandled={() => setForceUnlock(false)} />}
            <button type="button" onClick={() => void loadRecords()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d0d5dd] bg-white px-4 text-sm font-bold text-[#344054] disabled:opacity-50"><RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新</button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1760px] space-y-5 p-6">
        <section className="grid grid-cols-[minmax(0,1fr)_repeat(3,minmax(150px,220px))] gap-4">
          <div className="rounded-2xl border border-[#b7e4d2] bg-[#ecfdf3] p-5">
            <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#079455]" /><div><h2 className="font-black text-[#065f46]">证据优先，禁止猜测终态</h2><p className="mt-1 text-sm leading-6 text-[#067647]">本页不会联系供应商、重试提取、自动退款或改写钱包。提交必须同时具备供应商和财务证据，并写入不可变审计。</p></div></div>
          </div>
          <div className="rounded-2xl border border-[#e4e7ec] bg-white p-5"><p className="text-xs font-bold text-[#667085]">待人工核对</p><strong className="mt-2 block text-3xl font-black">{records.length}</strong></div>
          <div className="rounded-2xl border border-[#e4e7ec] bg-white p-5"><p className="text-xs font-bold text-[#667085]">结果未知</p><strong className="mt-2 block text-3xl font-black text-rose-600">{records.filter((record) => record.state === "failed_unknown").length}</strong></div>
          <div className="rounded-2xl border border-[#e4e7ec] bg-white p-5"><p className="text-xs font-bold text-[#667085]">超时运行</p><strong className="mt-2 block text-3xl font-black text-amber-600">{records.filter((record) => record.state === "running").length}</strong></div>
        </section>

        {message && <div role="status" className={`rounded-2xl border p-4 text-sm font-semibold ${message.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : message.type === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sky-200 bg-sky-50 text-sky-800"}`}>{message.text}</div>}

        <section className="grid min-h-[660px] grid-cols-[390px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-[#e4e7ec] bg-white shadow-sm">
          <aside className="border-r border-[#e4e7ec] bg-[#fcfcfd]">
            <div className="border-b border-[#e4e7ec] px-5 py-4"><h2 className="font-black">异常任务</h2><p className="mt-1 text-xs text-[#667085]">按最早更新时间排序</p></div>
            <div className="max-h-[760px] overflow-y-auto p-3">
              {loading && records.length === 0 ? <div className="grid place-items-center py-16 text-sm text-[#667085]"><Loader2 className="mb-3 h-5 w-5 animate-spin" />正在读取真实记录…</div> : records.length === 0 ? <div className="px-4 py-16 text-center"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-600" /><h3 className="mt-3 font-black">没有待对账记录</h3><p className="mt-1 text-xs leading-5 text-[#667085]">没有使用空数据冒充成功；当前接口真实返回 0 条。</p></div> : records.map((record) => (
                <button key={record.record_id} type="button" onClick={() => setSelectedId(record.record_id)} className={`mb-2 w-full rounded-xl border p-4 text-left transition-colors ${selectedId === record.record_id ? "border-[#079455] bg-[#ecfdf3]" : "border-[#e4e7ec] bg-white hover:border-[#b7e4d2]"}`}>
                  <div className="flex items-center justify-between gap-2"><StateBadge state={record.state} /><span className="text-[11px] text-[#667085]">{record.request_kind || "unknown"}</span></div>
                  <strong className="mt-3 block font-mono text-xs text-[#344054]" title={record.client_request_id}>{compactId(record.client_request_id)}</strong>
                  <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#667085]">{record.error_message || record.error_code || "暂无错误摘要"}</p>
                  <p className="mt-3 text-[11px] text-[#98a2b3]">更新于 {formatDate(record.updated_at)}</p>
                </button>
              ))}
            </div>
          </aside>

          <div className="min-w-0 bg-white">
            {!selected || !form ? <div className="grid h-full place-items-center p-10 text-center text-[#667085]"><div><FileWarning className="mx-auto h-10 w-10" /><p className="mt-3 text-sm font-bold">选择一条记录查看证据与处置表单</p></div></div> : (
              <div className="space-y-6 p-6">
                <div className="flex items-start justify-between gap-4 border-b border-[#e4e7ec] pb-5">
                  <div><div className="flex items-center gap-2"><StateBadge state={selected.state} /><span className="rounded-full bg-[#f2f4f7] px-2.5 py-1 text-xs font-bold text-[#475467]">{selected.request_kind}</span></div><h2 className="mt-3 text-lg font-black">记录 {compactId(selected.record_id, 14, 10)}</h2><p className="mt-1 text-xs text-[#667085]">只允许基于外部证据确认，不会从本页发起供应商查询。</p></div>
                  <div className="text-right text-xs leading-5 text-[#667085]"><p>创建：{formatDate(selected.created_at)}</p><p>更新：{formatDate(selected.updated_at)}</p></div>
                </div>

                <section className="grid grid-cols-2 gap-3 rounded-2xl border border-[#e4e7ec] bg-[#f9fafb] p-4 text-xs">
                  <div><span className="font-bold text-[#667085]">用户 ID</span><code className="mt-1 block break-all text-[#344054]">{selected.user_id}</code></div>
                  <div><span className="font-bold text-[#667085]">上游任务 ID</span><code className="mt-1 block break-all text-[#344054]">{selected.provider_task_id || "未记录"}</code></div>
                  <div><span className="font-bold text-[#667085]">HTTP 状态</span><p className="mt-1 text-[#344054]">{selected.http_status ?? "未知"}</p></div>
                  <div><span className="font-bold text-[#667085]">错误代码</span><p className="mt-1 text-[#344054]">{selected.error_code || "未记录"}</p></div>
                  <div className="col-span-2"><span className="font-bold text-[#667085]">错误摘要</span><p className="mt-1 break-words leading-5 text-[#344054]">{selected.error_message || "未记录"}</p></div>
                </section>

                <fieldset className="space-y-3"><legend className="text-sm font-black">1. 选择处置结果</legend><div className="grid grid-cols-3 gap-3">{TARGET_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => setForm((current) => current ? { ...current, targetState: option.value, responseJson: option.value === "failed_unknown" ? "" : current.responseJson } : current)} className={`rounded-xl border p-4 text-left ${form.targetState === option.value ? "border-[#079455] bg-[#ecfdf3]" : "border-[#d0d5dd] bg-white"}`}><strong className="text-sm">{option.label}</strong><span className="mt-1 block text-xs leading-5 text-[#667085]">{option.description}</span></button>)}</div></fieldset>

                <section className="grid grid-cols-2 gap-4">
                  <div className="space-y-4 rounded-2xl border border-[#d0d5dd] p-5"><div><h3 className="font-black">2. 供应商证据</h3><p className="mt-1 text-xs text-[#667085]">记录从哪里得到、上游处于什么状态。</p></div>
                    <label className="block text-xs font-bold text-[#344054]">证据来源<select value={form.providerEvidenceSource} onChange={(event) => setForm({ ...form, providerEvidenceSource: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm font-normal"><option value="">请选择</option>{EVIDENCE_SOURCES.slice(0, 3).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <div className="grid grid-cols-2 gap-3"><label className="text-xs font-bold text-[#344054]">供应商状态<input value={form.providerStatus} onChange={(event) => setForm({ ...form, providerStatus: event.target.value })} placeholder="如 completed / failed" className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label><label className="text-xs font-bold text-[#344054]">确认终态<input value={form.terminalState} onChange={(event) => setForm({ ...form, terminalState: event.target.value })} placeholder="如 success / failure" className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label></div>
                    <label className="block text-xs font-bold text-[#344054]">上游任务 ID<input value={form.providerTaskId} onChange={(event) => setForm({ ...form, providerTaskId: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 font-mono text-xs font-normal" /></label>
                    <label className="block text-xs font-bold text-[#344054]">是否已发起供应商调用<SelectBoolean value={form.providerCallStarted} onChange={(value) => setForm({ ...form, providerCallStarted: value })} /></label>
                    <label className="block text-xs font-bold text-[#344054]">证据说明<textarea value={form.providerNotes} onChange={(event) => setForm({ ...form, providerNotes: event.target.value })} rows={3} placeholder="填写控制台截图、工单或接口回读的关键结论，不粘贴密钥和签名链接。" className="mt-2 w-full rounded-xl border border-[#d0d5dd] p-3 text-sm font-normal leading-6" /></label>
                  </div>

                  <div className="space-y-4 rounded-2xl border border-[#d0d5dd] p-5"><div><h3 className="font-black">3. 财务证据</h3><p className="mt-1 text-xs text-[#667085]">必须明确钱包是否扣款、是否退款。</p></div>
                    <label className="block text-xs font-bold text-[#344054]">证据来源<select value={form.billingEvidenceSource} onChange={(event) => setForm({ ...form, billingEvidenceSource: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm font-normal"><option value="">请选择</option>{EVIDENCE_SOURCES.slice(3).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <label className="block text-xs font-bold text-[#344054]">钱包账本状态<input value={form.walletState} onChange={(event) => setForm({ ...form, walletState: event.target.value })} placeholder="如 no_charge / settled / refunded" className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label>
                    <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-bold text-[#344054]">是否扣费<SelectBoolean value={form.charged} onChange={(value) => setForm({ ...form, charged: value })} /></label><label className="block text-xs font-bold text-[#344054]">是否退款<SelectBoolean value={form.refunded} onChange={(value) => setForm({ ...form, refunded: value })} /></label></div>
                    <div className="grid grid-cols-2 gap-3"><label className="text-xs font-bold text-[#344054]">实际扣除积分<input type="number" min="0" step="0.01" value={form.creditsCharged} onChange={(event) => setForm({ ...form, creditsCharged: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label><label className="text-xs font-bold text-[#344054]">实际退回积分<input type="number" min="0" step="0.01" value={form.creditsRefunded} onChange={(event) => setForm({ ...form, creditsRefunded: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label></div>
                  </div>
                </section>

                <section className="space-y-4 rounded-2xl border border-[#d0d5dd] p-5"><div><h3 className="font-black">4. 终态与审计说明</h3><p className="mt-1 text-xs text-[#667085]">确认成功或失败必须附带可回放 JSON；继续未知时禁止附带响应。</p></div>
                  <div className="grid grid-cols-3 gap-3"><label className="text-xs font-bold text-[#344054]">HTTP 状态<input type="number" min="100" max="599" disabled={form.targetState === "failed_unknown"} value={form.httpStatus} onChange={(event) => setForm({ ...form, httpStatus: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal disabled:bg-[#f2f4f7]" /></label><label className="text-xs font-bold text-[#344054]">错误代码<input value={form.errorCode} onChange={(event) => setForm({ ...form, errorCode: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label><label className="text-xs font-bold text-[#344054]">错误摘要<input value={form.errorMessage} onChange={(event) => setForm({ ...form, errorMessage: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm font-normal" /></label></div>
                  <label className="block text-xs font-bold text-[#344054]">可回放响应 JSON<textarea value={form.responseJson} disabled={form.targetState === "failed_unknown"} onChange={(event) => setForm({ ...form, responseJson: event.target.value })} rows={5} placeholder={form.targetState === "failed_unknown" ? "未知终态禁止填写" : "粘贴已核验的完整响应 JSON，不要填写猜测内容。"} className="mt-2 w-full rounded-xl border border-[#d0d5dd] p-3 font-mono text-xs font-normal leading-5 disabled:bg-[#f2f4f7]" /></label>
                  <label className="block text-xs font-bold text-[#344054]">对账理由<textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} rows={3} maxLength={500} placeholder="至少 8 个字，说明为什么这些证据足以支持该终态。" className="mt-2 w-full rounded-xl border border-[#d0d5dd] p-3 text-sm font-normal leading-6" /></label>
                </section>

                <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div className="min-w-0 flex-1"><h3 className="font-black text-amber-900">5. 最终确认</h3><p className="mt-1 text-sm leading-6 text-amber-800">该操作不会联系供应商，但会改变任务终态并写入永久审计。请输入 <strong>确认 {selected.record_id.slice(-8)}</strong>。</p><div className="mt-4 flex items-center gap-3"><input value={form.confirmation} onChange={(event) => setForm({ ...form, confirmation: event.target.value })} className="h-11 min-w-0 flex-1 rounded-xl border border-amber-300 bg-white px-3 font-mono text-sm outline-none focus:border-amber-600" /><button type="button" onClick={() => void submit()} disabled={submitting || !canCommit} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#b54708] px-5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}{submitting ? "原子提交中…" : canCommit ? "提交并写入审计" : "仅可查看"}</button></div>{!canCommit && <p className="mt-2 text-xs font-bold text-amber-900">当前账号缺少“钱包调账”权限，因此不能提交。</p>}</div></div></section>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
