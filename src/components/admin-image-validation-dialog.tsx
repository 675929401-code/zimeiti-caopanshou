"use client";

import { readAdminValidationReferences, restoreAdminValidationReferenceInputs, resolveAdminValidationReference, sameAdminValidationReferenceScope, writeAdminValidationReference, type AdminValidationReferencePending } from "@/lib/admin-image-validation-reference";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  adoptImageValidationAttempt, canCorrectNotSubmittedImageValidation, buildImageValidationPublishRequest, fetchImageValidationAsset,fetchImageValidationRecord,
  imageValidationInputsForDto, imageValidationIsTerminal, imageValidationSafeError,
  readImageValidationAttempt, recoverImageValidation, sameImageValidationProof, saveImageValidationAttempt,
  submitImageValidation, updateImageValidationReceipt,
  type ImageValidationAttempt, type ImageValidationDto, type ImageValidationInputs,
} from "./admin-image-validation-state";

type Props = { modelId: string; modelName: string; token: string; onClose: () => void; onPublished: () => void };
const phases: Record<ImageValidationAttempt["status"], string> = {
  not_submitted: "缺少必填参考图，本次未提交生成", submitting: "正在提交", processing: "正在生成", finalizing: "图片已生成，正在确认保存", unknown: "等待确认原任务",
  rejected: "本次请求已被明确拒绝", completed: "验证图片已完成", published: "已启用此配置",
};
const fieldClass = "w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm";
const buttonClass = "rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50";
const primaryClass = "rounded-lg bg-[var(--primary)] px-4 py-2 text-sm text-white disabled:opacity-50";

/** A changed token immediately unmounts private state before checking the new current account. */
export default function AdminImageValidationDialog(props: Props) {
  const [identity, setIdentity] = useState<{ userId: string; token: string } | null>(null);
  const [failure, setFailure] = useState<{ token: string; error: string } | null>(null);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void fetch("/api/auth/me", { headers: { Authorization: `Bearer ${props.token}` }, cache: "no-store", redirect: "error", signal: controller.signal })
      .then(async response => { const data = await response.json();
        if (!response.ok || data.user?.role !== "admin" || !data.user?.id) throw new Error("请使用当前有效管理员账号登录");
        if (active) { setIdentity({ userId: String(data.user.id), token: props.token }); setFailure(null); }
      }).catch(() => { if (active) setFailure({ token: props.token, error: "请使用当前有效管理员账号登录" }); });
    return () => { active = false; controller.abort(); };
  }, [props.token]);
  const current = identity?.token === props.token ? identity : null;
  if (current) return <ImageValidationContent key={`${current.userId}:${props.modelId}`} {...props} userId={current.userId} />;
  return <ImageValidationFrame title={props.modelName} onClose={props.onClose}><p role={failure?.token === props.token ? "alert" : "status"}>{failure?.token === props.token ? failure.error : "正在确认管理员身份…"}</p></ImageValidationFrame>;
}

function ImageValidationFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null), close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const all = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="file"]),textarea:not(:disabled),select:not(:disabled),a[href]') || []);
      const first = all[0], last = all[all.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, []);
  return <div className="admin-image-validation fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
    <div ref={dialog} role="dialog" data-testid="admin-image-validation-dialog" aria-modal="true" aria-labelledby="image-validation-title" tabIndex={-1}
      style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] p-5 text-[var(--foreground)] shadow-xl">
      <div className="mb-4 flex items-start justify-between gap-4"><div><h2 id="image-validation-title" className="text-lg font-bold">生图模型真实验证</h2><p className="mt-1 break-words text-sm font-medium">{title}</p></div>
        <button type="button" onClick={onClose} className={buttonClass} aria-label="关闭生图验证">关闭</button></div>
      {children}
    </div>
  </div>;
}

function ImageValidationContent({ modelId, modelName, token, userId, onClose, onPublished }: Props & { userId: string }) {
  const [dto, setDto] = useState<ImageValidationDto | null>(null), [attempt, setAttempt] = useState<ImageValidationAttempt | null>(null);
  const [inputs, setInputs] = useState<ImageValidationInputs | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(true), [uploading, setUploading] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [preparedCorrection, setPreparedCorrection] = useState(false);
  const [referenceUploads, setReferenceUploads] = useState<AdminValidationReferencePending[]>([]);
  const referenceUploadsRef = useRef<AdminValidationReferencePending[]>([]);
  const referenceUploadLock = useRef(false);
  const referenceOwnerRef = useRef("");
  useLayoutEffect(() => {
    referenceOwnerRef.current = JSON.stringify([userId, token, modelId, dto?.configurationHash || ""]);
    return () => { referenceOwnerRef.current = ""; };
  }, [userId, token, modelId, dto?.configurationHash]);
  const [reason, setReason] = useState(""), [preparedReason, setPreparedReason] = useState("");
  const [preview, setPreview] = useState<{ url: string; blob: Blob; extension: string } | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const mounted = useRef(true), lock = useRef(false), previewRef = useRef("");
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const getDto = useCallback(async (retestReason = "") => {
    const query = new URLSearchParams({ modelId }); if (retestReason) query.set("retestReason", retestReason);
    const response = await fetch(`/api/admin/cover-models/validation?${query}`, { headers: headers(), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.modelId !== modelId) throw new Error(imageValidationSafeError(data.error, "当前模型验证配置暂不可读取"));
    return data as ImageValidationDto;
  }, [headers, modelId]);
  const store = useCallback((next: ImageValidationAttempt) => {
    saveImageValidationAttempt(localStorage, next); if (mounted.current) setAttempt(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const original = readImageValidationAttempt(localStorage, userId, modelId);
        const saved = original?.status === "submitting" ? { ...original, status: "unknown" as const, error: "原验证仍在确认，请检查原任务" } : original;
        if (saved && mounted.current) setAttempt(saved);
        const data = await getDto();
        const restored = adoptImageValidationAttempt(data, userId, saved);
        if (!mounted.current) return;
        const references = readAdminValidationReferences(localStorage, userId); referenceUploadsRef.current = references; setReferenceUploads(references);
        setDto(data); setInputs(restoreAdminValidationReferenceInputs(data, imageValidationInputsForDto(data), references, userId));
        if (restored) store(restored);
      } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
      finally { if (mounted.current) setBusy(false); }
    })();
    return () => { mounted.current = false; if (previewRef.current) URL.revokeObjectURL(previewRef.current); };
  }, [getDto, modelId, store, userId]);

  const checkOriginal = useCallback(async (original = attempt) => {
    if (!original || original.status === "not_submitted" || lock.current) return;
    lock.current = true;
    try {
      const params = new URLSearchParams({ clientIdempotencyKey: original.proof.clientIdempotencyKey, clientTraceId: original.proof.clientTraceId });
      const response = await fetch(`/api/image/status?${params}`, { headers: headers(), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
      const data = await response.json(); let next = updateImageValidationReceipt(original, data, response.ok);
      // Status remains readable with the original key even if the model has since changed.
      try { const current = await getDto(); const adopted = adoptImageValidationAttempt(current, userId, next);
        if (adopted) next = adopted; if (mounted.current) setDto(current);
      } catch { /* Retain the original key and status when current configuration is unavailable. */ }
      store(next);
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { lock.current = false; }
  }, [attempt, getDto, headers, store, userId]);
  useEffect(() => {
    if (!attempt || attempt.status === "not_submitted" || attempt.status === "submitting" || (imageValidationIsTerminal(attempt) && attempt.imageRecordId)) return;
    const timer = setTimeout(() => void checkOriginal(), 5000); return () => clearTimeout(timer);
  }, [attempt, checkOriginal]);

  const completedAssetId = attempt && ["completed", "published"].includes(attempt.status) ? attempt.assetId : "";
  const completedProviderRecord=attempt && ["completed","published"].includes(attempt.status) && attempt.deliveryReceipt?.deliveryMode==="provider_url" ? attempt.imageRecordId : "";
  useEffect(() => {
    let active = true;
    if(attempt?.deliveryReceipt?.deliveryMode==="inline_ephemeral" && !completedAssetId)return;
    setPreview(null); setDimensions(null);
    if (previewRef.current) { URL.revokeObjectURL(previewRef.current); previewRef.current = ""; }
    if (!completedAssetId && !completedProviderRecord) return;
    void (completedAssetId?fetchImageValidationAsset(completedAssetId,token):fetchImageValidationRecord(completedProviderRecord,token)).then(result => {
      if (!active || !mounted.current) return;
      const url = URL.createObjectURL(result.blob); previewRef.current = url; setPreview({ ...result, url });
    }).catch(cause => { if (active && mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "", "验证图片暂不可读取")); });
    return () => { active = false; };
  }, [completedAssetId,completedProviderRecord, token]);

  const acceptCurrentDelivery = (delivery: import("@/lib/generated-image-client-delivery").GeneratedImageClientDelivery) => {
    if(!mounted.current || !delivery.url){delivery.revoke();return;}
    if(!delivery.blob && delivery.kind==="provider_url"){
      delivery.revoke();return; // The owned-record effect performs the bounded authenticated read.
    }
    if(!delivery.blob){delivery.revoke();return;}
    if(previewRef.current)URL.revokeObjectURL(previewRef.current);
    previewRef.current=delivery.url;setPreview({blob:delivery.blob,url:delivery.url,extension:delivery.blob.type==="image/jpeg"?"jpg":delivery.blob.type==="image/webp"?"webp":"png"});
  };
  const submit = async () => {
    if (!dto || !inputs || !confirmed || busy || uploading || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const currentDto = preparedCorrection ? await getDto() : dto;
      if (preparedCorrection && (!attempt || !canCorrectNotSubmittedImageValidation(attempt, currentDto, userId))) throw new Error("原未受理证明或配置已变化，请保留原记录重新核对");
      const perform = () => submitImageValidation(currentDto, inputs, userId, { storage: localStorage, token, fetcher: fetch,
        onDelivery:acceptCurrentDelivery, onChange: next => { if (mounted.current) { setAttempt(next); setPreparedReason(""); setPreparedCorrection(false); } } }, preparedReason, preparedCorrection);
      const next = navigator.locks ? await navigator.locks.request(`admin-image-validation:${userId}:${modelId}`, perform) : await perform();
      lock.current = false; if (mounted.current) { setPreparedReason(""); if(!imageValidationIsTerminal(next)) await checkOriginal(next); }
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const upload = async (file: File | undefined, index: number) => {
    if (uploading || referenceUploadLock.current || busy || lock.current || (attempt && !preparedReason && !preparedCorrection) || !inputs || !dto) return;
    const scope = { userId, modelId, configurationHash: dto.configurationHash, index };
    const owner = JSON.stringify([userId, token, modelId, dto.configurationHash]);
    const stillCurrent = () => mounted.current && referenceOwnerRef.current === owner;
    referenceUploadLock.current = true; setUploading(true); setError(""); setConfirmed(false);
    const persist = (pending: AdminValidationReferencePending) => {
      const remember = () => { if (stillCurrent()) { const next = [...referenceUploadsRef.current.filter(item => !sameAdminValidationReferenceScope(item, pending)), pending]; referenceUploadsRef.current = next; setReferenceUploads(next); } };
      // A confirmed private key remains available in this page if local storage becomes unavailable.
      if (pending.storageKey) remember();
      writeAdminValidationReference(localStorage, pending);
      if (!pending.storageKey) remember();
    };
    try {
      const previous = referenceUploadsRef.current.find(item => sameAdminValidationReferenceScope(item, scope)) || readAdminValidationReferences(localStorage, userId).find(item => sameAdminValidationReferenceScope(item, scope));
      const pending = file && previous?.status === "ready" ? undefined : previous;
      const owned = await resolveAdminValidationReference({ scope, pending, file, token, fetcher: fetch, persist, stillCurrent,
        decode: async url => { const image = new Image(); image.src = url; await image.decode(); if (!image.naturalWidth || !image.naturalHeight) throw new Error("原参考图暂时无法读取，请重新读取已上传图。"); },
      });
      if (stillCurrent()) setInputs(current => current ? { ...current, referenceImageUrls: current.referenceImageUrls.map((value, item) => item === index ? owned.url : value) } : current);
    } catch (cause) { if (stillCurrent()) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { referenceUploadLock.current = false; if (mounted.current) setUploading(false); }
  };
  const pendingReferenceAt = (index: number) => referenceUploads.find(item => item.userId === userId && item.modelId === modelId && item.configurationHash === dto?.configurationHash && item.index === index);
  const hasReferenceUploads = referenceUploads.some(item => item.userId === userId && item.modelId === modelId && item.configurationHash === dto?.configurationHash);
  const prepareCorrection = async () => {
    if (!attempt || busy || lock.current || attempt.status !== "not_submitted") return;
    lock.current = true; setBusy(true); setError("");
    try {
      const current = await getDto();
      if (!canCorrectNotSubmittedImageValidation(attempt, current, userId)) throw new Error("原未受理证明或配置已变化，请保留原记录重新核对");
      if (mounted.current) { setDto(current); setInputs({ ...restoreAdminValidationReferenceInputs(current, imageValidationInputsForDto(current), referenceUploadsRef.current, userId), ...(attempt.body ? { prompt: attempt.body.prompt, aspectRatio: attempt.body.aspectRatio, resolution: attempt.body.resolution } : {}) }); setPreparedCorrection(true); setConfirmed(false); }
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const prepareRetest = async () => {
    if (!attempt || attempt.status !== "rejected" || busy || lock.current) return;
    const text = reason.trim(); if (text.length < 8 || text.length > 300) { setError("请填写 8 至 300 字的复测原因"); return; }
    lock.current = true; setBusy(true); setError("");
    try { const current = await getDto(text);
      if (current.busy || !current.validationKey || sameImageValidationProof(attempt.proof, current)) throw new Error("原请求尚不可复测，请先核对配置和拒绝原因");
      if (mounted.current) { setDto(current); setInputs(restoreAdminValidationReferenceInputs(current, imageValidationInputsForDto(current), referenceUploadsRef.current, userId)); setPreparedReason(text); setConfirmed(false); }
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const publish = async () => {
    if (!attempt || busy || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const publication=buildImageValidationPublishRequest(attempt);
      let body:BodyInit=JSON.stringify(publication),publicationHeaders:Record<string,string>={...headers(),"Content-Type":"application/json"};
      if(attempt.deliveryReceipt?.deliveryMode==="inline_ephemeral" && attempt.status!=="published"){
        if(!preview)throw new Error("请提供本页原验证图片或选择已下载的同一原图");
        const form=new FormData();form.set("file",preview.blob,"validation-image."+preview.extension);body=form;
        publicationHeaders={...headers(),"x-image-publication-request":encodeURIComponent(JSON.stringify(publication))};
      }
      const response = await fetch("/api/admin/cover-models/validation/publish", { method: "POST", headers:publicationHeaders,
        body, redirect: "error", signal: AbortSignal.timeout(60000) });
      const data = await response.json();
      if (!response.ok || data.success !== true || data.modelId !== modelId || data.imageRecordId !== attempt.imageRecordId || typeof data.assetId!=="string" || (!attempt.deliveryReceipt && data.assetId !== attempt.assetId)) throw new Error(imageValidationSafeError(data.error, "启用结果暂未确认，请检查原记录"));
      store({ ...attempt,assetId:data.assetId, status: "published", error: "", errorCode: "" }); if (mounted.current) onPublished();
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "", "启用结果暂未确认，请保留原验证记录")); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const recover = async () => {
    if (!attempt || !attempt.body || !attempt.canRecover || attempt.status !== "finalizing" || busy || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const perform = () => recoverImageValidation(attempt, { storage: localStorage, token, fetcher: fetch, onChange: next => { if (mounted.current) setAttempt(next); } });
      const next = navigator.locks ? await navigator.locks.request(`admin-image-validation:${userId}:${modelId}`, perform) : await perform();
      lock.current = false; if (mounted.current) await checkOriginal(next);
    } catch (cause) { if (mounted.current) setError(imageValidationSafeError(cause instanceof Error ? cause.message : "")); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const download = () => {
    if (!preview) return;
    const link = document.createElement("a"); link.href = preview.url;
    link.download = `${(attempt?.model.name || modelName).replace(/[\\/:*?"<>|]/gu, "_").slice(0, 80)}-验证.${preview.extension}`; link.click();
  };
  const selectPublicationOriginal=async(file:File)=>{
    if(!attempt?.deliveryReceipt || attempt.deliveryReceipt.deliveryMode!=="inline_ephemeral" || file.size<=0 || file.size>30*1024*1024)return;
    const receipt=attempt.deliveryReceipt;
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer())),value=>value.toString(16).padStart(2,"0")).join("");
    if(digest!==receipt.sha256 || file.size!==receipt.byteLength || file.type!==receipt.contentType){setError("选择的文件与原验证图片摘要不一致");return;}
    if(!mounted.current)return;
    if(previewRef.current)URL.revokeObjectURL(previewRef.current);
    const url=URL.createObjectURL(file);previewRef.current=url;setPreview({url,blob:file,extension:file.type==="image/jpeg"?"jpg":file.type==="image/webp"?"webp":"png"});setError("");
  };
  const showForm = !!dto && !!inputs && (!attempt || !!preparedReason || preparedCorrection);
  return <ImageValidationFrame title={attempt?.model.name || dto?.name || modelName} onClose={onClose}>
    {(attempt?.model.upstream || dto?.modelName) && <p className="mb-3 break-words text-xs text-[var(--muted-foreground)]">{attempt?.model.upstream || dto?.modelName}</p>}
    {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">{error}</p>}
    {!dto && busy && <p role="status">正在读取模型能力…</p>}
    {attempt && !preparedReason && !preparedCorrection && <div className="space-y-3" data-testid="image-validation-attempt" data-model-id={attempt.model.id} data-status={attempt.status}>
      <p role="status" className="font-medium">{phases[attempt.status]}</p>
      {attempt.status === "not_submitted" && <button type="button" className={buttonClass} disabled={busy} onClick={() => void prepareCorrection()}>补充参考图后重新确认</button>}
      {attempt.generationCompleted && !preview && !attempt.assetId && <p className="text-sm">图片生成已完成，任务与费用收据已保留；当前页面没有可用图片，临时图片刷新后无法恢复。</p>}
      {attempt.error && <p className="text-sm text-red-600">{attempt.model.name}：{attempt.error}</p>}
      {attempt.errorCode && <p className="break-all text-xs text-[var(--muted-foreground)]">{attempt.errorCode}</p>}
      {preview && <div><img src={preview.url} alt={`${attempt.model.name} 的原验证图片`} className="max-h-96 w-full rounded-lg object-contain" onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError("原验证图片无法解码，请检查下载结果")} />
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">{dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ""}{Math.round(preview.blob.size / 1024)} KB</p></div>}
      <div className="flex flex-wrap gap-2">
        {attempt.status !== "not_submitted" && <button type="button" onClick={() => void checkOriginal()} disabled={busy} className={buttonClass}>检查原任务</button>}
        {attempt.status === "finalizing" && attempt.canRecover && attempt.body && <button type="button" onClick={() => void recover()} disabled={busy} className={buttonClass}>恢复原结果保存</button>}
        {preview && <button type="button" onClick={download} className={buttonClass}>下载验证图片</button>}
        {attempt.status==="completed" && attempt.deliveryReceipt?.deliveryMode==="inline_ephemeral" && !preview && <label className={buttonClass}>选择已下载的原验证图<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{const file=event.target.files?.[0];if(file)void selectPublicationOriginal(file).catch(()=>setError("原图读取未通过，请重新选择同一文件"));event.target.value="";}} /></label>}
        {attempt.status === "completed" && <button type="button" onClick={() => void publish()} disabled={busy || (!attempt.assetId && !attempt.deliveryReceipt) || !attempt.imageRecordId || (attempt.deliveryReceipt?.deliveryMode!=="provider_url" && (!preview || !dimensions))} className={primaryClass}>{busy ? "正在启用…" : attempt.deliveryReceipt ? "保存验证凭证并发布模型" : "启用此配置"}</button>}
        {attempt.status==="completed" && attempt.deliveryReceipt && <p className="text-xs text-[var(--muted-foreground)]">仅点击发布时保存独立验证凭证；普通生成与刷新不会备份临时图片，也不会再次生成或扣费。</p>}
      </div>
      {!imageValidationIsTerminal(attempt) && <p className="text-xs text-[var(--muted-foreground)]">原任务已保留，关闭后可再次打开查看进度。</p>}
      {attempt.status === "rejected" && dto?.canRequestRetest && <div className="space-y-2"><label className="block text-sm">复测原因<textarea value={reason} onChange={event => setReason(event.target.value)} rows={2} maxLength={300} className={`${fieldClass} mt-1`} placeholder="说明已修正的问题，保留原失败记录" /></label>
        <button type="button" onClick={() => void prepareRetest()} disabled={busy} className={buttonClass}>准备一次复测</button></div>}
    </div>}
    {showForm && dto && inputs && <div className="space-y-4" data-testid="image-validation-form" data-model-id={dto.modelId}>
      <label className="block space-y-1 text-sm"><span>验证图片描述</span><textarea value={inputs.prompt} onChange={event => setInputs({ ...inputs, prompt: event.target.value })} rows={3} maxLength={10000} className={fieldClass} placeholder="描述一张简单图片，核对当前模型的生成效果" /></label>
      <div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-sm"><span>清晰度</span><select aria-label="清晰度" value={inputs.resolution} onChange={event => setInputs({ ...inputs, resolution: event.target.value as ImageValidationInputs["resolution"] })} className={fieldClass}>{dto.capabilities.resolutionOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>画面比例</span><select aria-label="画面比例" value={inputs.aspectRatio} onChange={event => setInputs({ ...inputs, aspectRatio: event.target.value })} className={fieldClass}>{["1:1", "3:4", "4:3", "9:16", "16:9"].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
      {dto.capabilities.supportsReferenceInput && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={dto.requiresReferenceInput || inputs.referenceMode} disabled={dto.requiresReferenceInput || uploading} onChange={event => setInputs({ ...inputs, referenceMode: event.target.checked, referenceImageUrls: inputs.referenceImageUrls.length ? inputs.referenceImageUrls : [""] })} />使用参考图验证</label>}
      {(dto.requiresReferenceInput || inputs.referenceMode) && dto.capabilities.supportsReferenceInput && <div className="space-y-3">
        {inputs.referenceImageUrls.map((value, index) => <div key={index} className="space-y-2"><label className="block space-y-1 text-sm"><span>参考图片 {index + 1}</span><input type="url" value={value} disabled={uploading} onChange={event => setInputs({ ...inputs, referenceImageUrls: inputs.referenceImageUrls.map((item, slot) => slot === index ? event.target.value : item) })} className={fieldClass} placeholder="HTTPS 图片链接，或选择图片上传" /></label>
          <input id={`image-validation-upload-${index}`} type="file" className="hidden" tabIndex={-1} aria-hidden="true" accept="image/png,image/jpeg,image/webp" disabled={uploading || Boolean(pendingReferenceAt(index) && pendingReferenceAt(index)?.status !== "ready")} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file, index); event.target.value = ""; }} />
          <div className="flex gap-2"><button type="button" disabled={uploading || Boolean(pendingReferenceAt(index) && pendingReferenceAt(index)?.status !== "ready")} className={buttonClass} onClick={() => document.getElementById(`image-validation-upload-${index}`)?.click()}>选择图片上传</button>
            {pendingReferenceAt(index)?.storageKey && <button type="button" data-testid={`image-validation-reference-read-${index}`} disabled={uploading} className={buttonClass} onClick={() => void upload(undefined, index)}>重新读取已上传图</button>}
            {pendingReferenceAt(index) && !pendingReferenceAt(index)?.storageKey && <span role="status" className="text-sm">上传结果待确认，请到我的图片核对原图，勿重复上传。</span>}
            {inputs.referenceImageUrls.length > 1 && <button type="button" disabled={uploading || hasReferenceUploads} className={buttonClass} onClick={() => setInputs({ ...inputs, referenceImageUrls: inputs.referenceImageUrls.filter((_, slot) => slot !== index) })}>移除</button>}</div></div>)}
        {inputs.referenceImageUrls.length < Math.min(8, dto.capabilities.maxReferenceImages) && <button type="button" className={buttonClass} onClick={() => setInputs({ ...inputs, referenceImageUrls: [...inputs.referenceImageUrls, ""] })}>添加参考图</button>}
        <p className="text-xs text-[var(--muted-foreground)]">{dto.requiresReferenceInput ? "此模型至少需要一张参考图。" : ""}PNG、JPG、WebP，单张不超过 5MB。</p>
      </div>}
      {uploading && <p role="status" className="text-sm">正在上传参考图…</p>}
      {dto.busy && <p role="status" className="text-sm">此配置已有验证正在进行，请稍后检查。</p>}
      {(!dto.credentialReady || !dto.priceReady) && <p className="text-sm text-amber-600">请先补齐当前模型的密钥和价格配置。</p>}
      {dto.requiresComputeReadiness && <p className="text-xs text-[var(--muted-foreground)]">此模型需要专属算力就绪后验证。</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>确认使用当前模型生成一张验证图片{typeof dto.quotedPriceYuan === "number" ? `（本次按标价 ¥${dto.quotedPriceYuan.toFixed(2)} 结算）` : ""}；成功交付后写入钱包与收益账务。</span></label>
      <button type="button" className={primaryClass} disabled={!confirmed || busy || uploading || dto.busy || !dto.credentialReady || !dto.priceReady || (dto.requiresReferenceInput && inputs.referenceImageUrls.filter(value => value.trim()).length < Math.max(1, dto.minReferenceImages || 1))} onClick={() => void submit()}>{busy ? "正在提交…" : "提交一次真实验证"}</button>
    </div>}
  </ImageValidationFrame>;
}
