"use client";

import {
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Expand,
  Film,
  Gauge,
  Maximize2,
  MessageSquareText,
  Pause,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./experience-flow-demo.module.css";

type DemoTab = "stream" | "video";
type VideoStage = "idle" | "queued" | "rendering" | "finalizing" | "ready";

const STREAM_DEMO_TEXT = "已经收到你的任务。我会先提炼目标，再把内容拆成可执行的镜头：第一步锁定人物与场景，第二步组织节奏和动作，第三步给出可直接生成的视频提示词。整个过程会持续输出，不让你对着空白页面等待。";

const taskItems = [
  { id: "CHAT-STREAM-01", label: "首字快速出现", status: "已确定" },
  { id: "CHAT-STREAM-02", label: "持续平滑输出", status: "模拟验收" },
  { id: "VIDEO-LIVE-01", label: "完成即预览", status: "模拟验收" },
  { id: "VIDEO-LIVE-02", label: "点击播放与缩放", status: "模拟验收" },
  { id: "VIDEO-HISTORY-01", label: "历史即时回填", status: "待真实链路" },
] as const;

function stageLabel(stage: VideoStage): string {
  if (stage === "queued") return "任务已提交";
  if (stage === "rendering") return "上游生成中";
  if (stage === "finalizing") return "正在确认结果";
  if (stage === "ready") return "可实时预览";
  return "等待演示";
}

export function ExperienceFlowDemo() {
  const [tab, setTab] = useState<DemoTab>("stream");
  const [streamOutput, setStreamOutput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const [videoStage, setVideoStage] = useState<VideoStage>("idle");
  const [videoProgress, setVideoProgress] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const animationRef = useRef<number | null>(null);
  const videoTimersRef = useRef<number[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);

  const stopStreaming = useCallback(() => {
    if (animationRef.current != null) window.cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    setStreaming(false);
  }, []);

  const runStreamingDemo = useCallback(() => {
    stopStreaming();
    setStreamOutput("");
    setFirstTokenMs(null);
    setStreaming(true);
    const submittedAt = performance.now();
    const firstTokenDelay = 120;
    const charactersPerSecond = 44;
    let streamStartedAt = 0;

    const tick = (now: number) => {
      if (!streamStartedAt) {
        if (now - submittedAt < firstTokenDelay) {
          animationRef.current = window.requestAnimationFrame(tick);
          return;
        }
        streamStartedAt = now;
        setFirstTokenMs(Math.round(now - submittedAt));
      }
      const visible = Math.min(
        STREAM_DEMO_TEXT.length,
        Math.max(1, Math.floor(((now - streamStartedAt) / 1000) * charactersPerSecond) + 1),
      );
      setStreamOutput(STREAM_DEMO_TEXT.slice(0, visible));
      if (visible < STREAM_DEMO_TEXT.length) {
        animationRef.current = window.requestAnimationFrame(tick);
      } else {
        animationRef.current = null;
        setStreaming(false);
      }
    };

    animationRef.current = window.requestAnimationFrame(tick);
  }, [stopStreaming]);

  const clearVideoTimers = useCallback(() => {
    videoTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    videoTimersRef.current = [];
  }, []);

  const scheduleVideo = useCallback((delay: number, callback: () => void) => {
    videoTimersRef.current.push(window.setTimeout(callback, delay));
  }, []);

  const runVideoDemo = useCallback(() => {
    clearVideoTimers();
    setPreviewOpen(false);
    setPlaying(false);
    setZoom(100);
    setVideoStage("queued");
    setVideoProgress(8);
    scheduleVideo(260, () => { setVideoStage("rendering"); setVideoProgress(26); });
    scheduleVideo(680, () => setVideoProgress(54));
    scheduleVideo(1_080, () => setVideoProgress(82));
    scheduleVideo(1_340, () => { setVideoProgress(94); setVideoStage("finalizing"); });
    scheduleVideo(1_720, () => { setVideoProgress(100); setVideoStage("ready"); });
  }, [clearVideoTimers, scheduleVideo]);

  useEffect(() => () => {
    if (animationRef.current != null) window.cancelAnimationFrame(animationRef.current);
    videoTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!previewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPreviewOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previewTriggerRef.current?.focus({ preventScroll: true }));
    };
  }, [previewOpen]);

  const openPreview = (trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewOpen(true);
  };

  const requestFullscreen = async () => {
    const target = videoRef.current || previewRef.current;
    if (!target?.requestFullscreen) return;
    await target.requestFullscreen().catch(() => undefined);
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play().catch(() => undefined);
    else video.pause();
  };

  const copyTaskId = async (taskId: string) => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(taskId);
      copied = true;
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = taskId;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      copied = document.execCommand("copy");
      fallback.remove();
    }
    setCopiedTaskId(copied ? taskId : null);
    setCopyFeedback(copied ? `${taskId} 已复制` : `${taskId} 复制失败，请手动选择`);
  };

  return (
    <main className={styles.page} data-testid="experience-flow-demo">
      <div className={styles.ambient} aria-hidden="true"><i /><i /><i /></div>
      <header className={styles.header}>
        <div>
          <a href="/" className={styles.back}><ArrowLeft size={15} />返回首页</a>
          <span className={styles.eyebrow}>LOCAL INTERACTION PROTOTYPE</span>
          <h1>体验链路 Demo</h1>
          <p>只验证界面与操作流程；全部数据均为模拟，不调用模型、不计费、不写真实后端。</p>
        </div>
        <div className={styles.demoBadge}><Sparkles size={16} /><span>模拟数据</span><strong>零成本</strong></div>
      </header>

      <section className={styles.workspace}>
        <aside className={styles.taskRail} aria-label="本轮任务定位">
          <div className={styles.railTitle}><Gauge size={17} /><div><strong>任务定位</strong><span>点击 ID 可精准沟通</span></div></div>
          <div className={styles.taskList}>
            {taskItems.map((item) => <article key={item.id}>
              <button
                type="button"
                className={styles.taskIdButton}
                data-task-id={item.id}
                aria-label={`复制任务 ID ${item.id}`}
                title={`复制 ${item.id}`}
                onClick={() => void copyTaskId(item.id)}
              >
                <code>{item.id}</code>
                {copiedTaskId === item.id ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              </button>
              <strong>{item.label}</strong>
              <span data-status={item.status} aria-label={`状态：${item.status}`}>{item.status}</span>
            </article>)}
          </div>
          <p className={styles.copyFeedback} role="status" aria-live="polite">{copyFeedback}</p>
          <p className={styles.railNote}>“模拟验收”只代表当前 Demo 的交互成立，真实功能仍需单独跑 API、任务、存储和历史链。</p>
        </aside>

        <div className={styles.demoShell}>
          <div className={styles.tabs} role="tablist" aria-label="Demo 场景">
            <button role="tab" aria-selected={tab === "stream"} onClick={() => setTab("stream")}><MessageSquareText size={16} />流式回复</button>
            <button role="tab" aria-selected={tab === "video"} onClick={() => setTab("video")}><Film size={16} />视频生成与历史</button>
          </div>

          {tab === "stream" ? <section className={styles.streamPanel} aria-labelledby="stream-demo-title" data-testid="stream-demo-panel">
            <div className={styles.panelHeading}>
              <div><span>CHAT-STREAM-01 / 02</span><h2 id="stream-demo-title">首字快，后续稳，不憋整段</h2></div>
              <div className={styles.metrics}><span><Clock3 size={14} />首字 {firstTokenMs == null ? "—" : `${firstTokenMs}ms`}</span><span>目标节奏 44 字/秒</span></div>
            </div>
            <div className={styles.chatFrame}>
              <div className={styles.userMessage}>请把这个创意整理成可拍摄的短视频方案。</div>
              <div className={styles.agentMessage} aria-live="polite">
                <div className={styles.agentAvatar}>AI</div>
                <div>
                  <strong>内容策划智能体 <small>{streaming ? "正在持续输出" : streamOutput ? "输出完成" : "等待开始"}</small></strong>
                  <p data-testid="stream-demo-output">{streamOutput || "点击下方按钮，观察从提交到首字以及后续连续输出的节奏。"}{streaming && <i className={styles.caret} aria-hidden="true" />}</p>
                </div>
              </div>
            </div>
            <div className={styles.composer}>
              <span>模拟请求不会离开本机</span>
              <button type="button" data-testid="start-stream-demo" onClick={runStreamingDemo}><Send size={15} />{streaming ? "重新演示" : "开始流式演示"}</button>
            </div>
          </section> : <section className={styles.videoPanel} aria-labelledby="video-demo-title">
            <div className={styles.panelHeading}>
              <div><span>VIDEO-LIVE-01 / 02 · VIDEO-HISTORY-01</span><h2 id="video-demo-title">完成即出现，点击即播放</h2></div>
              <div className={styles.metrics}><span data-ready={videoStage === "ready"}>{stageLabel(videoStage)}</span><span>{videoProgress}%</span></div>
            </div>
            <div className={styles.flowSteps} aria-label="模拟视频流程">
              {["提交任务", "上游生成", "确认结果", "即时预览", "历史回填"].map((label, index) => {
                const completedSteps = videoStage === "ready" ? 5 : videoStage === "finalizing" ? 3 : videoStage === "rendering" ? 2 : videoStage === "queued" ? 1 : 0;
                const active = index < completedSteps;
                return <span key={label} data-active={active}><i>{active ? <Check size={12} /> : index + 1}</i>{label}</span>;
              })}
            </div>
            <div className={styles.videoGrid}>
              <article className={styles.previewCard}>
                <header><strong>实时预览</strong><span>{stageLabel(videoStage)}</span></header>
                <button type="button" data-testid="demo-video-preview" className={styles.posterButton} disabled={videoStage !== "ready"} onClick={(event) => openPreview(event.currentTarget)}>
                  <img src="/short-drama/previews/inspiration-product-film-v1.webp" alt="模拟视频预览封面" />
                  {videoStage === "ready" ? <span className={styles.playButton}><Play size={22} fill="currentColor" /></span> : <span className={styles.renderState}>{videoStage === "idle" ? "尚未生成" : `${videoProgress}%`}</span>}
                </button>
                <div className={styles.progress}><i style={{ width: `${videoProgress}%` }} /></div>
              </article>
              <article className={styles.historyCard}>
                <header><strong>作品历史</strong><span>实时同步</span></header>
                {videoStage === "ready" ? <button type="button" data-testid="demo-history-preview" onClick={(event) => openPreview(event.currentTarget)}>
                  <img src="/short-drama/previews/inspiration-product-film-v1.webp" alt="历史记录模拟缩略图" />
                  <span><strong>产品短片 · Demo 01</strong><small>刚刚完成 · 模拟直链</small></span>
                  <Play size={16} />
                </button> : <div className={styles.historyEmpty}>生成完成后，同一条结果会立即出现在这里，不要求刷新页面。</div>}
              </article>
            </div>
            <div className={styles.videoActions}>
              <span>本 Demo 不下载、不上传、不保存真实视频</span>
              <button type="button" data-testid="start-video-demo" onClick={runVideoDemo}><RotateCcw size={15} />{videoStage === "idle" ? "运行模拟流程" : "重新演示"}</button>
            </div>
          </section>}
        </div>
      </section>

      {previewOpen && createPortal(<div className={styles.lightbox} data-testid="demo-video-lightbox" role="dialog" aria-modal="true" aria-label="模拟视频放大预览" onMouseDown={(event) => event.target === event.currentTarget && setPreviewOpen(false)}>
        <div ref={previewRef} className={styles.playerDialog}>
          <header><div><span>模拟直链预览</span><strong>产品短片 · Demo 01</strong></div><button type="button" aria-label="关闭预览" onClick={() => setPreviewOpen(false)}><X size={18} /></button></header>
          <div className={`${styles.playerStage} ${playing ? styles.isPlaying : ""}`}>
            <video
              ref={videoRef}
              controls
              loop
              muted
              playsInline
              preload="metadata"
              poster="/short-drama/previews/hero-pipeline-v1.webp"
              style={{ transform: `scale(${zoom / 100})` }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            >
              <source src="/short-drama/hero-pipeline-loop-v1.webm" type="video/webm" />
              <source src="/short-drama/hero-pipeline-loop-v1.mp4" type="video/mp4" />
            </video>
            {!playing && <button type="button" className={styles.largePlay} onClick={() => void togglePlayback()}><Play size={30} fill="currentColor" /><span>播放模拟预览</span></button>}
          </div>
          <footer>
            <button type="button" onClick={() => void togglePlayback()}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "暂停" : "播放"}</button>
            <button type="button" aria-label="缩小" onClick={() => setZoom((value) => Math.max(70, value - 10))}><ZoomOut size={16} /></button>
            <span>{zoom}%</span>
            <button type="button" aria-label="放大" onClick={() => setZoom((value) => Math.min(140, value + 10))}><ZoomIn size={16} /></button>
            <button type="button" onClick={() => void requestFullscreen()}><Maximize2 size={16} />全屏</button>
            <span className={styles.fakeTimeline}><i className={playing ? styles.timelineMoving : ""} /></span>
            <Expand size={15} />
          </footer>
        </div>
      </div>, document.body)}
    </main>
  );
}
