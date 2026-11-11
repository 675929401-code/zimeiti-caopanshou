"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  PublishingCashPricingInputSchema, PublishingCashPricingPreviewSchema, PublishingCashPricingReceiptResultSchema,
  PublishingCashPricingReceiptSchema, PublishingCashPricingSaveSchema, PublishingCashPricingStateSchema,
  type PublishingCashPricingAction, type PublishingCashPricingInput, type PublishingCashPricingPreview,
  type PublishingCashPricingReceipt, type PublishingCashPricingSave, type PublishingCashPricingState,
} from "@/lib/publishing-cash-contract";
import { PUBLISHING_COMMERCIAL_PLATFORMS } from "@/lib/publishing-contract";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { safeLocalStorageGet } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import styles from "./PublishingAdminTab.module.css";

type Props = { accessEpoch?: string; onDirtyChange?: (dirty: boolean) => void };
type PriceRow = PublishingCashPricingInput["overrides"][number];
type Editor = { expectedRevision: number; defaultChargeCents: string; overrides: Array<Omit<PriceRow, "chargeCents"> & { chargeCents: string }> };
type Identity = { token: string; owner: string; storageKey: string };
const pendingSchema = z.object({ owner: z.string().min(1).max(200), request: PublishingCashPricingSaveSchema }).strict();
type Pending = z.infer<typeof pendingSchema>;
// Feature-local recovery metadata contains prices and request identity, never credentials.
const pendingPrefix = "publishing-cash-pricing:pending:";
const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;
const platformName = (key: string) => PUBLISHING_COMMERCIAL_PLATFORMS.find(item => item.key === key)?.name ?? "发布平台";
const transportName = (kind: PriceRow["transport"]) => kind === "browser_plugin" ? "浏览器插件" : "官方授权通道";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function identity(): Identity {
  const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || "";
  try {
    const encoded = token.split(".")[1];
    const payload = object(JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/"))));
    const owner = payload.userId;
    if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(owner)) throw new Error("identity");
    // This untrusted claim only separates local markers; the route authenticates every request.
    return { token, owner, storageKey: `${pendingPrefix}${owner}` };
  } catch { throw new Error("当前登录身份无法确认，请重新登录后台。"); }
}
function readPending(current: Identity): Pending | null {
  const raw = localStorage.getItem(current.storageKey);
  if (!raw) return null;
  const result = pendingSchema.safeParse(JSON.parse(raw));
  if (!result.success || result.data.owner !== current.owner) throw new Error("原价格保存标识无法核对，请保留浏览器数据并联系维护人员。");
  return result.data;
}
function clearPending(current: Identity, key: string) {
  if (readPending(current)?.request.requestKey === key) localStorage.removeItem(current.storageKey);
}
function editor(value: PublishingCashPricingState["current"]): Editor {
  return { expectedRevision: value?.revision ?? 0, defaultChargeCents: value ? String(value.defaultChargeCents) : "", overrides: value?.overrides.map(row => ({ ...row, chargeCents: String(row.chargeCents) })) ?? [] };
}
function parseEditor(value: Editor): PublishingCashPricingInput {
  const integer = (text: string) => /^\d+$/.test(text) ? Number(text) : NaN;
  const result = PublishingCashPricingInputSchema.safeParse({ ...value, defaultChargeCents: integer(value.defaultChargeCents), overrides: value.overrides.map(row => ({ ...row, chargeCents: integer(row.chargeCents) })) });
  if (!result.success) throw new Error("金额请填写正整数分；同一平台与通道只能设置一次。");
  return result.data;
}
function samePrices(left: PublishingCashPricingInput, right: { defaultChargeCents: number; overrides: PriceRow[] }) {
  const order = (rows: PriceRow[]) => [...rows].sort((a, b) => `${a.platform}:${a.transport}`.localeCompare(`${b.platform}:${b.transport}`));
  return left.defaultChargeCents === right.defaultChargeCents && JSON.stringify(order(left.overrides)) === JSON.stringify(order(right.overrides));
}
function verifyReceipt(value: unknown, request: PublishingCashPricingSave): PublishingCashPricingReceipt {
  const parsed = PublishingCashPricingReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.requestKey !== request.requestKey || parsed.data.version.revision !== request.input.expectedRevision + 1 || !samePrices(request.input, parsed.data.version)) throw new Error("原保存回执与本次内容不一致，请保留请求继续核对。");
  return parsed.data;
}
class PricingRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly unknown: boolean) { super(message); }
}
async function requestPricing(current: Identity, action?: PublishingCashPricingAction, requestKey?: string): Promise<unknown> {
  const controller = new AbortController(), timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`/api/admin/publishing/pricing${requestKey ? `?requestKey=${encodeURIComponent(requestKey)}` : ""}`, {
      method: action ? "POST" : "GET", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${current.token}`, ...(action ? { "Content-Type": "application/json" } : {}) },
      ...(action ? { body: JSON.stringify(action) } : {}),
    });
    const payload: unknown = await response.json().catch(() => null), body = object(payload);
    if (!response.ok || body.ok === false) {
      const code = typeof body.code === "string" ? body.code : "";
      const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `价格请求未完成（HTTP ${response.status}）`;
      const stepUp = body.adminStepUp === true || object(body.adminStepUp).required === true || response.status === 428;
      const unknown = body.outcome === "unknown" || response.status === 408 || response.status >= 500 && code !== "PUBLISH_CASH_SCHEMA_NOT_READY";
      throw new PricingRequestError(`${message}${stepUp ? " 请先完成后台上方的敏感配置验证，再重新预览。" : ""}`, response.status, code, unknown);
    }
    return payload;
  } finally { window.clearTimeout(timer); }
}

export default function PublishingCashPricing({ accessEpoch = "", onDirtyChange }: Props) {
  const [state, setState] = useState<PublishingCashPricingState | null>(null), [form, setForm] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<PublishingCashPricingPreview | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<"read" | "preview" | "save" | "recover" | null>(null);
  const [notice, setNotice] = useState(""), [failed, setFailed] = useState(false), [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false);
  const generation = useRef(0), sequence = useRef(0), writeLock = useRef(false), dirtyRef = useRef(false), formRef = useRef<Editor | null>(null);
  const previewButton = useRef<HTMLButtonElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const invalidate = useCallback(() => { generation.current++; sequence.current++; }, []);
  const isCurrent = (epoch: number, current: Identity) => epoch === generation.current && safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) === current.token;
  const replace = useCallback((next: Editor) => { formRef.current = next; setForm(next); dirtyRef.current = false; setDirty(false); setConflict(false); }, []);
  const load = useCallback(async (discard = false) => {
    const epoch = generation.current, order = ++sequence.current; setBusy("read"); setPreview(null);
    try {
      const current = identity(), marker = readPending(current);
      setPending(marker);
      const result = PublishingCashPricingStateSchema.parse(await requestPricing(current));
      if (!isCurrent(epoch, current) || order !== sequence.current) return;
      setState(result); setFailed(false);
      if (discard || !dirtyRef.current) replace(editor(result.current));
      else if (formRef.current?.expectedRevision !== (result.current?.revision ?? 0)) { setConflict(true); setNotice("价格已有新版本，未保存输入已保留。请核对后载入最新价格。"); }
    } catch (error) {
      if (epoch === generation.current && order === sequence.current) { setFailed(true); setNotice(error instanceof Error ? error.message : "价格读取失败。"); setState(null); }
    } finally { if (epoch === generation.current && order === sequence.current) setBusy(null); }
  }, [replace]);
  useEffect(() => {
    invalidate(); setPreview(null); setState(null); setPending(null); setNotice(""); replace({ expectedRevision: 0, defaultChargeCents: "", overrides: [] }); void load(true);
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.AUTH_TOKEN) { invalidate(); replace({ expectedRevision: 0, defaultChargeCents: "", overrides: [] }); void load(true); }
      else if (event.key.startsWith(pendingPrefix)) { invalidate(); void load(); }
    };
    window.addEventListener("storage", changed);
    return () => { invalidate(); window.removeEventListener("storage", changed); };
  }, [accessEpoch, load, replace, invalidate]);
  useEffect(() => { onDirtyChange?.(dirty || !!pending); }, [dirty, pending, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  function update(next: Editor) { formRef.current = next; setForm(next); setPreview(null); dirtyRef.current = true; setDirty(true); setNotice(""); }
  async function makePreview() {
    if (busy || pending || !form || !state?.schemaReady || !state.access.canEdit || conflict) return;
    const epoch = generation.current; setBusy("preview"); setNotice(""); setFailed(false);
    try {
      const current = identity(); if (readPending(current)) throw new Error("存在尚待核对的原价格保存，请先读取其回执。");
      const input = parseEditor(form), result = PublishingCashPricingPreviewSchema.parse(await requestPricing(current, { action: "preview", input }));
      if (!isCurrent(epoch, current)) return;
      if (result.proposed.expectedRevision !== input.expectedRevision || !samePrices(input, result.proposed) || (result.current?.revision ?? 0) !== input.expectedRevision) throw new Error("价格预览与本次输入不一致，请重新读取。");
      setPreview(result);
    } catch (error) { if (epoch === generation.current) { setFailed(true); setNotice(error instanceof Error ? error.message : "价格预览失败。"); } }
    finally { if (epoch === generation.current) setBusy(null); }
  }
  function acceptReceipt(receipt: PublishingCashPricingReceipt, current: Identity, request: PublishingCashPricingSave) {
    clearPending(current, request.requestKey); setPending(null); setPreview(null);
    setState({ schemaReady: true, current: receipt.version, access: { canEdit: true } }); replace(editor(receipt.version));
    setFailed(false); setNotice(`价格 v${receipt.version.revision} 已保存并取得原请求回执。发布执行开关保持原样。`);
  }
  async function save() {
    if (writeLock.current || busy || pending || !preview || !form || !state?.access.canEdit) return;
    const epoch = generation.current, frozen = preview; writeLock.current = true; setBusy("save"); setNotice(""); setFailed(false);
    let submitted: Pending | null = null, current: Identity | null = null;
    try {
      current = identity(); const owner = current;
      if (!navigator.locks) throw new Error("当前浏览器无法安全协调价格保存，请使用新版桌面浏览器。");
      await navigator.locks.request(`${pendingPrefix}${owner.owner}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("其他标签页正在保存价格，请稍后读取最新状态。");
        if (!isCurrent(epoch, owner)) return;
        if (readPending(owner)) throw new Error("存在尚待核对的原价格保存，请先读取原请求回执。");
        const input = parseEditor(form);
        if (input.expectedRevision !== frozen.proposed.expectedRevision || !samePrices(input, frozen.proposed)) throw new Error("输入已变化，请重新预览。");
        const request = PublishingCashPricingSaveSchema.parse({ action: "save", requestKey: `cash-price:${crypto.randomUUID()}`, input, previewHash: frozen.previewHash });
        const marker = pendingSchema.parse({ owner: owner.owner, request });
        localStorage.setItem(owner.storageKey, JSON.stringify(marker)); submitted = marker; setPending(marker);
        const receipt = verifyReceipt(await requestPricing(owner, request), request);
        if (!isCurrent(epoch, owner)) return;
        acceptReceipt(receipt, owner, request);
      });
    } catch (error) {
      const definite = error instanceof PricingRequestError && !error.unknown && error.code !== "PUBLISH_IDEMPOTENCY_CONFLICT";
      let cleared = false;
      if (submitted && current && definite) {
        try { clearPending(current, (submitted as Pending).request.requestKey); cleared = true; } catch { /* Retain the marker if local recovery metadata cannot be changed. */ }
      }
      if (epoch !== generation.current || current && !isCurrent(epoch, current)) return;
      setFailed(true); setPreview(null);
      if (cleared) setPending(null);
      setNotice(`${error instanceof Error ? error.message : "价格保存未完成。"}${submitted && !cleared ? " 本次结果尚待核对，已暂停再次保存。请核对原请求，不会自动重试。" : ""}`);
    } finally { writeLock.current = false; if (epoch === generation.current) setBusy(null); }
  }
  async function recover() {
    if (busy || !pending) return;
    const epoch = generation.current, original = pending; setBusy("recover"); setNotice("");
    try {
      const current = identity(); if (original.owner !== current.owner) throw new Error("当前身份与原保存请求不一致。");
      const result = PublishingCashPricingReceiptResultSchema.parse(await requestPricing(current, undefined, original.request.requestKey));
      if (!isCurrent(epoch, current)) return;
      if (!result.receipt) { setFailed(true); setNotice(result.schemaReady ? "尚未找到原请求的完成回执。已保留请求，当前价格相同也不代表本次保存成功；请稍后继续核对。" : "价格服务尚未就绪，原保存请求已保留，请待服务恢复后核对。"); return; }
      acceptReceipt(verifyReceipt(result.receipt, original.request), current, original.request);
    } catch (error) { if (epoch === generation.current) { setFailed(true); setNotice(error instanceof Error ? error.message : "原请求暂无法核对。"); } }
    finally { if (epoch === generation.current) setBusy(null); }
  }
  const disabled = !!busy || !!pending || !state?.schemaReady || !state.access.canEdit || conflict;
  const comparisonKeys = preview ? [...new Set([...(preview.current?.overrides ?? []), ...preview.proposed.overrides].map(row => `${row.platform}:${row.transport}`))] : [];
  return <section className={styles.panel} data-testid="publishing-cash-pricing">
    <div className={styles.sectionHeading}><div><h3>会员发布现金价格</h3><p>每个目标账号按一次执行计费。默认价适用于未单独设置的平台通道；站方采购费用另行核算。</p></div><span className={styles.badge}>{state?.current ? `价格 v${state.current.revision}` : "待读取价格"}</span></div>
    {notice && <p role={failed ? "alert" : "status"} className={styles.notice} data-error={failed}>{notice}</p>}
    {pending && <div className={styles.actions}><span>原价格保存尚待核对，当前暂停编辑与保存。</span><button type="button" data-testid="publishing-cash-recover" className={styles.button} disabled={!!busy} onClick={() => void recover()}>{busy === "recover" ? "核对中…" : "核对原保存请求"}</button></div>}
    {state && !state.schemaReady && <p className={styles.quietNotice}>现金定价结构尚未就绪。请完成本轮数据库升级后读取；本页不会显示或保存推测价格。</p>}
    {state?.schemaReady && form && <form onSubmit={event => { event.preventDefault(); void makePreview(); }}>
      <div className={styles.pricingDefault}><label className={styles.label}>默认价格（分 / 目标账号 / 一次执行）<input data-testid="publishing-cash-default-price" type="text" inputMode="numeric" value={form.defaultChargeCents} disabled={disabled} onChange={event => update({ ...form, defaultChargeCents: event.target.value })} /><small>{/^\d+$/.test(form.defaultChargeCents) && Number.isSafeInteger(Number(form.defaultChargeCents)) ? `${money(Number(form.defaultChargeCents))} / 次` : "填写正整数分，100 分 = 1 元。"}</small></label></div>
      <div className={styles.editorTitle}><h4>平台与通道单独定价</h4><button type="button" className={styles.button} data-testid="publishing-cash-override-add" disabled={disabled || form.overrides.length >= 28} onClick={() => { const candidates = PUBLISHING_COMMERCIAL_PLATFORMS.flatMap(item => (["official_api", "browser_plugin"] as const).map(transport => ({ platform: item.key, transport }))); const next = candidates.find(row => !form.overrides.some(item => item.platform === row.platform && item.transport === row.transport)); if (next) update({ ...form, overrides: [...form.overrides, { ...next, chargeCents: form.defaultChargeCents }] }); }}>添加单独价格</button></div>
      {!form.overrides.length && <p className={styles.help}>所有平台通道沿用默认价格。设置价格不会开通对应通道。</p>}
      <div className={styles.pricingRows}>{form.overrides.map((row, index) => <div className={styles.pricingRow} key={index}>
        <label className={styles.label}>平台<select aria-label={`第 ${index + 1} 项平台`} disabled={disabled} value={row.platform} onChange={event => update({ ...form, overrides: form.overrides.map((item, position) => position === index ? { ...item, platform: event.target.value as PriceRow["platform"] } : item) })}>{PUBLISHING_COMMERCIAL_PLATFORMS.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
        <label className={styles.label}>通道<select aria-label={`第 ${index + 1} 项通道`} disabled={disabled} value={row.transport} onChange={event => update({ ...form, overrides: form.overrides.map((item, position) => position === index ? { ...item, transport: event.target.value as PriceRow["transport"] } : item) })}><option value="browser_plugin">浏览器插件</option><option value="official_api">官方授权通道</option></select></label>
        <label className={styles.label}>价格（分）<input aria-label={`第 ${index + 1} 项价格（分）`} type="text" inputMode="numeric" disabled={disabled} value={row.chargeCents} onChange={event => update({ ...form, overrides: form.overrides.map((item, position) => position === index ? { ...item, chargeCents: event.target.value } : item) })} /></label>
        <button type="button" className={styles.button} disabled={disabled} onClick={() => update({ ...form, overrides: form.overrides.filter((_, position) => position !== index) })}>移除覆盖</button>
      </div>)}</div>
      <div className={styles.actions}><button ref={previewButton} type="submit" className={styles.primaryButton} data-testid="publishing-cash-preview" disabled={disabled || !dirty}>{busy === "preview" ? "预览中…" : "预览价格调整"}</button><button type="button" className={styles.button} disabled={!!busy || !!pending} onClick={() => { if (!dirty || window.confirm("放弃当前未保存价格，载入最新已保存版本？")) { setNotice(""); void load(true); } }}>载入最新价格</button><span>{conflict ? "价格版本已变化，请载入最新版本后修改。" : dirty ? "价格有未保存修改" : "保存价格不会开启发布执行或扣款。"}</span></div>
    </form>}
    {!state?.schemaReady && <div className={styles.actions}><button type="button" className={styles.button} disabled={!!busy} onClick={() => void load()}>{busy === "read" ? "读取中…" : "重新读取价格"}</button></div>}
    <Dialog open={!!preview} onOpenChange={open => { if (!open && busy !== "save") setPreview(null); }}>
      <DialogContent className={styles.pricingDialog} showCloseButton={busy !== "save"} data-testid="publishing-cash-preview-dialog" onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus(); }} onCloseAutoFocus={event => { event.preventDefault(); previewButton.current?.focus(); }} onEscapeKeyDown={event => { if (busy === "save") event.preventDefault(); }} onInteractOutside={event => { if (busy === "save") event.preventDefault(); }}>
        <DialogHeader><DialogTitle>确认发布现金价格</DialogTitle><DialogDescription>保存为新价格版本。已有收费保持原样，尚未执行的旧报价需重新确认；不会扣款或开启发布执行。</DialogDescription></DialogHeader>
        {preview && <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>适用范围</th><th>当前价格</th><th>调整后价格</th></tr></thead><tbody><tr><td>默认价格</td><td>{preview.current ? money(preview.current.defaultChargeCents) : "尚未设置"}</td><td>{money(preview.proposed.defaultChargeCents)}</td></tr>{comparisonKeys.map(key => { const before = preview.current?.overrides.find(row => `${row.platform}:${row.transport}` === key), after = preview.proposed.overrides.find(row => `${row.platform}:${row.transport}` === key), row = after ?? before!; return <tr key={key}><td>{platformName(row.platform)} · {transportName(row.transport)}</td><td>{before ? money(before.chargeCents) : preview.current ? `${money(preview.current.defaultChargeCents)}（默认）` : "尚未设置"}</td><td>{after ? money(after.chargeCents) : `${money(preview.proposed.defaultChargeCents)}（恢复默认）`}</td></tr>; })}</tbody></table></div>}
        <DialogFooter><button ref={cancelButton} type="button" data-testid="publishing-cash-cancel" className={styles.button} disabled={busy === "save"} onClick={() => setPreview(null)}>返回修改</button><button type="button" data-testid="publishing-cash-confirm" className={styles.primaryButton} disabled={!!busy || !!pending} onClick={() => void save()}>{busy === "save" ? "保存并核对中…" : "确认保存新价格"}</button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
