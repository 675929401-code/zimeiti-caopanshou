"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  Clapperboard,
  FileText,
  Film,
  ImageIcon,
  Loader2,
  PenLine,
  Sparkles,
  Users,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useApp } from "@/contexts/app-context";
import styles from "./drama-script-workbench.module.css";

const DRAMA_SCRIPT_PROFILE_ID = "drama-script" as const;
const DRAMA_SCRIPT_API = "/api/short-drama/drama-script";
const MAX_BRIEF_CHARACTERS = 100_000;

type ThemeId = "relationship" | "power" | "advantage" | "revenge";
type StoryType = "auto" | "male" | "female";
type StoryTone = "爽文" | "甜宠" | "虐心" | "悬疑";
type RequestOperation = "generate" | "optimize";

interface ThemeOption {
  id: ThemeId;
  emoji: string;
  label: string;
  description: string;
  tags: readonly string[];
}

interface SelectOption<T extends string> {
  value: T;
  emoji: string;
  label: string;
}

export interface DramaScriptGenerateRequest {
  operation: RequestOperation;
  profileId: typeof DRAMA_SCRIPT_PROFILE_ID;
  clientRequestId: string;
  input: {
    theme: ThemeId;
    storyType: StoryType;
    tone: StoryTone;
    batchEpisodeCount: number;
    totalEpisodeCount: number | null;
    brief: string;
    videoSize: "9:16";
  };
}

export type DramaScriptGenerateHandler = (
  request: DramaScriptGenerateRequest,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

interface DramaScriptWorkbenchProps {
  /**
   * 测试、宿主或后续项目适配可注入真实生成器。
   * 未注入时固定请求 /api/short-drama/drama-script，不会用本地模拟结果伪造成功。
   */
  onGenerate?: DramaScriptGenerateHandler;
}

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting"; operation: RequestOperation }
  | { status: "error"; message: string }
  | { status: "success"; payload: Record<string, unknown> };

const THEMES: readonly ThemeOption[] = [
  {
    id: "relationship",
    emoji: "💕",
    label: "两性主题",
    description: "情感纠葛、婚姻冲突",
    tags: ["离婚", "出轨", "霸总", "甜宠"],
  },
  {
    id: "power",
    emoji: "⚔️",
    label: "暴力主题",
    description: "战力碾压、金手指",
    tags: ["战王", "金手指", "暴虐", "神豪"],
  },
  {
    id: "advantage",
    emoji: "👑",
    label: "优势主题",
    description: "身份地位、能力碾压",
    tags: ["官场", "权臣", "家族", "学霸"],
  },
  {
    id: "revenge",
    emoji: "🔥",
    label: "复仇主题",
    description: "重生逆袭、打脸复仇",
    tags: ["重生", "穿越", "复仇", "逆袭"],
  },
] as const;

const STORY_TYPES: readonly SelectOption<StoryType>[] = [
  { value: "auto", emoji: "🤖", label: "自动" },
  { value: "male", emoji: "👨", label: "男频" },
  { value: "female", emoji: "👩", label: "女频" },
] as const;

const STORY_TONES: readonly SelectOption<StoryTone>[] = [
  { value: "爽文", emoji: "😎", label: "爽文" },
  { value: "甜宠", emoji: "🍬", label: "甜宠" },
  { value: "虐心", emoji: "❤️", label: "虐心" },
  { value: "悬疑", emoji: "🔍", label: "悬疑" },
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
    description: "编辑角色场景，生成形象图、音色和场景图",
  },
  {
    number: 4,
    icon: Clapperboard,
    title: "分集视频",
    description: "一键切分片段，使用角色场景素材创作视频",
  },
  {
    number: 5,
    icon: Film,
    title: "剪辑成片",
    description: "片段拼接微调，去穿帮、加效果并输出成片",
  },
] as const;

const INFO_CARDS: readonly {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  subtitle: string;
  points: readonly string[];
  tone: "green" | "violet" | "orange" | "blue";
}[] = [
  {
    icon: PenLine,
    title: "创作剧本",
    subtitle: "灵活的创作方式",
    points: [
      "可重写任意一集，不影响其他集内容",
      "总集数建议不超过 80 集，也可使用开放式续写",
      "续写时可选“本次续写后剧终”随时收尾",
    ],
    tone: "green",
  },
  {
    icon: FileText,
    title: "持续创作",
    subtitle: "不需要一次完成",
    points: [
      "连载剧本可在项目工作台继续创作",
      "可边创作新集，边对已定稿集继续工作",
      "每一步都可反复修改，并保持上下文连贯",
    ],
    tone: "violet",
  },
  {
    icon: Users,
    title: "角色与素材",
    subtitle: "管理同步生成的角色和场景",
    points: [
      "剧本创作时同步生成角色、场景和道具资料",
      "后续可绑定角色形象、参考音色和场景图片",
      "所有素材描述都应支持二次编辑与版本化",
    ],
    tone: "orange",
  },
  {
    icon: ImageIcon,
    title: "视频制作",
    subtitle: "从片段到成片",
    points: [
      "定稿剧本可切分为分镜片段脚本",
      "使用项目角色、场景和道具资产创作片段",
      "配音、字幕、音乐和剪辑由后续项目链路承接",
    ],
    tone: "blue",
  },
] as const;

const BRIEF_PLACEHOLDER = `描述你想要的短剧内容，例如：

【主角设定】
• 姓名、性别、表面身份与隐藏身份
• 核心性格特质（隐忍 / 果断 / 智慧等）

【故事框架】
• 开场处境：主角当前的地位 / 困境
• 核心矛盾：谁背叛了主角？什么场合？
• 身份反转：隐藏优势如何被激活？
• 复仇 / 逆袭路径：主角如何一步步反击？

【关键场景】（可选填）
• 首集高潮场景
• 中期反转节点
• 最终对决设定

【特殊要求】（可选填）
• 感情线、反派、金手指、时代背景和职业设定
• 其他要求：无虐主 / 快节奏 / 反转多等`;

function createClientRequestId(operation: RequestOperation): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `drama-script-${operation}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorMessage(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["error", "message", "detail"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function readInternalHref(value: Record<string, unknown>): string {
  for (const key of ["projectHref", "href", "redirectTo"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string"
      && candidate.startsWith("/")
      && !candidate.startsWith("//")
    ) {
      return candidate;
    }
  }
  const data = value.data;
  return isRecord(data) ? readInternalHref(data) : "";
}

function readOptimizedBrief(value: Record<string, unknown>): string {
  for (const key of ["optimizedBrief", "brief", "content", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const data = value.data;
  return isRecord(data) ? readOptimizedBrief(data) : "";
}

async function defaultGenerate(
  request: DramaScriptGenerateRequest,
  authToken: string,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const response = await fetch(DRAMA_SCRIPT_API, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(request),
    signal: options?.signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = readErrorMessage(payload);
    throw new Error(message || "剧本生成服务暂时不可用，请稍后重试。");
  }
  if (!isRecord(payload)) {
    throw new Error("剧本生成服务返回内容不完整，请稍后重试。");
  }
  if (payload.ok === false) {
    throw new Error(readErrorMessage(payload) || "爽剧生成请求失败");
  }
  return payload;
}

export function DramaScriptWorkbench({ onGenerate }: DramaScriptWorkbenchProps) {
  const { state } = useApp();
  const authToken = state.auth?.token || "";
  const generate: DramaScriptGenerateHandler = onGenerate
    ?? ((request, options) => defaultGenerate(request, authToken, options));
  const activeRequestRef = useRef<AbortController | null>(null);
  const [screen, setScreen] = useState<"setup" | "brief">("setup");
  const [theme, setTheme] = useState<ThemeId>("relationship");
  const [storyType, setStoryType] = useState<StoryType>("auto");
  const [tone, setTone] = useState<StoryTone>("爽文");
  const [batchEpisodeCount, setBatchEpisodeCount] = useState(5);
  const [totalEpisodeCount, setTotalEpisodeCount] = useState<number | null>(null);
  const [brief, setBrief] = useState("");
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });

  useEffect(() => () => activeRequestRef.current?.abort(), []);

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
  const projectHref = submission.status === "success" ? readInternalHref(submission.payload) : "";

  function buildRequest(operation: RequestOperation): DramaScriptGenerateRequest {
    return {
      operation,
      profileId: DRAMA_SCRIPT_PROFILE_ID,
      clientRequestId: createClientRequestId(operation),
      input: {
        theme,
        storyType,
        tone,
        batchEpisodeCount,
        totalEpisodeCount,
        brief: brief.trim(),
        videoSize: "9:16",
      },
    };
  }

  async function submit(operation: RequestOperation) {
    if (brief.trim().length < 20) {
      setSubmission({ status: "error", message: "请先填写不少于 20 个字的详细需求。" });
      return;
    }
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setSubmission({ status: "submitting", operation });
    try {
      const payload = await generate(buildRequest(operation), { signal: controller.signal });
      if (!isRecord(payload)) {
        throw new Error("生成器未返回可验证的结构化结果");
      }
      if (payload.ok === false) {
        throw new Error(readErrorMessage(payload) || "爽剧请求失败");
      }
      if (operation === "optimize") {
        const optimizedBrief = readOptimizedBrief(payload);
        if (!optimizedBrief) {
          throw new Error("优化服务未返回可用结果，请稍后重试。");
        }
        setBrief(optimizedBrief.slice(0, MAX_BRIEF_CHARACTERS));
      }
      setSubmission({ status: "success", payload });
    } catch (error) {
      if (controller.signal.aborted) return;
      setSubmission({
        status: "error",
        message: error instanceof Error ? error.message : "爽剧请求失败，请稍后重试。",
      });
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
    }
  }

  const activeStep = screen === "setup" ? 1 : 3;
  const isBusy = submission.status === "submitting";

  return (
    <div className={styles.page} data-testid="drama-script-profile" data-profile-id={DRAMA_SCRIPT_PROFILE_ID}>
      <div className={styles.pageInner}>
        <header className={styles.hero}>
          <Link className={styles.backLink} href="/tools/text">
            <ArrowLeft size={15} aria-hidden="true" />
            返回文本创作
          </Link>
          <div className={styles.heroCopy}>
            <h1><span aria-hidden="true">🎭</span> 爽剧剧本创作</h1>
            <p>专业爽剧剧本创作引擎，基于爽点模型输出商业级剧本</p>
          </div>
          <ol className={styles.progress} aria-label="爽剧创作步骤">
            {[1, 2, 3].map((step) => (
              <li
                className={styles.progressStep}
                data-active={step === activeStep ? "true" : undefined}
                data-complete={screen === "brief" && step < 3 ? "true" : undefined}
                key={step}
                aria-current={step === activeStep ? "step" : undefined}
              >
                {screen === "brief" && step < 3 ? <Check size={15} /> : step}
              </li>
            ))}
          </ol>
        </header>

        <main className={styles.content}>
          {screen === "setup" ? (
            <section className={styles.wizardCard} aria-label="爽剧基础设置">
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
                    onClick={() => setTheme(option.id)}
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
                        onClick={() => setStoryType(option.value)}
                      >
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
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
                        onClick={() => setTone(option.value)}
                      >
                        <span aria-hidden="true">{option.emoji}</span> {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className={styles.selectField}>
                  <span>生成集数 <small>建议 ≤ 5 集</small></span>
                  <select
                    value={batchEpisodeCount}
                    onChange={(event) => setBatchEpisodeCount(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((count) => (
                      <option key={count} value={count}>{count} 集</option>
                    ))}
                  </select>
                </label>
                <label className={styles.selectField}>
                  <span>总集数</span>
                  <select
                    value={totalEpisodeCount ?? ""}
                    onChange={(event) => setTotalEpisodeCount(event.target.value ? Number(event.target.value) : null)}
                  >
                    <option value="">不设定（开放式长剧）</option>
                    {[10, 20, 30, 40, 50, 60, 80].map((count) => (
                      <option key={count} value={count}>{count} 集</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.setupFooter}>
                <span>默认 9:16 竖屏，后续可在项目工作台调整。</span>
                <button type="button" className={styles.primaryButton} onClick={() => setScreen("brief")}>
                  下一步：输入需求 <ArrowRight size={17} />
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
                  setSubmission({ status: "idle" });
                }}
              >
                <ArrowLeft size={15} /> 返回上一步
              </button>
              <div className={styles.sectionTitle}>
                <span>3</span>
                <h2>详细需求描述</h2>
                <i title="需求会与主题、类型、基调和集数一起提交给爽剧生成器。">?</i>
              </div>
              <div className={styles.summaryBar} aria-label="已选设置">
                <span>主题: {selectedTheme.emoji} {selectedTheme.label}</span>
                <span>类型: {selectedType.label}</span>
                <span>基调: {selectedTone.emoji} {selectedTone.label}</span>
                <span>生成: {batchEpisodeCount}集</span>
                <span>总集数: {totalEpisodeCount ? `${totalEpisodeCount}集` : "不设定"}</span>
              </div>
              <div className={styles.briefToolbar}>
                <p>把人物、冲突、反转与特殊要求说清楚，生成器会一次接收全部变量。</p>
                <button type="button" disabled={isBusy || brief.trim().length < 20} onClick={() => void submit("optimize")}>
                  {submission.status === "submitting" && submission.operation === "optimize"
                    ? <Loader2 className={styles.spinner} size={16} />
                    : <WandSparkles size={16} />}
                  AI 优化需求
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
                  if (submission.status !== "idle" && submission.status !== "submitting") {
                    setSubmission({ status: "idle" });
                  }
                }}
              />
              <div className={styles.characterCount}>{brief.length.toLocaleString("zh-CN")} / 100,000 字符</div>

              {submission.status === "error" && (
                <div className={styles.errorNotice} role="alert">
                  <strong>未生成</strong>
                  <span>{submission.message}</span>
                </div>
              )}
              {submission.status === "success" && (
                <div className={styles.successNotice} role="status">
                  <div>
                    <strong>剧本已生成</strong>
                    <span>生成结果已保存到当前工作区，可继续查看或进入项目。</span>
                  </div>
                  {projectHref && <Link href={projectHref}>进入项目 <ArrowRight size={15} /></Link>}
                </div>
              )}

              <div className={styles.generateFooter}>
                <small>
                  提交前请确认题材、时长和创作要求；生成失败时会保留当前输入。
                </small>
                <button
                  type="button"
                  className={styles.primaryButton}
                  data-testid="drama-script-generate"
                  disabled={isBusy}
                  onClick={() => void submit("generate")}
                >
                  {submission.status === "submitting" && submission.operation === "generate"
                    ? <Loader2 className={styles.spinner} size={18} />
                    : <Clapperboard size={18} />}
                  {submission.status === "submitting" && submission.operation === "generate" ? "正在提交…" : "生成剧本"}
                </button>
              </div>
            </section>
          )}

          <section className={styles.guide} aria-labelledby="drama-guide-title">
            <div className={styles.guideHeading}>
              <h2 id="drama-guide-title"><Sparkles size={22} /> 使用指南</h2>
              <p>从创意到成片的自动化制作流程</p>
            </div>
            <div className={styles.flowPanel}>
              <h3><Clapperboard size={24} /> 制作全流程</h3>
              <p><strong>你当前在第 1 步。</strong> 创作完剧本后，后续步骤在同一项目工作台中继续。</p>
              <div className={styles.flowGrid}>
                {GUIDE_STEPS.map((step) => {
                  const Icon = step.icon;
                  return (
                    <article data-current={step.number === 1 ? "true" : undefined} key={step.number}>
                      <Icon size={23} />
                      <div><b>{step.number}</b><strong>{step.title}</strong></div>
                      <p>{step.description}</p>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className={styles.infoGrid}>
              {INFO_CARDS.map((card) => {
                const Icon = card.icon;
                return (
                  <article className={styles.infoCard} data-tone={card.tone} key={card.title}>
                    <header>
                      <span><Icon size={20} /></span>
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
