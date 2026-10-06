"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { ArrowLeft, Brush, Download, Film, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./local-video-tools.module.css";

type Region = "bottom" | "middle-bottom" | "middle-top" | "top";
const REGIONS: Array<{id:Region;label:string;hint:string}> = [
  {id:"bottom",label:"底部 1/4",hint:"字幕最常见位置"},
  {id:"middle-bottom",label:"中下 1/4",hint:"偏下方"},
  {id:"middle-top",label:"中上 1/4",hint:"偏上方"},
  {id:"top",label:"顶部 1/4",hint:"视频顶部"},
];

export function SubtitleRemoverWorkbench(){
  const [file,setFile]=useState<File|null>(null);
  const [sourceUrl,setSourceUrl]=useState("");
  const [resultUrl,setResultUrl]=useState("");
  const [region,setRegion]=useState<Region>("bottom");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>()=>{if(sourceUrl)URL.revokeObjectURL(sourceUrl);},[sourceUrl]);
  useEffect(()=>()=>{if(resultUrl)URL.revokeObjectURL(resultUrl);},[resultUrl]);

  function select(next:File|null){
    setFile(next);setSourceUrl(next?URL.createObjectURL(next):"");setError("");
  }

  async function process(){
    if(!file)return setError("请先选择带固定字幕的视频");
    setBusy(true);setError("");
    try{
      const form=new FormData();form.set("action","subtitle-region");form.set("subtitleRegion",region);form.append("videos",file);
      const token=localStorage.getItem("auth_token")||"";
      const response=await fetch("/api/video/local-media/process",{method:"POST",headers:token?{Authorization:`Bearer ${token}`}:{},body:form});
      if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||`处理失败（${response.status}）`);}
      const blob=await response.blob();if(!blob.size)throw new Error("处理结果为空");
      setResultUrl(URL.createObjectURL(blob));
    }catch(cause){setError(cause instanceof Error?cause.message:"处理失败");}finally{setBusy(false);}
  }

  return <main className={styles.page} data-testid="subtitle-remover-workbench"><div className={styles.container}>
    <Link href="/tools/video" className={styles.back}><ArrowLeft size={17}/>返回视频创作</Link>
    <div className={styles.heading}><h1>🧹 视频去字幕</h1><p>处理固定位置的硬编码字幕，输出可播放、可下载的干净版本</p></div>
    <div className={styles.workspace}>
      <section className={styles.panel}>
        <div className={styles.panelTitle}><span className={styles.icon}><Brush size={18}/></span>去字幕设置</div>
        <label className={styles.upload}><Upload size={34}/><strong>{file?file.name:"点击或拖拽上传带字幕的视频"}</strong><span>支持 MP4 / WebM / MOV / AVI，单文件最大 100MB</span><input type="file" accept="video/mp4,video/webm,video/quicktime,video/x-msvideo" onChange={e=>select(e.target.files?.[0]||null)}/></label>
        {sourceUrl?<video className={styles.preview} src={sourceUrl} controls/>:null}
        <div className={styles.controls}><div className={styles.field}><label>🎯 字幕擦除区域</label><span style={{fontSize:12,color:"#718198"}}>选择字幕所在的纵向区域，处理该区域的全部画面</span></div><div className={styles.regionGrid}>{REGIONS.map(item=><button type="button" key={item.id} className={`${styles.region} ${region===item.id?styles.regionActive:""}`} onClick={()=>setRegion(item.id)}><strong>{item.label}</strong><span>{item.hint}</span></button>)}</div></div>
        <div className={styles.notice}>当前版本使用主站 FFmpeg 对所选固定区域逐帧模糊覆盖，不会调用外部 AI。适合字幕位置固定的视频；移动字幕或复杂背景可能留下涂抹痕迹。</div>
        {error?<p className={styles.error}>{error}</p>:null}<button className={styles.primary} type="button" onClick={process} disabled={!file||busy}>{busy?"正在逐帧处理…":"🧹 开始去除固定区域字幕"}</button>
      </section>
      <section className={styles.panel}>
        <div className={styles.panelTitle}><span className={styles.icon}><Film size={18}/></span>去字幕结果</div>
        {!resultUrl?<div className={styles.resultEmpty}><div><Brush size={42}/><p>上传视频并完成处理后在此预览</p></div></div>:<div className={styles.result}><video src={resultUrl} controls/><a className={styles.download} href={resultUrl} download="固定区域去字幕.mp4"><Download size={18}/>下载处理后视频</a></div>}
      </section>
    </div>
    <section className={styles.guide}><h2>🧩 使用指南</h2><div className={styles.guideBox}><strong>当前真实原理：</strong>逐帧读取所选 1/4 区域并做高斯模糊，再保留原视频时长和音轨。<br/><span className={styles.privacy}><ShieldCheck size={18}/>文件只送到当前主站进程处理，临时目录在响应完成前清理；本功能不等于 OCR 自动识别，也不使用生成式修复。</span></div></section>
  </div></main>;
}
