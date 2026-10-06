"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
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
  Upload,
  Users,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useApp } from "@/contexts/app-context";
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
import styles from "./general-script-official.module.css";

const MAX_TEXT_LENGTH = 100_000;
const MAX_FORMAL_FIELD_LENGTH = 2_000;

export type GeneralScriptOfficialVariant = "general" | "formal";

interface GeneralScriptVariantConfig {
  title: string;
  description: string;
  genre: "通用短剧" | "正剧";
  animationStyle: "影视级短剧" | "传统影视正剧";
  videoSize: "16:9";
  draftKey: string;
  requestPrefix: "general-script" | "formal-script";
  testId: "general-script-official" | "formal-script-official";
  generateTestId: "general-script-generate" | "formal-script-generate";
  requirementsId: "general-script-requirements" | "formal-script-requirements";
  guideId: "general-script-guide-title" | "formal-script-guide-title";
}

const VARIANT_CONFIG: Record<GeneralScriptOfficialVariant, GeneralScriptVariantConfig> = {
  general: {
    title: "通用短剧创作",
    description: "需求驱动原创或素材驱动改编，支持童话、小说等多种剧本类型",
    genre: "通用短剧",
    animationStyle: "影视级短剧",
    videoSize: "16:9",
    draftKey: "general_script_official_draft_v1",
    requestPrefix: "general-script",
    testId: "general-script-official",
    generateTestId: "general-script-generate",
    requirementsId: "general-script-requirements",
    guideId: "general-script-guide-title",
  },
  formal: {
    title: "正剧创作",
    description: "面向单集 10+ 分钟的传统叙事，支持需求驱动原创或长文素材改编",
    genre: "正剧",
    animationStyle: "传统影视正剧",
    videoSize: "16:9",
    draftKey: "formal_script_official_draft_v1",
    requestPrefix: "formal-script",
    testId: "formal-script-official",
    generateTestId: "formal-script-generate",
    requirementsId: "formal-script-requirements",
    guideId: "formal-script-guide-title",
  },
};

interface GeneralScriptOfficialDraft {
  schemaVersion: 1;
  creationMode: GeneralScriptCreationMode;
  targetAudience: GeneralScriptAudience;
  tone: GeneralScriptOfficialTone;
  customTone: string;
  episodesToGenerate: number;
  totalEpisodes: string;
  sourceMaterial: string;
  requirements: string;
  formalFormat: FormalProductionFormat;
  episodeDurationMinutes: number;
  actStructure: FormalActStructure;
  sceneContinuity: FormalSceneContinuity;
  characterArc: string;
  relationshipConflict: string;
  foreshadowingPlan: string;
}

type WorkflowState =
  | { status: "idle" }
  | { status: "working"; phase: "generating" | "saving" }
  | { status: "error"; phase: "generating" | "saving"; message: string }
  | { status: "success"; href: string };

interface GeneratedCandidate {
  clientRequestId: string;
  result: GeneralScriptResult;
}

interface SelectOption<T extends string> {
  value: T;
  label: string;
  emoji: string;
}

interface InfoCard {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  subtitle: string;
  tone: "orange" | "blue" | "violet" | "cyan";
  points: readonly string[];
}

type GeneralScriptOfficialTone = GeneralScriptTone | "adventure";
type FormalProductionFormat = "film" | "tv_series" | "web_series" | "limited_series";
type FormalActStructure = "three_act" | "five_act" | "sequence" | "chapter";
type FormalSceneContinuity = "strict" | "balanced" | "chaptered";

const DEFAULT_DRAFT: GeneralScriptOfficialDraft = {
  schemaVersion: 1,
  creationMode: "original",
  targetAudience: "all_ages",
  tone: "warm",
  customTone: "",
  episodesToGenerate: 5,
  totalEpisodes: "",
  sourceMaterial: "",
  requirements: "",
  formalFormat: "tv_series",
  episodeDurationMinutes: 45,
  actStructure: "three_act",
  sceneContinuity: "strict",
  characterArc: "",
  relationshipConflict: "",
  foreshadowingPlan: "",
};

const FORMAL_DEFAULT_DRAFT: GeneralScriptOfficialDraft = {
  ...DEFAULT_DRAFT,
  targetAudience: "adult",
  tone: "serious",
  episodesToGenerate: 1,
};

const AUDIENCE_OPTIONS: readonly SelectOption<GeneralScriptAudience>[] = [
  { value: "all_ages", label: "全年龄", emoji: "🌐" },
  { value: "children", label: "儿童", emoji: "🧒" },
  { value: "teen", label: "青少年", emoji: "🧑" },
  { value: "adult", label: "成人", emoji: "🧔" },
] as const;

const TONE_OPTIONS: readonly SelectOption<GeneralScriptOfficialTone>[] = [
  { value: "warm", label: "温馨", emoji: "💗" },
  { value: "suspense", label: "悬疑", emoji: "🔍" },
  { value: "comedy", label: "幽默", emoji: "😁" },
  { value: "inspiring", label: "励志", emoji: "💪" },
  { value: "adventure", label: "冒险", emoji: "🗺️" },
  { value: "custom", label: "自定义", emoji: "🖊️" },
] as const;

const FORMAL_TONE_OPTIONS: readonly SelectOption<GeneralScriptOfficialTone>[] = [
  { value: "serious", label: "严肃", emoji: "🎬" },
  { value: "emotional", label: "情感", emoji: "🎭" },
  { value: "suspense", label: "悬疑", emoji: "🔍" },
  { value: "inspiring", label: "励志", emoji: "🔥" },
  { value: "warm", label: "温情", emoji: "💗" },
  { value: "custom", label: "自定义", emoji: "🖊️" },
] as const;

const FORMAL_FORMAT_OPTIONS: readonly { value: FormalProductionFormat; label: string }[] = [
  { value: "film", label: "电影" },
  { value: "tv_series", label: "电视剧" },
  { value: "web_series", label: "网剧" },
  { value: "limited_series", label: "限定剧" },
] as const;

const FORMAL_ACT_OPTIONS: readonly { value: FormalActStructure; label: string }[] = [
  { value: "three_act", label: "三幕式" },
  { value: "five_act", label: "五幕式" },
  { value: "sequence", label: "八段式序列" },
  { value: "chapter", label: "章节式" },
] as const;

const FORMAL_CONTINUITY_OPTIONS: readonly { value: FormalSceneContinuity; label: string }[] = [
  { value: "strict", label: "严格连续" },
  { value: "balanced", label: "叙事优先" },
  { value: "chaptered", label: "章节跳接" },
] as const;

const GUIDE_STEPS = [
  { number: 1, icon: PenLine, title: "创作剧本", description: "AI 生成多集剧本，可续写、重写、随时剧终" },
  { number: 2, icon: FileText, title: "定稿剧本", description: "逐集编辑定稿，可边创作边定稿前面的集" },
  { number: 3, icon: Users, title: "角色场景", description: "编辑角色场景，生成形象图、音色和场景图" },
  { number: 4, icon: Clapperboard, title: "分集视频", description: "一键切分片段，使用角色场景素材创作视频" },
  { number: 5, icon: Film, title: "剪辑成片", description: "片段拼接微调，去穿帮、加效果并输出成片" },
] as const;

const FORMAL_GUIDE_STEPS = [
  { number: 1, icon: PenLine, title: "故事工程", description: "确定影视类型、时长、幕结构和全剧主命题" },
  { number: 2, icon: Users, title: "人物关系", description: "建立人物弧、核心关系冲突和阶段性转变" },
  { number: 3, icon: FileText, title: "分场剧本", description: "按场次连续性组织动作、对白、调度与转场" },
  { number: 4, icon: Clapperboard, title: "制作分镜", description: "锁定场景、角色与道具后进入镜头拆解" },
  { number: 5, icon: Film, title: "审片回收", description: "检查伏笔回收、人物弧闭合与叙事节奏" },
] as const;

const INFO_CARDS: readonly InfoCard[] = [
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
      "自动生成角色形象图、参考音色与场景图片",
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
      "剪辑成片只需去穿帮、加镜头效果等后期微调",
    ],
  },
] as const;

const REQUIREMENTS_PLACEHOLDER = `描述你想要的剧本，简单的描述也可以：

【主角设定】
• 姓名、年龄、身份、性格特点

【故事框架】
• 开篇：主角的初始处境
• 发展：遇到的挑战和转折
• 结局：最终结果

【风格与节奏】
• 故事基调（温馨 / 悬疑 / 热血 / 治愈等）
• 特殊要求（如参考某部作品风格）`;

const FORMAL_REQUIREMENTS_PLACEHOLDER = `描述这部正剧的核心故事：

【主命题】
• 作品要讨论的价值问题与最终立场

【主线故事】
• 开端事件、阶段目标、中点转向与终局决择

【时代与空间】
• 时代背景、地域、核心场景和社会规则

【风格与表演】
• 写实程度、对白密度、节奏、尺度与受众预期`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionLabel<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function buildFormalDirectives(draft: GeneralScriptOfficialDraft): string {
  return `【正剧制作参数】
影视类型：${optionLabel(FORMAL_FORMAT_OPTIONS, draft.formalFormat)}
单集目标时长：${draft.episodeDurationMinutes} 分钟（不得低于 10 分钟）
默认画幅：16:9 横屏
幕结构：${optionLabel(FORMAL_ACT_OPTIONS, draft.actStructure)}
场次连续性：${optionLabel(FORMAL_CONTINUITY_OPTIONS, draft.sceneContinuity)}

【人物弧】
${draft.characterArc.trim()}

【关系冲突】
${draft.relationshipConflict.trim()}

【伏笔与回收】
${draft.foreshadowingPlan.trim() || "请根据主线设计可追踪伏笔，并在后续关键场次明确回收。"}

【硬约束】
保持人物动机、时间线、空间位置和道具状态的场次连续性；每一幕都要推进主命题、人物弧或核心关系冲突。`;
}

function buildSubmissionBrief(draft: GeneralScriptOfficialDraft, variant: GeneralScriptOfficialVariant): string {
  if (variant === "general") return draft.requirements.trim();
  return `${draft.requirements.trim()}\n\n${buildFormalDirectives(draft)}`;
}

function sectionValue(text: string, heading: string, nextHeading?: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const contentStart = start + heading.length;
  const end = nextHeading ? text.indexOf(nextHeading, contentStart) : -1;
  return text.slice(contentStart, end >= 0 ? end : undefined).trim();
}

function draftFromHistoryRequest(
  request: GeneralScriptRequest,
  variant: GeneralScriptOfficialVariant,
  defaults: GeneralScriptOfficialDraft,
): GeneralScriptOfficialDraft {
  const directives = request.content.requirements;
  const restoredTone: GeneralScriptOfficialTone = request.settings.tone === "custom"
    && request.settings.customTone === "冒险"
    ? "adventure"
    : request.settings.tone;
  const restored: GeneralScriptOfficialDraft = {
    ...defaults,
    creationMode: request.settings.creationMode,
    targetAudience: request.settings.targetAudience,
    tone: restoredTone,
    customTone: restoredTone === "adventure" ? "" : request.settings.customTone,
    episodesToGenerate: request.settings.episodesToGenerate,
    totalEpisodes: request.settings.totalEpisodes === null ? "" : String(request.settings.totalEpisodes),
    sourceMaterial: request.content.sourceMaterial,
    requirements: variant === "formal"
      ? request.content.brief.split("\n\n【正剧制作参数】", 1)[0].trim()
      : request.content.requirements || request.content.brief,
  };
  if (variant !== "formal") return restored;

  const formatLabel = directives.match(/影视类型：([^\n]+)/u)?.[1]?.trim();
  const actLabel = directives.match(/幕结构：([^\n]+)/u)?.[1]?.trim();
  const continuityLabel = directives.match(/场次连续性：([^\n]+)/u)?.[1]?.trim();
  const duration = Number(directives.match(/单集目标时长：(\d+)\s*分钟/u)?.[1]);
  return {
    ...restored,
    formalFormat: FORMAL_FORMAT_OPTIONS.find((option) => option.label === formatLabel)?.value || defaults.formalFormat,
    episodeDurationMinutes: Number.isInteger(duration) && duration >= 10 && duration <= 180
      ? duration
      : defaults.episodeDurationMinutes,
    actStructure: FORMAL_ACT_OPTIONS.find((option) => option.label === actLabel)?.value || defaults.actStructure,
    sceneContinuity: FORMAL_CONTINUITY_OPTIONS.find((option) => option.label === continuityLabel)?.value || defaults.sceneContinuity,
    characterArc: sectionValue(directives, "【人物弧】", "【关系冲突】"),
    relationshipConflict: sectionValue(directives, "【关系冲突】", "【伏笔与回收】"),
    foreshadowingPlan: sectionValue(directives, "【伏笔与回收】", "【硬约束】"),
  };
}

function createClientRequestId(prefix: GeneralScriptVariantConfig["requestPrefix"]): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function readErrorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  for (const key of ["error", "message", "detail"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      const message = candidate.trim();
      return /API|接口|HTTP|provider|供应商|上游|渠道|密钥|数据库|迁移|fixture|验收|结构化/iu.test(message)
        ? fallback
        : message;
    }
  }
  return fallback;
}

function readInternalProjectHref(value: unknown): string {
  if (!isRecord(value)) return "";
  for (const key of ["href", "projectHref", "redirectTo"]) {
    const candidate = value[key];
    if (
      typeof candidate === "string"
      && candidate.startsWith("/tools/film-studio/projects/")
      && !candidate.startsWith("//")
    ) {
      return candidate;
    }
  }
  for (const key of ["data", "project"]) {
    const nested = readInternalProjectHref(value[key]);
    if (nested) return nested;
  }
  return "";
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export function GeneralScriptOfficial({
  variant = "general",
  brandLabel = "自媒体操盘手",
}: {
  variant?: GeneralScriptOfficialVariant;
  brandLabel?: string;
}) {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <div className={styles.page}><p role="status">请先登录后查看自己的剧本草稿。</p></div>;
  return <UserGeneralScriptOfficial key={`${identity.userId}:${variant}`} variant={variant} brandLabel={brandLabel} identity={identity} />;
}

function UserGeneralScriptOfficial({ variant, brandLabel, identity }: {
  variant: GeneralScriptOfficialVariant; brandLabel: string; identity: WorkbenchIdentity;
}) {
  const config = VARIANT_CONFIG[variant];
  const storageKey = workbenchUserStorageKey(config.draftKey, identity.userId);
  const defaults = variant === "formal" ? FORMAL_DEFAULT_DRAFT : DEFAULT_DRAFT;
  const toneOptions = variant === "formal" ? FORMAL_TONE_OPTIONS : TONE_OPTIONS;
  const router = useAppScopedRouter();
  const requestControllerRef = useRef<AbortController | null>(null);
  const generationIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draft, setDraft] = useState<GeneralScriptOfficialDraft>(defaults);
  const [workflow, setWorkflow] = useState<WorkflowState>({ status: "idle" });
  const [candidate, setCandidate] = useState<GeneratedCandidate | null>(null);
  const [historyRefreshNonce, setHistoryRefreshNonce] = useState(0);

  useEffect(() => {
    // Editable material is deliberately session-only. An already-submitted
    // request keeps its separate idempotency pointer, but a later page visit
    // always starts with a clean editor.
    setDraft(defaults);
    try { window.localStorage.removeItem(storageKey); } catch { /* The in-memory editor is already clean. */ }
    generationIdentityRef.current = readGeneralScriptSubmission(config.draftKey, identity.userId);
    return () => requestControllerRef.current?.abort();
  }, [config.draftKey, defaults, identity.userId, storageKey]);

  const selectedAudience = useMemo(
    () => AUDIENCE_OPTIONS.find((option) => option.value === draft.targetAudience) ?? AUDIENCE_OPTIONS[0],
    [draft.targetAudience],
  );
  const selectedTone = useMemo(
    () => toneOptions.find((option) => option.value === draft.tone) ?? toneOptions[0],
    [draft.tone, toneOptions],
  );
  const totalEpisodes = draft.totalEpisodes ? Number(draft.totalEpisodes) : null;

  function updateDraft<K extends keyof GeneralScriptOfficialDraft>(
    key: K,
    value: GeneralScriptOfficialDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (workflow.status !== "working") setWorkflow({ status: "idle" });
    setCandidate(null);
  }

  function getAuthToken(): string {
    return identity.token;
  }

  function loadHistoryRetry(request: GeneralScriptRequest, failedRequestId: string) {
    generationIdentityRef.current = null;
    clearGeneralScriptSubmission(config.draftKey, identity.userId, failedRequestId);
    setCandidate(null);
    setDraft(draftFromHistoryRequest(request, variant, defaults));
    setWorkflow({ status: "idle" });
    setStep(2);
  }

  function loadHistoryResult(result: GeneralScriptResult, clientRequestId: string) {
    setCandidate({ result, clientRequestId });
    setWorkflow({
      status: "error",
      phase: "saving",
      message: "已从账号历史载入生成结果。确认后可继续保存到影视工坊项目。",
    });
    setStep(3);
  }

  function stepOneError(): string {
    const maximumEpisodes = variant === "formal" ? 5 : 10;
    if (draft.episodesToGenerate < 1 || draft.episodesToGenerate > maximumEpisodes) {
      return `本次生成集数必须在 1 到 ${maximumEpisodes} 集之间。`;
    }
    if (draft.tone === "custom" && !draft.customTone.trim()) {
      return "选择自定义基调后，请填写具体基调。";
    }
    if (draft.totalEpisodes) {
      const total = Number(draft.totalEpisodes);
      if (!Number.isInteger(total) || total < 1 || total > 500) {
        return "总集数必须是 1 到 500 之间的整数，或留空采用开放式长剧。";
      }
      if (total < draft.episodesToGenerate) {
        return "总集数不能小于本次生成集数。";
      }
    }
    if (
      variant === "formal"
      && (!Number.isInteger(draft.episodeDurationMinutes)
        || draft.episodeDurationMinutes < 10
        || draft.episodeDurationMinutes > 180)
    ) {
      return "正剧单集目标时长必须是 10 到 180 分钟之间的整数。";
    }
    return "";
  }

  function stepTwoError(): string {
    if (draft.creationMode === "adaptation" && !draft.sourceMaterial.trim()) {
      return "素材驱动改编必须粘贴原文、故事大纲或小说片段。";
    }
    if (!draft.requirements.trim()) {
      return "请填写故事需求描述。";
    }
    if (variant === "formal" && !draft.characterArc.trim()) {
      return "请填写正剧主要人物弧，说明人物从起点到终点的关键转变。";
    }
    if (variant === "formal" && !draft.relationshipConflict.trim()) {
      return "请填写核心关系冲突，说明冲突双方、利益和不可调和点。";
    }
    if (buildSubmissionBrief(draft, variant).length > MAX_TEXT_LENGTH) {
      return "正剧需求与叙事工程参数合计超过 100,000 字符，请精简后重试。";
    }
    return "";
  }

  function goToStepTwo() {
    const message = stepOneError();
    if (message) {
      setWorkflow({ status: "error", phase: "generating", message });
      return;
    }
    setWorkflow({ status: "idle" });
    setStep(2);
  }

  async function importProject(
    generated: GeneratedCandidate,
    token: string,
    signal: AbortSignal,
  ): Promise<string> {
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
      throw new Error(readErrorMessage(payload, "影视工坊项目保存失败，请稍后重试。"));
    }
    const href = readInternalProjectHref(payload);
    if (!href) {
      throw new Error("影视工坊项目保存结果不完整，请稍后重试。");
    }
    return href;
  }

  async function generateAndSave() {
    const firstError = stepOneError();
    const secondError = stepTwoError();
    const validationError = firstError || secondError;
    if (validationError) {
      setWorkflow({ status: "error", phase: "generating", message: validationError });
      setStep(firstError ? 1 : 2);
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const token = getAuthToken();
    let failurePhase: "generating" | "saving" = "generating";
    setCandidate(null);
    setStep(3);
    setWorkflow({ status: "working", phase: "generating" });

    try {
      const submissionBrief = buildSubmissionBrief(draft, variant);
      const submissionRequirements = variant === "formal"
        ? buildFormalDirectives(draft)
        : draft.requirements.trim();
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
          genre: config.genre,
          animationStyle: config.animationStyle,
          videoSize: config.videoSize,
          episodesToGenerate: draft.episodesToGenerate,
          totalEpisodes,
          isFinale: false,
        },
        content: {
          title: "",
          brief: submissionBrief,
          sourceMaterial: draft.sourceMaterial.trim(),
          requirements: submissionRequirements,
        },
        rewriteEpisodeNumbers: [] as number[],
        rewriteInstruction: "",
      };
      const submissionIdentity = resolveClientSubmissionIdentity(
        generationIdentityRef.current,
        await buildClientRequestFingerprint(generationRequest),
        () => createClientRequestId(config.requestPrefix),
      );
      generationIdentityRef.current = submissionIdentity;
      saveGeneralScriptSubmission(config.draftKey, identity.userId, submissionIdentity);
      const clientRequestId = submissionIdentity.requestId;
      const response = await fetch("/api/general-script", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Idempotency-Key": clientRequestId,
          "X-General-Script-Surface": variant,
        },
        body: JSON.stringify(generationRequest),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new Error(readErrorMessage(payload, "剧本生成服务暂时不可用，请稍后重试。"));
      }
      if (payload.executionMode !== "real") {
        throw new Error("当前生成结果暂时不能保存为正式项目，请稍后重试。");
      }
      if (controller.signal.aborted) return;
      const generated: GeneratedCandidate = {
        clientRequestId,
        result: parseGeneralScriptResult(payload.result),
      };
      setCandidate(generated);
      failurePhase = "saving";
      const href = await importProject(generated, token, controller.signal);
      if (controller.signal.aborted) return;
      generationIdentityRef.current = clearConfirmedClientSubmissionIdentity(generationIdentityRef.current, clientRequestId);
      clearGeneralScriptSubmission(config.draftKey, identity.userId, clientRequestId);
      setWorkflow({ status: "success", href });
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // The saved database project is already authoritative.
      }
      router.push(href);
    } catch (error) {
      if (controller.signal.aborted) return;
      setWorkflow({
        status: "error",
        phase: failurePhase,
        message: error instanceof Error ? error.message : "剧本创建失败，请稍后重试。",
      });
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setHistoryRefreshNonce((value) => value + 1);
    }
  }

  async function retryProjectSave() {
    if (!candidate) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    try {
      const href = await importProject(candidate, getAuthToken(), controller.signal);
      if (controller.signal.aborted) return;
      generationIdentityRef.current = clearConfirmedClientSubmissionIdentity(generationIdentityRef.current, candidate.clientRequestId);
      clearGeneralScriptSubmission(config.draftKey, identity.userId, candidate.clientRequestId);
      setWorkflow({ status: "success", href });
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // The database result, not local storage, is the source of truth.
      }
      router.push(href);
    } catch (error) {
      if (controller.signal.aborted) return;
      setWorkflow({
        status: "error",
        phase: "saving",
        message: error instanceof Error ? error.message : "影视工坊项目保存失败。",
      });
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  return (
    <div
      className={styles.page}
      data-testid={config.testId}
      data-profile-id={GENERAL_SCRIPT_PROFILE_ID}
      data-workflow-variant={variant}
    >
      <div className={styles.pageInner}>
        <header className={styles.hero}>
          <Link className={styles.backLink} href="/tools/text">
            <ArrowLeft size={15} aria-hidden="true" />
            返回文本创作
          </Link>
          <div className={styles.heroCopy}>
            <h1><FolderOpen size={31} aria-hidden="true" /> {config.title}</h1>
            <p>{config.description}</p>
          </div>
          <ol className={styles.progress} aria-label={`${config.title}步骤`}>
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
            <section className={styles.wizardCard} aria-label={`${config.title}基础设置`}>
              <div className={styles.sectionTitle}>
                <span>1</span>
                <h2>选择创作类型</h2>
              </div>
              <div className={styles.modeGrid} role="group" aria-label="创作类型">
                <button
                  type="button"
                  className={styles.modeCard}
                  data-tone="original"
                  aria-pressed={draft.creationMode === "original"}
                  onClick={() => updateDraft("creationMode", "original")}
                >
                  <strong><Sparkles size={21} /> 需求驱动·原创</strong>
                  <p>根据你的需求描述创作全新剧本。提供故事框架、主角设定、情节走向等，AI 据此原创完整故事。</p>
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
                  <p>根据你提供的原文素材改编为剧本。粘贴小说片段、故事原文或大纲，AI 提取精华并转换为剧本格式。</p>
                  <span><em>小说片段改编</em><em>故事原文改编</em><em>大纲扩充</em></span>
                </button>
              </div>

              <div className={styles.sectionTitle}>
                <span>2</span>
                <h2>基础设定</h2>
              </div>
              <div className={styles.settingsGrid}>
                <fieldset className={styles.optionFieldset}>
                  <legend>目标受众</legend>
                  <div className={styles.segmented}>
                    {AUDIENCE_OPTIONS.map((option) => (
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
                    {toneOptions.map((option) => (
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
                  <span>{variant === "formal" ? "本次生成集数" : "生成集数"} <small>{variant === "formal" ? "建议 1 集逐集精修" : "建议 ≤ 5 集"}</small></span>
                  <select
                    aria-label={variant === "formal" ? "正剧本次生成集数" : "通用短剧生成集数"}
                    data-testid={variant === "formal" ? "formal-episodes-to-generate" : undefined}
                    value={draft.episodesToGenerate}
                    onChange={(event) => updateDraft("episodesToGenerate", Number(event.target.value))}
                  >
                    {Array.from({ length: variant === "formal" ? 5 : 10 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>{count} 集</option>
                    ))}
                  </select>
                </label>
                <label className={styles.selectField}>
                  <span>{variant === "formal" ? "全剧总集数" : "总集数"}</span>
                  <input
                    aria-label={variant === "formal" ? "正剧全剧总集数" : "通用短剧总集数"}
                    data-testid={variant === "formal" ? "formal-total-episodes" : undefined}
                    type="number"
                    min={1}
                    max={500}
                    inputMode="numeric"
                    value={draft.totalEpisodes}
                    placeholder={variant === "formal" ? "不设定（长篇连载）" : "不设定（开放式长剧）"}
                    onChange={(event) => updateDraft("totalEpisodes", event.target.value.replace(/\D/g, "").slice(0, 3))}
                  />
                </label>
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
              {variant === "formal" && (
                <>
                  <div className={styles.sectionTitle}>
                    <span>3</span>
                    <h2>正剧制作规格</h2>
                    <i title="这些参数会整理为本次剧本的创作要求。">?</i>
                  </div>
                  <div className={styles.formalSettingsGrid} aria-label="正剧制作规格">
                    <label className={styles.selectField}>
                      <span>影视类型</span>
                      <select
                        aria-label="正剧影视类型"
                        data-testid="formal-production-format"
                        value={draft.formalFormat}
                        onChange={(event) => updateDraft("formalFormat", event.target.value as FormalProductionFormat)}
                      >
                        {FORMAL_FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={styles.selectField}>
                      <span>单集目标时长 <small>不得低于 10 分钟</small></span>
                      <input
                        aria-label="正剧单集目标时长（分钟）"
                        data-testid="formal-episode-duration"
                        type="number"
                        min={10}
                        max={180}
                        inputMode="numeric"
                        value={draft.episodeDurationMinutes}
                        onChange={(event) => updateDraft("episodeDurationMinutes", Number(event.target.value))}
                      />
                    </label>
                    <label className={styles.selectField}>
                      <span>幕结构</span>
                      <select
                        aria-label="正剧幕结构"
                        data-testid="formal-act-structure"
                        value={draft.actStructure}
                        onChange={(event) => updateDraft("actStructure", event.target.value as FormalActStructure)}
                      >
                        {FORMAL_ACT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={styles.selectField}>
                      <span>场次连续性</span>
                      <select
                        aria-label="正剧场次连续性"
                        data-testid="formal-scene-continuity"
                        value={draft.sceneContinuity}
                        onChange={(event) => updateDraft("sceneContinuity", event.target.value as FormalSceneContinuity)}
                      >
                        {FORMAL_CONTINUITY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className={styles.selectField}>
                      <span>默认画幅</span>
                      <input aria-label="正剧默认画幅" data-testid="formal-video-size" readOnly value="16:9 横屏" />
                    </label>
                  </div>
                </>
              )}
              {workflow.status === "error" && step === 1 && (
                <div className={styles.inlineError} role="alert">{workflow.message}</div>
              )}
              <div className={styles.setupFooter}>
                <span>表单草稿只保存在本机，不会被当作影视工坊项目。</span>
                <button type="button" className={styles.primaryButton} onClick={goToStepTwo}>
                  下一步：输入内容 <ArrowRight size={17} />
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className={styles.wizardCard} aria-label={`${config.title}故事需求`}>
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
                <span>{variant === "formal" ? 4 : 3}</span>
                <h2>{variant === "formal" ? "正剧故事命题" : "故事需求描述"}</h2>
                <i title={variant === "formal" ? "故事需求和正剧创作参数会一起用于生成。" : "基础设定和两块文本会一起用于生成。"}>?</i>
              </div>
              <div className={styles.summaryBar} aria-label="已选设置">
                <span>类型: {draft.creationMode === "original" ? "✨ 原创" : "📖 改编"}</span>
                <span>受众: {selectedAudience.emoji} {selectedAudience.label}</span>
                <span>基调: {selectedTone.emoji} {draft.tone === "custom" ? draft.customTone : selectedTone.label}</span>
                <span>生成: {draft.episodesToGenerate}集</span>
                <span>总集数: {totalEpisodes ? `${totalEpisodes}集` : "不设定"}</span>
                {variant === "formal" && (
                  <>
                    <span>影视类型: {optionLabel(FORMAL_FORMAT_OPTIONS, draft.formalFormat)}</span>
                    <span>单集时长: {draft.episodeDurationMinutes}分钟</span>
                    <span>幕结构: {optionLabel(FORMAL_ACT_OPTIONS, draft.actStructure)}</span>
                    <span>画幅: 16:9</span>
                  </>
                )}
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
                    : "可粘贴参考素材，AI 会参考其写作风格和剧创作，不会照搬原文内容。"}
                  onChange={(event) => updateDraft("sourceMaterial", event.target.value)}
                />
                <em>{draft.sourceMaterial.length.toLocaleString("zh-CN")} / 100,000 字符</em>
              </label>

              {variant === "formal" && (
                <>
                  <div className={styles.sectionTitle}>
                    <span>5</span>
                    <h2>正剧叙事工程</h2>
                    <i title="人物弧和关系冲突为必填，伏笔回收可由模型按主线补全。">?</i>
                  </div>
                  <div
                    className={styles.formalNarrativeGrid}
                    data-testid="formal-narrative-engineering"
                    aria-label="正剧叙事工程字段"
                  >
                    <label className={styles.formalNarrativeField}>
                      <span>主要人物弧 <b>*必填</b></span>
                      <textarea
                        aria-label="正剧主要人物弧"
                        data-testid="formal-character-arc"
                        maxLength={MAX_FORMAL_FIELD_LENGTH}
                        value={draft.characterArc}
                        placeholder="例如：主角从回避责任到愿意承担代价；标明起点、诱因、错误选择、顿悟与终局转变。"
                        onChange={(event) => updateDraft("characterArc", event.target.value)}
                      />
                      <em>{draft.characterArc.length} / {MAX_FORMAL_FIELD_LENGTH}</em>
                    </label>
                    <label className={styles.formalNarrativeField}>
                      <span>核心关系冲突 <b>*必填</b></span>
                      <textarea
                        aria-label="正剧核心关系冲突"
                        data-testid="formal-relationship-conflict"
                        maxLength={MAX_FORMAL_FIELD_LENGTH}
                        value={draft.relationshipConflict}
                        placeholder="例如：说明冲突双方、各自想要什么、共享的秘密、利益相撞点和关系变化节点。"
                        onChange={(event) => updateDraft("relationshipConflict", event.target.value)}
                      />
                      <em>{draft.relationshipConflict.length} / {MAX_FORMAL_FIELD_LENGTH}</em>
                    </label>
                    <label className={styles.formalNarrativeField}>
                      <span>伏笔与回收 <small>（可选）</small></span>
                      <textarea
                        aria-label="正剧伏笔与回收计划"
                        data-testid="formal-foreshadowing-plan"
                        maxLength={MAX_FORMAL_FIELD_LENGTH}
                        value={draft.foreshadowingPlan}
                        placeholder="记录伏笔物件、信息或行为，约定埋设场次、误导方式和回收场次；留空则由模型按主线设计。"
                        onChange={(event) => updateDraft("foreshadowingPlan", event.target.value)}
                      />
                      <em>{draft.foreshadowingPlan.length} / {MAX_FORMAL_FIELD_LENGTH}</em>
                    </label>
                  </div>
                </>
              )}

              <div className={styles.requirementHeading}>
                <label htmlFor={config.requirementsId}>{variant === "formal" ? "正剧主线需求" : "需求描述"} <b>*必填</b></label>
                <button
                  type="button"
                  disabled
                  title="需求优化功能正在准备中。"
                >
                  <Sparkles size={14} /> AI优化需求
                </button>
              </div>
              <textarea
                id={config.requirementsId}
                className={styles.requirementsInput}
                value={draft.requirements}
                maxLength={MAX_TEXT_LENGTH}
                placeholder={variant === "formal" ? FORMAL_REQUIREMENTS_PLACEHOLDER : REQUIREMENTS_PLACEHOLDER}
                onChange={(event) => updateDraft("requirements", event.target.value)}
              />
              <div className={styles.characterCount}>
                {draft.requirements.length.toLocaleString("zh-CN")} / 100,000 字符
              </div>
              {workflow.status === "error" && step === 2 && (
                <div className={styles.inlineError} role="alert">{workflow.message}</div>
              )}
              <div className={styles.generateFooter}>
                <small>提交后开始生成剧本；生成成功后会保存为影视工坊项目。</small>
                <button
                  type="button"
                  className={styles.primaryButton}
                  data-testid={config.generateTestId}
                  onClick={() => void generateAndSave()}
                >
                  <Clapperboard size={18} /> {variant === "formal" ? "生成正剧剧本" : "生成剧本"}
                </button>
              </div>
            </section>
          )}

          {step === 3 && (
            <section className={`${styles.wizardCard} ${styles.statusCard}`} aria-label={`${config.title}创建状态`}>
              <div className={styles.statusIcon} data-error={workflow.status === "error" ? "true" : undefined}>
                {workflow.status === "working" ? <Loader2 className={styles.spinner} size={32} /> : workflow.status === "success" ? <Check size={32} /> : <FileText size={32} />}
              </div>
              {workflow.status === "working" && (
                <>
                  <h2>{workflow.phase === "generating" ? "正在生成完整剧本" : "正在保存影视工坊项目"}</h2>
                  <p>{workflow.phase === "generating"
                    ? "主站文案模型正在创建剧集、角色、场景与道具，请勿关闭页面。"
                    : "剧本已经生成，正在保存项目并建立工作台入口。"}</p>
                  <div className={styles.statusSteps}>
                    <span data-active="true"><b>1</b> 生成剧本</span>
                    <span data-active={workflow.phase === "saving" ? "true" : undefined}><b>2</b> 整理项目内容</span>
                    <span data-active={workflow.phase === "saving" ? "true" : undefined}><b>3</b> 保存影视工坊项目</span>
                  </div>
                </>
              )}
              {workflow.status === "error" && (
                <>
                  <h2>{workflow.phase === "saving" ? "剧本已生成，但项目尚未保存" : "剧本创建未完成"}</h2>
                  <p className={styles.statusError} role="alert">{workflow.message}</p>
                  <div className={styles.statusActions}>
                    {workflow.phase === "saving" && candidate ? (
                      <button type="button" className={styles.primaryButton} onClick={() => void retryProjectSave()}>
                        <Upload size={17} /> 重试保存项目
                      </button>
                    ) : (
                      <button type="button" className={styles.primaryButton} onClick={() => setStep(2)}>
                        <ArrowLeft size={17} /> 返回修改需求
                      </button>
                    )}
                    <Link href="/login">前往登录</Link>
                  </div>
                  <small className={styles.truthNotice}>
                    项目保存成功后才会进入影视工坊；失败时会保留已填写的内容。
                  </small>
                </>
              )}
              {workflow.status === "success" && (
                <>
                  <h2>影视工坊项目已创建</h2>
                  <p>正在进入真实项目工作台。如果浏览器没有自动跳转，可使用下方入口。</p>
                  <Link className={styles.primaryLink} href={workflow.href}>进入项目 <ArrowRight size={17} /></Link>
                </>
              )}
              {workflow.status === "idle" && (
                <>
                  <h2>准备创建项目</h2>
                  <p>返回需求页确认内容后再提交。</p>
                  <button type="button" className={styles.primaryButton} onClick={() => setStep(2)}>
                    <ArrowLeft size={17} /> 返回需求页
                  </button>
                </>
              )}
            </section>
          )}

          <GeneralScriptHistoryPanel
            token={identity.token}
            surface={variant}
            endpoint="/api/general-script"
            refreshNonce={historyRefreshNonce}
            onLoadRetry={loadHistoryRetry}
            onLoadResult={loadHistoryResult}
          />

          <GuideSection guideId={config.guideId} variant={variant} />
        </main>

      <footer className={styles.footer}>© 2026 {brandLabel} · 关于我们 · 商务合作</footer>
      </div>
    </div>
  );
}

function GuideSection({
  guideId,
  variant,
}: {
  guideId: GeneralScriptVariantConfig["guideId"];
  variant: GeneralScriptOfficialVariant;
}) {
  const guideSteps = variant === "formal" ? FORMAL_GUIDE_STEPS : GUIDE_STEPS;
  return (
    <section className={styles.guide} aria-labelledby={guideId}>
      <div className={styles.guideHeading}>
        <h2 id={guideId}><Sparkles size={22} /> {variant === "formal" ? "正剧创作指南" : "使用指南"}</h2>
        <p>{variant === "formal" ? "从故事工程、人物关系到分场剧本与伏笔回收" : "从创意到成片的自动化制作流程"}</p>
      </div>
      <div className={styles.flowPanel}>
        <h3><Clapperboard size={25} /> {variant === "formal" ? "正剧制作全流程" : "制作全流程"}</h3>
        <p><strong>你当前在第 1 步。</strong> {variant === "formal" ? "先锁定长叙事结构与人物关系，生成后在影视工坊逐集定稿。" : "创作完剧本后，后续步骤请在「创意工坊」中继续。"}</p>
        <div className={styles.flowGrid}>
          {guideSteps.map((item) => {
            const Icon = item.icon;
            return (
              <article data-current={item.number === 1 ? "true" : undefined} key={item.number}>
                <Icon size={23} />
                <div><b>{item.number}</b><strong>{item.title}</strong></div>
                <p>{item.description}</p>
              </article>
            );
          })}
        </div>
      </div>

      {variant === "general" && (
        <>
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
        {INFO_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <article className={styles.infoCard} data-tone={card.tone} key={card.title}>
              <header><span><Icon size={21} /></span><div><h3>{card.title}</h3><p>{card.subtitle}</p></div></header>
              <ul>{card.points.map((point) => <li key={point}>{point}</li>)}</ul>
            </article>
          );
        })}
          </div>
        </>
      )}

      {variant === "formal" && <FormalGuideDetails />}
    </section>
  );
}

function FormalGuideDetails() {
  return (
    <>
      <div className={styles.modeInfoGrid}>
        <article className={styles.modeInfoCard} data-tone="original">
          <header><span><Film size={21} /></span><div><h3>电影 / 单本正剧</h3><p>用完整人物弧支撑一次集中观看</p></div></header>
          <ul>
            <li>在一部作品中完成 <b>开端事件、中点转向、危机与终局</b></li>
            <li>单集时长通常设为 60–120 分钟，本次建议生成 1 集</li>
            <li>伏笔必须在终局前完成回收，人物最终选择回应主命题</li>
          </ul>
        </article>
        <article className={styles.modeInfoCard} data-tone="adaptation">
          <header><span><BookOpen size={21} /></span><div><h3>电视剧 / 网剧 / 限定剧</h3><p>单集有闭环，全剧有持续发展的主线</p></div></header>
          <ul>
            <li>每集至少推进 <b>一条主线、一次关系变化和一个信息增量</b></li>
            <li>优先逐集生成与定稿，使用人物弧和场次连续性保持前后一致</li>
            <li>中期转折与终局回收要在全剧层面预先规划</li>
          </ul>
        </article>
      </div>

      <section className={styles.longFormPanel}>
        <header><span>🎬</span><div><h3>正剧交付前的四项硬检查</h3><p>长叙事不只是台词更多，而是结构、人物和场次都可追踪</p></div></header>
        <div>
          <article><b>1</b><h4>幕结构</h4><p>每一幕有清晰目标、阻力和不可逆的转折。</p><p>每一场都服务主命题、人物弧或核心冲突。</p></article>
          <article><b>2</b><h4>人物弧</h4><p>记录人物的起点信念、错误选择、代价、顿悟与终局选择。</p><p>变化必须由剧情事件触发，不用突然转性。</p></article>
          <article><b>3</b><h4>关系与场次</h4><p>每次对手戏都应改变信息、力量或情感关系。</p><p>核对时间线、地点、服化道、人物所知信息与伤势状态。</p></article>
          <article><b>4</b><h4>伏笔回收</h4><p>为每个伏笔记录埋设、强化、误导和回收场次。</p><p>终局前核对未回收信息，避免只靠解释性对白补漏。</p></article>
        </div>
      </section>
    </>
  );
}
