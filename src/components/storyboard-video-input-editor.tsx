"use client";

import { useState, type ChangeEvent } from "react";
import type { AiVideoPageInputCapabilities } from "@/lib/ai-video-page-capabilities";
import { getStoryboardVideoInputRoles, type StoryboardVideoInputs } from "@/lib/storyboard-video-inputs";
import styles from "./storyboard-video-input-editor.module.css";

type MediaKind = "image" | "audio" | "video";
type UploadedAsset = NonNullable<StoryboardVideoInputs["uploadedAssets"]>[number];
type UrlField = "firstFrameUrl" | "lastFrameUrl" | "audioUrl" | "sourceVideoUrl";
type ListField = "referenceImageUrls" | "referenceAudioUrls";
export type StoryboardVideoInputEditorProps = {
  cardOrder: number;
  capabilities: AiVideoPageInputCapabilities;
  value?: StoryboardVideoInputs;
  disabled: boolean;
  issue?: string;
  onChange: (value: StoryboardVideoInputs) => void;
  onUpload: (file: File, kind: MediaKind) => Promise<UploadedAsset>;
};

export function StoryboardVideoInputEditor({ cardOrder, capabilities: caps, value = {}, disabled, issue, onChange, onUpload }: StoryboardVideoInputEditorProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const locked = disabled || Boolean(uploading);
  const roles = getStoryboardVideoInputRoles(caps, value);
  const usesImage = roles.acceptsImage;
  const useStoryboard = roles.useStoryboardImage;
  const remainingImageSlots = roles.remainingImageSlots;
  const audioCount = Number(Boolean(roles.audioUrl)) + (roles.referenceAudioUrls?.length || 0);
  const missingRequiredExtra = (caps.requiresSourceVideo && !value.sourceVideoUrl)
    || (caps.requiresLastFrame && !roles.lastFrameUrl) || audioCount < caps.minReferenceAudios;
  const update = (next: StoryboardVideoInputs) => {
    try {
      const used = new Set([next.firstFrameUrl, next.lastFrameUrl, next.audioUrl, next.sourceVideoUrl, ...(next.referenceImageUrls || []), ...(next.referenceAudioUrls || [])].filter(Boolean));
      onChange({ ...next, ...(next.uploadedAssets ? { uploadedAssets: next.uploadedAssets.filter(asset => used.has(asset.url)) } : {}) });
      setError(""); return true;
    } catch (e) { setError(e instanceof Error ? e.message : "素材地址无效，请重新填写。"); return false; }
  };
  const slot = (field: UrlField | ListField, label: string, kind: MediaKind, maximum = 1) => {
    const listed = field === "referenceImageUrls" || field === "referenceAudioUrls";
    const urls: string[] = listed ? (value[field] || []) as string[] : value[field] ? [value[field] as string] : [];
    const add = (url: string, asset?: UploadedAsset) => {
      const text = url.trim(); if (!text) return;
      const next = { ...value, [field]: listed ? [...urls, text] : text, ...(asset ? { uploadedAssets: [...(value.uploadedAssets || []).filter(item => item.url !== asset.url), asset] } : {}) };
      if (update(next)) setDrafts(current => ({ ...current, [field]: "" }));
    };
    const upload = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || locked) return;
      setUploading(field); setError("");
      try { const asset = await onUpload(file, kind); add(asset.url, asset); } catch (e) { setError(e instanceof Error ? e.message : "上传未确认，请核对素材库后重试。"); } finally { setUploading(""); }
    };
    return <div className={styles.slot} key={field}>
      <strong>{label}{listed ? `（${urls.length}/${maximum}）` : ""}</strong>
      {urls.map((url, index) => <div className={styles.existing} key={`${url}:${index}`}><span title={url}>{listed ? `${label} ${index + 1}` : "已添加"}</span><button type="button" disabled={locked} aria-label={`移除分段${cardOrder}${label}${listed ? index + 1 : ""}`} onClick={() => update({ ...value, [field]: listed ? urls.filter((_, i) => i !== index) : undefined })}>移除</button></div>)}
      {urls.length < maximum && <div className={styles.controls}>
        <input type="url" value={drafts[field] || ""} disabled={locked} aria-label={`分段${cardOrder}${label}链接`} placeholder="粘贴素材链接" onChange={event => setDrafts(current => ({ ...current, [field]: event.target.value }))} />
        <button type="button" disabled={locked || !drafts[field]?.trim()} onClick={() => add(drafts[field] || "")}>添加</button>
        {kind !== "video" && <label className={locked ? styles.disabled : ""}>{uploading === field ? "上传中…" : "上传"}<input type="file" hidden accept={`${kind}/*`} disabled={locked} aria-label={`上传分段${cardOrder}${label}`} onChange={event => void upload(event)} /></label>}
      </div>}
    </div>;
  };
  return <details className={styles.editor} open={missingRequiredExtra}>
    <summary>视频素材{caps.mode === "text" && !caps.requiresSourceVideo ? " · 无需分镜图" : ""}</summary>
    <div className={styles.body}>
      {usesImage && <label className={styles.toggle}><input type="checkbox" checked={useStoryboard} disabled={locked} onChange={event => update({ ...value, useStoryboardImage: event.target.checked, ...(event.target.checked ? { firstFrameUrl: undefined } : {}) })} />使用本段分镜图{caps.showFirstFrame ? "作为首帧" : ""}</label>}
      {usesImage && !useStoryboard && slot("firstFrameUrl", caps.showFirstFrame ? "首帧图片" : "视频图片", "image")}
      {(caps.showLastFrame || value.lastFrameUrl) && slot("lastFrameUrl", "尾帧图片", "image", caps.showLastFrame ? 1 : 0)}
      {((caps.showReferenceImages && caps.maxReferenceImages > 1) || Boolean(value.referenceImageUrls?.length)) && slot("referenceImageUrls", "视频参考图", "image", Math.min(16, remainingImageSlots))}
      {(roles.acceptsAudio || value.audioUrl) && slot("audioUrl", "音频", "audio", roles.acceptsAudio ? 1 : 0)}
      {(roles.acceptsReferenceAudio || Boolean(value.referenceAudioUrls?.length)) && slot("referenceAudioUrls", "参考音频", "audio", Math.min(8, roles.remainingAudioSlots))}
      {(caps.supportsSourceVideoInput || value.sourceVideoUrl) && slot("sourceVideoUrl", "源视频链接", "video", caps.supportsSourceVideoInput ? 1 : 0)}
      {caps.supportsSourceVideoInput && <p>请使用可直接访问的源视频链接。</p>}
      {caps.mode === "text" && !caps.requiresSourceVideo && <p>根据视频提示词生成，不会自动生成分镜图。</p>}
      {(error || issue) && <p role="status">{error || issue}</p>}
    </div>
  </details>;
}
