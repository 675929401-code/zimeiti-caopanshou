"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Check,
  Clapperboard,
  FileText,
  Loader2,
  Upload,
} from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { VideoStylePicker } from "@/components/video-style-picker";
import { DEFAULT_VIDEO_STYLE } from "@/lib/short-drama/video-style-presets";
import type { StandardizedScript } from "@/lib/short-drama/upload-script";
import {
  clearConfirmedClientSubmissionIdentity,
  fingerprintClientSubmission,
  resolveClientSubmissionIdentity,
  type ClientSubmissionIdentity,
} from "@/lib/short-drama/client-submission-identity";
import styles from "./upload-script.module.css";

type Genre = "drama" | "short" | "formal";

const GENRE_PROJECT_CONFIG = {
  drama: {
    profileId: "drama-script-upload",
    summaryGenre: "爽剧",
    videoSize: "9:16",
    aspectRatio: "9:16",
    animationStyle: "",
  },
  short: {
    profileId: "general-script-upload",
    summaryGenre: "短剧",
    videoSize: "16:9",
    aspectRatio: "16:9",
    animationStyle: "",
  },
  formal: {
    profileId: "formal-drama-upload",
    summaryGenre: "正剧",
    videoSize: "16:9",
    aspectRatio: "16:9",
    animationStyle: "传统影视正剧",
  },
} as const satisfies Record<Genre, {
  profileId: string;
  summaryGenre: string;
  videoSize: "9:16" | "16:9";
  aspectRatio: "9:16" | "16:9";
  animationStyle: string;
}>;

interface ParsedFile {
  filename: string;
  extension: "txt" | "md" | "docx";
  text: string;
  chars: number;
}

function asError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  return typeof record.error === "string" && record.error.trim() ? record.error : fallback;
}

function requestId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

export function UploadScriptWorkbench() {
  const router = useAppScopedRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const standardizeIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const { state } = useApp();
  const authToken = state.auth?.token || "";
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [genre, setGenre] = useState<Genre>("drama");
  const [title, setTitle] = useState("");
  const [animationStyle, setAnimationStyle] = useState(DEFAULT_VIDEO_STYLE);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [result, setResult] = useState<StandardizedScript | null>(null);
  const [busy, setBusy] = useState<"parse" | "standardize" | "create" | null>(null);
  const [error, setError] = useState("");

  const chooseFile = async (selected?: File) => {
    if (!selected) return;
    if (!authToken) {
      setError("请先登录后上传剧本");
      return;
    }
    setBusy("parse");
    setError("");
    setResult(null);
    standardizeIdentityRef.current = null;
    try {
      const formData = new FormData();
      formData.append("file", selected);
      const response = await fetch("/api/short-drama/upload-script/parse", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
        body: formData,
      });
      const payload = await response.json() as { ok?: boolean; file?: ParsedFile; error?: string };
      if (!response.ok || !payload.ok || !payload.file) throw new Error(asError(payload, "剧本读取失败"));
      setFile(payload.file);
      if (!title.trim()) setTitle(payload.file.filename.replace(/\.(txt|md|docx)$/i, ""));
    } catch (cause) {
      setFile(null);
      setError(cause instanceof Error ? cause.message : "剧本读取失败");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const standardize = async () => {
    if (!file || busy) return;
    if (!authToken) return setError("请先登录后标准化剧本");
    setBusy("standardize");
    setStep(2);
    setError("");
    try {
      const standardizeRequest = { filename: file.filename, title, genre, text: file.text };
      const identity = resolveClientSubmissionIdentity(
        standardizeIdentityRef.current,
        fingerprintClientSubmission(standardizeRequest),
        () => requestId("upload-standardize"),
      );
      standardizeIdentityRef.current = identity;
      const response = await fetch("/api/short-drama/upload-script/standardize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          "Idempotency-Key": identity.requestId,
        },
        body: JSON.stringify(standardizeRequest),
      });
      const payload = await response.json() as { ok?: boolean; result?: StandardizedScript; error?: string };
      if (!response.ok || !payload.ok || !payload.result) throw new Error(asError(payload, "剧本标准化失败"));
      standardizeIdentityRef.current = clearConfirmedClientSubmissionIdentity(
        standardizeIdentityRef.current,
        identity.requestId,
      );
      setResult(payload.result);
      setTitle(payload.result.title);
      setStep(3);
    } catch (cause) {
      setStep(1);
      setError(cause instanceof Error ? cause.message : "剧本标准化失败");
    } finally {
      setBusy(null);
    }
  };

  const createProject = async () => {
    if (!result || busy) return;
    if (!authToken) return setError("请先登录后创建影视项目");
    setBusy("create");
    setError("");
    try {
      const projectConfig = GENRE_PROJECT_CONFIG[genre];
      const episodes = result.episodes.map((episode) => ({
        ...episode,
        logline: "由上传剧本标准化导入",
        endingHook: "",
        estimatedDurationSeconds: 0,
        characterNames: [] as string[],
        sceneNames: [] as string[],
        propNames: [] as string[],
      }));
      const response = await fetch("/api/short-drama/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          clientRequestId: requestId("upload-script"),
          title: result.title,
          description: result.standardizedText.slice(0, 1_800),
          projectType: "short_drama",
          sourcePayload: {
            schemaVersion: "uploaded-script.v1",
            profileId: projectConfig.profileId,
            operation: "import",
            summary: {
              title: result.title,
              synopsis: result.standardizedText.slice(0, 500),
              genre: projectConfig.summaryGenre,
              videoSize: projectConfig.videoSize,
              animationStyle,
            },
            episodes,
            characters: [],
            scenes: [],
            props: [],
            originalFilename: file?.filename || "",
            quality: result.quality,
            issues: result.issues,
            suggestions: result.suggestions,
            currentStage: "剧本",
            progress: 0,
          },
          settings: {
            aspectRatio: projectConfig.aspectRatio,
            outputLanguage: "zh-CN",
            animationStyle,
            noCharacterSpeech: false,
            defaultShotDurationSeconds: 5,
          },
        }),
      });
      const payload = await response.json() as { project?: { id?: string }; error?: string };
      const projectId = payload.project?.id;
      if (!response.ok || !projectId) throw new Error(asError(payload, "影视项目创建失败"));
      router.push(`/tools/film-studio/projects/${encodeURIComponent(projectId)}?step=script`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "影视项目创建失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.page} data-testid="upload-script-workbench">
      <Link href="/tools/text" className={styles.back}><ArrowLeft size={15} />返回文本创作</Link>

      <header className={styles.header}>
        <h1><Upload size={30} />上传剧本</h1>
        <p>上传已有剧本文件（TXT/MD/DOCX），AI 只规范格式，不补写内容</p>
        <div className={styles.steps} aria-label="上传剧本步骤">
          {["上传剧本", "格式标准化", "预览确认"].map((label, index) => {
            const number = (index + 1) as 1 | 2 | 3;
            return (
              <div className={styles.step} data-active={step === number} data-done={step > number} key={label}>
                <span>{step > number ? <Check size={14} /> : number}</span>{label}{index < 2 && <b>→</b>}
              </div>
            );
          })}
        </div>
      </header>

      {error && <div className={styles.error} role="alert"><AlertTriangle size={18} />{error}</div>}

      {step === 1 && (
        <>
          <section className={styles.panel}>
            <h2>上传剧本文件</h2>
            <button
              type="button"
              className={styles.dropzone}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void chooseFile(event.dataTransfer.files[0]);
              }}
              disabled={busy !== null}
            >
              {busy === "parse" ? <Loader2 className={styles.spin} size={34} /> : <Upload size={38} />}
              <strong>{file ? file.filename : "拖拽文件到此处，或点击选择"}</strong>
              <span>{file ? `${file.extension.toUpperCase()} · ${file.chars.toLocaleString("zh-CN")} 字` : "支持 TXT、MD、DOCX，最大 1MB（不超过 10 万字）"}</span>
              <em>{file ? "重新选择" : "选择文件"}</em>
            </button>
            <input
              ref={inputRef}
              className={styles.fileInput}
              type="file"
              accept=".txt,.md,.docx,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
          </section>

          <section className={styles.panel}>
            <h2>选择剧本类型</h2>
            <div className={styles.genreGrid}>
              <button
                type="button"
                className={genre === "drama" ? "brand-action" : undefined}
                aria-pressed={genre === "drama"}
                data-active={genre === "drama"}
                onClick={() => setGenre("drama")}
              >
                <span>🔥</span><strong>爽剧</strong><small>爽点模型的网络短剧</small>{genre === "drama" && <Check />}
              </button>
              <button
                type="button"
                className={genre === "short" ? "brand-action" : undefined}
                aria-pressed={genre === "short"}
                data-active={genre === "short"}
                onClick={() => setGenre("short")}
              >
                <span>🎬</span><strong>短剧</strong><small>通用剧本、童话/改编/原创</small>{genre === "short" && <Check />}
              </button>
              <button type="button" data-active={genre === "formal"} onClick={() => setGenre("formal")}>
                <span>📖</span><strong>正剧</strong><small>单集 10 分钟以上的传统影视剧本</small>{genre === "formal" && <Check />}
              </button>
            </div>
            <label className={styles.titleField}>剧名（可选，不填 AI 自拟）
              <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="输入剧名..." />
            </label>
            <div className={styles.styleField}>
              <span>视觉风格 <small>39 种预设或自定义，后续生图和视频会沿用</small></span>
              <VideoStylePicker
                value={animationStyle}
                onChange={setAnimationStyle}
                ariaLabel="上传剧本项目视觉风格"
              />
            </div>
          </section>

          <div className={styles.primaryRow}>
            <button type="button" className={styles.primary} disabled={!file || busy !== null} onClick={() => void standardize()}>
              {busy === "standardize" ? <Loader2 className={styles.spin} size={18} /> : null}格式标准化
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <section className={styles.processing}>
          <Loader2 className={styles.spin} size={38} />
          <h2>正在标准化剧本格式</h2>
          <p>主站文案模型正在整理场景标注、动作和对白格式，不会补写内容。</p>
        </section>
      )}

      {step === 3 && result && (
        <section className={styles.previewPanel}>
          <div className={styles.previewHeader}>
            <div><span>标准化完成</span><h2>{result.title}</h2><p>{result.episodes.length} 集 · {result.standardizedText.length.toLocaleString("zh-CN")} 字</p></div>
            <button type="button" className={styles.secondary} onClick={() => { setStep(1); setResult(null); }}>返回修改</button>
          </div>
          <div className={styles.qualityGrid}>
            {Object.entries({ 场景标注: result.quality.sceneLabels, 动作描述: result.quality.actionDescriptions, 对白格式: result.quality.dialogueFormat, 视频适配: result.quality.videoReadiness }).map(([label, value]) => (
              <div key={label}><strong>{value}</strong><span>{label}</span></div>
            ))}
          </div>
          <textarea className={styles.previewText} value={result.standardizedText} readOnly aria-label="标准化剧本预览" />
          <div className={styles.primaryRow}>
            <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void createProject()}>
              {busy === "create" ? <Loader2 className={styles.spin} size={18} /> : <Clapperboard size={18} />}
              进入影视工坊
            </button>
          </div>
        </section>
      )}

      <section className={styles.guide}>
        <h2>🧩 使用指南</h2>
        <p>上传已有剧本，标准化为平台可继续制作的项目格式</p>
        <div className={styles.flow}>
          {["上传剧本", "格式标准化", "进入工坊"].map((label, index) => <div key={label}><b>{index + 1}</b><strong>{label}</strong><span>{index === 0 ? "上传 TXT/MD/DOCX" : index === 1 ? "保留原文，只规范格式" : "继续角色/分镜/成片"}</span></div>)}
        </div>
      </section>

      <section className={styles.warning}>
        <AlertTriangle size={22} /><div><h3>重要：请上传剧本而非大纲</h3><p>格式标准化只处理格式，不创作内容。只有故事大纲时，请使用爽剧、通用短剧或正剧创作。</p></div>
      </section>

      <div className={styles.infoGrid}>
        <article><FileText /><h3>文件要求</h3><p>TXT、MD、DOCX；不超过 1MB 和 10 万字。</p></article>
        <article><BookOpen /><h3>格式标准化</h3><p>保留原始场次、对白和情节，只整理格式标记。</p></article>
        <article><BarChart3 /><h3>质量评估</h3><p>从场景、动作、对白和视频适配四个维度给出检查结果。</p></article>
        <article><Clapperboard /><h3>进入影视工坊</h3><p>确认后创建真实项目，继续剧本、角色、场景、分镜和成片。</p></article>
      </div>

      <footer className={styles.footer}>© 2026 自媒体操盘手 · 影视创作工坊</footer>
    </div>
  );
}
