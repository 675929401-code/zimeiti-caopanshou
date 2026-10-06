"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { ArrowLeft, Download, Film, Music2, Scissors, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import styles from "./local-video-tools.module.css";

type EditorMode = "trim" | "concat" | "mute" | "extract-audio" | "replace-audio" | "gif";

const MODES: Array<{ id: EditorMode; label: string }> = [
  { id: "trim", label: "裁剪" }, { id: "concat", label: "拼接" }, { id: "mute", label: "静音" },
  { id: "extract-audio", label: "提取音频" }, { id: "replace-audio", label: "音视频合成" },
  { id: "gif", label: "GIF" },
];

function fileSize(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function LocalVideoEditor() {
  const [mode, setMode] = useState<EditorMode>("trim");
  const [videos, setVideos] = useState<File[]>([]);
  const [audio, setAudio] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [resultType, setResultType] = useState("video/mp4");
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(5);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl); }, [resultUrl]);
  const actionLabel = useMemo(() => MODES.find((item) => item.id === mode)?.label || "处理", [mode]);

  function pickVideos(files: FileList | null) {
    const next = Array.from(files || []).filter((file) => file.type.startsWith("video/")).slice(0, 8);
    setVideos(next);
    setError("");
    setPreviewUrl(next[0] ? URL.createObjectURL(next[0]) : "");
  }

  async function process() {
    if (!videos.length) return setError("请先选择视频文件");
    if (mode === "concat" && videos.length < 2) return setError("拼接至少需要两个视频");
    if (mode === "replace-audio" && !audio) return setError("音视频合成需要选择音频文件");
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.set("action", mode); form.set("startSeconds", String(start)); form.set("endSeconds", String(end));
      videos.forEach((file) => form.append("videos", file));
      if (audio) form.set("audio", audio);
      const token = localStorage.getItem("auth_token") || "";
      const response = await fetch("/api/video/local-media/process", { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `处理失败（${response.status}）`); }
      const blob = await response.blob();
      if (!blob.size) throw new Error("处理结果为空");
      setResultType(blob.type || (mode === "extract-audio" ? "audio/mpeg" : "video/mp4"));
      setResultUrl(URL.createObjectURL(blob));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "媒体处理失败"); }
    finally { setBusy(false); }
  }

  return <main className={styles.page} data-testid="local-video-editor">
    <div className={styles.container}>
      <Link href="/tools/video" className={styles.back}><ArrowLeft size={17}/>返回视频创作</Link>
      <div className={styles.heading}><h1>🎬 在线视频编辑器</h1><p>裁剪、拼接、静音、提取音频、音视频合成与 GIF 导出</p></div>
      <div className={styles.tabs} aria-label="编辑模式">
        {MODES.map((item) => <button key={item.id} type="button" className={`${styles.tab} ${mode===item.id?styles.tabActive:""}`} onClick={()=>setMode(item.id)}>{item.label}</button>)}
      </div>
      <div className={styles.workspace}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}><span className={styles.icon}><Scissors size={18}/></span>素材与参数</div>
          <label className={styles.upload}><Upload size={34}/><strong>点击选择视频</strong><span>{mode==="concat"?"可按选择顺序添加 2-8 个视频":"支持 MP4 / WebM / MOV / AVI，单文件最大 100MB"}</span><input type="file" accept="video/mp4,video/webm,video/quicktime,video/x-msvideo" multiple={mode==="concat"} onChange={(event)=>pickVideos(event.target.files)}/></label>
          <div className={styles.fileList}>{videos.map((file,index)=><div className={styles.fileRow} key={`${file.name}-${index}`}><span>{index+1}. {file.name}</span><span>{fileSize(file.size)}</span></div>)}</div>
          {previewUrl?<video className={styles.preview} src={previewUrl} controls onLoadedMetadata={(event)=>{const value=event.currentTarget.duration||0;setDuration(value);setEnd(Number(Math.min(value,Math.max(1,value)).toFixed(2)));}}/>:null}
          {mode==="trim"||mode==="gif"?<div className={styles.controls}><div className={styles.row}><div className={styles.field}><label>开始时间（秒）</label><input type="number" min={0} max={duration||14400} step="0.1" value={start} onChange={e=>setStart(Number(e.target.value))}/></div><div className={styles.field}><label>结束时间（秒）</label><input type="number" min={0.1} max={duration||14400} step="0.1" value={end} onChange={e=>setEnd(Number(e.target.value))}/></div></div>{mode==="gif"?<p className={styles.notice}>导出从开始时间起最多 6 秒的无声 GIF，宽度 480 像素、每秒 8 帧。</p>:null}</div>:null}
          {mode==="replace-audio"?<label className={styles.upload} style={{minHeight:90}}><Music2 size={26}/><strong>{audio?audio.name:"选择替换音频"}</strong><span>支持 MP3 / WAV / AAC / OGG</span><input type="file" accept="audio/*" onChange={e=>setAudio(e.target.files?.[0]||null)}/></label>:null}
          <div className={styles.notice}>视频会上传到当前主站进程的临时目录处理，完成后立即清理；不会调用外部生成模型，也不会产生 AI 模型费用。拼接会统一到 1280×720、30fps。</div>
          {error?<p className={styles.error}>{error}</p>:null}
          <button type="button" className={styles.primary} onClick={process} disabled={busy||!videos.length}>{busy?"正在处理…":`${actionLabel}并导出`}</button>
        </section>
        <section className={styles.panel}>
          <div className={styles.panelTitle}><span className={styles.icon}><Film size={18}/></span>编辑结果</div>
          {!resultUrl?<div className={styles.resultEmpty}><div><Film size={42}/><p>完成设置后点击“{actionLabel}并导出”</p></div></div>:<div className={styles.result}>{resultType.startsWith("audio/")?<audio src={resultUrl} controls/>:resultType==="image/gif"?<img src={resultUrl} alt="导出的动态 GIF" style={{width:"100%",maxHeight:330,objectFit:"contain",borderRadius:12}}/>:<video src={resultUrl} controls/>}<a href={resultUrl} download={resultType.startsWith("audio/")?"提取音频.mp3":resultType==="image/gif"?"动态封面.gif":"编辑结果.mp4"} className={styles.download}><Download size={18}/>下载真实处理结果</a></div>}
        </section>
      </div>
      <section className={styles.guide}><h2>🧩 使用边界</h2><div className={styles.guideBox}>基础剪辑由 FFmpeg 完成，不等于 AI 重绘视频。裁剪、静音、提音频和音视频合成不扣模型积分；“AI 指令编辑”仍应在主站 AI 视频工作台选择已发布的源视频模型，并单独确认价格与任务。</div></section>
    </div>
  </main>;
}
