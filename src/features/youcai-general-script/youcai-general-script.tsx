"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clapperboard,
  FileText,
  Film,
  FolderOpen,
  ImageIcon,
  Loader2,
  PenLine,
  Sparkles,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useApp } from "@/contexts/app-context";
import { VideoStylePicker } from "@/components/video-style-picker";
import { resolveWorkbenchIdentity, workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { readGeneralScriptSubmission, saveGeneralScriptSubmission, clearGeneralScriptSubmission } from "@/features/general-script/submission-storage";
import { GeneralScriptHistoryPanel } from "@/features/general-script/general-script-history-panel";
import {
  GENERAL_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_PROFILE_VERSION,
  parseGeneralScriptResult,
  type GeneralScriptAudience,
  type GeneralScriptCreationMode,
  type GeneralScriptRequest,
  type GeneralScriptResult,
  type GeneralScriptTone,
} from "@/lib/short-drama/general-script-contract";
import {
  clearConfirmedClientSubmissionIdentity,
  resolveClientSubmissionIdentity,
  type ClientSubmissionIdentity,
} from "@/lib/short-drama/client-submission-identity";
import { buildClientRequestFingerprint } from "@/lib/browser-client-attempt";
import { toYoucaiHref } from "@/lib/youcai-routes";
import { useShortDramaPaidReadiness } from "@/features/youcai-film-studio/use-short-drama-paid-readiness";
import {
  DEFAULT_VIDEO_STYLE,
  getVideoStyleLabel,
} from "@/lib/short-drama/video-style-presets";
import styles from "./youcai-general-script.module.css";

const MAX_TEXT_LENGTH = 100_000;
const DRAFT_KEY = "youcai_general_script_draft_v1";

type WizardStep = 1 | 2 | 3;
type WizardTone = GeneralScriptTone | "adventure";

interface Draft {
  readonly schemaVersion: 1;
  readonly creationMode: GeneralScriptCreationMode;
  readonly targetAudience: GeneralScriptAudience;
  readonly tone: WizardTone;
  readonly customTone: string;
  readonly animationStyle: string;
  readonly episodesToGenerate: number;
  readonly totalEpisodes: string;
  readonly sourceMaterial: string;
  readonly requirements: string;
}

type Workflow =
  | { readonly status: "idle" }
  | { readonly status: "working"; readonly phase: "generating" | "saving" }
  | { readonly status: "error"; readonly phase: "generating" | "saving"; readonly message: string }
  | { readonly status: "success"; readonly href: string };

interface GeneratedCandidate {
  readonly clientRequestId: string;
  readonly result: GeneralScriptResult;
}

interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly emoji: string;
}

interface GuideCard {
  readonly icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  readonly title: string;
  readonly subtitle: string;
  readonly tone: "orange" | "violet" | "blue";
  readonly points: readonly string[];
}

const DEFAULT_DRAFT: Draft = {
  schemaVersion: 1,
  creationMode: "original",
  targetAudience: "all_ages",
  tone: "warm",
  customTone: "",
  animationStyle: DEFAULT_VIDEO_STYLE,
  episodesToGenerate: 5,
  totalEpisodes: "",
  sourceMaterial: "",
  requirements: "",
};

function draftFromHistoryRequest(request: GeneralScriptRequest): Draft {
  const tone: WizardTone = request.settings.tone === "custom" && request.settings.customTone === "冒险"
    ? "adventure"
    : request.settings.tone;
  return {
    ...DEFAULT_DRAFT,
    creationMode: request.settings.creationMode,
    targetAudience: request.settings.targetAudience,
    tone,
    customTone: tone === "adventure" ? "" : request.settings.customTone,
    animationStyle: request.settings.animationStyle,
    episodesToGenerate: request.settings.episodesToGenerate,
    totalEpisodes: request.settings.totalEpisodes === null ? "" : String(request.settings.totalEpisodes),
    sourceMaterial: request.content.sourceMaterial,
    requirements: request.content.requirements || request.content.brief,
  };
}

const AUDIENCES: readonly Choice<GeneralScriptAudience>[] = [
  { value: "all_ages", label: "全年龄", emoji: "🌍" },
  { value: "children", label: "儿童", emoji: "👦" },
  { value: "teen", label: "青少年", emoji: "👦" },
  { value: "adult", label: "成人", emoji: "👨" },
];

const TONES: readonly Choice<WizardTone>[] = [
  { value: "warm", label: "温馨", emoji: "💕" },
  { value: "suspense", label: "悬疑", emoji: "🔍" },
  { value: "comedy", label: "幽默", emoji: "😁" },
  { value: "inspiring", label: "励志", emoji: "💪" },
  { value: "adventure", label: "冒险", emoji: "🗺️" },
  { value: "custom", label: "自定义", emoji: "🖊️" },
];

const FLOW_STEPS = [
  { number: 1, icon: PenLine, title: "创作剧本", description: "AI 生成多集剧本，可续写、重写、随时剧终" },
  { number: 2, icon: FileText, title: "定稿剧本", description: "逐集编辑定稿，可边创作边定稿前面的集" },
  { number: 3, icon: Users, title: "角色场景", description: "编辑角色场景，生成形象图、音色和场景图" },
  { number: 4, icon: Clapperboard, title: "分集视频", description: "一键切分片段，使用角色场景素材创作视频" },
  { number: 5, icon: Film, title: "剪辑成片", description: "片段拼接微调，去穿帮、加效果并输出成片" },
] as const;

const GUIDE_CARDS: readonly GuideCard[] = [
  {
    icon: PenLine,
    title: "创作剧本",
    subtitle: "灵活的创作方式",
    tone: "orange",
    points: [
      "可重写任意一集或多集，不影响其他集内容",
      "有明确总集数请指定，建议不超过 50 集，质量更可控",
      "续写时勾选“本次续写后剧终”即可随时收尾",
    ],
  },
  {
    icon: FileText,
    title: "持续创作",
    subtitle: "不需要一次完成",
    tone: "violet",
    points: [
      "连载剧本随时在创意工坊继续创作",
      "可以边创作新集，边对已定稿的集继续后续工作",
      "每一步都可反复修改，AI 自动保持上下文连贯",
    ],
  },
  {
    icon: Users,
    title: "角色与素材",
    subtitle: "管理同步生成的角色和场景",
    tone: "orange",
    points: [
      "剧本创作时同步生成角色、场景和道具资料",
      "自动生成角色形象图、参考音色、场景图片",
      "所有素材描述都支持二次编辑修改",
    ],
  },
  {
    icon: ImageIcon,
    title: "视频制作",
    subtitle: "从片段到成片",
    tone: "blue",
    points: [
      "一键切分分镜片段脚本，使用角色场景素材制作片段视频",
      "片段视频自动包含配音、字幕和背景音乐",
      "剪辑成片进行去穿帮、加镜头效果等后期微调",
    ],
  },
];

const REQUIREMENTS_PLACEHOLDER = `描述你想要的短剧内容，例如：

【主角设定】
• 姓名、年龄、身份、性格特点

【故事框架】
• 开端：主角的初始处境
• 发展：遇到的挑战和转折
• 结局：最终结果

【风格与补充】
• 故事基调（温馨/悬疑/热血/治愈等）
• 特殊要求（如参考某部作品风格）`;

const ORIGINAL_REFERENCE_PLACEHOLDER = `粘贴参考素材（可选），AI 会参考其写作风格和氛围创作全新故事，不会照搬原文内容。

注意：与「改编」模式不同，这里 AI 只借鉴风格，人物和情节全部重新创作。

如需基于原文改编，请切换到「素材驱动·改编」模式。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(response: Response): Promise<unknown> {
  return response.text().then((text) => {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { error: text.slice(0, 500) };
    }
  });
}

function readError(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  for (const key of ["error", "message", "detail"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return fallback;
}

function readProjectHref(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["href", "projectHref", "redirectTo"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string"
      && candidate.startsWith("/tools/film-studio/projects/")
      && !candidate.startsWith("//")
    ) {
      return toYoucaiHref(candidate);
    }
  }
  for (const key of ["data", "project"]) {
    const nested = readProjectHref(value[key]);
    if (nested) return nested;
  }
  return "";
}

function clientRequestId(): string {
  return `general-script-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function YoucaiGeneralScript({
  backHref = "/youcai/tools/text",
  backLabel = "返回文本创作",
}: {
  backHref?: string;
  backLabel?: string;
} = {}) {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div className={styles.page}><p role="status">请先登录后查看自己的剧本草稿。</p></div>;
  return <UserYoucaiGeneralScript key={identity.userId} backHref={backHref} backLabel={backLabel} identity={identity} />;
}

function UserYoucaiGeneralScript({ backHref, backLabel, identity }: {
  backHref: string; backLabel: string; identity: WorkbenchIdentity;
}) {
  const storageKey = workbenchUserStorageKey(DRAFT_KEY, identity.userId);
  const controllerRef = useRef<AbortController | null>(null);
  const generationIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [workflow, setWorkflow] = useState<Workflow>({ status: "idle" });
  const [candidate, setCandidate] = useState<GeneratedCandidate | null>(null);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);
  const paidReadiness = useShortDramaPaidReadiness();

  useEffect(() => {
    setDraft(DEFAULT_DRAFT);
    try { window.localStorage.removeItem(storageKey); } catch { /* The in-memory editor is already clean. */ }
    generationIdentityRef.current = readGeneralScriptSubmission(DRAFT_KEY, identity.userId);
    return () => controllerRef.current?.abort();
  }, [identity.userId, storageKey]);

  const selectedAudience = useMemo(
    () => AUDIENCES.find((option) => option.value === draft.targetAudience) ?? AUDIENCES[0],
    [draft.targetAudience],
  );
  const selectedTone = useMemo(
    () => TONES.find((option) => option.value === draft.tone) ?? TONES[0],
    [draft.tone],
  );

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    if (Object.is(draft[key], value)) return;
    setDraft((current) => ({ ...current, [key]: value }));
    if (workflow.status !== "working") setWorkflow({ status: "idle" });
    setCandidate(null);
  }

  function validationError(): string {
    if (draft.tone === "custom" && !draft.customTone.trim()) return "请填写自定义故事基调。";
    if (draft.totalEpisodes) {
      const total = Number(draft.totalEpisodes);
      if (!Number.isInteger(total) || total < draft.episodesToGenerate || total > 500) {
        return "总集数需大于等于本次生成集数，且不能超过 500 集。";
      }
    }
    if (draft.creationMode === "adaptation" && !draft.sourceMaterial.trim()) {
      return "素材驱动改编需要提供原文素材。";
    }
    if (!draft.requirements.trim()) return "请先填写故事需求描述。";
    return "";
  }

  function goToRequirements() {
    if (draft.tone === "custom" && !draft.customTone.trim()) {
      setWorkflow({ status: "error", phase: "generating", message: "请填写自定义故事基调。" });
      return;
    }
    setWorkflow({ status: "idle" });
    setStep(2);
  }

  function loadHistoryRetry(request: GeneralScriptRequest, failedRequestId: string) {
    generationIdentityRef.current = null;
    clearGeneralScriptSubmission(DRAFT_KEY, identity.userId, failedRequestId);
    setCandidate(null);
    setDraft(draftFromHistoryRequest(request));
    setWorkflow({ status: "idle" });
    setStep(2);
  }

  function loadHistoryResult(result: GeneralScriptResult, clientRequestId: string) {
    setCandidate({ result, clientRequestId });
    setWorkflow({
      status: "error",
      phase: "saving",
      message: "已从账号历史载入生成结果。确认后可继续保存到影视项目。",
    });
    setStep(3);
  }

  async function saveProject(generated: GeneratedCandidate, token: string, signal: AbortSignal) {
    setWorkflow({ status: "working", phase: "saving" });
    const response = await fetch("/api/short-drama/projects/import-script", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        title: generated.result.summary.title,
        clientRequestId: generated.clientRequestId,
        result: generated.result,
      }),
      signal,
    });
    const payload = await readJson(response);
    if (!response.ok || (isRecord(payload) && payload.ok === false)) {
      throw new Error(readError(payload, "项目保存失败，请稍后重试。"));
    }
    const href = readProjectHref(payload);
    if (!href) throw new Error("项目保存完成，但未返回项目地址。");
    return href;
  }

  async function generate() {
    if (paidReadiness.status !== "ready") {
      setWorkflow({
        status: "error",
        phase: "generating",
        message: paidReadiness.status === "blocked"
          ? paidReadiness.message
          : "正在检查影视工坊服务状态，请稍后重试。",
      });
      return;
    }
    const message = validationError();
    if (message) {
      setWorkflow({ status: "error", phase: "generating", message });
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const token = identity.token;
    const generationRequest = {
      profile: {
        id: GENERAL_SCRIPT_PROFILE_ID,
        version: GENERAL_SCRIPT_PROFILE_VERSION,
      },
      operation: "generate" as const,
      settings: {
        creationMode: draft.creationMode,
        targetAudience: draft.targetAudience,
        tone: draft.tone === "adventure" ? "custom" as const : draft.tone,
        customTone: draft.tone === "adventure" ? "冒险" : draft.customTone,
        genre: "通用短剧",
        animationStyle: draft.animationStyle,
        videoSize: "16:9" as const,
        episodesToGenerate: draft.episodesToGenerate,
        totalEpisodes: draft.totalEpisodes ? Number(draft.totalEpisodes) : null,
        isFinale: false,
      },
      content: {
        title: "",
        brief: draft.requirements.trim(),
        sourceMaterial: draft.sourceMaterial.trim(),
        requirements: draft.requirements.trim(),
      },
      rewriteEpisodeNumbers: [] as number[],
      rewriteInstruction: "",
    };
    const submissionIdentity = resolveClientSubmissionIdentity(
      generationIdentityRef.current,
      await buildClientRequestFingerprint(generationRequest),
      clientRequestId,
    );
    generationIdentityRef.current = submissionIdentity;
    const requestId = submissionIdentity.requestId;
    let phase: "generating" | "saving" = "generating";
    setStep(3);
    setWorkflow({ status: "working", phase: "generating" });
    setCandidate(null);

    try {
      saveGeneralScriptSubmission(DRAFT_KEY, identity.userId, submissionIdentity);
      const response = await fetch("/api/short-drama/script", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Idempotency-Key": requestId,
          "X-General-Script-Surface": "youcai",
        },
        body: JSON.stringify(generationRequest),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new Error(readError(payload, "剧本生成失败，请稍后重试。"));
      }
      const parsedResult = parseGeneralScriptResult(payload.result);
      if (controller.signal.aborted) return;
      const generated = {
        clientRequestId: requestId,
        result: parsedResult,
      } satisfies GeneratedCandidate;
      setCandidate(generated);
      phase = "saving";
      const href = await saveProject(generated, token, controller.signal);
      if (controller.signal.aborted) return;
      generationIdentityRef.current = clearConfirmedClientSubmissionIdentity(generationIdentityRef.current, requestId);
      clearGeneralScriptSubmission(DRAFT_KEY, identity.userId, requestId);
      setWorkflow({ status: "success", href });
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // The project is already saved.
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setWorkflow({
          status: "error",
          phase,
          message: error instanceof Error ? error.message : "剧本创建失败，请稍后重试。",
        });
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setHistoryRefreshNonce((value) => value + 1);
    }
  }

  async function retrySave() {
    if (!candidate) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const token = identity.token;
    try {
      const href = await saveProject(candidate, token, controller.signal);
      if (controller.signal.aborted) return;
      generationIdentityRef.current = clearConfirmedClientSubmissionIdentity(generationIdentityRef.current, candidate.clientRequestId);
      clearGeneralScriptSubmission(DRAFT_KEY, identity.userId, candidate.clientRequestId);
      setWorkflow({ status: "success", href });
    } catch (error) {
      if (!controller.signal.aborted) {
        setWorkflow({
          status: "error",
          phase: "saving",
          message: error instanceof Error ? error.message : "项目保存失败，请稍后重试。",
        });
      }
    }
  }

  return (
    <div
      className={styles.page}
      data-testid="youcai-general-script"
      data-profile-id={GENERAL_SCRIPT_PROFILE_ID}
    >
      <div className={styles.pageInner}>
        <header className={styles.hero}>
          <Link className={styles.backLink} href={backHref}>
            <ArrowLeft size={15} aria-hidden="true" />
            {backLabel}
          </Link>
          <div className={styles.heroCopy}>
            <h1><FolderOpen size={31} aria-hidden="true" /> 通用短剧创作</h1>
            <p>需求驱动原创或素材驱动改编，支持童话、小说等多种剧本类型</p>
          </div>
          <ol className={styles.progress} aria-label="通用短剧创作步骤">
            {[1, 2, 3].map((item) => (
              <li
                className={styles.progressStep}
                data-active={item === step ? "true" : undefined}
                data-complete={item < step ? "true" : undefined}
                key={item}
                aria-current={item === step ? "step" : undefined}
              >
                {item < step ? <Check size={15} /> : item}
              </li>
            ))}
          </ol>
        </header>

        <main className={styles.content}>
          {step === 1 && (
            <section className={styles.wizardCard} aria-label="通用短剧基础设置">
              <div className={styles.sectionTitle}><span>1</span><h2>选择创作类型</h2></div>
              <div className={styles.modeGrid} role="group" aria-label="创作类型">
                <button
                  type="button"
                  className={styles.modeCard}
                  data-tone="original"
                  aria-pressed={draft.creationMode === "original"}
                  onClick={() => updateDraft("creationMode", "original")}
                >
                  <strong><Sparkles size={21} /> 需求驱动·原创</strong>
                  <p>根据你的需求描述创作全新剧本。提供故事框架、主角设定、情节走向等，AI据此原创完整故事。</p>
                  <span><em>提供故事框架</em><em>设定主角角色</em><em>描述情节走向</em></span>
                </button>
                <button
                  type="button"
                  className={styles.modeCard}
                  data-tone="adaptation"
                  aria-pressed={draft.creationMode === "adaptation"}
                  onClick={() => updateDraft("creationMode", "adaptation")}
                >
                  <strong><BookOpen size={21} /> 素材驱动·改编</strong>
                  <p>根据你提供的原文素材改编为剧本。粘贴小说片段、故事原文或大纲，AI提取精华转换为剧本格式。</p>
                  <span><em>小说片段改编</em><em>故事原文改编</em><em>大纲扩充</em></span>
                </button>
              </div>

              <div className={styles.sectionTitle}><span>2</span><h2>基础设定</h2></div>
              <div className={styles.settingsGrid}>
                <fieldset className={styles.optionFieldset}>
                  <legend>目标受众</legend>
                  <div className={styles.segmented}>
                    {AUDIENCES.map((option) => (
                      <button
                        type="button"
                        aria-pressed={draft.targetAudience === option.value}
                        key={option.value}
                        onClick={() => updateDraft("targetAudience", option.value)}
                      >
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset className={styles.optionFieldset}>
                  <legend>故事基调</legend>
                  <div className={styles.segmented}>
                    {TONES.map((option) => (
                      <button
                        type="button"
                        aria-pressed={draft.tone === option.value}
                        key={option.value}
                        onClick={() => updateDraft("tone", option.value)}
                      >
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className={styles.selectField}>
                  <span>生成集数 <small>建议 ≤ 5 集</small></span>
                  <select
                    aria-label="通用短剧生成集数"
                    value={draft.episodesToGenerate}
                    onChange={(event) => updateDraft("episodesToGenerate", Number(event.target.value))}
                  >
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>{count} 集</option>
                    ))}
                  </select>
                </label>
                <label className={styles.selectField}>
                  <span>总集数</span>
                  <input
                    aria-label="通用短剧总集数"
                    type="number"
                    min={1}
                    max={500}
                    inputMode="numeric"
                    value={draft.totalEpisodes}
                    placeholder="不设定（开放式长剧）"
                    onChange={(event) => updateDraft(
                      "totalEpisodes",
                      event.target.value.replace(/\D/g, "").slice(0, 3),
                    )}
                  />
                </label>
                <div className={`${styles.selectField} ${styles.styleField}`}>
                  <span>视觉风格 <small>39 种预设或自定义</small></span>
                  <VideoStylePicker
                    value={draft.animationStyle}
                    onChange={(value) => updateDraft("animationStyle", value)}
                    ariaLabel="通用短剧视觉风格"
                  />
                </div>
              </div>
              {draft.tone === "custom" && (
                <label className={styles.customToneField}>
                  <span>自定义故事基调</span>
                  <input
                    value={draft.customTone}
                    maxLength={100}
                    placeholder="例如：轻科幻治愈、黑色幽默、都市烟火气"
                    onChange={(event) => updateDraft("customTone", event.target.value)}
                  />
                </label>
              )}
              {workflow.status === "error" && step === 1 && (
                <div className={styles.inlineError} role="alert">{workflow.message}</div>
              )}
              <div className={styles.setupFooter}>
                <span />
                <button type="button" className={styles.primaryButton} onClick={goToRequirements}>
                  下一步：输入内容 <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className={styles.wizardCard} aria-label="通用短剧故事需求">
              <button
                type="button"
                className={styles.previousButton}
                onClick={() => {
                  setWorkflow({ status: "idle" });
                  setStep(1);
                }}
              >
                <ArrowLeft size={14} /> 返回上一步
              </button>
              <div className={styles.sectionTitle}>
                <span>3</span><h2>故事需求描述</h2><i title="基础设定、参考素材和需求描述会一起用于剧本创作。">?</i>
              </div>
              <div className={styles.summaryBar} aria-label="已选设置">
                <span>类型: {draft.creationMode === "original" ? "✨ 原创" : "📖 改编"}</span>
                <span>受众: {selectedAudience.emoji} {selectedAudience.label}</span>
                <span>基调: {selectedTone.emoji} {draft.tone === "custom" ? draft.customTone : selectedTone.label}</span>
                <span>画风: {getVideoStyleLabel(draft.animationStyle)}</span>
                <span>生成: {draft.episodesToGenerate}集</span>
                <span>总集数: {draft.totalEpisodes ? `${draft.totalEpisodes}集` : "不设定"}</span>
              </div>

              <label className={styles.textareaField}>
                <span>
                  参考素材
                  <small>{draft.creationMode === "adaptation" ? "（改编模式必填）" : "（可选）"}</small>
                </span>
                <textarea
                  className={styles.sourceInput}
                  value={draft.sourceMaterial}
                  maxLength={MAX_TEXT_LENGTH}
                  placeholder={draft.creationMode === "adaptation"
                    ? "粘贴小说片段、故事原文或大纲。AI 会保留核心信息，并转换为可制作的剧本结构。"
                    : ORIGINAL_REFERENCE_PLACEHOLDER}
                  onChange={(event) => updateDraft("sourceMaterial", event.target.value)}
                />
                <em>{draft.sourceMaterial.length.toLocaleString("zh-CN")} / 100000 字符</em>
              </label>

              <div className={styles.requirementHeading}>
                <label htmlFor="youcai-general-script-requirements">需求描述 <b>*必填</b></label>
                <button type="button" disabled>
                  <Sparkles size={14} /> AI优化需求
                </button>
              </div>
              <textarea
                id="youcai-general-script-requirements"
                className={styles.requirementsInput}
                value={draft.requirements}
                maxLength={MAX_TEXT_LENGTH}
                placeholder={REQUIREMENTS_PLACEHOLDER}
                onChange={(event) => updateDraft("requirements", event.target.value)}
              />
              <div className={styles.characterCount}>
                {draft.requirements.length.toLocaleString("zh-CN")} / 100000 字符
              </div>
              {workflow.status === "error" && step === 2 && (
                <div className={styles.inlineError} role="alert">{workflow.message}</div>
              )}
              <div className={styles.generateFooter}>
                <small data-paid-readiness={paidReadiness.status}>
                  {paidReadiness.status === "checking"
                    ? "正在检查影视工坊服务状态…"
                    : paidReadiness.status === "blocked"
                      ? paidReadiness.message
                      : "影视工坊服务已就绪；实际费用以提交前报价为准。"}
                </small>
                <button
                  type="button"
                  className={styles.primaryButton}
                  data-testid="youcai-general-script-generate"
                  disabled={!draft.requirements.trim() || paidReadiness.status !== "ready"}
                  onClick={() => void generate()}
                >
                  <Sparkles size={18} /> 生成剧本
                </button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className={`${styles.wizardCard} ${styles.statusCard}`} aria-label="剧本创建状态">
              <div className={styles.statusIcon} data-error={workflow.status === "error" ? "true" : undefined}>
                {workflow.status === "working"
                  ? <Loader2 className={styles.spinner} size={32} />
                  : workflow.status === "success"
                    ? <Check size={32} />
                    : <FileText size={32} />}
              </div>
              {workflow.status === "working" && (
                <>
                  <h2>{workflow.phase === "generating" ? "正在生成完整剧本" : "正在保存影视项目"}</h2>
                  <p>{workflow.phase === "generating"
                    ? "正在创建剧集、角色、场景与道具，请勿关闭页面。"
                    : "剧本已经生成，正在建立项目与后续制作入口。"}</p>
                </>
              )}
              {workflow.status === "error" && (
                <>
                  <h2>{workflow.phase === "saving" ? "剧本已生成，项目保存未完成" : "剧本创建未完成"}</h2>
                  <p className={styles.statusError} role="alert">{workflow.message}</p>
                  {workflow.phase === "saving" && candidate ? (
                    <button type="button" className={styles.primaryButton} onClick={() => void retrySave()}>
                      重试保存项目
                    </button>
                  ) : (
                    <button type="button" className={styles.primaryButton} onClick={() => setStep(2)}>
                      <ArrowLeft size={17} /> 返回修改需求
                    </button>
                  )}
                </>
              )}
              {workflow.status === "success" && (
                <>
                  <h2>影视项目已创建</h2>
                  <p>剧本与项目已保存。确认后可进入影视工坊继续角色、场景、分镜与视频流程。</p>
                  <Link className={styles.primaryLink} href={workflow.href}>
                    进入项目 <ArrowRight size={17} />
                  </Link>
                </>
              )}
            </section>
          )}

          <GeneralScriptHistoryPanel
            token={identity.token}
            surface="youcai"
            refreshNonce={historyRefreshNonce}
            onLoadRetry={loadHistoryRetry}
            onLoadResult={loadHistoryResult}
          />

          <GeneralScriptGuide />
        </main>

        <footer className={styles.footer}>
          © 2026 漫剧工作台 · 关于我们 · 商务合作
        </footer>
      </div>
    </div>
  );
}

function GeneralScriptGuide() {
  return (
    <section className={styles.guide} aria-labelledby="youcai-general-guide-title">
      <div className={styles.guideHeading}>
        <h2 id="youcai-general-guide-title"><Sparkles size={22} /> 使用指南</h2>
        <p>从创意到成片的自动化制作流程</p>
      </div>
      <div className={styles.flowPanel}>
        <h3><Clapperboard size={25} /> 制作全流程</h3>
        <p><strong>你当前在第 1 步。</strong> 创作完剧本后，后续步骤请在「创意工坊」中继续。</p>
        <div className={styles.flowGrid}>
          {FLOW_STEPS.map((item) => {
            const Icon = item.icon;
            return (
              <article data-current={item.number === 1 ? "true" : undefined} key={item.number}>
                <Icon size={23} aria-hidden="true" />
                <div><b>{item.number}</b><strong>{item.title}</strong></div>
                <p>{item.description}</p>
              </article>
            );
          })}
        </div>
      </div>

      <div className={styles.modeInfoGrid}>
        <article className={styles.modeInfoCard} data-tone="original">
          <header><span><Sparkles size={21} /></span><div><h3>需求驱动（原创）</h3><p>根据你的创意需求创作新剧本</p></div></header>
          <ul>
            <li>描述 <b>故事创意、主角设定、情节框架</b></li>
            <li>AI 会根据需求 <b>原创全新剧本</b></li>
            <li>可粘贴 <b>参考素材</b> 让 AI 参考风格（不直接复制）</li>
            <li>适合：童话、教育故事、短篇原创、创意实验</li>
          </ul>
        </article>
        <article className={styles.modeInfoCard} data-tone="adaptation">
          <header><span><BookOpen size={21} /></span><div><h3>素材驱动（改编）</h3><p>将小说/故事原文改编为剧本</p></div></header>
          <ul>
            <li>粘贴 <b>小说片段、故事原文或大纲</b></li>
            <li>AI <b>保留原著精髓</b>，提取精华改编为剧本格式</li>
            <li>自动转换：环境描写→场景标注、心理描写→画外音</li>
            <li>适合：小说改编、故事改编、长篇小说分段改编</li>
          </ul>
        </article>
      </div>

      <section className={styles.longFormPanel}>
        <header><span>📚</span><div><h3>长篇小说改编方案</h3><p>分段续写，边改边创作，完成超长篇小说改编</p></div></header>
        <div>
          <article><b>1</b><h4>首次生成（建立基础）</h4><p>粘贴小说开头部分（建议不超过20章/8万字）</p><p>AI 全压缩提炼，生成若干集剧本</p><p>可指定总集数，或留空使用「开放式长剧」</p></article>
          <article><b>2</b><h4>续写下一批（保持连贯）</h4><p>点击「续写剧本」继续创作下一批集数</p><p>上次素材改编完后，粘贴新章节（建议每次约10章）</p><p>AI 自动保持人物设定和情节连贯</p></article>
          <article><b>3</b><h4>灵活收尾（随时剧终）</h4><p>续写时勾选「本次续写后剧终」</p><p>AI 会完整收尾，添加结局和「本剧终」标记</p><p>无需提前设定总集数，随时可完结</p></article>
          <article><b>4</b><h4>重写修改（调整内容）</h4><p>可重写任意单集或多集</p><p>粘贴新的改编指导或参考内容</p><p>AI 保持前后剧情连贯，只修改指定集</p></article>
        </div>
      </section>

      <div className={styles.infoGrid}>
        {GUIDE_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <article className={styles.infoCard} data-tone={card.tone} key={card.title}>
              <header><span><Icon size={21} /></span><div><h3>{card.title}</h3><p>{card.subtitle}</p></div></header>
              <ul>{card.points.map((point) => <li key={point}>{point}</li>)}</ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}
