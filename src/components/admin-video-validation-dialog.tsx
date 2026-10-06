"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { videoDurationDisplay } from "@/lib/video-duration-display";
import {
  buildVideoValidationPublishRequest, readVideoValidationAttempt, saveVideoValidationAttempt,
  submitVideoValidation, updateVideoValidationReceipt, videoValidationIsTerminal, videoValidationProof, videoValidationInputsForDto,
  type VideoValidationAttempt, type VideoValidationDto, type VideoValidationInputs,
} from "./admin-video-validation-state";

type Props = { modelId: string; modelName: string; listedPrice?: number; token: string; onClose: () => void; onPublished: () => void };
const emptyInputs: VideoValidationInputs = { prompt: "", firstFrame: "", lastFrame: "", images: [], audios: [], sourceVideo: "" };
const phaseLabel: Record<VideoValidationAttempt["status"], string> = {
  submitting: "正在提交", processing: "正在生成", finalizing: "生成已完成，正在保存结果", unknown: "等待确认原任务", completed: "验证生成已完成", failed: "本次验证未完成", published: "已启用此配置",
};

export default function AdminVideoValidationDialog({ modelId, modelName, listedPrice, token, onClose, onPublished }: Props) {
  const [dto, setDto] = useState<VideoValidationDto | null>(null);
  const [userId, setUserId] = useState("");
  const [attempt, setAttempt] = useState<VideoValidationAttempt | null>(null);
  const [inputs, setInputs] = useState<VideoValidationInputs>(emptyInputs);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [playbackUrl, setPlaybackUrl] = useState("");
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const headers = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const getProof = useCallback(async (original?: VideoValidationAttempt) => {
    const params = new URLSearchParams({ modelId });
    if (original) {
      params.set("validationKey", original.proof.validationKey);
      params.set("configurationHash", original.proof.configurationHash);
      params.set("healthEpoch", original.proof.healthEpoch);
    }
    const response = await fetch(`/api/admin/video-models/validation?${params}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "暂时无法检查当前模型");
    if (data.model?.id !== modelId) throw new Error("返回配置与所选模型不一致");
    videoValidationProof(data);
    return data as VideoValidationDto;
  }, [headers, modelId]);

  const adoptReceipt = useCallback((data: VideoValidationDto, owner: string, original: VideoValidationAttempt | null) => {
    const receipt = data.existingTask;
    if (!receipt) return original;
    const proof = original?.proof || videoValidationProof({
      ...data, validationKey: receipt.validationKey || data.validationKey,
      configurationHash: receipt.configurationHash || data.configurationHash, healthEpoch: receipt.healthEpoch || data.healthEpoch,
    });
    if (original && receipt.validationKey && receipt.validationKey !== original.proof.validationKey) throw new Error("查到的任务不属于原验证记录");
    const base: VideoValidationAttempt = original || {
      version: 1, userId: owner, proof, createdAt: new Date().toISOString(), status: "unknown", taskId: "", businessTaskId: "", error: "", errorCode: "",
    };
    const next = updateVideoValidationReceipt(base, { ...receipt, modelId, errorMessage: receipt.error });
    saveVideoValidationAttempt(localStorage, next);
    return next;
  }, [modelId]);

  useEffect(() => {
    mounted.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], video[controls]') || []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(20_000) });
        const me = await response.json();
        if (!response.ok || me.user?.role !== "admin" || !me.user?.id) throw new Error("请使用当前有效管理员账号登录");
        const owner = String(me.user.id);
        const stored = readVideoValidationAttempt(localStorage, owner, modelId);
        const saved = stored?.status === "submitting" ? { ...stored, status: "unknown" as const, error: "页面已重新载入，请检查原验证任务" } : stored;
        if (mounted.current) { setUserId(owner); setAttempt(saved); }
        const data = await getProof(saved || undefined);
        const restored = adoptReceipt(data, owner, saved);
        if (!mounted.current) return;
        setUserId(owner); setDto(data); setAttempt(restored);
        setInputs(videoValidationInputsForDto(data));
      } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "模型验证预检失败"); }
      finally { if (mounted.current) setBusy(false); }
    })();
    return () => { mounted.current = false; document.removeEventListener("keydown", keyboard); previouslyFocused?.focus(); };
  }, [adoptReceipt, getProof, headers, modelId]);

  const storeAttempt = useCallback((next: VideoValidationAttempt) => {
    saveVideoValidationAttempt(localStorage, next);
    if (mounted.current) setAttempt(next);
  }, []);

  const checkOriginal = useCallback(async () => {
    if (!attempt || actionLock.current) return;
    actionLock.current = true;
    try {
      let next = attempt;
      if (!attempt.taskId && !attempt.businessTaskId) {
        const restored = adoptReceipt(await getProof(attempt), attempt.userId, attempt);
        if (restored) next = restored;
      }
      if (next.taskId || next.businessTaskId) {
        const params = new URLSearchParams({ taskId: next.taskId || next.businessTaskId, modelId: next.proof.model.id });
        const response = await fetch(`/api/video/status?${params}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(60_000) });
        const data = await response.json();
        next = updateVideoValidationReceipt(next, data, response.ok);
      }
      storeAttempt(next);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "原任务暂时无法查询，请稍后再查"); }
    finally { actionLock.current = false; }
  }, [adoptReceipt, attempt, getProof, headers, storeAttempt]);

  useEffect(() => {
    if (!attempt || videoValidationIsTerminal(attempt) || attempt.status === "submitting") return;
    const timer = setTimeout(() => void checkOriginal(), attempt.taskId || attempt.businessTaskId ? 5000 : 15000);
    return () => clearTimeout(timer);
  }, [attempt, checkOriginal]);

  const playbackTaskId = attempt?.businessTaskId || attempt?.taskId || "";
  const canPlay = !!attempt && ["completed", "published"].includes(attempt.status);
  useEffect(() => {
    setPlaybackUrl("");
    if (!canPlay || !playbackTaskId) return;
    let current = true;
    const params = new URLSearchParams({ taskId: playbackTaskId, scope: "playback" });
    void fetch(`/api/video/access-ticket?${params}`, { headers: headers(), cache: "no-store" }).then(async response => {
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string") throw new Error(data.error || "视频播放地址暂不可用");
      const url = new URL(data.url, location.origin);
      if (url.origin !== location.origin) throw new Error("视频播放地址必须来自本站");
      if (current) setPlaybackUrl(url.href);
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "视频播放暂不可用"); });
    return () => { current = false; };
  }, [canPlay, playbackTaskId, headers]);

  const submit = async () => {
    if (!dto || !confirmed || busy || actionLock.current) return;
    actionLock.current = true; setBusy(true); setError("");
    try {
      const perform = () => submitVideoValidation(dto, inputs, userId, { storage: localStorage, fetcher: fetch, token, onChange: next => { if (mounted.current) setAttempt(next); } });
      if (navigator.locks) await navigator.locks.request(`admin-video-validation:${userId}:${modelId}`, perform);
      else await perform();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "视频验证提交失败"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  };

  const upload = async (file: File, category: "image" | "audio" | "video", slot: string, apply: (url: string) => void) => {
    if (uploading || attempt) return;
    const limit = category === "video" ? 300 : category === "image" ? 10 : 30;
    if (file.size <= 0 || file.size > limit * 1024 * 1024) { setError(`请选择 ${limit}MB 以内的${category === "image" ? "图片" : category === "video" ? "视频" : "音频"}`); return; }
    setUploading(slot); setError("");
    try {
      const form = new FormData(); form.set("file", file); form.set("category", category);
      const response = await fetch(category === "video" ? "/api/digital-human/upload" : "/api/video/reference-upload", { method: "POST", headers: headers(), body: form, signal: AbortSignal.timeout(60_000) });
      const data = await response.json();
      if (!response.ok || !(data.file?.url || data.asset?.url)) throw new Error(data.error || "参考素材上传失败");
      if (mounted.current) apply(data.file?.url || data.asset?.url);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "上传失败"); }
    finally { if (mounted.current) setUploading(""); }
  };

  const publish = async () => {
    if (!attempt || busy || actionLock.current) return;
    actionLock.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/video-models/validation/publish", { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(buildVideoValidationPublishRequest(attempt)), signal: AbortSignal.timeout(30_000) });
      const data = await response.json();
      if (!response.ok || data.success !== true || data.modelId !== modelId || data.taskId !== attempt.businessTaskId) throw new Error(data.error || "暂时无法启用此配置");
      storeAttempt({ ...attempt, status: "published", error: "", errorCode: "" }); onPublished();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "启用响应未确认，请检查当前配置；验证结果已保留"); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  };

  const prepareNext = async () => {
    if (!attempt || attempt.status !== "failed" || busy || actionLock.current) return;
    actionLock.current = true; setBusy(true); setError("");
    try {
      const data = await getProof();
      if (data.busy) throw new Error("该配置已有验证任务，请先检查原任务");
      if (data.validationKey === attempt.proof.validationKey && !attempt.notSubmitted) throw new Error("原任务仍绑定当前验证记录，请先修正模型配置再检查");
      setDto(data); setAttempt(null); setInputs(videoValidationInputsForDto(data)); setConfirmed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法重新检查模型"); }
    finally { actionLock.current = false; setBusy(false); }
  };

  const download = async () => {
    if (!attempt) return;
    try {
      const name = `${attempt.proof.model.displayName.replace(/[\\/:*?"<>|]/gu, "_")}-验证.mp4`;
      const params = new URLSearchParams({ taskId: attempt.businessTaskId || attempt.taskId, scope: "download", name });
      const response = await fetch(`/api/video/access-ticket?${params}`, { headers: headers(), cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "下载暂不可用");
      const url = new URL(data.url, location.origin);
      if (url.origin !== location.origin) throw new Error("下载地址必须来自本站");
      const link = document.createElement("a"); link.href = url.href; link.download = name; link.click();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "下载暂不可用"); }
  };

  const fieldClass = "w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm";
  const secondaryClass = "rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50";
  const assetField = (label: string, category: "image" | "audio" | "video", value: string, slot: string, apply: (url: string) => void) => (
    <div className="space-y-1" key={slot}>
      <label className="block text-sm" htmlFor={`vv-${slot}`}>{label}</label>
      <input id={`vv-${slot}`} type="url" value={value} onChange={event => apply(event.target.value)} placeholder="HTTPS 链接，或选择文件上传" className={fieldClass} />
      <div className="flex items-center gap-2">
        <input id={`vv-upload-${slot}`} aria-label={`上传${label}`} aria-hidden="true" type="file" accept={category === "image" ? "image/*" : category === "video" ? "video/mp4,video/quicktime" : "audio/*,.mp4"} disabled={!!uploading} onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file, category, slot, apply); event.target.value = ""; }} className="hidden" tabIndex={-1} />
        <button type="button" aria-label={`上传${label}`} disabled={!!uploading} onClick={() => document.getElementById(`vv-upload-${slot}`)?.click()} className={secondaryClass}>选择{category === "image" ? "图片" : category === "video" ? "视频" : "音频"}上传</button>
        <span className="text-xs text-[var(--muted-foreground)]">{value ? "已设置素材" : "尚未选择文件"}</span>
      </div>
      {uploading === slot && <span className="text-xs" role="status">正在上传…</span>}
    </div>
  );
  const price = dto?.minimumPrice ?? listedPrice;
  const minimum = dto?.minimumInput;
  const durationDisplay = videoDurationDisplay({ workflowInputMode: dto?.capabilities.mode, billingUnit: dto?.billingUnit, requiresSourceVideo: minimum?.sourceVideoRequired });
  return (
    <div className="admin-video-validation fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="video-validation-title" tabIndex={-1} style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--background)] p-5 text-[var(--foreground)] shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div><h2 id="video-validation-title" className="text-lg font-bold">视频模型真实验证</h2><p className="mt-1 break-words text-sm font-medium">{attempt?.proof.model.displayName || dto?.model.displayName || modelName}</p><p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">{attempt?.proof.model.upstreamModel || dto?.model.upstreamModel}</p></div>
          <button type="button" onClick={onClose} className={secondaryClass} aria-label="关闭视频验证">关闭</button>
        </div>
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-600">{error}</p>}
        {!dto && busy && <p role="status">正在读取模型能力…</p>}
        {attempt ? <div className="space-y-4">
          <p role="status" className="font-medium">{phaseLabel[attempt.status]}</p>
          {attempt.taskId && <p className="break-all text-xs text-[var(--muted-foreground)]">任务编号：{attempt.businessTaskId || attempt.taskId}</p>}
          {attempt.error && <p className="text-sm text-red-600">{attempt.proof.model.displayName}：{attempt.error}</p>}
          {attempt.errorCode && <p className="break-all text-xs text-[var(--muted-foreground)]">{attempt.errorCode}</p>}
          {playbackUrl && <video key={playbackUrl} src={playbackUrl} controls preload="metadata" className="max-h-80 w-full rounded-lg bg-black" onError={() => setError("当前验证视频加载失败，可重新检查原任务或下载查看")} />}
          <div className="flex flex-wrap gap-2">
            {attempt.status !== "published" && <button type="button" onClick={() => void checkOriginal()} disabled={busy} className={secondaryClass}>检查原任务</button>}
            {attempt.status === "failed" && <button type="button" onClick={() => void prepareNext()} disabled={busy} className={secondaryClass}>重新检查配置</button>}
            {["completed", "published"].includes(attempt.status) && <button type="button" onClick={() => void download()} className={secondaryClass}>下载验证视频</button>}
            {attempt.status === "completed" && <button type="button" onClick={() => void publish()} disabled={busy || !attempt.businessTaskId} className="rounded-lg bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "正在启用…" : "启用此配置"}</button>}
          </div>
          {!videoValidationIsTerminal(attempt) && <p className="text-xs text-[var(--muted-foreground)]">原任务已保留，关闭后可再次打开查看进度。</p>}
        </div> : dto && minimum && <div className="space-y-4">
          <p className="text-xs text-[var(--muted-foreground)]">{minimum.sourceVideoRequired ? "时长沿用源视频" : `${durationDisplay.label} ${minimum.durationSeconds} 秒`} · {minimum.sourceVideoRequired ? "原视频画质" : minimum.resolution || "模型默认画质"} · {minimum.aspectRatio}</p>
          {minimum.promptRequired && <label className="block space-y-1 text-sm"><span>验证视频描述</span><textarea value={inputs.prompt} onChange={event => setInputs(current => ({ ...current, prompt: event.target.value }))} maxLength={10000} rows={3} className={fieldClass} placeholder="描述一个简短场景，确认该模型能生成预期内容" /></label>}
          {dto.capabilities.showFirstFrame && assetField(`首帧图片${minimum.firstFrameRequired ? "（必填）" : "（可选）"}`, "image", inputs.firstFrame, "first", value => setInputs(current => ({ ...current, firstFrame: value })))}
          {dto.capabilities.showLastFrame && assetField(`尾帧图片${minimum.lastFrameRequired ? "（必填）" : "（可选）"}`, "image", inputs.lastFrame, "last", value => setInputs(current => ({ ...current, lastFrame: value })))}
          {inputs.images.map((value, index) => assetField(`参考图片 ${index + 1}`, "image", value, `image-${index}`, url => setInputs(current => ({ ...current, images: current.images.map((item, itemIndex) => itemIndex === index ? url : item) }))))}
          {inputs.audios.map((value, index) => assetField(`参考音频 ${index + 1}${minimum.audioCount > index ? "（必填）" : "（可选）"}`, "audio", value, `audio-${index}`, url => setInputs(current => ({ ...current, audios: current.audios.map((item, itemIndex) => itemIndex === index ? url : item) }))))}
          {minimum.sourceVideoRequired && assetField("源视频（必填）", "video", inputs.sourceVideo, "source-video", value => setInputs(current => ({ ...current, sourceVideo: value })))}
          {minimum.requiresComputeLifecycle && <p className="text-xs text-[var(--muted-foreground)]">此模型需要算力启动；提交后会跟踪同一任务。</p>}
          {(!dto.readiness.credentialReady || !dto.readiness.endpointConfigured || dto.busy) && <p className="text-sm text-amber-600">{dto.busy ? "该配置已有验证正在进行，请稍后检查。" : "请先补齐当前模型的 API 地址和密钥配置。"}</p>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1" /><span>确认使用此模型生成一次验证视频{typeof price === "number" && Number.isFinite(price) ? `（本次按 ¥${price.toFixed(2)}${dto.billingUnit === "output_second" ? `，${durationDisplay.quoteBasis}` : ""} 结算）` : "，费用按当前模型配置计算"}；成功交付后写入钱包与收益账务。</span></label>
          <button type="button" onClick={() => void submit()} disabled={!confirmed || busy || !!uploading || dto.busy || !dto.readiness.credentialReady || !dto.readiness.endpointConfigured} className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? "正在提交…" : "提交一次真实验证"}</button>
        </div>}
      </div>
    </div>
  );
}
