"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { VideoStylePicker } from "@/components/video-style-picker";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Clapperboard,
  FileText,
  Film,
  ImageIcon,
  LoaderCircle,
  PenLine,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApp } from "@/contexts/app-context";
import {
  describePublicDramaFailure,
  publicDramaFailureFromPayload,
  type PublicDramaFailure,
} from "@/lib/short-drama/public-drama-errors";
import {
  DEFAULT_VIDEO_STYLE,
  getVideoStyleLabel,
} from "@/lib/short-drama/video-style-presets";
import styles from "./youcai-drama-script-wizard.module.css";

const DRAMA_SCRIPT_API = "/api/short-drama/drama-script";
const DRAMA_SCRIPT_PROFILE_ID = "drama-script" as const;
const MAX_BRIEF_CHARACTERS = 100_000;
const PREFERRED_DRAMA_TEXT_MODEL_ID = "pm_xHhTgrkOC_yQmUqKQ44onpP4";
const PREFERRED_DRAMA_TEXT_MODEL_NAME = "GLM-5-Turbo";

type WizardScreen = "setup" | "brief";
type ThemeId = "relationship" | "power" | "advantage" | "revenge";
type StoryType = "auto" | "male" | "female";
type StoryTone = "爽文" | "甜宠" | "虐心" | "悬疑";
type RequestOperation = "optimize" | "generate";

interface ThemeOption {
  id: ThemeId;
  emoji: string;
  label: string;
  description: string;
  tags: readonly string[];
}

interface ChoiceOption<T extends string> {
  value: T;
  emoji: string;
  label: string;
  title?: string;
}

type Feedback =
  | { status: "idle" }
  | { status: "submitting"; operation: RequestOperation }
  | { status: "error"; operation: RequestOperation; failure: PublicDramaFailure }
  | { status: "notice"; message: string; projectHref?: string };

interface TextModelCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly variantLabel?: string;
}

type CreationReadiness =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "blocked"; code: string; message: string };

type ModelCatalogState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

class DramaScriptRequestError extends Error {
  readonly failure: PublicDramaFailure;

  constructor(failure: PublicDramaFailure) {
    super(failure.message);
    this.name = "DramaScriptRequestError";
    this.failure = failure;
  }
}

const THEMES: readonly ThemeOption[] = [
  {
    id: "relationship",
    emoji: "💕",
    label: "两性主题",
    description: "情感纠葛、婚姻冲突",
    tags: ["离婚", "赘婿", "霸总", "甜宠"],
  },
  {
    id: "power",
    emoji: "⚔️",
    label: "暴力主题",
    description: "战力碾压、金手指",
    tags: ["战王", "金手指", "暴富", "神豪"],
  },
  {
    id: "advantage",
    emoji: "👑",
    label: "优势主题",
    description: "身份地位、能力碾压",
    tags: ["官场", "神医", "家族", "学霸"],
  },
  {
    id: "revenge",
    emoji: "🔥",
    label: "复仇主题",
    description: "重生逆袭、打脸复仇",
    tags: ["重生", "穿越", "复仇", "逆袭"],
  },
] as const;

const STORY_TYPES: readonly ChoiceOption<StoryType>[] = [
  { value: "auto", emoji: "🤖", label: "自动" },
  { value: "male", emoji: "👨", label: "男频" },
  { value: "female", emoji: "👩", label: "女频" },
] as const;

const STORY_TONES: readonly ChoiceOption<StoryTone>[] = [
  { value: "爽文", emoji: "😎", label: "爽文", title: "打脸反转，一路碾压" },
  { value: "甜宠", emoji: "🍬", label: "甜宠", title: "甜蜜温馨，糖分超标" },
  { value: "虐心", emoji: "💔", label: "虐心", title: "先虐后甜，情感冲击" },
  { value: "悬疑", emoji: "🔍", label: "悬疑", title: "悬念迭起，扣人心弦" },
] as const;

const GUIDE_STEPS = [
  {
    number: 1,
    icon: PenLine,
    title: "创作剧本",
    description: "AI 生成多集剧本，可续写、重写、随时剧终",
  },
  {
    number: 2,
    icon: BookOpenCheck,
    title: "定稿剧本",
    description: "逐集编辑定稿，可边创作边定稿前面的集",
  },
  {
    number: 3,
    icon: Users,
    title: "角色场景",
    description: "编辑角色场景，生成形象图/音色/场景图",
  },
  {
    number: 4,
    icon: Clapperboard,
    title: "分集视频",
    description: "一键切分片段，素材创作视频（含配音/字幕/音乐）",
  },
  {
    number: 5,
    icon: Film,
    title: "剪辑成片",
    description: "片段拼接微调，去穿帮加效果，生成成片",
  },
] as const;

const GUIDE_CARDS: readonly {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  tone: "green" | "violet" | "orange" | "blue";
  points: readonly string[];
}[] = [
  {
    icon: PenLine,
    title: "创作剧本",
    subtitle: "灵活的创作方式",
    tone: "green",
    points: [
      "可重写任意一集，不影响其他集内容",
      "总集数建议不超过 80 集，超过可用开放式续写随时收尾",
      "续写时勾选「本次续写后剧终」即可随时收尾",
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
      "剧本创作时会同步生成角色、场景和道具资料",
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
      "一键切分分镜片段脚本，使用角色场景素材创作片段视频",
      "片段视频自动包含配音、字幕和背景音乐",
      "剪辑成片只需去穿帮、加镜头效果等后期微调",
    ],
  },
] as const;

const BRIEF_PLACEHOLDER = `描述你想要的短剧内容，例如：

【主角设定】
• 姓名、性别、表面身份与隐藏身份
• 核心性格特质（隐忍/果断/智慧等）

【故事框架】
• 开场处境：主角当前的地位/困境
• 核心矛盾：谁背叛了主角？什么场合？
• 身份反转：隐藏优势如何被激活？
• 复仇/逆袭路径：主角如何一步步反击？

【关键场景】（可选填）
• 首集高潮场景
• 中期反转节点
• 最终对决设定

【特殊要求】（可选填）
• 感情线设定：1v1 / 追妻火葬场 / 先婚后爱 / 多女主等
• 反派设定：智商在线 / 有背景 / 逐步升级等
• 金手指设定：系统 / 异能 / 身份 / 无金手指等
• 时代背景：现代 / 古代 / 架空 / 特定年代
• 职业设定：医生 / 律师 / 设计师 / 特种兵等
• 其他要求：无虐主 / 快节奏 / 反转多等`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptimizedBrief(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["optimizedBrief", "brief", "content", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return readOptimizedBrief(value.data);
}

function readProjectHref(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["href", "projectHref", "redirectTo"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string"
      && candidate.startsWith("/")
      && !candidate.startsWith("//")
      && !candidate.startsWith("/api/")
    ) {
      if (candidate === "/youcai" || candidate.startsWith("/youcai/")) return candidate;
      return `/youcai${candidate}`;
    }
  }
  return readProjectHref(value.project) || readProjectHref(value.data);
}

function createClientRequestId(operation: RequestOperation): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const suffix = uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `youcai-drama-script-${operation}-${suffix}`;
}

export function YoucaiDramaScriptWizard({
  backHref = "/youcai/tools/text",
  backLabel = "返回文本创作",
}: {
  backHref?: string;
  backLabel?: string;
} = {}) {
  const { state } = useApp();
  const authToken = state.auth?.token || "";
  const requestControllerRef = useRef<AbortController | null>(null);
  const submissionIdentityRef = useRef<Partial<Record<RequestOperation, {
    fingerprint: string;
    clientRequestId: string;
  }>>>({});
  const [screen, setScreen] = useState<WizardScreen>("setup");
  const [theme, setTheme] = useState<ThemeId>("relationship");
  const [storyType, setStoryType] = useState<StoryType>("auto");
  const [tone, setTone] = useState<StoryTone>("爽文");
  const [animationStyle, setAnimationStyle] = useState(DEFAULT_VIDEO_STYLE);
  const [episodesToGenerate, setEpisodesToGenerate] = useState(5);
  const [totalEpisodes, setTotalEpisodes] = useState("");
  const [brief, setBrief] = useState("");
  const [setupError, setSetupError] = useState("");
  const [feedback, setFeedback] = useState<Feedback>({ status: "idle" });
  const [creationReadiness, setCreationReadiness] = useState<CreationReadiness>({ status: "checking" });
  const [modelCatalogState, setModelCatalogState] = useState<ModelCatalogState>({ status: "loading" });
  const [textModels, setTextModels] = useState<TextModelCandidate[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/short-drama/health", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (
        response.ok
        && isRecord(payload)
        && payload.ok === true
        && payload.migrationStatus === "ready"
        && payload.paidModelCallsEnabled === true
      ) {
        setCreationReadiness({ status: "ready" });
        return;
      }
      const code = isRecord(payload) && typeof payload.code === "string"
        ? payload.code
        : "PROJECT_DATABASE_UNAVAILABLE";
      const message = isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "影视工坊状态暂时无法确认";
      setCreationReadiness({ status: "blocked", code, message });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setCreationReadiness({
          status: "blocked",
          code: "PROJECT_DATABASE_UNAVAILABLE",
          message: "影视工坊状态暂时无法确认",
        });
      }
    });

    void fetch("/api/youcai/chat-models", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      const models = isRecord(payload) && Array.isArray(payload.models)
        ? payload.models.flatMap((candidate): TextModelCandidate[] => {
            if (!isRecord(candidate)) return [];
            const id = typeof candidate.id === "string" ? candidate.id : "";
            const displayName = typeof candidate.displayName === "string" ? candidate.displayName : "";
            if (!id.startsWith("pm_") || !displayName.trim()) return [];
            return [{
              id,
              displayName: displayName.trim(),
              variantLabel: typeof candidate.variantLabel === "string"
                ? candidate.variantLabel
                : undefined,
            }];
          })
        : [];
      if (!response.ok || models.length === 0) {
        setModelCatalogState({
          status: "error",
          message: "暂无已发布且兼容的公共文案模型",
        });
        setTextModels([]);
        setSelectedModelId("");
        return;
      }
      const policy = isRecord(payload) && isRecord(payload.policy) ? payload.policy : null;
      const defaultModelId = policy && typeof policy.defaultModelId === "string"
        ? policy.defaultModelId
        : "";
      const preferredModel = models.find((model) => model.id === PREFERRED_DRAMA_TEXT_MODEL_ID)
        || models.find((model) => (
          model.displayName.toLowerCase().startsWith(PREFERRED_DRAMA_TEXT_MODEL_NAME.toLowerCase())
          && model.variantLabel === "官方"
        ));
      setTextModels(models);
      setSelectedModelId((current) => (
        models.some((model) => model.id === current)
          ? current
          : preferredModel?.id
            || models.find((model) => model.id === defaultModelId)?.id
            || models[0].id
      ));
      setModelCatalogState({ status: "ready" });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setModelCatalogState({ status: "error", message: "文案模型目录暂时不可用" });
        setTextModels([]);
        setSelectedModelId("");
      }
    });

    return () => controller.abort();
  }, []);

  const selectedTheme = useMemo(
    () => THEMES.find((item) => item.id === theme) ?? THEMES[0],
    [theme],
  );
  const selectedType = useMemo(
    () => STORY_TYPES.find((item) => item.value === storyType) ?? STORY_TYPES[0],
    [storyType],
  );
  const selectedTone = useMemo(
    () => STORY_TONES.find((item) => item.value === tone) ?? STORY_TONES[0],
    [tone],
  );

  const hasBrief = brief.trim().length > 0;
  const isBusy = feedback.status === "submitting";
  const canSubmitPaidRequest = creationReadiness.status === "ready"
    && modelCatalogState.status === "ready"
    && Boolean(selectedModelId);

  function clearFeedback() {
    if (feedback.status !== "idle" && feedback.status !== "submitting") {
      setFeedback({ status: "idle" });
    }
  }

  function goToBrief() {
    const parsedTotal = totalEpisodes.trim() ? Number(totalEpisodes) : null;
    if (
      parsedTotal !== null
      && (!Number.isInteger(parsedTotal) || parsedTotal < 1 || parsedTotal > 500)
    ) {
      setSetupError("总集数请输入 1–500 的整数，或留空使用开放式长剧。");
      return;
    }
    setSetupError("");
    setFeedback({ status: "idle" });
    setScreen("brief");
  }

  async function submit(operation: RequestOperation) {
    const normalizedBrief = brief.trim();
    if (!normalizedBrief) return;
    if (normalizedBrief.length < 20) {
      setFeedback({
        status: "error",
        operation,
        failure: describePublicDramaFailure(400, "INVALID_DRAMA_SCRIPT_REQUEST"),
      });
      return;
    }
    if (!authToken) {
      setFeedback({
        status: "error",
        operation,
        failure: describePublicDramaFailure(401, "UNAUTHORIZED"),
      });
      return;
    }
    if (creationReadiness.status !== "ready") {
      setFeedback({
        status: "error",
        operation,
        failure: describePublicDramaFailure(
          503,
          creationReadiness.status === "blocked"
            ? creationReadiness.code
            : "PROJECT_DATABASE_UNAVAILABLE",
        ),
      });
      return;
    }
    if (modelCatalogState.status !== "ready" || !selectedModelId) {
      setFeedback({
        status: "error",
        operation,
        failure: describePublicDramaFailure(503, "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE"),
      });
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setFeedback({ status: "submitting", operation });

    const requestInput = {
      theme,
      storyType,
      tone,
      animationStyle,
      batchEpisodeCount: episodesToGenerate,
      totalEpisodeCount: totalEpisodes.trim() ? Number(totalEpisodes) : null,
      brief: normalizedBrief,
      videoSize: "9:16" as const,
    };
    const fingerprint = JSON.stringify({ modelId: selectedModelId, input: requestInput });
    const previousIdentity = submissionIdentityRef.current[operation];
    const clientRequestId = previousIdentity?.fingerprint === fingerprint
      ? previousIdentity.clientRequestId
      : createClientRequestId(operation);
    submissionIdentityRef.current[operation] = { fingerprint, clientRequestId };

    try {
      const response = await fetch(DRAMA_SCRIPT_API, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          "Idempotency-Key": clientRequestId,
        },
        body: JSON.stringify({
          operation,
          profileId: DRAMA_SCRIPT_PROFILE_ID,
          clientRequestId,
          modelId: selectedModelId,
          input: requestInput,
        }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new DramaScriptRequestError(publicDramaFailureFromPayload(response.status, payload));
      }

      if (operation === "optimize") {
        const optimizedBrief = readOptimizedBrief(payload);
        if (!optimizedBrief) {
          throw new DramaScriptRequestError(
            describePublicDramaFailure(502, "DRAMA_EMPTY_MODEL_RESULT"),
          );
        }
        setBrief(optimizedBrief.slice(0, MAX_BRIEF_CHARACTERS));
        setFeedback({
          status: "notice",
          message: "需求已优化，请确认后生成剧本。",
        });
        delete submissionIdentityRef.current[operation];
        return;
      }

      setFeedback({
        status: "notice",
        message: "剧本已生成，可继续编辑角色、场景和分镜。",
        projectHref: readProjectHref(payload) || undefined,
      });
      delete submissionIdentityRef.current[operation];
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof DramaScriptRequestError
        ? error.failure
        : describePublicDramaFailure(503, "DRAMA_NETWORK_FAILED");
      setFeedback({
        status: "error",
        operation,
        failure,
      });
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  return (
    <div
      className={styles.page}
      data-testid="youcai-drama-script-wizard"
      data-screen={screen}
    >
      <div className={styles.pageInner}>
        <header className={styles.hero}>
          <Link className={styles.backLink} href={backHref}>
            <ArrowLeft size={15} aria-hidden="true" />
            {backLabel}
          </Link>

          <div className={styles.heroCopy}>
            <h1><span aria-hidden="true">🎭</span> 爽剧剧本创作</h1>
            <p>专业爽剧剧本创作引擎，基于爽点模型输出商业级剧本</p>
          </div>

          <ol className={styles.progress} aria-label="爽剧创作步骤">
            {[1, 2, 3].map((step) => {
              const currentStep = screen === "setup" ? 1 : 2;
              return (
                <li
                  className={styles.progressStep}
                  data-active={step === currentStep ? "true" : undefined}
                  data-complete={step < currentStep ? "true" : undefined}
                  key={step}
                  aria-current={step === currentStep ? "step" : undefined}
                >
                  {step}
                </li>
              );
            })}
          </ol>
        </header>

        <main className={styles.content}>
          {screen === "setup" ? (
            <section className={styles.wizardCard} aria-label="爽剧创作基础设定">
              <div className={styles.sectionTitle}>
                <span>1</span>
                <h2>选择主题类型</h2>
              </div>

              <div className={styles.themeGrid} role="group" aria-label="主题类型">
                {THEMES.map((option) => (
                  <button
                    type="button"
                    className={styles.themeCard}
                    data-theme={option.id}
                    aria-pressed={theme === option.id}
                    key={option.id}
                    onClick={() => {
                      setTheme(option.id);
                      clearFeedback();
                    }}
                  >
                    <strong><span aria-hidden="true">{option.emoji}</span> {option.label}</strong>
                    <small>{option.description}</small>
                    <span className={styles.tagRow}>
                      {option.tags.map((tag) => <em key={tag}>{tag}</em>)}
                    </span>
                  </button>
                ))}
              </div>

              <div className={styles.sectionTitle}>
                <span>2</span>
                <h2>基础设定</h2>
              </div>

              <div className={styles.settingsGrid}>
                <fieldset className={styles.optionFieldset}>
                  <legend>故事类型</legend>
                  <div className={styles.segmented}>
                    {STORY_TYPES.map((option) => (
                      <button
                        type="button"
                        aria-pressed={storyType === option.value}
                        key={option.value}
                        onClick={() => {
                          setStoryType(option.value);
                          clearFeedback();
                        }}
                      >
                        <span aria-hidden="true">{option.emoji}</span>{option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className={styles.optionFieldset}>
                  <legend>故事基调</legend>
                  <div className={styles.segmented}>
                    {STORY_TONES.map((option) => (
                      <button
                        type="button"
                        aria-pressed={tone === option.value}
                        key={option.value}
                        title={option.title}
                        onClick={() => {
                          setTone(option.value);
                          clearFeedback();
                        }}
                      >
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className={styles.formField}>
                  <span>生成集数 <small>建议 ≤ 5 集</small></span>
                  <select
                    aria-label="生成集数"
                    value={episodesToGenerate}
                    onChange={(event) => {
                      setEpisodesToGenerate(Number(event.target.value));
                      clearFeedback();
                    }}
                  >
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>{count} 集</option>
                    ))}
                  </select>
                </label>

                <label className={styles.formField}>
                  <span>总集数</span>
                  <input
                    aria-label="总集数"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={500}
                    step={1}
                    value={totalEpisodes}
                    placeholder="不设定（开放式长剧）"
                    onChange={(event) => {
                      setTotalEpisodes(event.target.value);
                      setSetupError("");
                      clearFeedback();
                    }}
                  />
                </label>

                <div className={`${styles.formField} ${styles.styleField}`}>
                  <span>视觉风格 <small>39 种预设或自定义</small></span>
                  <VideoStylePicker
                    value={animationStyle}
                    onChange={(value) => {
                      setAnimationStyle(value);
                      clearFeedback();
                    }}
                    ariaLabel="爽剧视觉风格"
                  />
                </div>
              </div>

              {setupError && <p className={styles.setupError} role="alert">{setupError}</p>}

              <div className={styles.setupFooter}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  data-testid="youcai-drama-script-next"
                  onClick={goToBrief}
                >
                  下一步：输入需求 <ArrowRight size={17} aria-hidden="true" />
                </button>
              </div>
            </section>
          ) : (
            <section className={styles.wizardCard} aria-label="爽剧详细需求">
              <button
                type="button"
                className={styles.previousButton}
                disabled={isBusy}
                onClick={() => {
                  setScreen("setup");
                  setFeedback({ status: "idle" });
                }}
              >
                <ArrowLeft size={15} aria-hidden="true" /> 返回上一步
              </button>

              <div className={styles.sectionTitle}>
                <span>3</span>
                <h2>详细需求描述</h2>
                <i title="需求会与主题、类型、基调和集数一起提交。">?</i>
              </div>

              <div className={styles.summaryBar} aria-label="已选设定">
                <span>主题: {selectedTheme.emoji} {selectedTheme.label}</span>
                <span>类型: {selectedType.label}</span>
                <span>基调: {selectedTone.emoji} {selectedTone.label}</span>
                <span>画风: {getVideoStyleLabel(animationStyle)}</span>
                <span>生成: {episodesToGenerate}集</span>
                <span>总集数: {totalEpisodes.trim() ? `${totalEpisodes}集` : "不设定"}</span>
              </div>

              {creationReadiness.status !== "ready" && (
                <div
                  className={styles.preflightNotice}
                  data-state={creationReadiness.status}
                  data-testid="youcai-drama-script-preflight"
                  role={creationReadiness.status === "blocked" ? "alert" : "status"}
                >
                  <strong>
                    {creationReadiness.status === "checking"
                      ? "正在检查影视工坊…"
                      : "影视工坊暂未开放生成"}
                  </strong>
                  <span>
                    {creationReadiness.status === "blocked"
                      ? creationReadiness.message
                      : "项目保存服务准备完成后，才会开放付费文案生成。"}
                  </span>
                  {creationReadiness.status === "blocked" && (
                    <small>本页已阻止模型请求，不会产生生成费用。</small>
                  )}
                </div>
              )}

              {modelCatalogState.status === "error" && (
                <div className={styles.preflightNotice} data-state="blocked" role="alert">
                  <strong>文案模型暂不可用</strong>
                  <span>{modelCatalogState.message}</span>
                  <small>请选择已发布且兼容的公共文本模型后再提交。</small>
                </div>
              )}

              <div className={styles.briefToolbar}>
                <label className={styles.modelSelector}>
                  <span>文案模型</span>
                  <select
                    aria-label="爽剧文案模型"
                    data-testid="youcai-drama-script-model"
                    disabled={isBusy || modelCatalogState.status !== "ready"}
                    value={selectedModelId}
                    onChange={(event) => {
                      setSelectedModelId(event.target.value);
                      clearFeedback();
                    }}
                  >
                    {modelCatalogState.status === "loading" && <option value="">正在加载…</option>}
                    {modelCatalogState.status === "error" && <option value="">暂无可用模型</option>}
                    {textModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}{model.variantLabel ? ` · ${model.variantLabel}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!hasBrief || isBusy || !canSubmitPaidRequest}
                  data-testid="youcai-drama-script-optimize"
                  onClick={() => void submit("optimize")}
                >
                  {feedback.status === "submitting" && feedback.operation === "optimize"
                    ? <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
                    : <span aria-hidden="true">✨</span>}
                  {feedback.status === "submitting" && feedback.operation === "optimize"
                    ? "正在优化…"
                    : "AI优化需求"}
                </button>
              </div>

              <textarea
                className={styles.briefInput}
                value={brief}
                maxLength={MAX_BRIEF_CHARACTERS}
                placeholder={BRIEF_PLACEHOLDER}
                aria-label="爽剧详细需求"
                onChange={(event) => {
                  setBrief(event.target.value);
                  clearFeedback();
                }}
              />

              <div className={styles.characterCount}>
                {brief.length.toLocaleString("zh-CN")} / 100000 字符
              </div>

              {feedback.status === "error" && (
                <div className={styles.errorNotice} role="alert">
                  <div>
                    <strong>{feedback.failure.title}</strong>
                    <span>{feedback.failure.message}</span>
                    <small>{feedback.failure.guidance}</small>
                  </div>
                  {feedback.failure.retryable && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void submit(feedback.operation)}
                    >
                      重新尝试
                    </button>
                  )}
                </div>
              )}

              {feedback.status === "notice" && (
                <div className={styles.cautionNotice} role="status">
                  <div>
                    <strong>{feedback.projectHref ? "剧本已生成" : "需求已优化"}</strong>
                    <span>{feedback.message}</span>
                  </div>
                  {feedback.projectHref && (
                    <Link href={feedback.projectHref}>
                      进入项目 <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  )}
                </div>
              )}

              <div className={styles.generateFooter}>
                <button
                  type="button"
                  className={styles.generateButton}
                  disabled={!hasBrief || isBusy || !canSubmitPaidRequest}
                  data-testid="youcai-drama-script-generate"
                  onClick={() => void submit("generate")}
                >
                  {feedback.status === "submitting" && feedback.operation === "generate"
                    ? <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
                    : <span aria-hidden="true">🎬</span>}
                  {feedback.status === "submitting" && feedback.operation === "generate"
                    ? "正在提交…"
                    : "生成剧本"}
                </button>
              </div>
            </section>
          )}

          <section className={styles.guide} aria-labelledby="youcai-drama-guide-title">
            <div className={styles.guideHeading}>
              <h2 id="youcai-drama-guide-title"><Sparkles size={22} aria-hidden="true" /> 使用指南</h2>
              <p>从创意到成片的自动化制作流程</p>
            </div>

            <div className={styles.flowPanel}>
              <h3><Clapperboard size={25} aria-hidden="true" /> 制作全流程</h3>
              <p><strong>你当前在第 1 步。</strong> 创作完剧本后，后续步骤请在「创意工坊」中继续。</p>

              <div className={styles.flowGrid}>
                {GUIDE_STEPS.map((step) => {
                  const Icon = step.icon;
                  return (
                    <article data-current={step.number === 1 ? "true" : undefined} key={step.number}>
                      <Icon size={23} aria-hidden="true" />
                      <div><b>{step.number}</b><strong>{step.title}</strong></div>
                      <p>{step.description}</p>
                    </article>
                  );
                })}
              </div>
            </div>

            <div className={styles.infoGrid}>
              {GUIDE_CARDS.map((card) => {
                const Icon = card.icon;
                return (
                  <article className={styles.infoCard} data-tone={card.tone} key={card.title}>
                    <header>
                      <span><Icon size={21} aria-hidden="true" /></span>
                      <div><h3>{card.title}</h3><p>{card.subtitle}</p></div>
                    </header>
                    <ul>{card.points.map((point) => <li key={point}>{point}</li>)}</ul>
                  </article>
                );
              })}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
