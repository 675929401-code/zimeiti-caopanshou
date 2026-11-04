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
import {
  clearConfirmedClientSubmissionIdentity,
  fingerprintClientSubmission,
  resolveClientSubmissionIdentity,
  type ClientSubmissionIdentity,
} from "@/lib/short-drama/client-submission-identity";
import type { StandardizedScript } from "@/lib/short-drama/upload-script";
import { useShortDramaPaidReadiness } from "@/features/youcai-film-studio/use-short-drama-paid-readiness";
import { DEFAULT_VIDEO_STYLE } from "@/lib/short-drama/video-style-presets";
import styles from "./youcai-upload-script.module.css";
import guideStyles from "./youcai-upload-script-guide.module.css";

type Genre = "drama" | "short";

const GENRE_PROJECT_CONFIG = {
  drama: {
    profileId: "drama-script-upload",
    summaryGenre: "爽剧",
    videoSize: "9:16",
    aspectRatio: "9:16",
  },
  short: {
    profileId: "general-script-upload",
    summaryGenre: "短剧",
    videoSize: "16:9",
    aspectRatio: "16:9",
  },
} as const satisfies Record<Genre, {
  readonly profileId: string;
  readonly summaryGenre: string;
  readonly videoSize: "9:16" | "16:9";
  readonly aspectRatio: "9:16" | "16:9";
}>;

interface ParsedFile {
  readonly filename: string;
  readonly extension: "txt" | "md" | "docx";
  readonly text: string;
  readonly chars: number;
}

function readError(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  return typeof record.error === "string" && record.error.trim() ? record.error : fallback;
}

function requestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `upload-script-${uuid}`;
}

export function YoucaiUploadScript({
  backHref = "/youcai/tools/text",
  backLabel = "返回文本创作",
}: {
  backHref?: string;
  backLabel?: string;
} = {}) {
  const router = useAppScopedRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const standardizeIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const { state } = useApp();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [genre, setGenre] = useState<Genre>("drama");
  const [title, setTitle] = useState("");
  const [animationStyle, setAnimationStyle] = useState(DEFAULT_VIDEO_STYLE);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [result, setResult] = useState<StandardizedScript | null>(null);
  const [busy, setBusy] = useState<"parse" | "standardize" | "create" | null>(null);
  const [error, setError] = useState("");
  const paidReadiness = useShortDramaPaidReadiness();

  function authToken(): string {
    if (state.auth.token) return state.auth.token;
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("auth_token") || "";
  }

  async function chooseFile(selected?: File) {
    if (!selected) return;
    const token = authToken();
    if (!token) {
      setError("请先登录后上传剧本");
      return;
    }
    setBusy("parse");
    setError("");
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", selected);
      const response = await fetch("/api/short-drama/upload-script/parse", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (
        !response.ok
        || typeof payload !== "object"
        || payload === null
        || !("ok" in payload)
        || payload.ok !== true
        || !("file" in payload)
        || typeof payload.file !== "object"
        || payload.file === null
      ) {
        throw new Error(readError(payload, "剧本读取失败"));
      }
      const parsed = payload.file as ParsedFile;
      setFile(parsed);
      if (!title.trim()) setTitle(parsed.filename.replace(/\.(txt|md|docx)$/i, ""));
    } catch (cause) {
      setFile(null);
      setError(cause instanceof Error ? cause.message : "剧本读取失败");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function standardize() {
    if (!file || busy) return;
    const token = authToken();
    if (!token) {
      setError("请先登录后标准化剧本");
      return;
    }
    if (paidReadiness.status !== "ready") {
      setError(paidReadiness.status === "blocked"
        ? paidReadiness.message
        : "正在检查影视工坊服务状态，请稍后重试。");
      return;
    }
    setBusy("standardize");
    setStep(2);
    setError("");
    try {
      const standardizeRequest = {
        filename: file.filename,
        title,
        genre,
        text: file.text,
      };
      const identity = resolveClientSubmissionIdentity(
        standardizeIdentityRef.current,
        fingerprintClientSubmission(standardizeRequest),
        requestId,
      );
      standardizeIdentityRef.current = identity;
      const response = await fetch("/api/short-drama/upload-script/standardize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": identity.requestId,
        },
        body: JSON.stringify(standardizeRequest),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (
        !response.ok
        || typeof payload !== "object"
        || payload === null
        || !("ok" in payload)
        || payload.ok !== true
        || !("result" in payload)
        || typeof payload.result !== "object"
        || payload.result === null
      ) {
        throw new Error(readError(payload, "剧本标准化失败"));
      }
      const standardized = payload.result as StandardizedScript;
      standardizeIdentityRef.current = clearConfirmedClientSubmissionIdentity(
        standardizeIdentityRef.current,
        identity.requestId,
      );
      setResult(standardized);
      setTitle(standardized.title);
      setStep(3);
    } catch (cause) {
      setStep(1);
      setError(cause instanceof Error ? cause.message : "剧本标准化失败");
    } finally {
      setBusy(null);
    }
  }

  async function createProject() {
    if (!result || busy) return;
    const token = authToken();
    if (!token) {
      setError("请先登录后创建影视项目");
      return;
    }
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          clientRequestId: requestId(),
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
      const payload: unknown = await response.json().catch(() => ({}));
      const projectId = typeof payload === "object"
        && payload !== null
        && "project" in payload
        && typeof payload.project === "object"
        && payload.project !== null
        && "id" in payload.project
        && typeof payload.project.id === "string"
        ? payload.project.id
        : "";
      if (!response.ok || !projectId) throw new Error(readError(payload, "影视项目创建失败"));
      router.push(`/youcai/tools/film-studio/projects/${encodeURIComponent(projectId)}?step=script`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "影视项目创建失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.page} data-testid="youcai-upload-script">
      <Link href={backHref} className={styles.back}>
        <ArrowLeft size={15} aria-hidden="true" />{backLabel}
      </Link>

      <header className={styles.header}>
        <h1><Upload size={30} aria-hidden="true" />上传剧本</h1>
        <p>上传已有剧本文件（TXT/MD/DOCX），AI自动转为平台标准格式</p>
        <div className={styles.steps} aria-label="上传剧本步骤">
          {["上传剧本", "格式标准化", "预览确认"].map((label, index) => {
            const number = (index + 1) as 1 | 2 | 3;
            return (
              <div
                className={styles.step}
                data-active={step === number}
                data-done={step > number}
                key={label}
              >
                <span>{step > number ? <Check size={14} /> : number}</span>
                {label}
                {index < 2 && <b>→</b>}
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
              {busy === "parse"
                ? <Loader2 className={styles.spin} size={34} />
                : <Upload size={38} />}
              <strong>{file ? file.filename : "拖拽文件到此处，或点击选择"}</strong>
              <span>{file
                ? `${file.extension.toUpperCase()} · ${file.chars.toLocaleString("zh-CN")} 字`
                : "支持 TXT、MD、DOCX，最大 1MB（不超过 10 万字）"}</span>
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
                <span>🔥</span><strong>爽剧</strong><small>爽点模型的网络短剧</small>
                {genre === "drama" && <Check />}
              </button>
              <button
                type="button"
                className={genre === "short" ? "brand-action" : undefined}
                aria-pressed={genre === "short"}
                data-active={genre === "short"}
                onClick={() => setGenre("short")}
              >
                <span>🎬</span><strong>短剧</strong><small>通用剧本，童话/改编/原创</small>
                {genre === "short" && <Check />}
              </button>
            </div>
            <label className={styles.titleField}>
              剧名（可选，不填 AI 自拟）
              <input
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="输入剧名..."
              />
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

          {paidReadiness.status !== "ready" && (
            <div className={styles.error} role="status" data-paid-readiness={paidReadiness.status}>
              <AlertTriangle size={18} />
              {paidReadiness.status === "blocked"
                ? paidReadiness.message
                : "正在检查影视工坊服务状态…"}
            </div>
          )}
          <div className={styles.primaryRow}>
            <button
              type="button"
              className={styles.primary}
              disabled={!file || busy !== null || paidReadiness.status !== "ready"}
              onClick={() => void standardize()}
            >
              {busy === "standardize" && <Loader2 className={styles.spin} size={18} />}
              格式标准化
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <section className={styles.processing}>
          <Loader2 className={styles.spin} size={38} />
          <h2>正在标准化剧本格式</h2>
          <p>正在整理场景标注、动作和对白格式，不补写内容。</p>
        </section>
      )}

      {step === 3 && result && (
        <section className={styles.previewPanel}>
          <div className={styles.previewHeader}>
            <div>
              <span>标准化完成</span>
              <h2>{result.title}</h2>
              <p>{result.episodes.length} 集 · {result.standardizedText.length.toLocaleString("zh-CN")} 字</p>
            </div>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setStep(1);
                setResult(null);
              }}
            >
              返回修改
            </button>
          </div>
          <div className={styles.qualityGrid}>
            {Object.entries({
              场景标注: result.quality.sceneLabels,
              动作描述: result.quality.actionDescriptions,
              对白格式: result.quality.dialogueFormat,
              视频适配: result.quality.videoReadiness,
            }).map(([label, value]) => (
              <div key={label}><strong>{value}</strong><span>{label}</span></div>
            ))}
          </div>
          <textarea
            className={styles.previewText}
            value={result.standardizedText}
            readOnly
            aria-label="标准化剧本预览"
          />
          <div className={styles.primaryRow}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy !== null}
              onClick={() => void createProject()}
            >
              {busy === "create"
                ? <Loader2 className={styles.spin} size={18} />
                : <Clapperboard size={18} />}
              进入影视工坊
            </button>
          </div>
        </section>
      )}

      <section className={styles.guide}>
        <h2>🧩 使用指南</h2>
        <p>上传已有剧本，AI自动转为平台标准格式</p>
        <div className={`${styles.flow} ${guideStyles.flow}`}>
          <div className={guideStyles.flowHeader}>
            <h3>📄 上传剧本流程</h3>
            <p>将已有剧本转为平台标准格式后，可在影视工坊中继续全流程创作。</p>
          </div>
          <div><b>1</b><strong>上传剧本</strong><span>上传 TXT/MD/DOCX 文件，选择剧本类型</span></div>
          <div><b>2</b><strong>格式标准化</strong><span>AI 保留原文内容，只标准化格式标记和排版</span></div>
          <div><b>3</b><strong>进入工坊</strong><span>确认后进入影视工坊，续写/角色/分镜全流程</span></div>
        </div>
      </section>

      <section className={`${styles.warning} ${guideStyles.warning}`}>
        <AlertTriangle size={22} />
        <div>
          <h3>重要：请上传剧本而非大纲</h3>
          <small>格式标准化只处理格式，不创作内容</small>
          <div className={guideStyles.warningDetails}>
            <p><strong>上传的必须是完整剧本</strong>（包含场次、对话、动作描述），AI 只会标准化格式标记，不会补充内容。</p>
            <p><strong>如果你只有故事大纲</strong>（故事梗概、章节概要），请使用爽剧剧本创作或通用短剧创作，AI 会根据大纲创作完整剧本。</p>
            <p className={guideStyles.warningDifference}>区别：剧本有完整场次和对白；大纲只有故事脉络和情节概要。</p>
          </div>
        </div>
      </section>

      <div className={`${styles.infoGrid} ${guideStyles.infoGrid}`}>
        <article><FileText /><h3>文件要求</h3><small>支持的格式和限制</small><p><span>支持 TXT、MD、DOCX 格式，文件不超过 1MB（约 10 万字）</span><span>上传后可预览前 2000 字，确认内容无误再提交</span></p></article>
        <article><BookOpen /><h3>格式标准化</h3><small>AI 只改格式不改内容</small><p><span>AI 保留原始场次、对白、情节，只标准化格式标记</span><span>处理需要 3-45 分钟（视剧本长度），完成后自动显示结果</span></p></article>
        <article><BarChart3 /><h3>质量评估</h3><small>四维度评分 + 改进建议</small><p><span>从场景标注、动作描述、对话格式、视频生成适配度四个维度评分</span><span>列出具体问题和建议，方便你了解剧本格式质量</span></p></article>
        <article><Clapperboard /><h3>进入影视工坊</h3><small>全流程创作</small><p><span>格式化后的剧本可直接进入影视工坊继续创作</span><span>支持续写、重写、角色提取、分镜创作、视频生成全流程</span></p></article>
      </div>

      <footer className={styles.footer}>
        © 2026 漫剧工作台 · 关于我们 · 商务合作
      </footer>
    </div>
  );
}
