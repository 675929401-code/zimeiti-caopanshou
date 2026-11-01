"use client";
import { readOfficialPrivateCache, writeOfficialPrivateCache } from "@/lib/official-agent-private-cache";

import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  Coins,
  Command,
  FileAudio,
  Film,
  Hash,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquare,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  Sparkles,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { VerifiedStoryboardMessageContent, verifyStoryboardMessageReferenceAssets } from "@/components/chat/storyboard-verified-message";
import { useApp } from "@/contexts/app-context";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import { appendImageWorkbenchPromptTransfer } from "@/lib/image-workbench-transfer";
import type {
  ManjuSkillOutput,
  ManjuSkillToolProposal,
} from "@/lib/manju-skill-output-protocol";
import {
  buildMangaCreativeAgentApiContent,
  detectMangaCreativeAgentSkill,
} from "@/lib/manga-creative-agent-prompt";
import {
  parseStructuredAgentOutput,
} from "@/lib/structured-agent-output";
import {
  buildHomepageStoryboardDraftDetail,
  readStoryboardIntakeSnapshotForMessage,
  resolveStoryboardHandoffContract,
  saveAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffTarget,
} from "@/lib/agent-workbench-handoff";
import { readBrowserWorkbenchIdentity } from "@/lib/workbench-user-storage";
import { hasStoryboardPromptPushCapability } from "@/lib/storyboard-prompt-push-capability";
import {
  findYoucaiSkillByCommand,
  inferYoucaiSkill,
  parseYoucaiSkillInvocation,
  YOUCAI_SKILL_CATALOG,
} from "@/lib/youcai-skill-catalog";
import {
  storeYoucaiMusicPrefill,
  storeYoucaiVideoPrefill,
  YOUCAI_AGENT_WORKBENCH_ROUTES,
} from "@/lib/youcai-agent-routing";
import { consumeYoucaiAgentPrefill, storeYoucaiAgentPrefill } from "@/lib/youcai-agent-prefill";
import {
  createVirtualChatAgent,
  MANGA_WORKBENCH_AGENT_ID,
} from "@/lib/virtual-chat-agents";
import type { Message } from "@/types/coze";
import styles from "./official-agent-route.module.css";

const MODEL_STORAGE_KEY = "youcai_agent_model_id";
const MANGA_CONVERSATION_NAME = "创作 Agent";
const ALLOWED_INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_IMAGES_TOTAL_BYTES = 24 * 1024 * 1024;
const LATEST_MESSAGE_THRESHOLD_PX = 96;

const PLATFORM_COMMANDS = [
  { name: "help", label: "命令帮助", description: "查看命令与 Skill 的使用方法" },
  { name: "skills", label: "创作技能", description: "查看当前可直接调用的创作 Skill" },
] as const;

const PROMPT_CATEGORIES = ["通用", "风格", "构图", "光影", "人物", "场景", "运镜", "画质", "音频", "文本", "模板"] as const;
const PROMPT_SCENES = ["全部", "图片", "视频", "音频", "文本"] as const;
const ASSET_CATEGORIES: Record<AssetKind, readonly string[]> = {
  image: ["全部", "角色", "场景", "道具", "风格", "图片", "收藏"],
  video: ["全部", "分镜", "成片", "视频", "收藏"],
  audio: ["全部", "音乐", "语音", "音频", "音效", "收藏"],
};
const ASSET_LABELS: Record<AssetKind, string> = { image: "图片", video: "视频", audio: "音频" };

type ComposerPanel = "commands" | "prompts" | null;
type AssetKind = "image" | "video" | "audio";
type AgentControlPanel = "wechat" | "authorization" | "memory" | null;
type ProposalDestination = "image" | "video" | "audio" | "music";

interface ProposalDestinationMeta {
  label: string;
  route: string;
  actionLabel: string;
}

const AUDIO_WORKBENCH_ROUTE = "/voice-studio/workspace";
const PROPOSAL_DESTINATIONS: Readonly<Record<ProposalDestination, ProposalDestinationMeta>> = {
  image: {
    label: "图片工作台",
    route: YOUCAI_AGENT_WORKBENCH_ROUTES.image,
    actionLabel: "带入图片工作台",
  },
  video: {
    label: "视频工作台",
    route: YOUCAI_AGENT_WORKBENCH_ROUTES.video,
    actionLabel: "带入视频工作台",
  },
  audio: {
    label: "音频工作台",
    route: AUDIO_WORKBENCH_ROUTE,
    actionLabel: "进入音频工作台",
  },
  music: {
    label: "音乐工作台",
    route: YOUCAI_AGENT_WORKBENCH_ROUTES.music,
    actionLabel: "带入音乐工作台",
  },
};

const STRUCTURED_HANDOFF_DESTINATIONS: Readonly<Record<AgentWorkbenchHandoffTarget, ProposalDestinationMeta>> = {
  "storyboard-workbench": {
    label: "分镜工作台",
    route: "/storyboard-workbench?entry=agent&handoff=storyboard",
    actionLabel: "交接到分镜工作台",
  },
  canvas: {
    label: "分镜工作台",
    route: "/storyboard-workbench?entry=agent&handoff=storyboard&legacy=canvas",
    actionLabel: "交接到分镜工作台",
  },
  "film-studio": {
    label: "影视工坊",
    route: "/tools/film-studio?entry=agent&handoff=storyboard",
    actionLabel: "交接到影视工坊",
  },
};

const PROPOSAL_PREFILL_KEYS = [
  "prompt",
  "brief",
  "text",
  "content",
  "description",
  "image_prompt",
  "video_prompt",
  "audio_prompt",
  "music_prompt",
  "script",
  "lyrics",
  "narration",
] as const;

const OPEN_WORKBENCH_HINT_KEYS = ["workbench", "target", "media_type", "kind"] as const;

interface AgentAsset {
  id: string;
  kind: AssetKind;
  name: string;
  category: string;
  source: string;
  contentType: string;
  createdAt: string;
  contentPath: string;
  requiresAuth: boolean;
  previewPath?: string;
}

interface AgentMemoryRecord {
  id: string;
  content: string;
  updatedAt?: string;
}

interface AgentControlSnapshot {
  available: boolean;
  enabled?: boolean;
  connected?: boolean;
  reason?: string;
  conversationTitle?: string;
  paidToolAuthorizationEnabled?: boolean;
  memories?: AgentMemoryRecord[];
}

interface QuickPrompt {
  id: string;
  name: string;
  content: string;
  category: string;
  scenes: string[];
}

interface CommandOption {
  kind: "platform" | "skill";
  name: string;
  label: string;
  description: string;
  categoryLabel: string;
}

const STARTERS: ReadonlyArray<{ text: string }> = [
  { text: "我想做一部短剧，该怎么开始？" },
  { text: "根据今日抖音热点帮我写小红书文案" },
  { text: "用 Seedream 5.0 Lite 生成雨夜咖啡馆插画，霓虹湿街与室内暖灯形成冷暖对比" },
  { text: "先创作一段关于放下疲惫、安心入睡的治愈系晚安心语，再用温柔青年女声朗读，不要背景音乐" },
  { text: "创作一首轻快治愈的流行歌曲，以木吉他和钢琴为主，清澈女声唱出青春爱情里的心动与遗憾" },
  { text: "生成一段 5 秒赛博朋克城市夜景航拍视频，霓虹灯光穿过雨雾，镜头平稳向前推进" },
] as const;

interface ChatModelOption {
  id: string;
  displayName: string;
  variantLabel?: string;
  capabilities?: {
    imageParsing?: boolean;
    fileParsing?: boolean;
  };
}

interface QueuedPrompt {
  id: string;
  mode: "new-conversation" | "retry";
  prompt: string;
  modelId?: string;
  requiredConversationId?: string;
  waitForRemovedMessageId?: string;
  restoreMessage?: Message;
  apiContent?: string;
  imageUrls?: string[];
  attachmentAssetIds: string[];
  attachments: AgentAsset[];
  imagePayloads: Array<{ assetId: string; dataUrl: string }>;
  allowedSkillIds: string[];
}

interface ChatModelCatalogPayload {
  models?: unknown[];
  policy?: {
    defaultModelId?: unknown;
    selection?: unknown;
    fallback?: unknown;
    unavailableMessage?: unknown;
  };
}

interface OfficialAgentRouteProps {
  modelCatalogEndpoint?: "/api/chat-models" | "/api/youcai/chat-models";
}

function isChatModelOption(value: unknown): value is ChatModelOption {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.displayName === "string"
    && candidate.displayName.length > 0;
}

function formatConversationDate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatModelLabel(model: ChatModelOption | undefined): string {
  if (!model) return "";
  return `${model.displayName}${model.variantLabel ? `（${model.variantLabel}）` : ""}`;
}

function friendlyMangaError(value: string): string {
  if (!value) return value;
  if (/model_not_found|not supported by any configured account|modelCode.{0,8}不存在/iu.test(value)) {
    return "当前请求所用模型暂不可用。请切换模型后点击重试；系统不会自动改用其他模型。";
  }
  if (/LLM API|智谱AI API|invalid api key|authentication|rate limit|too many requests/iu.test(value)) {
    return "模型服务本次响应异常，请稍后重试或切换模型。";
  }
  return value;
}

function hideManjuSkillEnvelope(value: string): string {
  return value
    .replace(/<!--\s*manju_skill_output:v1[\s\S]*?(?:-->|$)/giu, "")
    .trim();
}

function extractProposalPrefill(proposal: ManjuSkillToolProposal): string {
  for (const key of PROPOSAL_PREFILL_KEYS) {
    const value = proposal.input[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized.slice(0, 40_000);
  }
  return "";
}

function resolveProposalDestination(proposal: ManjuSkillToolProposal): ProposalDestination | null {
  if (proposal.type === "generate_image") return "image";
  if (proposal.type === "generate_video") return "video";
  if (proposal.type === "generate_audio") return "audio";
  if (proposal.type === "generate_music") return "music";

  const hint = OPEN_WORKBENCH_HINT_KEYS
    .flatMap((key) => typeof proposal.input[key] === "string" ? [proposal.input[key] as string] : [])
    .join(" ")
    .toLocaleLowerCase();
  if (!hint) return null;
  if (/(?:music|歌曲|配乐|音乐)/u.test(hint)) return "music";
  if (/(?:audio|voice|speech|tts|声音|语音|音频|音效)/u.test(hint)) return "audio";
  if (/(?:video|movie|film|视频|成片|分镜)/u.test(hint)) return "video";
  if (/(?:image|picture|photo|图片|生图|绘图)/u.test(hint)) return "image";
  return null;
}

function proposalIcon(destination: ProposalDestination | null) {
  if (destination === "image") return <ImageIcon size={18} aria-hidden="true" />;
  if (destination === "video") return <Video size={18} aria-hidden="true" />;
  if (destination === "music") return <Music2 size={18} aria-hidden="true" />;
  return <FileAudio size={18} aria-hidden="true" />;
}

function ToolProposalCards({
  output,
  onHandoff,
}: {
  output: ManjuSkillOutput;
  onHandoff: (proposal: ManjuSkillToolProposal) => void;
}) {
  if (output.tool_proposals.length === 0) return null;
  return (
    <section
      className={styles.toolProposalSection}
      aria-label="待用户确认的工作台交接"
      data-testid="agent-tool-proposals"
    >
      <header className={styles.toolProposalHeader}>
        <span><Sparkles size={15} aria-hidden="true" />待用户确认</span>
        <small>{output.skill.command}</small>
      </header>
      <div className={styles.toolProposalGrid}>
        {output.tool_proposals.map((proposal, index) => {
          const destination = resolveProposalDestination(proposal);
          const meta = destination ? PROPOSAL_DESTINATIONS[destination] : null;
          const prefill = extractProposalPrefill(proposal);
          return (
            <article
              className={styles.toolProposalCard}
              data-destination={destination || "unknown"}
              data-testid={`agent-tool-proposal-${index}`}
              key={`${proposal.type}-${index}`}
            >
              <div className={styles.toolProposalTitle}>
                <span>{proposalIcon(destination)}</span>
                <div>
                  <strong>{meta?.label || "目标工作台待确认"}</strong>
                  <small>{proposal.requires_authorization ? "需用户主动确认" : "需用户点击进入"}</small>
                </div>
              </div>
              <p>{proposal.reason}</p>
              {prefill ? <pre className={styles.toolProposalPreview}>{prefill.slice(0, 320)}</pre> : null}
              <div className={styles.toolProposalSafety}>
                仅带入工作台；进入后仍需选择已发布模型、查看价格并主动提交。当前未生成、未创建任务、未扣费。
              </div>
              <button
                type="button"
                disabled={!meta}
                onClick={() => onHandoff(proposal)}
                data-testid={`agent-tool-proposal-action-${index}`}
              >
                {meta?.actionLabel || "目标工作台不明确"}
                {meta ? <ArrowRight size={15} aria-hidden="true" /> : null}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function StructuredStoryboardHandoffCards({
  onHandoff,
}: {
  onHandoff: (target: AgentWorkbenchHandoffTarget) => void;
}) {
  return (
    <section
      className={styles.toolProposalSection}
      aria-label="结构化分镜交接"
      data-testid="agent-structured-handoff"
    >
      <header className={styles.toolProposalHeader}>
        <span><Film size={15} aria-hidden="true" />继续生产</span>
        <small>storyboard_director_output.v1</small>
      </header>
      <div className={styles.toolProposalGrid}>
        {(Object.keys(STRUCTURED_HANDOFF_DESTINATIONS) as AgentWorkbenchHandoffTarget[]).map((target) => {
          const meta = STRUCTURED_HANDOFF_DESTINATIONS[target];
          return (
            <article
              className={styles.toolProposalCard}
              data-destination={target}
              key={target}
            >
              <div className={styles.toolProposalTitle}>
                <span>{target === "canvas" ? <ImageIcon size={18} /> : <Film size={18} />}</span>
                <div>
                  <strong>{meta.label}</strong>
                  <small>版本化数据包 · 确认后导入</small>
                </div>
              </div>
              <p>携带分段文案、生图 Prompt、视频 Prompt、时长、画幅和连续性信息。</p>
              <div className={styles.toolProposalSafety}>
                只交接结构化内容；目标页确认前不覆盖现有项目，不调用模型、不扣费。
              </div>
              <button type="button" onClick={() => onHandoff(target)}>
                {meta.actionLabel}<ArrowRight size={15} aria-hidden="true" />
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readPromptLibrary(value: unknown): QuickPrompt[] {
  try {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      const content = typeof candidate.content === "string"
        ? candidate.content
        : typeof candidate.value === "string"
          ? candidate.value
          : "";
      if (!content.trim()) return [];
      return [{
        id: typeof candidate.id === "string" ? candidate.id : `shortcut-${index}`,
        name: typeof candidate.name === "string"
          ? candidate.name
          : typeof candidate.title === "string"
            ? candidate.title
            : `提示词 ${index + 1}`,
        content,
        category: typeof candidate.category === "string" ? candidate.category : "通用",
        scenes: Array.isArray(candidate.scenes)
          ? candidate.scenes.filter((scene): scene is string => typeof scene === "string")
          : ["文本"],
      }];
    });
  } catch {
    return [];
  }
}

function persistPromptLibrary(prompts: QuickPrompt[], ownerId: string, currentOwner: () => string): boolean {
  try {
    return writeOfficialPrivateCache(localStorage, ownerId, "prompts", prompts, currentOwner);
  } catch {
    return false;
  }
}

function normalizeAssetKind(value: unknown): AssetKind | null {
  return value === "image" || value === "video" || value === "audio" ? value : null;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return null;
  const payload = await response.json() as unknown;
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("素材读取失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(blob);
  });
}

function ownedAssetIdFromContentPath(value: string): string {
  const match = /^\/api\/storage\/files\/([A-Za-z0-9_-]{1,160})\/content(?:\?.*)?$/u.exec(value);
  return match?.[1] || "";
}

function imageAssetIdsFromApiContent(value: string): string[] {
  const ids: string[] = [];
  for (const match of value.matchAll(/<asset id="([A-Za-z0-9_-]{1,160})" kind="image"/gu)) {
    if (match[1] && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

function AssetMediaPreview({
  asset,
  token,
  active,
}: {
  asset: AgentAsset;
  token: string;
  active: boolean;
}) {
  const [objectUrl, setObjectUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!asset.requiresAuth || !active || !token) return;
    const controller = new AbortController();
    let nextUrl = "";
    setFailed(false);
    void fetch(asset.contentPath, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error("素材预览读取失败");
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [active, asset.contentPath, asset.requiresAuth, token]);

  if (!asset.requiresAuth) {
    if (asset.kind === "image") return <img src={asset.contentPath} alt="" loading="lazy" />;
    if (!active && asset.previewPath) return <img src={asset.previewPath} alt="" loading="lazy" />;
    if (!active) {
      return (
        <span className={styles.assetPreviewFallback}>
          {asset.kind === "video" ? <Video size={28} /> : <FileAudio size={28} />}
        </span>
      );
    }
    if (asset.kind === "video") return <video src={asset.contentPath} controls playsInline preload="metadata" />;
    return <audio src={asset.contentPath} controls preload="metadata" />;
  }

  if (failed) return <span className={styles.assetPreviewFallback}>预览不可用</span>;
  if (!objectUrl) {
    return (
      <span className={styles.assetPreviewFallback}>
        {asset.kind === "image" ? <ImageIcon size={28} /> : asset.kind === "video" ? <Video size={28} /> : <FileAudio size={28} />}
      </span>
    );
  }
  if (asset.kind === "image") return <img src={objectUrl} alt="" />;
  if (asset.kind === "video") return <video src={objectUrl} controls playsInline preload="metadata" />;
  return <audio src={objectUrl} controls preload="metadata" />;
}

function MessageImagePreview({ src, token, label }: { src: string; token: string; label: string }) {
  const [previewUrl, setPreviewUrl] = useState(src.startsWith("data:image/") ? src : "");

  useEffect(() => {
    if (src.startsWith("data:image/")) {
      setPreviewUrl(src);
      return;
    }
    if (!ownedAssetIdFromContentPath(src) || !token) {
      setPreviewUrl("");
      return;
    }
    const controller = new AbortController();
    let objectUrl = "";
    void fetch(src, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error("图片读取失败")))
      .then((blob) => {
        if (!ALLOWED_INLINE_IMAGE_TYPES.has(blob.type.toLowerCase())) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => setPreviewUrl(""));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, token]);

  if (!previewUrl) return <span>{label}（需重新登录后查看）</span>;
  return (
    <img
      src={previewUrl}
      alt={label}
      style={{ width: 112, height: 84, objectFit: "cover", borderRadius: 9, border: "1px solid #dbe4f5" }}
    />
  );
}

export function OfficialAgentRoute({
  modelCatalogEndpoint = "/api/youcai/chat-models",
}: OfficialAgentRouteProps = {}) {
  const router = useAppScopedRouter();
  const { state, dispatch, startFreeChat, selectConversation, sendMessage } = useApp();
  const handoffStateRef = useRef(state); handoffStateRef.current = state;
  const structuredHandoffBusyRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const stickToLatestRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<number | null>(null);
  const inFlightRequestRef = useRef<string | null>(null);
  const commandQueryAppliedRef = useRef(false);
  const composerSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const [input, setInput] = useState("");
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedPrompt | null>(null);
  const [sending, setSending] = useState(false);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelStatus, setModelStatus] = useState("正在读取统一模型池的文案模型");
  const [lastRequestModelLabel, setLastRequestModelLabel] = useState("");
  const [activeSkillTitle, setActiveSkillTitle] = useState("");
  const [notice, setNotice] = useState("");
  const [composerPanel, setComposerPanel] = useState<ComposerPanel>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [privateInstalledCommunityIds, setInstalledCommunityIds] = useState<string[]>([]);
  const [privateQuickPrompts, setQuickPrompts] = useState<QuickPrompt[]>([]);
  const [showAllPrompts, setShowAllPrompts] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState("");
  const [promptDraftName, setPromptDraftName] = useState("");
  const [promptDraftContent, setPromptDraftContent] = useState("");
  const [promptDraftCategory, setPromptDraftCategory] = useState("通用");
  const [promptDraftScenes, setPromptDraftScenes] = useState<string[]>(["文本"]);
  const [assetPickerKind, setAssetPickerKind] = useState<AssetKind | null>(null);
  const [assetRecords, setAssetRecords] = useState<AgentAsset[]>([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [assetCategory, setAssetCategory] = useState("全部");
  const [assetSort, setAssetSort] = useState("newest");
  const [previewAssetId, setPreviewAssetId] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<AgentAsset[]>([]);
  const [privateFavoriteAssetIds, setFavoriteAssetIds] = useState<string[]>([]);
  const [controlPanel, setControlPanel] = useState<AgentControlPanel>(null);
  const [controlLoading, setControlLoading] = useState(false);
  const [controlSaving, setControlSaving] = useState(false);
  const [controlError, setControlError] = useState("");
  const [controlSnapshot, setControlSnapshot] = useState<AgentControlSnapshot | null>(null);
  const [editingMemoryId, setEditingMemoryId] = useState("");
  const [editingMemoryContent, setEditingMemoryContent] = useState("");
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const authenticated = state.auth.isAuthenticated;
  const privateOwnerId = authenticated ? String(state.auth.user?.id || "").trim() : "";
  const privateOwnerRef = useRef(privateOwnerId);
  useLayoutEffect(() => {
    privateOwnerRef.current = privateOwnerId;
    setAssetPickerKind(null); setSelectedAssets([]); setAssetRecords([]); setPreviewAssetId("");
    setInput(""); setQueuedPrompt(null); setComposerPanel(null);
  }, [privateOwnerId]);
  const [privateCacheOwner, setPrivateCacheOwner] = useState("");
  const privateCacheReady = Boolean(privateOwnerId && privateCacheOwner === privateOwnerId);
  const quickPrompts = useMemo(() => privateCacheReady ? privateQuickPrompts : [], [privateCacheReady, privateQuickPrompts]);
  const favoriteAssetIds = useMemo(() => privateCacheReady ? privateFavoriteAssetIds : [], [privateCacheReady, privateFavoriteAssetIds]);
  const installedCommunityIds = useMemo(() => privateCacheReady ? privateInstalledCommunityIds : [], [privateCacheReady, privateInstalledCommunityIds]);
  const canSelectModel = state.auth.user?.role === "admin";
  const conversations = useMemo(
    () => state.conversations
      .filter((conversation) => (
        conversation.type !== "video"
        && conversation.agentId === MANGA_WORKBENCH_AGENT_ID
      ))
      .slice()
      .sort((left, right) => right.updatedAt - left.updatedAt),
    [state.conversations],
  );
  const activeConversation = conversations.find(
    (conversation) => conversation.id === state.activeConversationId,
  );
  const activeAgent = state.agents.find((agent) => agent.id === activeConversation?.agentId || agent.botId === activeConversation?.agentId);
  const storyboardPromptPushEnabled = hasStoryboardPromptPushCapability(activeConversation?.agentId, activeAgent?.outputStyle);
  const selectedModelOption = models.find((model) => model.id === selectedModelId);
  const modelCapabilitySummary = modelsLoading
    ? "正在读取模型 · 发送已阻止"
    : selectedModelOption
      ? `${selectedModelOption.capabilities?.imageParsing === true ? "文案 + 图片理解" : "仅文案"} · 不自动切换 · 扣费以服务端结果为准`
      : "无兼容模型 · 发送已阻止";
  const composerSkill = input.trim() ? detectMangaCreativeAgentSkill(input) : "chat";
  const installedCommunitySet = useMemo(() => new Set(installedCommunityIds), [installedCommunityIds]);
  const availableSkills = useMemo(
    () => YOUCAI_SKILL_CATALOG.filter((skill) => skill.installedByDefault || installedCommunitySet.has(skill.id)),
    [installedCommunitySet],
  );
  const allowedSkillIds = useMemo(() => availableSkills.map((skill) => skill.id), [availableSkills]);
  const favoriteAssetSet = useMemo(() => new Set(favoriteAssetIds), [favoriteAssetIds]);
  const commandFragment = /^\/([^\s]*)$/u.exec(input.trim())?.[1]?.toLowerCase() ?? "";
  const commandMatches = useMemo<CommandOption[]>(() => {
    if (composerPanel !== "commands" && !/^\/[^\s]*$/u.test(input.trim())) return [];
    const platform: CommandOption[] = PLATFORM_COMMANDS.map((command) => ({
      kind: "platform",
      name: command.name,
      label: command.label,
      description: command.description,
      categoryLabel: "平台命令",
    }));
    const skills: CommandOption[] = availableSkills.map((skill) => ({
      kind: "skill",
      name: skill.commandName,
      label: skill.title,
      description: skill.summary,
      categoryLabel: skill.categoryLabel,
    }));
    return [...platform, ...skills].filter((command) => {
      if (!commandFragment) return true;
      return [command.name, command.label, command.description]
        .join(" ")
        .toLowerCase()
        .includes(commandFragment);
    });
  }, [availableSkills, commandFragment, composerPanel, input]);
  const visiblePrompts = useMemo(
    () => showAllPrompts
      ? quickPrompts
      : quickPrompts.filter((prompt) => prompt.scenes.includes("全部") || prompt.scenes.includes("文本")),
    [quickPrompts, showAllPrompts],
  );
  const filteredAssets = useMemo(() => {
    const normalizedQuery = assetQuery.trim().toLowerCase();
    const matchesCategory = (asset: AgentAsset) => {
      const haystack = `${asset.name} ${asset.category} ${asset.source}`.toLowerCase();
      if (assetCategory === "全部" || assetCategory === "图片" || assetCategory === "视频" || assetCategory === "音频") return true;
      if (assetCategory === "收藏") return favoriteAssetSet.has(asset.id);
      if (assetCategory === "角色") return /角色|人物|character|avatar/u.test(haystack);
      if (assetCategory === "场景") return /场景|scene|background|environment/u.test(haystack);
      if (assetCategory === "道具") return /道具|prop|object/u.test(haystack);
      if (assetCategory === "风格") return /风格|style/u.test(haystack);
      if (assetCategory === "分镜") return /分镜|storyboard|shot/u.test(haystack);
      if (assetCategory === "成片") return /成片|final|export|render/u.test(haystack);
      if (assetCategory === "音乐") return /音乐|music|song/u.test(haystack);
      if (assetCategory === "语音") return /语音|voice|tts|speech|配音/u.test(haystack);
      if (assetCategory === "音效") return /音效|sound|effect|sfx/u.test(haystack);
      return true;
    };
    return assetRecords
      .filter((asset) => matchesCategory(asset))
      .filter((asset) => !normalizedQuery || `${asset.name} ${asset.source}`.toLowerCase().includes(normalizedQuery))
      .slice()
      .sort((left, right) => {
        if (assetSort === "oldest") return left.createdAt.localeCompare(right.createdAt);
        if (assetSort === "name") return left.name.localeCompare(right.name, "zh-CN");
        return right.createdAt.localeCompare(left.createdAt);
      });
  }, [assetCategory, assetQuery, assetRecords, assetSort, favoriteAssetSet]);

  const persistOwnedImageAttachmentHistory = useCallback(async (
    conversationId: string,
    messageContent: string,
    assetIds: string[],
  ): Promise<boolean> => {
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length === 0) return true;
    const headers: HeadersInit = { "Content-Type": "application/json" };
    if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch("/api/conversations/history", {
          method: "POST",
          headers,
          cache: "no-store",
          body: JSON.stringify({
            attachmentHistory: { conversationId, messageContent, assetIds: uniqueAssetIds },
          }),
        });
        const payload = await readJsonRecord(response);
        if (response.ok) return true;
        if (
          response.status === 409
          && payload?.code === "ATTACHMENT_MESSAGE_NOT_READY"
          && attempt < maxAttempts - 1
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        setNotice("附件记录暂未保存，请保留当前页面并稍后重试。");
        return false;
      } catch {
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
      }
    }
    setNotice("附件历史未能写入；请保留当前页面并稍后重试。");
    return false;
  }, [state.auth.token]);

  const distanceFromLatest = useCallback(() => {
    const list = messageListRef.current;
    if (!list) return 0;
    return Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "auto") => {
    const list = messageListRef.current;
    if (!list) return;
    stickToLatestRef.current = true;
    autoScrollingRef.current = behavior === "smooth";
    setShowScrollToLatest(false);
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      list.scrollTo({ top: list.scrollHeight, behavior });
      scrollFrameRef.current = null;
      if (behavior !== "smooth") {
        autoScrollingRef.current = false;
        return;
      }
      scrollSettleTimerRef.current = window.setTimeout(() => {
        autoScrollingRef.current = false;
        const nearLatest = distanceFromLatest() <= LATEST_MESSAGE_THRESHOLD_PX;
        stickToLatestRef.current = nearLatest;
        setShowScrollToLatest(!nearLatest);
        scrollSettleTimerRef.current = null;
      }, 650);
    });
  }, [distanceFromLatest]);

  const handleMessageListScroll = useCallback(() => {
    const nearLatest = distanceFromLatest() <= LATEST_MESSAGE_THRESHOLD_PX;
    if (autoScrollingRef.current) {
      if (nearLatest) autoScrollingRef.current = false;
      stickToLatestRef.current = true;
      setShowScrollToLatest(false);
      return;
    }
    stickToLatestRef.current = nearLatest;
    setShowScrollToLatest(!nearLatest);
  }, [distanceFromLatest]);

  useEffect(() => {
    stickToLatestRef.current = true;
    autoScrollingRef.current = false;
    setShowScrollToLatest(false);
    scrollToLatest("auto");
  }, [activeConversation?.id, scrollToLatest]);

  useEffect(() => {
    if (!messageListRef.current) return;
    if (stickToLatestRef.current) scrollToLatest("auto");
    else setShowScrollToLatest(distanceFromLatest() > LATEST_MESSAGE_THRESHOLD_PX);
  }, [activeConversation?.messages, distanceFromLatest, scrollToLatest]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const observer = new MutationObserver(() => {
      if (stickToLatestRef.current) scrollToLatest("auto");
      else setShowScrollToLatest(distanceFromLatest() > LATEST_MESSAGE_THRESHOLD_PX);
    });
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [activeConversation?.id, distanceFromLatest, scrollToLatest]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (scrollSettleTimerRef.current !== null) window.clearTimeout(scrollSettleTimerRef.current);
  }, []);

  useEffect(() => {
    const virtualAgent = createVirtualChatAgent(MANGA_WORKBENCH_AGENT_ID);
    if (virtualAgent) dispatch({ type: "ADD_AGENTS", payload: [virtualAgent] });
  }, [dispatch]);

  useEffect(() => {
    setPrivateCacheOwner(""); setQuickPrompts([]); setFavoriteAssetIds([]); setInstalledCommunityIds([]);
    setPromptEditorOpen(false); setEditingPromptId(""); setPromptDraftName(""); setPromptDraftContent("");
    if (!privateOwnerId) return;
    try {
      const prompts = readOfficialPrivateCache<unknown>(localStorage, privateOwnerId, "prompts");
      const favorites = readOfficialPrivateCache<unknown>(localStorage, privateOwnerId, "favorites");
      const skills = readOfficialPrivateCache<unknown>(localStorage, privateOwnerId, "skills");
      if (!prompts.ok || !favorites.ok || !skills.ok) { setNotice("个人浏览器资料暂不可读取，已阻止覆盖；请检查存储权限。"); return; }
      if (privateOwnerRef.current !== privateOwnerId) return;
      setQuickPrompts(readPromptLibrary(prompts.value));
      setFavoriteAssetIds(readStringArray(favorites.value));
      setInstalledCommunityIds(readStringArray(skills.value));
      setPrivateCacheOwner(privateOwnerId);
    } catch { setNotice("个人浏览器资料暂不可读取，已阻止覆盖；请检查存储权限。"); }
  }, [privateOwnerId]);

  useEffect(() => {
    setCommandIndex(0);
  }, [commandFragment, composerPanel]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(240, Math.max(56, textarea.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    const closeComposerPanel = (event: MouseEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) setComposerPanel(null);
    };
    document.addEventListener("mousedown", closeComposerPanel);
    return () => document.removeEventListener("mousedown", closeComposerPanel);
  }, []);

  useEffect(() => {
    if (!assetPickerKind && !promptEditorOpen && !composerPanel && !controlPanel) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setComposerPanel(null);
      setAssetPickerKind(null);
      setPromptEditorOpen(false);
      setControlPanel(null);
      setPreviewAssetId("");
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [assetPickerKind, composerPanel, controlPanel, promptEditorOpen]);

  useEffect(() => {
    if (!assetPickerKind) return;
    const assetOwnerId = privateOwnerId;
    const controller = new AbortController();
    setAssetError("");
    setAssetQuery("");
    setAssetCategory("全部");
    setAssetSort("newest");
    setPreviewAssetId("");
    setAssetLoading(true);
    const headers: HeadersInit = {};
    if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
    void (async () => {
      const records: unknown[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore && offset < 2000) {
        const response = await fetch(`/api/storage/files?category=${assetPickerKind}&limit=100&offset=${offset}`, {
          headers,
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await response.json() as {
          files?: unknown[];
          error?: unknown;
          pagination?: { hasMore?: unknown; nextOffset?: unknown };
        };
        if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "个人素材读取失败");
        const page = Array.isArray(payload.files) ? payload.files : [];
        records.push(...page);
        const nextOffset = typeof payload.pagination?.nextOffset === "number"
          ? payload.pagination.nextOffset
          : offset + page.length;
        hasMore = payload.pagination?.hasMore === true && nextOffset > offset;
        offset = nextOffset;
      }
      const assets = records.flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const candidate = record as Record<string, unknown>;
        const kind = normalizeAssetKind(candidate.file_category);
        if (!kind || kind !== assetPickerKind || typeof candidate.id !== "string") return [];
        const name = typeof candidate.file_name === "string" ? candidate.file_name : "未命名素材";
        return [{
          id: candidate.id,
          kind,
          name,
          category: typeof candidate.source === "string" ? candidate.source : kind,
          source: typeof candidate.source === "string" ? candidate.source : "个人资产",
          contentType: typeof candidate.content_type === "string" ? candidate.content_type : "",
          createdAt: typeof candidate.created_at === "string" ? candidate.created_at : "",
          contentPath: `/api/storage/files/${encodeURIComponent(candidate.id)}/content`,
          requiresAuth: true,
        } satisfies AgentAsset];
      });
      if (!controller.signal.aborted && privateOwnerRef.current === assetOwnerId) setAssetRecords(assets);
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted && privateOwnerRef.current === assetOwnerId) {
          setAssetRecords([]);
          setAssetError(error instanceof Error ? error.message : "个人素材读取失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setAssetLoading(false);
      });
    return () => controller.abort();
  }, [assetPickerKind, privateOwnerId, state.auth.token]);

  useEffect(() => {
    try {
      const prefill = consumeYoucaiAgentPrefill();
      if (!prefill) return;
      setInput(prefill);
    } catch {
      // The composer remains usable when browser storage is unavailable.
    }
  }, [authenticated]);

  useEffect(() => {
    if (commandQueryAppliedRef.current) return;
    commandQueryAppliedRef.current = true;
    const rawCommand = new URLSearchParams(window.location.search).get("command") || "";
    const normalized = rawCommand.trim();
    if (!normalized) return;
    const nextInput = /^\/[a-z\d-]+$/iu.test(normalized) ? `${normalized} ` : normalized;
    setInput(nextInput);
    const commandName = /^\/([a-z\d-]+)/iu.exec(normalized)?.[1] || "";
    const skill = findYoucaiSkillByCommand(commandName);
    if (skill) {
      setActiveSkillTitle(skill.title);
      setNotice(`已载入 /${skill.commandName}，请补充需求后发送。`);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadModels() {
      if (!canSelectModel) {
        try {
          sessionStorage.removeItem(MODEL_STORAGE_KEY);
        } catch {
          // Role enforcement does not depend on browser storage cleanup.
        }
      }
      setModelsLoading(true);
      try {
        const headers: HeadersInit = {};
        if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
        const requestOptions: RequestInit = {
          headers,
          signal: controller.signal,
          cache: "no-store",
        };
        const response = modelCatalogEndpoint === "/api/youcai/chat-models"
          ? await fetch("/api/youcai/chat-models", requestOptions)
          : await fetch(modelCatalogEndpoint, requestOptions);
        if (!response.ok) throw new Error("模型列表加载失败");
        const payload = await response.json() as ChatModelCatalogPayload;
        const options = Array.isArray(payload.models)
          ? payload.models.filter(isChatModelOption)
          : [];
        const policyDefault = typeof payload.policy?.defaultModelId === "string"
          ? payload.policy.defaultModelId
          : "";
        setModels(options);
        let stored = "";
        try {
          if (canSelectModel) {
            stored = sessionStorage.getItem(MODEL_STORAGE_KEY) || "";
          }
        } catch {
          // A current server default remains usable without browser storage.
        }
        setSelectedModelId((current) => {
          if (canSelectModel && options.some((model) => model.id === current)) return current;
          if (canSelectModel && options.some((model) => model.id === stored)) return stored;
          if (options.some((model) => model.id === policyDefault)) return policyDefault;
          return options[0]?.id || "";
        });
        setModelStatus(
          typeof payload.policy?.unavailableMessage === "string"
            ? payload.policy.unavailableMessage
            : options.length > 0
              ? "统一模型池 · 文案兼容筛选"
              : "暂无已发布且兼容的文案模型",
        );
      } catch {
        if (!controller.signal.aborted) {
          setModels([]);
          setSelectedModelId("");
          setModelStatus(modelCatalogEndpoint === "/api/chat-models"
            ? "平台文案模型列表暂时不可用，已阻止对话发送"
            : "分支文案模型列表暂时不可用，已阻止对话发送");
        }
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    }
    void loadModels();
    return () => controller.abort();
  }, [canSelectModel, modelCatalogEndpoint, state.auth.token]);

  useEffect(() => {
    if (!queuedPrompt || !activeConversation) return;
    if (activeConversation.agentId !== MANGA_WORKBENCH_AGENT_ID) return;
    if (
      queuedPrompt.requiredConversationId
      && activeConversation.id !== queuedPrompt.requiredConversationId
    ) return;
    if (
      queuedPrompt.waitForRemovedMessageId
      && activeConversation.messages.some((message) => message.id === queuedPrompt.waitForRemovedMessageId)
    ) return;
    if (inFlightRequestRef.current === queuedPrompt.id) return;
    const task = queuedPrompt;
    inFlightRequestRef.current = task.id;
    setQueuedPrompt((current) => current?.id === task.id ? null : current);
    setSending(true);
    const queuedImageUrls = task.imageUrls
      ?? (task.imagePayloads.length > 0 ? task.imagePayloads.map((payload) => payload.dataUrl) : undefined);
    const queuedApiContent = task.apiContent
      ?? buildMangaCreativeAgentApiContent(task.prompt, {
        attachments: task.attachments,
        allowedSkillIds: task.allowedSkillIds,
        imagePayloadAssetIds: task.imagePayloads.map((payload) => payload.assetId),
      });
    void sendMessage(
      task.prompt,
      undefined,
      queuedImageUrls,
      task.modelId,
      queuedApiContent,
    )
      .then(async (success) => {
        const attachmentHistoryReady = task.attachmentAssetIds.length === 0
          || await persistOwnedImageAttachmentHistory(
            activeConversation.id,
            queuedApiContent,
            task.attachmentAssetIds,
          );
        if (!success) {
          setNotice(attachmentHistoryReady
            ? "发送链未建立，已保留本次引用图片；请使用失败消息下方的重试按钮。"
            : "发送链未建立，且附件历史未能确认；请保留当前页面后重试。");
          return;
        }
      })
      .finally(() => {
        if (inFlightRequestRef.current === task.id) inFlightRequestRef.current = null;
        setSending(false);
      });
  }, [activeConversation, persistOwnedImageAttachmentHistory, queuedPrompt, sendMessage]);

  useEffect(() => {
    if (!queuedPrompt) return;
    const task = queuedPrompt;
    const timeoutId = window.setTimeout(() => {
      if (inFlightRequestRef.current === task.id) return;
      setQueuedPrompt((current) => current?.id === task.id ? null : current);
      if (task.mode === "retry" && task.requiredConversationId && task.restoreMessage) {
        dispatch({
          type: "ADD_MESSAGE",
          payload: {
            conversationId: task.requiredConversationId,
            message: task.restoreMessage,
          },
        });
      }
      setSending(false);
      setNotice("对话状态未就绪，本次没有调用模型，请重试。");
    }, 4_000);
    return () => window.clearTimeout(timeoutId);
  }, [dispatch, queuedPrompt]);

  function rememberModel(modelId: string) {
    if (!canSelectModel) return;
    setSelectedModelId(modelId);
    try {
      sessionStorage.setItem(MODEL_STORAGE_KEY, modelId);
    } catch {
      // The selected model still applies to the current page.
    }
  }

  function rememberRequestModel(modelId: string) {
    setLastRequestModelLabel(formatModelLabel(models.find((model) => model.id === modelId)));
  }

  function loginWithPrefill(prompt: string) {
    try {
      if (prompt.trim()) storeYoucaiAgentPrefill(prompt);
      if (canSelectModel && selectedModelId) sessionStorage.setItem(MODEL_STORAGE_KEY, selectedModelId);
    } catch {
      // Login remains available without browser storage.
    }
    router.push("/login?redirect=%2Fyoucai%2Ftools%2Ftext%2Ftext-chat");
  }

  function beginConversation() {
    setNotice("");
    if (!authenticated) {
      loginWithPrefill(input);
      return;
    }
    dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: null });
    startFreeChat({
      agentId: MANGA_WORKBENCH_AGENT_ID,
      conversationName: MANGA_CONVERSATION_NAME,
      title: "新创作对话",
    });
  }

  function openAssetPicker(kind: AssetKind) {
    rememberComposerSelection();
    setComposerPanel(null);
    setAssetPickerKind(kind);
    setAssetQuery("");
    setAssetCategory("全部");
    setAssetSort("newest");
    setPreviewAssetId("");
    setNotice("");
  }

  async function openControlPanel(panel: Exclude<AgentControlPanel, null>) {
    setControlPanel(panel);
    setControlSnapshot(null);
    setControlError("");
    setEditingMemoryId("");
    setEditingMemoryContent("");
    if (!authenticated) {
      setControlError("请先登录当前漫剧工作台账号。未登录时不会读取或更改微信连接、会话授权和 Agent 记忆。");
      return;
    }
    if (panel === "authorization" && !activeConversation) {
      setControlError("当前没有已选中的创作会话。请先新建或选择一个会话，再设置该会话的授权范围。");
      return;
    }

    const endpoint = panel === "wechat"
      ? "/api/text-chat/weixin-binding"
      : panel === "memory"
        ? "/api/text-chat/memories"
        : `/api/text-chat/conversations/${encodeURIComponent(activeConversation?.id || "")}`;
    const headers: HeadersInit = {};
    if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
    setControlLoading(true);
    try {
      const response = await fetch(endpoint, { headers, cache: "no-store" });
      const payload = await readJsonRecord(response);
      if (!response.ok || payload?.success !== true) {
        if (response.status === 404) {
          throw new Error("这项会话服务暂未开放，当前账号状态没有发生变化。");
        }
        throw new Error("状态读取失败；本次没有更改任何账号或会话状态。");
      }

      if (panel === "wechat") {
        const binding = payload.binding && typeof payload.binding === "object"
          ? payload.binding as Record<string, unknown>
          : {};
        setControlSnapshot({
          available: true,
          enabled: payload.enabled !== false,
          connected: binding.connected === true,
          reason: typeof payload.reason === "string" ? "当前功能暂未开放，请稍后重试。" : undefined,
          conversationTitle: typeof binding.conversationTitle === "string" ? binding.conversationTitle : undefined,
          paidToolAuthorizationEnabled: binding.paidToolAuthorizationEnabled === true,
        });
      } else if (panel === "authorization") {
        const conversation = payload.conversation && typeof payload.conversation === "object"
          ? payload.conversation as Record<string, unknown>
          : {};
        setControlSnapshot({
          available: true,
          paidToolAuthorizationEnabled: conversation.paidToolAuthorizationEnabled === true,
        });
      } else {
        const memories = Array.isArray(payload.memories)
          ? payload.memories.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const memory = entry as Record<string, unknown>;
            if (typeof memory.id !== "string" || typeof memory.content !== "string") return [];
            return [{
              id: memory.id,
              content: memory.content,
              updatedAt: typeof memory.updatedAt === "string" ? memory.updatedAt : undefined,
            } satisfies AgentMemoryRecord];
          })
          : [];
        setControlSnapshot({ available: true, memories });
      }
    } catch (error) {
      setControlSnapshot({ available: false });
      setControlError(error instanceof Error ? error.message : "状态读取失败；功能已安全关闭。");
    } finally {
      setControlLoading(false);
    }
  }

  async function mutateControl(
    endpoint: string,
    method: "PATCH" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const headers: HeadersInit = {};
    if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
    if (body) headers["Content-Type"] = "application/json";
    setControlSaving(true);
    setControlError("");
    try {
      const response = await fetch(endpoint, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await readJsonRecord(response);
      if (!response.ok || payload?.success !== true) {
        throw new Error("操作失败，本次没有更改状态。");
      }
      return payload;
    } finally {
      setControlSaving(false);
    }
  }

  async function togglePaidToolAuthorization() {
    if (!activeConversation || !controlSnapshot?.available) return;
    const nextEnabled = controlSnapshot.paidToolAuthorizationEnabled !== true;
    try {
      const payload = await mutateControl(
        `/api/text-chat/conversations/${encodeURIComponent(activeConversation.id)}`,
        "PATCH",
        { paidToolAuthorizationEnabled: nextEnabled },
      );
      const conversation = payload.conversation && typeof payload.conversation === "object"
        ? payload.conversation as Record<string, unknown>
        : {};
      setControlSnapshot((current) => current ? {
        ...current,
        paidToolAuthorizationEnabled: conversation.paidToolAuthorizationEnabled === true,
      } : current);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "授权更新失败，本次没有更改状态。");
    }
  }

  async function saveMemory(memoryId: string) {
    const content = editingMemoryContent.trim();
    if (!content || content.length > 2_000) {
      setControlError("记忆内容必须为 1 至 2000 个字符。");
      return;
    }
    try {
      const payload = await mutateControl("/api/text-chat/memories", "PATCH", { id: memoryId, content });
      const memory = payload.memory && typeof payload.memory === "object"
        ? payload.memory as Record<string, unknown>
        : {};
      setControlSnapshot((current) => current ? {
        ...current,
        memories: (current.memories || []).map((entry) => entry.id === memoryId ? {
          id: memoryId,
          content: typeof memory.content === "string" ? memory.content : content,
          updatedAt: typeof memory.updatedAt === "string" ? memory.updatedAt : entry.updatedAt,
        } : entry),
      } : current);
      setEditingMemoryId("");
      setEditingMemoryContent("");
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "记忆更新失败，本次没有更改状态。");
    }
  }

  async function deleteMemory(memoryId: string) {
    if (!window.confirm("确定删除这条 Agent 记忆吗？删除后无法恢复。")) return;
    try {
      await mutateControl(`/api/text-chat/memories?id=${encodeURIComponent(memoryId)}`, "DELETE");
      setControlSnapshot((current) => current ? {
        ...current,
        memories: (current.memories || []).filter((entry) => entry.id !== memoryId),
      } : current);
      if (editingMemoryId === memoryId) {
        setEditingMemoryId("");
        setEditingMemoryContent("");
      }
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "记忆删除失败，本次没有更改状态。");
    }
  }

  async function clearMemories() {
    if (!window.confirm("确定清空当前账号的全部 Agent 记忆吗？此操作无法恢复。")) return;
    try {
      await mutateControl("/api/text-chat/memories?all=true", "DELETE");
      setControlSnapshot((current) => current ? { ...current, memories: [] } : current);
      setEditingMemoryId("");
      setEditingMemoryContent("");
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "记忆清空失败，本次没有更改状态。");
    }
  }

  function rememberComposerSelection() {
    const textarea = inputRef.current;
    if (!textarea) return;
    composerSelectionRef.current = {
      start: textarea.selectionStart ?? textarea.value.length,
      end: textarea.selectionEnd ?? textarea.selectionStart ?? textarea.value.length,
    };
  }

  function insertAtCursor(value: string) {
    const textarea = inputRef.current;
    const savedSelection = composerSelectionRef.current;
    let nextCursor = 0;
    setInput((current) => {
      if (!textarea) return `${current}${current && !current.endsWith(" ") ? " " : ""}${value}`;
      const start = Math.min(savedSelection?.start ?? textarea.selectionStart ?? current.length, current.length);
      const end = Math.min(savedSelection?.end ?? textarea.selectionEnd ?? start, current.length);
      const before = current.slice(0, start);
      const after = current.slice(end);
      nextCursor = start + value.length;
      return `${before}${value}${after}`;
    });
    requestAnimationFrame(() => {
      const nextTextarea = inputRef.current;
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(nextCursor, nextCursor);
      composerSelectionRef.current = { start: nextCursor, end: nextCursor };
    });
  }

  function chooseAsset(asset: AgentAsset) {
    if (selectedAssets.some((item) => item.id === asset.id)) {
      setNotice("该素材已经引用");
      return;
    }
    if (selectedAssets.length >= 20) {
      setNotice("每条消息最多引用 20 个素材");
      return;
    }
    const nextIndex = selectedAssets.filter((item) => item.kind === asset.kind).length + 1;
    const label = asset.kind === "image" ? "图片" : asset.kind === "video" ? "视频" : "音频";
    setSelectedAssets((current) => [...current, asset]);
    insertAtCursor(`@${label}${nextIndex} `);
    setAssetPickerKind(null);
    setPreviewAssetId("");
    setNotice(`已引用 ${asset.name}`);
  }

  function removeSelectedAsset(assetId: string) {
    setSelectedAssets((current) => current.filter((asset) => asset.id !== assetId));
  }

  async function materializeImagePayloads(assets: AgentAsset[]): Promise<Array<{ assetId: string; dataUrl: string }>> {
    const imageAssets = assets.filter((asset) => asset.kind === "image");
    if (imageAssets.length === 0) return [];
    const token = state.auth.token;
    if (!token && imageAssets.some((asset) => asset.requiresAuth)) return [];
    const blobs = await Promise.all(imageAssets.map(async (asset) => {
      try {
        const headers: HeadersInit = {};
        if (asset.requiresAuth && token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(asset.contentPath, {
          headers,
          cache: "no-store",
        });
        if (!response.ok) return "";
        const blob = await response.blob();
        if (!ALLOWED_INLINE_IMAGE_TYPES.has(blob.type.toLowerCase()) || blob.size > MAX_INLINE_IMAGE_BYTES) return "";
        return { assetId: asset.id, blob };
      } catch {
        return "";
      }
    }));
    let totalBytes = 0;
    const acceptedBlobs = blobs.filter((value): value is { assetId: string; blob: Blob } => {
      if (!value || totalBytes + value.blob.size > MAX_INLINE_IMAGES_TOTAL_BYTES) return false;
      totalBytes += value.blob.size;
      return true;
    });
    const available = await Promise.all(acceptedBlobs.map(async ({ assetId, blob }) => ({
      assetId,
      dataUrl: await blobToDataUrl(blob),
    })));
    if (available.length !== imageAssets.length) {
      setNotice("部分图片无法读取，已保留素材引用，但不会假装模型看到了缺失图片。");
    }
    return available;
  }

  async function materializeRetryImages(imageUrls: string[]): Promise<string[]> {
    if (imageUrls.length === 0) return [];
    const token = state.auth.token;
    let totalBytes = 0;
    const materialized: string[] = [];
    for (const imageUrl of imageUrls) {
      const assetId = ownedAssetIdFromContentPath(imageUrl);
      const inline = /^data:image\/(?:png|jpeg|webp|gif);base64,/iu.test(imageUrl);
      if (!inline && (!assetId || !token)) return [];
      try {
        const response = await fetch(imageUrl, {
          headers: assetId && token ? { Authorization: `Bearer ${token}` } : undefined,
          cache: "no-store",
        });
        if (!response.ok) return [];
        const blob = await response.blob();
        if (!ALLOWED_INLINE_IMAGE_TYPES.has(blob.type.toLowerCase()) || blob.size > MAX_INLINE_IMAGE_BYTES) return [];
        totalBytes += blob.size;
        if (totalBytes > MAX_INLINE_IMAGES_TOTAL_BYTES) return [];
        materialized.push(await blobToDataUrl(blob));
      } catch {
        return [];
      }
    }
    return materialized;
  }

  async function submitPrompt(prompt: string) {
    const normalized = prompt.trim();
    if (!normalized || sending) return;
    if (normalized === "/help") {
      setInput("/");
      setComposerPanel("commands");
      setNotice("使用 ↑↓ 选择命令，Enter 确认；/skills 可查看当前可调用的创作 Skill。");
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (normalized === "/skills") {
      setInput("/");
      setComposerPanel("commands");
      setNotice(`当前可直接调用 ${availableSkills.length} 个创作 Skill。`);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const invocation = parseYoucaiSkillInvocation(normalized);
    if (invocation.explicit && !invocation.skill) {
      setNotice("没有找到这个 Skill。请输入 / 打开命令目录后重新选择。");
      return;
    }
    if (invocation.skill && !allowedSkillIds.includes(invocation.skill.id)) {
      setNotice("这个社区 Skill 尚未安装，请先在 Skill 专家中安装后再调用。");
      return;
    }
    const inferred = inferYoucaiSkill(normalized);
    const selectedSkill = invocation.skill || (inferred && allowedSkillIds.includes(inferred.id) ? inferred : undefined);
    setActiveSkillTitle(selectedSkill?.title || "默认 Skill 调度助手");
    if (!authenticated) {
      loginWithPrefill(normalized);
      return;
    }
    if (!selectedModelId) {
      setNotice(canSelectModel ? "请先选择可用模型。" : "对话服务暂时不可用，请稍后重试。");
      return;
    }
    const attachmentSnapshot = selectedAssets.slice();
    const selectedModel = models.find((model) => model.id === selectedModelId);
    if (!selectedModel) {
      setNotice(canSelectModel
        ? "所选模型已不在当前可用目录中，请重新选择后发送。"
        : "对话服务当前不可用，请稍后重试。");
      return;
    }
    const imageAttachments = attachmentSnapshot.filter((asset) => asset.kind === "image");
    const unreadableMedia = attachmentSnapshot.filter((asset) => asset.kind === "video" || asset.kind === "audio");
    if (unreadableMedia.length > 0) {
      setNotice("当前 Agent 链路尚未将视频/音频内容传给模型；本次已阻止发送和扣费。请先移除这类素材，或在对应工作台完成转写/拆解后再引用。");
      return;
    }
    if (imageAttachments.length > 0 && selectedModel.capabilities?.imageParsing !== true) {
      setNotice(canSelectModel
        ? "当前模型未发布图片理解能力；本次已阻止发送和扣费。请切换支持图片理解的模型，或移除图片。"
        : "当前对话服务暂不支持图片；本次不会发送或扣费，请移除图片后重试。");
      return;
    }
    setNotice("");
    const imagePayloads = await materializeImagePayloads(attachmentSnapshot);
    if (imagePayloads.length !== imageAttachments.length) {
      setNotice("引用图片没有全部通过归属验权、类型或大小检查；本次已阻止发送和扣费，不会假装模型看到了图片。");
      return;
    }
    scrollToLatest("smooth");
    setInput("");
    setSelectedAssets([]);
    setComposerPanel(null);
    rememberRequestModel(selectedModelId);
    const requestModelId = canSelectModel ? selectedModelId : undefined;
    if (activeConversation) {
      setSending(true);
      const apiContent = buildMangaCreativeAgentApiContent(normalized, {
        attachments: attachmentSnapshot,
        allowedSkillIds,
        imagePayloadAssetIds: imagePayloads.map((payload) => payload.assetId),
      });
      void sendMessage(
        normalized,
        undefined,
        imagePayloads.length > 0 ? imagePayloads.map((payload) => payload.dataUrl) : undefined,
        requestModelId,
        apiContent,
      )
        .then(async (success) => {
          const attachmentHistoryReady = imagePayloads.length === 0
            || await persistOwnedImageAttachmentHistory(
              activeConversation.id,
              apiContent,
              imagePayloads.map((payload) => payload.assetId),
            );
          if (!success) {
            setNotice(attachmentHistoryReady
              ? "发送失败，已保留本次引用图片；请使用失败消息下方的重试按钮。"
              : "发送失败，且附件历史未能确认；请保留当前页面后重试。");
            return;
          }
        })
        .finally(() => setSending(false));
      return;
    }
    setSending(true);
    setQueuedPrompt({
      id: "agent-new-conversation",
      mode: "new-conversation",
      prompt: normalized,
      modelId: requestModelId,
      attachmentAssetIds: imagePayloads.map((payload) => payload.assetId),
      attachments: attachmentSnapshot,
      imagePayloads,
      allowedSkillIds,
    });
    startFreeChat({
      agentId: MANGA_WORKBENCH_AGENT_ID,
      conversationName: MANGA_CONVERSATION_NAME,
      title: "新创作对话",
    });
  }

  async function retryFailedMessage(conversationId: string, message: Message) {
    const normalized = (message.displayContent || message.content).trim();
    if (!normalized || sending || activeConversation?.id !== conversationId) return;
    if (!selectedModelId) {
      setNotice("暂无兼容的文案模型，无法重试。");
      return;
    }
    const retryModel = models.find((model) => model.id === selectedModelId);
    if (!retryModel) {
      setNotice(canSelectModel
        ? "所选模型已不在当前可用目录中，请重新选择后重试。"
        : "对话服务当前不可用，请稍后重试。");
      return;
    }
    const originalImageUrls = message.images || [];
    const stableAssetIds = originalImageUrls.map(ownedAssetIdFromContentPath).filter(Boolean);
    const contentAssetIds = imageAssetIdsFromApiContent(message.content);
    const retryAssetIds = stableAssetIds.length === originalImageUrls.length ? stableAssetIds : contentAssetIds;
    if (originalImageUrls.length > 0 && retryAssetIds.length !== originalImageUrls.length) {
      setNotice("原消息没有完整的已归属图片资产编号；本次已阻止重试和扣费，请重新选择图片素材。");
      return;
    }
    if (originalImageUrls.length > 0 && retryModel.capabilities?.imageParsing !== true) {
      setNotice(canSelectModel
        ? "当前模型未发布图片理解能力；本次已阻止重试和扣费，请切换支持图片理解的模型。"
        : "当前对话服务暂不支持图片；本次不会重试或扣费，请移除图片后重新发送。");
      return;
    }
    const originalImages = await materializeRetryImages(originalImageUrls);
    if (originalImages.length !== originalImageUrls.length) {
      setNotice("原消息的图片无法通过归属验权、类型或大小检查；本次已阻止重试和扣费。");
      return;
    }

    setNotice("");
    scrollToLatest("smooth");
    setSending(true);
    rememberRequestModel(selectedModelId);
    const requestModelId = canSelectModel ? selectedModelId : undefined;
    setQueuedPrompt({
      id: `agent-retry-${conversationId}-${message.id}`,
      mode: "retry",
      prompt: normalized,
      modelId: requestModelId,
      requiredConversationId: conversationId,
      waitForRemovedMessageId: message.id,
      restoreMessage: message,
      apiContent: message.content,
      imageUrls: originalImages,
      attachmentAssetIds: retryAssetIds,
      attachments: [],
      imagePayloads: [],
      allowedSkillIds,
    });
    dispatch({ type: "DELETE_MESSAGE", payload: { conversationId, messageId: message.id } });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt(input);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composerPanel === "commands" && commandMatches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setCommandIndex((current) => (current + direction + commandMatches.length) % commandMatches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setComposerPanel(null);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        chooseCommand(commandMatches[commandIndex] || commandMatches[0]);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function openPromptLibrary() {
    rememberComposerSelection();
    setComposerPanel("prompts");
    setNotice("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function openCommandMenu() {
    setComposerPanel("commands");
    setInput((current) => current.trim() ? current : "/");
    setNotice("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function chooseCommand(option: CommandOption) {
    setInput(`/${option.name} `);
    setComposerPanel(null);
    if (option.kind === "skill") setActiveSkillTitle(option.label);
    setNotice(`已选择 ${option.label}，请继续输入本次创作需求。`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function selectPrompt(prompt: QuickPrompt) {
    insertAtCursor(prompt.content.replace(/\[\d+\]/gu, ""));
    setComposerPanel(null);
    setNotice(`已插入提示词：${prompt.name}`);
  }

  function openPromptEditor(prompt?: QuickPrompt) {
    if (!privateCacheReady) { setNotice("请登录并确认个人资料已读取后再编辑提示词。"); return; }
    setComposerPanel(null);
    setEditingPromptId(prompt?.id || "");
    setPromptDraftName(prompt?.name || "");
    setPromptDraftContent(prompt?.content || "");
    setPromptDraftCategory(prompt?.category || "通用");
    setPromptDraftScenes(prompt?.scenes?.length ? prompt.scenes : ["文本"]);
    setPromptEditorOpen(true);
  }

  function savePrompt() {
    if (!privateCacheReady || privateOwnerRef.current !== privateOwnerId) { setNotice("账户已变化，请重新打开提示词编辑器。"); return; }
    const name = promptDraftName.trim();
    const content = promptDraftContent.trim();
    if (!name || !content) {
      setNotice("请填写提示词名称和内容。");
      return;
    }
    const record: QuickPrompt = {
      id: editingPromptId || `shortcut-${Date.now()}`,
      name,
      content,
      category: promptDraftCategory,
      scenes: promptDraftScenes.length > 0 ? promptDraftScenes : ["文本"],
    };
    const next: QuickPrompt[] = editingPromptId
      ? quickPrompts.map((prompt) => prompt.id === editingPromptId ? record : prompt)
      : [...quickPrompts, record];
    if (!persistPromptLibrary(next, privateOwnerId, () => privateOwnerRef.current)) {
      setNotice("浏览器未能保存提示词，请检查存储权限后重试。");
      return;
    }
    setQuickPrompts(next);
    setPromptEditorOpen(false);
    setNotice(`${editingPromptId ? "已更新" : "已保存"}提示词：${name}`);
  }

  function deletePrompt(promptId: string) {
    if (!privateCacheReady || privateOwnerRef.current !== privateOwnerId) { setNotice("账户已变化，请刷新个人提示词。"); return; }
    const next = quickPrompts.filter((prompt) => prompt.id !== promptId);
    if (!persistPromptLibrary(next, privateOwnerId, () => privateOwnerRef.current)) {
      setNotice("提示词删除失败，请检查浏览器存储权限。");
      return;
    }
    setQuickPrompts(next);
  }

  function togglePromptScene(scene: string) {
    setPromptDraftScenes((current) => (
      current.includes(scene)
        ? current.filter((item) => item !== scene)
        : [...current, scene]
    ));
  }

  function toggleAssetFavorite(assetId: string) {
    if (!privateCacheReady || privateOwnerRef.current !== privateOwnerId) { setNotice("请登录并读取个人收藏后再操作。"); return; }
    const next = favoriteAssetIds.includes(assetId) ? favoriteAssetIds.filter(id => id !== assetId) : [...favoriteAssetIds, assetId];
    try {
      if (!writeOfficialPrivateCache(localStorage, privateOwnerId, "favorites", next, () => privateOwnerRef.current)) throw new Error("PRIVATE_CACHE_WRITE_FAILED");
      setFavoriteAssetIds(next);
    } catch { setNotice("收藏状态未能保存，请检查浏览器存储权限。"); }
  }

  const handleStructuredWorkbenchHandoff = useCallback(async (
    messageId: string,
    target: AgentWorkbenchHandoffTarget,
  ) => {
    if (structuredHandoffBusyRef.current) { setNotice("正在导入提示词，请稍候。"); return; }
    const identity = readBrowserWorkbenchIdentity();
    if (!privateOwnerId || privateOwnerRef.current !== privateOwnerId
      || identity?.userId !== privateOwnerId) {
      setNotice("账号已变化，请重新打开当前账号的回复后操作。");
      return;
    }
    const messages = activeConversation?.messages;
    const messageIndex = messages?.findIndex(message => message.id === messageId) ?? -1;
    const originalMessage = messages && messageIndex >= 0 ? messages[messageIndex] : undefined;
    const agent = state.agents.find(item => item.id === activeConversation?.agentId || item.botId === activeConversation?.agentId);
    const intake = readStoryboardIntakeSnapshotForMessage(messages, messageId, (agent?.outputStyle as Record<string, unknown> | undefined)?.director_mode);
    const contract = resolveStoryboardHandoffContract(messages, messageId, agent?.outputStyle);
    const detail = originalMessage && buildHomepageStoryboardDraftDetail(originalMessage, intake?.input, contract.requiredVersion,
      { previewAssetVerification: true, referenceProjectId: intake?.referenceProjectId, allowLegacyUnverified: contract.allowLegacyUnverified, requirePerformancePlan: contract.requirePerformancePlan, allowQualityWarnings: true });
    const meta = STRUCTURED_HANDOFF_DESTINATIONS[target];
    if (!detail) {
      setNotice("未识别到与原接收卡逐段对应的完整生图和视频提示词，请核对段落编号与提示词代码框。");
      return;
    }
    if (detail.phase === "assets" && target === "film-studio") {
      setNotice("三视图资产阶段请先推送到分镜工作台，完成生成并采用后再续写正式分镜。");
      return;
    }
    structuredHandoffBusyRef.current = true;
    try {
      const ready = await verifyStoryboardMessageReferenceAssets(detail, identity);
      const latest = handoffStateRef.current;
      const latestMessage = latest.conversations.find(item => item.id === activeConversation?.id)?.messages.find(item => item.id === messageId);
      if (latest.activeConversationId !== activeConversation?.id || latest.auth.user?.id !== privateOwnerId
        || latestMessage?.content !== originalMessage.content || readBrowserWorkbenchIdentity()?.token !== identity.token) {
        throw new Error("账号、会话或回复已变化，请重新确认后操作。");
      }
      const handoff = saveAgentWorkbenchHandoff(ready, target === "canvas" ? "storyboard-workbench" : target);
      if (!handoff) throw new Error(`${meta.label}交接包未能写入浏览器会话，已停止跳转；未创建项目、未调用模型、未扣费。`);
      setNotice(`已准备 ${meta.label} 交接包；目标页仍需确认导入，当前未调用模型、未扣费。`);
      router.push(`${meta.route}&handoffId=${encodeURIComponent(handoff.handoff_id)}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "三视图核验或交接失败，请稍后重试。"); }
    finally { structuredHandoffBusyRef.current = false; }
  }, [activeConversation, privateOwnerId, router, state.agents]);

  const handleToolProposalHandoff = useCallback((proposal: ManjuSkillToolProposal) => {
    const destination = resolveProposalDestination(proposal);
    if (!destination) {
      setNotice("该建议没有可验证的目标工作台，已阻止跳转；当前未生成、未创建任务、未扣费。");
      return;
    }

    const meta = PROPOSAL_DESTINATIONS[destination];
    const prefill = extractProposalPrefill(proposal);
    let prepared = true;
    try {
      if (destination === "image" && prefill) {
        prepared = Boolean(appendImageWorkbenchPromptTransfer(prefill));
      } else if (destination === "video" && prefill) {
        prepared = storeYoucaiVideoPrefill(prefill);
      } else if (destination === "music" && prefill) {
        prepared = storeYoucaiMusicPrefill(prefill);
      }
    } catch {
      prepared = false;
    }

    if (!prepared) {
      setNotice(`${meta.label}的预填内容未能安全写入，已停止跳转；当前未生成、未创建任务、未扣费。`);
      return;
    }

    setNotice(destination === "audio" && prefill
      ? "音频工作台暂无现成文本预填协议；建议内容继续保留在本卡片，进入后请手动复制。当前未生成、未创建任务、未扣费。"
      : `已准备${meta.label}交接内容；进入后仍需选择模型、查看价格并主动提交。当前未生成、未创建任务、未扣费。`);
    router.push(meta.route);
  }, [router]);

  function handleMessageAction(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>(".copy-code-button, .copyable-block-copy-btn");
    if (!button) return;
    const wrapper = button.closest<HTMLElement>(".code-block-wrapper, .copyable-block");
    const text = wrapper?.querySelector("code, pre, .copyable-block-content")?.textContent || "";
    if (!text.trim()) return;
    void navigator.clipboard.writeText(text).then(() => setNotice("已复制")).catch(() => setNotice("复制失败，请手动选择内容。"));
  }

  return (
    <div className={styles.route} data-testid="official-agent-page">
      <aside
        className={styles.conversationRail}
        aria-label="对话列表"
        data-history-source="youcai-agent-account-conversations"
      >
        <button className={styles.newConversationButton} type="button" onClick={beginConversation} disabled={sending}>
          <Plus size={17} aria-hidden="true" />
          新对话
        </button>
        <div className={styles.conversationList}>
          {conversations.length === 0 ? (
            <div className={styles.emptyConversation} data-authenticated={authenticated ? "true" : "false"}>
              <MessageSquare size={19} aria-hidden="true" />
              <strong>{authenticated ? "暂无对话" : "登录后查看对话"}</strong>
              <span>
                {authenticated
                  ? "新建对话后，只展示当前账号的漫剧创作历史。"
                  : "登录后读取漫剧工作台的真实历史，不混入主站其他智能体。"}
              </span>
              {!authenticated && (
                <button type="button" onClick={() => loginWithPrefill("")}>去登录</button>
              )}
            </div>
          ) : conversations.map((conversation) => (
            <button
              className={styles.conversationItem}
              data-active={conversation.id === state.activeConversationId ? "true" : undefined}
              key={conversation.id}
              type="button"
              onClick={() => selectConversation(conversation.id)}
            >
              <MessageSquare size={16} aria-hidden="true" />
              <span>
                <strong>{conversation.title || conversation.agentName || "新对话"}</strong>
                <small>{conversation.lastMessage || formatConversationDate(conversation.updatedAt)}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div className={styles.topbarTitle}>
            <button type="button" onClick={() => router.back()} aria-label="返回"><ArrowLeft size={17} /></button>
            <Sparkles size={18} aria-hidden="true" />
            <strong>创作 Agent</strong>
          </div>
          <div className={styles.topbarControls}>
            <button type="button" onClick={() => void openControlPanel("wechat")} data-testid="agent-wechat-control"><Smartphone size={13} />微信</button>
            <button type="button" onClick={() => void openControlPanel("authorization")} data-testid="agent-authorization-control"><Coins size={13} />积分消费授权</button>
            <button type="button" onClick={() => void openControlPanel("memory")} data-testid="agent-memory-control"><Brain size={13} />记忆</button>
            <div className={styles.modelChooser}>
              {canSelectModel ? (
                <label className={styles.modelSelect}>
                  {modelsLoading ? <LoaderCircle className={styles.spin} size={13} /> : null}
                  <select
                    value={selectedModelId}
                    onChange={(event) => rememberModel(event.target.value)}
                    disabled={sending || modelsLoading || models.length === 0}
                    aria-label="选择创作模型"
                  >
                    {models.length === 0 ? (
                      <option value="">{modelsLoading ? "读取模型中" : "暂无可用文案模型"}</option>
                    ) : models.map((model) => (
                      <option value={model.id} key={model.id}>
                        {model.displayName}{model.variantLabel ? `（${model.variantLabel}）` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <small
                className={styles.modelPolicy}
                title={`${modelStatus}；所选模型不会被静默替换，实际发送和扣费以服务端即时校验结果为准。`}
                aria-live="polite"
                data-image-parsing={selectedModelOption?.capabilities?.imageParsing === true ? "supported" : "unsupported"}
              >
                {canSelectModel ? modelCapabilitySummary : `系统模型 · ${modelCapabilitySummary}`}
              </small>
            </div>
          </div>
        </header>

        {activeConversation ? (
          <div className={styles.chatSurface} data-testid="official-agent-real-chat">
            <div className={styles.conversationHeader}>
              <span><Sparkles size={18} aria-hidden="true" /></span>
              <div>
                <strong>创作 Agent</strong>
                <small>独立会话 · Skill 调度 · 多模态创作编排</small>
              </div>
              {activeSkillTitle ? <span className={styles.activeSkillBadge}>Skill · {activeSkillTitle}</span> : null}
              {lastRequestModelLabel ? (
                <span className={styles.requestModelLabel}>最近请求：{lastRequestModelLabel}</span>
              ) : null}
            </div>
            <div
              ref={messageListRef}
              className={styles.messageList}
              aria-live="polite"
              data-testid="agent-message-list"
              onClick={handleMessageAction}
              onScroll={handleMessageListScroll}
            >
              {activeConversation.messages.length === 0 ? (
                <div className={styles.emptyMessages}>
                  <Sparkles size={24} aria-hidden="true" />
                  <strong>对话已建立</strong>
                  <span>输入创作需求后，系统会先进行类型判断和结构化拆解。</span>
                </div>
              ) : activeConversation.messages.map((message) => {
                const isUser = message.role === "user";
                const rawText = message.displayContent || message.content;
                const structuredOutput = isUser
                  ? null
                  : parseStructuredAgentOutput(rawText, !message.isStreaming, { allowQualityWarnings: true });
                const skillOutput = structuredOutput?.status === "valid"
                  && structuredOutput.kind === "manju_skill_output"
                  && structuredOutput.machine_payload
                  ? structuredOutput.machine_payload as ManjuSkillOutput
                  : null;
                const readableText = structuredOutput?.visible_text || rawText;
                const visibleText = isUser
                  ? rawText
                  : friendlyMangaError(hideManjuSkillEnvelope(readableText));
                return (
                  <article
                    className={styles.messageRow}
                    data-role={message.role}
                    data-message-status={message.error ? "failed" : message.isStreaming ? "streaming" : "complete"}
                    key={message.id}
                  >
                    <span className={styles.messageAvatar} aria-hidden="true">
                      {isUser ? "我" : <Sparkles size={16} />}
                    </span>
                    <div className={styles.messageColumn}>
                      {!isUser ? <strong>创作 Agent</strong> : null}
                      <div className={styles.messageBubble}>
                        <VerifiedStoryboardMessageContent
                          message={message}
                          conversationId={activeConversation.id}
                          ownerUserId={privateOwnerId}
                          text={visibleText}
                          outputStyle={activeAgent?.outputStyle}
                          agentId={activeConversation.agentId}
                          responseFormat={isUser ? "text" : "markdown"}
                        />
                        {isUser && message.images?.length ? (
                          <div
                            aria-label="已归属的引用图片"
                            style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}
                          >
                            {message.images.map((imageUrl, imageIndex) => (
                              <MessageImagePreview
                                key={`${message.id}-image-${imageIndex}`}
                                src={imageUrl}
                                token={state.auth.token || ""}
                                label={`引用图片 ${imageIndex + 1}`}
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {!isUser && skillOutput ? (
                        <ToolProposalCards
                          output={skillOutput}
                          onHandoff={handleToolProposalHandoff}
                        />
                      ) : null}
                      {!isUser
                        && storyboardPromptPushEnabled
                        && !message.isStreaming && Boolean(message.content.trim()) ? (
                          <StructuredStoryboardHandoffCards
                            onHandoff={(target) => handleStructuredWorkbenchHandoff(message.id, target)}
                          />
                        ) : null}
                      {isUser && message.error ? (
                        <div className={styles.messageError} role="alert">
                          <span>{friendlyMangaError(message.error)}</span>
                          <button
                            type="button"
                            onClick={() => void retryFailedMessage(activeConversation.id, message)}
                            disabled={sending || !selectedModelId}
                          >
                            <RefreshCw size={13} aria-hidden="true" />
                            重试
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>
        ) : (
          <div className={styles.welcome}>
            <span className={styles.agentMark}><Sparkles size={34} /></span>
            <h1>全能 AI 创作 Agent</h1>
            <p>描述你的需求，Agent 会调用专业 Skill 完成文案和多模态提示词，真实媒体任务在对应工作台使用已发布模型提交与计费。</p>
            <div className={styles.starterGrid}>
              {STARTERS.map(({ text }) => (
                <button type="button" key={text} onClick={() => void submitPrompt(text)} disabled={sending}>{text}</button>
              ))}
            </div>
          </div>
        )}

        <div className={styles.composerDock} data-conversation={activeConversation ? "true" : "false"}>
          {activeConversation && showScrollToLatest ? (
            <button
              type="button"
              className={styles.scrollToLatestButton}
              aria-label="回到最新消息"
              title="回到最新消息"
              data-testid="agent-scroll-to-latest"
              onClick={() => scrollToLatest("smooth")}
            >
              <ChevronDown size={19} aria-hidden="true" />
            </button>
          ) : null}
          <form ref={composerRef} className={styles.composer} onSubmit={handleSubmit}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => {
                const next = event.target.value;
                setInput(next);
                if (/^\/[^\s]*$/u.test(next.trim())) setComposerPanel("commands");
                else if (next.trim() === "#") setComposerPanel("prompts");
                else if (composerPanel === "commands") setComposerPanel(null);
              }}
              onSelect={rememberComposerSelection}
              onKeyDown={handleComposerKeyDown}
              placeholder={"描述你的创作需求，Agent 可以调用 Skill 输出文案、生图提示词、视频提示词或声音方案。\n图片可随消息引用；真实媒体生成由对应工作台的已发布模型提交与计费。\nEnter 发送 · / 命令与技能 · # 快捷提示词"}
              rows={1}
              aria-label="创作需求"
            />
            {composerPanel === "commands" ? (
              <div
                className={styles.commandMenu}
                role="listbox"
                aria-label="命令与创作技能"
                data-testid="agent-command-menu"
              >
                <header>
                  <strong><Command size={17} aria-hidden="true" />/ 命令与创作技能</strong>
                  <span>↑↓ 选择 · Enter 确认</span>
                  <button type="button" aria-label="关闭命令与创作技能" title="关闭" onClick={() => setComposerPanel(null)}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </header>
                {commandMatches.length === 0 ? (
                  <p className={styles.commandEmpty}>没有匹配的命令</p>
                ) : (
                  ["platform", "skill"].map((groupKind) => {
                    const group = commandMatches.filter((option) => option.kind === groupKind);
                    if (group.length === 0) return null;
                    return (
                      <section className={styles.commandGroup} key={groupKind}>
                        <small>{groupKind === "platform" ? "平台命令" : "创作技能"}</small>
                        {group.map((option) => {
                          const index = commandMatches.indexOf(option);
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={index === commandIndex}
                              data-highlighted={index === commandIndex ? "true" : undefined}
                              key={`${option.kind}-${option.name}`}
                              onMouseEnter={() => setCommandIndex(index)}
                              onClick={() => {
                                setInput(`/${option.name} `);
                                setComposerPanel(null);
                                if (option.kind === "skill") setActiveSkillTitle(option.label);
                                setNotice(`已选择 ${option.label}，请继续输入本次创作需求。`);
                                requestAnimationFrame(() => inputRef.current?.focus());
                              }}
                            >
                              <span><strong>/{option.name}</strong><small>{option.label}</small></span>
                              <em>{option.description}</em>
                            </button>
                          );
                        })}
                      </section>
                    );
                  })
                )}
              </div>
            ) : null}
            {composerPanel === "prompts" ? (
              <div className={styles.promptPopover} role="dialog" aria-label="提示词库" data-testid="agent-shortcut-popover">
                <header>
                  <strong># 提示词库</strong>
                  <button type="button" onClick={() => setShowAllPrompts((current) => !current)}>
                    {showAllPrompts ? "按当前工具筛选" : "显示全部"}
                  </button>
                  <button type="button" aria-label="关闭提示词库" title="关闭" onClick={() => setComposerPanel(null)}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </header>
                <div className={styles.promptList}>
                  {visiblePrompts.length === 0 ? (
                    <p>暂无文本类提示词<br />点击下方创建</p>
                  ) : visiblePrompts.map((prompt) => (
                    <div className={styles.promptListItem} key={prompt.id}>
                      <button type="button" onClick={() => selectPrompt(prompt)}>
                        <strong>{prompt.name}</strong>
                        <span>{prompt.content}</span>
                      </button>
                      <span className={styles.promptItemActions}>
                        <button type="button" aria-label={`编辑提示词 ${prompt.name}`} onClick={() => openPromptEditor(prompt)}>
                          <Pencil size={14} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`删除提示词 ${prompt.name}`} onClick={() => deletePrompt(prompt.id)}>
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
                <button className={styles.createPromptButton} type="button" onClick={() => openPromptEditor()}>
                  <Plus size={16} aria-hidden="true" />新建提示词
                </button>
              </div>
            ) : null}
            {selectedAssets.length > 0 ? (
              <div className={styles.attachmentStrip} aria-label="已引用素材">
                {selectedAssets.map((asset) => (
                  <span key={asset.id} data-testid={`agent-attachment-${asset.id}`}>
                    {asset.kind === "image" ? <ImageIcon size={14} /> : asset.kind === "video" ? <Video size={14} /> : <FileAudio size={14} />}
                    {asset.name}
                    <button type="button" aria-label={`移除 ${asset.name}`} onClick={() => removeSelectedAsset(asset.id)}><X size={13} /></button>
                  </span>
                ))}
              </div>
            ) : null}
            {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
            <div className={styles.composerFooter}>
              <div className={styles.composerTools}>
                <button type="button" data-tool="commands" onClick={openCommandMenu} title="命令与创作技能" aria-label="打开命令与创作技能" data-testid="agent-command-trigger">
                  <span className={styles.composerSlashIcon} aria-hidden="true">/</span>
                  <span className={styles.composerToolLabel}>命令 / Skill</span>
                </button>
                <button type="button" data-tool="prompts" onClick={openPromptLibrary} title="快捷提示词" aria-label="快捷提示词" data-testid="agent-shortcut-trigger">
                  <Hash size={19} aria-hidden="true" />
                  <span className={styles.composerToolLabel}>提示词库</span>
                </button>
                <button type="button" data-tool="image" onClick={() => openAssetPicker("image")} title="引用个人图片" aria-label="引用个人图片" data-testid="agent-asset-trigger-image">
                  <ImageIcon size={18} aria-hidden="true" />
                  <span className={styles.composerToolLabel}>图片</span>
                </button>
                <button type="button" data-tool="video" onClick={() => openAssetPicker("video")} title="引用个人视频" aria-label="引用个人视频" data-testid="agent-asset-trigger-video">
                  <Video size={18} aria-hidden="true" />
                  <span className={styles.composerToolLabel}>视频</span>
                </button>
                <button type="button" data-tool="audio" onClick={() => openAssetPicker("audio")} title="引用个人音频" aria-label="引用个人音频" data-testid="agent-asset-trigger-audio">
                  <Music2 size={18} aria-hidden="true" />
                  <span className={styles.composerToolLabel}>音频 / 音乐</span>
                </button>
              </div>
              <button
                className={styles.sendButton}
                type="submit"
                data-intent={composerSkill}
                disabled={!input.trim() || sending || (authenticated && !selectedModelId)}
                aria-label="发送创作需求"
              >
                {sending ? <LoaderCircle className={styles.spin} size={18} /> : <Send size={18} />}
              </button>
            </div>
          </form>
        </div>
      </section>
      {controlPanel ? (
        <div
          className={styles.modalOverlay}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setControlPanel(null);
          }}
        >
          <section
            className={styles.controlDialog}
            role="dialog"
            aria-modal="true"
            aria-label={controlPanel === "wechat" ? "连接微信创作" : controlPanel === "authorization" ? "积分消费授权" : "管理 Agent 记忆"}
            data-testid={`agent-control-dialog-${controlPanel}`}
          >
            <header>
              <strong>
                <span className={styles.controlDialogIcon} data-kind={controlPanel}>
                  {controlPanel === "wechat" ? <Smartphone size={20} /> : controlPanel === "authorization" ? <Coins size={20} /> : <Brain size={20} />}
                </span>
                {controlPanel === "wechat" ? "连接微信创作" : controlPanel === "authorization" ? "积分消费授权" : "管理 Agent 记忆"}
              </strong>
              <button type="button" aria-label="关闭" onClick={() => setControlPanel(null)}><X size={20} /></button>
            </header>
            <div className={styles.controlDialogBody}>
              {controlLoading ? (
                <div className={styles.controlLoading}><LoaderCircle className={styles.spin} size={24} />正在读取当前账号状态</div>
              ) : controlError ? (
                <div className={styles.controlUnavailable} role="status" data-testid="agent-control-fail-closed">
                  <strong>当前服务未接通，已安全关闭</strong>
                  <p>{controlError}</p>
                  <small>
                    {controlPanel === "wechat"
                      ? "读取当前连接状态后，才能扫码连接、切换当前对话或解除连接。"
                      : controlPanel === "authorization"
                        ? "授权只对当前会话有效；每次使用仍会校验积分和素材权限。"
                        : "Agent 记忆与普通聊天记录分开管理，可以单独编辑、删除或清空。"}
                  </small>
                </div>
              ) : controlSnapshot?.available ? (
                controlPanel === "wechat" ? (
                  <div className={styles.controlStack}>
                    <div className={styles.controlStatusCard} data-positive={controlSnapshot.connected ? "true" : undefined}>
                      <strong>{controlSnapshot.connected ? "微信已连接" : "微信尚未连接"}</strong>
                      <p>{controlSnapshot.connected ? `当前连接到“${controlSnapshot.conversationTitle || "微信创作"}”` : "需要通过本应用微信绑定服务生成二维码后才能连接。"}</p>
                    </div>
                    <div className={styles.controlInfoGrid}>
                      <article><strong>连续对话</strong><p>网页和微信共享同一段历史、模型与 Agent 记忆。</p></article>
                      <article><strong>付费工具</strong><p>遵循连接对话的授权设置，当前{controlSnapshot.paidToolAuthorizationEnabled ? "已授权" : "未授权"}。</p></article>
                    </div>
                    {controlSnapshot.enabled === false ? <p className={styles.controlWarning}>{controlSnapshot.reason || "微信创作通道尚未启用，请稍后再试。"}</p> : null}
                  </div>
                ) : controlPanel === "authorization" ? (
                  <div className={styles.controlStack}>
                    <div className={styles.controlStatusCard}>
                      <strong>当前会话：{activeConversation?.title || "新对话"}</strong>
                      <p>积分消费授权当前{controlSnapshot.paidToolAuthorizationEnabled ? "已开启" : "未开启"}。</p>
                    </div>
                    <button
                      className={styles.authorizationSwitch}
                      type="button"
                      role="switch"
                      aria-checked={controlSnapshot.paidToolAuthorizationEnabled === true}
                      disabled={controlSaving}
                      onClick={() => void togglePaidToolAuthorization()}
                      title="授权仅保存到当前账号拥有的当前会话"
                    >
                      <span>允许 Agent 在当前会话调用扣积分工具</span>
                      <i aria-hidden="true" />
                    </button>
                    {controlSaving ? <span className={styles.controlSaving}><LoaderCircle className={styles.spin} size={14} />正在保存</span> : null}
                    <p className={styles.controlFinePrint}>授权仅对当前会话有效，新建或切换到其他会话不会自动继承。已提交任务不会因随后关闭授权而自动取消。</p>
                  </div>
                ) : (
                  <div className={styles.controlStack}>
                    {(controlSnapshot.memories || []).length === 0 ? (
                      <div className={styles.controlStatusCard}><strong>暂无 Agent 记忆</strong><p>对话历史不会被冒充为长期记忆。</p></div>
                    ) : (
                      <div className={styles.memoryList}>
                        {(controlSnapshot.memories || []).map((memory) => (
                          <article key={memory.id}>
                            {editingMemoryId === memory.id ? (
                              <textarea
                                value={editingMemoryContent}
                                maxLength={2_000}
                                onChange={(event) => setEditingMemoryContent(event.target.value)}
                                aria-label="编辑 Agent 记忆"
                              />
                            ) : <p>{memory.content}</p>}
                            <div className={styles.memoryMeta}>
                              {memory.updatedAt ? <small>{new Date(memory.updatedAt).toLocaleString("zh-CN")}</small> : <span />}
                              <span>
                                {editingMemoryId === memory.id ? (
                                  <>
                                    <button type="button" disabled={controlSaving} onClick={() => void saveMemory(memory.id)}><Check size={13} />保存</button>
                                    <button type="button" disabled={controlSaving} onClick={() => { setEditingMemoryId(""); setEditingMemoryContent(""); }}><X size={13} />取消</button>
                                  </>
                                ) : (
                                  <>
                                    <button type="button" disabled={controlSaving} onClick={() => { setEditingMemoryId(memory.id); setEditingMemoryContent(memory.content); }}><Pencil size={13} />编辑</button>
                                    <button type="button" disabled={controlSaving} onClick={() => void deleteMemory(memory.id)}><Trash2 size={13} />删除</button>
                                  </>
                                )}
                              </span>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    {(controlSnapshot.memories || []).length > 0 ? (
                      <button className={styles.clearMemoriesButton} type="button" disabled={controlSaving} onClick={() => void clearMemories()}>
                        <Trash2 size={14} />清空全部记忆
                      </button>
                    ) : null}
                  </div>
                )
              ) : null}
            </div>
            <footer><button type="button" onClick={() => setControlPanel(null)}>关闭</button></footer>
          </section>
        </div>
      ) : null}
      {assetPickerKind ? (
        <div
          className={styles.modalOverlay}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              setAssetPickerKind(null);
              setPreviewAssetId("");
            }
          }}
        >
          <section
            className={styles.assetDialog}
            role="dialog"
            aria-modal="true"
            aria-label={`选择${ASSET_LABELS[assetPickerKind]}`}
            data-testid={`agent-asset-dialog-${assetPickerKind}`}
          >
            <header>
              <strong>
                {assetPickerKind === "image" ? <ImageIcon size={21} /> : assetPickerKind === "video" ? <Video size={21} /> : <Music2 size={21} />}
                选择{ASSET_LABELS[assetPickerKind]}
              </strong>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => {
                  setAssetPickerKind(null);
                  setPreviewAssetId("");
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <label className={styles.assetSearch}>
              <Search size={18} aria-hidden="true" />
              <input
                value={assetQuery}
                onChange={(event) => setAssetQuery(event.target.value)}
                placeholder="搜索文件名或提示词..."
                aria-label="搜索文件名或提示词"
              />
            </label>
            <div className={styles.assetFilters}>
              <div>
                {ASSET_CATEGORIES[assetPickerKind].map((category) => (
                  <button
                    type="button"
                    data-active={assetCategory === category ? "true" : undefined}
                    key={category}
                    onClick={() => setAssetCategory(category)}
                  >
                    {category === "角色" ? "👤 " : category === "场景" ? "🏞️ " : category === "道具" ? "💍 " : category === "风格" ? "🎨 " : category === "图片" ? "🖼️ " : category === "分镜" ? "🎬 " : category === "成片" ? "🎞️ " : category === "视频" ? "🎥 " : category === "音乐" ? "🎵 " : category === "语音" ? "🎙️ " : category === "音频" ? "🎧 " : category === "音效" ? "🔊 " : category === "收藏" ? "⭐ " : ""}
                    {category}
                  </button>
                ))}
              </div>
              <label>
                <select value={assetSort} onChange={(event) => setAssetSort(event.target.value)} aria-label="素材排序">
                  <option value="newest">最新优先</option>
                  <option value="oldest">最早优先</option>
                  <option value="name">名称 A-Z</option>
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </label>
            </div>
            <div className={styles.assetDialogBody}>
              {assetLoading ? (
                <div className={styles.assetEmpty}><LoaderCircle className={styles.spin} size={34} /><strong>正在读取个人素材</strong></div>
              ) : assetError ? (
                <div className={styles.assetEmpty} role="alert">
                  <span className={styles.assetEmptyIcon}><X size={32} /></span>
                  <strong>个人素材读取失败</strong>
                  <small>{assetError}</small>
                </div>
              ) : filteredAssets.length === 0 ? (
                <div className={styles.assetEmpty}>
                  <span className={styles.assetEmptyIcon}>
                    {assetPickerKind === "image" ? <ImageIcon size={34} /> : assetPickerKind === "video" ? <Video size={34} /> : <Music2 size={34} />}
                  </span>
                  <strong>暂无{ASSET_LABELS[assetPickerKind]}素材</strong>
                  <small>上传或生成后将显示在这里</small>
                </div>
              ) : (
                <div className={styles.assetGrid}>
                  {filteredAssets.map((asset) => (
                    <article className={styles.assetCard} key={asset.id} data-testid={`agent-asset-card-${asset.id}`}>
                      <button
                        className={styles.assetPreviewButton}
                        type="button"
                        aria-label={asset.kind === "image" ? `引用 ${asset.name}` : `预览 ${asset.name}`}
                        onClick={() => asset.kind === "image" ? chooseAsset(asset) : setPreviewAssetId((current) => current === asset.id ? "" : asset.id)}
                      >
                        <AssetMediaPreview
                          asset={asset}
                          token={state.auth.token || ""}
                          active={asset.kind === "image" || previewAssetId === asset.id}
                        />
                      </button>
                      <footer>
                        <span><strong>{asset.name}</strong><small>{asset.source}</small></span>
                        <div>
                          <button
                            type="button"
                            aria-label={`${favoriteAssetSet.has(asset.id) ? "取消收藏" : "收藏"} ${asset.name}`}
                            data-active={favoriteAssetSet.has(asset.id) ? "true" : undefined}
                            onClick={() => toggleAssetFavorite(asset.id)}
                          >
                            {favoriteAssetSet.has(asset.id) ? "★" : "☆"}
                          </button>
                          <button type="button" onClick={() => chooseAsset(asset)}>
                            <Check size={14} aria-hidden="true" />引用
                          </button>
                        </div>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
      {promptEditorOpen && privateCacheReady ? (
        <div
          className={styles.modalOverlay}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setPromptEditorOpen(false);
          }}
        >
          <section className={styles.promptEditor} role="dialog" aria-modal="true" aria-label={editingPromptId ? "编辑提示词" : "新建提示词"}>
            <header>
              <strong>{editingPromptId ? "编辑提示词" : "新建提示词"}</strong>
              <button type="button" aria-label="关闭" onClick={() => setPromptEditorOpen(false)}><X size={20} /></button>
            </header>
            <label>
              <span>名称</span>
              <input value={promptDraftName} onChange={(event) => setPromptDraftName(event.target.value)} placeholder="给提示词起一个名称" />
            </label>
            <label>
              <span>提示词内容</span>
              <textarea value={promptDraftContent} onChange={(event) => setPromptDraftContent(event.target.value)} rows={7} placeholder="输入要插入创作输入框的提示词" />
            </label>
            <label>
              <span>内容分类</span>
              <select value={promptDraftCategory} onChange={(event) => setPromptDraftCategory(event.target.value)}>
                {PROMPT_CATEGORIES.map((category) => <option value={category} key={category}>{category}</option>)}
              </select>
            </label>
            <fieldset>
              <legend>适用场景（可多选）</legend>
              <div>
                {PROMPT_SCENES.map((scene) => (
                  <button
                    type="button"
                    data-active={promptDraftScenes.includes(scene) ? "true" : undefined}
                    key={scene}
                    onClick={() => togglePromptScene(scene)}
                  >
                    {promptDraftScenes.includes(scene) ? <Check size={13} /> : null}{scene}
                  </button>
                ))}
              </div>
            </fieldset>
            <footer>
              <button type="button" onClick={() => setPromptEditorOpen(false)}>取消</button>
              <button type="button" onClick={savePrompt}>保存</button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
