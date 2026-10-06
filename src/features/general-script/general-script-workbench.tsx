"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  Clipboard,
  Copy,
  FileJson,
  Film,
  Loader2,
  PenLine,
  RefreshCcw,
  RotateCcw,
  Sparkles,
  Users,
} from "lucide-react";
import { SubPageHeader } from "@/components/sub-page-header";
import { VideoStylePicker } from "@/components/video-style-picker";
import { useApp } from "@/contexts/app-context";
import { resolveWorkbenchIdentity, type WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { readGeneralScriptSubmission, saveGeneralScriptSubmission, clearGeneralScriptSubmission } from "./submission-storage";
import {
  GENERAL_SCRIPT_PROFILE_ID,
  GENERAL_SCRIPT_PROFILE_VERSION,
  PET_SILENT_NARRATION_PROFILE_ID,
  parseGeneralScriptResult,
  type GeneralScriptApiError,
  type GeneralScriptApiSuccess,
  type GeneralScriptResult,
} from "@/lib/short-drama/general-script-contract";
import {
  clearConfirmedClientSubmissionIdentity,
  resolveClientSubmissionIdentity,
  type ClientSubmissionIdentity,
} from "@/lib/short-drama/client-submission-identity";
import { buildClientRequestFingerprint } from "@/lib/browser-client-attempt";
import {
  clearGeneralScriptDraft,
  saveGeneralScriptHandoff,
} from "./storage";
import {
  applyProfileDefaultsToEmptyDraft,
  createDefaultGeneralScriptDraft,
  DEFAULT_GENERAL_SCRIPT_DRAFT,
  type GeneralScriptDraft,
} from "./types";

const FIELD_CLASS =
  "w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-violet-400/30";
const CARD_CLASS = "rounded-2xl border bg-[var(--card)] shadow-sm";

const OPERATIONS = [
  {
    value: "generate" as const,
    label: "初次生成",
    description: "从第 1 集创建完整项目",
    icon: Sparkles,
  },
  {
    value: "continue" as const,
    label: "续写",
    description: "保留已有项目并接着写",
    icon: ArrowRight,
  },
  {
    value: "rewrite" as const,
    label: "重写",
    description: "只改指定集并返回完整项目",
    icon: RefreshCcw,
  },
];

const PROJECT_TYPES = [
  {
    value: GENERAL_SCRIPT_PROFILE_ID,
    label: "通用短剧",
    description: "适合常规对白、旁白或混合叙事项目",
    icon: BookOpen,
  },
  {
    value: PET_SILENT_NARRATION_PROFILE_ID,
    label: "宠物无口型口播（单条）",
    description: "单条视频，后期旁白，角色靠表情、动作与语义道具演出",
    icon: Sparkles,
  },
] as const;

const AUDIENCES = [
  { value: "all_ages" as const, label: "全年龄" },
  { value: "children" as const, label: "儿童" },
  { value: "teen" as const, label: "青少年" },
  { value: "adult" as const, label: "成人" },
];

const TONES = [
  { value: "emotional" as const, label: "情感" },
  { value: "suspense" as const, label: "悬疑" },
  { value: "comedy" as const, label: "喜剧" },
  { value: "inspiring" as const, label: "励志" },
  { value: "warm" as const, label: "温暖" },
  { value: "serious" as const, label: "严肃" },
  { value: "custom" as const, label: "自定义" },
];

const VIDEO_SIZES = ["9:16", "16:9", "1:1", "4:3"] as const;

function parseRewriteNumbers(value: string): number[] {
  return Array.from(
    new Set(
      value
        .split(/[,，、\s]+/)
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  ).sort((a, b) => a - b);
}

function formatResultAsText(result: GeneralScriptResult): string {
  const summary = [
    result.summary.title,
    "主角：" + result.summary.protagonist,
    "一句话：" + result.summary.oneSentence,
    "类型：" + result.summary.genre,
    "梗概：" + result.summary.synopsis,
    "背景：" + result.summary.background,
    "场域：" + result.summary.setting,
  ].join("\n");
  const episodes = result.episodes.map((episode) =>
    [
      "第" + episode.episodeNumber + "集 " + episode.title,
      episode.logline,
      episode.content,
      "结尾钩子：" + episode.endingHook,
    ].join("\n"),
  ).join("\n\n");
  return summary + "\n\n" + episodes;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function parseApiPayload(value: unknown): GeneralScriptApiSuccess | GeneralScriptApiError {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return { ok: false, error: "生成结果格式异常", code: "INVALID_API_RESPONSE" };
  }
  return value as GeneralScriptApiSuccess | GeneralScriptApiError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createClientRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return "general-script-" + uuid;
  return "general-script-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function findProjectHref(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const directCandidates = [payload.href, payload.projectHref, payload.redirectTo];
  for (const candidate of directCandidates) {
    if (
      typeof candidate === "string"
      && candidate.startsWith("/")
      && !candidate.startsWith("//")
    ) {
      return candidate;
    }
  }
  const nestedCandidates = [payload.project, payload.data];
  for (const candidate of nestedCandidates) {
    const nested = findProjectHref(candidate);
    if (nested) return nested;
  }
  return "";
}

function findEndpointError(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const value = typeof payload.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : "";
  if (value) {
    return /API|接口|HTTP|provider|供应商|上游|渠道|密钥|数据库|迁移|fixture|验收|结构化/iu.test(value)
      ? fallback
      : value;
  }
  return fallback;
}

function whitelistedProfile(
  value: string | null,
): GeneralScriptDraft["profileId"] | null {
  if (value === GENERAL_SCRIPT_PROFILE_ID) return GENERAL_SCRIPT_PROFILE_ID;
  if (value === PET_SILENT_NARRATION_PROFILE_ID) return PET_SILENT_NARRATION_PROFILE_ID;
  return null;
}

export function GeneralScriptWorkbench() {
  const { state } = useApp();
  const identity = resolveWorkbenchIdentity(state.auth);
  if (!identity) return <p role="status">请先登录后查看自己的剧本草稿。</p>;
  return <UserGeneralScriptWorkbench key={identity.userId} identity={identity} />;
}

function UserGeneralScriptWorkbench({ identity }: { identity: WorkbenchIdentity }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydrationStartedRef = useRef(false);
  const generationIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const authToken = identity.token;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draft, setDraft] = useState<GeneralScriptDraft>(DEFAULT_GENERAL_SCRIPT_DRAFT);
  const [result, setResult] = useState<GeneralScriptResult | null>(null);
  const [executionMode, setExecutionMode] = useState<"fixture" | "real" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"text" | "json" | null>(null);
  const [savingToStudio, setSavingToStudio] = useState(false);
  const [studioSaveError, setStudioSaveError] = useState("");

  useEffect(() => {
    if (hydrationStartedRef.current) return;
    hydrationStartedRef.current = true;
    // Retire the old cross-session editor snapshot. Submitted projects and
    // terminal output are recovered from account history instead.
    clearGeneralScriptDraft(identity.userId);
    generationIdentityRef.current = readGeneralScriptSubmission("general_script_draft_v1", identity.userId);
    const requestedProfile = whitelistedProfile(searchParams.get("profile"));
    const profileId = requestedProfile || GENERAL_SCRIPT_PROFILE_ID;
    const freshDraft = createDefaultGeneralScriptDraft(profileId);
    setDraft({
      ...freshDraft,
      clientRequestId: createClientRequestId(),
    });
  }, [searchParams, identity.userId]);

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const selectedTone = useMemo(
    () => TONES.find((item) => item.value === draft.tone)?.label || draft.tone,
    [draft.tone],
  );

  function updateDraft<K extends keyof GeneralScriptDraft>(
    key: K,
    value: GeneralScriptDraft[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError("");
  }

  function selectOperation(operation: GeneralScriptDraft["operation"]) {
    setDraft((previous) => ({
      ...previous,
      operation,
      existingResultText: operation !== "generate" && !previous.existingResultText && result
        ? JSON.stringify(result, null, 2)
        : previous.existingResultText,
    }));
    setError("");
  }

  function selectProjectType(profileId: GeneralScriptDraft["profileId"]) {
    setDraft((previous) => applyProfileDefaultsToEmptyDraft(previous, profileId));
    setError("");
  }

  function validateStepOne(): boolean {
    if (!draft.genre.trim()) {
      setError("请填写视频类型");
      return false;
    }
    if (!draft.animationStyle.trim()) {
      setError("请填写动画风格");
      return false;
    }
    if (draft.episodesToGenerate < 1 || draft.episodesToGenerate > 20) {
      setError("本次生成集数必须在 1 到 20 之间");
      return false;
    }
    if (draft.totalEpisodes) {
      const total = Number(draft.totalEpisodes);
      if (!Number.isInteger(total) || total < 1 || total > 500) {
        setError("总集数必须是 1 到 500 之间的整数，或留空");
        return false;
      }
    }
    if (draft.tone === "custom" && !draft.customTone.trim()) {
      setError("请填写自定义故事基调");
      return false;
    }
    return true;
  }

  function parseExistingResult(): GeneralScriptResult | undefined {
    if (draft.operation === "generate") return undefined;
    if (!draft.existingResultText.trim()) {
      throw new Error("续写或重写需要粘贴已有完整项目 JSON");
    }
    return parseGeneralScriptResult(JSON.parse(draft.existingResultText) as unknown);
  }

  function validateStepTwo(): boolean {
    if (!draft.brief.trim() && !draft.sourceMaterial.trim()) {
      setError("故事需求或改编素材至少填写一项");
      return false;
    }
    if (draft.creationMode === "adaptation" && !draft.sourceMaterial.trim()) {
      setError("素材改编模式必须粘贴改编素材");
      return false;
    }
    try {
      parseExistingResult();
    } catch (parseError: unknown) {
      setError(parseError instanceof Error ? parseError.message : "已有项目 JSON 无法解析");
      return false;
    }
    if (draft.operation === "rewrite") {
      if (parseRewriteNumbers(draft.rewriteEpisodeNumbers).length === 0) {
        setError("请填写需要重写的集数，例如：2, 4");
        return false;
      }
      if (!draft.rewriteInstruction.trim()) {
        setError("请填写重写要求");
        return false;
      }
    }
    return true;
  }

  function goToStepTwo() {
    if (!validateStepOne()) return;
    setStep(2);
    setError("");
  }

  async function submit() {
    if (!validateStepOne() || !validateStepTwo()) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setSubmitting(true);
    setError("");
    try {
      const existingResult = parseExistingResult();
      const generationRequest = {
        profile: {
          id: draft.profileId,
          version: GENERAL_SCRIPT_PROFILE_VERSION,
        },
        operation: draft.operation,
        settings: {
          creationMode: draft.creationMode,
          targetAudience: draft.targetAudience,
          tone: draft.tone,
          customTone: draft.customTone,
          genre: draft.genre,
          animationStyle: draft.animationStyle,
          videoSize: draft.videoSize,
          episodesToGenerate: draft.episodesToGenerate,
          totalEpisodes: draft.totalEpisodes ? Number(draft.totalEpisodes) : null,
          isFinale: draft.isFinale,
        },
        content: {
          title: draft.title,
          brief: draft.brief,
          sourceMaterial: draft.sourceMaterial,
          requirements: draft.requirements,
        },
        existingResult,
        rewriteEpisodeNumbers: parseRewriteNumbers(draft.rewriteEpisodeNumbers),
        rewriteInstruction: draft.rewriteInstruction,
      };
      const submissionIdentity = resolveClientSubmissionIdentity(
        generationIdentityRef.current,
        await buildClientRequestFingerprint(generationRequest),
        createClientRequestId,
      );
      generationIdentityRef.current = submissionIdentity;
      saveGeneralScriptSubmission("general_script_draft_v1", identity.userId, submissionIdentity);
      const response = await fetch("/api/short-drama/script", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
          "Idempotency-Key": submissionIdentity.requestId,
        },
        body: JSON.stringify(generationRequest),
      });
      const payload = parseApiPayload(await response.json());
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "生成失败" : payload.error);
      }
      const validated = parseGeneralScriptResult(payload.result);
      if (controller.signal.aborted) return;
      const completedDraft: GeneralScriptDraft = {
        ...draft,
        existingResultText: JSON.stringify(validated, null, 2),
        clientRequestId: createClientRequestId(),
        lastExecutionMode: payload.executionMode,
        lastResult: validated,
      };
      generationIdentityRef.current = clearConfirmedClientSubmissionIdentity(generationIdentityRef.current, submissionIdentity.requestId);
      clearGeneralScriptSubmission("general_script_draft_v1", identity.userId, submissionIdentity.requestId);
      setResult(validated);
      setExecutionMode(payload.executionMode);
      setDraft(completedDraft);
      setStep(3);
    } catch (submitError: unknown) {
      if (controller.signal.aborted) return;
      setError(submitError instanceof Error ? submitError.message : "生成失败，请稍后重试");
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setSubmitting(false);
    }
  }

  async function handleCopy(kind: "text" | "json") {
    if (!result) return;
    const value = kind === "json"
      ? JSON.stringify(result, null, 2)
      : formatResultAsText(result);
    try {
      await copyText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setError("复制失败，请使用 JSON 视图手动复制");
    }
  }

  function startFollowUp(operation: "continue" | "rewrite") {
    if (!result) return;
    setDraft((previous) => ({
      ...previous,
      operation,
      existingResultText: JSON.stringify(result, null, 2),
      rewriteEpisodeNumbers: operation === "rewrite"
        ? String(result.episodes[result.episodes.length - 1]?.episodeNumber || "")
        : "",
    }));
    setStep(1);
    setError("");
  }

  function handoffToStudio() {
    if (!result) return;
    saveGeneralScriptHandoff(result, identity.userId);
    router.push("/storyboard-workbench?entry=short-drama&handoff=general-script");
  }

  async function saveToStudio() {
    if (!result) return;
    setStudioSaveError("");
    if (!authToken) {
      setStudioSaveError("请先登录；未登录状态不会向影视工坊提交项目。");
      return;
    }
    if (executionMode !== "real") {
      setStudioSaveError(
        executionMode === "fixture"
          ? "当前是离线预览结果，暂时不能保存为正式项目。"
          : "当前结果来源无法确认，请重新生成后再保存。",
      );
      return;
    }

    const clientRequestId = draft.clientRequestId || createClientRequestId();
    if (!draft.clientRequestId) updateDraft("clientRequestId", clientRequestId);
    setSavingToStudio(true);
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    try {
      const response = await fetch("/api/short-drama/projects/import-script", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + authToken,
        },
        body: JSON.stringify({
          title: result.summary.title,
          clientRequestId,
          result,
        }),
      });
      const text = await response.text();
      let payload: unknown = {};
      if (text.trim()) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = { error: text.slice(0, 500) };
        }
      }
      if (!response.ok) {
        throw new Error(findEndpointError(payload, "影视工坊项目保存服务暂时不可用"));
      }
      const href = findProjectHref(payload);
      if (!href) {
        throw new Error("项目保存结果不完整，请稍后重试。");
      }
      if (controller.signal.aborted) return;
      saveGeneralScriptHandoff(result, identity.userId);
      router.push(href);
    } catch (saveError: unknown) {
      if (controller.signal.aborted) return;
      setStudioSaveError(
        saveError instanceof Error ? saveError.message : "保存到影视工坊失败",
      );
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      setSavingToStudio(false);
    }
  }

  function resetDraft() {
    if (!window.confirm("确认清空当前输入和生成结果吗？")) return;
    clearGeneralScriptDraft(identity.userId);
    const resetProfile = whitelistedProfile(searchParams.get("profile")) || draft.profileId;
    setDraft({
      ...createDefaultGeneralScriptDraft(resetProfile),
      clientRequestId: createClientRequestId(),
    });
    setResult(null);
    setExecutionMode(null);
    setStep(1);
    setError("");
  }

  return (
    <div className="voice-studio-root vs-workbench min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <SubPageHeader
        title="通用短剧创作"
        subtitle="原创与改编 · 初次生成、续写、重写"
        icon={<BookOpen className="h-5 w-5" />}
        backHref="/tools"
        rightSlot={
          <button
            type="button"
            onClick={resetDraft}
            className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            清空草稿
          </button>
        }
      />

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <section className={CARD_CLASS + " overflow-hidden"}>
          <div className="bg-gradient-to-r from-blue-600 via-violet-600 to-fuchsia-600 px-5 py-6 text-white sm:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm text-white/80">
                  <Sparkles className="h-4 w-4" />
                  Prompt Profile {draft.profileId}@{GENERAL_SCRIPT_PROFILE_VERSION}
                </div>
                <h2 className="text-2xl font-black sm:text-3xl">三步完成可进入影视工坊的剧本项目</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-white/80">
                  统一产出项目摘要、完整剧集、角色、场景和道具，后续可以继续续写、重写或交给分镜链路。
                </p>
              </div>
              <div className="flex min-w-[280px] items-center gap-2">
                {[1, 2, 3].map((item) => {
                  const active = step === item;
                  const done = step > item;
                  return (
                    <div key={item} className="flex flex-1 items-center gap-2">
                      <div
                        className={
                          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black " +
                          (active || done ? "bg-white text-violet-700" : "bg-white/15 text-white/70")
                        }
                        aria-current={active ? "step" : undefined}
                      >
                        {done ? <Check className="h-4 w-4" /> : item}
                      </div>
                      {item < 3 && <div className="h-px flex-1 bg-white/30" />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="border-b border-[var(--border)] px-5 py-3 sm:px-8">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted-foreground)]">
              <span className={step === 1 ? "font-bold text-violet-600" : ""}>1. 创作方式与基础设置</span>
              <span className={step === 2 ? "font-bold text-violet-600" : ""}>2. 输入故事与已有项目</span>
              <span className={step === 3 ? "font-bold text-violet-600" : ""}>3. 查看、复制与交接</span>
              {draft.updatedAt && <span className="ml-auto">本地草稿已自动保存</span>}
            </div>
          </div>
        </section>

        {error && (
          <div
            className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
            role="alert"
          >
            {error}
          </div>
        )}

        {step === 1 && (
          <section className={CARD_CLASS + " mt-5 p-5 sm:p-8"}>
            <div className="mb-6">
              <h3 className="text-lg font-black">选择项目类型</h3>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                不同项目类型使用独立、可版本化的提示词配置。
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {PROJECT_TYPES.map((item) => {
                const Icon = item.icon;
                const selected = draft.profileId === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectProjectType(item.value)}
                    className={
                      "rounded-2xl border p-4 text-left transition " +
                      (selected
                        ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
                        : "border-[var(--border)] hover:border-blue-300 hover:bg-[var(--muted)]")
                    }
                  >
                    <Icon className={selected ? "h-5 w-5 text-blue-600" : "h-5 w-5"} />
                    <div className="mt-3 font-bold">{item.label}</div>
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">{item.description}</div>
                  </button>
                );
              })}
            </div>

            {draft.profileId === PET_SILENT_NARRATION_PROFILE_ID && (
              <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                硬约束：人物与宠物不张嘴、不做对白口型；语言全部由后期旁白承担，
                画面用表情、动作、视线、走位、环境反馈和语义道具推进。
              </div>
            )}

            <div className="mb-4 mt-8">
              <h3 className="text-lg font-black">选择本次任务</h3>
              <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                续写和重写会要求在下一步提供已有完整项目 JSON。
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {OPERATIONS.map((item) => {
                const Icon = item.icon;
                const selected = draft.operation === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectOperation(item.value)}
                    className={
                      "rounded-2xl border p-4 text-left transition " +
                      (selected
                        ? "border-violet-500 bg-violet-50 ring-2 ring-violet-200"
                        : "border-[var(--border)] hover:border-violet-300 hover:bg-[var(--muted)]")
                    }
                  >
                    <Icon className={selected ? "h-5 w-5 text-violet-600" : "h-5 w-5"} />
                    <div className="mt-3 font-bold">{item.label}</div>
                    <div className="mt-1 text-xs text-[var(--muted-foreground)]">{item.description}</div>
                  </button>
                );
              })}
            </div>

            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm font-bold">创作类型</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { value: "original" as const, label: "需求驱动 · 原创", icon: PenLine },
                    { value: "adaptation" as const, label: "素材驱动 · 改编", icon: Clipboard },
                  ].map((item) => {
                    const Icon = item.icon;
                    const selected = draft.creationMode === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => updateDraft("creationMode", item.value)}
                        className={
                          "flex items-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold " +
                          (selected
                            ? "border-orange-400 bg-orange-50 text-orange-700"
                            : "border-[var(--border)]")
                        }
                      >
                        <Icon className="h-4 w-4" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label htmlFor="animation-style" className="mb-2 block text-sm font-bold">
                  视觉风格 <span className="font-normal text-[var(--muted-foreground)]">（39 种预设或自定义）</span>
                </label>
                <VideoStylePicker
                  id="animation-style"
                  value={draft.animationStyle}
                  onChange={(value) => updateDraft("animationStyle", value)}
                  selectClassName={FIELD_CLASS}
                  inputClassName={FIELD_CLASS}
                  customPlaceholder="例如：商业级 3D 卡通、手绘水彩"
                />
              </div>

              <div>
                <label htmlFor="video-size" className="mb-2 block text-sm font-bold">
                  视频尺寸
                </label>
                <select
                  id="video-size"
                  value={draft.videoSize}
                  onChange={(event) => updateDraft(
                    "videoSize",
                    event.target.value as GeneralScriptDraft["videoSize"],
                  )}
                  className={FIELD_CLASS}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                >
                  {VIDEO_SIZES.map((size) => (
                    <option key={size} value={size}>{size}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-sm font-bold">目标受众</label>
                <div className="grid grid-cols-4 gap-2">
                  {AUDIENCES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => updateDraft("targetAudience", item.value)}
                      className={
                        "rounded-xl border px-2 py-3 text-xs font-semibold " +
                        (draft.targetAudience === item.value
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-[var(--border)]")
                      }
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="general-script-tone" className="mb-2 block text-sm font-bold">
                  故事基调
                </label>
                <select
                  id="general-script-tone"
                  value={draft.tone}
                  onChange={(event) => updateDraft(
                    "tone",
                    event.target.value as GeneralScriptDraft["tone"],
                  )}
                  className={FIELD_CLASS}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                >
                  {TONES.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
                {draft.tone === "custom" && (
                  <input
                    value={draft.customTone}
                    onChange={(event) => updateDraft("customTone", event.target.value)}
                    placeholder="例如：克制、治愈但不煽情"
                    className={FIELD_CLASS + " mt-2"}
                    style={{ borderColor: "var(--border)", background: "var(--background)" }}
                  />
                )}
              </div>

              <div>
                <label htmlFor="general-script-genre" className="mb-2 block text-sm font-bold">
                  视频类型
                </label>
                <input
                  id="general-script-genre"
                  value={draft.genre}
                  onChange={(event) => updateDraft("genre", event.target.value)}
                  placeholder="例如：宠物动画口播、都市短剧"
                  className={FIELD_CLASS}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="episodes-to-generate" className="mb-2 block text-sm font-bold">
                    本次生成
                  </label>
                  <input
                    id="episodes-to-generate"
                    type="number"
                    min={1}
                    max={20}
                    value={draft.episodesToGenerate}
                    onChange={(event) => updateDraft(
                      "episodesToGenerate",
                      Number(event.target.value),
                    )}
                    className={FIELD_CLASS}
                    style={{ borderColor: "var(--border)", background: "var(--background)" }}
                  />
                </div>
                <div>
                  <label htmlFor="total-episodes" className="mb-2 block text-sm font-bold">
                    总集数
                  </label>
                  <input
                    id="total-episodes"
                    type="number"
                    min={1}
                    max={500}
                    value={draft.totalEpisodes}
                    onChange={(event) => updateDraft("totalEpisodes", event.target.value)}
                    placeholder="不设定"
                    className={FIELD_CLASS}
                    style={{ borderColor: "var(--border)", background: "var(--background)" }}
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3">
                <div>
                  <div className="text-sm font-bold">本次生成后完结</div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    开启后，最后一集必须完成核心冲突闭环
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={draft.isFinale}
                  onChange={(event) => updateDraft("isFinale", event.target.checked)}
                  className="h-5 w-5 accent-violet-600"
                />
              </label>
            </div>

            <div className="mt-8 flex justify-end">
              <button
                type="button"
                onClick={goToStepTwo}
                className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/20"
              >
                下一步：输入内容
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className={CARD_CLASS + " mt-5 p-5 sm:p-8"}>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-black">详细需求描述</h3>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  当前：{draft.creationMode === "original" ? "原创" : "素材改编"} ·
                  {selectedTone} · 本次 {draft.episodesToGenerate} 集
                </p>
              </div>
              <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-bold text-violet-700">
                {OPERATIONS.find((item) => item.value === draft.operation)?.label}
              </span>
            </div>

            <div className="grid gap-5">
              <div>
                <label htmlFor="script-title" className="mb-2 block text-sm font-bold">项目名称（可选）</label>
                <input
                  id="script-title"
                  value={draft.title}
                  onChange={(event) => updateDraft("title", event.target.value)}
                  placeholder="不填时由编剧生成"
                  className={FIELD_CLASS}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                />
              </div>

              <div>
                <label htmlFor="script-brief" className="mb-2 block text-sm font-bold">
                  {draft.profileId === PET_SILENT_NARRATION_PROFILE_ID ? "口播 / 旁白文案" : "故事需求"}
                </label>
                <textarea
                  id="script-brief"
                  value={draft.brief}
                  onChange={(event) => updateDraft("brief", event.target.value)}
                  placeholder={
                    draft.profileId === PET_SILENT_NARRATION_PROFILE_ID
                      ? "粘贴需要转成无口型宠物动画的文案。系统会把信息拆成旁白、表情、动作和语义道具。"
                      : "描述主题、主角、核心矛盾、故事走向和你希望观众得到的感受。"
                  }
                  rows={8}
                  className={FIELD_CLASS + " resize-y leading-6"}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                />
              </div>

              {draft.creationMode === "adaptation" && (
                <div>
                  <label htmlFor="source-material" className="mb-2 block text-sm font-bold">
                    改编素材
                  </label>
                  <textarea
                    id="source-material"
                    value={draft.sourceMaterial}
                    onChange={(event) => updateDraft("sourceMaterial", event.target.value)}
                    placeholder="粘贴小说片段、故事原文、采访资料或内容大纲。"
                    rows={10}
                    className={FIELD_CLASS + " resize-y font-mono text-xs leading-5"}
                    style={{ borderColor: "var(--border)", background: "var(--background)" }}
                  />
                </div>
              )}

              <div>
                <label htmlFor="script-requirements" className="mb-2 block text-sm font-bold">
                  补充要求（可选）
                </label>
                <textarea
                  id="script-requirements"
                  value={draft.requirements}
                  onChange={(event) => updateDraft("requirements", event.target.value)}
                  placeholder="例如：无人物或宠物开口，剧情由旁白推进；每集 60—90 秒；避免复杂场景。"
                  rows={4}
                  className={FIELD_CLASS + " resize-y"}
                  style={{ borderColor: "var(--border)", background: "var(--background)" }}
                />
              </div>

              {draft.operation !== "generate" && (
                <div>
                  <label htmlFor="existing-project" className="mb-2 block text-sm font-bold">
                    已有完整项目 JSON
                  </label>
                  <textarea
                    id="existing-project"
                    value={draft.existingResultText}
                    onChange={(event) => updateDraft("existingResultText", event.target.value)}
                    placeholder="粘贴之前生成的 general-script-result.v1 完整 JSON"
                    rows={12}
                    className={FIELD_CLASS + " resize-y font-mono text-xs leading-5"}
                    style={{ borderColor: "var(--border)", background: "var(--background)" }}
                  />
                </div>
              )}

              {draft.operation === "rewrite" && (
                <div className="grid gap-4 md:grid-cols-[220px_1fr]">
                  <div>
                    <label htmlFor="rewrite-numbers" className="mb-2 block text-sm font-bold">
                      重写集数
                    </label>
                    <input
                      id="rewrite-numbers"
                      value={draft.rewriteEpisodeNumbers}
                      onChange={(event) => updateDraft("rewriteEpisodeNumbers", event.target.value)}
                      placeholder="例如：2, 4"
                      className={FIELD_CLASS}
                      style={{ borderColor: "var(--border)", background: "var(--background)" }}
                    />
                  </div>
                  <div>
                    <label htmlFor="rewrite-instruction" className="mb-2 block text-sm font-bold">
                      重写要求
                    </label>
                    <input
                      id="rewrite-instruction"
                      value={draft.rewriteInstruction}
                      onChange={(event) => updateDraft("rewriteInstruction", event.target.value)}
                      placeholder="例如：加强冲突，让转折由角色行动触发"
                      className={FIELD_CLASS}
                      style={{ borderColor: "var(--border)", background: "var(--background)" }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-8 flex flex-wrap justify-between gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex items-center gap-2 rounded-xl border border-[var(--border)] px-5 py-3 text-sm font-bold"
              >
                <ChevronLeft className="h-4 w-4" />
                返回设置
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="flex min-w-[170px] items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                {submitting ? "正在生成…" : "生成完整项目"}
              </button>
            </div>
          </section>
        )}

        {step === 3 && result && (
          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            <section className={CARD_CLASS + " overflow-hidden"}>
              <div className="border-b border-[var(--border)] p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-black">{result.summary.title}</h3>
                      {executionMode && (
                        <span
                          className={
                            "rounded-full px-2.5 py-1 text-[11px] font-bold " +
                            (executionMode === "fixture"
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-100 text-emerald-700")
                          }
                        >
                          {executionMode === "fixture" ? "离线预览" : "已生成"}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted-foreground)]">
                      {result.summary.oneSentence}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy("text")}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold"
                    >
                      {copied === "text" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      复制剧本
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy("json")}
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold"
                    >
                      {copied === "json" ? <Check className="h-3.5 w-3.5" /> : <FileJson className="h-3.5 w-3.5" />}
                      复制 JSON
                    </button>
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["类型", result.summary.genre],
                    ["集数", String(result.episodes.length)],
                    ["受众", AUDIENCES.find((item) => item.value === result.summary.targetAudience)?.label || result.summary.targetAudience],
                    ["状态", result.summary.isFinale ? "已完结" : "可继续"],
                    ["画幅", result.summary.videoSize],
                    ["动画风格", result.summary.animationStyle],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl bg-[var(--muted)] px-4 py-3">
                      <div className="text-[11px] text-[var(--muted-foreground)]">{label}</div>
                      <div className="mt-1 text-sm font-bold">{value}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-5 sm:p-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-[var(--border)] p-4">
                    <h4 className="text-sm font-black">项目梗概</h4>
                    <p className="mt-2 text-sm font-semibold">主角：{result.summary.protagonist}</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--muted-foreground)]">
                      {result.summary.synopsis}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-4">
                    <h4 className="text-sm font-black">世界与场域</h4>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                      {result.summary.background}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                      {result.summary.setting}
                    </p>
                  </div>
                </div>

                <div className="mt-6">
                  <h4 className="mb-3 text-base font-black">完整剧集</h4>
                  <div className="space-y-3">
                    {result.episodes.map((episode) => (
                      <details
                        key={episode.episodeNumber}
                        className="group rounded-xl border border-[var(--border)]"
                        open={episode.episodeNumber === result.episodes[0]?.episodeNumber}
                      >
                        <summary className="cursor-pointer list-none p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-bold">
                                第 {episode.episodeNumber} 集 · {episode.title}
                              </div>
                              <div className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                                {episode.logline}
                              </div>
                            </div>
                            <span className="shrink-0 rounded-full bg-[var(--muted)] px-2 py-1 text-[11px]">
                              约 {episode.estimatedDurationSeconds} 秒
                            </span>
                          </div>
                        </summary>
                        <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
                          <pre className="whitespace-pre-wrap font-sans text-sm leading-7">
                            {episode.content}
                          </pre>
                          <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                            结尾钩子：{episode.endingHook}
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                </div>

                <div className="mt-7 grid gap-4 lg:grid-cols-3">
                  <AssetList
                    icon={<Users className="h-4 w-4" />}
                    title={"角色 " + result.characters.length}
                    items={result.characters.map((item) => ({
                      name: item.name,
                      description: item.role + " · " + item.profile,
                    }))}
                  />
                  <AssetList
                    icon={<Film className="h-4 w-4" />}
                    title={"场景 " + result.scenes.length}
                    items={result.scenes.map((item) => ({
                      name: item.name,
                      description: item.description,
                    }))}
                  />
                  <AssetList
                    icon={<Clipboard className="h-4 w-4" />}
                    title={"道具 " + result.props.length}
                    items={result.props.map((item) => ({
                      name: item.name,
                      description: item.description,
                    }))}
                  />
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <section className={CARD_CLASS + " p-5"}>
                <h4 className="font-black">下一步</h4>
                <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
                  真实登录结果可保存为影视工坊项目；离线结果只做本地交接。
                </p>
                <button
                  type="button"
                  onClick={saveToStudio}
                  disabled={savingToStudio}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-3 text-sm font-bold text-white"
                >
                  {savingToStudio ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                  {savingToStudio ? "正在保存…" : "保存到影视工坊"}
                </button>
                {studioSaveError && (
                  <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                    {studioSaveError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handoffToStudio}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold"
                >
                  仅本地交接并进入
                  <ArrowRight className="h-4 w-4" />
                </button>
              </section>

              <section className={CARD_CLASS + " p-5"}>
                <h4 className="font-black">继续编辑</h4>
                <div className="mt-3 grid gap-2">
                  <button
                    type="button"
                    onClick={() => startFollowUp("continue")}
                    className="flex items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold"
                  >
                    续写下一批
                    <ArrowRight className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => startFollowUp("rewrite")}
                    className="flex items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold"
                  >
                    重写指定集
                    <RefreshCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft((previous) => ({
                        ...DEFAULT_GENERAL_SCRIPT_DRAFT,
                        creationMode: previous.creationMode,
                        profileId: previous.profileId,
                        targetAudience: previous.targetAudience,
                        tone: previous.tone,
                        genre: previous.genre,
                        animationStyle: previous.animationStyle,
                        videoSize: previous.videoSize,
                      }));
                      setStep(1);
                    }}
                    className="flex items-center justify-between rounded-xl border border-[var(--border)] px-4 py-3 text-sm font-bold"
                  >
                    创建新项目
                    <Sparkles className="h-4 w-4" />
                  </button>
                </div>
              </section>
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}

function AssetList({
  icon,
  title,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  items: Array<{ name: string; description: string }>;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] p-4">
      <h5 className="flex items-center gap-2 text-sm font-black">
        {icon}
        {title}
      </h5>
      <div className="mt-3 space-y-3">
        {items.length === 0 && (
          <div className="text-xs text-[var(--muted-foreground)]">暂无资产</div>
        )}
        {items.map((item) => (
          <div key={item.name}>
            <div className="text-sm font-bold">{item.name}</div>
            <div className="mt-1 line-clamp-3 text-xs leading-5 text-[var(--muted-foreground)]">
              {item.description}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
