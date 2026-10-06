"use client";

import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { VideoStylePicker } from "@/components/video-style-picker";
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Copy,
  FileText,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Forward,
  FilePenLine,
  LogIn,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Trash2,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { useApp } from "@/contexts/app-context";
import type { JsonValue, ShortDramaProject } from "@/lib/short-drama/contracts";
import { safeGetItem } from "@/lib/safe-storage";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import { validateStoryboardEpisodeReadiness } from "@/lib/short-drama/episode-workflow";
import {
  GENERAL_SCRIPT_PROFILE_VERSION,
  GENERAL_SCRIPT_TONES,
  parseGeneralScriptResult,
  type GeneralScriptOperation,
  type GeneralScriptResult,
  type GeneralScriptTone,
} from "@/lib/short-drama/general-script-contract";
import {
  clearConfirmedClientSubmissionIdentity,
  resolveClientSubmissionIdentity,
  type ClientSubmissionIdentity,
} from "@/lib/short-drama/client-submission-identity";
import { buildClientRequestFingerprint } from "@/lib/browser-client-attempt";
import {
  clearGeneralScriptSubmission,
  readGeneralScriptSubmission,
  saveGeneralScriptSubmission,
} from "@/features/general-script/submission-storage";
import { useShortDramaPaidReadiness } from "@/features/youcai-film-studio/use-short-drama-paid-readiness";
import { FilmStudioEntityPanel } from "./film-studio-entity-panel";
import { FilmStudioProductionPanel } from "./film-studio-production-panel";
import { FilmStudioShotPanel } from "./film-studio-shot-panel";
import styles from "./film-studio-project-workbench.module.css";

export type FilmStudioProjectStep =
  | "script"
  | "character"
  | "scene"
  | "prop"
  | "storyboard"
  | "final";

interface StepDefinition {
  key: FilmStudioProjectStep;
  label: string;
  note: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const STEPS: readonly StepDefinition[] = [
  { key: "script", label: "剧本", note: "梗概与分集", icon: ScrollText },
  { key: "character", label: "角色", note: "人物档案", icon: Users },
  { key: "scene", label: "场景", note: "空间与氛围", icon: ImageIcon },
  { key: "prop", label: "道具", note: "关键物件", icon: Box },
  { key: "storyboard", label: "分镜", note: "镜头生产", icon: Clapperboard },
  { key: "final", label: "成片", note: "剪辑与导出", icon: Film },
] as const;

const SUMMARY_FIELDS = [
  { key: "title", label: "内容标题", multiline: false },
  { key: "protagonist", label: "主角", multiline: false },
  { key: "genre", label: "题材", multiline: false },
  { key: "oneSentence", label: "一句话故事", multiline: true },
  { key: "synopsis", label: "故事梗概", multiline: true },
  { key: "background", label: "故事背景", multiline: true },
  { key: "setting", label: "核心场域", multiline: true },
  { key: "animationStyle", label: "视觉风格", multiline: false },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value);
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return isJsonRecord(value) ? value : {};
}

function jsonRecordArray(value: unknown): Array<Record<string, JsonValue>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonRecord);
}

function fieldText(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function episodeIsConfirmed(episode: Record<string, JsonValue> | null | undefined): boolean {
  return episode?.status === "confirmed";
}

function displayValue(value: JsonValue | undefined, fallback = "未填写"): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseProject(value: unknown): ShortDramaProject | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string"
    || typeof value.title !== "string"
    || typeof value.revision !== "number"
    || !isJsonRecord(value.sourcePayload)
  ) {
    return null;
  }
  return value as unknown as ShortDramaProject;
}

function parseResponseText(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const value = payload.error ?? payload.message;
  if (typeof value !== "string" || !value.trim()) return fallback;
  const message = value.trim();
  return /API|接口|HTTP|provider|供应商|上游|渠道|密钥|数据库|迁移|sourcePayload|fixture|验收/iu.test(message)
    ? fallback
    : message;
}

function formatDate(value: string | undefined): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function scriptClientRequestId(operation: GeneralScriptOperation): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `project-${operation}-${suffix}`.slice(0, 120);
}

function generalScriptResultFromPayload(payload: Record<string, JsonValue>): GeneralScriptResult | null {
  try {
    return parseGeneralScriptResult({
      schemaVersion: payload.schemaVersion,
      profileId: payload.profileId,
      operation: payload.operation,
      summary: payload.summary,
      episodes: payload.episodes,
      characters: payload.characters,
      scenes: payload.scenes,
      props: payload.props,
    });
  } catch {
    return null;
  }
}

function requestTone(result: GeneralScriptResult): {
  tone: GeneralScriptTone;
  customTone: string;
} {
  const normalized = result.summary.tone.trim() as GeneralScriptTone;
  return GENERAL_SCRIPT_TONES.includes(normalized)
    ? { tone: normalized, customTone: normalized === "custom" ? result.summary.tone.trim() : "" }
    : { tone: "custom", customTone: result.summary.tone.trim().slice(0, 100) };
}

function mergeGeneratedScriptPayload(input: {
  current: Record<string, JsonValue>;
  result: GeneralScriptResult;
  operation: "continue" | "rewrite";
  rewriteEpisodeNumbers: number[];
}): Record<string, JsonValue> {
  const currentEpisodes = jsonRecordArray(input.current.episodes);
  const currentByNumber = new Map(
    currentEpisodes.map((episode, index) => [
      Number(episode.episodeNumber) || index + 1,
      episode,
    ]),
  );
  const rewritten = new Set(input.rewriteEpisodeNumbers);
  const episodes = input.result.episodes.map((episode) => {
    const current = currentByNumber.get(episode.episodeNumber);
    const keepStatus = current && (
      input.operation === "continue" || !rewritten.has(episode.episodeNumber)
    );
    const lockedContent = keepStatus && current
      ? {
          episodeNumber: Number(current.episodeNumber) || episode.episodeNumber,
          title: typeof current.title === "string" ? current.title : episode.title,
          logline: typeof current.logline === "string" ? current.logline : episode.logline,
          content: typeof current.content === "string" ? current.content : episode.content,
          endingHook: typeof current.endingHook === "string" ? current.endingHook : episode.endingHook,
          estimatedDurationSeconds: Number.isFinite(Number(current.estimatedDurationSeconds))
            ? Number(current.estimatedDurationSeconds)
            : episode.estimatedDurationSeconds,
        }
      : {};
    return {
      ...episode,
      ...lockedContent,
      status: keepStatus && current?.status === "confirmed" ? "confirmed" : "draft",
      confirmedAt: keepStatus && current?.status === "confirmed"
        ? current.confirmedAt ?? null
        : null,
    } as unknown as JsonValue;
  });
  return {
    ...input.current,
    schemaVersion: input.result.schemaVersion,
    profileId: input.result.profileId,
    operation: input.result.operation,
    summary: input.result.summary as unknown as JsonValue,
    episodes,
    characters: input.result.characters as unknown as JsonValue,
    scenes: input.result.scenes as unknown as JsonValue,
    props: input.result.props as unknown as JsonValue,
    episodeCount: input.result.episodes.length,
    currentStage: "剧本",
  };
}

function projectTypeLabel(value: ShortDramaProject["projectType"]): string {
  const labels: Record<ShortDramaProject["projectType"], string> = {
    short_drama: "通用短剧",
    narrated_animation: "旁白动画",
    pet_story: "宠物故事",
    custom: "自定义项目",
  };
  return labels[value] || value;
}

function validStep(value: string | null): FilmStudioProjectStep | null {
  return STEPS.some((step) => step.key === value)
    ? value as FilmStudioProjectStep
    : null;
}

function LoadingState() {
  return (
    <div className={styles.centerState} role="status">
      <LoaderCircle className={styles.spin} size={28} aria-hidden="true" />
      <strong>正在读取项目…</strong>
      <span>正在恢复剧本、角色、分镜和制作进度</span>
    </div>
  );
}

function SignedOutState() {
  return (
    <div className={styles.centerState} data-tone="warning">
      <LockKeyhole size={30} aria-hidden="true" />
      <strong>请先登录主站</strong>
      <span>该工作台只读取当前账号拥有的影视项目。</span>
      <div className={styles.stateActions}>
        <Link className={styles.primaryButton} href="/login">
          <LogIn size={16} />
          前往登录
        </Link>
        <Link className={styles.secondaryButton} href="/youcai/tools/film-studio#projects">
          返回影视工坊
        </Link>
      </div>
    </div>
  );
}

function CompatProductionGate() {
  return (
    <section
      className={styles.unconnectedPanel}
      data-storage-mode="compat"
      data-testid="film-project-production-compat-gate"
    >
      <span className={styles.unconnectedIcon}><LockKeyhole size={28} /></span>
      <h2>成片制作服务正在准备中</h2>
      <p>
        当前仍可编辑和保存项目、角色与分镜草稿。成片制作恢复前，
        页面不会提交图片或视频生成，也不会产生相关费用。
      </p>
      <div className={styles.existingNotice}>
        <AlertTriangle size={17} />
        <span>当前仅开放可安全保存的编辑功能，成片制作恢复后会自动启用。</span>
      </div>
    </section>
  );
}

interface ScriptPanelProps {
  payload: Record<string, JsonValue>;
  selectedEpisodeIndex: number;
  saving: boolean;
  dirty: boolean;
  onSelectEpisode: (index: number) => void;
  onSummaryChange: (key: string, value: string) => void;
  onEpisodeChange: (index: number, key: string, value: string) => void;
  onAddEpisode: () => void;
  onRemoveEpisode: (index: number) => void;
  onEpisodeStatusChange: (index: number) => void;
  onConfirmAll: () => void;
  hasDownstreamData: boolean;
  onSave: () => void;
  aiCompatible: boolean;
  aiBusy: "continue" | "rewrite" | "saving" | null;
  aiMessage: string;
  aiError: string;
  continueCount: number;
  continueInstruction: string;
  continueAsFinale: boolean;
  rewriteStart: number;
  rewriteCount: number;
  rewriteInstruction: string;
  onContinueCountChange: (value: number) => void;
  onContinueInstructionChange: (value: string) => void;
  onContinueAsFinaleChange: (value: boolean) => void;
  onRewriteStartChange: (value: number) => void;
  onRewriteCountChange: (value: number) => void;
  onRewriteInstructionChange: (value: string) => void;
  onContinue: () => void;
  onRewrite: () => void;
  onRetryAiSave: () => void;
  hasPendingAiSave: boolean;
}

function ScriptPanel({
  payload,
  selectedEpisodeIndex,
  saving,
  dirty,
  onSelectEpisode,
  onSummaryChange,
  onEpisodeChange,
  onAddEpisode,
  onRemoveEpisode,
  onEpisodeStatusChange,
  onConfirmAll,
  hasDownstreamData,
  onSave,
  aiCompatible,
  aiBusy,
  aiMessage,
  aiError,
  continueCount,
  continueInstruction,
  continueAsFinale,
  rewriteStart,
  rewriteCount,
  rewriteInstruction,
  onContinueCountChange,
  onContinueInstructionChange,
  onContinueAsFinaleChange,
  onRewriteStartChange,
  onRewriteCountChange,
  onRewriteInstructionChange,
  onContinue,
  onRewrite,
  onRetryAiSave,
  hasPendingAiSave,
}: ScriptPanelProps) {
  const summary = jsonRecord(payload.summary);
  const episodes = jsonRecordArray(payload.episodes);
  const selectedEpisode = episodes[selectedEpisodeIndex] || null;
  const selectedEpisodeConfirmed = episodeIsConfirmed(selectedEpisode);
  const draftCount = episodes.filter((episode) => !episodeIsConfirmed(episode)).length;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyFullScript() {
    const summaryLines = SUMMARY_FIELDS
      .map((field) => `${field.label}：${fieldText(summary[field.key])}`)
      .filter((line) => !line.endsWith("："));
    const episodeLines = episodes.map((episode, index) => [
      `第 ${Math.max(1, Math.round(Number(episode.episodeNumber) || index + 1))} 集｜${fieldText(episode.title) || "未命名"}`,
      fieldText(episode.logline) ? `一句话：${fieldText(episode.logline)}` : "",
      fieldText(episode.content),
      fieldText(episode.endingHook) ? `结尾钩子：${fieldText(episode.endingHook)}` : "",
    ].filter(Boolean).join("\n"));
    const text = [...summaryLines, ...episodeLines].filter(Boolean).join("\n\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = text;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.select();
        const copied = document.execCommand("copy");
        fallback.remove();
        if (!copied) throw new Error("CLIPBOARD_UNAVAILABLE");
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className={styles.scriptStack} data-testid="film-project-script-step">
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>项目设定 · 剧本摘要</span>
            <h2>项目剧本底稿</h2>
            <p>这里展示当前项目的剧本摘要；修改后保存到同一项目。</p>
          </div>
          <div className={styles.panelHeaderActions}>
            <button className={styles.secondaryButton} type="button" disabled={episodes.length === 0} onClick={() => void copyFullScript()}>
              <Copy size={16} />
              {copyState === "copied" ? "已复制全本" : copyState === "failed" ? "复制失败" : "复制全本"}
            </button>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={!dirty || saving}
              onClick={onSave}
            >
              {saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}
              {saving ? "保存中…" : "保存剧本"}
            </button>
          </div>
        </div>

        <div className={styles.summaryGrid}>
          {SUMMARY_FIELDS.map((field) => field.key === "animationStyle" ? (
            <div className={`${styles.styleSummaryField} ${styles.wideField}`} key={field.key}>
              <span>{field.label} <small>39 种预设或自定义；修改后需保存，再重新规划未生产的镜头</small></span>
              <VideoStylePicker
                value={fieldText(summary.animationStyle)}
                disabled={saving}
                onChange={(value) => onSummaryChange("animationStyle", value)}
                ariaLabel="项目视觉风格"
              />
            </div>
          ) : (
            <label
              className={field.multiline ? styles.wideField : undefined}
              key={field.key}
            >
              <span>{field.label}</span>
              {field.multiline ? (
                <textarea
                  value={fieldText(summary[field.key])}
                  disabled={saving}
                  maxLength={100_000}
                  onChange={(event) => onSummaryChange(field.key, event.target.value)}
                  placeholder={`填写${field.label}`}
                />
              ) : (
                <input
                  value={fieldText(summary[field.key])}
                  disabled={saving}
                  maxLength={500}
                  onChange={(event) => onSummaryChange(field.key, event.target.value)}
                  placeholder={`填写${field.label}`}
                />
              )}
            </label>
          ))}
        </div>
      </section>

      <div className={styles.episodeBatchBar}>
        <span>{draftCount > 0 ? `还有 ${draftCount} 集待定稿` : episodes.length > 0 ? "全部分集已定稿" : "暂无分集"}</span>
        <button
          className={styles.secondaryButton}
          type="button"
          disabled={saving || draftCount === 0}
          onClick={onConfirmAll}
          data-testid="film-confirm-all-episodes"
        >
          <Check size={15} />
          批量定稿{draftCount > 0 ? `（${draftCount}）` : ""}
        </button>
      </div>

      <section className={styles.aiScriptPanel} data-testid="film-project-script-ai-operations">
        <div className={styles.aiScriptHeader}>
          <div>
            <span className={styles.eyebrow}>CONTINUE / REWRITE</span>
            <h2>续写与指定分集改写</h2>
            <p>AI 会读取当前完整项目；续写只在末尾追加，改写只替换所选连续分集。生成结果必须写回当前项目后才显示成功。</p>
          </div>
          {hasPendingAiSave && (
            <button className={styles.primaryButton} type="button" disabled={aiBusy !== null} onClick={onRetryAiSave}>
              {aiBusy === "saving" ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}
              重试保存已生成结果
            </button>
          )}
        </div>

        {!aiCompatible && (
          <div className={styles.aiScriptStatus} data-tone="warning">
            <AlertTriangle size={17} />
            当前项目缺少续写或改写所需的完整剧本结构；现有剧本仍可手动编辑。
          </div>
        )}
        {aiMessage && <div className={styles.aiScriptStatus} data-tone="success"><CheckCircle2 size={17} />{aiMessage}</div>}
        {aiError && <div className={styles.aiScriptStatus} data-tone="danger"><AlertTriangle size={17} />{aiError}</div>}

        <div className={styles.aiScriptGrid}>
          <div className={styles.aiScriptCard}>
            <div>
              <strong><Forward size={17} />续写后续分集</strong>
              <span>保留已有分集、角色和后续制作内容，从当前最大集号之后连续追加。</span>
            </div>
            <div className={styles.aiScriptFields}>
              <label>
                <span>本次续写集数</span>
                <input type="number" min={1} max={20} value={continueCount} disabled={aiBusy !== null} onChange={(event) => onContinueCountChange(Number(event.target.value) || 1)} />
              </label>
              <label className={styles.aiScriptWide}>
                <span>续写指导（可选）</span>
                <textarea maxLength={10_000} value={continueInstruction} disabled={aiBusy !== null} onChange={(event) => onContinueInstructionChange(event.target.value)} placeholder="例如：加快冲突，在本批最后制造身份反转" />
              </label>
              <label className={styles.aiScriptCheckbox}>
                <input type="checkbox" checked={continueAsFinale} disabled={aiBusy !== null} onChange={(event) => onContinueAsFinaleChange(event.target.checked)} />
                本次续写后剧终
              </label>
            </div>
            <button className={styles.primaryButton} type="button" disabled={!aiCompatible || aiBusy !== null || hasPendingAiSave} onClick={onContinue}>
              {aiBusy === "continue" ? <LoaderCircle className={styles.spin} size={16} /> : <Forward size={16} />}
              {aiBusy === "continue" ? "续写中…" : "确认续写"}
            </button>
          </div>

          <div className={styles.aiScriptCard}>
            <div>
              <strong><FilePenLine size={17} />改写连续分集</strong>
              <span>{hasDownstreamData ? "项目已有分镜或成片，现有分集保持锁定。" : "已定稿分集需先取消定稿；其他分集保持原样。"}</span>
            </div>
            <div className={styles.aiScriptFields}>
              <label>
                <span>开始集数</span>
                <select value={rewriteStart} disabled={aiBusy !== null || episodes.length === 0} onChange={(event) => onRewriteStartChange(Number(event.target.value))}>
                  {episodes.map((episode, index) => <option key={index} value={Number(episode.episodeNumber) || index + 1}>第 {Number(episode.episodeNumber) || index + 1} 集</option>)}
                </select>
              </label>
              <label>
                <span>连续改写集数</span>
                <input type="number" min={1} max={20} value={rewriteCount} disabled={aiBusy !== null} onChange={(event) => onRewriteCountChange(Number(event.target.value) || 1)} />
              </label>
              <label className={styles.aiScriptWide}>
                <span>改写要求</span>
                <textarea maxLength={10_000} value={rewriteInstruction} disabled={aiBusy !== null} onChange={(event) => onRewriteInstructionChange(event.target.value)} placeholder="说明要保留的事实、要修正的冲突和预期结尾" />
              </label>
            </div>
            <button className={styles.primaryButton} type="button" disabled={!aiCompatible || hasDownstreamData || aiBusy !== null || hasPendingAiSave || !rewriteInstruction.trim()} onClick={onRewrite}>
              {aiBusy === "rewrite" ? <LoaderCircle className={styles.spin} size={16} /> : <FilePenLine size={16} />}
              {aiBusy === "rewrite" ? "改写中…" : "确认改写"}
            </button>
          </div>
        </div>
      </section>

      <section className={styles.episodeWorkspace}>
        <aside className={styles.episodeList}>
          <div className={styles.episodeListHeader}>
            <div>
              <span className={styles.eyebrow}>EPISODES</span>
              <strong>{episodes.length} 集 · {episodes.length - draftCount} 已定稿</strong>
            </div>
            <button
              className={styles.episodeIconButton}
              type="button"
              disabled={saving}
              onClick={onAddEpisode}
              aria-label="新增分集"
              title="新增分集"
              data-testid="film-add-episode"
            >
              <Plus size={16} />
            </button>
          </div>
          <div className={styles.episodeButtons}>
            {episodes.map((episode, index) => (
              <button
                type="button"
                data-active={selectedEpisodeIndex === index ? "true" : undefined}
                key={`${displayValue(episode.episodeNumber, String(index + 1))}-${index}`}
                onClick={() => onSelectEpisode(index)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{displayValue(episode.title, `第 ${index + 1} 集`)}</strong>
                  <small>{displayValue(episode.logline, "暂无本集梗概")}</small>
                  <em data-confirmed={episodeIsConfirmed(episode) ? "true" : undefined}>
                    {episodeIsConfirmed(episode) ? "已定稿" : "草稿"}
                  </em>
                </span>
              </button>
            ))}
            {episodes.length === 0 && (
              <div className={styles.emptyList}>当前项目暂无分集。</div>
            )}
          </div>
        </aside>

        <div className={styles.episodeEditor}>
          {selectedEpisode ? (
            <>
              <div className={styles.episodeEditorHeader}>
                <div>
                  <span className={styles.eyebrow}>
                    EP {displayValue(selectedEpisode.episodeNumber, String(selectedEpisodeIndex + 1))}
                  </span>
                  <h2>编辑本集剧本</h2>
                </div>
                <div className={styles.episodeEditorActions}>
                  <span
                    className={styles.episodeStatusBadge}
                    data-confirmed={selectedEpisodeConfirmed ? "true" : undefined}
                  >
                    {selectedEpisodeConfirmed ? "已定稿" : "草稿"}
                  </span>
                  <span className={styles.durationBadge}>
                    <Clock3 size={14} />
                    {displayValue(selectedEpisode.estimatedDurationSeconds, "未设置时长")} 秒
                  </span>
                  <button
                    className={selectedEpisodeConfirmed ? styles.secondaryButton : styles.primaryButton}
                    type="button"
                    disabled={saving}
                    onClick={() => onEpisodeStatusChange(selectedEpisodeIndex)}
                    data-testid="film-toggle-episode-status"
                    title={selectedEpisodeConfirmed && hasDownstreamData ? "已有分镜或成片，不能取消定稿" : undefined}
                  >
                    <Check size={15} />
                    {selectedEpisodeConfirmed ? "取消定稿" : "定稿"}
                  </button>
                  <button
                    className={styles.dangerButton}
                    type="button"
                    disabled={saving || selectedEpisodeConfirmed || hasDownstreamData}
                    onClick={() => onRemoveEpisode(selectedEpisodeIndex)}
                    data-testid="film-remove-episode"
                    title={selectedEpisodeConfirmed ? "请先取消定稿" : hasDownstreamData ? "已有分镜或成片，不能删除分集" : "删除本集"}
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
              </div>
              {selectedEpisodeConfirmed && (
                <div className={styles.confirmedNotice}>
                  本集已定稿。需要修改时请先取消定稿；已有分镜或成片后会保持锁定，避免画面与剧本失配。
                </div>
              )}
              <div className={styles.episodeFields}>
                <label>
                  <span>分集标题</span>
                  <input
                    value={fieldText(selectedEpisode.title)}
                    disabled={saving || selectedEpisodeConfirmed}
                    maxLength={500}
                    onChange={(event) => onEpisodeChange(selectedEpisodeIndex, "title", event.target.value)}
                  />
                </label>
                <label>
                  <span>本集梗概</span>
                  <textarea
                    className={styles.compactTextarea}
                    value={fieldText(selectedEpisode.logline)}
                    disabled={saving || selectedEpisodeConfirmed}
                    maxLength={10_000}
                    onChange={(event) => onEpisodeChange(selectedEpisodeIndex, "logline", event.target.value)}
                  />
                </label>
                <label>
                  <span>完整剧本内容</span>
                  <textarea
                    className={styles.scriptTextarea}
                    value={fieldText(selectedEpisode.content)}
                    disabled={saving || selectedEpisodeConfirmed}
                    maxLength={100_000}
                    onChange={(event) => onEpisodeChange(selectedEpisodeIndex, "content", event.target.value)}
                    placeholder="本集场景、旁白、动作与对白…"
                  />
                </label>
                <label>
                  <span>结尾钩子</span>
                  <textarea
                    className={styles.compactTextarea}
                    value={fieldText(selectedEpisode.endingHook)}
                    disabled={saving || selectedEpisodeConfirmed}
                    maxLength={10_000}
                    onChange={(event) => onEpisodeChange(selectedEpisodeIndex, "endingHook", event.target.value)}
                  />
                </label>
              </div>
            </>
          ) : (
            <div className={styles.emptyEditor}>
              <FileText size={30} aria-hidden="true" />
              <strong>没有可编辑的分集</strong>
              <span>请先从编剧入口生成并真实保存项目。</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function FilmStudioProjectWorkbench({
  projectId,
  initialStep = "script",
}: {
  projectId: string;
  initialStep?: FilmStudioProjectStep;
}) {
  const { state } = useApp();
  const [storedToken, setStoredToken] = useState<string | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [project, setProject] = useState<ShortDramaProject | null>(null);
  const [projectStorageMode, setProjectStorageMode] = useState<"native" | "compat" | null>(null);
  const [draftPayload, setDraftPayload] = useState<Record<string, JsonValue>>({});
  const [activeStep, setActiveStep] = useState<FilmStudioProjectStep>(initialStep);
  const [selectedEpisodeIndex, setSelectedEpisodeIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [productionCounts, setProductionCounts] = useState({
    loaded: false,
    shots: 0,
    completedVideos: 0,
  });
  const paidReadiness = useShortDramaPaidReadiness();
  const scriptOperationIdentityRef = useRef<ClientSubmissionIdentity | null>(null);
  const [aiBusy, setAiBusy] = useState<"continue" | "rewrite" | "saving" | null>(null);
  const [aiMessage, setAiMessage] = useState("");
  const [aiError, setAiError] = useState("");
  const [continueCount, setContinueCount] = useState(1);
  const [continueInstruction, setContinueInstruction] = useState("");
  const [continueAsFinale, setContinueAsFinale] = useState(false);
  const [rewriteStart, setRewriteStart] = useState(1);
  const [rewriteCount, setRewriteCount] = useState(1);
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [pendingGenerated, setPendingGenerated] = useState<{
    requestId: string;
    result: GeneralScriptResult;
    operation: "continue" | "rewrite";
    rewriteEpisodeNumbers: number[];
  } | null>(null);
  const scriptSubmissionKey = `film-project-script-operation:${projectId}`;
  const currentUserId = state.auth.user?.id || "";

  useEffect(() => {
    setStoredToken(state.auth.token || safeGetItem(STORAGE_KEYS.AUTH_TOKEN));
    setAuthResolved(true);
  }, [state.auth.token]);

  useEffect(() => {
    scriptOperationIdentityRef.current = currentUserId
      ? readGeneralScriptSubmission(scriptSubmissionKey, currentUserId)
      : null;
  }, [currentUserId, scriptSubmissionKey]);

  const token = state.auth.token || storedToken;

  const serverPayloadSignature = useMemo(
    () => project ? JSON.stringify(project.sourcePayload) : "",
    [project],
  );
  const draftPayloadSignature = useMemo(
    () => JSON.stringify(draftPayload),
    [draftPayload],
  );
  const dirty = Boolean(project) && serverPayloadSignature !== draftPayloadSignature;

  const loadProject = useCallback(async (signal?: AbortSignal) => {
    if (!token) return;
    setLoading(true);
    setLoadError("");
    setSaveError("");
    try {
      const response = await fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal,
      });
      const payload = parseResponseText(await response.text());
      if (response.status === 401 || response.status === 403) {
        setRequiresLogin(true);
        setProject(null);
        return;
      }
      if (!response.ok) {
        throw new Error(responseMessage(payload, "项目加载失败"));
      }
      const nextProject = isRecord(payload) ? parseProject(payload.project) : null;
      if (!nextProject) {
        throw new Error("项目数据读取不完整，请刷新后重试。");
      }
      setProject(nextProject);
      if (isRecord(payload) && (payload.storageMode === "native" || payload.storageMode === "compat")) {
        setProjectStorageMode(payload.storageMode);
      }
      setDraftPayload({ ...nextProject.sourcePayload });
      setSelectedEpisodeIndex(0);
      setRequiresLogin(false);
    } catch (error: unknown) {
      if (signal?.aborted) return;
      setLoadError(error instanceof Error ? error.message : "项目加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [projectId, token]);

  useEffect(() => {
    if (!authResolved) return;
    if (!token) {
      setLoading(false);
      setRequiresLogin(true);
      setProject(null);
      return;
    }
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [authResolved, loadProject, token]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const handlePopState = () => {
      const step = validStep(new URL(window.location.href).searchParams.get("step"));
      if (step) setActiveStep(step);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const episodes = useMemo(
    () => jsonRecordArray(draftPayload.episodes),
    [draftPayload.episodes],
  );
  const characters = useMemo(
    () => jsonRecordArray(draftPayload.characters),
    [draftPayload.characters],
  );
  const scenes = useMemo(
    () => jsonRecordArray(draftPayload.scenes),
    [draftPayload.scenes],
  );
  const props = useMemo(
    () => jsonRecordArray(draftPayload.props),
    [draftPayload.props],
  );
  const generalScriptResult = useMemo(
    () => generalScriptResultFromPayload(draftPayload),
    [draftPayload],
  );
  const storyboardEpisodeIssue = useMemo(
    () => validateStoryboardEpisodeReadiness(draftPayload),
    [draftPayload],
  );

  const updateProductionCounts = useCallback((counts: { shots: number; completedVideos: number }) => {
    setProductionCounts((current) => (
      current.loaded
      && current.shots === counts.shots
      && current.completedVideos === counts.completedVideos
        ? current
        : { loaded: true, ...counts }
    ));
  }, []);

  const updateShotCount = useCallback((shots: number) => {
    setProductionCounts((current) => (
      current.loaded && current.shots === shots
        ? current
        : { ...current, loaded: true, shots }
    ));
  }, []);

  useEffect(() => {
    if (selectedEpisodeIndex >= episodes.length) setSelectedEpisodeIndex(0);
  }, [episodes.length, selectedEpisodeIndex]);

  useEffect(() => {
    const numbers = episodes.map((episode, index) => Number(episode.episodeNumber) || index + 1);
    if (numbers.length > 0 && !numbers.includes(rewriteStart)) setRewriteStart(numbers[0]);
  }, [episodes, rewriteStart]);

  const counts: Record<FilmStudioProjectStep, string> = {
    script: `${episodes.length} 集`,
    character: String(characters.length),
    scene: String(scenes.length),
    prop: String(props.length),
    storyboard: productionCounts.loaded ? `${productionCounts.shots} 镜头` : "待读取",
    final: productionCounts.loaded ? `${productionCounts.completedVideos} 可预览` : "待读取",
  };

  function changeStep(step: FilmStudioProjectStep) {
    setActiveStep(step);
    const url = new URL(window.location.href);
    url.searchParams.set("step", step);
    window.history.pushState({}, "", url);
  }

  function updateSummary(key: string, value: string) {
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => ({
      ...current,
      summary: {
        ...jsonRecord(current.summary),
        [key]: value,
      },
    }));
  }

  function updateEpisode(index: number, key: string, value: string) {
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => {
      const nextEpisodes: JsonValue[] = Array.isArray(current.episodes)
        ? [...current.episodes]
        : [];
      nextEpisodes[index] = {
        ...jsonRecord(nextEpisodes[index]),
        [key]: value,
      };
      return { ...current, episodes: nextEpisodes };
    });
  }

  function addEpisode() {
    const nextIndex = episodes.length;
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => {
      const nextEpisodes = jsonRecordArray(current.episodes).map((episode) => ({ ...episode }));
      nextEpisodes.push({
        episodeNumber: nextEpisodes.length + 1,
        title: `第 ${nextEpisodes.length + 1} 集`,
        logline: "",
        content: "",
        endingHook: "",
        status: "draft",
        confirmedAt: null,
      });
      return { ...current, episodes: nextEpisodes };
    });
    setSelectedEpisodeIndex(nextIndex);
  }

  function removeEpisode(index: number) {
    const episode = episodes[index];
    if (!episode || saving) return;
    if (episodeIsConfirmed(episode)) {
      window.alert("请先取消本集定稿，再删除分集。");
      return;
    }
    if (productionCounts.shots > 0 || productionCounts.completedVideos > 0) {
      window.alert("项目已有分镜或成片，为避免镜头与集号错位，不能删除分集。");
      return;
    }
    if (!window.confirm(`确认删除第 ${index + 1} 集？删除后其余集号会连续重排。`)) return;
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => {
      const nextEpisodes = jsonRecordArray(current.episodes)
        .filter((_, episodeIndex) => episodeIndex !== index)
        .map((item, episodeIndex) => ({ ...item, episodeNumber: episodeIndex + 1 }));
      return { ...current, episodes: nextEpisodes };
    });
    setSelectedEpisodeIndex((current) => Math.max(0, Math.min(current, episodes.length - 2)));
  }

  function toggleEpisodeStatus(index: number) {
    const episode = episodes[index];
    if (!episode || saving) return;
    const confirmed = episodeIsConfirmed(episode);
    if (!confirmed && !fieldText(episode.content).trim()) {
      window.alert("本集剧本内容为空，不能定稿。");
      return;
    }
    if (confirmed && (productionCounts.shots > 0 || productionCounts.completedVideos > 0)) {
      window.alert("项目已有分镜或成片，不能取消定稿。");
      return;
    }
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => {
      const nextEpisodes: JsonValue[] = Array.isArray(current.episodes)
        ? [...current.episodes]
        : [];
      nextEpisodes[index] = {
        ...jsonRecord(nextEpisodes[index]),
        status: confirmed ? "draft" : "confirmed",
        confirmedAt: confirmed ? null : new Date().toISOString(),
      };
      return { ...current, episodes: nextEpisodes };
    });
  }

  function confirmAllEpisodes() {
    const draftEpisodes = episodes.filter((episode) => !episodeIsConfirmed(episode));
    if (draftEpisodes.length === 0 || saving) return;
    const emptyIndex = episodes.findIndex(
      (episode) => !episodeIsConfirmed(episode) && !fieldText(episode.content).trim(),
    );
    if (emptyIndex >= 0) {
      window.alert(`第 ${emptyIndex + 1} 集剧本内容为空，不能批量定稿。`);
      setSelectedEpisodeIndex(emptyIndex);
      return;
    }
    if (!window.confirm(`确认定稿 ${draftEpisodes.length} 集？定稿后才能进入分镜制作。`)) return;
    const confirmedAt = new Date().toISOString();
    setSaveMessage("");
    setSaveError("");
    setDraftPayload((current) => ({
      ...current,
      episodes: jsonRecordArray(current.episodes).map((episode) => (
        episodeIsConfirmed(episode) ? episode : { ...episode, status: "confirmed", confirmedAt }
      )),
    }));
  }

  async function saveProject() {
    if (!project || !token || !dirty) return;
    setSaving(true);
    setSaveMessage("");
    setSaveError("");
    try {
      const response = await fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sourcePayload: draftPayload,
          expectedRevision: project.revision,
        }),
      });
      const payload = parseResponseText(await response.text());
      if (response.status === 401 || response.status === 403) {
        setRequiresLogin(true);
        throw new Error("登录状态已失效，请重新登录后再保存。");
      }
      if (!response.ok) {
        const fallback = response.status === 409
          ? "项目已被其他请求更新，请刷新后重新编辑。"
          : "剧本保存失败";
        throw new Error(responseMessage(payload, fallback));
      }
      const nextProject = isRecord(payload) ? parseProject(payload.project) : null;
      if (!nextProject) {
        throw new Error("项目保存结果不完整，请刷新后重试。");
      }
      const nextStorageMode = isRecord(payload) && payload.storageMode === "compat"
        ? "compat"
        : "native";
      setProject(nextProject);
      setProjectStorageMode(nextStorageMode);
      setDraftPayload({ ...nextProject.sourcePayload });
      setSaveMessage(`项目已保存 · 版本 ${nextProject.revision}`);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : "剧本保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function persistGeneratedScript(candidate: {
    requestId: string;
    result: GeneralScriptResult;
    operation: "continue" | "rewrite";
    rewriteEpisodeNumbers: number[];
  }) {
    if (!project || !token || !currentUserId) return;
    setAiBusy("saving");
    setAiError("");
    try {
      const nextSourcePayload = mergeGeneratedScriptPayload({
        current: project.sourcePayload,
        result: candidate.result,
        operation: candidate.operation,
        rewriteEpisodeNumbers: candidate.rewriteEpisodeNumbers,
      });
      const response = await fetch(`/api/short-drama/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sourcePayload: nextSourcePayload,
          expectedRevision: project.revision,
        }),
      });
      const payload = parseResponseText(await response.text());
      if (!response.ok) {
        throw new Error(responseMessage(
          payload,
          response.status === 409
            ? "项目已发生变化；已保留本次生成结果，请刷新核对后重试保存。"
            : "AI 剧本已生成，但写回项目失败。",
        ));
      }
      const nextProject = isRecord(payload) ? parseProject(payload.project) : null;
      if (!nextProject) throw new Error("项目保存结果不完整，已保留本次生成内容。");
      setProject(nextProject);
      setDraftPayload({ ...nextProject.sourcePayload });
      setSelectedEpisodeIndex(candidate.operation === "continue"
        ? Math.max(0, candidate.result.episodes.length - continueCount)
        : Math.max(0, candidate.result.episodes.findIndex((episode) => episode.episodeNumber === candidate.rewriteEpisodeNumbers[0])));
      setPendingGenerated(null);
      scriptOperationIdentityRef.current = clearConfirmedClientSubmissionIdentity(
        scriptOperationIdentityRef.current,
        candidate.requestId,
      );
      clearGeneralScriptSubmission(scriptSubmissionKey, currentUserId, candidate.requestId);
      setAiMessage(candidate.operation === "continue"
        ? `已续写并保存到当前项目，共 ${candidate.result.episodes.length} 集；新增分集为草稿。`
        : `已改写第 ${candidate.rewriteEpisodeNumbers[0]}–${candidate.rewriteEpisodeNumbers.at(-1)} 集并保存；改写分集为草稿。`);
    } catch (cause) {
      setPendingGenerated(candidate);
      setAiError(cause instanceof Error ? cause.message : "AI 剧本已生成，但写回项目失败。");
    } finally {
      setAiBusy(null);
    }
  }

  async function runScriptOperation(operation: "continue" | "rewrite") {
    setAiMessage("");
    setAiError("");
    if (!project || !token || !currentUserId || !generalScriptResult) {
      setAiError("当前项目缺少完整的通用剧本结构，不能安全执行 AI 续写或改写。");
      return;
    }
    if (dirty) {
      setAiError("请先保存或放弃当前手动修改，再执行 AI 续写或改写。");
      return;
    }
    if (pendingGenerated) {
      setAiError("已有生成结果尚未保存，请先重试保存，避免重复提交。");
      return;
    }
    if (paidReadiness.status !== "ready") {
      setAiError(paidReadiness.status === "blocked"
        ? paidReadiness.message
        : "正在检查影视工坊服务状态，请稍后重试。");
      return;
    }

    const existingNumbers = generalScriptResult.episodes.map((episode) => episode.episodeNumber);
    const maxEpisode = Math.max(...existingNumbers);
    const count = Math.max(1, Math.min(20, operation === "continue" ? continueCount : rewriteCount));
    let rewriteEpisodeNumbers: number[] = [];
    if (operation === "rewrite") {
      if (productionCounts.shots > 0 || productionCounts.completedVideos > 0) {
        setAiError("项目已有分镜或成片，不能改写已有分集；可继续追加新分集。");
        return;
      }
      rewriteEpisodeNumbers = Array.from({ length: count }, (_, index) => rewriteStart + index);
      if (rewriteEpisodeNumbers.some((number) => !existingNumbers.includes(number))) {
        setAiError("改写范围超过当前已有分集，请缩小连续改写集数。");
        return;
      }
      const currentByNumber = new Map(episodes.map((episode, index) => [
        Number(episode.episodeNumber) || index + 1,
        episode,
      ]));
      const confirmed = rewriteEpisodeNumbers.find((number) => currentByNumber.get(number)?.status === "confirmed");
      if (confirmed) {
        setAiError(`第 ${confirmed} 集已定稿，请先取消定稿并保存后再改写。`);
        return;
      }
      if (!rewriteInstruction.trim()) {
        setAiError("请填写具体改写要求。");
        return;
      }
    } else if (generalScriptResult.summary.isFinale) {
      setAiError("当前剧本已经标记剧终；请先在剧本摘要中调整完结状态后再续写。");
      return;
    }

    const projectedMax = maxEpisode + (operation === "continue" ? count : 0);
    const fixedTotal = generalScriptResult.summary.totalEpisodes;
    if (operation === "continue" && !continueAsFinale && fixedTotal !== null && projectedMax > fixedTotal) {
      setAiError(`本次续写将到第 ${projectedMax} 集，超过计划总集数 ${fixedTotal}。`);
      return;
    }
    const tone = requestTone(generalScriptResult);
    const instruction = operation === "continue" ? continueInstruction.trim() : rewriteInstruction.trim();
    const requestBody = {
      profile: {
        id: generalScriptResult.profileId,
        version: GENERAL_SCRIPT_PROFILE_VERSION,
      },
      operation,
      settings: {
        creationMode: generalScriptResult.summary.creationMode,
        targetAudience: generalScriptResult.summary.targetAudience,
        tone: tone.tone,
        customTone: tone.customTone,
        genre: generalScriptResult.summary.genre,
        animationStyle: generalScriptResult.summary.animationStyle,
        videoSize: generalScriptResult.summary.videoSize,
        episodesToGenerate: count,
        totalEpisodes: operation === "continue" && continueAsFinale
          ? projectedMax
          : generalScriptResult.summary.totalEpisodes,
        isFinale: operation === "continue"
          ? continueAsFinale
          : generalScriptResult.summary.isFinale,
      },
      content: {
        title: generalScriptResult.summary.title,
        brief: generalScriptResult.summary.oneSentence || generalScriptResult.summary.synopsis || project.title,
        sourceMaterial: generalScriptResult.summary.creationMode === "adaptation"
          ? fieldText(project.sourcePayload.sourceMaterial, generalScriptResult.summary.synopsis)
          : "",
        requirements: instruction || generalScriptResult.summary.synopsis || generalScriptResult.summary.oneSentence,
      },
      existingResult: generalScriptResult,
      rewriteEpisodeNumbers,
      rewriteInstruction: instruction,
    };
    const approved = window.confirm(
      operation === "continue"
        ? `将调用当前影视编剧模型续写 ${count} 集，并在成功后写回当前项目。是否继续？`
        : `将调用当前影视编剧模型改写第 ${rewriteEpisodeNumbers[0]}–${rewriteEpisodeNumbers.at(-1)} 集，并在成功后写回当前项目。是否继续？`,
    );
    if (!approved) return;

    const submissionIdentity = resolveClientSubmissionIdentity(
      scriptOperationIdentityRef.current,
      await buildClientRequestFingerprint(requestBody),
      () => scriptClientRequestId(operation),
    );
    scriptOperationIdentityRef.current = submissionIdentity;
    try {
      saveGeneralScriptSubmission(scriptSubmissionKey, currentUserId, submissionIdentity);
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : "无法保留本次请求编号，本次尚未提交。");
      return;
    }
    setAiBusy(operation);
    try {
      const response = await fetch("/api/short-drama/script", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": submissionIdentity.requestId,
        },
        body: JSON.stringify(requestBody),
      });
      const payload = parseResponseText(await response.text());
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new Error(responseMessage(payload, operation === "continue" ? "续写失败" : "改写失败"));
      }
      const generated = parseGeneralScriptResult(payload.result);
      const candidate = {
        requestId: submissionIdentity.requestId,
        result: generated,
        operation,
        rewriteEpisodeNumbers,
      };
      setPendingGenerated(candidate);
      await persistGeneratedScript(candidate);
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : operation === "continue" ? "续写失败" : "改写失败");
      setAiBusy(null);
    }
  }

  function discardChanges() {
    if (!project || !dirty) return;
    setDraftPayload({ ...project.sourcePayload });
    setSelectedEpisodeIndex(0);
    setSaveMessage("");
    setSaveError("");
  }

  function refreshProject() {
    if (dirty && !window.confirm("刷新会放弃尚未保存的剧本修改，是否继续？")) return;
    void loadProject();
  }

  if (!authResolved || (loading && !project)) {
    return <div className={styles.root}><LoadingState /></div>;
  }

  if (requiresLogin && !project) {
    return <div className={styles.root}><SignedOutState /></div>;
  }

  if (!project) {
    return (
      <div className={styles.root}>
        <div className={styles.centerState} data-tone="danger" role="alert">
          <AlertTriangle size={30} aria-hidden="true" />
          <strong>项目无法读取</strong>
          <span>{loadError || "项目不存在或服务暂时不可用。"}</span>
          <div className={styles.stateActions}>
            <button className={styles.primaryButton} type="button" onClick={() => void loadProject()}>
              <RefreshCw size={16} />
              重试
            </button>
            <Link className={styles.secondaryButton} href="/youcai/tools/film-studio#projects">返回项目库</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root} data-testid="film-project-workbench">
      <header className={styles.topbar}>
        <Link className={styles.backLink} href="/youcai/tools/film-studio#projects">
          <ArrowLeft size={16} />
          返回项目库
        </Link>
        <div className={styles.topbarActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={loading || saving}
            onClick={refreshProject}
          >
            <RefreshCw className={loading ? styles.spin : undefined} size={16} />
            刷新
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={!dirty || saving}
            onClick={discardChanges}
          >
            <RotateCcw size={16} />
            放弃修改
          </button>
          <button
            className={styles.primaryButton}
            type="button"
            disabled={!dirty || saving}
            onClick={() => void saveProject()}
          >
            {saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </header>

      <div className={styles.workspace}>
        <section className={styles.projectHeader}>
          <div>
            <span className={styles.eyebrow}>FILM STUDIO PROJECT</span>
            <h1>{project.title}</h1>
            <p>{project.description || "项目尚未填写说明"}</p>
          </div>
          <div className={styles.projectBadges}>
            <span data-storage-mode={projectStorageMode || "unknown"}>
              {projectStorageMode === "compat" ? "草稿可保存" : "制作服务可用"}
            </span>
            <span>{projectTypeLabel(project.projectType)}</span>
            <span>版本 {project.revision}</span>
            <span>{formatDate(project.updatedAt)}</span>
          </div>
        </section>

        <nav className={styles.stepNav} aria-label="影视制作六阶段">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            return (
              <button
                type="button"
                data-active={activeStep === step.key ? "true" : undefined}
                data-connected="true"
                key={step.key}
                onClick={() => changeStep(step.key)}
              >
                <span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
                <Icon size={17} strokeWidth={1.8} />
                <span className={styles.stepCopy}>
                  <strong>{step.label}</strong>
                  <small>{step.note} · {counts[step.key]}</small>
                </span>
              </button>
            );
          })}
        </nav>

        {(dirty || saveMessage || saveError || loadError) && (
          <div
            className={styles.statusBar}
            data-tone={saveError || loadError ? "danger" : dirty ? "warning" : "success"}
            role={saveError || loadError ? "alert" : "status"}
          >
            {saveError || loadError ? (
              <AlertTriangle size={17} />
            ) : dirty ? (
              <Save size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
            <span>{saveError || loadError || (dirty ? "剧本有尚未保存的修改" : saveMessage)}</span>
          </div>
        )}

        <main className={styles.stageContent}>
          {activeStep === "script" && (
            <ScriptPanel
              payload={draftPayload}
              selectedEpisodeIndex={selectedEpisodeIndex}
              saving={saving}
              dirty={dirty}
              onSelectEpisode={setSelectedEpisodeIndex}
              onSummaryChange={updateSummary}
              onEpisodeChange={updateEpisode}
              onAddEpisode={addEpisode}
              onRemoveEpisode={removeEpisode}
              onEpisodeStatusChange={toggleEpisodeStatus}
              onConfirmAll={confirmAllEpisodes}
              hasDownstreamData={productionCounts.shots > 0 || productionCounts.completedVideos > 0}
              onSave={() => void saveProject()}
              aiCompatible={Boolean(generalScriptResult)}
              aiBusy={aiBusy}
              aiMessage={aiMessage}
              aiError={aiError}
              continueCount={continueCount}
              continueInstruction={continueInstruction}
              continueAsFinale={continueAsFinale}
              rewriteStart={rewriteStart}
              rewriteCount={rewriteCount}
              rewriteInstruction={rewriteInstruction}
              onContinueCountChange={(value) => setContinueCount(Math.max(1, Math.min(20, value)))}
              onContinueInstructionChange={setContinueInstruction}
              onContinueAsFinaleChange={setContinueAsFinale}
              onRewriteStartChange={setRewriteStart}
              onRewriteCountChange={(value) => setRewriteCount(Math.max(1, Math.min(20, value)))}
              onRewriteInstructionChange={setRewriteInstruction}
              onContinue={() => void runScriptOperation("continue")}
              onRewrite={() => void runScriptOperation("rewrite")}
              onRetryAiSave={() => pendingGenerated && void persistGeneratedScript(pendingGenerated)}
              hasPendingAiSave={Boolean(pendingGenerated)}
            />
          )}
          {activeStep === "character" && (
            <FilmStudioEntityPanel
              entityType="character"
              projectId={projectId}
              token={token || ""}
              sourceItems={characters}
            />
          )}
          {activeStep === "scene" && (
            <FilmStudioEntityPanel
              entityType="location"
              projectId={projectId}
              token={token || ""}
              sourceItems={scenes}
            />
          )}
          {activeStep === "prop" && (
            <FilmStudioEntityPanel
              entityType="prop"
              projectId={projectId}
              token={token || ""}
              sourceItems={props}
            />
          )}
          {activeStep === "storyboard" && (
            <div className={styles.scriptStack}>
              <FilmStudioShotPanel
                projectId={projectId}
                token={token || ""}
                defaultAspectRatio={project.settings.aspectRatio}
                creationBlockedMessage={storyboardEpisodeIssue?.message}
                onCountChange={updateShotCount}
              />
              {projectStorageMode === "native" ? (
                <FilmStudioProductionPanel
                  stage="storyboard"
                  projectId={projectId}
                  token={token || ""}
                  creationBlockedMessage={storyboardEpisodeIssue?.message}
                  onCountsChange={updateProductionCounts}
                />
              ) : <CompatProductionGate />}
            </div>
          )}
          {activeStep === "final" && (
            projectStorageMode === "native" ? (
              <FilmStudioProductionPanel
                stage="final"
                projectId={projectId}
                token={token || ""}
                onCountsChange={updateProductionCounts}
              />
            ) : <CompatProductionGate />
          )}
        </main>
      </div>
    </div>
  );
}
