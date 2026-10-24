"use client";

import Image from "next/image";
import { canvasModelAdmissionIssue } from "@/lib/canvas-public-catalog-loader";
import { getVideoMediaUnavailable } from "@/lib/video-media-availability";
import { generatedImageReferenceUri, parseGeneratedImageReferenceUri } from "@/lib/generated-image-reference";
import { videoWorkflowImageRequestFields } from "@/lib/video-workflow-draft";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  AlertCircle,
  AudioLines,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  DownloadCloud,
  Eye,
  FileJson,
  FileText,
  Focus,
  Frame,
  Grid2X2,
  History,
  ImageIcon,
  Images,
  LayoutGrid,
  Layers3,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Music2,
  PanelRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  Upload,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  AspectRatio,
  CanvasVoiceOption,
  CanvasVoicePricing,
  CoverModel,
  StoryboardCard,
  StudioAsset,
  VideoModel,
} from "@/lib/studio-canvas-types";
import type { InspirationCanvasHandoff } from "@/features/official-inspiration/canvas-handoff";
import {
  coerceImageResolution,
  getImageModelCapabilities,
  type ImageResolution,
} from "@/lib/image-model-capabilities";
import type {
  CompiledCharacterAsset,
  CompiledStoryboardShot,
  KeyframeStrategy,
  PublicCanvasPromptPreset,
  VisualEffectsLevel,
} from "@/lib/canvas-prompt-presets";
import { composeStoryboardReferenceGenerationPrompt } from "@/lib/canvas-prompt-presets";
import {
} from "@/lib/canvas-model-defaults";
import {
  CANVAS_HISTORY_MAX_RECORDS,
  CANVAS_HISTORY_RETENTION_DAYS,
  cleanCanvasRunHistory,
} from "@/lib/canvas-run-history";
import {
  parseStoryboardCanvasImport,
  type StoryboardCanvasImportPlan,
} from "@/lib/storyboard-canvas-bridge";
import {
  readAgentWorkbenchHandoff,
  type AgentWorkbenchHandoffEnvelope,
} from "@/lib/agent-workbench-handoff";
import {
  coerceVideoTargetDuration,
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
  getVideoTargetDurationOptions,
  resolveVideoCharge,
  resolveVideoResolution,
  resolveVideoDuration,
} from "@/lib/video-model-capabilities";
import { resolveGeneratedImageClientDelivery, projectGeneratedImageClientReceipt, projectGeneratedImageDocument, type GeneratedImageClientDelivery } from "@/lib/generated-image-client-delivery";
import {
  collectWorkflowInputs,
  getWorkflowExecutionOrder,
  resolveWorkflowPrompt,
  WorkflowGraphSchema,
  type WorkflowNodeData as PersistedWorkflowNodeData,
  type WorkflowNodeKind,
  type WorkflowNodeRecord,
} from "@/lib/workflow-schema";
import {
  isAmbiguousAutodlH3SubmissionStatus,
  resolveAutodlH3ClientAttempt,
} from "@/lib/autodl-h3-client-idempotency";
import {
  BORDER_COLLIE_HOME_INSTRUCTION,
  BORDER_COLLIE_HOME_SCRIPT,
  CAT_HEALTH_SCRIPT,
  DOG_HOME_SCRIPT,
  DOG_SLEEP_GUARD_SCRIPT,
  DOG_TOY_SEMANTIC_INSTRUCTION,
  DOG_TOY_SEMANTIC_SCRIPT,
  GOLDEN_RETRIEVER_SEMANTIC_INSTRUCTION,
  GOLDEN_RETRIEVER_SEMANTIC_SCRIPT,
  DOG_SLEEP_WOMAN_INSTRUCTION,
  DOG_SLEEP_WOMAN_SCRIPT,
} from "@/lib/canvas-demo-scripts";
import {
  STORYBOARD_DIRECTOR_MODE_LABELS,
  type StoryboardDirectorMode,
  type StoryboardShotTimeRange,
} from "@/lib/storyboard-director-protocol";
import {
  createCanvasSessionId,
  prependFreshCanvasCopy,
  restoreActiveCanvasSession,
} from "@/lib/canvas-session-lifecycle";
import {
  canvasScopedStorageKey,
  type CanvasStorageScope,
} from "@/lib/canvas-storage-scope";

const TOKEN_KEY = "auth_token";
const CANVAS_DEMO_LEASE_TTL_MS = 8 * 60 * 1000;
const RATIOS: AspectRatio[] = ["16:9", "9:16", "4:3", "3:4", "1:1"];

function coerceCanvasVideoResolution(model: VideoModel | undefined, requested = "720p") {
  return resolveVideoResolution(model, requested).resolution || "720p";
}

function getCanvasVideoResolutionOptions(model: VideoModel | undefined) {
  const options = getVideoResolutionCapabilities(model).options;
  if (options.length > 0) return options;
  return [coerceCanvasVideoResolution(model, "720p")];
}

function getVideoAudioReferenceLimits(model: Pick<VideoModel, "minReferenceAudios" | "maxReferenceAudios"> | undefined) {
  const max = Math.max(0, model?.maxReferenceAudios || 0);
  const min = Math.max(0, Math.min(max, model?.minReferenceAudios || 0));
  return { min, max };
}
const ANIMATION_STYLE_OPTIONS = [
  {
    id: "pixar-3d",
    label: "皮克斯式3D",
    description: "圆润友好、表情细腻、暖亮电影光影",
    prompt: "电影级皮克斯式3D动画观感，明确可见的卡通化三维头身比例、简化五官和动画材质，角色造型圆润友好、表情细腻生动，动物保留柔软毛发，暖亮而有层次的色彩，家庭动画电影级灯光、景深与渲染质感；不是真人摄影，不是写实人像",
  },
  {
    id: "cinematic-cartoon-realism-3d",
    label: "电影级3D卡通半写实",
    description: "真实毛发、卡通表情、温暖电影光影",
    prompt: "电影级3D卡通半写实动画，欧美家庭动画电影质感；人物与动物保持清晰统一的三维卡通角色设计，动物具有真实蓬松毛发和可信材质，人物采用自然且适度卡通化的比例；眼神、面部表情和身体动作生动并具有剧情性；使用温暖明亮且协调的色彩、柔和体积光、轮廓光、浅景深和轻微辉光，场景道具丰富并具有前中后景层次，兼顾精致可爱、电影构图与商业动画渲染质感",
  },
  {
    id: "disney-3d",
    label: "迪士尼式3D",
    description: "优雅比例、灵动眼神、梦幻童话光影",
    prompt: "高品质迪士尼式3D动画观感，角色比例优雅，眼神灵动，面部表演丰富，材质精致，梦幻童话色彩与柔和体积光，经典动画电影级构图与渲染质感",
  },
  {
    id: "chibi-3d",
    label: "Q版萌系3D",
    description: "大头短身、明快色彩、可爱IP质感",
    prompt: "高品质Q版萌系3D动画，大头短身的可爱角色比例，圆脸大眼，柔软材质，明快但协调的多彩配色，动作轻快有弹性，精致可爱IP与商业动画短片质感",
  },
  {
    id: "clay-3d",
    label: "黏土定格3D",
    description: "手工纹理、温暖布景、定格动画质感",
    prompt: "精致黏土定格3D动画观感，角色与场景具有细腻手工黏土纹理和轻微指压质感，温暖棚拍布景，柔和实体灯光，动作保留自然定格节奏，手作艺术与电影级微缩场景质感",
  },
  {
    id: "cinematic-3d",
    label: "电影写实3D",
    description: "真实材质、物理光照、克制电影表演",
    prompt: "电影级写实3D动画观感，保持动画化角色轮廓并采用真实毛发、皮肤和环境材质，物理级光照与自然景深，克制可信的表演，精细摄影构图与高品质院线动画渲染",
  },
] as const;
type AnimationStyleId = typeof ANIMATION_STYLE_OPTIONS[number]["id"];
type ProductionModeId = "anime-story" | "real-story" | "ten-second" | "product-video";
type ProductionPresetId = "anime_story" | "warm_story" | "pet_knowledge" | "cinematic_realism" | "fast_marketing";
type ConsistencySource = "auto" | "explore" | "upload";
type FreeCanvasStoryTargetDuration = 8 | 10 | 15;
type StoryboardReferenceTextMode = "annotated" | "clean-video";

const STORY_DIRECTOR_OPTIONS: Array<{
  id: StoryboardDirectorMode;
  title: string;
  summary: string;
}> = [
  { id: "high_energy", title: STORYBOARD_DIRECTOR_MODE_LABELS.high_energy, summary: "动作更大、节奏更快、视觉包装更抓眼" },
  { id: "cinematic", title: STORYBOARD_DIRECTOR_MODE_LABELS.cinematic, summary: "镜头更稳、空间更连贯、情绪与事件平衡" },
  { id: "lyrical", title: STORYBOARD_DIRECTOR_MODE_LABELS.lyrical, summary: "节奏更慢、眼神触碰更细腻、包装更克制" },
];

const STORY_TARGET_DURATION_OPTIONS: FreeCanvasStoryTargetDuration[] = [8, 10, 15];

const STORYBOARD_REFERENCE_TEXT_OPTIONS: Array<{
  id: StoryboardReferenceTextMode;
  title: string;
  summary: string;
}> = [
  { id: "annotated", title: "图文注释校准版", summary: "一图多格可带简短中文镜头说明，用于人工核对分镜和对标效果" },
  { id: "clean-video", title: "纯画面视频参考版", summary: "不带说明条和小字，把信息转成图标、牌面、箭头和空间锚点" },
];

function storyTargetShotLabel(seconds: number) {
  if (seconds === 8) return "3个真实镜头";
  if (seconds === 15) return "4-6个真实镜头";
  return "3-4个真实镜头";
}

function storyboardReferenceTextModeInstruction(mode: StoryboardReferenceTextMode) {
  return mode === "annotated"
    ? "参考图版本：图文注释校准版。生图提示词生成一图多格故事板时，可以在每格下方加入极短中文镜头说明条，用于人工核对分镜、动作峰值和对标效果；说明条必须短、清楚、服务校准，不写长导演解释。视频提示词仍必须把说明条视为参考信息，成片不显示说明条、小字、字幕或分格线。"
    : "参考图版本：纯画面视频参考版。生图提示词生成一图多格故事板时，不出现说明条、小字、字幕、导演注释或可读长文字；把信息转成图标、无字牌面、箭头、颜色区、空间锚点和角色动作证据，便于后续图生视频参考。";
}

function resolveAnimationStyleId(value: string): AnimationStyleId {
  const normalized = value.trim().toLowerCase();
  const exact = ANIMATION_STYLE_OPTIONS.find((style) => (
    style.id === normalized || style.label.toLowerCase() === normalized
  ));
  if (exact) return exact.id;
  if (/黏土|clay/.test(normalized)) return "clay-3d";
  if (/q版|萌系|chibi/.test(normalized)) return "chibi-3d";
  if (/迪士尼|disney|童话/.test(normalized)) return "disney-3d";
  if (/写实|半写实|cinematic/.test(normalized)) return "cinematic-3d";
  return "pixar-3d";
}

const PRODUCTION_MODES: Array<{
  id: ProductionModeId;
  title: string;
  summary: string;
  agentName: string;
  workflowSummary: string;
  presetId: ProductionPresetId;
}> = [
  {
    id: "anime-story",
    title: "故事版提示词",
    summary: "分段文案 → 参考图提示词 / 视频提示词",
    agentName: "故事版提示词导演流程",
    workflowSummary: "读取分段文案、动画风格、时长和画幅，系统自动完成导演拆解、语义包装、视频提示词和参考图提示词，再加载到画布。",
    presetId: "anime_story",
  },
  {
    id: "real-story",
    title: "真实风提示词",
    summary: "文案 → 影视分镜提示词",
    agentName: "真实风提示词流程",
    workflowSummary: "根据文案和视觉风格统一人物、场景、动作和镜头，再自动加载可编辑分镜节点。",
    presetId: "cinematic_realism",
  },
  {
    id: "ten-second",
    title: "短视频提示词",
    summary: "短文案 → 快速成片提示词",
    agentName: "短视频提示词流程",
    workflowSummary: "把短文案拆成少量关键帧和视频节点，优先保持节奏紧凑、动作清楚。",
    presetId: "warm_story",
  },
  {
    id: "product-video",
    title: "产品提示词",
    summary: "产品图 / 卖点 → 图生视频提示词",
    agentName: "产品提示词流程",
    workflowSummary: "围绕产品参考图和卖点搭建图生视频画布，不走长文案分镜。",
    presetId: "fast_marketing",
  },
];

type WorkflowNodeData = Omit<PersistedWorkflowNodeData,"history"> & {imagePreviewUrl?:string;history:Array<PersistedWorkflowNodeData["history"][number]&{imagePreviewUrl?:string}>};
type WorkflowFlowNode = Node<WorkflowNodeData, "workflow">;
type WorkflowFlowEdge = Edge;

const LAYOUT_COLUMN_GAP = 560;
const LAYOUT_ROW_GAP = 430;

const NON_EXECUTABLE_ANIME_DECORATION_PATTERN = /(?:保持干净|可加入|可以使用|例如|根据语义|按语义选择)/u;

function hasConcreteAnimeSemanticDesign(prompt: string) {
  const semanticDesign = prompt.match(/(?:必画语义证据（优先执行）|语义强化（表演 \/ 道具 \/ 环境 \/ 特效）|语义强化（剧情道具 \/ 装饰）|视觉装饰)：([^\r\n]+)/u)?.[1]?.trim() || "";
  if (semanticDesign) {
    if (semanticDesign.length < 36 || NON_EXECUTABLE_ANIME_DECORATION_PATTERN.test(semanticDesign)) return false;
    const hasCurrentLayers = ["语义重点", "剧情表演", "叙事道具", "环境反馈", "图形特效"]
      .every((layer) => semanticDesign.includes(`【${layer}】`));
    if (hasCurrentLayers) return true;
    const hasLegacyLayers = ["剧情表演", "叙事道具", "环境反馈", "图形特效"]
      .every((layer) => semanticDesign.includes(`【${layer}】`));
    if (hasLegacyLayers) return true;
    return /(?:剧情表演|角色表演|角色反应|动作前势)/u.test(semanticDesign)
      && /(?:叙事道具|剧情道具|环境证据|环境反馈)/u.test(semanticDesign);
  }

  const directPrompt = prompt.trim();
  if (directPrompt.length < 80 || NON_EXECUTABLE_ANIME_DECORATION_PATTERN.test(directPrompt)) return false;
  const hasSubjectAndPerformance = /(?:人物|女性|男性|主人|女孩|男孩|金毛|哈士奇|泰迪|比熊|柯基|边牧|狗|猫|宠物)/u.test(directPrompt)
    && /(?:站|坐|趴|蹲|跑|跳|扑|咬|叼|抬|低|转|望|盯|躲|缩|僵|发抖|前倾|后仰|侧身|伸爪|摇尾|竖耳|皱眉|睁大|张嘴)/u.test(directPrompt);
  const hasCameraComposition = /(?:近景|中景|远景|特写|机位|视角|构图|前景|中景|后景|景深|俯拍|仰拍|平视)/u.test(directPrompt);
  const hasVisualRendering = /(?:光|阴影|色彩|色调|材质|毛发|轮廓|体积|渲染|3D|动画|卡通|场景|环境)/u.test(directPrompt);
  return hasSubjectAndPerformance && hasCameraComposition && hasVisualRendering;
}

function selectReferenceImageModel(selected?: CoverModel) {
  if (!selected || !getImageModelCapabilities(selected).supportsReferenceInput) return undefined;
  return selected;
}

function unresolvedCanvasImageAttempt(data: WorkflowNodeData, imageCount: number) {
  if (!data.imageClientTraceId && !data.imageClientIdempotencyKey) return null;
  const traceId = data.imageClientTraceId;
  const confirmed = traceId && (data.history.some(item => item.taskId === traceId && Boolean(item.outputUrl || item.imagePreviewUrl || item.imageDeliveryReceipt?.generationCompleted))
    || data.taskId === traceId && Boolean(data.imageDeliveryReceipt?.generationCompleted));
  if (confirmed) return null;
  if (!traceId || !data.imageClientIdempotencyKey || !data.imageRequestFingerprint) throw new Error("原图片请求身份不完整，请先核对历史；本次未创建新请求");
  let index: unknown;
  try { index = JSON.parse(data.imageRequestFingerprint).batchIndex; } catch { /* Reject below without replacing original keys. */ }
  if (!Number.isSafeInteger(index) || Number(index) < 0 || Number(index) >= imageCount) throw new Error("原图片请求位置已变化，请先核对历史；本次未创建新请求");
  return { traceId, key: data.imageClientIdempotencyKey, fingerprint: data.imageRequestFingerprint, index: Number(index) };
}

function assertCanvasImageAttemptRecovery(attempt: ReturnType<typeof unresolvedCanvasImageAttempt>, index: number, fingerprint: string) {
  if (attempt && (attempt.index !== index || attempt.fingerprint !== fingerprint)) throw new Error("原图片请求参数已变化，请先核对历史；仅显式重新生成可创建新请求");
}

function getShotNumber(node: WorkflowFlowNode) {
  if (node.data.visualOrder) return node.data.visualOrder;
  const match = node.data.title.match(/(?:镜头|分镜|shot)\s*0*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function getStoryboardRole(node: WorkflowFlowNode, reserveEndFrameColumn: boolean) {
  if (node.data.workflowRole === "narration") return 0;
  if (node.data.workflowRole === "director-card" || node.data.workflowRole === "image-prompt") return 1;
  if (node.data.workflowRole === "storyboard-reference" || node.data.workflowRole === "character-reference") return 2;
  if (node.data.assetRole === "storyboard-end-frame") return 3;
  if (node.data.workflowRole === "video-prompt") return reserveEndFrameColumn ? 3 : 2;
  if (node.data.workflowRole === "video-output") return reserveEndFrameColumn ? 4 : 3;
  const title = node.data.title.toLowerCase();
  if (node.data.kind === "text" && /文案|口播|旁白|narration/.test(title)) return 0;
  if (node.data.kind === "text") return 1;
  if (node.data.kind === "upload") return 2;
  if (node.data.kind === "image" && /尾帧|end\s*frame/.test(title)) return 3;
  if (node.data.kind === "image") return 2;
  if (node.data.kind === "video") return reserveEndFrameColumn ? 4 : 3;
  return 1;
}

function formatDurationLabel(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function layoutGenericWorkflow(nodes: WorkflowFlowNode[], edges: WorkflowFlowEdge[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const depth = new Map(nodes.map((node) => [node.id, 0]));

  edges.forEach((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  });

  const queue = nodes
    .filter((node) => (incoming.get(node.id) || 0) === 0)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((node) => node.id);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id) || []) {
      depth.set(target, Math.max(depth.get(target) || 0, (depth.get(id) || 0) + 1));
      incoming.set(target, (incoming.get(target) || 0) - 1);
      if ((incoming.get(target) || 0) === 0) queue.push(target);
    }
  }

  const maxDepth = Math.max(0, ...depth.values());
  nodes.filter((node) => !visited.has(node.id)).forEach((node, index) => {
    depth.set(node.id, maxDepth + 1 + Math.floor(index / 3));
  });

  const layers = new Map<number, WorkflowFlowNode[]>();
  nodes.forEach((node) => {
    const layer = depth.get(node.id) || 0;
    layers.set(layer, [...(layers.get(layer) || []), node]);
  });

  const laidOut = nodes.map((node) => {
    const layer = depth.get(node.id) || 0;
    const siblings = (layers.get(layer) || []).sort(
      (a, b) => a.position.y - b.position.y || a.position.x - b.position.x,
    );
    const row = siblings.findIndex((item) => item.id === node.id);
    return {
      ...node,
      position: { x: 220 + layer * LAYOUT_COLUMN_GAP, y: 120 + row * LAYOUT_ROW_GAP },
    };
  });

  return {
    nodes: laidOut,
    previewNodes: laidOut.length <= 12
      ? laidOut
      : laidOut.filter((node) => (depth.get(node.id) || 0) <= 2).slice(0, 9),
  };
}

function layoutWorkflow(nodes: WorkflowFlowNode[], edges: WorkflowFlowEdge[]) {
  const storyboardNodes = nodes.filter((node) => getShotNumber(node) !== null);
  if (storyboardNodes.length < 2) return layoutGenericWorkflow(nodes, edges);

  const globalNodes = nodes
    .filter((node) => getShotNumber(node) === null)
    .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const groups = new Map<number, WorkflowFlowNode[]>();
  storyboardNodes.forEach((node) => {
    const shotNumber = getShotNumber(node)!;
    groups.set(shotNumber, [...(groups.get(shotNumber) || []), node]);
  });
  const orderedShots = [...groups.entries()].sort(([a], [b]) => a - b);
  const reserveEndFrameColumn = storyboardNodes.some(
    (node) => node.data.assetRole === "storyboard-end-frame"
      || (node.data.kind === "image" && /尾帧|end\s*frame/i.test(node.data.title)),
  );
  const globalY = 80 + Math.floor(Math.max(0, orderedShots.length - 1) / 2) * LAYOUT_ROW_GAP;
  const shotStartX = 680;
  const positions = new Map<string, { x: number; y: number }>();

  const primaryGlobalNodes = globalNodes.filter((node) => /完整文案|AI拆镜|统一设定/.test(node.data.title));
  const auxiliaryGlobalNodes = globalNodes.filter((node) => !primaryGlobalNodes.some((primary) => primary.id === node.id));
  primaryGlobalNodes.forEach((node, index) => {
    positions.set(node.id, { x: -1040 + index * LAYOUT_COLUMN_GAP, y: globalY });
  });
  auxiliaryGlobalNodes.forEach((node, index) => {
    const direction = index % 2 === 0 ? -1 : 1;
    const distance = Math.floor(index / 2) + 1;
    positions.set(node.id, { x: 80, y: globalY + direction * distance * LAYOUT_ROW_GAP });
  });
  orderedShots.forEach(([, shotNodes], row) => {
    const roleCounts = new Map<number, number>();
    shotNodes
      .sort((a, b) => getStoryboardRole(a, reserveEndFrameColumn) - getStoryboardRole(b, reserveEndFrameColumn))
      .forEach((node) => {
        const role = getStoryboardRole(node, reserveEndFrameColumn);
        const duplicateOffset = roleCounts.get(role) || 0;
        roleCounts.set(role, duplicateOffset + 1);
        positions.set(node.id, {
          x: shotStartX + role * LAYOUT_COLUMN_GAP,
          y: 80 + row * LAYOUT_ROW_GAP + duplicateOffset * 72,
        });
      });
  });

  const laidOut = nodes.map((node) => ({ ...node, position: positions.get(node.id) || node.position }));
  const middleShotNumber = orderedShots[Math.floor(orderedShots.length / 2)]?.[0];
  const previewIds = new Set([
    ...globalNodes.map((node) => node.id),
    ...(middleShotNumber === undefined ? [] : groups.get(middleShotNumber) || []).map((node) => node.id),
  ]);
  return {
    nodes: laidOut,
    previewNodes: laidOut.filter((node) => previewIds.has(node.id)),
  };
}

function isLegacyGridLayout(nodes: WorkflowFlowNode[]) {
  if (nodes.length < 6) return false;
  const matchesColumns = (columns: number) => {
    const matched = nodes.filter((node, index) => {
      const expectedX = 220 + (index % columns) * 520;
      const expectedY = 120 + Math.floor(index / columns) * 430;
      return Math.abs(node.position.x - expectedX) <= 2 && Math.abs(node.position.y - expectedY) <= 2;
    }).length;
    return matched >= Math.ceil(nodes.length * 0.8);
  };
  return matchesColumns(1) || matchesColumns(3);
}

type CanvasSession = {
  id: string;
  name: string;
  sourceReferenceId?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  viewport: CanvasViewport;
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  storyboardSettings?: CanvasStoryboardSettings;
};

export type ManualCanvasDraftSnapshot = {
  schemaVersion: 1;
  referenceId: string;
  session: CanvasSession;
};

type CanvasViewport = { x: number; y: number; zoom: number };
type CanvasPersistenceState = "loading" | "saved" | "saving" | "blocked" | "failed";
type AgentCanvasHandoffState =
  | { status: "hidden" }
  | { status: "ready"; handoff: AgentWorkbenchHandoffEnvelope; plan: StoryboardCanvasImportPlan }
  | { status: "error"; error: string }
  | { status: "imported"; handoff: AgentWorkbenchHandoffEnvelope; plan: StoryboardCanvasImportPlan };
type CanvasServerDocument = {
  schemaVersion: 1;
  session: Omit<CanvasSession, "revision">;
  viewport: CanvasViewport;
  runHistory: CanvasRunRecord[];
  diagnostics: GenerationDiagnosticEntry[];
};

type CanvasServerRecord = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  document: CanvasServerDocument;
};

type CanvasStoryboardSettings = {
  productionModeId: ProductionModeId;
  directorMode: StoryboardDirectorMode;
  targetDurationSeconds: FreeCanvasStoryTargetDuration;
  animationStyleId: AnimationStyleId;
  aspectRatio: AspectRatio;
  referenceTextMode?: StoryboardReferenceTextMode;
};

type CanvasRunEvent = {
  nodeId: string;
  title: string;
  kind: WorkflowNodeKind;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  modelId?: string;
  outputUrl?: string;
  error?: string;
};

type CanvasRunRecord = {
  id: string;
  canvasId: string;
  canvasName: string;
  recordType?: "generation" | "test-snapshot";
  status: "draft" | "running" | "completed" | "partial" | "failed";
  sourceScript: string;
  styleGuide: string;
  aspectRatio: AspectRatio;
  promptPreset: string;
  imageModelId: string;
  videoModelId: string;
  compiler?: "ai" | "deterministic-fallback";
  storyboardSettings?: CanvasStoryboardSettings;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  events: CanvasRunEvent[];
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  error?: string;
};

function snapshotRunNodes(nodes: WorkflowFlowNode[]) {
  return nodes.map((node) => ({
    ...node,
    data: { ...node.data, history: node.data.history.slice(0, 4) },
  }));
}

type FreeNodeContextValue = {
  imageModels: CoverModel[];
  videoModels: VideoModel[];
  voiceOptions: CanvasVoiceOption[];
  voicePricing: CanvasVoicePricing[];
  uploadBusy: boolean;
  selectedNodeId: string | null;
  updateNode: (id: string, patch: Partial<WorkflowNodeData>) => void;
  selectImageCandidate: (id: string, candidateId: string, outputUrl: string) => void;
  setVideoMode: (id: string, mode: "first-frame" | "multimodal") => void;
  runNode: (id: string, options?: NodeExecutionOptions) => void;
  regenerateNode: (id: string) => void;
  previewAsset: (id: string) => void;
  downloadAsset: (id: string) => void;
  deleteNode: (id: string) => void;
  uploadNode: (id: string, file: File) => void;
  inputSummary: (id: string) => { texts: number; images: number; imageConnections: number; audios: number; audioConnections: number; gridImages: number; unverifiedReferences: number };
};

type GenerationStage = "images" | "videos" | "all";
type NodeExecutionOptions = {
  ignoreGenerationBlock?: boolean;
  trigger?: "manual" | "batch";
  forceVideoResubmit?: boolean;
  persistenceCheckpointConfirmed?: boolean;
};
type BatchControlState = "idle" | "running" | "paused" | "stopping";
type ProPanelTab = "setup" | "history" | "quality";
type WorkStatus = {
  state: "running" | "paused" | "stopping" | "downloading";
  title: string;
  detail: string;
  elapsed?: number;
};
type CanvasVideoSubmission = {
  task_id?: string;
  content_url?: string;
  status?: string;
  video_url?: string;
  model_name?: string;
  price?: number;
  priceCharged?: number;
  cashCharged?: number;
  cashRemaining?: number | null;
};
type RecoverableCanvasVideoTask = {
  id?: string;
  modelId?: string;
  taskIdExternal?: string;
  contentUrl?: string;
  taskLabel?: string;
  firstFrameUrl?: string;
  status?: string;
  videoUrl?: string;
  createdAt?: string;
  completedAt?: string;
  priceCharged?: number;
  batchTopic?: string;
  cardIndex?: number;
};
type CanvasVideoPollResult = {
  videoUrl: string;
  priceCharged: number;
};

// VIDEO_MEDIA_UNAVAILABLE_CONSUMER_BEGIN
function videoMediaUnavailablePatch(data: {
  status?: string; mediaAvailable?: boolean; mediaUnavailableReason?: string;
  processingStage?: string; errorMessage?: string; priceCharged?: number;
}, taskId: string): Partial<WorkflowNodeData> | null {
  const unavailable = getVideoMediaUnavailable(data);
  if (!unavailable) return null;
  const message = unavailable.message;
  const charged = Number(data.priceCharged);
  return {
    status: "failed", outputUrl: "", taskId,
    error: message, progressMessage: undefined,
    playbackStatus: "failed", playbackError: message,
    generationBlockedReason: message,
    ...(Number.isFinite(charged) ? { actualCost: Math.max(0, charged) } : {}),
    billingReferenceId: `video:${taskId}`,
    completedAt: new Date().toISOString(),
  };
}
// VIDEO_MEDIA_UNAVAILABLE_CONSUMER_END
const IMAGE_BATCH_SUBMIT_INTERVAL_MS = 5_000;
const IMAGE_BATCH_MAX_IN_FLIGHT = 3;
const IMAGE_GENERATE_MAX_ATTEMPTS = 3;
const VIDEO_BATCH_SUBMIT_INTERVAL_MS = 8_000;
const VIDEO_BATCH_MAX_IN_FLIGHT = 3;
const VIDEO_SUBMIT_MAX_ATTEMPTS = 4;
const VIDEO_POLL_INTERVAL_MS = 6_000;
const VIDEO_POLL_REQUEST_INTERVAL_MS = 750;
const VIDEO_POLL_SESSION_LIMIT_MS = 6 * 60_000;
const VIDEO_PREVIEW_VALIDATION_TIMEOUT_MS = 20_000;

function normalizeHistoryTimestamp(value?: string) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

class BatchQueueStoppedError extends Error {
  constructor() {
    super("批量队列已终止");
    this.name = "BatchQueueStoppedError";
  }
}

class VideoPollingDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoPollingDeferredError";
  }
}

function isDirectorQualityAdvisory(reason?: string) {
  return Boolean(reason && /AI导演方案未通过生产质检|基础规则预览|基础预览/u.test(reason));
}

type GenerationDiagnosticEntry = {
  id: string;
  canvasId: string;
  nodeId: string;
  title: string;
  kind: WorkflowNodeKind;
  modelId?: string;
  trigger?: "manual" | "batch";
  phase: "image-generate" | "image-persist" | "video-submit" | "video-poll" | "video-preview" | "node-total";
  status: "succeeded" | "failed";
  startedAt: string;
  durationMs: number;
  detail?: string;
};

const FreeNodeContext = createContext<FreeNodeContextValue | null>(null);

type ManualCanvasProps = {
  storyboards: StoryboardCard[];
  assets: StudioAsset[];
  imageModels: CoverModel[];
  videoModels: VideoModel[];
  voiceOptions: CanvasVoiceOption[];
  voicePricing: CanvasVoicePricing[];
  defaultImageModelId: string;
  defaultVideoModelId: string;
  defaultAspectRatio: AspectRatio;
  initialReference?: InspirationCanvasHandoff | null;
  initialDraft?: ManualCanvasDraftSnapshot | null;
  preferredReferenceId?: string;
  storageScope: CanvasStorageScope;
  onNotice: (message: string | null) => void;
  onRequireLogin: () => void;
  onBalanceRefresh: () => void;
  onLocalDraftChange?: (draft: ManualCanvasDraftSnapshot) => void;
  onReferencePersisted?: (referenceId: string) => void;
};

const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
  upload: "可选上传",
};

function isAudioUpload(data: Pick<WorkflowNodeData, "kind" | "sourceMediaKind">) {
  return data.kind === "upload" && (data.sourceMediaKind === "audio" || data.sourceMediaKind === "music");
}

function canvasVoiceModelId(voice?: CanvasVoiceOption) {
  if (!voice) return "seed-tts-2.0";
  return voice.engine === "volcano" && (/^(?:ICL_|S_)/u.test(voice.speakerId))
    ? "seed-icl-2.0"
    : "seed-tts-2.0";
}

function canvasAudioPricing(
  mode: WorkflowNodeData["audioMode"],
  voiceId: string | undefined,
  voices: CanvasVoiceOption[],
  pricing: CanvasVoicePricing[],
) {
  const modelId = mode === "seed-audio"
    ? "seed-audio-1.0"
    : canvasVoiceModelId(voices.find((voice) => voice.id === voiceId));
  return pricing.find((item) => item.modelId === modelId && item.sellPrice > 0);
}

function stableCanvasMediaIdentity(url: string, runtimeNodes: WorkflowFlowNode[]) {
  for (const node of runtimeNodes) {
    if (node.data.outputUrl === url && node.data.assetId) return `asset:${node.data.assetId}`;
    const history = node.data.history.find((item) => item.outputUrl === url && item.assetId);
    if (history?.assetId) return `asset:${history.assetId}`;
  }
  if (url.startsWith("/")) return `app-public:${url}`;
  return "temporary-media-without-owned-asset";
}

function visibleKindLabel(data: Pick<WorkflowNodeData, "kind" | "sourceMediaKind">) {
  if (data.kind === "upload" && data.sourceMediaKind === "audio") return "音频";
  if (data.kind === "upload" && data.sourceMediaKind === "music") return "音乐";
  return KIND_LABEL[data.kind];
}

const STATUS_LABEL: Record<WorkflowNodeData["status"], string> = {
  idle: "未开始",
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
};

function KindIcon({ kind, size = 15 }: { kind: WorkflowNodeKind; size?: number }) {
  if (kind === "text") return <FileText size={size} />;
  if (kind === "image") return <ImageIcon size={size} />;
  if (kind === "video") return <Video size={size} />;
  return <Upload size={size} />;
}

function WorkflowNode({ id, data }: NodeProps<WorkflowFlowNode>) {
  const context = useContext(FreeNodeContext);
  if (!context) return null;
  const isSelected = context.selectedNodeId === id;
  const inputs = context.inputSummary(id);
  const isBusy = data.status === "running" || data.status === "queued";
  const audioUpload = isAudioUpload(data);
  const audioMode = audioUpload ? data.audioMode || "upload" : "upload";
  const selectedVoice = audioUpload ? context.voiceOptions.find((voice) => voice.id === data.voiceId) : undefined;
  const selectedAudioPricing = audioUpload && audioMode !== "upload"
    ? canvasAudioPricing(audioMode, data.voiceId, context.voiceOptions, context.voicePricing)
    : undefined;
  const mediaStatusLabel = data.status === "running" && data.playbackStatus === "validating"
    ? "检查预览"
    : STATUS_LABEL[data.status];
  const usesUpstreamPrompt = (data.kind === "image" || data.kind === "video") && data.prompt.trim() === "{{input.text}}";
  const generationBlocked = Boolean(data.generationBlockedReason && !isDirectorQualityAdvisory(data.generationBlockedReason));
  const directorQualityAdvisory = isDirectorQualityAdvisory(data.generationBlockedReason)
    ? data.generationBlockedReason
    : "";
  const selectedImageModel = data.kind === "image" ? context.imageModels.find((model) => model.id === data.modelId) : undefined;
  const selectedImageCapabilities = getImageModelCapabilities(selectedImageModel);
  const imageResolutionOptions = selectedImageCapabilities.resolutionOptions;
  const selectedImageResolution = coerceImageResolution(selectedImageModel, data.resolution);
  const selectedVideoModel = data.kind === "video" ? context.videoModels.find((model) => model.id === data.modelId) : undefined;
  const imageAdmissionIssue = data.kind === "image" ? canvasModelAdmissionIssue(selectedImageModel, "image") : "";
  const videoAdmissionIssue = data.kind === "video" ? canvasModelAdmissionIssue(selectedVideoModel, "video") : "";
  const videoAudioReferenceLimits = getVideoAudioReferenceLimits(selectedVideoModel);
  const videoTiming = data.kind === "video" ? resolveVideoDuration(selectedVideoModel, data.durationSeconds) : null;
  const videoExactTimingMismatch = data.kind === "video"
    && Boolean(data.requiresExactDuration)
    && Boolean(selectedVideoModel)
    && (
      !selectedVideoModel!.supportsImageInput
      || !videoTiming?.supported
    );
  const nativeTargetOptions = getVideoTargetDurationOptions(selectedVideoModel);
  const videoDurationOptions = nativeTargetOptions.includes(data.durationSeconds)
    ? nativeTargetOptions
    : [data.durationSeconds, ...nativeTargetOptions].sort((a, b) => a - b);
  const videoRatioUnsupported = data.kind === "video" && data.aspectRatio !== "16:9" && data.aspectRatio !== "9:16";
  const imageNeedsReference = data.kind === "image" && (data.imageMode === "image-to-image" || data.imageMode === "edit");
  const imageModelNeedsReferenceInput = data.kind === "image" && (imageNeedsReference || inputs.images > 0);
  const imageReferenceBlocked = imageModelNeedsReferenceInput
    && Boolean(selectedImageModel)
    && !selectedImageCapabilities.supportsReferenceInput;
  const imageReferenceLimitExceeded = data.kind === "image"
    && inputs.images > selectedImageCapabilities.maxReferenceImages;
  const imageReferenceMissing = imageNeedsReference && inputs.images === 0 && !data.outputUrl;
  const videoNeedsImage = data.kind === "video" && Boolean(selectedVideoModel?.requiresImage);
  const videoReferenceMissing = videoNeedsImage && inputs.images === 0;
  const videoReferenceUnsupported = data.kind === "video"
    && inputs.images > 0
    && Boolean(selectedVideoModel)
    && !selectedVideoModel?.supportsImageInput;
  const videoModelNeedsImageInput = data.kind === "video" && (inputs.imageConnections > 0 || data.videoMode === "multimodal");
  const videoFirstLastMissing = data.kind === "video" && data.videoMode === "multimodal" && inputs.images < 2;
  const videoHasGridInput = data.kind === "video" && inputs.gridImages > 0;
  const videoHasUnverifiedReference = data.kind === "video" && inputs.unverifiedReferences > 0;
  const videoAudioUnsupported = data.kind === "video"
    && inputs.audios > 0
    && Boolean(selectedVideoModel)
    && !selectedVideoModel?.supportsAudioInput;
  const videoAudioLimitExceeded = data.kind === "video"
    && inputs.audios > videoAudioReferenceLimits.max;
  const videoAudioMinimumMissing = data.kind === "video"
    && inputs.audios < videoAudioReferenceLimits.min;
  const imageResumeAvailable = data.kind === "image"
    && (Boolean(data.pendingPersistUrl) || (Boolean(data.imageClientTraceId) && Boolean(data.imageClientIdempotencyKey)));
  const videoAmbiguousSubmission = data.kind === "video"
    && data.status === "failed"
    && !data.outputUrl
    && !data.taskId
    && Boolean(data.clientRequestId);
  const imageCandidates = data.kind === "image"
    ? data.history.filter((item) => item.imagePreviewUrl || item.outputUrl).slice(0, 4)
    : [];
  const hasGeneratedMediaOutput = Boolean(data.outputUrl)
    || (data.kind === "image" && imageCandidates.length > 0)
    || (data.kind === "video" && Boolean(data.taskId));
  const canChangeMediaModel = (data.kind === "image" || data.kind === "video")
    && (!data.modelLocked || (!isBusy && !hasGeneratedMediaOutput && data.status !== "succeeded"));
  const candidateSubjectLabel = data.characterName ? `${data.characterName}定妆图` : "角色或风格锚点";
  const candidateSelectionPending = data.kind === "image"
    && Boolean(data.candidateSelectionRequired)
    && !data.selectedCandidateId;
  const showReferenceRow = data.kind === "video"
    || (data.kind === "image" && (data.imageMode === "image-to-image" || data.imageMode === "edit"));
  const videoSubmitBlocked = data.kind === "video" && Boolean(
    videoAdmissionIssue || videoRatioUnsupported
    || !videoTiming?.supported
    || videoExactTimingMismatch
    || videoReferenceMissing
    || videoReferenceUnsupported
    || videoFirstLastMissing
    || videoHasUnverifiedReference
    || videoAudioUnsupported
    || videoAudioMinimumMissing
    || videoAudioLimitExceeded,
  );
  const tabs = data.kind === "image"
    ? [
        { label: "文生图", active: data.imageMode === "text-to-image", action: () => context.updateNode(id, { imageMode: "text-to-image", imageCount: 1 }) },
        { label: "图生图", active: data.imageMode === "image-to-image", action: () => context.updateNode(id, { imageMode: "image-to-image", imageCount: 1 }) },
        { label: "四宫格探索", active: data.imageMode === "grid", action: () => context.updateNode(id, { imageMode: "grid", imageCount: 4 }) },
        { label: "局部编辑", active: data.imageMode === "edit", action: () => context.updateNode(id, { imageMode: "edit", imageCount: 1 }) },
      ]
    : data.kind === "video"
      ? [
          { label: "首帧", active: data.videoMode === "first-frame", action: () => context.setVideoMode(id, "first-frame") },
          { label: "首尾帧", active: data.videoMode === "multimodal", action: () => context.setVideoMode(id, "multimodal") },
        ]
      : audioUpload
        ? [
            {
              label: "上传",
              active: audioMode === "upload",
              action: () => context.updateNode(id, {
                audioMode: "upload",
                status: "idle",
                error: undefined,
              }),
            },
            ...(data.sourceMediaKind === "music"
              ? [{
                  label: "AI 音频",
                  active: audioMode === "seed-audio",
                  action: () => {
                    const pricing = canvasAudioPricing("seed-audio", undefined, context.voiceOptions, context.voicePricing);
                    context.updateNode(id, {
                      audioMode: "seed-audio",
                      modelId: pricing?.modelId || "seed-audio-1.0",
                      publicModelName: pricing?.name,
                      estimatedCost: pricing?.sellPrice,
                      status: "idle",
                      error: undefined,
                    });
                  },
                }]
              : [{
                  label: "文字转语音",
                  active: audioMode === "tts",
                  action: () => {
                    const voice = selectedVoice || context.voiceOptions[0];
                    const pricing = canvasAudioPricing("tts", voice?.id, context.voiceOptions, context.voicePricing);
                    context.updateNode(id, {
                      audioMode: "tts",
                      voiceId: voice?.id,
                      modelId: pricing?.modelId || canvasVoiceModelId(voice),
                      publicModelName: pricing?.name,
                      estimatedCost: pricing?.sellPrice,
                      status: "idle",
                      error: undefined,
                    });
                  },
                }]),
          ]
        : [{ label: "编辑", active: true, action: () => undefined }];

  return (
    <div
      className={`free-node-shell kind-${data.kind} ${isSelected ? "selected" : ""}`}
      data-aspect-ratio={data.aspectRatio}
    >
      <Handle type="target" position={Position.Left} className="workflow-handle" />
      <NodeToolbar isVisible={isSelected} position={Position.Top} offset={10} className="free-node-modebar">
        {tabs.map((tab) => (
          <button type="button" className={tab.active ? "active" : ""} key={tab.label} onClick={tab.action}>{tab.label}</button>
        ))}
        <button type="button" className="delete" title="删除节点" onClick={() => context.deleteNode(id)}><Trash2 size={15} /></button>
      </NodeToolbar>

      <article className="workflow-node">
        <div className="workflow-node-head">
          <span className="workflow-kind"><span>{visibleKindLabel(data)}</span><strong>{data.title}</strong></span>
          <span className="workflow-node-head-actions">
            {(data.kind === "image" || data.kind === "video" || audioUpload) && (
              <span className={`workflow-status ${data.status}`}><i aria-hidden="true" />{mediaStatusLabel}</span>
            )}
            <span className="workflow-history"><History size={14} />历史{data.history.length > 0 ? ` ${data.history.length}` : ""}</span>
          </span>
        </div>
        <div className="workflow-node-preview">
          {data.kind === "image" && data.candidateSelectionRequired && imageCandidates.length > 0 ? (
            <div
              className={`free-node-preview-candidates nodrag nowheel ${imageCandidates.length === 1 ? "single" : "multiple"}`}
              role="group"
              aria-label={`选择${candidateSubjectLabel}`}
            >
              {imageCandidates.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  className={data.selectedCandidateId === item.id ? "active" : ""}
                  title={`选择候选 ${index + 1}`}
                  aria-label={`选择${candidateSubjectLabel}候选 ${index + 1}`}
                  aria-pressed={data.selectedCandidateId === item.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    context.selectImageCandidate(id, item.id, item.imagePreviewUrl || item.outputUrl || "");
                  }}
                >
                  <Image src={item.imagePreviewUrl || item.outputUrl || ""} alt={`${candidateSubjectLabel}候选 ${index + 1}`} fill unoptimized sizes="250px" />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
          ) : (data.imagePreviewUrl || data.outputUrl) && data.kind === "image" && data.status !== "failed" ? (
            <Image src={data.imagePreviewUrl || data.outputUrl} alt={data.title} fill unoptimized sizes="440px" />
          ) : data.kind === "image" && data.status === "failed" ? (
            <div className="free-video-preview-error nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <AlertCircle size={28} />
              <strong>图片生成失败</strong>
              <span>{data.error || "本次图片任务没有返回可用结果；可切换卡片模型后重试。"}</span>
              <div>
                <button
                  type="button"
                  title={data.pendingPersistUrl
                    ? "只重试永久保存，不会重新生成或扣费"
                    : imageResumeAvailable
                      ? "使用原幂等键恢复图片任务；仅显式重新生成才会创建新任务"
                      : "创建新任务，可能再次计费"}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (imageResumeAvailable) context.runNode(id, { ignoreGenerationBlock: true, trigger: "manual" });
                    else context.regenerateNode(id);
                  }}
                >
                  {imageResumeAvailable ? <RefreshCw size={14} /> : <RotateCcw size={14} />}
                  {data.pendingPersistUrl ? "重试保存" : imageResumeAvailable ? "恢复任务" : "重新生成"}
                </button>
              </div>
            </div>
          ) : data.outputUrl && data.kind === "video" && data.playbackStatus === "failed" ? (
            <div className="free-video-preview-error nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <AlertCircle size={28} />
              <strong>模型已完成，但交付文件不可用</strong>
              <span>{data.playbackError || "浏览器暂时无法读取该视频"}</span>
              <div>
                <button type="button" title="只检查现有任务，不会重新提交或扣费" onClick={(event) => { event.stopPropagation(); context.runNode(id); }}>
                  <RefreshCw size={14} />重新检查
                </button>
                <button type="button" onClick={(event) => { event.stopPropagation(); context.downloadAsset(id); }}>
                  <Download size={14} />下载源文件
                </button>
                <button type="button" className="danger" title="创建新任务，可能再次计费" onClick={(event) => { event.stopPropagation(); context.regenerateNode(id); }}>
                  <RotateCcw size={14} />重新生成
                </button>
              </div>
            </div>
          ) : data.outputUrl && data.kind === "video" ? (
            <video
              src={videoPlaybackSrc(data.outputUrl)}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration) && duration > 0) {
                  context.updateNode(id, { playbackStatus: "ready", playbackError: undefined });
                }
              }}
              onError={(event) => {
                const code = event.currentTarget.error?.code;
                context.updateNode(id, {
                  status: "failed",
                  playbackStatus: "failed",
                  playbackError: code ? `播放器读取失败（媒体错误 ${code}），请先重新检查视频源` : "播放器无法读取该视频，请先重新检查视频源",
                  error: "视频生成任务已完成，但交付文件尚不可用",
                });
              }}
            />
          ) : data.kind === "video" && data.status === "failed" ? (
            <div className="free-video-preview-error nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <AlertCircle size={28} />
              <strong>{data.taskId ? "视频任务未完成" : "视频生成失败"}</strong>
              <span>{data.error || "本次任务没有得到可用视频"}</span>
              <div>
                {data.taskId && (
                  <button type="button" title="继续查询原任务，不会重复提交或扣费" onClick={(event) => { event.stopPropagation(); context.runNode(id); }}>
                    <RefreshCw size={14} />继续查询
                  </button>
                )}
                <button type="button" className="danger" title="创建新任务，可能再次计费" onClick={(event) => { event.stopPropagation(); context.regenerateNode(id); }}>
                  <RotateCcw size={14} />重新生成
                </button>
              </div>
            </div>
          ) : data.kind === "image" ? (
            <div className="free-text-preview free-image-prompt-preview">
              <span>{usesUpstreamPrompt ? "图片生成节点" : "生图提示词"}</span>
              <p>{usesUpstreamPrompt ? "读取前置节点的生图提示词，生成本镜头关键帧图片。" : data.prompt || "尚未生成生图提示词"}</p>
            </div>
          ) : data.kind === "text" ? (
            <div className="free-text-preview"><span>{data.title.includes("生图提示词") ? "生图提示词 · 由本镜头视频提示词反推" : data.title.includes("视频提示词") ? "视频提示词 · 含环境音与动作音" : "预览"}</span><p>{data.outputText || data.prompt || "暂无正文。请使用下方提示词生成；点击预览区可编辑。"}</p></div>
          ) : data.kind === "upload" && audioUpload && data.status === "failed" && audioMode !== "upload" ? (
            <div className="free-video-preview-error nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              <AlertCircle size={28} />
              <strong>{data.sourceMediaKind === "music" ? "AI 音频生成失败" : "语音生成失败"}</strong>
              <span>{data.error || "主站模型没有返回可持久化音频；本次未创建假资产。"}</span>
              <div>
                <button type="button" title="使用原幂等键重试，不会重复扣费" onClick={(event) => { event.stopPropagation(); context.runNode(id); }}>
                  <RefreshCw size={14} />安全重试
                </button>
                <button type="button" className="danger" title="创建新任务，可能再次计费" onClick={(event) => { event.stopPropagation(); context.regenerateNode(id); }}>
                  <RotateCcw size={14} />重新生成
                </button>
              </div>
            </div>
          ) : data.kind === "upload" && audioUpload && data.outputUrl ? (
            <div className="free-upload-audio nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              {data.sourceMediaKind === "music" ? <Music2 size={24} /> : <AudioLines size={24} />}
              <strong>{data.sourceMediaKind === "music" ? "音乐素材已就绪" : "音频素材已就绪"}</strong>
              <audio src={data.outputUrl} controls preload="metadata" />
              <button type="button" onClick={(event) => { event.stopPropagation(); context.downloadAsset(id); }}><Download size={14} />下载素材</button>
            </div>
          ) : data.kind === "upload" ? (
            <div><Upload size={28} /><strong>{data.outputUrl ? "已有图片已就绪" : audioUpload ? "选择音频素材" : "选择已有图片（可选）"}</strong><span>{audioUpload ? "保留示例中的音频 / 音乐语义，可试听、替换和下载" : "仅手动增强或产品保真时使用"}</span></div>
          ) : (
            <div><KindIcon kind={data.kind} size={28} /><strong>{STATUS_LABEL[data.status]}</strong><span>{data.error || "选中节点以进行生成"}</span></div>
          )}
          {(data.imagePreviewUrl || data.outputUrl) && (data.kind === "image" || data.kind === "video") && (
            <div className="free-node-result-actions nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
              {data.kind === "image" && data.assetRole === "storyboard-keyframe" && (
                <>
                  <button
                    type="button"
                    className={data.referenceValidationStatus === "verified" ? "active" : ""}
                    title="确认参考图可用，允许关联视频进入提交队列"
                    aria-label={`确认${data.title}参考图可用`}
                    onClick={(event) => { event.stopPropagation(); context.updateNode(id, { referenceValidationStatus: "verified" }); }}
                  >
                    <Check size={15} />
                  </button>
                  <button
                    type="button"
                    className={data.referenceValidationStatus === "rejected" ? "danger" : ""}
                    title="标记参考图不通过，关联视频保持关闭"
                    aria-label={`标记${data.title}参考图不可用`}
                    onClick={(event) => { event.stopPropagation(); context.updateNode(id, { referenceValidationStatus: "rejected" }); }}
                  >
                    <X size={15} />
                  </button>
                </>
              )}
              {!(data.kind === "video" && data.playbackStatus === "failed") && (
                <button type="button" title="大图预览" aria-label={`预览${data.title}`} onClick={(event) => { event.stopPropagation(); context.previewAsset(id); }}>
                  <Eye size={15} />
                </button>
              )}
              <button type="button" title="下载结果" aria-label={`下载${data.title}`} onClick={(event) => { event.stopPropagation(); context.downloadAsset(id); }}>
                <Download size={15} />
              </button>
            </div>
          )}
          {isBusy && <div className="free-preview-busy"><LoaderCircle size={24} className="spin" /><span>{data.progressMessage || STATUS_LABEL[data.status]}</span></div>}
        </div>
      </article>

      {isSelected && (
        <section className="free-node-compose nodrag nowheel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="free-compose-mobile-modes">
            {tabs.map((tab) => (
              <button type="button" className={tab.active ? "active" : ""} key={tab.label} onClick={tab.action}>{tab.label}</button>
            ))}
            <button type="button" className="delete" title="删除节点" onClick={() => context.deleteNode(id)}><Trash2 size={15} /></button>
          </div>
          {showReferenceRow && (
            <div className="free-reference-row">
              <strong>{data.kind === "image" ? "可选图像输入" : "前置关键帧"}</strong>
              <span>{data.kind === "image"
                ? inputs.images > 0
                  ? `已接入 ${inputs.images} 张图像`
                  : inputs.imageConnections > 0
                    ? `已连接 ${inputs.imageConnections} 个前置图像节点，等待生成或选定`
                    : "仅在你主动使用图生图或局部编辑时需要"
                : inputs.images > 0
                  ? `已接入 ${inputs.images} 张自动关键帧`
                  : inputs.imageConnections > 0
                    ? `已连接 ${inputs.imageConnections} 个关键帧节点，批量运行会先自动生图`
                    : "手动视频节点尚未连接关键帧"}</span>
            </div>
          )}

          {data.visualOrder && (
            <div className="free-protocol-note">
              <strong>成片节拍</strong>
              <span>分镜 {String(data.visualOrder).padStart(2, "0")} · 文案 {data.semanticOrder || "-"} · {data.timelineDurationSeconds || data.durationSeconds} 秒{data.shotRole ? ` · ${data.shotRole}` : ""}{data.transition ? ` · ${data.transition}` : ""}</span>
            </div>
          )}

          {(data.kind === "image" || data.kind === "video") && (
            <div className={`free-protocol-note ${(generationBlocked || videoSubmitBlocked || imageReferenceBlocked || imageReferenceLimitExceeded || imageReferenceMissing || (candidateSelectionPending && imageCandidates.length > 0)) ? "warn" : ""}`}>
              {data.kind === "image" ? (
                <>
                  <strong>图片协议</strong>
                  <span>{data.candidateSelectionRequired
                    ? data.selectedCandidateId
                      ? `已确认${candidateSubjectLabel}；后续镜头只继承身份和固定造型，不照搬定妆背景与姿态`
                      : imageCandidates.length > 0
                        ? `${imageCandidates.length} 张${candidateSubjectLabel}已生成，请确认后再生成关联镜头`
                        : `将先生成${data.imageCount > 1 ? `${data.imageCount} 张候选` : "1 张"}${candidateSubjectLabel}，确认后才会进入关联镜头`
                    : data.imageMode === "grid"
                    ? data.selectedCandidateId
                      ? "已选定一张角色 / 风格锚点；后续只传这张单图，不传四宫格合成图"
                      : imageCandidates.length > 0
                        ? "4 张候选已生成，请在下方选定一张后再继续"
                        : "将生成 4 张独立候选；生成后必须选定一张，四宫格合成图不直接作为视频首帧"
                    : data.imageMode === "text-to-image"
                      ? "系统根据本镜视频方案自动生成关键帧，无需上传任何图片"
                      : selectedImageCapabilities.supportsReferenceInput
                        ? `你已主动选择图像输入模式；当前模型能力：${selectedImageCapabilities.referenceCapabilityLabel}`
                        : "当前模型不支持图像输入，只适合文本生图"}</span>
                  {imageReferenceMissing && <span>当前是手动图生图/编辑模式，请连接已有图片；自动关键帧请切回文生图</span>}
                  {imageReferenceBlocked && <span>当前节点已接入已有图像，需要换成支持图像输入的图片模型</span>}
                  {imageReferenceLimitExceeded && <span>当前接入 {inputs.images} 张参考图，超过该模型上限 {selectedImageCapabilities.maxReferenceImages} 张</span>}
                  {data.modelLocked && !canChangeMediaModel && <span>本轮生成已开始，模型已锁定为 {selectedImageModel?.name || data.lockedModelId}</span>}
                  {data.assetRole === "storyboard-keyframe" && data.outputUrl && (
                    <span>{data.referenceValidationStatus === "verified"
                      ? "参考图已确认可用，可以继续生成关联视频"
                      : data.referenceValidationStatus === "rejected"
                        ? "参考图已标记不可用，请修改提示词或重新生成后再次确认"
                        : "参考图已完成但尚未确认，请点击预览区的 ✓ 后再生成视频"}</span>
                  )}
                </>
              ) : (
                <>
                  <strong>视频协议</strong>
                  <span>{selectedVideoModel?.requiresImage ? "当前模型由前置关键帧驱动，无需用户上传" : selectedVideoModel?.supportsImageInput ? "当前模型支持自动关键帧驱动" : "当前模型只能按文字生成视频"}</span>
                  <span>{videoTiming?.supported
                    ? videoExactTimingMismatch
                      ? "当前剧情镜头需要支持关键帧输入的模型"
                      : `原生时长 ${videoTiming.target}s`
                    : `目标 ${videoTiming?.target}s，当前模型最多 ${videoTiming?.maxDuration}s，请缩短镜头或切换模型`}</span>
                  {videoHasGridInput && <span>已接入从探索候选中选定的单张图片；未选定的候选不会传给视频模型</span>}
                  {inputs.audioConnections > 0 && <span>已连接 {inputs.audioConnections} 个音频 / 音乐节点，其中 {inputs.audios} 个已有可用素材；生成时按连线顺序提交</span>}
                  {videoAudioUnsupported && <span>当前视频模型不支持音频输入，请移除音频连线或切换支持音频的视频模型</span>}
                  {videoAudioMinimumMissing && <span>当前视频模型至少需要 {videoAudioReferenceLimits.min} 条可用音频输入</span>}
                  {videoAudioLimitExceeded && <span>当前接入 {inputs.audios} 条音频，超过模型上限 {videoAudioReferenceLimits.max} 条</span>}
                  {videoReferenceUnsupported && <span>当前视频模型不支持关键帧输入，请切换关键帧驱动的视频模型</span>}
                  {videoReferenceMissing && <span>尚未连接前置关键帧；自动流程会自动创建，手动节点请先连接生图节点</span>}
                  {videoFirstLastMissing && <span>首尾帧模式需要连接两张图片：首帧和尾帧</span>}
                  {videoHasUnverifiedReference && <span>前置参考图尚未确认；完成检查并点击 ✓ 后才能提交视频</span>}
                  {videoRatioUnsupported && <span>当前视频服务只支持 16:9 / 9:16</span>}
                  {data.modelLocked && !canChangeMediaModel && <span>本轮生成已开始，模型已锁定为 {selectedVideoModel?.name || data.lockedModelId}</span>}
                </>
              )}
            </div>
          )}

          {generationBlocked && (
            <div className="free-protocol-note warn">
              <strong>批量生成已暂停</strong>
              <span>{data.generationBlockedReason} 当前卡片仍可手动单张生成用于检查。</span>
            </div>
          )}

          {directorQualityAdvisory && (
            <div className="free-protocol-note warn">
              <strong>导演质量提醒</strong>
              <span>{directorQualityAdvisory} 批量与全部生成已暂停；你仍可编辑当前卡片后单张手动生成。</span>
            </div>
          )}

          {(data.kind === "text" || data.kind === "image" || data.kind === "video") && !usesUpstreamPrompt && (
            <label className="free-compose-prompt">
              <span>{data.kind === "text" ? "正文 / 提示词" : data.kind === "image" ? "生图提示词（由视频提示词反推）" : "视频提示词"}</span>
              <textarea
                value={data.prompt}
                rows={data.kind === "text" ? 5 : 4}
                onChange={(event) => context.updateNode(id, { prompt: event.target.value, ...(data.kind === "text" ? { outputText: event.target.value } : {}), status: "idle", taskId: "", generationBlockedReason: undefined })}
                placeholder={data.kind === "video" ? "描述镜头与动作；连接图片后自动作为首帧" : "描述你想要生成的内容，支持引用前置节点"}
              />
            </label>
          )}

          {usesUpstreamPrompt && (
            <div className="free-protocol-note">
              <strong>Prompt 来源</strong>
              <span>{data.kind === "image" ? "只读取前置“生图提示词”节点；需要修改时请编辑前置文本卡片。" : "只读取前置“视频提示词”节点，并与本镜头关键帧共同提交。"}</span>
            </div>
          )}

          {audioUpload && audioMode !== "upload" && (
            <>
              <label className="free-compose-prompt">
                <span>{audioMode === "seed-audio" ? "AI 音频提示词" : "朗读文案"}</span>
                <textarea
                  value={data.prompt}
                  rows={5}
                  onChange={(event) => context.updateNode(id, { prompt: event.target.value, status: "idle", error: undefined })}
                  placeholder={audioMode === "seed-audio" ? "描述需要生成的音乐、环境音或音效，包括风格、情绪、时长和声音层次" : "输入要由所选主站音色朗读的文案"}
                />
              </label>
              <div className={`free-protocol-note ${selectedAudioPricing ? "" : "warn"}`}>
                <strong>{selectedAudioPricing ? `主站发布模型 · ${selectedAudioPricing.name}` : "音频模型价格未配置"}</strong>
                <span>{selectedAudioPricing
                  ? `售价 ¥${selectedAudioPricing.sellPrice.toFixed(2)}/${selectedAudioPricing.unit}；提交成功后按主站共享钱包实际扣费，失败不建立假资产。`
                  : "当前模式暂不可用，请稍后重试。"}</span>
              </div>
              <div className="free-parameter-row">
                {audioMode === "tts" && (
                  <select
                    aria-label="主站音色"
                    value={data.voiceId || ""}
                    onChange={(event) => {
                      const voice = context.voiceOptions.find((item) => item.id === event.target.value);
                      const pricing = canvasAudioPricing("tts", voice?.id, context.voiceOptions, context.voicePricing);
                      context.updateNode(id, {
                        voiceId: event.target.value,
                        modelId: pricing?.modelId || canvasVoiceModelId(voice),
                        publicModelName: pricing?.name,
                        estimatedCost: pricing?.sellPrice,
                        status: "idle",
                        error: undefined,
                      });
                    }}
                  >
                    {context.voiceOptions.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.category || voice.language}</option>)}
                  </select>
                )}
                <button
                  type="button"
                  title={data.outputUrl ? "保留历史并创建新的音频任务，可能再次计费" : "调用主站音频模型"}
                  onClick={() => data.outputUrl ? context.regenerateNode(id) : context.runNode(id, { trigger: "manual" })}
                  disabled={isBusy || !data.prompt.trim() || !selectedAudioPricing || (audioMode === "tts" && !data.voiceId)}
                >
                  {isBusy ? <LoaderCircle size={15} className="spin" /> : data.outputUrl ? <RotateCcw size={15} /> : <Play size={15} />}
                  {data.outputUrl ? "重新生成" : "生成"}
                </button>
              </div>
            </>
          )}

          {data.kind === "image" && (
            <div className="free-parameter-row">
              <select aria-label="图片生成模型" title={canChangeMediaModel ? "图片生成模型" : "本轮生成已开始，模型不可更换"} disabled={!canChangeMediaModel} value={data.modelId} onChange={(event) => {
                const model = context.imageModels.find((item) => item.id === event.target.value);
                context.updateNode(id, {
                  modelId: event.target.value,
                  resolution: coerceImageResolution(model, data.resolution),
                  status: "idle",
                  taskId: "",
                  modelLocked: false,
                  lockedModelId: "",
                });
              }}>
                {!selectedImageModel && <option value={data.modelId} disabled>已选图片模型暂不可读取，请手动选择</option>}
                {context.imageModels.map((model) => {
                  const capabilities = getImageModelCapabilities(model);
                  const admissionIssue = canvasModelAdmissionIssue(model, "image");
                  const disabled = Boolean(admissionIssue) || imageModelNeedsReferenceInput && !capabilities.supportsReferenceInput;
                  return (
                    <option key={model.id} value={model.id} disabled={disabled}>
                      {model.name} · ¥{Number(model.selling_price ?? 0).toFixed(2)}/张 · {capabilities.referenceCapabilityLabel}{admissionIssue ? ` · ${admissionIssue}` : disabled ? " · 当前不可选" : ""}
                    </option>
                  );
                })}
              </select>
              <select value={data.aspectRatio} onChange={(event) => context.updateNode(id, { aspectRatio: event.target.value as AspectRatio })}>{RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}</select>
              <select aria-label="生成数量" value={data.imageCount} onChange={(event) => context.updateNode(id, { imageCount: Number(event.target.value), imageMode: Number(event.target.value) === 4 ? "grid" : data.imageMode })}><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></select>
              <select aria-label="图片分辨率" title={`${selectedImageModel?.name || "当前模型"} 支持：${imageResolutionOptions.join(" / ")}`} value={selectedImageResolution} onChange={(event) => context.updateNode(id, { resolution: event.target.value })}>
                {imageResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
              </select>
              <button type="button" title={imageAdmissionIssue || (generationBlocked ? "手动单张生成（忽略批量导演质检锁）" : "生成图片")} onClick={() => context.runNode(id, { ignoreGenerationBlock: true, trigger: "manual" })} disabled={isBusy || Boolean(imageAdmissionIssue) || !data.prompt.trim() || imageReferenceBlocked || imageReferenceLimitExceeded || imageReferenceMissing}>{isBusy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}生成</button>
            </div>
          )}

          {data.kind === "video" && (
            <div className="free-parameter-row video">
              <select value={data.modelId} title={canChangeMediaModel ? "视频生成模型" : "本轮生成已开始，模型不可更换"} disabled={!canChangeMediaModel} onChange={(event) => {
                const model = context.videoModels.find((item) => item.id === event.target.value);
                context.updateNode(id, { modelId: event.target.value, durationSeconds: coerceVideoTargetDuration(model, data.durationSeconds), resolution: coerceCanvasVideoResolution(model, data.resolution), status: "idle", taskId: "", modelLocked: false, lockedModelId: "" });
              }}>{!selectedVideoModel && <option value={data.modelId} disabled>已选视频模型暂不可读取，请手动选择</option>}{context.videoModels.map((model) => {
                const modelCharge = resolveVideoCharge(model, data.resolution, coerceVideoTargetDuration(model, data.durationSeconds));
                const exactTimingBlocked = Boolean(data.requiresExactDuration) && !model.supportsImageInput;
                const admissionIssue = canvasModelAdmissionIssue(model, "video");
                const disabled = Boolean(admissionIssue) || (videoModelNeedsImageInput && !model.supportsImageInput) || exactTimingBlocked;
                const modeLabel = model.requiresImage ? "关键帧驱动" : model.supportsImageInput ? "支持关键帧" : "纯文生视频";
                return (
                  <option key={model.id} value={model.id} disabled={disabled}>
                    {model.name} · ¥{modelCharge.publicPrice.toFixed(2)}{modelCharge.billingUnit === "output_second" ? `/${modelCharge.billingQuantity}秒` : "/次"} · {modeLabel}{admissionIssue ? ` · ${admissionIssue}` : exactTimingBlocked ? " · 当前模型不支持参考图" : disabled ? " · 当前不可选" : ""}
                  </option>
                );
              })}</select>
              <select value={data.aspectRatio} onChange={(event) => context.updateNode(id, { aspectRatio: event.target.value as AspectRatio })}>{RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}</select>
              <select aria-label="目标视频时长" value={data.durationSeconds} onChange={(event) => context.updateNode(id, { durationSeconds: Number(event.target.value) })}>
                {videoDurationOptions.map((duration) => {
                  const timing = resolveVideoDuration(selectedVideoModel, duration);
                  return <option key={duration} value={duration} disabled={!timing.supported}>{duration} 秒{!timing.supported ? " · 当前模型不支持" : ""}</option>;
                })}
              </select>
              <select
                value={coerceCanvasVideoResolution(selectedVideoModel, data.resolution)}
                disabled={getCanvasVideoResolutionOptions(selectedVideoModel).length <= 1}
                onChange={(event) => context.updateNode(id, { resolution: event.target.value })}
              >
                {getCanvasVideoResolutionOptions(selectedVideoModel).map((resolution) => <option key={resolution}>{resolution}</option>)}
              </select>
              <button
                type="button"
                title={videoAdmissionIssue || (videoAmbiguousSubmission
                  ? "提交状态不确定；核对媒体历史后显式创建新任务，可能再次计费"
                  : generationBlocked
                    ? "手动单条生成（忽略批量导演质检锁）"
                    : data.status === "succeeded" && data.outputUrl
                      ? "保留历史结果并重新生成视频"
                      : "生成视频")}
                onClick={() => ((data.status === "succeeded" && Boolean(data.outputUrl)) || videoAmbiguousSubmission)
                  ? context.regenerateNode(id)
                  : context.runNode(id, { ignoreGenerationBlock: true, trigger: "manual" })}
                disabled={isBusy || !data.prompt.trim() || videoSubmitBlocked}
              >
                {isBusy
                  ? <LoaderCircle size={15} className="spin" />
                  : (data.status === "succeeded" && data.outputUrl) || videoAmbiguousSubmission
                    ? <RotateCcw size={15} />
                    : data.playbackStatus === "failed"
                      ? <RefreshCw size={15} />
                      : <Play size={15} />}
                {(data.status === "succeeded" && data.outputUrl) || videoAmbiguousSubmission ? "重新生成" : data.playbackStatus === "failed" ? "重新检查" : data.taskId && !data.outputUrl ? "继续查询" : "生成"}
              </button>
            </div>
          )}

          {data.kind === "text" && (
            <div className="free-compose-actions"><button type="button" onClick={() => context.runNode(id)} disabled={!data.prompt.trim()}><Check size={15} />应用正文</button></div>
          )}

          {data.kind === "upload" && (
            <label className="free-upload-button">
              {context.uploadBusy ? <LoaderCircle size={17} className="spin" /> : <Upload size={17} />}
              {audioUpload ? (data.outputUrl ? "替换为上传素材" : "上传本地音频素材") : "选择已有图片"}
              <input type="file" accept={audioUpload ? "audio/mpeg,audio/wav,audio/ogg,audio/aac,audio/webm,audio/flac,.aac" : "image/png,image/jpeg,image/webp"} disabled={context.uploadBusy} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) context.uploadNode(id, file);
                event.target.value = "";
              }} />
            </label>
          )}

          {data.error && <div className="free-node-error"><AlertCircle size={14} />{data.error}</div>}
        </section>
      )}
      <Handle type="source" position={Position.Right} className="workflow-handle" />
    </div>
  );
}

const nodeTypes = { workflow: WorkflowNode };

function asDomainNodes(nodes: WorkflowFlowNode[]): WorkflowNodeRecord[] {
  return nodes.map((node) => ({ id: node.id, type: "workflow", position: node.position, data: node.data }));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanVideoPlaybackUrl(value: string) {
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith("/api/video/")) return value;
    parsed.searchParams.delete("token");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return value;
  }
}

function videoPlaybackSrc(value: string) {
  return cleanVideoPlaybackUrl(value);
}

async function probeVideoSource(url: string, timeoutMs: number) {
  const parsed = new URL(url, window.location.origin);
  if (parsed.origin !== window.location.origin) return;

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.min(timeoutMs, 15_000));
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      headers: { Range: "bytes=0-63" },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      const reason = payload.error ? `：${payload.error}` : "";
      if (response.status === 404) throw new Error(`视频源已失效或文件不存在${reason}`);
      if (response.status === 401 || response.status === 403) throw new Error("视频访问权限已失效");
      throw new Error(`视频源暂不可用${reason}`);
    }
    await response.body?.cancel().catch(() => undefined);
    if (contentType && !contentType.startsWith("video/") && !contentType.includes("octet-stream")) {
      throw new Error(`视频地址返回了非媒体内容（${contentType}）`);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("视频源连接超时，请重新检查；不会重复提交或扣费");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function validateVideoPlayback(url: string, timeoutMs = VIDEO_PREVIEW_VALIDATION_TIMEOUT_MS) {
  await probeVideoSource(url, timeoutMs);
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(video.duration);
      video.removeAttribute("src");
      video.load();
    };
    const onLoadedMetadata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        finish(new Error("视频元数据中没有有效时长"));
        return;
      }
      finish();
    };
    const onError = () => {
      const code = video.error?.code;
      const detail = code ? `媒体错误 ${code}` : "媒体解码失败";
      finish(new Error(detail));
    };
    const timer = window.setTimeout(() => finish(new Error("视频元数据加载超时")), timeoutMs);

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("error", onError);
    video.src = url;
    video.load();
  });
}

async function validateImageAspectRatio(
  url: string,
  expectedRatio: AspectRatio,
  reportedSize?: { width?: number; height?: number },
  timeoutMs = 30_000,
) {
  const [expectedWidth, expectedHeight] = expectedRatio.split(":").map(Number);
  const expected = expectedWidth / expectedHeight;
  const reportedWidth = Number(reportedSize?.width || 0);
  const reportedHeight = Number(reportedSize?.height || 0);
  if (reportedWidth > 0 && reportedHeight > 0) {
    const reported = reportedWidth / reportedHeight;
    const deviation = Math.abs(reported - expected) / expected;
    if (deviation > 0.12) {
      throw new Error(`模型返回 ${reportedWidth}×${reportedHeight}，不符合 ${expectedRatio} 画幅`);
    }
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const image = new window.Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        finish(new Error("图片没有有效尺寸"));
        return;
      }
      const actual = image.naturalWidth / image.naturalHeight;
      const deviation = Math.abs(actual - expected) / expected;
      if (deviation > 0.12) {
        finish(new Error(`模型返回 ${image.naturalWidth}×${image.naturalHeight}，不符合 ${expectedRatio} 画幅`));
        return;
      }
      finish();
    };
    image.onerror = () => finish(new Error("图片结果无法读取"));
    const timer = window.setTimeout(() => finish(new Error("图片尺寸检查超时")), timeoutMs);
    image.src = url;
  });
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function formatHistoryTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return `${date.getMonth() + 1}.${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function assetFilename(node: WorkflowFlowNode, mimeType = "") {
  const shotNumber = getShotNumber(node) ?? node.data.visualOrder ?? 0;
  const prefix = shotNumber > 0 ? `分镜${String(shotNumber).padStart(2, "0")}` : node.data.title.replace(/[\\/:*?"<>|]/g, "_");
  const isVideo = node.data.kind === "video";
  const isAudio = isAudioUpload(node.data);
  const extension = mimeType.includes("webm") ? "webm"
    : mimeType.includes("mpeg") ? "mp3"
      : mimeType.includes("wav") ? "wav"
        : mimeType.includes("ogg") ? "ogg"
          : mimeType.includes("aac") ? "aac"
            : mimeType.includes("flac") ? "flac"
    : mimeType.includes("jpeg") ? "jpg"
      : mimeType.includes("webp") ? "webp"
        : mimeType.includes("png") ? "png"
          : isVideo ? "mp4" : isAudio ? (node.data.sourceMediaKind === "music" ? "m4a" : "mp3") : "png";
  return `${prefix}-${isVideo ? "视频" : isAudio ? (node.data.sourceMediaKind === "music" ? "音乐" : "音频") : "关键帧"}.${extension}`;
}

function taskIdFromPlaybackUrl(value: string) {
  const storageMatch = value.match(/\/api\/video\/storage\/([^?/#]+)/u);
  if (storageMatch) return decodeURIComponent(storageMatch[1]);
  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.pathname === "/api/video/proxy" || parsed.pathname === "/api/video/proxy-download") {
      return parsed.searchParams.get("id") || parsed.searchParams.get("taskId") || "";
    }
  } catch {
    return "";
  }
  return "";
}

function buildStoryboardNarrationManifest(allNodes: WorkflowFlowNode[], videoNodes: WorkflowFlowNode[]) {
  const narrationByOrder = new Map<number, string>();
  allNodes.forEach((node) => {
    if (node.data.kind !== "text" || !node.data.semanticOrder) return;
    if (!/(?:口播文案|口播段|旁白)/u.test(node.data.title)) return;
    const narration = (node.data.outputText || node.data.prompt).replace(/\s+/g, " ").trim();
    if (narration) narrationByOrder.set(node.data.semanticOrder, narration);
  });

  const rows = videoNodes.map((node) => {
    const order = getShotNumber(node) ?? node.data.semanticOrder ?? 0;
    const semanticOrder = node.data.semanticOrder ?? order;
    const duration = node.data.timelineDurationSeconds || node.data.durationSeconds;
    const narration = narrationByOrder.get(semanticOrder) || "（未找到对应口播文案，请回到画布检查连线）";
    return `分镜${String(order).padStart(2, "0")}（${formatDurationLabel(duration)}）：${narration}`;
  });

  return [
    "分镜视频与口播文案对照",
    "每个分镜编号对应同编号视频；旁白、配音和字幕请在后期剪辑软件中对齐。",
    "",
    ...rows,
  ].join("\r\n");
}

function downloadTextFile(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function responseJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

class CanvasPersistenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "CanvasPersistenceError";
  }
}

async function canvasResponseJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & {
    error?: string;
    code?: string;
    currentRevision?: number;
  };
  if (!response.ok) {
    throw new CanvasPersistenceError(
      data.error || `画布存储请求失败 (${response.status})`,
      response.status,
      data.code,
      data.currentRevision,
    );
  }
  return data;
}

function canvasAuthHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function canvasDocumentDigest(document: CanvasServerDocument) {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const normalized = Object.fromEntries(Object.entries(record).map(([key, item]) => {
      if (key === "createdAt" || key === "updatedAt") return [key, ""];
      if ((key === "outputUrl" || key === "storageKey") && typeof record.assetId === "string" && record.assetId) {
        return [key, `asset:${record.assetId}`];
      }
      if (key === "pendingPersistUrl" || key === "providerContentUrl") return [key, ""];
      return [key, normalize(item)];
    }));
    return normalized;
  };
  const digestDocument = normalize(document);
  const bytes = new TextEncoder().encode(JSON.stringify(digestDocument));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}


async function requestImageJsonWithRetry<T>(request: () => Promise<Response>, onRetry: (message: string) => void): Promise<T> {
  let lastMessage = "图片服务暂时不可用";
  for (let attempt = 1; attempt <= IMAGE_GENERATE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : "图片服务连接中断";
      if (attempt === IMAGE_GENERATE_MAX_ATTEMPTS) throw new Error(lastMessage);
      const retryDelayMs = 4_000 * (2 ** (attempt - 1));
      onRetry(`图片服务连接中断，${retryDelayMs / 1000} 秒后重试 ${attempt + 1}/${IMAGE_GENERATE_MAX_ATTEMPTS}`);
      await delay(retryDelayMs);
      continue;
    }

    if (response.ok) return responseJson<T>(response);
    const failure = await response.json().catch(() => ({})) as { error?: string };
    lastMessage = failure.error || `图片请求失败 (${response.status})`;
    const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === IMAGE_GENERATE_MAX_ATTEMPTS) throw new Error(lastMessage);
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const serverDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
    const retryDelayMs = Math.max(serverDelayMs, (response.status === 429 ? 8_000 : 4_000) * (2 ** (attempt - 1)));
    onRetry(`生成服务${response.status === 429 ? "繁忙" : "暂时异常"}，${Math.ceil(retryDelayMs / 1000)} 秒后重试 ${attempt + 1}/${IMAGE_GENERATE_MAX_ATTEMPTS}`);
    await delay(retryDelayMs);
  }
  throw new Error(lastMessage);
}

function recommendPromptPresetId(script: string) {
  const text = script.toLowerCase();
  const scores: Record<ProductionPresetId, number> = {
    anime_story: 0,
    warm_story: 0,
    pet_knowledge: 0,
    cinematic_realism: 0,
    fast_marketing: 0,
  };
  const add = (id: keyof typeof scores, patterns: RegExp[], weight = 1) => {
    patterns.forEach((pattern) => {
      if (pattern.test(text)) scores[id] += weight;
    });
  };

  add("fast_marketing", [/产品|卖点|下单|购买|优惠|转化|带货|开箱|测评|功效|价格|套餐|直播|种草|复购|用户痛点|核心卖点/], 2);
  add("pet_knowledge", [/宠物|萌宠|狗|狗狗|小狗|犬|金毛|柯基|猫|猫咪|橘猫|胖猫|主子|铲屎|摇尾|尾巴|爪子|毛孩子|喂食|食盆|兽医|认主人|养狗|养猫|幸福|行为|记忆/], 2.5);
  add("cinematic_realism", [/品牌|剧情|人物|主角|客户|公司|创业|真实事件|冲突|转折|镜头|采访|纪录|空间|关系/], 1.5);
  add("warm_story", [/陪伴|治愈|家人|妈妈|爸爸|孩子|朋友|老人|回家|温暖|感动|想念|孤独|成长|守护|故事/], 1.5);

  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return (winner && winner[1] > 0 ? winner[0] : "warm_story") as ProductionPresetId;
}

function resolveProductionPresetId(mode: { id: ProductionModeId; presetId: ProductionPresetId }, script: string): ProductionPresetId {
  if (mode.id === "product-video") return "fast_marketing";
  if (mode.id === "real-story") return "cinematic_realism";
  if (mode.id === "anime-story") return "anime_story";

  const recommended = recommendPromptPresetId(script);
  if (mode.id === "ten-second" && recommended === "fast_marketing") return "fast_marketing";
  return mode.presetId;
}

function starterNode(
  kind: WorkflowNodeKind,
  order: number,
  position: { x: number; y: number },
  defaults: {
    imageModelId: string;
    videoModelId: string;
    aspectRatio: AspectRatio;
    imageResolution?: string;
    videoResolution?: string;
    videoDurationSeconds?: number;
  },
): WorkflowFlowNode {
  return {
    id: `${kind}:${crypto.randomUUID()}`,
    type: "workflow",
    position,
    data: {
      kind,
      title: `${KIND_LABEL[kind]}节点 ${order}`,
      prompt: "",
      outputText: "",
      outputUrl: "",
      taskId: "",
      providerContentUrl: "",
      modelId: kind === "image" ? defaults.imageModelId : kind === "video" ? defaults.videoModelId : "",
      aspectRatio: defaults.aspectRatio,
      durationSeconds: defaults.videoDurationSeconds || 10,
      resolution: kind === "image" ? defaults.imageResolution || "2K" : defaults.videoResolution || "1080p",
      imageMode: "text-to-image",
      imageCount: 1,
      videoMode: "first-frame",
      status: "idle",
      history: [],
    },
  };
}

function createStarterCanvas(): Pick<CanvasSession, "nodes" | "edges"> {
  return { nodes: [], edges: [] };
}

function normalizeEdges(edges: WorkflowFlowEdge[]): WorkflowFlowEdge[] {
  return edges.map((edge) => ({ ...edge, animated: true, markerEnd: { type: MarkerType.ArrowClosed } }));
}

function normalizeInterruptedNodeStates(nodes: WorkflowFlowNode[]): WorkflowFlowNode[] {
  return nodes.map((node) => {
    if(node.data.kind==="image" && node.data.imageDeliveryReceipt?.deliveryMode==="inline_ephemeral")return {...node,data:{...node.data,status:"succeeded",imagePreviewUrl:undefined,outputUrl:"",error:"生成已完成且费用收据已保留；临时图片刷新后无法恢复"}};
    if (node.data.status !== "running" && node.data.status !== "queued") return node;
    if (node.data.kind === "image") {
      const canResume = Boolean(node.data.pendingPersistUrl)
        || (Boolean(node.data.imageClientTraceId) && Boolean(node.data.imageClientIdempotencyKey));
      return {
        ...node,
        data: {
          ...node.data,
          status: "failed",
          progressMessage: undefined,
          error: canResume
            ? node.data.pendingPersistUrl
              ? "页面刷新中断了永久保存；请点击“重试保存”，不会重新生成或扣费"
              : "页面刷新中断了图片任务；请点击“恢复任务”，将沿用原幂等键"
            : "页面刷新时图片提交状态未知；请先核对媒体历史，再显式重新生成",
        },
      };
    }
    if (node.data.kind === "video") {
      if (node.data.taskId) {
        return {
          ...node,
          data: {
            ...node.data,
            status: "idle",
            progressMessage: "任务已提交，页面刷新后可继续查询",
            error: undefined,
          },
        };
      }
      return {
        ...node,
        data: {
          ...node.data,
          status: node.data.clientRequestId ? "failed" : "idle",
          progressMessage: undefined,
          error: node.data.clientRequestId
            ? "页面刷新时视频提交结果不确定；请先核对媒体历史，再显式重新生成"
            : undefined,
        },
      };
    }
    return {
      ...node,
      data: { ...node.data, status: "idle", progressMessage: undefined, error: undefined },
    };
  });
}

function makeCanvasSession(
  name: string,
  graph?: Pick<CanvasSession, "nodes" | "edges">,
  sourceReferenceId?: string,
): CanvasSession {
  const now = new Date().toISOString();
  const starter = graph || createStarterCanvas();
  return {
    id: createCanvasSessionId(),
    name,
    sourceReferenceId,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: starter.nodes,
    edges: normalizeEdges(starter.edges),
  };
}

function createInspirationStarterCanvas(
  reference: NonNullable<ManualCanvasProps["initialReference"]>,
  defaults: {
    imageModelId: string;
    videoModelId: string;
    aspectRatio: AspectRatio;
  },
): Pick<CanvasSession, "nodes" | "edges"> {
  if (reference.workflow) {
    const nodes = reference.workflow.nodes.map((handoffNode, index) => {
      const node = starterNode(
        handoffNode.kind,
        index + 1,
        handoffNode.position,
        defaults,
      );
      node.id = handoffNode.id;
      node.data = {
        ...node.data,
        title: handoffNode.title,
        prompt: handoffNode.prompt,
        outputText: handoffNode.kind === "text" ? handoffNode.prompt : "",
        outputUrl: handoffNode.outputUrl,
        sourceMediaKind: handoffNode.sourceKind === "audio" || handoffNode.sourceKind === "music"
          ? handoffNode.sourceKind
          : handoffNode.sourceKind === "audio-plan"
            ? "audio"
          : handoffNode.kind === "upload" ? "image" : undefined,
        optionalInput: handoffNode.kind === "upload",
        status: handoffNode.status,
      };
      return node;
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = reference.workflow.edges
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map((edge): WorkflowFlowEdge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      }));
    return { nodes, edges };
  }

  const textNode = starterNode("text", 1, { x: 140, y: 120 }, defaults);
  textNode.data = {
    ...textNode.data,
    title: `灵感提示词 · ${reference.title}`,
    prompt: reference.prompt,
    outputText: reference.prompt,
  };

  const referenceNode = starterNode("upload", 1, { x: 640, y: 120 }, defaults);
  referenceNode.data = {
    ...referenceNode.data,
    title: `原创参考图 · ${reference.title}`,
    prompt: `灵感编号：${reference.inspirationId}`,
    outputUrl: reference.imagePath,
    sourceMediaKind: "image",
    optionalInput: true,
    status: "succeeded",
  };

  return { nodes: [textNode, referenceNode], edges: [] };
}

export function ManualCanvas({
  imageModels,
  videoModels,
  voiceOptions,
  voicePricing,
  defaultImageModelId,
  defaultVideoModelId,
  defaultAspectRatio,
  initialReference,
  initialDraft,
  preferredReferenceId,
  storageScope,
  onNotice,
  onRequireLogin,
  onBalanceRefresh,
  onLocalDraftChange,
  onReferencePersisted,
}: ManualCanvasProps) {
  const [nodes, setNodes] = useState<WorkflowFlowNode[]>([]);
  const [edges, setEdges] = useState<WorkflowFlowEdge[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [activeRunStage, setActiveRunStage] = useState<GenerationStage | null>(null);
  const [batchControl, setBatchControl] = useState<BatchControlState>("idle");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [canvasSessions, setCanvasSessions] = useState<CanvasSession[]>([]);
  const [runHistory, setRunHistory] = useState<CanvasRunRecord[]>([]);
  const [generationDiagnostics, setGenerationDiagnostics] = useState<GenerationDiagnosticEntry[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState("");
  const [persistenceState, setPersistenceState] = useState<CanvasPersistenceState>("loading");
  const [persistenceMessage, setPersistenceMessage] = useState("正在读取账号画布…");
  const [viewportSaveTick, setViewportSaveTick] = useState(0);
  const [canvasMenuOpen, setCanvasMenuOpen] = useState(false);
  const [proPanelOpen, setProPanelOpen] = useState(false);
  const [proPanelTab, setProPanelTab] = useState<ProPanelTab>("setup");
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [scriptImporterOpen, setScriptImporterOpen] = useState(false);
  const [scriptDraft, setScriptDraft] = useState("");
  const [productionModeId, setProductionModeId] = useState<ProductionModeId>("anime-story");
  const [animationStyleId, setAnimationStyleId] = useState<AnimationStyleId>("pixar-3d");
  const [storyboardReferenceTextMode, setStoryboardReferenceTextMode] = useState<StoryboardReferenceTextMode>("annotated");
  const [agentCanvasHandoff, setAgentCanvasHandoff] = useState<AgentCanvasHandoffState>({ status: "hidden" });

  useEffect(() => {
    if (!previewNodeId) return;
    const closePreviewOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPreviewNodeId(null);
    };
    window.addEventListener("keydown", closePreviewOnEscape);
    return () => window.removeEventListener("keydown", closePreviewOnEscape);
  }, [previewNodeId]);
  const [storyDirectorMode, setStoryDirectorMode] = useState<StoryboardDirectorMode>("high_energy");
  const [storyTargetDurationSeconds, setStoryTargetDurationSeconds] = useState<FreeCanvasStoryTargetDuration>(10);
  const [consistencySourceDraft, setConsistencySourceDraft] = useState<ConsistencySource>("explore");
  const consistencySourceDraftRef = useRef<ConsistencySource>("explore");
  const updateConsistencySourceDraft = useCallback((value: ConsistencySource) => {
    consistencySourceDraftRef.current = value;
    setConsistencySourceDraft(value);
  }, []);
  const [scriptStyleDraft, setScriptStyleDraft] = useState("");
  const [scriptRatioDraft, setScriptRatioDraft] = useState<AspectRatio>("16:9");
  const [canvasImageModelId, setCanvasImageModelId] = useState("");
  const [canvasImageResolution, setCanvasImageResolution] = useState<ImageResolution>(() =>
    coerceImageResolution(imageModels.find((model) => model.id === defaultImageModelId), undefined, "2K"),
  );
  const [canvasVideoModelId, setCanvasVideoModelId] = useState("");
  const [canvasVideoResolution, setCanvasVideoResolution] = useState("1080p");
  const [promptPresets, setPromptPresets] = useState<PublicCanvasPromptPreset[]>([]);
  const [keyframeStrategyDraft, setKeyframeStrategyDraft] = useState<KeyframeStrategy>("visual-anchor");
  const [effectsLevelDraft, setEffectsLevelDraft] = useState<VisualEffectsLevel>("rich");
  const [advancedDraftOpen, setAdvancedDraftOpen] = useState(false);
  const [assistantDraftOpen, setAssistantDraftOpen] = useState(false);
  const [assistantInstruction, setAssistantInstruction] = useState("");
  const [scriptCompiling, setScriptCompiling] = useState(false);
  const [scriptCompileElapsedSeconds, setScriptCompileElapsedSeconds] = useState(0);
  const [batchRunElapsedSeconds, setBatchRunElapsedSeconds] = useState(0);
  const nodesRef = useRef(nodes);
  const deliveryPageActiveRef=useRef(true);
  const deliveryCanvasRef=useRef(activeCanvasId);deliveryCanvasRef.current=activeCanvasId;
  const imageDeliveryReleases=useRef(new Map<string,()=>void>());
  useEffect(()=>{deliveryPageActiveRef.current=true;return ()=>{deliveryPageActiveRef.current=false;for(const release of imageDeliveryReleases.current.values())release();imageDeliveryReleases.current.clear();};},[activeCanvasId]);
  const edgesRef = useRef(edges);
  const runHistoryRef = useRef(runHistory);
  const nextImageSubmitAtRef = useRef(0);
  const nextVideoSubmitAtRef = useRef(0);
  const nextVideoPollAtRef = useRef(0);
  const activeNodeRunsRef = useRef(new Set<string>());
  const refreshedAssetUrlsRef = useRef(new Set<string>());
  const initialReferenceRef = useRef(initialReference);
  const initialDraftRef = useRef(initialDraft);
  const initialCanvasDefaultsRef = useRef({
    imageModelId: defaultImageModelId,
    videoModelId: defaultVideoModelId,
    aspectRatio: defaultAspectRatio,
  });
  const batchControlRef = useRef<BatchControlState>("idle");
  const videoRecoveryCanvasRef = useRef("");
  const lastStructuredCommitRef = useRef("");
  const agentHandoffConsumedRef = useRef(false);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkflowFlowNode, WorkflowFlowEdge> | null>(null);
  const viewportRef = useRef<CanvasViewport>({ x: 0, y: 0, zoom: 1 });
  const pendingViewportRef = useRef<CanvasViewport | null>(null);
  const canvasRevisionRef = useRef(new Map<string, number>());
  const lastCanvasSaveHashRef = useRef(new Map<string, string>());
  const canvasSavePromiseRef = useRef(new Map<string, Promise<void>>());
  const canvasSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const currentModelCatalogRef = useRef({ imageModels, videoModels });
  currentModelCatalogRef.current = { imageModels, videoModels };
  const selectedCanvasImageModel = useMemo(
    () => imageModels.find((model) => model.id === canvasImageModelId),
    [canvasImageModelId, imageModels],
  );
  const canvasImageResolutionOptions = getImageModelCapabilities(selectedCanvasImageModel).resolutionOptions;
  const requiresExactStoryboardTiming = productionModeId !== "product-video";
  const selectableCanvasVideoModels = videoModels;
  const selectedCanvasVideoModel = useMemo(
    () => selectableCanvasVideoModels.find((model) => model.id === canvasVideoModelId)
      || videoModels.find((model) => model.id === canvasVideoModelId),
    [canvasVideoModelId, selectableCanvasVideoModels, videoModels],
  );
  const canvasVideoResolutionOptions = getCanvasVideoResolutionOptions(selectedCanvasVideoModel);
  const selectedCanvasVideoResolution = coerceCanvasVideoResolution(selectedCanvasVideoModel, canvasVideoResolution);
  const selectedProductionMode = useMemo(
    () => PRODUCTION_MODES.find((mode) => mode.id === productionModeId) || PRODUCTION_MODES[0],
    [productionModeId],
  );
  const selectedStoryDirector = useMemo(
    () => STORY_DIRECTOR_OPTIONS.find((mode) => mode.id === storyDirectorMode) || STORY_DIRECTOR_OPTIONS[0],
    [storyDirectorMode],
  );
  const scriptCompileStageLabel = productionModeId === "anime-story"
    ? scriptCompileElapsedSeconds < 12
      ? "导演分析全文"
      : scriptCompileElapsedSeconds < 70
        ? "生成分镜与图视频提示词"
        : "提示词流程仍在处理"
    : scriptCompileElapsedSeconds < 12
      ? "分析全文"
      : scriptCompileElapsedSeconds < 70
        ? "生成逐镜提示词"
        : "生成服务仍在处理";

  useEffect(() => {
    if (!scriptCompiling) {
      setScriptCompileElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setScriptCompileElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [scriptCompiling]);
  useEffect(() => {
    if (!runningAll) {
      setBatchRunElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setBatchRunElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runningAll]);
  const selectedAnimationStyle = useMemo(
    () => ANIMATION_STYLE_OPTIONS.find((style) => style.id === animationStyleId) || ANIMATION_STYLE_OPTIONS[0],
    [animationStyleId],
  );
  const effectiveScriptStyleGuide = useMemo(() => {
    if (productionModeId !== "anime-story") return scriptStyleDraft.trim();
    return selectedAnimationStyle.prompt;
  }, [productionModeId, scriptStyleDraft, selectedAnimationStyle]);
  const currentStoryboardSettings = useMemo<CanvasStoryboardSettings>(() => ({
    productionModeId,
    directorMode: storyDirectorMode,
    targetDurationSeconds: storyTargetDurationSeconds,
    animationStyleId,
    aspectRatio: scriptRatioDraft,
    referenceTextMode: storyboardReferenceTextMode,
  }), [animationStyleId, productionModeId, scriptRatioDraft, storyDirectorMode, storyTargetDurationSeconds, storyboardReferenceTextMode]);

  const applyStoryboardSettings = useCallback((settings?: CanvasStoryboardSettings) => {
    if (!settings) return;
    setProductionModeId(settings.productionModeId);
    setStoryDirectorMode(settings.directorMode);
    setStoryTargetDurationSeconds(settings.targetDurationSeconds);
    setAnimationStyleId(settings.animationStyleId);
    setScriptRatioDraft(settings.aspectRatio);
    setStoryboardReferenceTextMode(settings.referenceTextMode || "annotated");
  }, []);

  const preserveViewport = useCallback((changePanelState: () => void) => {
    const viewport = flowRef.current?.getViewport();
    changePanelState();
    if (!viewport) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void flowRef.current?.setViewport(viewport, { duration: 0 });
      });
    });
  }, []);

  const openScriptPanel = useCallback(() => {
    preserveViewport(() => {
      setProPanelOpen(true);
      setScriptImporterOpen(true);
    });
  }, [preserveViewport]);

  const toggleProPanel = useCallback(() => {
    preserveViewport(() => setProPanelOpen((open) => !open));
  }, [preserveViewport]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { runHistoryRef.current = runHistory; }, [runHistory]);
  useEffect(() => {
    if (!hydrated || !activeCanvasId || !onLocalDraftChange) return;
    if (window.localStorage.getItem(TOKEN_KEY)) return;
    const activeSession = canvasSessions.find((session) => session.id === activeCanvasId);
    const referenceId = activeSession?.sourceReferenceId
      || initialReferenceRef.current?.inspirationId
      || preferredReferenceId;
    if (!activeSession || !referenceId) return;
    const timer = window.setTimeout(() => {
      const snapshotNodes = nodes.map((node) => ({
        ...node,
        position: { ...node.position },
        data: { ...node.data, history: [...node.data.history] },
      }));
      const snapshotEdges = normalizeEdges(edges).map((edge) => ({ ...edge }));
      onLocalDraftChange({
        schemaVersion: 1,
        referenceId,
        session: {
          ...activeSession,
          sourceReferenceId: referenceId,
          revision: 0,
          updatedAt: new Date().toISOString(),
          viewport: { ...viewportRef.current },
          nodes: snapshotNodes,
          edges: snapshotEdges,
          storyboardSettings: currentStoryboardSettings,
        },
      });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [
    activeCanvasId,
    canvasSessions,
    currentStoryboardSettings,
    edges,
    hydrated,
    nodes,
    onLocalDraftChange,
    preferredReferenceId,
    viewportSaveTick,
  ]);

  useEffect(() => {
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const zIndex = node.id === selectedId ? 1000 : 0;
        if ((node.zIndex || 0) === zIndex) return node;
        changed = true;
        return { ...node, zIndex };
      });
      return changed ? next : current;
    });
  }, [selectedId]);

  const persistRunHistory = useCallback((updater: (current: CanvasRunRecord[]) => CanvasRunRecord[]) => {
    setRunHistory((current) => {
      const next = cleanCanvasRunHistory(updater(current));
      runHistoryRef.current = next;
      return next;
    });
  }, []);

  const updateRunRecord = useCallback((runId: string, updater: (record: CanvasRunRecord) => CanvasRunRecord, persist = false) => {
    if (persist) {
      persistRunHistory((current) => current.map((record) => record.id === runId ? updater(record) : record));
      return;
    }
    setRunHistory((current) => {
      const next = current.map((record) => record.id === runId ? updater(record) : record);
      runHistoryRef.current = next;
      return next;
    });
  }, [persistRunHistory]);

  function recordGenerationDiagnostic(entry: Omit<GenerationDiagnosticEntry, "id" | "canvasId">) {
    const nextEntry: GenerationDiagnosticEntry = {
      ...entry,
      id: crypto.randomUUID(),
      canvasId: activeCanvasId,
    };
    setGenerationDiagnostics((current) => [nextEntry, ...current].slice(0, 300));
    if (nextEntry.status === "failed") {
      console.error("[free-canvas:diagnostic]", nextEntry);
    } else {
      console.info("[free-canvas:diagnostic]", nextEntry);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/canvas/prompt-presets")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "提示词方案加载失败");
        return data.presets as PublicCanvasPromptPreset[];
      })
      .then((presets) => {
        if (cancelled) return;
        setPromptPresets(presets);
      })
      .catch(() => {
        if (!cancelled) onNotice("提示词方案暂时不可用，请稍后重试");
      });
    return () => { cancelled = true; };
  }, [onNotice]);

  useEffect(() => {
    if (defaultImageModelId && imageModels.length) setCanvasImageModelId(current => current || defaultImageModelId);
    if (defaultVideoModelId && selectableCanvasVideoModels.length) setCanvasVideoModelId(current => current || defaultVideoModelId);
  }, [defaultImageModelId, defaultVideoModelId, imageModels, selectableCanvasVideoModels]);

  useEffect(() => {
    if (!requiresExactStoryboardTiming || videoModels.length === 0) return;
    const selected = videoModels.find(model => model.id === canvasVideoModelId);
    if (selected && !selected.supportsImageInput) onNotice(`${selected.name} 不支持当前精确时长，请手动选择支持参考图的视频模型。`);
  }, [canvasVideoModelId, onNotice, requiresExactStoryboardTiming, videoModels]);

  useEffect(() => {
    setCanvasImageResolution((current) => {
      const next = coerceImageResolution(selectedCanvasImageModel, current, "2K");
      const capabilities = getImageModelCapabilities(selectedCanvasImageModel);
      if (current === "1K" && capabilities.resolutionOptions.includes("2K")) return "2K";
      return next;
    });
  }, [selectedCanvasImageModel]);

  useEffect(() => {
    setCanvasVideoResolution((current) => coerceCanvasVideoResolution(selectedCanvasVideoModel, current));
  }, [selectedCanvasVideoModel]);

  useEffect(() => {
    if (imageModels.length === 0) return;
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== "image") return node;
      const model = imageModels.find((item) => item.id === node.data.modelId);
      if (!model) return node; // Never replace a missing saved model with another paid channel.
      const resolution = coerceImageResolution(model, node.data.resolution);
      if (node.data.modelId === model.id && node.data.resolution === resolution) return node;
      return { ...node, data: { ...node.data, modelId: model.id, resolution } };
    }));
  }, [imageModels, selectedCanvasImageModel]);

  useEffect(() => {
    if (videoModels.length === 0) return;
    setNodes((current) => current.map((node) => {
      if (node.data.kind !== "video" || node.data.taskId || node.data.clientRequestId || node.data.outputUrl || node.data.status === "running" || node.data.status === "succeeded" || node.data.history.length > 0) return node;
      const model = videoModels.find((item) => item.id === node.data.modelId);
      if (!model) return node;
      const durationSeconds = coerceVideoTargetDuration(model, node.data.durationSeconds);
      const resolution = coerceCanvasVideoResolution(model, node.data.resolution);
      if (durationSeconds === node.data.durationSeconds && resolution === node.data.resolution) return node;
      return { ...node, data: { ...node.data, durationSeconds, resolution } };
    }));
  }, [videoModels]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      const restoredViewport = pendingViewportRef.current;
      if (restoredViewport) {
        viewportRef.current = restoredViewport;
        pendingViewportRef.current = null;
        void flowRef.current?.setViewport(restoredViewport, { duration: 0 });
        return;
      }
      const currentNodes = nodesRef.current;
      const previewIds = new Set(layoutWorkflow(currentNodes, edgesRef.current).previewNodes.map((node) => node.id));
      const targetNodes = initialReferenceRef.current?.workflow
        ? currentNodes
        : currentNodes.length > 12
        ? currentNodes.filter((node) => previewIds.has(node.id))
        : currentNodes;
      flowRef.current?.fitView({
        nodes: targetNodes.length > 0 ? targetNodes : currentNodes,
        padding: window.innerWidth <= 760 ? 0.08 : 0.12,
        maxZoom: window.innerWidth <= 760 ? 0.62 : 0.78,
        duration: 180,
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [hydrated]);

  useEffect(() => {
    let cancelled = false;
    const hydrateFromAccount = async () => {
      const reference = initialReferenceRef.current;
      const draft = initialDraftRef.current
        && (!preferredReferenceId || initialDraftRef.current.referenceId === preferredReferenceId)
        ? initialDraftRef.current
        : null;
      const importedReferenceId = draft?.referenceId || reference?.inspirationId;
      const createImportedSession = () => {
        if (draft) {
          return {
            ...draft.session,
            sourceReferenceId: draft.referenceId,
            revision: 0,
            updatedAt: new Date().toISOString(),
            viewport: { ...draft.session.viewport },
            nodes: normalizeInterruptedNodeStates(draft.session.nodes),
            edges: normalizeEdges(draft.session.edges),
          };
        }
        return makeCanvasSession(
          `灵感 · ${reference?.title || "原创参考"}`,
          reference ? createInspirationStarterCanvas(reference, initialCanvasDefaultsRef.current) : undefined,
          reference?.inspirationId,
        );
      };
      const setMemoryOnlySession = (message: string, state: CanvasPersistenceState) => {
        const session = importedReferenceId
          ? createImportedSession()
          : makeCanvasSession(preferredReferenceId ? "待导入示例副本" : "新会话", undefined, preferredReferenceId);
        if (cancelled) return;
        canvasRevisionRef.current = new Map([[session.id, 0]]);
        setCanvasSessions([session]);
        setActiveCanvasId(session.id);
        setNodes(session.nodes);
        setEdges(session.edges);
        setSelectedId(session.nodes[0]?.id || null);
        // Imported showcase coordinates describe the complete public graph.
        // Let the post-hydration fitView calculate the initial transform instead
        // of restoring the synthetic {0,0,1} session viewport and hiding nodes.
        pendingViewportRef.current = reference?.workflow || draft ? null : session.viewport;
        setPersistenceState(state);
        setPersistenceMessage(message);
        onNotice(message);
        setHydrated(true);
      };
      try {
        const token = window.localStorage.getItem(TOKEN_KEY);
        if (!token) {
          const importedNodeCount = draft?.session.nodes.length || reference?.workflow?.nodes.length || 0;
          const importedEdgeCount = draft?.session.edges.length || reference?.workflow?.edges.length || 0;
          const memoryOnlyNotice = importedNodeCount > 0
            ? `已导入 ${importedNodeCount} 个可编辑节点和 ${importedEdgeCount} 条连线，本次未触发生成或扣费；登录后可保存到账号`
            : reference
              ? "已导入灵感参考，本次未触发生成或扣费；登录后可保存到账号"
              : "当前画布可在本地编辑；连接主平台后才会保存到账号";
          setMemoryOnlySession(memoryOnlyNotice, "blocked");
          return;
        }
        const remoteCanvases: CanvasServerRecord[] = [];
        let nextOffset: number | null = 0;
        while (nextOffset !== null) {
          const response: Response = await fetch(`/api/canvas?includeDocuments=1&limit=50&offset=${nextOffset}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          });
          const page: {
            canvases: CanvasServerRecord[];
            pagination: { nextOffset: number | null };
          } = await canvasResponseJson(response);
          remoteCanvases.push(...(page.canvases || []));
          nextOffset = page.pagination?.nextOffset ?? null;
        }
        if (cancelled) return;
        let sessions = remoteCanvases.map((record): CanvasSession => ({
          ...record.document.session,
          id: record.id,
          name: record.name,
          revision: record.revision,
          viewport: record.document.viewport || { x: 0, y: 0, zoom: 1 },
          nodes: normalizeInterruptedNodeStates(record.document.session.nodes),
          edges: normalizeEdges(record.document.session.edges),
        }));
        canvasRevisionRef.current = new Map(sessions.map((session) => [session.id, session.revision]));
        const mergedRunHistory = cleanCanvasRunHistory(remoteCanvases.flatMap((record) => record.document.runHistory || []));
        const mergedDiagnostics = remoteCanvases.flatMap((record) => record.document.diagnostics || []).slice(0, 300);
        setRunHistory(mergedRunHistory);
        runHistoryRef.current = mergedRunHistory;
        setGenerationDiagnostics(mergedDiagnostics);

        let importedSession: CanvasSession | null = null;
        if (reference || draft) {
          const existingDraftSession = draft
            ? sessions.find((session) => session.id === draft.session.id)
            : null;
          if (existingDraftSession) {
            importedSession = {
              ...createImportedSession(),
              createdAt: existingDraftSession.createdAt,
              revision: existingDraftSession.revision,
            };
            sessions = sessions.map((session) => session.id === importedSession!.id ? importedSession! : session);
            canvasRevisionRef.current.set(importedSession.id, existingDraftSession.revision);
          } else {
            const freshCopy = prependFreshCanvasCopy(sessions, createImportedSession);
            importedSession = freshCopy.activeSession;
            sessions = freshCopy.sessions;
            canvasRevisionRef.current.set(importedSession.id, 0);
          }
        }

        let preferredSession: CanvasSession | null = null;
        let missingPreferredReference = false;
        if (!importedSession && preferredReferenceId) {
          preferredSession = sessions.find((session) => session.sourceReferenceId === preferredReferenceId) ?? null;
          missingPreferredReference = !preferredSession || preferredSession.name === "待导入示例副本";
          if (!preferredSession) {
            preferredSession = makeCanvasSession("待导入示例副本", undefined, preferredReferenceId);
            sessions = [preferredSession, ...sessions];
          }
        }

        if (sessions.length === 0) {
          sessions = [makeCanvasSession("新会话")];
          canvasRevisionRef.current.set(sessions[0].id, 0);
        }

        const activeSession = importedSession
          || preferredSession
          || restoreActiveCanvasSession(sessions, null);
        if (!activeSession) throw new Error("Canvas session restoration returned no active session");
        const restoredEdges = normalizeEdges(activeSession.edges);
        const shouldRepairLegacyLayout = isLegacyGridLayout(activeSession.nodes);
        const restoredNodes = shouldRepairLegacyLayout
          ? layoutWorkflow(activeSession.nodes, restoredEdges).nodes
          : activeSession.nodes;
        sessions = sessions.map((session) => session.id === activeSession.id
          ? { ...session, nodes: restoredNodes, edges: restoredEdges }
          : session);
        setCanvasSessions(sessions);
        setActiveCanvasId(activeSession.id);
        setNodes(restoredNodes);
        setEdges(restoredEdges);
        setSelectedId(restoredNodes[0]?.id || null);
        applyStoryboardSettings(activeSession.storyboardSettings);
        pendingViewportRef.current = draft ? draft.session.viewport : importedSession ? null : activeSession.viewport;
        viewportRef.current = draft
          ? draft.session.viewport
          : importedSession ? { x: 0, y: 0, zoom: 1 } : activeSession.viewport;
        setPersistenceState("saved");
        setPersistenceMessage(remoteCanvases.length > 0 ? "账号画布已恢复" : "账号暂无画布，正在创建首个画布");
        if (draft) {
          onNotice(`已将登录前的 ${draft.session.nodes.length} 个可编辑节点和 ${draft.session.edges.length} 条连线保存到当前账号；本次操作未触发生成或扣费`);
        } else if (reference?.workflow) {
          onNotice(`已导入 ${reference.workflow.nodes.length} 个可编辑节点和 ${reference.workflow.edges.length} 条连线，正在保存到账号；本次导入未触发生成或扣费`);
        } else if (reference) {
          onNotice("已导入灵感参考，正在保存到账号；可直接编辑提示词或连接参考图");
        } else if (missingPreferredReference) {
          onNotice("未找到指定示例的复制数据；已隔离为空白画布，请返回示例页重新点击“复制并继续创作”");
        } else if (preferredSession) {
          onNotice("已恢复指定示例的独立画布会话");
        } else if (shouldRepairLegacyLayout) {
          onNotice("已自动修复旧版布局，修复结果正在保存到账号");
        }
        setHydrated(true);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof CanvasPersistenceError && error.status === 401) onRequireLogin();
        const message = error instanceof CanvasPersistenceError && error.code === "MIGRATION_NOT_READY"
          ? "账号画布保存服务正在准备中；当前内容仅保留在本页，暂未保存到账号"
          : error instanceof CanvasPersistenceError && error.status === 401
            ? "登录已过期；当前画布仅在内存中，未保存到账号"
            : "账号画布读取失败；当前画布仅在内存中，未保存";
        setMemoryOnlySession(message, "blocked");
      } finally {
        if (!cancelled) setHydrated(true);
      }
    };
    void hydrateFromAccount();
    return () => { cancelled = true; };
  }, [
    applyStoryboardSettings,
    onNotice,
    onRequireLogin,
    preferredReferenceId,
  ]);

  const buildCanvasDocument = useCallback((session: CanvasSession, snapshotNodes: WorkflowFlowNode[], snapshotEdges: WorkflowFlowEdge[]) => {
    const updatedSession: CanvasSession = {
      ...session,
      nodes: snapshotNodes,
      edges: normalizeEdges(snapshotEdges),
      storyboardSettings: currentStoryboardSettings,
      viewport: viewportRef.current,
      updatedAt: new Date().toISOString(),
    };
    const serverSession: CanvasServerDocument["session"] = {
      id: updatedSession.id,
      name: updatedSession.name,
      sourceReferenceId: updatedSession.sourceReferenceId,
      createdAt: updatedSession.createdAt,
      updatedAt: updatedSession.updatedAt,
      viewport: updatedSession.viewport,
      nodes: projectGeneratedImageDocument(updatedSession.nodes),
      edges: updatedSession.edges,
      storyboardSettings: updatedSession.storyboardSettings,
    };
    return {
      session: updatedSession,
      document: {
        schemaVersion: 1 as const,
        session: serverSession,
        viewport: viewportRef.current,
        runHistory: projectGeneratedImageDocument(runHistory.filter((record) => record.canvasId === updatedSession.id)),
        diagnostics: generationDiagnostics.filter((entry) => entry.canvasId === updatedSession.id),
      },
    };
  }, [currentStoryboardSettings, generationDiagnostics, runHistory]);

  const persistCanvasDocument = useCallback(async (session: CanvasSession, document: CanvasServerDocument) => {
    const canvasId = session.id;
    document=projectGeneratedImageDocument(document);
    const hash = await canvasDocumentDigest(document);
    const existingPromise = canvasSavePromiseRef.current.get(canvasId);
    if (lastCanvasSaveHashRef.current.get(canvasId) === hash) {
      if (existingPromise) await existingPromise;
      return;
    }
    lastCanvasSaveHashRef.current.set(canvasId, hash);
    setPersistenceState("saving");
    setPersistenceMessage("正在保存到账号…");
    const queued = canvasSaveQueueRef.current.then(async () => {
      const token = window.localStorage.getItem(TOKEN_KEY);
      if (!token) throw new CanvasPersistenceError("请先登录", 401, "UNAUTHORIZED");
      const expectedRevision = canvasRevisionRef.current.get(canvasId) || 0;
      const response = await fetch("/api/canvas", {
        method: "POST",
        headers: canvasAuthHeaders(token),
        body: JSON.stringify({
          action: "save",
          canvasId,
          expectedRevision,
          idempotencyKey: `canvas-save:${canvasId.slice(7)}:${expectedRevision}:${hash.slice(0, 24)}`,
          document,
        }),
      });
      const payload = await canvasResponseJson<{ canvas: Omit<CanvasServerRecord, "document"> }>(response);
      canvasRevisionRef.current.set(canvasId, payload.canvas.revision);
      setCanvasSessions((current) => current.map((item) => item.id === canvasId
        ? { ...session, revision: payload.canvas.revision, updatedAt: payload.canvas.updatedAt }
        : item));
      setPersistenceState("saved");
      setPersistenceMessage(`已保存到账号 · R${payload.canvas.revision}`);
      if (session.sourceReferenceId) onReferencePersisted?.(session.sourceReferenceId);
    });
    canvasSaveQueueRef.current = queued.catch(() => undefined);
    const handled = queued.catch((error) => {
      lastCanvasSaveHashRef.current.delete(canvasId);
      if (error instanceof CanvasPersistenceError && error.code === "REVISION_CONFLICT") {
        setPersistenceState("blocked");
        setPersistenceMessage(`云端已有更新${error.currentRevision ? `（R${error.currentRevision}）` : ""}，请刷新后继续`);
        onNotice("画布保存已停止：检测到其他页面的新版本，请刷新恢复后再编辑");
      } else {
        if (error instanceof CanvasPersistenceError && (error.status === 401 || error.code === "MIGRATION_NOT_READY")) {
          if (error.status === 401) onRequireLogin();
          setPersistenceState("blocked");
        } else {
          setPersistenceState("failed");
        }
        setPersistenceMessage(error instanceof Error ? `${error.message}；当前更改未确认保存` : "画布保存失败；当前更改未确认保存");
      }
      throw error;
    }).finally(() => {
      if (canvasSavePromiseRef.current.get(canvasId) === handled) canvasSavePromiseRef.current.delete(canvasId);
    });
    canvasSavePromiseRef.current.set(canvasId, handled);
    await handled;
  }, [onNotice, onReferencePersisted, onRequireLogin]);

  async function ensureActiveCanvasPersistedForGeneration() {
    const activeSession = canvasSessions.find((session) => session.id === activeCanvasId);
    if (!hydrated || !activeCanvasId || !activeSession || persistenceState === "loading") {
      const message = "画布尚未完成加载，未提交生成任务或产生费用";
      onNotice(message);
      throw new Error(message);
    }
    if (persistenceState === "blocked") {
      if (!window.localStorage.getItem(TOKEN_KEY)) onRequireLogin();
      const message = "画布当前无法保存到账号，未提交生成任务或产生费用";
      onNotice(message);
      throw new Error(message);
    }

    try {
      const snapshot = buildCanvasDocument(activeSession, nodesRef.current, edgesRef.current);
      await persistCanvasDocument(snapshot.session, snapshot.document);
      const revision = canvasRevisionRef.current.get(activeCanvasId) || 0;
      if (revision <= 0) throw new Error("服务端未返回有效画布版本");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "画布保存失败";
      const message = `画布未保存，未提交生成任务或产生费用（${reason}）`;
      onNotice(message);
      throw new Error(message, { cause: error });
    }
  }

  useEffect(() => {
    if (!hydrated || !activeCanvasId || persistenceState === "blocked") return;
    const activeSession = canvasSessions.find((session) => session.id === activeCanvasId);
    if (!activeSession) return;
    const timer = window.setTimeout(() => {
      const snapshot = buildCanvasDocument(activeSession, nodes, edges);
      void persistCanvasDocument(snapshot.session, snapshot.document).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    activeCanvasId,
    buildCanvasDocument,
    canvasSessions,
    edges,
    hydrated,
    nodes,
    persistenceState,
    persistCanvasDocument,
    viewportSaveTick,
  ]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const candidates = nodesRef.current.flatMap((node) => {
      const entries = [
        ...(node.data.storageKey && node.data.assetId ? [{ storageKey: node.data.storageKey, assetId: node.data.assetId }] : []),
        ...node.data.history
          .filter((item) => item.storageKey && item.assetId)
          .map((item) => ({ storageKey: item.storageKey!, assetId: item.assetId! })),
      ];
      return entries.map((entry) => ({ nodeId: node.id, storageKey: entry.storageKey, assetId: entry.assetId }));
    });
    const uniqueCandidates = [...new Map(candidates.map((item) => [`${item.nodeId}:${item.storageKey}`, item])).values()]
      .filter((item) => !refreshedAssetUrlsRef.current.has(`${activeCanvasId}:${item.nodeId}:${item.storageKey}`));
    if (uniqueCandidates.length === 0) return;
    let cancelled = false;
    void Promise.all(uniqueCandidates.map(async ({ nodeId, storageKey, assetId }) => {
      const refreshKey = `${activeCanvasId}:${nodeId}:${storageKey}`;
      refreshedAssetUrlsRef.current.add(refreshKey);
      const response = await fetch(`/api/bridge/image/persist?assetId=${encodeURIComponent(assetId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`ASSET_URL_REFRESH_${response.status}`);
      const payload = await responseJson<{ url?: string; assetId?: string; storageKey?: string }>(response);
      const refreshed = new URL(payload.url || "", window.location.origin);
      const refreshedProtocol = refreshed.protocol;
      if ((refreshedProtocol !== "http:" && refreshedProtocol !== "https:") || cancelled) return;
      if (payload.assetId !== assetId || payload.storageKey !== storageKey) {
        throw new Error("ASSET_URL_REFRESH_IDENTITY_MISMATCH");
      }
      const refreshedUrl = refreshed.toString();
      setNodes((current) => current.map((node) => {
        if (node.id !== nodeId) return node;
        const history = node.data.history.map((item) => item.storageKey === storageKey
          ? { ...item, outputUrl: refreshedUrl }
          : item);
        return {
          ...node,
          data: {
            ...node.data,
            ...(node.data.storageKey === storageKey ? { outputUrl: refreshedUrl } : {}),
            history,
          },
        };
      }));
    })).catch((error) => {
      console.warn("[free-canvas] persisted asset URL refresh failed", error instanceof Error ? error.message : "unknown");
    });
    return () => {
      cancelled = true;
    };
  }, [activeCanvasId, hydrated]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId || videoRecoveryCanvasRef.current === activeCanvasId) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    videoRecoveryCanvasRef.current = activeCanvasId;
    let cancelled = false;

    void fetch("/api/bridge/video/active-tasks", {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async (response) => responseJson<{
      activeTasks?: RecoverableCanvasVideoTask[];
      recentlyCompleted?: RecoverableCanvasVideoTask[];
    }>(response)).then((payload) => {
      if (cancelled) return;
      const tasks = [...(payload.recentlyCompleted || []), ...(payload.activeTasks || [])]
        .filter((task) => Boolean(task.taskIdExternal && (task.batchTopic || task.taskLabel)));
      if (tasks.length === 0) return;

      let recoveredVideos = 0;
      let recoveredFrames = 0;
      setNodes((current) => {
        const frameUrlByNodeId = new Map<string, string>();
        current.forEach((node) => {
          if (node.data.kind !== "video") return;
          if (!node.data.taskId) return;
          const task = tasks.find((item) => item.taskIdExternal === node.data.taskId)
            || tasks.findLast((item) => item.batchTopic === node.id);
          if (task?.modelId && node.data.modelId && task.modelId !== node.data.modelId) return;
          if (!task?.firstFrameUrl) return;
          edgesRef.current
            .filter((edge) => edge.target === node.id)
            .forEach((edge) => frameUrlByNodeId.set(edge.source, task.firstFrameUrl!));
        });

        const next = current.map((node) => {
          const restoredFrameUrl = frameUrlByNodeId.get(node.id);
          if (node.data.kind === "image" && restoredFrameUrl && !node.data.outputUrl) {
            recoveredFrames += 1;
            return {
              ...node,
              data: {
                ...node.data,
                outputUrl: restoredFrameUrl,
                status: "succeeded" as const,
                error: undefined,
                history: [{ id: crypto.randomUUID(), outputUrl: restoredFrameUrl, createdAt: new Date().toISOString() }, ...node.data.history].slice(0, 20),
              },
            };
          }
          if (node.data.kind !== "video") return node;
          if (node.data.status === "succeeded" && node.data.outputUrl) return node;
          const task = tasks.find((item) => item.taskIdExternal === node.data.taskId)
            || tasks.findLast((item) => item.batchTopic === node.id);
          if (!task?.taskIdExternal) return node;
          if (task.modelId && node.data.modelId && task.modelId !== node.data.modelId) return node;
          const currentFrameUrl = edgesRef.current
            .filter((edge) => edge.target === node.id)
            .map((edge) => current.find((source) => source.id === edge.source))
            .find((source) => source?.data.kind === "image" || (source?.data.kind === "upload" && !isAudioUpload(source.data)))
            ?.data.outputUrl;
          if (task.firstFrameUrl && currentFrameUrl && task.firstFrameUrl !== currentFrameUrl) return node;
          recoveredVideos += 1;
          const completed = task.status === "completed" && Boolean(task.id || task.videoUrl);
          const outputUrl = completed ? task.videoUrl || "" : "";
          return {
            ...node,
            data: {
              ...node.data,
              taskId: task.taskIdExternal,
              providerContentUrl: task.contentUrl || "",
              outputUrl,
              status: completed ? "succeeded" as const : "idle" as const,
              progressMessage: completed ? undefined : "已从主站恢复任务，点击生成只会继续查询",
              error: undefined,
              ...(completed ? {
                playbackStatus: "ready" as const,
                playbackError: undefined,
                actualCost: Number(task.priceCharged || 0),
                billingReferenceId: `video:${task.taskIdExternal}`,
                completedAt: normalizeHistoryTimestamp(task.completedAt),
                history: [{
                  id: crypto.randomUUID(),
                  outputUrl,
                  taskId: task.taskIdExternal,
                  modelId: task.modelId,
                  actualCost: Number(task.priceCharged || 0),
                  createdAt: normalizeHistoryTimestamp(task.completedAt),
                }, ...node.data.history].slice(0, 20),
              } : {}),
            },
          };
        });
        nodesRef.current = next;
        return next;
      });
      window.setTimeout(() => {
        if (!cancelled && recoveredVideos > 0) {
          onNotice(`已从主站恢复 ${recoveredVideos} 个视频任务${recoveredFrames > 0 ? `和 ${recoveredFrames} 张对应首帧` : ""}；继续查询不会重复提交或扣费`);
        }
      }, 0);
    }).catch(() => {
      videoRecoveryCanvasRef.current = "";
    });

    return () => { cancelled = true; };
  }, [activeCanvasId, hydrated, onNotice]);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowFlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const next = addEdge({
      ...connection,
      id: `${connection.source}->${connection.target}:${crypto.randomUUID()}`,
      animated: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    }, edgesRef.current);
    try {
      getWorkflowExecutionOrder({ nodes: asDomainNodes(nodesRef.current), edges: next });
      setEdges(next);
      onNotice(null);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "不能创建循环连线");
    }
  }, [onNotice]);

  const updateNode = useCallback((id: string, patch: Partial<WorkflowNodeData>) => {
    setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node));
  }, []);

  const selectImageCandidate = useCallback((id: string, candidateId: string, outputUrl: string) => {
    if (!outputUrl) return;
    const candidateNode = nodesRef.current.find((node) => node.id === id);
    const chosen = candidateNode?.data.history.find(item=>item.id===candidateId);
    const descendants = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const source = queue.shift()!;
      edgesRef.current.filter((edge) => edge.source === source).forEach((edge) => {
        if (descendants.has(edge.target)) return;
        descendants.add(edge.target);
        queue.push(edge.target);
      });
    }
    const next = nodesRef.current.map((node) => {
      if (node.id === id) {
        return {
          ...node,
          data: {
            ...node.data,
            outputUrl: chosen?.imageDeliveryReceipt?.deliveryMode === "inline_ephemeral" ? "" : outputUrl,
            imagePreviewUrl:chosen?.imagePreviewUrl, imageDeliveryReceipt:chosen?.imageDeliveryReceipt, imageRef:chosen?.imageRef,
            selectedCandidateId: candidateId,
            status: "succeeded" as const,
            error: undefined,
            ...(node.data.assetRole === "storyboard-keyframe"
              ? { referenceValidationStatus: "verified" as const }
              : {}),
          },
        };
      }
      if (!descendants.has(node.id) || node.data.kind === "text") return node;
      return {
        ...node,
        data: {
          ...node.data,
          outputUrl: "",
          taskId: "",
          providerContentUrl: "",
          status: "idle" as const,
          error: undefined,
          ...(node.data.assetRole === "storyboard-keyframe"
            ? { referenceValidationStatus: "pending" as const }
            : {}),
        },
      };
    });
    nodesRef.current = next;
    setNodes(next);
    onNotice(candidateNode?.data.characterName
      ? `已确认“${candidateNode.data.characterName}”定妆图；只有该角色出场的镜头会引用这张图`
      : "已选定角色 / 风格锚点；关联关键帧会使用这张单图");
  }, [onNotice]);

  const lockMediaNodeModels = useCallback((kinds: Array<"image" | "video">) => {
    const kindSet = new Set(kinds);
    const next = nodesRef.current.map((node) => {
      if (!kindSet.has(node.data.kind as "image" | "video") || !node.data.modelId) return node;
      if (node.data.modelLocked && node.data.lockedModelId === node.data.modelId) return node;
      return {
        ...node,
        data: {
          ...node.data,
          modelLocked: true,
          lockedModelId: node.data.modelId,
        },
      };
    });
    nodesRef.current = next;
    setNodes(next);
    return next;
  }, []);

  const setVideoMode = useCallback((id: string, mode: "first-frame" | "multimodal") => {
    if (mode === "first-frame") {
      updateNode(id, { videoMode: mode, status: "idle", taskId: "" });
      return;
    }

    const videoNode = nodesRef.current.find((node) => node.id === id && node.data.kind === "video");
    if (!videoNode) return;
    const incomingImageIds = edgesRef.current.filter((edge) => edge.target === id).map((edge) => edge.source);
    const incomingImages = nodesRef.current.filter((node) => incomingImageIds.includes(node.id) && node.data.kind === "image");
    if (incomingImages.length >= 2) {
      updateNode(id, { videoMode: mode, status: "idle", taskId: "" });
      return;
    }

    const defaults = {
      imageModelId: canvasImageModelId || defaultImageModelId,
      videoModelId: canvasVideoModelId || defaultVideoModelId,
      aspectRatio: videoNode.data.aspectRatio,
      imageResolution: canvasImageResolution,
      videoResolution: selectedCanvasVideoResolution,
    };
    const endFrame = starterNode("image", 1, videoNode.position, defaults);
    const shotName = videoNode.data.title.split("·")[0]?.trim() || "当前镜头";
    endFrame.data = {
      ...endFrame.data,
      title: `${shotName} · 尾帧 ${canvasImageResolution}`,
      prompt: `尾帧提示词：保持首帧中的角色、场景、光线、服装和镜位一致，根据视频提示词描述动作完成后的稳定状态。\n${videoNode.data.prompt}`,
      modelId: canvasImageModelId || defaultImageModelId,
      aspectRatio: videoNode.data.aspectRatio,
      resolution: canvasImageResolution,
      imageMode: "image-to-image",
    };

    setNodes((current) => [
      ...current.map((node) => node.id === id
        ? { ...node, position: { x: node.position.x + 560, y: node.position.y }, data: { ...node.data, videoMode: mode, status: "idle" as const, taskId: "" } }
        : node),
      endFrame,
    ]);
    setEdges((current) => normalizeEdges([
      ...current,
      { id: `${endFrame.id}->${id}`, source: endFrame.id, target: id },
    ]));
    setSelectedId(endFrame.id);
    onNotice("已为当前镜头补充尾帧节点；生成首帧后再生成尾帧");
  }, [canvasImageModelId, canvasImageResolution, canvasVideoModelId, defaultImageModelId, defaultVideoModelId, onNotice, selectedCanvasVideoResolution, updateNode]);

  const selectNode = useCallback((node: WorkflowFlowNode) => {
    setSelectedId(node.id);
    if (window.innerWidth > 760) return;
    const nodeHeight = node.data.kind === "text" || node.data.kind === "upload" ? 251 : 305;
    window.setTimeout(() => {
      flowRef.current?.setCenter(node.position.x + 220, node.position.y + (nodeHeight + 289) / 2, {
        zoom: 0.78,
        duration: 220,
      });
    }, 0);
  }, []);

  function addNode(kind: WorkflowNodeKind, sourceMediaKind?: WorkflowNodeData["sourceMediaKind"]) {
    const count = nodesRef.current.filter((node) => (
      node.data.kind === kind && (!sourceMediaKind || node.data.sourceMediaKind === sourceMediaKind)
    )).length + 1;
    const model = kind === "image"
      ? canvasImageModelId || defaultImageModelId
      : kind === "video"
        ? canvasVideoModelId || defaultVideoModelId
        : "";
    const node: WorkflowFlowNode = {
      id: `${kind}:${crypto.randomUUID()}`,
      type: "workflow",
      position: { x: 120 + (nodesRef.current.length % 3) * 350, y: 100 + Math.floor(nodesRef.current.length / 3) * 280 },
      data: {
        kind,
        title: `${sourceMediaKind === "audio" ? "音频" : sourceMediaKind === "music" ? "音乐" : KIND_LABEL[kind]}节点 ${count}`,
        prompt: "",
        outputText: "",
        outputUrl: "",
        sourceMediaKind,
        taskId: "",
        providerContentUrl: "",
        modelId: model,
        aspectRatio: defaultAspectRatio,
        durationSeconds: kind === "video" ? coerceVideoTargetDuration(videoModels.find(item => item.id === model), 10) : 10,
        resolution: kind === "image" ? canvasImageResolution : selectedCanvasVideoResolution,
        imageMode: "text-to-image",
        imageCount: 1,
        videoMode: "first-frame",
        status: "idle",
        history: [],
      },
    };
    setNodes((current) => [...current, node]);
    setSelectedId(node.id);
  }

  function createNewCanvas() {
    const session = makeCanvasSession("新会话");
    canvasRevisionRef.current.set(session.id, 0);
    setCanvasSessions((current) => [session, ...current]);
    setActiveCanvasId(session.id);
    setNodes(session.nodes);
    setEdges(session.edges);
    setSelectedId(session.nodes[0]?.id || null);
    pendingViewportRef.current = session.viewport;
    setCanvasMenuOpen(false);
    onNotice("已新建画布，正在保存到账号");
  }

  function clearCurrentCanvas() {
    if (!activeCanvasId || runningAll || scriptCompiling || nodes.length === 0) return;
    const confirmed = window.confirm("将清空当前画布的全部节点、连线、生成记录和诊断日志。模型、比例与制作设置会保留，是否继续？");
    if (!confirmed) return;
    const now = new Date().toISOString();
    const emptyNodes: WorkflowFlowNode[] = [];
    const emptyEdges: WorkflowFlowEdge[] = [];
    nodesRef.current = emptyNodes;
    edgesRef.current = emptyEdges;
    setCanvasSessions((current) => {
      return current.map((session) => session.id === activeCanvasId
        ? { ...session, nodes: emptyNodes, edges: emptyEdges, updatedAt: now }
        : session);
    });
    persistRunHistory((current) => current.filter((record) => record.canvasId !== activeCanvasId));
    setGenerationDiagnostics((current) => current.filter((entry) => entry.canvasId !== activeCanvasId));
    setNodes(emptyNodes);
    setEdges(emptyEdges);
    setSelectedId(null);
    setPreviewNodeId(null);
    setCanvasMenuOpen(false);
    onNotice("当前画布已清空，正在保存到账号；模型、比例与制作设置已保留");
  }

  async function switchCanvas(sessionId: string) {
    const session = canvasSessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (sessionId === activeCanvasId) {
      setCanvasMenuOpen(false);
      return;
    }
    const currentSession = canvasSessions.find((item) => item.id === activeCanvasId);
    if (currentSession) {
      if (persistenceState === "blocked") {
        onNotice("当前画布未保存且已阻断；请刷新或重新登录后再切换");
        return;
      }
      const snapshot = buildCanvasDocument(currentSession, nodesRef.current, edgesRef.current);
      try {
        await persistCanvasDocument(snapshot.session, snapshot.document);
      } catch {
        onNotice("当前画布未确认保存，已取消切换");
        return;
      }
    }
    setActiveCanvasId(session.id);
    setNodes(session.nodes);
    setEdges(normalizeEdges(session.edges));
    setSelectedId(session.nodes[0]?.id || null);
    applyStoryboardSettings(session.storyboardSettings);
    pendingViewportRef.current = session.viewport;
    viewportRef.current = session.viewport;
    window.setTimeout(() => void flowRef.current?.setViewport(session.viewport, { duration: 0 }), 0);
    setCanvasMenuOpen(false);
  }

  function renameCanvas(sessionId: string, name: string) {
    setCanvasSessions((current) => current.map((session) => session.id === sessionId
        ? { ...session, name: name.trim() || "新会话", updatedAt: new Date().toISOString() }
        : session));
  }

  async function copyCanvas(sessionId: string) {
    let source = canvasSessions.find((session) => session.id === sessionId);
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!source || !token) {
      if (!token) onRequireLogin();
      onNotice("源画布尚未确认保存，不能创建服务端副本");
      return;
    }
    if (sessionId === activeCanvasId) {
      if (persistenceState === "blocked") {
        onNotice("当前画布保存已阻断，不能复制未确认的版本");
        return;
      }
      const snapshot = buildCanvasDocument(source, nodesRef.current, edgesRef.current);
      try {
        await persistCanvasDocument(snapshot.session, snapshot.document);
        source = { ...snapshot.session, revision: canvasRevisionRef.current.get(sessionId) || source.revision };
      } catch {
        onNotice("源画布未确认保存，未创建副本");
        return;
      }
    }
    if (source.revision <= 0) {
      onNotice("源画布尚未确认保存，不能创建服务端副本");
      return;
    }
    setPersistenceState("saving");
    setPersistenceMessage("正在复制账号画布…");
    try {
      const response = await fetch("/api/canvas", {
        method: "POST",
        headers: canvasAuthHeaders(token),
        body: JSON.stringify({
          action: "copy",
          sourceCanvasId: sessionId,
          name: `${source.name} 副本`,
          idempotencyKey: `canvas-copy:${crypto.randomUUID()}`,
        }),
      });
      const payload = await canvasResponseJson<{ canvas: CanvasServerRecord }>(response);
      const copied: CanvasSession = {
        ...payload.canvas.document.session,
        id: payload.canvas.id,
        name: payload.canvas.name,
        revision: payload.canvas.revision,
        viewport: payload.canvas.document.viewport,
        nodes: normalizeInterruptedNodeStates(payload.canvas.document.session.nodes),
        edges: normalizeEdges(payload.canvas.document.session.edges),
      };
      canvasRevisionRef.current.set(copied.id, copied.revision);
      setCanvasSessions((current) => [copied, ...current]);
      setActiveCanvasId(copied.id);
      setNodes(copied.nodes);
      setEdges(copied.edges);
      setSelectedId(copied.nodes[0]?.id || null);
      pendingViewportRef.current = copied.viewport;
      setPersistenceState("saved");
      setPersistenceMessage(`副本已保存到账号 · R${copied.revision}`);
      setCanvasMenuOpen(false);
      onNotice("账号画布副本已创建，可刷新恢复");
    } catch (error) {
      setPersistenceState("failed");
      setPersistenceMessage(error instanceof Error ? `${error.message}；未创建副本` : "画布复制失败；未创建副本");
      onNotice("画布复制失败，服务端未确认创建副本");
    }
  }

  async function deleteCanvas(sessionId: string) {
    const session = canvasSessions.find((item) => item.id === sessionId);
    if (!session) return;
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (session.revision > 0) {
      if (!token) {
        onRequireLogin();
        onNotice("请先登录；未删除账号画布");
        return;
      }
      try {
        const response = await fetch("/api/canvas", {
          method: "DELETE",
          headers: canvasAuthHeaders(token),
          body: JSON.stringify({
            canvasId: sessionId,
            expectedRevision: canvasRevisionRef.current.get(sessionId) || session.revision,
            idempotencyKey: `canvas-delete:${sessionId.slice(7)}:${session.revision}`,
          }),
        });
        await canvasResponseJson<{ deleted: true }>(response);
      } catch (error) {
        setPersistenceState("failed");
        setPersistenceMessage(error instanceof Error ? `${error.message}；未删除画布` : "画布删除失败；未删除画布");
        onNotice("服务端未确认删除，画布已保留");
        return;
      }
    }
    canvasRevisionRef.current.delete(sessionId);
    lastCanvasSaveHashRef.current.delete(sessionId);
    const remaining = canvasSessions.filter((item) => item.id !== sessionId);
    const fallback = remaining.length > 0 ? remaining : [makeCanvasSession("新会话")];
    if (remaining.length === 0) canvasRevisionRef.current.set(fallback[0].id, 0);
    const active = sessionId === activeCanvasId ? fallback[0] : fallback.find((item) => item.id === activeCanvasId) || fallback[0];
    setCanvasSessions(fallback);
    setActiveCanvasId(active.id);
    setNodes(active.nodes);
    setEdges(normalizeEdges(active.edges));
    setSelectedId(active.nodes[0]?.id || null);
    pendingViewportRef.current = active.viewport;
    onNotice(session.revision > 0 ? "账号画布已删除" : "未保存的内存画布已移除");
  }

  function replaceRuntimeNode(runtime: WorkflowFlowNode[], id: string, patch: Partial<WorkflowNodeData>) {
    const base = nodesRef.current.length > 0 ? nodesRef.current : runtime;
    const next = base.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node);
    nodesRef.current = next;
    setNodes(next);
    return next;
  }

  function queueRuntimeNodes(nodeIds: string[]) {
    const queuedIds = new Set(nodeIds);
    const current = nodesRef.current;
    const next = current.map((node) => {
      if (!queuedIds.has(node.id) || (node.data.kind !== "image" && node.data.kind !== "video")) return node;
      const hasPersistedMedia = Boolean(node.data.outputUrl)
        || (node.data.kind === "image" && Boolean(node.data.selectedCandidateId));
      if ((node.data.status === "succeeded" && hasPersistedMedia) || node.data.status === "running") return node;
      return {
        ...node,
        data: {
          ...node.data,
          status: "queued" as const,
          error: undefined,
          progressMessage: node.data.kind === "image" ? "等待批量生图" : "等待视频提交时隙",
        },
      };
    });
    nodesRef.current = next;
    setNodes(next);
    return next;
  }

  function resetQueuedRuntimeNodes(nodeIds: string[]) {
    const queuedIds = new Set(nodeIds);
    const current = nodesRef.current;
    if (!current.some((node) => queuedIds.has(node.id) && node.data.status === "queued")) return current;
    const next = current.map((node) => queuedIds.has(node.id) && node.data.status === "queued"
      ? { ...node, data: { ...node.data, status: "idle" as const, progressMessage: undefined } }
      : node);
    nodesRef.current = next;
    setNodes(next);
    return next;
  }

  function updateBatchControl(next: BatchControlState) {
    batchControlRef.current = next;
    setBatchControl(next);
  }

  async function waitForBatchPermission() {
    while (batchControlRef.current === "paused") {
      await delay(250);
    }
    if (batchControlRef.current === "stopping") throw new BatchQueueStoppedError();
  }

  async function waitForBatchSubmissionSlot(nextSubmitAtRef: { current: number }, intervalMs: number) {
    if (batchControlRef.current === "idle") return;
    while (true) {
      await waitForBatchPermission();
      const remaining = nextSubmitAtRef.current - Date.now();
      if (remaining <= 0) {
        nextSubmitAtRef.current = Date.now() + intervalMs;
        return;
      }
      await delay(Math.min(remaining, 250));
    }
  }

  async function waitForImageSubmissionSlot() {
    await waitForBatchSubmissionSlot(nextImageSubmitAtRef, IMAGE_BATCH_SUBMIT_INTERVAL_MS);
  }

  async function waitForVideoSubmissionSlot() {
    await waitForBatchSubmissionSlot(nextVideoSubmitAtRef, VIDEO_BATCH_SUBMIT_INTERVAL_MS);
  }

  async function waitForVideoPollSlot() {
    while (true) {
      await waitForBatchPermission();
      const remaining = nextVideoPollAtRef.current - Date.now();
      if (remaining <= 0) {
        nextVideoPollAtRef.current = Date.now() + VIDEO_POLL_REQUEST_INTERVAL_MS;
        return;
      }
      await delay(Math.min(remaining, 150));
    }
  }

  function pauseBatchGeneration() {
    if (!runningAll || batchControlRef.current !== "running") return;
    updateBatchControl("paused");
    onNotice("批量队列已暂停：不再提交下一项；当前图片请求会先完成，已提交的视频任务会保留任务 ID，点击继续后恢复查询。");
  }

  function resumeBatchGeneration() {
    if (!runningAll || batchControlRef.current !== "paused") return;
    updateBatchControl("running");
    onNotice("批量队列已继续，将从未完成节点接着执行，不会重复生成已有结果。");
  }

  function stopBatchGeneration() {
    if (!runningAll || batchControlRef.current === "stopping") return;
    updateBatchControl("stopping");
    onNotice("正在终止批量队列：不会再提交后续节点；当前已发出的图片和视频任务不会重复提交，已完成结果会保留。");
  }

  function upstreamTextPrompt(currentNodes: WorkflowFlowNode[], targetId: string) {
    const sourceIds = new Set(edgesRef.current.filter((edge) => edge.target === targetId).map((edge) => edge.source));
    return currentNodes
      .filter((source) => sourceIds.has(source.id) && source.data.kind === "text")
      .map((source) => source.data.outputText || source.data.prompt)
      .filter(Boolean)
      .join("\n");
  }

  function animeDecorationPreflightError(node: WorkflowFlowNode, currentNodes: WorkflowFlowNode[]) {
    if (productionModeId !== "anime-story" || effectsLevelDraft === "none") return "";
    const validateImageNode = (imageNode: WorkflowFlowNode) => {
      if (imageNode.data.kind !== "image" || !/(?:自动关键帧|故事板参考图)/u.test(imageNode.data.title)) return "";
      const imagePrompt = upstreamTextPrompt(currentNodes, imageNode.id);
      return hasConcreteAnimeSemanticDesign(imagePrompt)
        ? ""
        : `${imageNode.data.title}仍是旧版提示词，缺少完整的剧情表演、叙事道具、环境反馈和特效决策；请重新点击“镜头拆分”后再生图`;
    };

    if (node.data.kind === "image") return validateImageNode(node);
    if (node.data.kind !== "video" || !/关键帧生成视频/u.test(node.data.title)) return "";
    const imageSourceIds = new Set(edgesRef.current.filter((edge) => edge.target === node.id).map((edge) => edge.source));
    const imageSources = currentNodes.filter((source) => imageSourceIds.has(source.id) && source.data.kind === "image");
    return imageSources.map(validateImageNode).find(Boolean) || "";
  }

  async function pollVideo(
    node: WorkflowFlowNode,
    taskId: string,
    contentUrl: string,
    imageUrl: string,
    prompt: string,
    token: string,
  ) {
    let transientErrors = 0;
    const pollingStartedAt = Date.now();
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (Date.now() - pollingStartedAt >= VIDEO_POLL_SESSION_LIMIT_MS) {
        throw new VideoPollingDeferredError("本次已查询 6 分钟，生成服务仍未返回最终状态。任务编号已保留，稍后点击“继续查询”不会重复生成或重复扣费");
      }
      await waitForBatchPermission();
      const params = new URLSearchParams({
        taskId,
        modelId: node.data.modelId,
        prompt,
        imageUrl,
      });
      if (contentUrl) params.set("contentUrl", contentUrl);
      await waitForVideoPollSlot();
      const response = await fetch(`/api/bridge/video/status?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        transientErrors += 1;
        if (response.status === 429) {
          const retryAfterSeconds = Number(response.headers.get("retry-after"));
          const retryDelayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1_000
            : Math.min(30_000, 4_000 * Math.max(1, transientErrors));
          replaceRuntimeNode(nodesRef.current, node.id, { status: "running", progressMessage: `状态查询限流，${Math.ceil(retryDelayMs / 1000)} 秒后继续` });
          await delay(retryDelayMs);
          continue;
        }
        if (response.status >= 500 && transientErrors <= 12) {
          await delay(Math.min(30_000, VIDEO_POLL_INTERVAL_MS * Math.max(1, transientErrors)));
          continue;
        }
        if (response.status >= 500) {
          throw new VideoPollingDeferredError("视频任务已提交，但状态服务暂时不可用。任务 ID 已保留，稍后点击继续只会查询，不会重复提交");
        }
      }
      const data = await responseJson<{
        status?: string;
        videoUrl?: string;
        errorMessage?: string;
        processingStage?: string;
        providerCompleted?: boolean;
        progress?: number | null;
        priceCharged?: number;
        mediaAvailable?: boolean;
        mediaUnavailableReason?: string;
      }>(response);
      transientErrors = 0;
      const unavailablePatch = videoMediaUnavailablePatch(data, taskId);
      if (unavailablePatch) {
        // Preserve the original task and idempotency identity. This is a
        // delivery terminal, never a reason to submit another generation.
        replaceRuntimeNode(nodesRef.current, node.id, unavailablePatch);
        throw new Error(String(unavailablePatch.error));
      }
      if (data.status === "completed" && data.videoUrl) {
        return { videoUrl: data.videoUrl, priceCharged: Number(data.priceCharged || 0) } satisfies CanvasVideoPollResult;
      }
      if (data.status === "failed") {
        // 只有明确的业务终态才允许下一次显式“重新生成”换幂等键。
        // 断网和 5xx 会走上面的延后查询分支，不会清键。
        replaceRuntimeNode(nodesRef.current, node.id, { clientRequestId: undefined, clientRequestFingerprint: undefined });
        throw new Error(data.errorMessage || "视频生成失败");
      }
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - pollingStartedAt) / 1000));
      const progressLabel = typeof data.progress === "number" && data.progress > 0
        ? ` · ${Math.round(data.progress)}%`
        : "";
      const progressMessage = data.processingStage === "trimming"
        ? "模型已完成，正在处理已有任务"
        : data.processingStage === "persisting" || data.providerCompleted
          ? "模型已完成，正在保存视频"
          : data.status === "queued"
            ? `生成服务排队中${progressLabel} · ${elapsedSeconds}s`
            : `模型生成中${progressLabel} · ${elapsedSeconds}s`;
      replaceRuntimeNode(nodesRef.current, node.id, { status: "running", progressMessage });
      await delay(VIDEO_POLL_INTERVAL_MS + (attempt % 3) * 500);
    }
    throw new VideoPollingDeferredError("视频仍在生成，任务 ID 已保存，可稍后点击继续");
  }

  async function executeNode(nodeId: string, initial: WorkflowFlowNode[], options: NodeExecutionOptions = {}): Promise<WorkflowFlowNode[]> {
    let runtime = initial;
    let node = runtime.find((item) => item.id === nodeId);
    if (!node) return runtime;
    const nodeStartedAtMs = Date.now();
    const imageRunCanvasId=activeCanvasId;
    const rejectBeforeRun = (detail: string): never => {
      recordGenerationDiagnostic({
        nodeId,
        title: node!.data.title,
        kind: node!.data.kind,
        modelId: node!.data.modelId || undefined,
        trigger: options.trigger,
        phase: "node-total",
        status: "failed",
        startedAt: new Date(nodeStartedAtMs).toISOString(),
        durationMs: Date.now() - nodeStartedAtMs,
        detail,
      });
      throw new Error(detail);
    };
    const recoveringAcceptedMedia = (node.data.kind === "video" && Boolean(node.data.taskId) && !options.forceVideoResubmit)
      || (node.data.kind === "image" && Boolean(node.data.pendingPersistUrl || node.data.imageClientTraceId && node.data.imageClientIdempotencyKey));
    if (!recoveringAcceptedMedia && (node.data.kind === "image" || node.data.kind === "video")) {
      const model = node.data.kind === "image" ? currentModelCatalogRef.current.imageModels.find(item => item.id === node!.data.modelId) : currentModelCatalogRef.current.videoModels.find(item => item.id === node!.data.modelId);
      const issue = canvasModelAdmissionIssue(model, node.data.kind);
      if (issue) rejectBeforeRun(issue);
    }
    if ((node.data.kind === "image" || node.data.kind === "video") && node.data.modelLocked
      && node.data.lockedModelId && node.data.modelId !== node.data.lockedModelId) {
      rejectBeforeRun(`${node.data.title} 已锁定生成模型，不能在本轮中途更换`);
    }
    if (!options.ignoreGenerationBlock
      && (node.data.kind === "image" || node.data.kind === "video")
      && node.data.generationBlockedReason
      && !isDirectorQualityAdvisory(node.data.generationBlockedReason)) {
      rejectBeforeRun(node.data.generationBlockedReason);
    }
    const decorationPreflightError = animeDecorationPreflightError(node, runtime);
    if (decorationPreflightError) {
      console.warn("[free-canvas:quality-advisory]", {
        nodeId,
        title: node.data.title,
        detail: decorationPreflightError,
      });
    }
    if(node.data.kind==="image" && node.data.imageDeliveryReceipt?.deliveryMode==="inline_ephemeral" && node.data.imageDeliveryReceipt.generationCompleted) {
      onNotice("图片已生成且费用收据已保留；临时图片仅原页面可用，不会自动重新生成");return runtime;
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if ((node.data.kind === "image" || node.data.kind === "video" || node.data.kind === "upload") && !token) {
      onRequireLogin();
      rejectBeforeRun("请先连接主平台");
    }
    if (
      node.data.kind === "video"
      && node.data.status === "failed"
      && !node.data.outputUrl
      && !node.data.taskId
      && node.data.clientRequestId
      && options.forceVideoResubmit !== true
    ) {
      rejectBeforeRun("视频提交结果不确定，已阻止自动重复提交；请先在媒体历史核对，再使用“重新生成”显式创建新任务");
    }
    const shouldResubmitFailedVideo = node.data.kind === "video"
      && !node.data.outputUrl
      && options.forceVideoResubmit === true;
    runtime = replaceRuntimeNode(runtime, nodeId, {
      status: "running",
      error: undefined,
      ...(shouldResubmitFailedVideo ? { taskId: "", providerContentUrl: "" } : {}),
      progressMessage: node.data.kind === "image"
        ? "正在准备图片生成"
        : node.data.kind === "video"
          ? "正在准备视频任务"
          : "正在应用节点内容",
    });
    node = runtime.find((item) => item.id === nodeId)!;

    try {
      const domain = { nodes: asDomainNodes(runtime), edges: edgesRef.current };
      const inputs = collectWorkflowInputs(domain, nodeId);
      const prompt = resolveWorkflowPrompt(node.data.prompt, inputs);
      let outputUrl = node.data.outputUrl;
      let outputText = node.data.outputText;
      let taskId = shouldResubmitFailedVideo ? "" : node.data.taskId;
      let providerContentUrl = shouldResubmitFailedVideo ? "" : node.data.providerContentUrl;
      const generatedHistory: WorkflowNodeData["history"] = [];
      let publicModelName = node.data.publicModelName;
      let estimatedCost = node.data.estimatedCost;
      let actualCost = Number(node.data.actualCost || 0);
      let creditsCharged = node.data.creditsCharged;
      let retailPriceRmb = node.data.retailPriceRmb;
      let billingUnit = node.data.billingUnit;
      let cashRemaining = node.data.cashRemaining;
      let billingReferenceId = node.data.billingReferenceId;
      let assetId = node.data.assetId;
      let storageKey = node.data.storageKey;
      let historyRecordId = node.data.historyRecordId;
      let completedAt = node.data.completedAt;

      if (node.data.kind === "text") {
        outputText = prompt;
        if (!outputText) throw new Error("文本节点没有内容");
      } else if (node.data.kind === "upload") {
        const audioMode = isAudioUpload(node.data) ? node.data.audioMode || "upload" : "upload";
        if (isAudioUpload(node.data) && audioMode !== "upload") {
          if (!prompt.trim()) throw new Error(audioMode === "tts" ? "请先填写朗读文案" : "请先填写 AI 音频提示词");
          const pricing = canvasAudioPricing(audioMode, node.data.voiceId, voiceOptions, voicePricing);
          if (!pricing) throw new Error("该音频模型尚未配置主站售价，已停止提交以避免错误扣费");
          const voice = audioMode === "tts"
            ? voiceOptions.find((item) => item.id === node.data.voiceId)
            : undefined;
          if (audioMode === "tts" && !voice) throw new Error("请选择主站已发布音色");

          const requestFingerprint = JSON.stringify({
            mode: audioMode,
            modelId: pricing.modelId,
            voiceId: voice?.id || "",
            prompt: prompt.trim(),
          });
          const clientRequestId = node.data.clientRequestFingerprint === requestFingerprint && node.data.clientRequestId
            ? node.data.clientRequestId
            : `canvas-audio-${crypto.randomUUID()}`;
          runtime = replaceRuntimeNode(runtime, nodeId, {
            clientRequestId,
            clientRequestFingerprint: requestFingerprint,
            modelId: pricing.modelId,
            publicModelName: pricing.name,
            estimatedCost: pricing.sellPrice,
            status: "running",
            progressMessage: audioMode === "tts" ? "正在使用主站音色生成语音" : "正在使用主站模型生成音频",
          });

          const generatedResponse = await responseJson<{
            success?: boolean;
            data?: {
              terminalStatus?: string;
              persisted?: boolean;
              generationId?: string;
              providerTaskId?: string;
              audioUrl?: string;
              cost?: number;
              retailPrice?: number;
              asset?: { id?: string; storageKey?: string; storageProvider?: string };
              billing?: {
                modelId?: string;
                modelName?: string;
                unit?: string;
                sellPriceRmb?: number;
                creditsCharged?: number;
              };
            };
          }>(await fetch("/api/voice/tts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              "Idempotency-Key": clientRequestId,
            },
            body: JSON.stringify(audioMode === "seed-audio"
              ? { textPrompt: prompt.trim(), clientRequestId }
              : { text: prompt.trim(), voiceId: voice!.id, clientRequestId }),
          }));
          const generated = generatedResponse.data;
          if (generatedResponse.success === false
            || generated?.terminalStatus !== "completed"
            || generated.persisted !== true
            || !generated.audioUrl
            || !generated.generationId
            || !generated.asset?.id
            || !generated.asset.storageKey) {
            throw new Error("音频模型未返回已完成且已永久保存的资产，未创建画布结果");
          }

          outputUrl = generated.audioUrl;
          taskId = generated.providerTaskId || generated.generationId;
          publicModelName = generated.billing?.modelName || pricing.name;
          estimatedCost = pricing.sellPrice;
          retailPriceRmb = Number(generated.retailPrice ?? generated.billing?.sellPriceRmb ?? pricing.sellPrice);
          actualCost = retailPriceRmb;
          creditsCharged = Number(generated.cost ?? generated.billing?.creditsCharged ?? 0);
          billingUnit = generated.billing?.unit || pricing.unit;
          billingReferenceId = `voice:${generated.generationId}`;
          assetId = generated.asset.id;
          storageKey = generated.asset.storageKey;
          historyRecordId = generated.generationId;
          completedAt = new Date().toISOString();
        } else {
          if (!outputUrl && !node.data.optionalInput) throw new Error("这个手动素材节点尚未选择文件；自动剧情流程不需要上传");
          if (!outputUrl && node.data.optionalInput) outputText = isAudioUpload(node.data)
            ? "本次未选择音频或音乐素材，后续节点继续按无外部音轨执行。"
            : "本次未选择已有图片，后续节点按全文角色与视觉设定自动生成。";
        }
      } else if (node.data.kind === "image") {
        if (!prompt) throw new Error("图片节点没有提示词或前置文本");
        const model = imageModels.find((item) => item.id === node.data.modelId);
        if (!model) throw new Error("请选择图片模型");
        const imageCapabilities = getImageModelCapabilities(model);
        const referenceImageUrls = inputs.imageUrls.length > 0
          ? inputs.imageUrls
          : ((node.data.imageMode === "image-to-image" || node.data.imageMode === "edit") && outputUrl ? [outputUrl] : []);
        const isAutomaticStoryboardKeyframe = node.data.assetRole === "storyboard-keyframe"
          || (node.data.imageMode === "image-to-image" && /(?:自动关键帧|故事板参考图)/u.test(node.data.title));
        if ((node.data.imageMode === "image-to-image" || node.data.imageMode === "edit") && referenceImageUrls.length === 0 && !isAutomaticStoryboardKeyframe) {
          throw new Error("你主动选择了图生图或编辑模式，请连接已有图片；自动关键帧请切回文生图");
        }
        if (referenceImageUrls.length > 0 && !imageCapabilities.supportsReferenceInput) {
          throw new Error(`${model.name} 不支持图像输入，请切换为支持该能力的图片模型`);
        }
        if (referenceImageUrls.length > imageCapabilities.maxReferenceImages) {
          throw new Error(`${model.name} 最多接收 ${imageCapabilities.maxReferenceImages} 张参考图，当前镜头连接了 ${referenceImageUrls.length} 张`);
        }
        const imageCount = Math.max(1, Math.min(4, node.data.imageCount || 1));
        let pendingOriginalImageAttempt = unresolvedCanvasImageAttempt(node.data, imageCount);
        publicModelName = model.name;
        estimatedCost = Number(model.selling_price || 0) * imageCount;
        const referenceGuide = inputs.imageSources
          .map((source, index) => `@参考图${index + 1}：${source.title}`)
          .join("\n");
        const generationPrompt = node.data.imageMode === "image-to-image"
          ? isAutomaticStoryboardKeyframe
            ? referenceImageUrls.length > 0
              ? composeStoryboardReferenceGenerationPrompt(prompt, referenceGuide)
              : `${prompt}\n角色定妆图暂未返回，本镜按完整角色设定与分镜提示词直接生成；必须保留角色身份、外观、动作、道具和语义包装。`
            : `${prompt}\n保持参考图主体身份、服装、色彩和场景一致，仅改变摄影机角度与景别。`
          : node.data.imageMode === "edit"
            ? `${prompt}\n基于参考图执行局部编辑，未明确要求修改的内容必须保持不变。`
            : prompt;
        for (let index = 0; index < imageCount; index += 1) {
          const previouslyPersisted = node.data.history.find((item) => (
            item.batchIndex === index && item.modelId === model.id && Boolean(item.outputUrl)
          ));
          if (previouslyPersisted?.outputUrl) {
            outputUrl = previouslyPersisted.outputUrl;
            taskId = previouslyPersisted.taskId || taskId;
            billingReferenceId = previouslyPersisted.billingReferenceId || billingReferenceId;
            assetId = previouslyPersisted.assetId || assetId;
            storageKey = previouslyPersisted.storageKey || storageKey;
            historyRecordId = previouslyPersisted.historyRecordId || historyRecordId;
            continue;
          }
          let generatedDelivery: GeneratedImageClientDelivery | undefined;
          let generatedUrl = "";
          let generatedTraceId = "";
          let generatedBillingReferenceId: string | undefined;
          let generatedAssetId = "";
          let generatedStorageKey = "";
          let generatedCharge = 0;
          let generatedWidth: number | undefined;
          let generatedHeight: number | undefined;
          const indexedPrompt = imageCount > 1
            ? `${generationPrompt}\n这是同批次第 ${index + 1} 张，请保持统一风格并提供有区分度的构图。`
            : generationPrompt;
          const imageRequestFingerprint = JSON.stringify({
            modelId: model.id,
            prompt: indexedPrompt,
            aspectRatio: node.data.aspectRatio,
            resolution: node.data.resolution || "2K",
            referenceImageRefs: referenceImageUrls.map((url) => stableCanvasMediaIdentity(url, runtime)),
            referenceUsage: isAutomaticStoryboardKeyframe ? "character-identity" : "general",
            batchIndex: index,
          });
          assertCanvasImageAttemptRecovery(pendingOriginalImageAttempt, index, imageRequestFingerprint);
          const canReuseImageAttempt = node.data.imageRequestFingerprint === imageRequestFingerprint
            && Boolean(node.data.imageClientTraceId)
            && Boolean(node.data.imageClientIdempotencyKey);
          const canResumePersistence = canReuseImageAttempt
            && node.data.pendingPersistIndex === index
            && Boolean(node.data.pendingPersistUrl);
          const clientTraceId = canReuseImageAttempt ? node.data.imageClientTraceId! : crypto.randomUUID();
          const clientIdempotencyKey = canReuseImageAttempt
            ? node.data.imageClientIdempotencyKey!
            : `canvas-image-${crypto.randomUUID()}`;
          runtime = replaceRuntimeNode(runtime, nodeId, {
            imageClientTraceId: clientTraceId,
            imageClientIdempotencyKey: clientIdempotencyKey,
            imageRequestFingerprint,
          });
          const maxAspectAttempts = 1;
          for (let aspectAttempt = 1; aspectAttempt <= maxAspectAttempts; aspectAttempt += 1) {
            runtime = replaceRuntimeNode(runtime, nodeId, {
              progressMessage: aspectAttempt === 1
                ? `正在生成图片 ${index + 1}/${imageCount}`
                : `画幅不符，正在自动重试 ${aspectAttempt}/${maxAspectAttempts}`,
            });
            const retryRatioInstruction = aspectAttempt === 1
              ? ""
              : `\n上一次返回的图片实际尺寸不符合${node.data.aspectRatio}。本次必须重新构图并输出严格${node.data.aspectRatio}画幅，不得沿用竖图、方图、旋转画布或留白。`;
            const generationStartedAtMs = Date.now();
            let candidateUrl = canResumePersistence ? node.data.pendingPersistUrl || "" : "";
            let candidateAssetId = canResumePersistence ? node.data.assetId || "" : "";
            let candidateStorageKey = canResumePersistence ? node.data.storageKey || "" : "";
            let candidateWidth = canResumePersistence ? node.data.pendingPersistWidth : undefined;
            let candidateHeight = canResumePersistence ? node.data.pendingPersistHeight : undefined;
            let returnedTraceId = clientTraceId;
            let returnedOperationId = canResumePersistence && node.data.billingReferenceId?.startsWith("image:")
              ? node.data.billingReferenceId.slice("image:".length)
              : "";
            let returnedBillingReferenceId = canResumePersistence ? node.data.billingReferenceId : undefined;
            if (canResumePersistence) {
              generatedCharge = Number(node.data.pendingPersistCharge || 0);
              cashRemaining = node.data.pendingPersistCashRemaining ?? cashRemaining;
              taskId = node.data.taskId || clientTraceId;
              billingReferenceId = returnedBillingReferenceId;
              runtime = replaceRuntimeNode(runtime, nodeId, { progressMessage: `正在恢复图片 ${index + 1}/${imageCount} 的永久保存，不会重新生成或扣费` });
            } else {
              const generated = await requestImageJsonWithRetry<{
                recordId?:string;deliveryMode?:"provider_url"|"inline_ephemeral";
                images?: Array<{ url: string; width?: number; height?: number; assetId?: string; storageKey?: string;recordId?:string;deliveryMode?:"provider_url"|"inline_ephemeral" }>;
                cashCharged?: number;
                cashRemaining?: number | null;
                modelUsed?: string;
                taskId?: string;
                traceId?: string;
                operationId?: string;
                billingReferenceId?: string;
              }>(() => {
                const latestIssue = !canReuseImageAttempt && canvasModelAdmissionIssue(currentModelCatalogRef.current.imageModels.find(item => item.id === model.id), "image");
                if (latestIssue) throw new Error(latestIssue);
                return fetch("/api/bridge/image/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(180_000),
                body: JSON.stringify({
                  prompt: `${indexedPrompt}${retryRatioInstruction}`,
                  mode: "local",
                  modelId: model.id,
                  aspectRatio: node.data.aspectRatio,
                  resolution: node.data.resolution || "2K",
                  referenceImageUrls,
                  referenceUsage: isAutomaticStoryboardKeyframe ? "character-identity" : "general",
                  historySurface: "free-canvas",
                  clientTraceId,
                  clientIdempotencyKey,
                  strictSingleSubmit: true,
                  noRetry: true,
                  ...(canReuseImageAttempt ? { resumeDeliveryOnly: true } : {}),
                  clientNodeId: node.id,
                  clientNodeTitle: node.data.title,
                }),
              }); }, (progressMessage) => {
                runtime = replaceRuntimeNode(runtime, nodeId, { progressMessage });
              });
              const candidate = generated.images?.[0];
              const receipt=projectGeneratedImageClientReceipt(generated);
              if(receipt) {
                try {generatedDelivery=await resolveGeneratedImageClientDelivery(generated);}catch {generatedDelivery={kind:receipt.deliveryMode,receipt,url:"",revoke:()=>{}};}
              }
              candidateUrl = generatedDelivery?.url || candidate?.url || "";
              candidateAssetId = candidate?.assetId || "";
              candidateStorageKey = candidate?.storageKey || "";
              candidateWidth = candidate?.width;
              candidateHeight = candidate?.height;
              returnedTraceId = generated.taskId || generated.traceId || clientTraceId;
              returnedOperationId = generated.operationId?.trim() || "";
              returnedBillingReferenceId = generated.billingReferenceId?.trim()
                || (returnedOperationId ? `image:${returnedOperationId}` : undefined);
              generatedCharge = Number(generated.cashCharged || 0);
              const alreadyAccounted = Boolean(
                returnedBillingReferenceId
                && node.data.billingReferenceId === returnedBillingReferenceId,
              );
              if (!alreadyAccounted) actualCost += generatedCharge;
              cashRemaining = generated.cashRemaining ?? cashRemaining;
              publicModelName = generated.modelUsed || publicModelName || model.name;
            }
            if (!candidateUrl && !generatedDelivery?.receipt) throw new Error(`图片模型没有返回第 ${index + 1} 张结果`);
            if (!generatedDelivery?.receipt && !canResumePersistence && (!candidateAssetId || !candidateStorageKey || !returnedOperationId)) {
              throw new Error(`第 ${index + 1} 张图片缺少永久资产或计费操作标识，已停止二次转存`);
            }
            billingReferenceId = returnedBillingReferenceId || billingReferenceId;
            runtime = replaceRuntimeNode(runtime, nodeId, {
              taskId: returnedTraceId,
              publicModelName,
              estimatedCost,
              actualCost,
              cashRemaining,
              billingReferenceId,
              assetId: candidateAssetId || undefined,
              storageKey: candidateStorageKey || undefined,
              pendingPersistUrl: generatedDelivery?.receipt ? undefined : candidateUrl,
              pendingPersistIndex: index,
              pendingPersistWidth: candidateWidth,
              pendingPersistHeight: candidateHeight,
              pendingPersistCharge: generatedCharge,
              pendingPersistCashRemaining: cashRemaining,
            });
            console.info("[canvas-batch] image response received", { nodeId, title: node.data.title, clientTraceId });
            runtime = replaceRuntimeNode(runtime, nodeId, { progressMessage: `图片 ${index + 1}/${imageCount} 已返回，正在检查 ${node.data.aspectRatio} 画幅` });
            if(generatedDelivery?.receipt) {generatedUrl=generatedDelivery.url;generatedTraceId=returnedTraceId;generatedBillingReferenceId=returnedBillingReferenceId;break;}
            try {
              await validateImageAspectRatio(candidateUrl, node.data.aspectRatio, { width: candidateWidth, height: candidateHeight });
              console.info("[canvas-batch] image aspect accepted", { nodeId, title: node.data.title, clientTraceId });
              generatedUrl = candidateUrl;
              generatedTraceId = returnedTraceId;
              generatedBillingReferenceId = returnedBillingReferenceId;
              generatedAssetId = candidateAssetId;
              generatedStorageKey = candidateStorageKey;
              taskId = returnedTraceId;
              generatedWidth = candidateWidth;
              generatedHeight = candidateHeight;
              recordGenerationDiagnostic({
                nodeId,
                title: node.data.title,
                kind: node.data.kind,
                modelId: model.id,
                phase: "image-generate",
                status: "succeeded",
                startedAt: new Date(generationStartedAtMs).toISOString(),
                durationMs: Date.now() - generationStartedAtMs,
                detail: `trace=${clientTraceId}；图片 ${index + 1}/${imageCount}，画幅检查通过${aspectAttempt > 1 ? `，第 ${aspectAttempt} 次尝试` : ""}`,
              });
              break;
            } catch (error) {
              if (aspectAttempt >= maxAspectAttempts) throw error;
            }
          }
          if(generatedDelivery?.receipt) {
            if(!deliveryPageActiveRef.current || deliveryCanvasRef.current!==imageRunCanvasId || !nodesRef.current.some(n=>n.id===nodeId)){generatedDelivery.revoke();return runtime;}
            imageDeliveryReleases.current.get(generatedDelivery.receipt.recordId)?.();imageDeliveryReleases.current.set(generatedDelivery.receipt.recordId,generatedDelivery.revoke);
            const receipt=generatedDelivery.receipt;
            outputUrl=generatedDelivery.kind==="provider_url"?generatedDelivery.url:"";
            completedAt=new Date().toISOString();taskId=generatedTraceId||clientTraceId;billingReferenceId=receipt.billingReferenceId;assetId=undefined;storageKey=undefined;historyRecordId=undefined;
            const receiptItem:WorkflowNodeData["history"][number]={id:crypto.randomUUID(),batchIndex:index,outputUrl,imagePreviewUrl:generatedDelivery.kind==="inline_ephemeral"?generatedDelivery.url:undefined,modelId:model.id,publicModelName,actualCost:receipt.cashCharged,taskId:generatedTraceId||clientTraceId,billingReferenceId:receipt.billingReferenceId,imageDeliveryReceipt:receipt,imageRef:generatedDelivery.imageRef,createdAt:completedAt};
            runtime=replaceRuntimeNode(runtime,nodeId,{outputUrl,imagePreviewUrl:generatedDelivery.kind==="inline_ephemeral"?generatedDelivery.url:undefined,imageDeliveryReceipt:receipt,imageRef:generatedDelivery.imageRef,actualCost,cashRemaining,billingReferenceId:receipt.billingReferenceId,taskId:generatedTraceId||clientTraceId,assetId:undefined,storageKey:undefined,historyRecordId:undefined,pendingPersistUrl:undefined,pendingPersistIndex:undefined,completedAt});
            generatedHistory.unshift(receiptItem);
            pendingOriginalImageAttempt = null;
            continue;
          }
          if (!generatedUrl) throw new Error(`第 ${index + 1} 张图片未通过 ${node.data.aspectRatio} 画幅检查`);
          runtime = replaceRuntimeNode(runtime, nodeId, { progressMessage: `图片 ${index + 1}/${imageCount} 已生成，正在保存` });
          const persistStartedAtMs = Date.now();
          const persistedResponse = await responseJson<{
            url?: string;
            assetId?: string;
            key?: string;
            storageKey?: string;
            historyRecordId?: string;
            createdAt?: string;
          }>(await fetch(generatedStorageKey ? "/api/image-workbench/persist" : "/api/bridge/image/persist", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: generatedStorageKey
              ? JSON.stringify({
                  url: generatedUrl,
                  index: index + 1,
                  clientTraceId,
                  storageKey: generatedStorageKey,
                  ...(generatedAssetId ? { assetId: generatedAssetId } : {}),
                })
              : JSON.stringify({
                  url: generatedUrl,
                  clientTraceId: generatedTraceId,
                  title: node.data.title,
                  modelId: model.id,
                  width: generatedWidth,
                  height: generatedHeight,
                  cashCharged: generatedCharge,
                  cashRemaining,
                }),
          }));
          const persisted = {
            ...persistedResponse,
            storageKey: persistedResponse.storageKey || persistedResponse.key,
          };
          console.info("[canvas-batch] image persisted", { nodeId, title: node.data.title, hasUrl: Boolean(persisted.url) });
          recordGenerationDiagnostic({
            nodeId,
            title: node.data.title,
            kind: node.data.kind,
            modelId: model.id,
            phase: "image-persist",
            status: "succeeded",
            startedAt: new Date(persistStartedAtMs).toISOString(),
            durationMs: Date.now() - persistStartedAtMs,
            detail: `图片 ${index + 1}/${imageCount}`,
          });
          if (!persisted.url || !persisted.assetId || !persisted.storageKey || !persisted.historyRecordId) {
            throw new Error(`第 ${index + 1} 张图片永久资产登记不完整；已保留原任务与待保存结果，请勿重新生成`);
          }
          outputUrl = persisted.url;
          assetId = persisted.assetId || assetId;
          storageKey = persisted.storageKey || storageKey;
          historyRecordId = persisted.historyRecordId || historyRecordId;
          completedAt = persisted.createdAt || new Date().toISOString();
          const persistedHistoryItem: WorkflowNodeData["history"][number] = {
            id: crypto.randomUUID(),
            batchIndex: index,
            outputUrl,
            modelId: model.id,
            publicModelName,
            actualCost: generatedCharge,
            taskId: generatedTraceId,
            billingReferenceId: generatedBillingReferenceId,
            assetId,
            storageKey,
            historyRecordId,
            createdAt: completedAt,
          };
          runtime = replaceRuntimeNode(runtime, nodeId, {
            outputUrl,
            taskId: generatedTraceId,
            billingReferenceId: generatedBillingReferenceId,
            assetId,
            storageKey,
            historyRecordId,
            completedAt,
            pendingPersistUrl: undefined,
            pendingPersistIndex: undefined,
            pendingPersistWidth: undefined,
            pendingPersistHeight: undefined,
            pendingPersistCharge: undefined,
            pendingPersistCashRemaining: undefined,
            history: [persistedHistoryItem, ...(runtime.find((item) => item.id === nodeId)?.data.history || [])]
              .filter((item, itemIndex, items) => items.findIndex((candidate) => candidate.batchIndex === item.batchIndex && candidate.taskId === item.taskId) === itemIndex)
              .slice(0, 20),
          });
          generatedHistory.unshift(persistedHistoryItem);
          pendingOriginalImageAttempt = null;
        }
        if (pendingOriginalImageAttempt) throw new Error("原图片请求尚未确认，请先核对历史；不会创建新请求");
      } else if (node.data.kind === "video") {
        if (!prompt) throw new Error("视频节点没有提示词或前置文本");
        const sourceIds = new Set(edgesRef.current.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
        if(runtime.some(source=>sourceIds.has(source.id) && source.data.imageDeliveryReceipt?.deliveryMode==="inline_ephemeral"))throw new Error("临时图片仅当前页面可预览下载，当前视频通道不支持这类输入；本次未提交或扣费");
        const referenceSources=runtime.filter(source=>sourceIds.has(source.id) && source.data.kind==="image");
        const videoImageUrls = inputs.imageUrls.map((url) => {
          const source = referenceSources.find((item) => item.data.outputUrl === url || item.data.imagePreviewUrl === url);
          return source?.data.imageRef ? generatedImageReferenceUri(source.data.imageRef) : url;
        });
        const unverifiedReferences = runtime.filter((source) => (
          sourceIds.has(source.id)
          && source.data.assetRole === "storyboard-keyframe"
          && source.data.referenceValidationStatus !== "verified"
        ));
        if (unverifiedReferences.length > 0) {
          throw new Error(`参考图尚未确认：${unverifiedReferences.map((source) => source.data.title).join("、")}。预览后点击 ✓ 才能提交视频`);
        }
        const model = videoModels.find((item) => item.id === node.data.modelId);
        if (!model) throw new Error("请选择视频模型");
        if (node.data.aspectRatio !== "16:9" && node.data.aspectRatio !== "9:16") {
          throw new Error("当前视频服务只支持 16:9 或 9:16，请调整画面比例");
        }
        const timing = resolveVideoDuration(model, node.data.durationSeconds);
        if (!timing.supported) throw new Error(`当前模型最长支持 ${timing.maxDuration} 秒，请缩短镜头或切换模型`);
        if (node.data.requiresExactDuration && !model.supportsImageInput) {
          throw new Error("当前剧情镜头需要关键帧输入，请选择支持参考图的视频模型");
        }
        const imageUrl = videoImageUrls[0] || "";
        if (imageUrl && !model.supportsImageInput) {
          throw new Error(`${model.name} 不支持关键帧输入，请切换关键帧驱动的视频模型`);
        }
        if (model.requiresImage && !imageUrl) throw new Error("当前视频模型需要前置关键帧；自动流程会先执行生图节点");
        if (node.data.videoMode === "multimodal" && inputs.imageUrls.length < 2) {
          throw new Error("首尾帧模式需要连接两张图片：首帧和尾帧");
        }
        const { max: maxReferenceAudios, min: minReferenceAudios } = getVideoAudioReferenceLimits(model);
        if (inputs.audioUrls.length > 0 && !model.supportsAudioInput) {
          throw new Error(`${model.name} 不支持音频输入，请移除音频连线或切换模型`);
        }
        if (inputs.audioUrls.length > maxReferenceAudios) {
          throw new Error(`${model.name} 最多接收 ${maxReferenceAudios} 条音频，当前连接了 ${inputs.audioUrls.length} 条`);
        }
        if (inputs.audioUrls.length < minReferenceAudios) {
          throw new Error(`${model.name} 至少需要 ${minReferenceAudios} 条音频，当前只有 ${inputs.audioUrls.length} 条可用音频`);
        }

        const serverIdempotencyVerified = model.provider === "autodl_h3_selfhost";
        const videoCharge = resolveVideoCharge(model, node.data.resolution, node.data.durationSeconds);
        publicModelName = model.name;
        estimatedCost = videoCharge.publicPrice;
        const clientRequestFingerprint = JSON.stringify({
          modelId: model.id,
          prompt,
          imageRefs: videoImageUrls.map((url) => parseGeneratedImageReferenceUri(url) ? url : stableCanvasMediaIdentity(url, runtime)),
          audioRefs: inputs.audioUrls.map((url) => stableCanvasMediaIdentity(url, runtime)),
          duration: timing.target,
          aspectRatio: node.data.aspectRatio,
          resolution: coerceCanvasVideoResolution(model, node.data.resolution),
          videoMode: node.data.videoMode,
          ambientSoundOnly: Boolean(node.data.ambientSoundOnly),
        });
        const clientAttempt = resolveAutodlH3ClientAttempt({
          enabled: true,
          fingerprint: clientRequestFingerprint,
          previousRequestId: node.data.clientRequestId,
          previousFingerprint: node.data.clientRequestFingerprint,
          // Explicit regenerate/duplicate actions clear both fields before execution.
          previousTerminal: false,
          createRequestId: () => `${serverIdempotencyVerified ? "h3" : "canvas"}-video-${crypto.randomUUID()}`,
        });
        const clientRequestId = clientAttempt.clientRequestId;
        if (clientRequestId && (
          node.data.clientRequestId !== clientRequestId
          || node.data.clientRequestFingerprint !== clientRequestFingerprint
        )) {
          runtime = replaceRuntimeNode(runtime, nodeId, { clientRequestId, clientRequestFingerprint });
        }

        if (!taskId) {
          runtime = replaceRuntimeNode(runtime, nodeId, { progressMessage: "等待视频提交时隙" });
          let submitted: CanvasVideoSubmission | null = null;
          const submitStartedAtMs = Date.now();
          for (let attempt = 1; attempt <= VIDEO_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
            await waitForVideoSubmissionSlot();
            const latestIssue = canvasModelAdmissionIssue(currentModelCatalogRef.current.videoModels.find(item => item.id === model.id), "video");
            if (latestIssue) throw new Error(latestIssue);
            runtime = replaceRuntimeNode(runtime, nodeId, {
              progressMessage: attempt === 1 ? "正在提交视频任务" : `生成服务繁忙，正在第 ${attempt} 次重试提交`,
            });
            const response = await fetch("/api/bridge/video/generate", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                model_id: model.id,
                prompt,
                ...Object.fromEntries(Object.entries(videoWorkflowImageRequestFields({
                  imageUrl,
                  referenceImageUrls: videoImageUrls.slice(1, Math.max(1, model.maxReferenceImages || 1)),
                  referenceImageUrl: node.data.videoMode === "multimodal" && videoImageUrls.length > 2 ? videoImageUrls[1] : undefined,
                  lastFrameUrl: node.data.videoMode === "multimodal" ? videoImageUrls.at(-1) : undefined,
                })).filter(([, value]) => value !== "")),
                audio_url: inputs.audioUrls[0] || undefined,
                reference_audio_urls: inputs.audioUrls.slice(1, maxReferenceAudios),
                duration: timing.target,
                aspect_ratio: node.data.aspectRatio,
                resolution_tier: coerceCanvasVideoResolution(model, node.data.resolution),
                negative_prompt: node.data.ambientSoundOnly
                  ? "background music, soundtrack, score, BGM, song, singing, narration, voice-over, dubbing, dialogue, human speech"
                  : undefined,
                task_label: node.data.title,
                 batch_id: "manual-workflow",
                 batch_topic: node.id,
                 surface: "free-canvas",
                 ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
              }),
            });
            if (response.ok) {
              submitted = await responseJson<CanvasVideoSubmission>(response);
              break;
            }
            const errorPayload = await response.json().catch(() => ({})) as { error?: string; error_code?: string; upstream_error?: string };
            const deterministicUpstreamError = response.status === 424
              || errorPayload.error_code === "MODEL_CHANNEL_UNAVAILABLE"
              || /(?:API|upstream)\s*400|supported only|requires (?:a )?reference image|not supported|model_not_found|no available channel|当前没有可用通道|模型通道不可用|模型(?:不存在|已下架|不支持)|无可用(?:模型)?通道/i.test(`${errorPayload.error || ""} ${errorPayload.upstream_error || ""}`);
            const retryable = serverIdempotencyVerified
              && (response.status === 429 || (response.status >= 500 && !deterministicUpstreamError));
            if (!retryable || attempt >= VIDEO_SUBMIT_MAX_ATTEMPTS) {
              if (!isAmbiguousAutodlH3SubmissionStatus(response.status)) {
                runtime = replaceRuntimeNode(runtime, nodeId, {
                  clientRequestId: undefined,
                  clientRequestFingerprint: undefined,
                });
              }
              if (!serverIdempotencyVerified && (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500)) {
                throw new Error(`视频提交响应不确定，已停止自动重提以避免重复任务或扣费；请先到媒体历史核对，再显式选择重新生成。${errorPayload.error ? ` ${errorPayload.error}` : ""}`);
              }
              throw new Error(errorPayload.error || `视频任务提交失败 (${response.status})`);
            }
            const backoffMs = Math.min(30_000, VIDEO_BATCH_SUBMIT_INTERVAL_MS * attempt);
            replaceRuntimeNode(nodesRef.current, nodeId, { progressMessage: `生成服务暂时异常，${Math.round(backoffMs / 1000)} 秒后重试` });
            await delay(backoffMs);
          }
          if (!submitted) throw new Error("视频任务提交失败，请稍后重试");
          recordGenerationDiagnostic({
            nodeId,
            title: node.data.title,
            kind: node.data.kind,
            modelId: model.id,
            phase: "video-submit",
            status: "succeeded",
            startedAt: new Date(submitStartedAtMs).toISOString(),
            durationMs: Date.now() - submitStartedAtMs,
          });
          if (!submitted.task_id) throw new Error("视频任务没有返回任务 ID");
          taskId = submitted.task_id;
          providerContentUrl = submitted.content_url || "";
          publicModelName = submitted.model_name || publicModelName || model.name;
          // The public price is the estimate. A synchronous admin response may
          // legitimately return price=0 because it represents the actual
          // charged amount, so it must not erase the public estimate.
          estimatedCost = Number(estimatedCost ?? videoCharge.publicPrice ?? 0);
          actualCost = Number(
            submitted.status === "completed" && submitted.video_url
              ? submitted.cashCharged ?? submitted.priceCharged ?? submitted.price ?? actualCost ?? 0
              : submitted.cashCharged ?? submitted.priceCharged ?? actualCost ?? 0,
          );
          cashRemaining = submitted.cashRemaining ?? cashRemaining;
          billingReferenceId = `video:${taskId}`;
          runtime = replaceRuntimeNode(runtime, nodeId, {
            taskId,
            providerContentUrl,
            publicModelName,
            estimatedCost,
            actualCost,
            cashRemaining,
            billingReferenceId,
            status: "running",
            progressMessage: "任务已提交，等待模型生成",
          });
          if (submitted.status === "completed" && submitted.video_url) {
            outputUrl = submitted.video_url;
          }
        }
        if (!outputUrl) {
          const pollStartedAtMs = Date.now();
          const polled = await pollVideo(node, taskId, providerContentUrl, imageUrl, prompt, token!);
          outputUrl = polled.videoUrl;
          actualCost = polled.priceCharged;
          billingReferenceId = `video:${taskId}`;
          completedAt = new Date().toISOString();
          recordGenerationDiagnostic({
            nodeId,
            title: node.data.title,
            kind: node.data.kind,
            modelId: model.id,
            phase: "video-poll",
            status: "succeeded",
            startedAt: new Date(pollStartedAtMs).toISOString(),
            durationMs: Date.now() - pollStartedAtMs,
          });
        }
        outputUrl = cleanVideoPlaybackUrl(outputUrl);
        runtime = replaceRuntimeNode(runtime, nodeId, {
          status: "running",
          playbackStatus: "validating",
          playbackError: undefined,
          progressMessage: "视频已返回，正在检查在线预览",
        });
        const previewStartedAtMs = Date.now();
        try {
          await validateVideoPlayback(videoPlaybackSrc(outputUrl));
          recordGenerationDiagnostic({
            nodeId,
            title: node.data.title,
            kind: node.data.kind,
            modelId: model.id,
            phase: "video-preview",
            status: "succeeded",
            startedAt: new Date(previewStartedAtMs).toISOString(),
            durationMs: Date.now() - previewStartedAtMs,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "浏览器无法解码视频";
          replaceRuntimeNode(nodesRef.current, nodeId, {
            outputUrl,
            taskId,
            playbackStatus: "failed",
            playbackError: detail,
          });
          recordGenerationDiagnostic({
            nodeId,
            title: node.data.title,
            kind: node.data.kind,
            modelId: model.id,
            phase: "video-preview",
            status: "failed",
            startedAt: new Date(previewStartedAtMs).toISOString(),
            durationMs: Date.now() - previewStartedAtMs,
            detail,
          });
          throw new Error(`视频生成已完成，但预览检查失败：${detail}`);
        }
      }

      const historyItem = {
        id: crypto.randomUUID(),
        ...(outputUrl ? { outputUrl } : {}),
        ...(outputText ? { outputText } : {}),
        ...(taskId ? { taskId } : {}),
        ...(node.data.modelId ? { modelId: node.data.modelId } : {}),
        ...(publicModelName ? { publicModelName } : {}),
        ...(Number.isFinite(actualCost) ? { actualCost } : {}),
        ...(Number.isFinite(creditsCharged) ? { creditsCharged } : {}),
        ...(Number.isFinite(retailPriceRmb) ? { retailPriceRmb } : {}),
        ...(billingUnit ? { billingUnit } : {}),
        ...(billingReferenceId ? { billingReferenceId } : {}),
        ...(assetId ? { assetId } : {}),
        ...(storageKey ? { storageKey } : {}),
        ...(historyRecordId ? { historyRecordId } : {}),
        createdAt: new Date().toISOString(),
      };
      const requiresCandidateSelection = node.data.kind === "image"
        && Boolean(node.data.candidateSelectionRequired)
        && generatedHistory.length > 0;
      runtime = replaceRuntimeNode(runtime, nodeId, {
        outputUrl: requiresCandidateSelection ? "" : outputUrl,
        outputText,
        status: "succeeded",
        progressMessage: undefined,
        taskId: node.data.kind === "image" || node.data.kind === "video" || (isAudioUpload(node.data) && node.data.audioMode !== "upload") ? taskId : "",
        providerContentUrl: "",
        publicModelName,
        estimatedCost,
        actualCost,
        creditsCharged,
        retailPriceRmb,
        billingUnit,
        cashRemaining,
        billingReferenceId,
        assetId,
        storageKey,
        historyRecordId,
        completedAt: completedAt || new Date().toISOString(),
        ...(node.data.kind === "video" ? { playbackStatus: "ready" as const, playbackError: undefined } : {}),
        ...(node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe"
          ? { referenceValidationStatus: "pending" as const }
          : {}),
        ...(node.data.kind === "image" ? {
          pendingPersistUrl: undefined,
          pendingPersistIndex: undefined,
          pendingPersistWidth: undefined,
          pendingPersistHeight: undefined,
          pendingPersistCharge: undefined,
          pendingPersistCashRemaining: undefined,
        } : {}),
        selectedCandidateId: requiresCandidateSelection ? undefined : node.data.selectedCandidateId,
        history: node.data.kind === "image" && generatedHistory.length === 0 && node.data.history.length > 0
          ? node.data.history.slice(0, 20)
          : [...(generatedHistory.length > 0 ? generatedHistory : [historyItem]), ...node.data.history].slice(0, 20),
      });
      console.info("[canvas-batch] node completed", { nodeId, title: node.data.title, kind: node.data.kind });
      if (requiresCandidateSelection) {
        onNotice(node.data.characterName
          ? `${node.data.characterName}定妆图已生成 ${generatedHistory.length} 张，请确认后再生成关联镜头`
          : `视觉探索已生成 ${generatedHistory.length} 张独立候选，请选定一张后再批量生成`);
      }
      recordGenerationDiagnostic({
        nodeId,
        title: node.data.title,
        kind: node.data.kind,
        modelId: node.data.modelId || undefined,
        trigger: options.trigger,
        phase: "node-total",
        status: "succeeded",
        startedAt: new Date(nodeStartedAtMs).toISOString(),
        durationMs: Date.now() - nodeStartedAtMs,
      });
      onBalanceRefresh();
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : "节点执行失败";
      const latestNode = nodesRef.current.find((item) => item.id === nodeId);
      if (latestNode?.data.outputUrl) {
        runtime = replaceRuntimeNode(runtime, nodeId, {
          status: "failed",
          outputUrl: latestNode.data.outputUrl,
          progressMessage: undefined,
          error: message,
          ...(node.data.kind === "video" ? {
            playbackStatus: latestNode.data.playbackStatus || "failed",
            playbackError: latestNode.data.playbackError || message,
          } : {}),
        });
        recordGenerationDiagnostic({
          nodeId,
          title: node.data.title,
          kind: node.data.kind,
          modelId: node.data.modelId || undefined,
          trigger: options.trigger,
          phase: "node-total",
          status: "failed",
          startedAt: new Date(nodeStartedAtMs).toISOString(),
          durationMs: Date.now() - nodeStartedAtMs,
          detail: `已保留可恢复结果，但节点仍标记失败：${message}`,
        });
        throw error;
      }
      if (error instanceof VideoPollingDeferredError) {
        runtime = replaceRuntimeNode(runtime, nodeId, {
          status: "idle",
          taskId: latestNode?.data.taskId || node.data.taskId,
          providerContentUrl: latestNode?.data.providerContentUrl || node.data.providerContentUrl,
          progressMessage: "任务已提交，等待继续查询",
          error: undefined,
        });
        recordGenerationDiagnostic({
          nodeId,
          title: node.data.title,
          kind: node.data.kind,
          modelId: node.data.modelId || undefined,
          trigger: options.trigger,
          phase: "video-poll",
          status: "succeeded",
          startedAt: new Date(nodeStartedAtMs).toISOString(),
          durationMs: Date.now() - nodeStartedAtMs,
          detail: message,
        });
        throw error;
      }
      if (error instanceof BatchQueueStoppedError) {
        const submittedTaskId = latestNode?.data.taskId || node.data.taskId;
        runtime = replaceRuntimeNode(runtime, nodeId, {
          status: "idle",
          taskId: submittedTaskId,
          providerContentUrl: latestNode?.data.providerContentUrl || node.data.providerContentUrl,
          progressMessage: submittedTaskId ? "任务已提交，等待继续查询" : undefined,
          error: undefined,
        });
        recordGenerationDiagnostic({
          nodeId,
          title: node.data.title,
          kind: node.data.kind,
          modelId: node.data.modelId || undefined,
          trigger: options.trigger,
          phase: submittedTaskId ? "video-poll" : "node-total",
          status: "succeeded",
          startedAt: new Date(nodeStartedAtMs).toISOString(),
          durationMs: Date.now() - nodeStartedAtMs,
          detail: submittedTaskId
            ? "批量队列停止；已提交任务 ID 保留，后续只继续查询"
            : "批量队列停止；节点恢复为待执行，未标记失败",
        });
        throw error;
      }
      runtime = replaceRuntimeNode(runtime, nodeId, { status: "failed", progressMessage: undefined, error: message });
      recordGenerationDiagnostic({
        nodeId,
        title: node.data.title,
        kind: node.data.kind,
        modelId: node.data.modelId || undefined,
        trigger: options.trigger,
        phase: "node-total",
        status: "failed",
        startedAt: new Date(nodeStartedAtMs).toISOString(),
        durationMs: Date.now() - nodeStartedAtMs,
        detail: message,
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  function validateBatchWorkflow(currentNodes: WorkflowFlowNode[], stage: GenerationStage = "all") {
    const errors: string[] = [];
    const directorFailure = currentNodes.find((node) => (
      (node.data.kind === "image" || node.data.kind === "video")
      && isDirectorQualityAdvisory(node.data.generationBlockedReason)
    ));
    if (directorFailure) {
      errors.push("AI导演拆解未通过生产质检，批量生成已停止；请重新点击“导演拆解”，或编辑卡片后单张生成");
    }
    for (const node of currentNodes) {
      const sourceIds = new Set(edgesRef.current.filter((edge) => edge.target === node.id).map((edge) => edge.source));
      const imageSources = currentNodes.filter((source) => sourceIds.has(source.id) && (
        source.data.kind === "image"
        || (source.data.kind === "upload" && !isAudioUpload(source.data))
      ));
      const audioSources = currentNodes.filter((source) => sourceIds.has(source.id) && isAudioUpload(source.data));
      if (stage !== "videos" && node.data.kind === "text" && !node.data.prompt.trim()) errors.push(`${node.data.title}没有正文`);
      if (stage !== "videos" && node.data.kind === "upload" && !node.data.optionalInput && !node.data.outputUrl) errors.push(`${node.data.title}尚未选择文件；自动剧情流程无需该节点`);
      if (stage !== "videos" && node.data.kind === "image") {
        const obsoleteTextLockCapacityBlock = imageSources.length === 0
          && /角色一致性能力最多覆盖\s*\d+\s*个角色，本镜声明了\s*\d+\s*个角色/u.test(node.data.generationBlockedReason || "");
        if (
          node.data.generationBlockedReason
          && !isDirectorQualityAdvisory(node.data.generationBlockedReason)
          && !obsoleteTextLockCapacityBlock
        ) errors.push(`${node.data.title}：${node.data.generationBlockedReason}`);
        const model = imageModels.find((item) => item.id === node.data.modelId);
        const capabilities = getImageModelCapabilities(model);
        if (!model) errors.push(`${node.data.title}没有可用图片模型`);
        if (node.data.modelLocked && node.data.lockedModelId !== node.data.modelId) errors.push(`${node.data.title}已锁定生成模型，不能中途更换`);
        if (node.data.candidateSelectionRequired && !node.data.selectedCandidateId) {
          errors.push(node.data.history.some((item) => item.outputUrl)
            ? `${node.data.title}已生成候选，但还没有选定单张锚点`
            : `${node.data.title}需要先生成候选并选定一张`);
        }
        const hasReferenceOutput = imageSources.some((source) => Boolean(source.data.outputUrl));
        if ((hasReferenceOutput || node.data.imageMode === "image-to-image" || node.data.imageMode === "edit") && model && !capabilities.supportsReferenceInput) {
          errors.push(`${node.data.title}的模型不支持图像输入`);
        }
        if (imageSources.length > capabilities.maxReferenceImages) {
          errors.push(`${node.data.title}连接了${imageSources.length}张参考图，超过模型上限${capabilities.maxReferenceImages}张`);
        }
      }
      if (stage !== "images" && node.data.kind === "video") {
        if (node.data.generationBlockedReason && !isDirectorQualityAdvisory(node.data.generationBlockedReason)) errors.push(`${node.data.title}：${node.data.generationBlockedReason}`);
        const model = videoModels.find((item) => item.id === node.data.modelId);
        if (!model) {
          errors.push(`${node.data.title}没有可用视频模型`);
          continue;
        }
        const audioReferenceLimits = getVideoAudioReferenceLimits(model);
        if (node.data.modelLocked && node.data.lockedModelId !== node.data.modelId) errors.push(`${node.data.title}已锁定生成模型，不能中途更换`);
        if (imageSources.length === 0) errors.push(`${node.data.title}缺少前置参考图，批量视频必须先有关键帧`);
        if (imageSources.length > 0 && !model.supportsImageInput) errors.push(`${node.data.title}必须改用图生视频模型`);
        if (audioSources.some((source) => Boolean(source.data.outputUrl)) && !model.supportsAudioInput) errors.push(`${node.data.title}必须改用支持音频输入的视频模型`);
        if (audioSources.filter((source) => Boolean(source.data.outputUrl)).length > audioReferenceLimits.max) {
          errors.push(`${node.data.title}的音频输入超过模型上限${audioReferenceLimits.max}条`);
        }
        if (audioSources.filter((source) => Boolean(source.data.outputUrl)).length < audioReferenceLimits.min) {
          errors.push(`${node.data.title}至少需要${audioReferenceLimits.min}条可用音频输入`);
        }
        if (stage === "videos" && imageSources.length > 0 && !imageSources.some((source) => Boolean(source.data.outputUrl))) {
          errors.push(`${node.data.title}的关键帧尚未生成，请先点击“开始生图”`);
        }
        const unverifiedReferences = imageSources.filter((source) => (
          source.data.assetRole === "storyboard-keyframe"
          && source.data.referenceValidationStatus !== "verified"
        ));
        if (unverifiedReferences.length > 0) {
          errors.push(`${node.data.title}的参考图尚未确认，请先预览并点击 ✓ 确认`);
        }
        const timing = resolveVideoDuration(model, node.data.durationSeconds);
        if (node.data.requiresExactDuration && (!model.supportsImageInput || !timing.supported)) errors.push(`${node.data.title}不能按目标秒数直接生成；请按所选模型的原生时长设置任务`);
        if (node.data.videoMode === "multimodal" && imageSources.length < 2) errors.push(`${node.data.title}的首尾帧不足两张`);
        if (node.data.aspectRatio !== "16:9" && node.data.aspectRatio !== "9:16") errors.push(`${node.data.title}的比例不受当前视频服务支持`);
        if (!timing.supported) errors.push(`${node.data.title}的目标时长超出模型能力`);
      }
    }
    return [...new Set(errors)];
  }

  async function executeWorkflowStage(stage: GenerationStage) {
    if (runningAll) return;
    onNotice(null);
    const preflightErrors = validateBatchWorkflow(nodesRef.current, stage);
    if (preflightErrors.length > 0) {
      const stageLabel = stage === "images" ? "开始生图" : stage === "videos" ? "开始生成视频" : "全部生成";
      console.warn(`[canvas-batch] preflight rejected ${JSON.stringify({
        stage,
        nodeCount: nodesRef.current.length,
        errors: preflightErrors,
      })}`);
      onNotice(`${stageLabel}前检查未通过：${preflightErrors.slice(0, 3).join("；")}${preflightErrors.length > 3 ? `；另有${preflightErrors.length - 3}项` : ""}`);
      return;
    }
    try {
      await ensureActiveCanvasPersistedForGeneration();
    } catch {
      return;
    }
    const initialNodes = lockMediaNodeModels(stage === "images"
      ? ["image"]
      : stage === "videos" ? ["video"] : ["image", "video"]);
    updateBatchControl("running");
    nextVideoSubmitAtRef.current = 0;
    nextVideoPollAtRef.current = 0;
    setRunningAll(true);
    setActiveRunStage(stage);
    const runStartedMs = Date.now();
    const runStartedAt = new Date(runStartedMs).toISOString();
    const currentCanvasName = canvasSessions.find((session) => session.id === activeCanvasId)?.name || "画布工作流";
    const existingDraft = runHistoryRef.current.find((record) => record.canvasId === activeCanvasId && record.status === "draft");
    const runId = existingDraft?.id || crypto.randomUUID();
    const initialEvents: CanvasRunEvent[] = initialNodes.map((node) => ({
      nodeId: node.id,
      title: node.data.title,
      kind: node.data.kind,
      status: node.data.status === "succeeded" ? "succeeded" : "pending",
      modelId: node.data.modelId || undefined,
      outputUrl: node.data.outputUrl || undefined,
    }));
    const runningRecord: CanvasRunRecord = existingDraft
      ? { ...existingDraft, status: "running", storyboardSettings: currentStoryboardSettings, startedAt: runStartedAt, completedAt: undefined, durationMs: undefined, events: initialEvents, nodes: snapshotRunNodes(initialNodes), edges: edgesRef.current, error: undefined }
      : {
          id: runId,
          canvasId: activeCanvasId,
          canvasName: currentCanvasName,
          status: "running",
          sourceScript: initialNodes.find((node) => /完整文案|brief/i.test(node.data.title))?.data.prompt || "",
          styleGuide: "",
          aspectRatio: initialNodes[0]?.data.aspectRatio || defaultAspectRatio,
          promptPreset: "手动工作流",
          imageModelId: canvasImageModelId,
          videoModelId: canvasVideoModelId,
          storyboardSettings: currentStoryboardSettings,
          startedAt: runStartedAt,
          events: initialEvents,
          nodes: snapshotRunNodes(initialNodes),
          edges: edgesRef.current,
        };
    persistRunHistory((current) => [runningRecord, ...current.filter((record) => record.id !== runId)]);

    let runtime = initialNodes;
    try {
      const order = getWorkflowExecutionOrder({ nodes: asDomainNodes(initialNodes), edges: edgesRef.current });
      const stageOrder = order.filter((id) => {
        const node = initialNodes.find((item) => item.id === id);
        if (!node) return false;
        if (stage === "images") return node.data.kind === "image";
        if (stage === "videos") return node.data.kind === "video";
        return true;
      });
      const failedVideoResubmitIds = new Set(initialNodes
        .filter((node) => stageOrder.includes(node.id)
          && node.data.kind === "video"
          && node.data.status === "failed"
          && !node.data.outputUrl
          && !node.data.clientRequestId)
        .map((node) => node.id));
      runtime = queueRuntimeNodes(stageOrder);
      const failed = new Set<string>();
      const deferred = new Set<string>();
      const executeStageNode = async (id: string) => {
        await waitForBatchPermission();
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node) return;
        const hasPersistedMedia = Boolean(node.data.outputUrl)
          || (node.data.kind === "image" && Boolean(node.data.selectedCandidateId));
        const hasAcceptedMedia = hasPersistedMedia
          && (node.data.kind !== "video" || node.data.playbackStatus === "ready");
        if (node.data.status === "succeeded" && hasAcceptedMedia) {
          console.info("[canvas-batch] skip completed node", {
            nodeId: id,
            title: node.data.title,
            hasOutputUrl: Boolean(node.data.outputUrl),
            hasSelectedCandidate: Boolean(node.data.selectedCandidateId),
          });
          updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "succeeded", completedAt: new Date().toISOString(), outputUrl: node.data.outputUrl || undefined } : event) }));
          return;
        }
        const parents = edgesRef.current.filter((edge) => edge.target === id).map((edge) => edge.source);
        const mayFallbackFromMissingCharacter = node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe";
        const hasBlockingFailedParent = parents.some((parentId) => {
          if (!failed.has(parentId)) return false;
          const parent = nodesRef.current.find((item) => item.id === parentId);
          return !(mayFallbackFromMissingCharacter && parent?.data.assetRole === "character-reference");
        });
        if (hasBlockingFailedParent) {
          replaceRuntimeNode(nodesRef.current, id, { status: "failed", error: "前置节点失败，已跳过" });
          failed.add(id);
          updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "skipped", completedAt: new Date().toISOString(), error: "前置节点失败，已跳过" } : event) }));
          return;
        }
        if (activeNodeRunsRef.current.has(id)) {
          deferred.add(id);
          updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "pending", error: "节点已在另一执行链中运行" } : event) }));
          return;
        }
        activeNodeRunsRef.current.add(id);
        const nodeStartedAt = new Date().toISOString();
        updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "running", startedAt: nodeStartedAt, error: undefined } : event) }));
        try {
          await executeNode(id, nodesRef.current, {
            trigger: "batch",
            forceVideoResubmit: failedVideoResubmitIds.has(id),
          });
          const completedNode = nodesRef.current.find((item) => item.id === id);
          const completedMedia = Boolean(completedNode?.data.outputUrl)
            || (completedNode?.data.kind === "image" && Boolean(completedNode.data.selectedCandidateId));
          if (completedNode?.data.kind === "image" || completedNode?.data.kind === "video") {
            if (completedNode.data.status !== "succeeded" || !completedMedia) {
              throw new Error(`${completedNode.data.title} 未达到成功终态，不能标记为成功`);
            }
            if (completedNode.data.kind === "video" && completedNode.data.playbackStatus !== "ready") {
              throw new Error(`${completedNode.data.title} 的视频尚未通过播放检查`);
            }
          }
          updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "succeeded", completedAt: new Date().toISOString(), outputUrl: completedNode?.data.outputUrl || undefined } : event) }));
        } catch (error) {
          if (error instanceof BatchQueueStoppedError) throw error;
          if (error instanceof VideoPollingDeferredError) {
            deferred.add(id);
            updateRunRecord(runId, (record) => ({
              ...record,
              events: record.events.map((event) => event.nodeId === id ? {
                ...event,
                status: "pending",
                error: undefined,
              } : event),
            }));
            return;
          }
          failed.add(id);
          const failedNode = nodesRef.current.find((item) => item.id === id);
          updateRunRecord(runId, (record) => ({ ...record, events: record.events.map((event) => event.nodeId === id ? { ...event, status: "failed", completedAt: new Date().toISOString(), error: failedNode?.data.error || (error instanceof Error ? error.message : "节点执行失败") } : event) }));
        } finally {
          activeNodeRunsRef.current.delete(id);
        }
      };

      const executeImageQueue = async (imageOrder: string[]) => {
        const remaining = new Set(imageOrder);
        const imageIds = new Set(imageOrder);
        const inFlight = new Set<Promise<void>>();
        const startImageNode = (id: string) => {
          remaining.delete(id);
          const task = (async () => {
            await waitForImageSubmissionSlot();
            const queuedNode = nodesRef.current.find((item) => item.id === id);
            console.info("[canvas-batch] image submit", {
              nodeId: id,
              title: queuedNode?.data.title,
              inFlight: inFlight.size,
              remaining: remaining.size,
            });
            await executeStageNode(id);
            runtime = nodesRef.current;
            console.info("[canvas-batch] image slot released", { nodeId: id });
          })();
          inFlight.add(task);
          task.then(() => inFlight.delete(task), () => inFlight.delete(task));
        };

        while (remaining.size > 0 || inFlight.size > 0) {
          await waitForBatchPermission();
          const ready = imageOrder.filter((id) => {
            if (!remaining.has(id)) return false;
            const imageParents = edgesRef.current
              .filter((edge) => edge.target === id && imageIds.has(edge.source))
              .map((edge) => edge.source);
            return imageParents.every((parentId) => {
              const parent = nodesRef.current.find((item) => item.id === parentId);
              return failed.has(parentId) || parent?.data.status === "succeeded" || Boolean(parent?.data.outputUrl);
            });
          });

          ready.slice(0, Math.max(0, IMAGE_BATCH_MAX_IN_FLIGHT - inFlight.size)).forEach(startImageNode);
          if (remaining.size > 0 || inFlight.size > 0) {
            if (inFlight.size === 0) throw new Error("图片队列缺少可提交节点，请检查参考图依赖");
            await Promise.race(Array.from(inFlight));
          }
        }
      };
      const executeVideoQueue = async (videoOrder: string[]) => {
        const remaining = [...videoOrder];
        const inFlight = new Set<Promise<void>>();
        const startVideoNode = (id: string) => {
          const task = (async () => {
            await waitForBatchPermission();
            await executeStageNode(id);
            runtime = nodesRef.current;
          })();
          inFlight.add(task);
          task.then(() => inFlight.delete(task), () => inFlight.delete(task));
        };

        while (remaining.length > 0 || inFlight.size > 0) {
          while (remaining.length > 0 && inFlight.size < VIDEO_BATCH_MAX_IN_FLIGHT) {
            startVideoNode(remaining.shift()!);
          }
          if (inFlight.size > 0) await Promise.race(Array.from(inFlight));
        }
      };

      if (stage === "images") {
        await executeImageQueue(stageOrder);
      } else if (stage === "videos") {
        await executeVideoQueue(stageOrder);
      } else {
        const nonMediaOrder = stageOrder.filter((id) => {
          const kind = initialNodes.find((item) => item.id === id)?.data.kind;
          return kind !== "image" && kind !== "video";
        });
        for (const id of nonMediaOrder) await executeStageNode(id);
        await executeImageQueue(stageOrder.filter((id) => initialNodes.find((item) => item.id === id)?.data.kind === "image"));
        await executeVideoQueue(stageOrder.filter((id) => initialNodes.find((item) => item.id === id)?.data.kind === "video"));
      }
      const completedAt = new Date().toISOString();
      const allMediaCompleted = runtime
        .filter((node) => node.data.kind === "image" || node.data.kind === "video")
        .every((node) => node.data.status === "succeeded"
          && Boolean(node.data.outputUrl || node.data.imageDeliveryReceipt?.generationCompleted)
          && (node.data.kind !== "video" || node.data.playbackStatus === "ready"));
      updateRunRecord(runId, (record) => ({
        ...record,
        status: failed.size > 0 ? "partial" : allMediaCompleted ? "completed" : "draft",
        completedAt,
        durationMs: Date.now() - runStartedMs,
        nodes: snapshotRunNodes(runtime),
        edges: edgesRef.current,
      }), true);
      const stageDoneLabel = stage === "images"
        ? "图片生成阶段已完成，请预览关键帧，确认后再开始生成视频"
        : stage === "videos"
          ? "视频生成阶段已完成，可逐条预览或批量下载"
          : "图片和视频已全部生成完成";
      onNotice(deferred.size > 0
        ? `${deferred.size} 个视频任务已提交并保留任务编号，当前仍在生成；再次点击批量视频只会继续查询，不会重复提交或扣费`
        : failed.size === 0 ? stageDoneLabel : `${stageDoneLabel}；${failed.size} 个节点需要处理`);
    } catch (error) {
      const queueStopped = error instanceof BatchQueueStoppedError;
      const message = error instanceof Error ? error.message : "工作流执行失败";
      updateRunRecord(runId, (record) => ({
        ...record,
        status: queueStopped ? "draft" : "failed",
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - runStartedMs,
        nodes: snapshotRunNodes(runtime),
        edges: edgesRef.current,
        error: queueStopped ? undefined : message,
      }), true);
      onNotice(queueStopped
        ? "批量队列已终止，已完成结果和视频任务 ID 均已保留；再次点击批量生图或批量视频即可继续未完成节点。"
        : message);
    } finally {
      resetQueuedRuntimeNodes(nodesRef.current.map((node) => node.id));
      setRunningAll(false);
      setActiveRunStage(null);
      updateBatchControl("idle");
    }
  }

  async function uploadAsset(nodeId: string, file: File) {
    const targetNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!targetNode) return;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      onRequireLogin();
      return;
    }
    setUploadBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      let data: { url?: string; warning?: string; assetId?: string; storageKey?: string; historyRecordId?: string; createdAt?: string };
      if (isAudioUpload(targetNode.data)) {
        if (file.size > 25 * 1024 * 1024) throw new Error("画布音频上传不能超过 25MB");
        const sourceDataUrl = await new Promise<string>((resolveDataUrl, rejectDataUrl) => {
          const reader = new FileReader();
          reader.onerror = () => rejectDataUrl(new Error("音频文件读取失败"));
          reader.onload = () => typeof reader.result === "string"
            ? resolveDataUrl(reader.result)
            : rejectDataUrl(new Error("音频文件读取失败"));
          reader.readAsDataURL(file);
        });
        const persisted = await responseJson<{
          url?: string;
          assetId?: string;
          storageKey?: string;
          historyRecordId?: string;
          createdAt?: string;
        }>(await fetch("/api/bridge/image/persist", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            url: sourceDataUrl,
            clientTraceId: crypto.randomUUID(),
            mediaKind: targetNode.data.sourceMediaKind === "music" ? "music" : "audio",
            title: targetNode.data.title,
          }),
        }));
        if (!persisted.url || !persisted.assetId || !persisted.storageKey || !persisted.historyRecordId) {
          throw new Error("音频保存结果暂未确认，请保留当前页面并稍后重试");
        }
        data = {
          url: persisted.url,
          assetId: persisted.assetId,
          storageKey: persisted.storageKey,
          historyRecordId: persisted.historyRecordId,
          createdAt: persisted.createdAt,
        };
      } else {
        form.set("category", file.type.startsWith("video/") ? "video" : "image");
        form.set("source", "漫剧画布");
        const uploaded = await responseJson<{
          success?: boolean;
          file?: { url?: string; key?: string };
        }>(await fetch("/api/storage/upload", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        }));
        if (uploaded.success !== true || !uploaded.file?.url || !uploaded.file.key) {
          throw new Error("素材上传没有返回稳定对象存储地址");
        }
        data = {
          url: uploaded.file.url,
          storageKey: uploaded.file.key,
          createdAt: new Date().toISOString(),
        };
      }
      if (!data.url) throw new Error("素材上传没有返回地址");
      const createdAt = data.createdAt || new Date().toISOString();
      updateNode(targetNode.id, {
        outputUrl: data.url,
        ...(isAudioUpload(targetNode.data) ? {
          audioMode: "upload" as const,
          modelId: "",
          publicModelName: undefined,
          estimatedCost: undefined,
          actualCost: undefined,
          creditsCharged: undefined,
          retailPriceRmb: undefined,
          billingUnit: undefined,
          billingReferenceId: undefined,
          clientRequestId: undefined,
          clientRequestFingerprint: undefined,
        } : {}),
        assetId: data.assetId,
        storageKey: data.storageKey,
        historyRecordId: data.historyRecordId,
        completedAt: createdAt,
        status: "succeeded",
        history: [{
          id: crypto.randomUUID(),
          outputUrl: data.url,
          assetId: data.assetId,
          storageKey: data.storageKey,
          historyRecordId: data.historyRecordId,
          createdAt,
        }, ...targetNode.data.history],
      });
      if (data.warning) onNotice(data.warning);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "素材上传失败");
    } finally {
      setUploadBusy(false);
    }
  }

  function deleteNode(nodeId: string) {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    if (selectedId === nodeId) setSelectedId(null);
  }

  const fitCanvas = useCallback(() => {
    const currentNodes = nodesRef.current;
    const previewIds = new Set(layoutWorkflow(currentNodes, edgesRef.current).previewNodes.map((node) => node.id));
    const targetNodes = currentNodes.length > 12
      ? currentNodes.filter((node) => previewIds.has(node.id))
      : currentNodes;
    flowRef.current?.fitView({
      nodes: targetNodes.length > 0 ? targetNodes : currentNodes,
      padding: 0.12,
      maxZoom: 0.82,
      duration: 220,
    });
  }, []);

  const focusSelectedNode = useCallback(() => {
    if (!selectedId) {
      fitCanvas();
      return;
    }
    const node = nodesRef.current.find((item) => item.id === selectedId);
    if (!node) return;
    const nodeHeight = node.data.kind === "text" || node.data.kind === "upload" ? 251 : 305;
    flowRef.current?.setCenter(node.position.x + 220, node.position.y + nodeHeight / 2, {
      zoom: window.innerWidth <= 760 ? 0.78 : 1.04,
      duration: 220,
    });
  }, [fitCanvas, selectedId]);

  const duplicateSelectedNode = useCallback(() => {
    if (!selectedId) return;
    const source = nodesRef.current.find((node) => node.id === selectedId);
    if (!source) return;
    const duplicate: WorkflowFlowNode = {
      ...source,
      id: `${source.data.kind}:${crypto.randomUUID()}`,
      selected: false,
      position: { x: source.position.x + 56, y: source.position.y + 56 },
      data: {
        ...source.data,
        title: `${source.data.title} Copy`,
        outputUrl: "",
        outputText: source.data.kind === "text" ? source.data.outputText : "",
        status: "idle",
        error: undefined,
        taskId: "",
        clientRequestId: undefined,
        clientRequestFingerprint: undefined,
        imageClientTraceId: undefined,
        imageClientIdempotencyKey: undefined,
        imageRequestFingerprint: undefined,
        pendingPersistUrl: undefined,
        pendingPersistIndex: undefined,
        pendingPersistWidth: undefined,
        pendingPersistHeight: undefined,
        pendingPersistCharge: undefined,
        pendingPersistCashRemaining: undefined,
        providerContentUrl: "",
        publicModelName: undefined,
        modelLocked: false,
        lockedModelId: "",
        actualCost: undefined,
        creditsCharged: undefined,
        retailPriceRmb: undefined,
        billingUnit: undefined,
        cashRemaining: undefined,
        billingReferenceId: undefined,
        assetId: undefined,
        storageKey: undefined,
        historyRecordId: undefined,
        completedAt: undefined,
        progressMessage: undefined,
        generationBlockedReason: undefined,
        referenceValidationStatus: source.data.assetRole === "storyboard-keyframe" ? "pending" : undefined,
        selectedCandidateId: undefined,
        playbackStatus: source.data.kind === "video" ? "unchecked" : source.data.playbackStatus,
        playbackError: undefined,
        history: [],
      },
    };
    setNodes((current) => [...current, duplicate]);
    setSelectedId(duplicate.id);
    window.setTimeout(() => {
      flowRef.current?.setCenter(duplicate.position.x + 220, duplicate.position.y + 152, {
        zoom: 0.92,
        duration: 180,
      });
    }, 0);
  }, [selectedId]);

  const tidyCanvas = useCallback(() => {
    const layout = layoutWorkflow(nodesRef.current, edgesRef.current);
    setNodes(layout.nodes);
    window.setTimeout(() => {
      flowRef.current?.fitView({
        nodes: layout.previewNodes.length > 0 ? layout.previewNodes : layout.nodes,
        padding: 0.12,
        maxZoom: 0.78,
        duration: 240,
      });
    }, 0);
    onNotice("已按工作流关系横向整理；同一镜头保持在同一行");
  }, [onNotice]);

  const applyHdDefaults = useCallback(() => {
    setNodes((current) => current.map((node) => {
      if (node.data.kind === "image") {
        const model = imageModels.find((item) => item.id === node.data.modelId);
        const resolution = coerceImageResolution(model, "4K", "4K");
        return { ...node, data: { ...node.data, resolution } };
      }
      if (node.data.kind === "video") {
        const model = videoModels.find((item) => item.id === node.data.modelId);
        const resolution = coerceCanvasVideoResolution(model, "1080p");
        return node.data.resolution === resolution ? node : { ...node, data: { ...node.data, resolution } };
      }
      return node;
    }));
    setCanvasImageResolution(coerceImageResolution(selectedCanvasImageModel, "4K", "4K"));
    setCanvasVideoResolution(coerceCanvasVideoResolution(selectedCanvasVideoModel, "1080p"));
    onNotice("已按每个模型的最高可用档位设置图片，视频设为 1080p");
  }, [imageModels, onNotice, selectedCanvasImageModel, selectedCanvasVideoModel, videoModels]);

  const applyCanvasModels = useCallback(() => {
    const imageModel = imageModels.find((model) => model.id === canvasImageModelId);
    const videoModel = videoModels.find((model) => model.id === canvasVideoModelId);
    let imageCount = 0;
    let videoCount = 0;
    let skippedCount = 0;

    setNodes((current) => current.map((node) => {
      if (node.data.kind === "image" && imageModel) {
        const hasCommittedGeneration = node.data.status === "running"
          || node.data.status === "succeeded"
          || Boolean(node.data.taskId)
          || Boolean(node.data.outputUrl);
        if (hasCommittedGeneration || node.data.clientRequestId) {
          skippedCount += 1;
          return node;
        }
        const inputs = collectWorkflowInputs({ nodes: asDomainNodes(current), edges: edgesRef.current }, node.id);
        const needsReference = inputs.imageUrls.length > 0 || node.data.imageMode === "image-to-image" || node.data.imageMode === "edit";
        if (needsReference && !imageModel.supports_image_input) {
          skippedCount += 1;
          return node;
        }
        imageCount += 1;
        return {
          ...node,
          data: {
            ...node.data,
            modelId: imageModel.id,
            lockedModelId: "",
            modelLocked: false,
            resolution: canvasImageResolution,
            status: "idle",
            taskId: "",
            error: undefined,
          },
        };
      }
      if (node.data.kind === "video" && videoModel) {
        const hasCommittedGeneration = node.data.status === "running"
          || node.data.status === "succeeded"
          || Boolean(node.data.taskId)
          || Boolean(node.data.outputUrl);
        if (node.data.modelLocked && hasCommittedGeneration) {
          skippedCount += 1;
          return node;
        }
        const sourceIds = new Set(edgesRef.current.filter((edge) => edge.target === node.id).map((edge) => edge.source));
        const needsImageInput = current.some((source) => sourceIds.has(source.id) && (
          source.data.kind === "image"
          || (source.data.kind === "upload" && !isAudioUpload(source.data))
        ))
          || node.data.videoMode === "multimodal";
        if (needsImageInput && !videoModel.supportsImageInput) {
          skippedCount += 1;
          return node;
        }
        const availableAudioInputs = current.filter((source) => sourceIds.has(source.id) && isAudioUpload(source.data) && Boolean(source.data.outputUrl)).length;
        const audioReferenceLimits = getVideoAudioReferenceLimits(videoModel);
        const needsAudioInput = availableAudioInputs > 0;
        if (needsAudioInput && !videoModel.supportsAudioInput) {
          skippedCount += 1;
          return node;
        }
        if (availableAudioInputs < audioReferenceLimits.min) {
          skippedCount += 1;
          return node;
        }
        const nextDuration = coerceVideoTargetDuration(videoModel, node.data.durationSeconds);
        const timing = resolveVideoDuration(videoModel, nextDuration);
        if (!timing.supported || (node.data.requiresExactDuration && !videoModel.supportsImageInput)) {
          skippedCount += 1;
          return node;
        }
        videoCount += 1;
        return {
          ...node,
          data: {
            ...node.data,
            modelId: videoModel.id,
            durationSeconds: nextDuration,
            lockedModelId: "",
            modelLocked: false,
            resolution: selectedCanvasVideoResolution,
            status: "idle",
            taskId: "",
            error: undefined,
          },
        };
      }
      return node;
    }));
    onNotice(`已批量更新 ${imageCount} 个图片节点、${videoCount} 个视频节点；图片 ${canvasImageResolution}，视频 ${selectedCanvasVideoResolution}${skippedCount ? `；${skippedCount} 个节点因模型能力不匹配已跳过` : ""}`);
  }, [canvasImageModelId, canvasImageResolution, canvasVideoModelId, imageModels, onNotice, selectedCanvasVideoResolution, videoModels]);

  const applyStructuredStoryboardPlan = useCallback((plan: StoryboardCanvasImportPlan) => {
    if (!activeCanvasId || plan.segments.length === 0) return false;
    const animationStyle = resolveAnimationStyleId(plan.settings.animationStyle);
    const settings: CanvasStoryboardSettings = {
      productionModeId: "anime-story",
      directorMode: plan.settings.directorMode,
      targetDurationSeconds: plan.settings.targetDurationSeconds,
      animationStyleId: animationStyle,
      aspectRatio: plan.settings.aspectRatio,
      referenceTextMode: "annotated",
    };
    applyStoryboardSettings(settings);
    setScriptDraft(plan.sourceScript || plan.segments.map((segment) => `${segment.sourceIndex}. ${segment.narration}`).join("\n"));

    const imageModelId = canvasImageModelId || defaultImageModelId;
    const videoModelId = canvasVideoModelId || defaultVideoModelId;
    const defaults = {
      imageModelId,
      videoModelId,
      aspectRatio: plan.settings.aspectRatio as AspectRatio,
      imageResolution: canvasImageResolution,
      videoResolution: selectedCanvasVideoResolution,
      videoDurationSeconds: plan.settings.targetDurationSeconds,
    };
    const brief = starterNode("text", 0, { x: -1040, y: 120 }, defaults);
    const directorConfig = starterNode("text", 0, { x: -480, y: 120 }, defaults);
    const lockedAssets = [...new Set(plan.segments.flatMap((segment) => segment.characterAssets))];
    const semanticEvidence = plan.segments.flatMap((segment) => segment.semanticVisualizations.map((item) => (
      `${segment.segmentId}｜${item.trigger} → ${item.visual_form} → ${item.interaction}`
    )));
    brief.data = {
      ...brief.data,
      title: "完整文案 Brief",
      prompt: plan.sourceScript,
      outputText: plan.sourceScript,
      aspectRatio: plan.settings.aspectRatio,
      workflowRole: "source-brief",
      storyboardDirectorMode: plan.settings.directorMode,
    };
    const directorConfigText = [
      `结构协议：${plan.schemaVersion}`,
      `导演版本：${plan.settings.directorLabel}`,
      `目标时长：${plan.settings.targetDurationSeconds}秒；实际镜头范围：${storyTargetShotLabel(plan.settings.targetDurationSeconds).replace("个真实镜头", "")}镜`,
      `画面尺寸：${plan.settings.aspectRatio}`,
      `动画风格：${plan.settings.animationStyle}`,
      `角色 / 宠物 / 道具锁定：${lockedAssets.length ? lockedAssets.join("；") : "按逐镜提示词中的具体资产执行"}`,
      `语义可视化锁定：${semanticEvidence.length ? semanticEvidence.join("；") : "仅使用逐镜物理表演、道具与环境反馈"}`,
      "生成顺序：导演拆解已完成 → 生成并确认参考图 → 提交视频。面板数与切镜数始终解耦。",
    ].join("\n");
    directorConfig.data = {
      ...directorConfig.data,
      title: `${plan.settings.directorLabel} · 结构化导演设定`,
      prompt: directorConfigText,
      outputText: directorConfigText,
      aspectRatio: plan.settings.aspectRatio,
      workflowRole: "director-config",
      storyboardDirectorMode: plan.settings.directorMode,
    };

    const importedNodes: WorkflowFlowNode[] = [brief, directorConfig];
    const importedEdges: WorkflowFlowEdge[] = [
      { id: `${brief.id}->${directorConfig.id}`, source: brief.id, target: directorConfig.id },
    ];
    plan.segments.forEach((segment, index) => {
      const y = 80 + index * LAYOUT_ROW_GAP;
      const narration = starterNode("text", index + 1, { x: 680, y }, defaults);
      const directorCard = starterNode("text", index + 1, { x: 1240, y }, defaults);
      const imagePrompt = starterNode("text", index + 1, { x: 1800, y }, defaults);
      const referenceImage = starterNode("image", index + 1, { x: 2360, y }, defaults);
      const videoPrompt = starterNode("text", index + 1, { x: 2920, y }, defaults);
      const video = starterNode("video", index + 1, { x: 3480, y }, defaults);
      const shotLabel = `分镜${String(segment.sourceIndex).padStart(2, "0")}`;
      const sharedMetadata = {
        aspectRatio: plan.settings.aspectRatio as AspectRatio,
        durationSeconds: plan.settings.targetDurationSeconds,
        timelineDurationSeconds: plan.settings.targetDurationSeconds,
        semanticOrder: segment.sourceIndex,
        visualOrder: segment.sourceIndex,
        storyboardSegmentId: segment.segmentId,
        storyboardDirectorMode: plan.settings.directorMode,
        storyboardPanelCount: segment.panelCount,
        storyboardLayout: segment.layout,
        actualShotCount: segment.actualShotCount,
      };
      narration.data = {
        ...narration.data,
        ...sharedMetadata,
        title: `${shotLabel} · 口播文案`,
        prompt: segment.narration,
        outputText: segment.narration,
        workflowRole: "narration",
      };
      const timeline = segment.shotTimeRanges.map((range, rangeIndex) => (
        `镜头${rangeIndex + 1} ${range.start_seconds}-${range.end_seconds}秒：${range.action_beat}`
      )).join("\n");
      const directorText = [
        `本段口播：${segment.narration}`,
        `导演：${plan.settings.directorLabel}｜节奏：${segment.pacingMode}`,
        `故事板：${segment.panelCount}格｜${segment.layout === "four_plus_panorama" ? "上方2x2 + 底部全宽锚点" : "2x2"}`,
        segment.panoramicAnchorRole ? `独立锚点价值：${segment.panoramicAnchorRole}` : "独立锚点价值：无，使用4格2x2",
        `实际视频镜头：${segment.actualShotCount}镜；面板不等于切镜`,
        `实际镜头时间轴：\n${timeline}`,
        `相邻镜头连续性：${segment.continuityLinks.map((link) => `${link.from_shot}→${link.to_shot} ${link.description}`).join("；") || "按动作方向、视线和道具状态连续衔接"}`,
      ].join("\n");
      directorCard.data = {
        ...directorCard.data,
        ...sharedMetadata,
        title: `${shotLabel} · 语义导演卡`,
        prompt: directorText,
        outputText: directorText,
        workflowRole: "director-card",
      };
      imagePrompt.data = {
        ...imagePrompt.data,
        ...sharedMetadata,
        title: `${shotLabel} · 参考图提示词`,
        prompt: segment.imagePrompt,
        outputText: segment.imagePrompt,
        workflowRole: "image-prompt",
      };
      referenceImage.data = {
        ...referenceImage.data,
        ...sharedMetadata,
        title: `${shotLabel} · ${segment.panelCount}格故事板参考图 ${canvasImageResolution}`,
        prompt: "{{input.text}}",
        modelId: imageModelId,
        resolution: canvasImageResolution,
        assetRole: "storyboard-keyframe",
        workflowRole: "storyboard-reference",
        referenceValidationStatus: "pending",
      };
      videoPrompt.data = {
        ...videoPrompt.data,
        ...sharedMetadata,
        title: `${shotLabel} · 视频提示词`,
        prompt: segment.videoPrompt,
        outputText: segment.videoPrompt,
        workflowRole: "video-prompt",
      };
      video.data = {
        ...video.data,
        ...sharedMetadata,
        title: `${shotLabel} · ${segment.actualShotCount}镜故事板生成视频 ${plan.settings.targetDurationSeconds}s`,
        prompt: "{{input.text}}",
        modelId: videoModelId,
        durationSeconds: coerceVideoTargetDuration(videoModels.find(model => model.id === videoModelId), plan.settings.targetDurationSeconds),
        resolution: selectedCanvasVideoResolution,
        videoMode: "first-frame",
        requiresExactDuration: true,
        ambientSoundOnly: true,
        workflowRole: "video-output",
      };
      importedNodes.push(narration, directorCard, imagePrompt, referenceImage, videoPrompt, video);
      importedEdges.push(
        { id: `${directorConfig.id}->${narration.id}`, source: directorConfig.id, target: narration.id },
        { id: `${narration.id}->${directorCard.id}`, source: narration.id, target: directorCard.id },
        { id: `${directorCard.id}->${imagePrompt.id}`, source: directorCard.id, target: imagePrompt.id },
        { id: `${directorCard.id}->${videoPrompt.id}`, source: directorCard.id, target: videoPrompt.id },
        { id: `${imagePrompt.id}->${referenceImage.id}`, source: imagePrompt.id, target: referenceImage.id },
        { id: `${videoPrompt.id}->${video.id}`, source: videoPrompt.id, target: video.id },
        { id: `${referenceImage.id}->${video.id}`, source: referenceImage.id, target: video.id },
      );
    });

    const normalizedEdges = normalizeEdges(importedEdges);
    const importedAt = new Date().toISOString();
    const canvasName = `${plan.settings.directorLabel} · ${plan.settings.targetDurationSeconds}秒故事版`;
    nodesRef.current = importedNodes;
    edgesRef.current = normalizedEdges;
    setNodes(importedNodes);
    setEdges(normalizedEdges);
    setSelectedId(importedNodes.find((node) => node.data.workflowRole === "narration")?.id || brief.id);
    setProductionModeId("anime-story");
    setCanvasSessions((current) => {
      return current.map((session) => session.id === activeCanvasId
        ? { ...session, name: canvasName, nodes: importedNodes, edges: normalizedEdges, storyboardSettings: settings, updatedAt: importedAt }
        : session);
    });
    const runRecord: CanvasRunRecord = {
      id: `structured:${plan.commitKey || crypto.randomUUID()}`,
      canvasId: activeCanvasId,
      canvasName,
      status: "draft",
      sourceScript: plan.sourceScript,
      styleGuide: plan.settings.animationStyle,
      aspectRatio: plan.settings.aspectRatio,
      promptPreset: `${plan.schemaVersion} · ${plan.settings.directorLabel}`,
      imageModelId,
      videoModelId,
      compiler: "ai",
      storyboardSettings: settings,
      startedAt: importedAt,
      events: importedNodes.map((node) => ({
        nodeId: node.id,
        title: node.data.title,
        kind: node.data.kind,
        status: "pending",
        modelId: node.data.modelId || undefined,
      })),
      nodes: snapshotRunNodes(importedNodes),
      edges: normalizedEdges,
    };
    persistRunHistory((current) => [runRecord, ...current.filter((record) => record.id !== runRecord.id)]);
    setProPanelOpen(false);
    setScriptImporterOpen(false);
    window.setTimeout(() => flowRef.current?.fitView({ nodes: importedNodes.slice(0, 8), padding: 0.12, maxZoom: 0.68, duration: 260 }), 80);
    onNotice(`已接收 ${plan.schemaVersion}：${plan.segments.length} 段已按${plan.settings.directorLabel}映射为可编辑画布；未调用生图或视频服务`);
    return true;
  }, [activeCanvasId, applyStoryboardSettings, canvasImageModelId, canvasImageResolution, canvasVideoModelId, defaultImageModelId, defaultVideoModelId, onNotice, persistRunHistory, selectedCanvasVideoResolution]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId) return;
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get("entry") !== "agent" || searchParams.get("handoff") !== "storyboard") return;
    if (agentHandoffConsumedRef.current) return;
    agentHandoffConsumedRef.current = true;
    const parsed = readAgentWorkbenchHandoff("canvas");
    if (!parsed.ok) {
      setAgentCanvasHandoff({ status: "error", error: parsed.error });
      onNotice(parsed.error);
      return;
    }
    const plan = parseStoryboardCanvasImport(parsed.handoff.payload);
    if (!plan) {
      const error = "Agent 分镜机器包未通过画布校验，未覆盖当前画布。";
      setAgentCanvasHandoff({ status: "error", error });
      onNotice(error);
      return;
    }
    setAgentCanvasHandoff({ status: "ready", handoff: parsed.handoff, plan });
    onNotice(`已读取 Agent 交接预览：${plan.segments.length} 段；确认前不会覆盖画布、不会调用模型或扣费`);
  }, [activeCanvasId, hydrated, onNotice]);

  const confirmAgentCanvasHandoff = useCallback(() => {
    if (agentCanvasHandoff.status !== "ready") return;
    const { handoff, plan } = agentCanvasHandoff;
    const commitKey = plan.commitKey || `${plan.messageId}:${plan.segments.map((segment) => segment.segmentId).join(",")}`;
    if (lastStructuredCommitRef.current === commitKey) return;
    if (!applyStructuredStoryboardPlan(plan)) return;
    lastStructuredCommitRef.current = commitKey;
    setAgentCanvasHandoff({ status: "imported", handoff, plan });
  }, [agentCanvasHandoff, applyStructuredStoryboardPlan]);

  const createCanvasFromScript = useCallback(async (
    script: string,
    styleGuide: string,
    ratio: AspectRatio,
    presetId = "",
    options?: {
      assistantInstructionOverride?: string;
      runNameOverride?: string;
      qualityNotes?: string[];
      consistencySourceOverride?: ConsistencySource;
      keyframeStrategyOverride?: KeyframeStrategy;
      effectsLevelOverride?: VisualEffectsLevel;
      imageModelIdOverride?: string;
      videoModelIdOverride?: string;
    },
  ) => {
    const cleanScript = script.trim();
    if (!cleanScript) {
      onNotice("请先粘贴一段文案");
      return;
    }

    const effectivePresetId = presetId || resolveProductionPresetId(selectedProductionMode, cleanScript);
    const effectivePreset = promptPresets.find((preset) => preset.id === effectivePresetId) || promptPresets[0];
    if (!effectivePreset) {
      onNotice("内容任务类型暂时不可用，请稍后重试");
      return;
    }

    const consistencySource = options?.consistencySourceOverride ?? consistencySourceDraftRef.current;
    const keyframeStrategy = options?.keyframeStrategyOverride ?? keyframeStrategyDraft;
    const effectsLevel = options?.effectsLevelOverride ?? effectsLevelDraft;
    const requestedImageModelId = options?.imageModelIdOverride || canvasImageModelId || defaultImageModelId;
    const requestedImageModel = imageModels.find((model) => model.id === requestedImageModelId);
    if (!requestedImageModel) {
      onNotice("当前暂无可用的图片生成模型");
      return;
    }
    const imageAdmissionIssue = canvasModelAdmissionIssue(requestedImageModel, "image");
    if (imageAdmissionIssue) { onNotice(imageAdmissionIssue); return; }
    const usesIdentityAnchor = consistencySource !== "auto";
    const referenceImageModel = usesIdentityAnchor
      ? selectReferenceImageModel(requestedImageModel)
      : undefined;
    if (usesIdentityAnchor && !referenceImageModel) {
      onNotice(`${requestedImageModel.name} 不支持参考图输入，请手动选择支持参考图的模型，或明确改用文字资产锁定。`);
      return;
    }
    const workflowImageModel = referenceImageModel || requestedImageModel;
    const workflowImageModelId = workflowImageModel.id;
    const requestedImageCapabilities = getImageModelCapabilities(workflowImageModel);
    const requestedVideoModelId = options?.videoModelIdOverride || canvasVideoModelId || defaultVideoModelId;
    const requestedVideoModel = videoModels.find((model) => model.id === requestedVideoModelId);
    if (!requestedVideoModel) {
      onNotice("请选择一个可用的视频生成模型");
      return;
    }
    const selectedVideoAdmissionIssue = canvasModelAdmissionIssue(requestedVideoModel, "video");
    if (selectedVideoAdmissionIssue) { onNotice(selectedVideoAdmissionIssue); return; }
    const videoModelMatchesWorkflow = (model: VideoModel) => model.supportsImageInput
      && (!requiresExactStoryboardTiming || model.supportsImageInput);
    if (!videoModelMatchesWorkflow(requestedVideoModel)) {
      onNotice(requiresExactStoryboardTiming
        ? `${requestedVideoModel.name} 不能直接生成本流程要求的故事版视频；请主动选择支持参考图的模型并使用其原生时长`
        : `${requestedVideoModel.name} 不支持关键帧驱动，请主动选择图生视频模型`);
      return;
    }
    const compatibleVideoModel = requestedVideoModel;
    const workflowVideoModelId = requestedVideoModel.id;
    const workflowVideoTiming = getVideoDurationCapabilities(requestedVideoModel);
    const workflowImageResolution = coerceImageResolution(
      workflowImageModel,
      canvasImageResolution,
    );
    const workflowVideoResolution = coerceCanvasVideoResolution(
      compatibleVideoModel,
      selectedCanvasVideoResolution,
    );
    const defaults = {
      imageModelId: workflowImageModelId,
      videoModelId: workflowVideoModelId,
      aspectRatio: ratio,
      imageResolution: workflowImageResolution,
      videoResolution: workflowVideoResolution,
    };
    const compiledAssistantInstruction = [
      productionModeId === "anime-story" ? storyboardReferenceTextModeInstruction(storyboardReferenceTextMode) : "",
      options?.assistantInstructionOverride ?? assistantInstruction,
    ].filter(Boolean).join("\n");

    setScriptCompiling(true);
    onNotice(productionModeId === "anime-story"
      ? `正在交给${selectedProductionMode.agentName}：先把口播转换成无对白微故事，再生成分镜、参考图提示词和视频提示词…`
      : `正在按照“${effectivePreset.name}”编排分镜草稿；图片和视频模型将保持你的当前选择…`);

    let compiled: {
      preset: { id: string; name: string; version: number };
      analysis: string;
      characterAssets: CompiledCharacterAsset[];
      storyPlan: string;
      consistencyPrompt: string;
      qualityNotes?: string[];
      postProductionPlan: string;
      semanticSegments: Array<{ order: number; narration: string; durationSeconds: number; visualShotCount: number }>;
      shots: Array<CompiledStoryboardShot & { shotTimeRanges?: StoryboardShotTimeRange[] }>;
      compiler: "ai" | "deterministic-fallback";
      compilerDiagnostics?: Array<{
        model: string;
        stage: string;
        status: "accepted" | "rejected" | "failed";
        durationMs: number;
        detail?: string;
      }>;
    };
    try {
      const authToken = window.localStorage.getItem(TOKEN_KEY) || "";
      const response = await fetch("/api/canvas/compile-script", {
        method: "POST",
        signal: AbortSignal.timeout(360_000),
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          script: cleanScript,
          presetId: effectivePreset.id,
          style: styleGuide,
          ratio,
          referenceMode: "single",
          keyframeStrategy,
          effectsLevel,
          productionMode: productionModeId,
          storyDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
          targetDurationSeconds: productionModeId === "anime-story" ? storyTargetDurationSeconds : undefined,
          imageModelName: workflowImageModel.name,
          videoModelName: compatibleVideoModel.name,
          videoModelDurationMode: workflowVideoTiming.mode,
          videoModelDurationSeconds: workflowVideoTiming.defaultDuration,
          consistencyMode: usesIdentityAnchor ? "reference" : "text-lock",
          assistantInstruction: compiledAssistantInstruction,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "分镜编排失败");
      compiled = data;
    } catch (error) {
      const message =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "导演拆解超过 6 分钟，已自动停止。本次没有进入生图或视频扣费，请重新拆解"
          : error instanceof Error
            ? error.message
            : "分镜编排失败";
      onNotice(message);
      setScriptCompiling(false);
      return;
    }

    const brief = starterNode("text", 0, { x: -1600, y: 980 }, defaults);
    const analysis = starterNode("text", 0, { x: -1040, y: 980 }, defaults);
    const storyPlan = starterNode("text", 0, { x: -480, y: 520 }, defaults);
    const consistency = starterNode("text", 0, { x: -480, y: 980 }, defaults);
    const postProduction = starterNode("text", 0, {
      x: 4600,
      y: 80 + Math.max(0, compiled.shots.length - 1) * 215,
    }, defaults);
    const characterAssets = compiled.characterAssets || [];
    if (usesIdentityAnchor && characterAssets.length === 0) {
      onNotice("全文分析没有返回可用角色资产，请重新拆镜后再生成");
      setScriptCompiling(false);
      return;
    }
    const identityAnchors: WorkflowFlowNode[] = !usesIdentityAnchor
      ? []
      : consistencySource === "upload"
        ? [starterNode("upload", 0, { x: 80, y: 520 }, defaults)]
        : characterAssets.map((_, index) => starterNode("image", index + 1, { x: 80, y: 180 + index * 390 }, defaults));
    const failedCompilerDiagnostic = [...(compiled.compilerDiagnostics || [])]
      .reverse()
      .find((diagnostic) => diagnostic.status !== "accepted");
    const directorQualityAdvisory = compiled.compiler === "deterministic-fallback"
      ? failedCompilerDiagnostic
        ? `AI导演方案未通过制作检查：${failedCompilerDiagnostic.detail || "生成服务未返回可用结果"}。当前仅加载基础预览，批量与全部生成已暂停；可重新拆镜，或编辑单张卡片后手动生成。`
        : "当前仅加载基础规则预览，批量与全部生成已暂停；可重新拆镜，或编辑单张卡片后手动生成。"
      : undefined;
    const compilerQualityNotes = directorQualityAdvisory
      ? [`导演质量提示：${directorQualityAdvisory}`]
      : [];
    const combinedQualityNotes = [...compilerQualityNotes, ...(compiled.qualityNotes || []), ...(options?.qualityNotes || [])];
    const qualityAudit = combinedQualityNotes.length
      ? starterNode("text", 0, { x: -1040, y: 520 }, defaults)
      : null;

    brief.data = {
      ...brief.data,
      title: "完整文案 Brief",
      prompt: cleanScript,
      outputText: cleanScript,
      aspectRatio: ratio,
      workflowRole: "source-brief",
    };
    analysis.data = {
      ...analysis.data,
      title: productionModeId === "anime-story"
        ? `${compiled.compiler === "ai" ? selectedProductionMode.agentName : "动漫剧情基础预览"} · ${compiled.preset.name} v${compiled.preset.version}`
        : `${compiled.compiler === "ai" ? "AI拆镜" : "基础预览"} · ${compiled.preset.name} v${compiled.preset.version}`,
      prompt: compiled.analysis,
      outputText: compiled.analysis,
      aspectRatio: ratio,
      workflowRole: "director-config",
    };
    storyPlan.data = {
      ...storyPlan.data,
      title: "口播转故事 · 全片故事接力表",
      prompt: compiled.storyPlan,
      outputText: compiled.storyPlan,
      aspectRatio: ratio,
    };
    if (qualityAudit) {
      const qualityAuditText = [
        "本节点记录疑点与本轮质检项，不自动改写用户原文。确认后再批量生成图片和视频。",
        ...combinedQualityNotes.map((note, index) => `${index + 1}. ${note}`),
      ].join("\n");
      qualityAudit.data = {
        ...qualityAudit.data,
        title: "生成前质检 / 纠错记录",
        prompt: qualityAuditText,
        outputText: qualityAuditText,
        aspectRatio: ratio,
      };
    }
    consistency.data = {
      ...consistency.data,
      title: "全片角色 / 风格设定（全文提取）",
      prompt: compiled.consistencyPrompt,
      outputText: compiled.consistencyPrompt,
      aspectRatio: ratio,
    };
    postProduction.data = {
      ...postProduction.data,
      title: "成片装配 / 后期计划",
      prompt: compiled.postProductionPlan,
      outputText: compiled.postProductionPlan,
      aspectRatio: ratio,
      workflowRole: "post-production",
    };
    identityAnchors.forEach((identityAnchor, index) => {
      if (identityAnchor.data.kind === "upload") {
        identityAnchor.data = {
          ...identityAnchor.data,
          title: "已有角色参考图（手动替代）",
          prompt: "仅当你已经拥有角色合照或角色设定板时使用。上传图只负责身份与固定造型，分镜仍按各镜提示词重新构图、布景和添加语义证据。",
          aspectRatio: ratio,
          optionalInput: false,
          assetRole: "character-reference",
          workflowRole: "character-reference",
          castIds: characterAssets.map((character) => character.id).slice(0, 4),
        };
        return;
      }
      const character = characterAssets[index];
      const candidateCount = 1;
      identityAnchor.data = {
        ...identityAnchor.data,
        title: `角色${String(index + 1).padStart(2, "0")} · ${character.name}身份定妆图`,
        prompt: character.referencePrompt,
        modelId: workflowImageModel.id,
        aspectRatio: ratio,
        resolution: workflowImageResolution,
        imageMode: "text-to-image",
        imageCount: candidateCount,
        candidateSelectionRequired: true,
        selectedCandidateId: undefined,
        assetRole: "character-reference",
        workflowRole: "character-reference",
        characterId: character.id,
        characterName: character.name,
        castIds: [character.id],
        generationBlockedReason: undefined,
      };
    });
    const nodesToApply: WorkflowFlowNode[] = [brief, ...(qualityAudit ? [qualityAudit] : []), analysis, storyPlan, consistency, ...identityAnchors];
    const edgesToApply: WorkflowFlowEdge[] = [
      ...(qualityAudit
        ? [
            { id: `${brief.id}->${qualityAudit.id}`, source: brief.id, target: qualityAudit.id },
            { id: `${qualityAudit.id}->${analysis.id}`, source: qualityAudit.id, target: analysis.id },
          ]
        : [{ id: `${brief.id}->${analysis.id}`, source: brief.id, target: analysis.id }]),
      { id: `${analysis.id}->${storyPlan.id}`, source: analysis.id, target: storyPlan.id },
      { id: `${storyPlan.id}->${consistency.id}`, source: storyPlan.id, target: consistency.id },
      ...identityAnchors.map((identityAnchor) => ({ id: `${consistency.id}->${identityAnchor.id}`, source: consistency.id, target: identityAnchor.id })),
    ];

    const narrationNodes = new Map<number, WorkflowFlowNode>();
    compiled.semanticSegments.forEach((semanticSegment) => {
      const firstShot = compiled.shots.find((shot) => shot.semanticOrder === semanticSegment.order);
      if (!firstShot) return;
      const y = 80 + (firstShot.order - 1) * 430;
      const narrationChars = semanticSegment.narration.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "").length;
      const segment = starterNode("text", semanticSegment.order, { x: 680, y }, defaults);
      segment.data = {
        ...segment.data,
        title: `分镜${String(semanticSegment.order).padStart(2, "0")} · 口播文案 (${narrationChars}字 / ${semanticSegment.durationSeconds}s)`,
        prompt: semanticSegment.narration,
        outputText: semanticSegment.narration,
        aspectRatio: ratio,
        durationSeconds: semanticSegment.durationSeconds,
        timelineDurationSeconds: semanticSegment.durationSeconds,
        semanticOrder: semanticSegment.order,
        visualOrder: firstShot.order,
        workflowRole: "narration",
        storyboardSegmentId: firstShot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
      };
      narrationNodes.set(semanticSegment.order, segment);
      nodesToApply.push(segment);
      edgesToApply.push({ id: `${consistency.id}->${segment.id}`, source: consistency.id, target: segment.id });
    });

    compiled.shots.forEach((shot, index) => {
      const y = 80 + index * 430;
      const duration = shot.durationSeconds;
      const segment = narrationNodes.get(shot.semanticOrder);
      if (!segment) return;
      const shotIdentityAnchors = identityAnchors.filter((identityAnchor) => (
        identityAnchor.data.kind === "upload"
        || Boolean(identityAnchor.data.characterId && shot.castIds.includes(identityAnchor.data.characterId))
      ));
      const referenceLimitReason = shotIdentityAnchors.length > requestedImageCapabilities.maxReferenceImages
        ? `${requestedImageModel.name} 每镜最多接收 ${requestedImageCapabilities.maxReferenceImages} 张参考图，本镜需要 ${shotIdentityAnchors.length} 张角色图`
        : shotIdentityAnchors.length > requestedImageCapabilities.maxCharacterReferences
          ? `${requestedImageModel.name} 的角色一致性能力最多覆盖 ${requestedImageCapabilities.maxCharacterReferences} 个角色，本镜接入了 ${shotIdentityAnchors.length} 张角色图`
          : undefined;
      const shotGenerationBlockedReason = referenceLimitReason;
      const directorDecisionNode = starterNode("text", index + 1, { x: 1240, y }, defaults);
      const imagePromptNode = starterNode("text", index + 1, { x: 1800, y }, defaults);
      const imageNode = starterNode("image", index + 1, { x: 2360, y }, defaults);
      const videoPromptNode = starterNode("text", index + 1, { x: 2920, y }, defaults);
      const endFrameNode = shot.referenceMode === "first-last"
        ? starterNode("image", index + 1, { x: 3480, y }, defaults)
        : null;
      const videoNode = starterNode("video", index + 1, { x: endFrameNode ? 4040 : 3480, y }, defaults);
      const shotNumber = String(shot.order).padStart(2, "0");
      const shotTitle = `分镜${shotNumber}`;
      const evidenceLabel = {
        physical_action: "行为与实物证据",
        body_state: "身体绑定状态",
        environment_feedback: "道具夸张 / 环境反馈",
        semantic_cutaway: "完整语义切片空间",
      }[shot.evidenceLevel];
      const directorDecisionText = [
        `本段口播：${segment.data.prompt}`,
        `可见事件：${shot.visibleProposition}`,
        shot.targetDurationSeconds
          ? `故事版节奏：${shot.targetDurationSeconds}秒｜${shot.storyboardPanelCount || 4}格参考图｜${shot.actualShotCount || (shot.targetDurationSeconds === 15 ? 4 : 3)}个真实视频镜头｜${shot.storyboardLayout === "four_plus_panorama" ? "上方2x2+底部全宽锚点" : "2x2四格"}${shot.panoramicAnchorRole ? `\n${shot.panoramicAnchorRole}` : ""}`
          : "",
        shot.shotTimeRanges?.length
          ? `实际镜头时间轴：${shot.shotTimeRanges.map((range) => `${range.start_seconds}-${range.end_seconds}秒 ${range.action_beat}`).join("｜")}`
          : "",
        `证据与包装：${evidenceLabel}｜${shot.visualMode}\n${shot.effectsPrompt}`,
        `角色怎么演：${shot.motionPrompt}`,
        `机位与衔接：${shot.cameraPlan}｜${shot.editPrompt}`,
        `生成要求：${shot.qualityCriteria}`,
      ].filter(Boolean).join("\n\n");
      directorDecisionNode.data = {
        ...directorDecisionNode.data,
        title: `${shotTitle} · 语义导演卡`,
        prompt: directorDecisionText,
        outputText: directorDecisionText,
        aspectRatio: ratio,
        durationSeconds: duration,
        timelineDurationSeconds: duration,
        semanticOrder: shot.semanticOrder,
        visualOrder: shot.order,
        shotRole: shot.shotRole,
        transition: shot.transition,
        castIds: shot.castIds,
        workflowRole: "director-card",
        storyboardSegmentId: shot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
        storyboardPanelCount: shot.storyboardPanelCount,
        storyboardLayout: shot.storyboardLayout,
        actualShotCount: shot.actualShotCount,
      };
      videoPromptNode.data = {
        ...videoPromptNode.data,
        title: `${shotTitle} · 视频提示词`,
        prompt: shot.videoPrompt,
        outputText: shot.videoPrompt,
        aspectRatio: ratio,
        durationSeconds: duration,
        timelineDurationSeconds: duration,
        semanticOrder: shot.semanticOrder,
        visualOrder: shot.order,
        shotRole: shot.shotRole,
        transition: shot.transition,
        castIds: shot.castIds,
        workflowRole: "video-prompt",
        storyboardSegmentId: shot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
        storyboardPanelCount: shot.storyboardPanelCount,
        storyboardLayout: shot.storyboardLayout,
        actualShotCount: shot.actualShotCount,
      };
      imagePromptNode.data = {
        ...imagePromptNode.data,
        title: `${shotTitle} · 参考图提示词`,
        prompt: shot.imagePrompt,
        outputText: shot.imagePrompt,
        aspectRatio: ratio,
        durationSeconds: duration,
        timelineDurationSeconds: duration,
        semanticOrder: shot.semanticOrder,
        visualOrder: shot.order,
        shotRole: shot.shotRole,
        transition: shot.transition,
        castIds: shot.castIds,
        workflowRole: "image-prompt",
        storyboardSegmentId: shot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
        storyboardPanelCount: shot.storyboardPanelCount,
        storyboardLayout: shot.storyboardLayout,
        actualShotCount: shot.actualShotCount,
      };
      imageNode.data = {
        ...imageNode.data,
        title: `${shotTitle} · ${shot.storyboardPanelCount ? `${shot.storyboardPanelCount}格故事板参考图` : "自动关键帧图片"} ${workflowImageResolution}`,
        prompt: "{{input.text}}",
        modelId: workflowImageModelId,
        aspectRatio: ratio,
        resolution: workflowImageResolution,
        imageMode: shotIdentityAnchors.length > 0 ? "image-to-image" : "text-to-image",
        timelineDurationSeconds: duration,
        semanticOrder: shot.semanticOrder,
        visualOrder: shot.order,
        shotRole: shot.shotRole,
        transition: shot.transition,
        castIds: shot.castIds,
        assetRole: "storyboard-keyframe",
        workflowRole: "storyboard-reference",
        storyboardSegmentId: shot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
        storyboardPanelCount: shot.storyboardPanelCount,
        storyboardLayout: shot.storyboardLayout,
        actualShotCount: shot.actualShotCount,
        referenceValidationStatus: "pending",
        generationBlockedReason: shotGenerationBlockedReason,
      };
      videoNode.data = {
        ...videoNode.data,
        title: `${shotTitle} · ${shot.actualShotCount ? `${shot.actualShotCount}镜故事板生成视频` : "关键帧生成视频"} ${duration}s`,
        prompt: "{{input.text}}",
        modelId: workflowVideoModelId,
        aspectRatio: ratio,
        durationSeconds: coerceVideoTargetDuration(requestedVideoModel, duration),
        requiresExactDuration: requiresExactStoryboardTiming,
        ambientSoundOnly: true,
        resolution: workflowVideoResolution,
        videoMode: endFrameNode ? "multimodal" : "first-frame",
        timelineDurationSeconds: duration,
        semanticOrder: shot.semanticOrder,
        visualOrder: shot.order,
        shotRole: shot.shotRole,
        transition: shot.transition,
        castIds: shot.castIds,
        workflowRole: "video-output",
        storyboardSegmentId: shot.id,
        storyboardDirectorMode: productionModeId === "anime-story" ? storyDirectorMode : undefined,
        storyboardPanelCount: shot.storyboardPanelCount,
        storyboardLayout: shot.storyboardLayout,
        actualShotCount: shot.actualShotCount,
        generationBlockedReason: shotGenerationBlockedReason,
      };

      if (endFrameNode) {
        endFrameNode.data = {
          ...endFrameNode.data,
          title: `${shotTitle} · 尾帧 ${workflowImageResolution}`,
          prompt: shot.endFramePrompt,
          modelId: workflowImageModelId,
          aspectRatio: ratio,
          resolution: workflowImageResolution,
          imageMode: "image-to-image",
          timelineDurationSeconds: duration,
          semanticOrder: shot.semanticOrder,
          visualOrder: shot.order,
          shotRole: shot.shotRole,
          transition: shot.transition,
          castIds: shot.castIds,
          assetRole: "storyboard-end-frame",
          generationBlockedReason: shotGenerationBlockedReason,
        };
      }

      nodesToApply.push(directorDecisionNode, imagePromptNode, imageNode, videoPromptNode, ...(endFrameNode ? [endFrameNode] : []), videoNode);
      edgesToApply.push(
        { id: `${segment.id}->${directorDecisionNode.id}`, source: segment.id, target: directorDecisionNode.id },
        { id: `${directorDecisionNode.id}->${videoPromptNode.id}`, source: directorDecisionNode.id, target: videoPromptNode.id },
        { id: `${directorDecisionNode.id}->${imagePromptNode.id}`, source: directorDecisionNode.id, target: imagePromptNode.id },
        { id: `${imagePromptNode.id}->${imageNode.id}`, source: imagePromptNode.id, target: imageNode.id },
        { id: `${videoPromptNode.id}->${videoNode.id}`, source: videoPromptNode.id, target: videoNode.id },
        { id: `${imageNode.id}->${videoNode.id}`, source: imageNode.id, target: videoNode.id },
        { id: `${videoNode.id}->${postProduction.id}`, source: videoNode.id, target: postProduction.id },
      );
      shotIdentityAnchors.forEach((identityAnchor) => {
        edgesToApply.push({ id: `${identityAnchor.id}->${imageNode.id}`, source: identityAnchor.id, target: imageNode.id });
      });
      if (endFrameNode) {
        edgesToApply.push(
          { id: `${videoPromptNode.id}->${endFrameNode.id}`, source: videoPromptNode.id, target: endFrameNode.id },
          { id: `${imageNode.id}->${endFrameNode.id}`, source: imageNode.id, target: endFrameNode.id },
          { id: `${endFrameNode.id}->${videoNode.id}`, source: endFrameNode.id, target: videoNode.id },
        );
      }
    });

    nodesToApply.push(postProduction);

    const normalizedEdgesToApply = normalizeEdges(edgesToApply);
    setProPanelOpen(false);
    setScriptImporterOpen(false);
    setNodes([]);
    setEdges([]);
    setSelectedId(null);

    const stagedNodes: WorkflowFlowNode[] = [];
    for (const node of nodesToApply) {
      stagedNodes.push(node);
      const stagedIds = new Set(stagedNodes.map((item) => item.id));
      setNodes([...stagedNodes]);
      setEdges(normalizedEdgesToApply.filter((edge) => stagedIds.has(edge.source) && stagedIds.has(edge.target)));
      setSelectedId(node.id);
      if (stagedNodes.length <= 3 || node.data.kind === "video") {
        const visibleNodes = stagedNodes.slice(-4);
        window.setTimeout(() => {
          flowRef.current?.fitView({ nodes: visibleNodes, padding: 0.18, maxZoom: 0.86, duration: 140 });
        }, 0);
      }
      await delay(stagedNodes.length <= 3 ? 120 : 45);
    }
    const firstStoryboardNode = narrationNodes.get(1);
    setSelectedId(firstStoryboardNode?.id || analysis.id);
    const runCreatedAt = new Date().toISOString();
    const activeSessionName = options?.runNameOverride || canvasSessions.find((session) => session.id === activeCanvasId)?.name || "分镜工作流";
    const runRecord: CanvasRunRecord = {
      id: crypto.randomUUID(),
      canvasId: activeCanvasId,
      canvasName: activeSessionName,
      status: "draft",
      sourceScript: cleanScript,
      styleGuide,
      aspectRatio: ratio,
      promptPreset: `${compiled.preset.name} v${compiled.preset.version}`,
      imageModelId: workflowImageModelId,
      videoModelId: workflowVideoModelId,
      compiler: compiled.compiler,
      storyboardSettings: {
        productionModeId,
        directorMode: storyDirectorMode,
        targetDurationSeconds: storyTargetDurationSeconds,
        animationStyleId,
        aspectRatio: ratio,
      },
      startedAt: runCreatedAt,
      events: nodesToApply.map((node) => ({
        nodeId: node.id,
        title: node.data.title,
        kind: node.data.kind,
        status: "pending",
        modelId: node.data.modelId || undefined,
      })),
      nodes: snapshotRunNodes(nodesToApply),
      edges: normalizedEdgesToApply,
    };
    if (options?.runNameOverride) {
      setCanvasSessions((current) => current.map((session) => session.id === activeCanvasId
          ? { ...session, name: options.runNameOverride!, updatedAt: runCreatedAt }
          : session));
    }
    persistRunHistory((current) => [
      runRecord,
      ...current.filter((record) => record.id !== runRecord.id && !(
        options?.runNameOverride
        && record.canvasId === activeCanvasId
        && record.canvasName === options.runNameOverride
      )),
    ]);
    window.setTimeout(() => {
      if (firstStoryboardNode) {
        flowRef.current?.setCenter(firstStoryboardNode.position.x + 1080, firstStoryboardNode.position.y + 150, {
          zoom: window.innerWidth <= 760 ? 0.38 : 0.58,
          duration: 280,
        });
        return;
      }
      flowRef.current?.fitView({ nodes: [brief, qualityAudit, analysis, consistency].filter(Boolean) as WorkflowFlowNode[], padding: 0.18, maxZoom: 0.82, duration: 280 });
    }, 60);
    const compilerLabel = compiled.compiler === "ai" ? "AI语义拆镜" : "稳定规则预览";
    const totalStoryboardSeconds = compiled.semanticSegments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const consistencyLabel = consistencySource === "explore"
      ? `已建立 ${characterAssets.length} 个独立角色资产；每个角色先生成4个造型候选并确认1张`
      : consistencySource === "upload"
        ? `已建立 ${characterAssets.length} 个角色定义；请上传1张已有角色设定板作为手动替代`
        : identityAnchors.length > 0
          ? `将先用 ${requestedImageModel.name} 为 ${characterAssets.length} 个角色分别生成定妆图并确认，再按每镜castIds传入相关角色图`
          : `将用 ${requestedImageModel.name} 和全片角色设定直接生成每镜关键帧，不额外生成无效锚点，也不切换图片模型`;
    onNotice(compiled.compiler === "ai"
      ? `已使用“${compiled.preset.name}”完成${compilerLabel}：${compiled.shots.length} 个分镜，每镜对应一段文案、一张参考图和一个视频，总时长约 ${formatDurationLabel(totalStoryboardSeconds)}；${consistencyLabel}`
      : directorQualityAdvisory || "AI导演方案未通过生产质检，当前已加载基础预览，仍可继续生成。");
    setScriptCompiling(false);
  }, [activeCanvasId, animationStyleId, assistantInstruction, canvasImageModelId, canvasImageResolution, canvasSessions, canvasVideoModelId, defaultImageModelId, defaultVideoModelId, effectsLevelDraft, imageModels, keyframeStrategyDraft, onNotice, persistRunHistory, productionModeId, promptPresets, requiresExactStoryboardTiming, selectedCanvasVideoResolution, selectedProductionMode, storyDirectorMode, storyboardReferenceTextMode, storyTargetDurationSeconds, videoModels]);

  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const revision = params.get("revision") || "";
    const shouldOpenProductionPanel = params.get("panel") === "production"
      || revision.startsWith("anime-performance");
    if (!shouldOpenProductionPanel) return;
    setProPanelTab("setup");
    setProPanelOpen(true);
    setScriptImporterOpen(true);
    if (params.has("panel")) {
      params.delete("panel");
      const next = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId) return;
    const params = new URLSearchParams(window.location.search);
    const reviewId = params.get("review");
    if (!reviewId || !/^[a-z0-9][a-z0-9-]{1,80}$/i.test(reviewId)) return;
    const productDemoGraphPath = reviewId === "clean-v21-images"
      ? "/product-assets/youcai-demo-v1/clean-v21/graph.json"
      : "";
    if (!productDemoGraphPath) {
      onNotice("该分享记录已失效或不可访问");
      return;
    }
    const runId = params.get("run") || "default";
    const reviewKey = canvasScopedStorageKey(
      `free-canvas-review-${reviewId}-${runId}-history-v1`,
      storageScope,
    );
    if (window.sessionStorage.getItem(reviewKey) === "1") return;
    window.sessionStorage.setItem(reviewKey, "1");

    void fetch(productDemoGraphPath, { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`产品演示画布读取失败：${response.status}`);
        return WorkflowGraphSchema.parse(await response.json());
      })
      .then((graph) => {
        const reviewNodes = graph.nodes as WorkflowFlowNode[];
        const reviewEdges = graph.edges.map((edge) => ({
          ...edge,
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed },
        })) as WorkflowFlowEdge[];
        const updatedAt = new Date().toISOString();
        const mediaNodes = reviewNodes.filter((node) => node.data.kind === "image" || node.data.kind === "video");
        const events: CanvasRunEvent[] = mediaNodes.map((node) => ({
          nodeId: node.id,
          title: node.data.title,
          kind: node.data.kind,
          status: node.data.outputUrl
            ? "succeeded"
            : node.data.status === "failed"
              ? "failed"
              : node.data.status === "running" || node.data.status === "queued"
                ? "running"
                : "pending",
          completedAt: node.data.outputUrl ? updatedAt : undefined,
          modelId: node.data.modelId || undefined,
          outputUrl: node.data.outputUrl || undefined,
          error: node.data.error || undefined,
        }));
        const firstMediaNode = mediaNodes[0];
        const sourceScript = reviewNodes
          .filter((node) => node.data.kind === "text" && /(?:完整文案|口播文案)/u.test(node.data.title))
          .map((node) => node.data.outputText || node.data.prompt)
          .filter(Boolean)
          .join("\n\n");
        const snapshotRecord: CanvasRunRecord = {
          id: `test-snapshot:${reviewId}:${runId}`,
          canvasId: activeCanvasId,
          canvasName: graph.name,
          recordType: "test-snapshot",
          status: events.some((event) => event.status === "failed") ? "partial" : "completed",
          sourceScript,
          styleGuide: "",
          aspectRatio: firstMediaNode?.data.aspectRatio || "16:9",
          promptPreset: "测试画布自动归档",
          imageModelId: mediaNodes.find((node) => node.data.kind === "image")?.data.modelId || "",
          videoModelId: mediaNodes.find((node) => node.data.kind === "video")?.data.modelId || "",
          startedAt: updatedAt,
          completedAt: updatedAt,
          events,
          nodes: snapshotRunNodes(reviewNodes),
          edges: reviewEdges,
        };
        setNodes(reviewNodes);
        setEdges(reviewEdges);
        setSelectedId(null);
        setProPanelOpen(false);
        setCanvasSessions((current) => current.map((session) => session.id === activeCanvasId
            ? {
                ...session,
                name: graph.name,
                nodes: reviewNodes,
                edges: reviewEdges,
                updatedAt,
              }
            : session));
        persistRunHistory((current) => [
          snapshotRecord,
          ...current.filter((record) => record.id !== snapshotRecord.id),
        ]);
        for (const delayMs of [80, 260, 600]) {
          window.setTimeout(() => flowRef.current?.fitView({ padding: 0.08, maxZoom: 0.56, duration: 180 }), delayMs);
        }
        const imageCount = events.filter((event) => event.kind === "image" && event.outputUrl).length;
        const videoCount = events.filter((event) => event.kind === "video" && event.outputUrl).length;
        onNotice(`可编辑产品演示已载入：${imageCount} 张本地图片、${videoCount} 条视频节点`);
      })
      .catch((error) => {
        window.sessionStorage.removeItem(reviewKey);
        onNotice(error instanceof Error ? error.message : "产品演示画布读取失败");
      });
  }, [activeCanvasId, hydrated, onNotice, persistRunHistory, storageScope]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId) return;
    const params = new URLSearchParams(window.location.search);
    const reviewId = params.get("review");
    if (!reviewId || !/^[a-z0-9][a-z0-9-]{1,80}$/i.test(reviewId)) return;
    const runId = params.get("run") || "default";
    const recordId = `test-snapshot:${reviewId}:${runId}`;
    if (!runHistoryRef.current.some((record) => record.id === recordId)) return;

    const timer = window.setTimeout(() => {
      const snapshotNodes = nodesRef.current;
      const snapshotEdges = edgesRef.current;
      const mediaNodes = snapshotNodes.filter((node) => node.data.kind === "image" || node.data.kind === "video");
      const updatedAt = new Date().toISOString();
      const events: CanvasRunEvent[] = mediaNodes.map((node) => ({
        nodeId: node.id,
        title: node.data.title,
        kind: node.data.kind,
        status: node.data.outputUrl
          ? "succeeded"
          : node.data.status === "failed"
            ? "failed"
            : node.data.status === "running" || node.data.status === "queued"
              ? "running"
              : "pending",
        startedAt: node.data.status === "running" || node.data.status === "queued" ? updatedAt : undefined,
        completedAt: node.data.outputUrl || node.data.status === "failed" ? updatedAt : undefined,
        modelId: node.data.modelId || undefined,
        outputUrl: node.data.outputUrl || undefined,
        error: node.data.error || undefined,
      }));
      const hasRunning = events.some((event) => event.status === "running");
      const hasFailed = events.some((event) => event.status === "failed");
      const hasPending = events.some((event) => event.status === "pending");
      const status: CanvasRunRecord["status"] = hasRunning
        ? "running"
        : hasFailed || hasPending
          ? "partial"
          : "completed";

      persistRunHistory((current) => current.map((record) => record.id === recordId
        ? {
            ...record,
            status,
            completedAt: status === "completed" ? updatedAt : undefined,
            events,
            nodes: snapshotRunNodes(snapshotNodes),
            edges: snapshotEdges,
          }
        : record));
    }, 500);

    return () => window.clearTimeout(timer);
  }, [activeCanvasId, edges, hydrated, nodes, persistRunHistory]);

  useEffect(() => {
    if (!hydrated || !activeCanvasId) return;
    if (promptPresets.length === 0 || imageModels.length === 0 || videoModels.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const demoId = params.get("demo");
    if (demoId !== "cat-pixar" && demoId !== "dog-home-audit" && demoId !== "dog-sleep-audit" && demoId !== "dog-sleep-woman-audit" && demoId !== "dog-toy-semantic-audit" && demoId !== "border-collie-banana-audit" && demoId !== "golden-retriever-semantic-v10") return;
    const demoRunId = params.get("run") || "default";
    const demoKey = canvasScopedStorageKey(
      `free-canvas-demo-${demoId}-${demoRunId}-running`,
      storageScope,
    );
    if (window.sessionStorage.getItem(demoKey) === "1") return;
    const demoLeaseKey = canvasScopedStorageKey(
      `free-canvas-demo-lease-${demoId}-${demoRunId}`,
      storageScope,
    );
    const demoLeaseOwner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const currentLease = JSON.parse(window.localStorage.getItem(demoLeaseKey) || "null") as { owner?: string; expiresAt?: number } | null;
      if (currentLease?.owner && Number(currentLease.expiresAt) > Date.now()) {
        params.delete("demo");
        const next = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", next);
        onNotice("同一演示已在另一个画布标签中运行，本标签已停止重复拆解");
        return;
      }
      window.localStorage.setItem(demoLeaseKey, JSON.stringify({
        owner: demoLeaseOwner,
        expiresAt: Date.now() + CANVAS_DEMO_LEASE_TTL_MS,
      }));
    } catch {
      // localStorage unavailable: session-level guard below still prevents duplicates in this tab.
    }
    const releaseDemoLease = () => {
      try {
        const currentLease = JSON.parse(window.localStorage.getItem(demoLeaseKey) || "null") as { owner?: string } | null;
        if (currentLease?.owner === demoLeaseOwner) window.localStorage.removeItem(demoLeaseKey);
      } catch {
        // Ignore storage cleanup failures.
      }
    };
    window.sessionStorage.setItem(demoKey, "1");
    // A demo replaces the active canvas. Clear the previous graph immediately so
    // users can see that a fresh storyboard is being assembled while compilation runs.
    const demoStartedAt = new Date().toISOString();
    setCanvasSessions((current) => current.map((session) => session.id === activeCanvasId
        ? { ...session, nodes: [], edges: [], updatedAt: demoStartedAt }
        : session));
    setNodes([]);
    setEdges([]);
    setSelectedId(null);

    if (demoId === "dog-home-audit" || demoId === "dog-sleep-audit" || demoId === "dog-sleep-woman-audit" || demoId === "dog-toy-semantic-audit" || demoId === "border-collie-banana-audit" || demoId === "golden-retriever-semantic-v10") {
      const isBorderCollieAudit = demoId === "border-collie-banana-audit";
      const isToySemanticAudit = demoId === "dog-toy-semantic-audit";
      const isGoldenSemanticAudit = demoId === "golden-retriever-semantic-v10";
      const selectedStyle = ANIMATION_STYLE_OPTIONS.find((style) => style.id === (isGoldenSemanticAudit ? "pixar-3d" : "cinematic-cartoon-realism-3d")) || ANIMATION_STYLE_OPTIONS[0];
      const styleGuide = selectedStyle.prompt;
      const isWomanAudit = demoId === "dog-sleep-woman-audit";
      const isSleepAudit = demoId === "dog-sleep-audit" || isWomanAudit;
      const bananaModel = isBorderCollieAudit
        ? imageModels.find((model) => model.id === "gemini-3-1-flash-image-chA" || /(?:Nano\s*)?Banana/i.test(model.name))
        : undefined;
      if (isBorderCollieAudit && !bananaModel) {
        onNotice("Banana 图片模型暂时不可用，已停止本轮检查以避免用错模型");
        window.sessionStorage.removeItem(demoKey);
        releaseDemoLease();
        return;
      }
      const demoScript = isGoldenSemanticAudit ? GOLDEN_RETRIEVER_SEMANTIC_SCRIPT : isBorderCollieAudit ? BORDER_COLLIE_HOME_SCRIPT : isToySemanticAudit ? DOG_TOY_SEMANTIC_SCRIPT : isWomanAudit ? DOG_SLEEP_WOMAN_SCRIPT : isSleepAudit ? DOG_SLEEP_GUARD_SCRIPT : DOG_HOME_SCRIPT;
      const demoRatio: AspectRatio = isBorderCollieAudit || isWomanAudit || !isSleepAudit ? "16:9" : "9:16";
      const demoInstruction = isGoldenSemanticAudit ? GOLDEN_RETRIEVER_SEMANTIC_INSTRUCTION : isBorderCollieAudit ? BORDER_COLLIE_HOME_INSTRUCTION : isToySemanticAudit ? DOG_TOY_SEMANTIC_INSTRUCTION : isWomanAudit ? DOG_SLEEP_WOMAN_INSTRUCTION : "";
      const gptImageModel = isGoldenSemanticAudit
        ? imageModels.find((model) => /gpt[- ]?image[- ]?2/i.test(`${model.name} ${model.model_name}`))
        : undefined;
      const veoFastModel = isGoldenSemanticAudit
        ? videoModels.find((model) => model.id === "veo-3-1-fast-chC" || /Veo\s*3\.1\s*Fast/i.test(model.name))
        : undefined;
      if (isGoldenSemanticAudit && (!gptImageModel || !veoFastModel)) {
        onNotice("GPT-Image-2 或 Veo 3.1 Fast 8秒模型暂时不可用，已停止本轮检查以避免用错模型");
        window.sessionStorage.removeItem(demoKey);
        releaseDemoLease();
        return;
      }
      setProductionModeId("anime-story");
      setProPanelOpen(true);
      setScriptImporterOpen(true);
      setAdvancedDraftOpen(isGoldenSemanticAudit || isToySemanticAudit || isWomanAudit || isBorderCollieAudit);
      setAnimationStyleId(selectedStyle.id);
      setScriptStyleDraft("");
      setScriptRatioDraft(demoRatio);
      updateConsistencySourceDraft("explore");
      setKeyframeStrategyDraft("visual-anchor");
      setEffectsLevelDraft("rich");
      setAssistantDraftOpen(isGoldenSemanticAudit || isToySemanticAudit || isWomanAudit || isBorderCollieAudit);
      setAssistantInstruction(demoInstruction);
      setScriptDraft(demoScript);
      if (bananaModel) setCanvasImageModelId(bananaModel.id);
      if (gptImageModel) setCanvasImageModelId(gptImageModel.id);
      if (veoFastModel) setCanvasVideoModelId(veoFastModel.id);
      void createCanvasFromScript(demoScript, styleGuide, demoRatio, "anime_story", {
        assistantInstructionOverride: demoInstruction,
        runNameOverride: isGoldenSemanticAudit ? "金毛误吞风险 · GPT-5.6语义包装全流程" : isBorderCollieAudit ? "边牧拆家 · Banana检查" : isToySemanticAudit ? "狗狗心虚拆玩具 · 语义包装检查" : isWomanAudit ? "女主人守护睡眠 · 16:9复测" : isSleepAudit ? "小狗守护睡眠 · 第二阶段测试" : "楼房养狗观点分镜演示",
        consistencySourceOverride: "explore",
        keyframeStrategyOverride: "visual-anchor",
        effectsLevelOverride: "rich",
        ...(bananaModel ? { imageModelIdOverride: bananaModel.id } : {}),
        ...(gptImageModel ? { imageModelIdOverride: gptImageModel.id } : {}),
        ...(veoFastModel ? { videoModelIdOverride: veoFastModel.id } : {}),
        ...(isGoldenSemanticAudit
          ? {
              qualityNotes: [
                "检查项：GPT-5.6逐镜识别语义缺口，装饰内容不能套固定符号或贴纸模板。",
                "检查项：先生成单角色中性身份定妆图，再让逐镜参考图只继承身份；剧情构图、道具和语义装饰仍由当前口播段决定。",
                "检查项：脚步逼近、心虚伪装、误吞风险、体内堵塞和安全放松应采用各自最合适的可见表达，并保持前后道具状态连续。",
                "检查项：全部参考图成功后，使用 Veo 3.1 Fast 8秒逐条提交视频，按模型登记的原生时长提交。",
              ],
            }
          : isBorderCollieAudit
          ? {
              qualityNotes: [
                "原文“边牧新眼子多”疑似为“边牧心眼子多”，本次保留原文并记录待人工确认。",
                "原文“尸狗哪有不拆家的”疑似为“是狗哪有不拆家的”，本次不擅自改写口播。",
                "原文“老天只狗”与结尾“生气了我”存在疑似断句或转写错误，需在正式导出前确认。",
                "检查项：沙发表面完好与底部破洞必须形成状态反差；边牧的心虚表演、损坏道具和语义图形修饰要自然关联。",
              ],
            }
          : isToySemanticAudit
          ? {
              qualityNotes: [
                "质检项：分镜文案只定义语义目标；视频提示词先给出动作与装饰运动方案；生图提示词再由同镜视频方案反推静态首帧。",
                "质检项：紧张、发抖、害怕责备的镜头必须把低饱和红色紧绷线或同类非文字装饰画进参考图，并在视频里绑定同一装饰运动。",
                "质检项：逐镜核对一段口播、一条视频提示词、一条生图提示词、一张自动关键帧和一个视频严格一一对应。",
              ],
            }
          : isWomanAudit
          ? {
              qualityNotes: [
                "复测项：口播原文必须完整保留，女主人设定只进入角色与画面约束，不得改写口播。",
                "复测项：每个分镜按每秒约6字估算为3至5秒，优先保证语义完整；固定时长模型按登记秒数生成，预览与下载保留完整视频。",
                "复测项：逐镜核对一段口播、一条视频提示词、一条生图提示词、一张自动关键帧和一个视频严格一一对应。",
                "复测项：声音只保留与动作同步的场景音和道具接触声，不生成背景音乐、旁白、配音、对白或字幕。",
              ],
            }
          : isSleepAudit
            ? {}
          : {
              qualityNotes: [
                "开头“人说”疑似漏字，请核对是否应为“有人说”。",
                "“半块发酸的圣饼”疑似语音识别错误，请核对是否应为“剩饼”。",
                "“早就把眼。封存的防御机制”存在异常断句或漏词，需要人工修订。",
                "文案中“他 / 它 / 他们”指代混用，建议统一后再生成，避免模型误判角色数量。",
              ],
            }),
      }).finally(() => {
        const next = new URL(window.location.href);
        next.searchParams.delete("demo");
        window.history.replaceState(null, "", next.toString());
        // Removing a query parameter does not trigger a React render. Nudge the
        // graph once so autogen starts against the newly compiled nodes, never
        // against the previous canvas that was visible when the demo began.
        setNodes((current) => [...current]);
        window.sessionStorage.removeItem(demoKey);
        releaseDemoLease();
      });
      return;
    }

    const styleGuide = [
      ANIMATION_STYLE_OPTIONS[0].prompt,
      "主角始终为同一只圆润橘白猫，圆脸、琥珀色大眼睛、白色胸口与爪尖。",
      "家庭客厅、进食区和宠物医院保持电影级柔和光影；允许问号、警示图标和情绪线等非文字动画修饰。",
    ].join("；");
    setAnimationStyleId("pixar-3d");
    setScriptStyleDraft("");
    setScriptRatioDraft("16:9");
    updateConsistencySourceDraft("explore");
    setKeyframeStrategyDraft("visual-anchor");
    setEffectsLevelDraft("rich");
    setAssistantInstruction("主角固定为同一只圆润橘白猫，圆脸、琥珀色大眼睛、白色胸口与爪尖。");
    setScriptDraft(CAT_HEALTH_SCRIPT);
    void createCanvasFromScript(CAT_HEALTH_SCRIPT, styleGuide, "16:9", "anime_story", {
      assistantInstructionOverride: "主角固定为同一只圆润橘白猫，圆脸、琥珀色大眼睛、白色胸口与爪尖。",
      consistencySourceOverride: "explore",
    }).finally(() => {
      const next = new URL(window.location.href);
      next.searchParams.delete("demo");
      window.history.replaceState(null, "", next.toString());
      window.sessionStorage.removeItem(demoKey);
    });
  }, [activeCanvasId, createCanvasFromScript, hydrated, imageModels, onNotice, promptPresets.length, storageScope, updateConsistencySourceDraft, videoModels]);

  const applyCanvasTemplate = useCallback((template: "campaign" | "image" | "video") => {
    const requestedImageModel = imageModels.find((model) => model.id === (canvasImageModelId || defaultImageModelId));
    const requestedVideoModel = videoModels.find((model) => model.id === (canvasVideoModelId || defaultVideoModelId));
    const selectedImageIssue = canvasModelAdmissionIssue(requestedImageModel, "image");
    const selectedVideoIssue = template !== "image" ? canvasModelAdmissionIssue(requestedVideoModel, "video") : "";
    if (selectedImageIssue || selectedVideoIssue) { onNotice(selectedImageIssue || selectedVideoIssue); return; }
    const referenceVideoModel = requestedVideoModel?.supportsImageInput
      ? requestedVideoModel
      : undefined;
    const needsReferenceVideoModel = template === "campaign" || template === "video";
    if (!requestedImageModel) {
      onNotice("当前暂无可用的图片生成模型");
      return;
    }
    if (needsReferenceVideoModel && !referenceVideoModel) {
      onNotice("该模板需要图片参考；请手动选择支持图生视频的模型，当前选择未改变。");
      return;
    }
    const templateImageModelId = requestedImageModel.id;
    const templateVideoModelId = needsReferenceVideoModel
      ? referenceVideoModel?.id || canvasVideoModelId || defaultVideoModelId
      : canvasVideoModelId || defaultVideoModelId;
    const templateImageResolution = coerceImageResolution(
      imageModels.find((model) => model.id === templateImageModelId),
      canvasImageResolution,
    );
    const templateVideoResolution = coerceCanvasVideoResolution(
      videoModels.find((model) => model.id === templateVideoModelId),
      selectedCanvasVideoResolution,
    );
    if (templateImageResolution !== canvasImageResolution) {
      setCanvasImageResolution(templateImageResolution);
    }
    const defaults = {
      imageModelId: templateImageModelId,
      videoModelId: templateVideoModelId,
      aspectRatio: defaultAspectRatio,
      imageResolution: templateImageResolution,
      videoResolution: templateVideoResolution,
    };
    const insertionY = template === "campaign" || nodesRef.current.length === 0
      ? 140
      : Math.max(...nodesRef.current.map((node) => node.position.y)) + 430;
    const text = starterNode("text", 1, { x: 220, y: insertionY }, defaults);
    const image = starterNode("image", 1, { x: 780, y: insertionY }, defaults);
    const video = starterNode("video", 1, { x: 1340, y: insertionY }, defaults);
    const upload = starterNode("upload", 1, { x: 220, y: insertionY + 420 }, defaults);

    if (template === "campaign") {
      upload.data = { ...upload.data, title: "产品参考图" };
      text.data = {
        ...text.data,
        title: "广告卖点脚本",
        prompt: "产品名称：\n目标人群：\n核心卖点：\n使用场景：\n镜头动作：产品保持真实外观，轻微旋转或推进展示质感\n禁用：不要改变产品结构、颜色、Logo和包装文字",
      };
      video.data = {
        ...video.data,
        title: `产品广告视频 ${templateVideoResolution}`,
        prompt: "基于上传的产品参考图和以下广告卖点脚本生成动态视频广告：\n{{input.text}}\n产品主体必须保持与参考图一致，不凭空重绘产品，不改变Logo、包装、颜色和结构；只允许增加光影、运镜、场景氛围和轻量广告动效。",
        resolution: templateVideoResolution,
      };
      setNodes([upload, text, video]);
      setEdges(normalizeEdges([
        { id: `${upload.id}->${video.id}`, source: upload.id, target: video.id },
        { id: `${text.id}->${video.id}`, source: text.id, target: video.id },
      ]));
    } else if (template === "image") {
      text.data = { ...text.data, title: "全文角色 / 视觉探索说明", prompt: "粘贴完整文案或角色设定：\n核心人物 / 宠物：\n动画或视觉风格：\n需要保持：身份、毛色/发型、体型、服装/配饰、核心材质\n允许变化：表情、构图、角度、光影和环境氛围\n禁用：拼贴画、分镜格、字幕、水印和可读文字" };
      image.data = {
        ...image.data,
        title: "全片角色 / 风格探索（4选1）",
        prompt: "根据以下完整文案或角色设定生成四张彼此独立的角色、宠物或核心人物组合候选图：\n{{input.text}}\n四张保持同一故事身份与统一视觉风格，在构图、表情、机位和环境氛围上提供有区分度的方向。每张主体清晰完整、可作为后续一致性锚点；不要生成四宫格拼贴、字幕、水印或可读文字。",
        imageMode: "grid",
        imageCount: 4,
        candidateSelectionRequired: true,
        selectedCandidateId: undefined,
        resolution: templateImageResolution,
      };
      setNodes([...nodesRef.current, text, image]);
      setEdges(normalizeEdges([...edgesRef.current,
        { id: `${text.id}->${image.id}`, source: text.id, target: image.id },
      ]));
    } else {
      upload.data = { ...upload.data, title: "已有首帧（手动工具）" };
      text.data = { ...text.data, title: "视频运镜脚本", prompt: "镜头运动：\n主体动作：\n场景变化：\n节奏/氛围：\n禁用：不要改变已有首帧中的主体身份和关键结构" };
      video.data = { ...video.data, title: `已有图片转视频 ${templateVideoResolution}`, prompt: "依据用户主动选择的已有首帧和以下视频运镜脚本生成稳定短片：\n{{input.text}}\n已有图片中的主体必须保持一致，避免主体变形，动作和运镜按脚本执行。", resolution: templateVideoResolution };
      setNodes([...nodesRef.current, upload, text, video]);
      setEdges(normalizeEdges([...edgesRef.current,
        { id: `${upload.id}->${video.id}`, source: upload.id, target: video.id },
        { id: `${text.id}->${video.id}`, source: text.id, target: video.id },
      ]));
    }

    setSelectedId(null);
    window.setTimeout(() => fitCanvas(), 0);
    onNotice(template === "image"
      ? "已插入视觉探索：先生成4张独立候选，再选定1张作为全片角色 / 风格锚点"
      : template === "video"
        ? "已插入已有图片转视频手动工具"
        : "已搭建产品图生视频画布");
  }, [canvasImageModelId, canvasImageResolution, canvasVideoModelId, defaultAspectRatio, defaultImageModelId, defaultVideoModelId, fitCanvas, imageModels, onNotice, selectedCanvasVideoResolution, videoModels]);

  const selectProductionMode = useCallback((modeId: ProductionModeId) => {
    const mode = PRODUCTION_MODES.find((item) => item.id === modeId) || PRODUCTION_MODES[0];
    setProductionModeId(mode.id);
    setProPanelOpen(true);
    setProPanelTab("setup");

    if (mode.id === "product-video") {
      setScriptImporterOpen(false);
      applyCanvasTemplate("campaign");
      onNotice("已切换到产品制作：上传真实产品图，填写卖点脚本后直接生成图生视频。");
      return;
    }

    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setScriptImporterOpen(true);
    updateConsistencySourceDraft("auto");
    setKeyframeStrategyDraft("visual-anchor");
    setEffectsLevelDraft("light");

    if (mode.id === "anime-story") {
      const style = ANIMATION_STYLE_OPTIONS[0];
      setAnimationStyleId(style.id);
      setScriptStyleDraft("");
      setEffectsLevelDraft("rich");
      updateConsistencySourceDraft("explore");
      onNotice("已切换到故事版提示词制作：粘贴分段文案、选择接收模板信息，系统会自动拆解并加载参考图提示词和视频提示词。");
    } else if (mode.id === "real-story") {
      setAnimationStyleId("cinematic-3d");
      setScriptStyleDraft("真实风剧情短片，真人影视摄影质感，真实材质、自然光影、可信表演；系统根据全文统一人物、场景和画面方向。");
      setEffectsLevelDraft("none");
      onNotice("已切换到真实风剧情：系统会按全文自动统一人物与场景并搭建镜头。");
    } else {
      const style = ANIMATION_STYLE_OPTIONS[0];
      setAnimationStyleId(style.id);
      setScriptStyleDraft(`${style.prompt}；整体控制为约10秒短视频，镜头少、动作清楚、节奏紧凑。`);
      onNotice("已切换到10秒视频制作：短文案会自动拆成少量关键帧与视频镜头。");
    }
  }, [applyCanvasTemplate, onNotice, updateConsistencySourceDraft]);

  function previewAsset(nodeId: string) {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node?.data.outputUrl && !node?.data.imagePreviewUrl) {
      onNotice("这个节点还没有可预览的结果");
      return;
    }
    setPreviewNodeId(nodeId);
  }

  async function saveWorkflowAsset(node: WorkflowFlowNode) {
    if (!node.data.outputUrl && !node.data.imagePreviewUrl) return false;
    if(node.data.imagePreviewUrl){const anchor=document.createElement("a");anchor.href=node.data.imagePreviewUrl;anchor.download=assetFilename(node);anchor.click();return true;}
    const token = localStorage.getItem(TOKEN_KEY);
    const streamOriginalVideoDownload = async () => {
      const taskId = node.data.taskId || taskIdFromPlaybackUrl(node.data.outputUrl);
      if (!token || !taskId) throw new Error("缺少原片下载凭据");
      const params = new URLSearchParams({
        taskId,
        scope: "download",
        name: assetFilename(node),
      });
      const response = await fetch(`/api/video/access-ticket?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await responseJson<{ url?: string; error?: string }>(response);
      if (!response.ok || !data.url) throw new Error(data.error || "原片下载凭据生成失败");
      const anchor = document.createElement("a");
      anchor.href = data.url;
      anchor.download = assetFilename(node);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    };
    const downloadResponse = async (response: Response) => {
      if (!response.ok) throw new Error(`资源读取失败 (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = assetFilename(node, blob.type);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Keep the blob URL alive for the page session. Large videos can
      // take more than a minute to finish saving, and early revocation cancels
      // an otherwise valid browser download. The browser releases it on unload.
    };
    try {
      if (node.data.kind === "video") {
        await streamOriginalVideoDownload();
        return true;
      }
      let response: Response;
      if (node.data.assetId && token) {
        response = await fetch(`/api/storage/files/${encodeURIComponent(node.data.assetId)}/content?download=1`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
      } else {
        response = await fetch(node.data.outputUrl,{headers:node.data.imageDeliveryReceipt?.deliveryMode==="provider_url" && token?{Authorization:"Bearer "+token}:{},cache:"no-store"});
      }
      await downloadResponse(response);
      return true;
    } catch {
      const anchor = document.createElement("a");
      anchor.href = node.data.outputUrl;
      anchor.download = assetFilename(node);
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return false;
    }
  }

  function downloadAsset(nodeId: string) {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node?.data.outputUrl && !node?.data.imagePreviewUrl) {
      onNotice("这个节点还没有可下载的结果");
      return;
    }
    void saveWorkflowAsset(node).then((saved) => {
      onNotice(saved ? `已下载 ${assetFilename(node)}` : "浏览器已打开结果文件；若未自动保存，请在新页面中下载");
    });
  }

  async function downloadAssets(kind: "image" | "video") {
    const kindLabel = kind === "image" ? "参考图" : "视频";
    const assetsToDownload = nodesRef.current
      .filter((node) => node.data.kind === kind && Boolean(node.data.imagePreviewUrl || node.data.outputUrl))
      .sort((left, right) => {
        return (getShotNumber(left) ?? Number.MAX_SAFE_INTEGER) - (getShotNumber(right) ?? Number.MAX_SAFE_INTEGER);
      });
    if (assetsToDownload.length === 0) {
      onNotice(`还没有已完成的${kindLabel}可下载`);
      return;
    }
    setDownloadBusy(true);
    onNotice(`正在按分镜序号下载 ${assetsToDownload.length} 个${kindLabel}…`);
    let directDownloads = 0;
    for (const node of assetsToDownload) {
      if (await saveWorkflowAsset(node)) directDownloads += 1;
      await delay(180);
    }
    if (kind === "video") {
      downloadTextFile("分镜口播文案对照.txt", buildStoryboardNarrationManifest(nodesRef.current, assetsToDownload));
    }
    setDownloadBusy(false);
    onNotice(directDownloads === assetsToDownload.length
      ? `已完成 ${assetsToDownload.length} 个${kindLabel}的批量下载${kind === "video" ? "，并附带分镜口播文案对照 TXT" : ""}`
      : `已处理 ${assetsToDownload.length} 个${kindLabel}；部分跨域文件已在新页面打开${kind === "video" ? "，分镜口播文案对照 TXT 已下载" : ""}`);
  }

  function exportGraph() {
    const currentCanvasName = canvasSessions.find((session) => session.id === activeCanvasId)?.name || "分镜工作流";
    const fileSafeCanvasName = currentCanvasName.replace(/[\\/:*?"<>|]/g, "_").trim() || "分镜工作流";
    const graph = {
      schemaVersion: 1,
      id: "manual-workflow",
      name: currentCanvasName,
      nodes: asDomainNodes(nodesRef.current),
      edges: edgesRef.current.map(({ id, source, target }) => ({ id, source, target })),
      updatedAt: new Date().toISOString(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(projectGeneratedImageDocument(graph), null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileSafeCanvasName}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportDiagnostics() {
    const entries = generationDiagnostics;
    if (entries.length === 0) {
      onNotice("还没有生成耗时记录；运行生图或视频后再导出");
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `自由画布生成诊断-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    onNotice(`已导出 ${entries.length} 条生成耗时记录`);
  }

  async function importGraph(file: File) {
    try {
      const parsed = WorkflowGraphSchema.parse(JSON.parse(await file.text()));
      setNodes(parsed.nodes as WorkflowFlowNode[]);
      setEdges(parsed.edges.map((edge) => ({ ...edge, animated: true, markerEnd: { type: MarkerType.ArrowClosed } })));
      setSelectedId(null);
      for (const delayMs of [60, 220, 500]) {
        window.setTimeout(() => flowRef.current?.fitView({ padding: 0.12, maxZoom: 1, duration: 0 }), delayMs);
      }
      onNotice(`已导入 ${parsed.nodes.length} 个节点`);
    } catch {
      onNotice("工作流 JSON 格式无效或版本不兼容");
    }
  }

  function inputSummary(nodeId: string) {
    const inputs = collectWorkflowInputs({ nodes: asDomainNodes(nodesRef.current), edges: edgesRef.current }, nodeId);
    const sourceIds = new Set(edgesRef.current.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
    const imageConnections = nodesRef.current.filter((node) => (
      sourceIds.has(node.id) && (
        node.data.kind === "image"
        || (node.data.kind === "upload" && !isAudioUpload(node.data))
      )
    )).length;
    const audioConnections = nodesRef.current.filter((node) => (
      sourceIds.has(node.id) && isAudioUpload(node.data)
    )).length;
    const unverifiedReferences = nodesRef.current.filter((node) => (
      sourceIds.has(node.id)
      && node.data.assetRole === "storyboard-keyframe"
      && node.data.referenceValidationStatus !== "verified"
    )).length;
    return {
      texts: inputs.texts.length,
      images: inputs.imageUrls.length,
      imageConnections,
      audios: inputs.audioUrls.length,
      audioConnections,
      gridImages: inputs.imageSources.filter((source) => source.imageMode === "grid" || source.imageCount > 1).length,
      unverifiedReferences,
    };
  }

  function runNode(nodeId: string, options: NodeExecutionOptions = {}) {
    onNotice(null);
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    const recoveringAcceptedMedia = (node.data.kind === "video" && Boolean(node.data.taskId) && !options.forceVideoResubmit)
      || (node.data.kind === "image" && Boolean(node.data.pendingPersistUrl || node.data.imageClientTraceId && node.data.imageClientIdempotencyKey));
    if (!recoveringAcceptedMedia && (node.data.kind === "image" || node.data.kind === "video")) {
      const model = node.data.kind === "image" ? currentModelCatalogRef.current.imageModels.find(item => item.id === node.data.modelId) : currentModelCatalogRef.current.videoModels.find(item => item.id === node.data.modelId);
      const issue = canvasModelAdmissionIssue(model, node.data.kind);
      if (issue) { onNotice(issue); return; }
    }
    if (activeNodeRunsRef.current.has(nodeId) || node.data.status === "running" || node.data.status === "queued") {
      onNotice(`${node.data.title}仍在执行，已阻止重复提交`);
      return;
    }
    if (!options.ignoreGenerationBlock && node?.data.generationBlockedReason && !isDirectorQualityAdvisory(node.data.generationBlockedReason)) {
      onNotice(node.data.generationBlockedReason);
      return;
    }
    activeNodeRunsRef.current.add(nodeId);
    const generatedAudio = isAudioUpload(node.data) && Boolean(node.data.audioMode && node.data.audioMode !== "upload");
    const requiresDurableCheckpoint = node.data.kind === "image" || node.data.kind === "video" || generatedAudio;
    const executionPromise = (async () => {
      if (requiresDurableCheckpoint && !options.persistenceCheckpointConfirmed) {
        await ensureActiveCanvasPersistedForGeneration();
      }
      const executionNodes = node.data.kind === "image" || node.data.kind === "video"
        ? lockMediaNodeModels([node.data.kind])
        : nodesRef.current;
      const startedAt = new Date().toISOString();
      persistRunHistory((current) => current.map((record) => (
        record.canvasId === activeCanvasId && record.status === "draft"
          ? {
              ...record,
              events: record.events.map((event) => event.nodeId === nodeId
                ? { ...event, status: "running", startedAt, completedAt: undefined, error: undefined }
                : event),
            }
          : record
      )));
      return executeNode(nodeId, executionNodes, { ...options, trigger: options.trigger || "manual" });
    })();
    void executionPromise.then((runtime) => {
      const completedAt = new Date().toISOString();
      const completedNode = runtime.find((node) => node.id === nodeId);
      persistRunHistory((current) => current.map((record) => (
        record.canvasId === activeCanvasId && record.status === "draft"
          ? {
              ...record,
              nodes: snapshotRunNodes(runtime),
              edges: edgesRef.current,
              events: record.events.map((event) => event.nodeId === nodeId
                ? { ...event, status: "succeeded", completedAt, outputUrl: completedNode?.data.outputUrl || undefined, error: undefined }
                : event),
            }
          : record
      )));
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "节点执行失败";
      const failedAt = new Date().toISOString();
      persistRunHistory((current) => current.map((record) => (
        record.canvasId === activeCanvasId && record.status === "draft"
          ? {
              ...record,
              nodes: snapshotRunNodes(nodesRef.current),
              edges: edgesRef.current,
              events: record.events.map((event) => event.nodeId === nodeId
                ? { ...event, status: "failed", completedAt: failedAt, error: message }
                : event),
            }
          : record
      )));
      onNotice(message);
    }).finally(() => {
      activeNodeRunsRef.current.delete(nodeId);
    });
  }

  function regenerateNode(nodeId: string) {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    const generatedAudio = Boolean(node && isAudioUpload(node.data) && node.data.audioMode && node.data.audioMode !== "upload");
    if (!node || (node.data.kind !== "image" && node.data.kind !== "video" && !generatedAudio)) return;
    if (node.data.status === "running" || node.data.status === "queued") {
      onNotice(`${node.data.title}仍在执行，不能重复提交`);
      return;
    }
    const kindLabel = generatedAudio ? "音频" : node.data.kind === "video" ? "视频" : "图片";
    if (!window.confirm(`重新生成会创建新的${kindLabel}任务，可能再次计费。当前历史结果会保留，确定继续吗？`)) return;

    const previousData = { ...node.data };
    void (async () => {
      try {
        await ensureActiveCanvasPersistedForGeneration();
      } catch {
        return;
      }

      // Historical candidates retain their own current-page previews until canvas cleanup.
      replaceRuntimeNode(nodesRef.current, nodeId, {
        imagePreviewUrl:undefined,imageDeliveryReceipt:undefined,imageRef:undefined,
        outputUrl: "",
        taskId: "",
        clientRequestId: undefined,
        clientRequestFingerprint: undefined,
        imageClientTraceId: undefined,
        imageClientIdempotencyKey: undefined,
        imageRequestFingerprint: undefined,
        pendingPersistUrl: undefined,
        pendingPersistIndex: undefined,
        pendingPersistWidth: undefined,
        pendingPersistHeight: undefined,
        pendingPersistCharge: undefined,
        pendingPersistCashRemaining: undefined,
        providerContentUrl: "",
        assetId: undefined,
        storageKey: undefined,
        historyRecordId: undefined,
        billingReferenceId: undefined,
        actualCost: undefined,
        creditsCharged: undefined,
        retailPriceRmb: undefined,
        billingUnit: undefined,
        cashRemaining: undefined,
        completedAt: undefined,
        status: "idle",
        progressMessage: undefined,
        error: undefined,
        ...(node.data.kind === "video" ? {
          playbackStatus: "unchecked" as const,
          playbackError: undefined,
        } : {}),
      });

      try {
        await ensureActiveCanvasPersistedForGeneration();
      } catch {
        replaceRuntimeNode(nodesRef.current, nodeId, previousData);
        return;
      }

      setPreviewNodeId((current) => current === nodeId ? null : current);
      onNotice(`正在为 ${node.data.title} 创建新的${kindLabel}任务`);
      runNode(nodeId, {
        ignoreGenerationBlock: true,
        trigger: "manual",
        persistenceCheckpointConfirmed: true,
      });
    })();
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      if (isTyping) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedNode();
        return;
      }
      if (event.key === "1") {
        event.preventDefault();
        fitCanvas();
        return;
      }
      if (event.key === "2") {
        event.preventDefault();
        focusSelectedNode();
        return;
      }
      if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        tidyCanvas();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [duplicateSelectedNode, fitCanvas, focusSelectedNode, tidyCanvas]);

  const contextValue: FreeNodeContextValue = {
    imageModels,
    videoModels,
    voiceOptions,
    voicePricing,
    uploadBusy,
    selectedNodeId: selectedId,
    updateNode,
    selectImageCandidate,
    setVideoMode,
    runNode,
    regenerateNode,
    previewAsset,
    downloadAsset,
    deleteNode,
    uploadNode: (nodeId, file) => { void uploadAsset(nodeId, file); },
    inputSummary,
  };
  const activeCanvas = canvasSessions.find((session) => session.id === activeCanvasId) || canvasSessions[0];
  const selectedNode = selectedId ? nodes.find((node) => node.id === selectedId) || null : null;
  const previewNode = previewNodeId ? nodes.find((node) => node.id === previewNodeId) || null : null;
  const recentRunHistory = runHistory.slice(0, CANVAS_HISTORY_MAX_RECORDS);
  const recentGenerationDiagnostics = generationDiagnostics
    .filter((entry) => entry.canvasId === activeCanvasId)
    .slice(0, 12);
  const latestRunRecord = recentRunHistory[0];
  const restoreRunRecord = useCallback((record: CanvasRunRecord) => {
    const restoredNodes = snapshotRunNodes(record.nodes);
    const restoredEdges = normalizeEdges(record.edges);
    const now = new Date().toISOString();
    const existingSession = canvasSessions.find((session) => session.id === record.canvasId);
    const restoredSessionId = existingSession ? existingSession.id : `canvas:${crypto.randomUUID()}`;
    const restoredSession: CanvasSession = {
      id: restoredSessionId,
      name: existingSession?.name || `${record.canvasName || "历史画布"}恢复`,
      createdAt: existingSession?.createdAt || record.startedAt,
      updatedAt: now,
      revision: existingSession?.revision || 0,
      viewport: existingSession?.viewport || viewportRef.current,
      nodes: restoredNodes,
      edges: restoredEdges,
    };
    if (!existingSession) canvasRevisionRef.current.set(restoredSessionId, 0);
    setCanvasSessions((current) => current.some((session) => session.id === restoredSessionId)
        ? current.map((session) => session.id === restoredSessionId ? restoredSession : session)
        : [restoredSession, ...current]);
    setActiveCanvasId(restoredSessionId);
    setNodes(restoredNodes);
    setEdges(restoredEdges);
    setSelectedId(restoredNodes[0]?.id || null);
    applyStoryboardSettings(record.storyboardSettings);
    setCanvasMenuOpen(false);
    window.setTimeout(() => fitCanvas(), 0);
    onNotice(`已恢复 ${formatHistoryTimestamp(record.startedAt)} 的运行记录`);
  }, [applyStoryboardSettings, canvasSessions, fitCanvas, onNotice]);

  const deleteRunRecord = useCallback((runId: string) => {
    persistRunHistory((current) => current.filter((record) => record.id !== runId));
  }, [persistRunHistory]);

  const runStatusLabel: Record<CanvasRunRecord["status"], string> = {
    draft: "待执行",
    running: "执行中",
    completed: "已完成",
    partial: "部分失败",
    failed: "失败",
  };
  const runRecordStatusLabel = (record: CanvasRunRecord) => (
    record.recordType === "test-snapshot" ? "检查快照" : runStatusLabel[record.status]
  );
  const canvasStats = useMemo(() => {
    const byKind = (kind: WorkflowNodeKind) => nodes.filter((node) => node.data.kind === kind).length;
    const completedByKind = (kind: WorkflowNodeKind) => nodes.filter((node) => node.data.kind === kind && Boolean(node.data.outputUrl)).length;
    const succeeded = nodes.filter((node) => node.data.status === "succeeded").length;
    const failed = nodes.filter((node) => node.data.status === "failed").length;
    const narrationShotNodes = nodes.filter((node) => (
      node.data.kind === "text"
      && Boolean(node.data.semanticOrder)
      && (node.data.workflowRole === "narration"
        || /^(?:口播段\d+|分镜\d+(?:-\d+)?\s*·\s*口播文案)/u.test(node.data.title))
    ));
    const videoShotNodes = nodes.filter((node) => (
      node.data.kind === "video"
      && getShotNumber(node) !== null
    ));
    const storyboardTimingNodes = narrationShotNodes.length > 0 ? narrationShotNodes : videoShotNodes;
    const storyboardSeconds = storyboardTimingNodes.reduce((sum, node) => sum + (node.data.durationSeconds || 0), 0);
    const storyboardReferences = nodes.filter((node) => node.data.assetRole === "storyboard-keyframe");
    const verifiedReferences = storyboardReferences.filter((node) => (
      Boolean(node.data.outputUrl) && node.data.referenceValidationStatus === "verified"
    )).length;
    return {
      images: byKind("image"),
      videos: byKind("video"),
      completedImages: completedByKind("image"),
      completedVideos: completedByKind("video"),
      pendingImages: nodes.filter((node) => node.data.kind === "image" && !node.data.outputUrl).length,
      pendingVideos: nodes.filter((node) => node.data.kind === "video" && !node.data.outputUrl).length,
      texts: byKind("text"),
      uploads: byKind("upload"),
      semanticSegments: narrationShotNodes.length,
      visualShots: videoShotNodes.length,
      storyboardSeconds,
      storyboardReferences: storyboardReferences.length,
      verifiedReferences,
      succeeded,
      failed,
      ready: nodes.length > 0 && failed === 0,
    };
  }, [nodes]);
  const hasCharacterSetup = nodes.some((node) => (
    (node.data.kind === "image" || node.data.kind === "upload")
    && (node.data.workflowRole === "character-reference" || /角色设定/u.test(node.data.title))
  ));
  const activeRuntimeNode = nodes.find((node) => node.data.status === "running");
  const workStatus = useMemo<WorkStatus | null>(() => {
    if (scriptCompiling) {
      return {
        state: "running" as const,
        title: scriptCompileStageLabel,
        detail: scriptCompileElapsedSeconds < 24
          ? "正在提取语义、角色、场景与纠错信息"
          : "正在编写逐镜视频方案和生图提示词",
        elapsed: scriptCompileElapsedSeconds,
      };
    }
    if (runningAll) {
      const stageKind = activeRunStage === "images" || activeRunStage === "videos"
        ? activeRunStage
        : activeRuntimeNode?.data.kind === "video" ? "videos" : "images";
      if (batchControl === "paused") {
        return { state: "paused" as const, title: "队列已暂停", detail: "已提交任务继续保留；不会提交下一批", elapsed: batchRunElapsedSeconds };
      }
      if (batchControl === "stopping") {
        return { state: "stopping" as const, title: "正在停止队列", detail: "等待当前已提交批次收口，不再提交新任务", elapsed: batchRunElapsedSeconds };
      }
      if (stageKind === "images") {
        const runningImages = nodes.filter((node) => node.data.kind === "image" && node.data.status === "running").length;
        const characterSetupRunning = nodes.some((node) => node.data.status === "running" && /角色设定/u.test(node.data.title));
        return {
          state: "running" as const,
          title: characterSetupRunning ? "正在建立全片角色设定" : "正在分批生成参考图",
          detail: characterSetupRunning
            ? "正在分别生成单角色定妆图；系统会按模型限流自动错峰，生成后停下等待逐个确认"
            : `${canvasStats.completedImages}/${canvasStats.images} 已完成 · 当前 ${runningImages} 张 · 每 5 秒提交 1 张，结果并发等待`,
          elapsed: batchRunElapsedSeconds,
        };
      }
      const runningVideos = nodes.filter((node) => node.data.kind === "video" && node.data.status === "running").length;
      return {
        state: "running" as const,
        title: "正在错峰生成视频",
        detail: `${canvasStats.completedVideos}/${canvasStats.videos} 已完成 · ${runningVideos} 条在途 · 每 ${VIDEO_BATCH_SUBMIT_INTERVAL_MS / 1000} 秒最多提交 1 条`,
        elapsed: batchRunElapsedSeconds,
      };
    }
    if (activeRuntimeNode && (activeRuntimeNode.data.kind === "image" || activeRuntimeNode.data.kind === "video")) {
      return {
        state: "running" as const,
        title: activeRuntimeNode.data.kind === "image" ? "正在试生成参考图" : "正在试生成视频",
        detail: `${activeRuntimeNode.data.title} · ${activeRuntimeNode.data.progressMessage || "请求已提交"}`,
      };
    }
    if (downloadBusy) {
      return { state: "downloading" as const, title: "正在准备下载", detail: "正在整理结果并按目标时长输出文件" };
    }
    return null;
  }, [activeRunStage, activeRuntimeNode, batchControl, batchRunElapsedSeconds, canvasStats.completedImages, canvasStats.completedVideos, canvasStats.images, canvasStats.videos, downloadBusy, nodes, runningAll, scriptCompileElapsedSeconds, scriptCompileStageLabel, scriptCompiling]);
  const checklist = useMemo(() => [
    { label: "有明确 Brief 或文本节点", done: canvasStats.texts > 0 },
    { label: "有视觉产出节点", done: canvasStats.images > 0 || canvasStats.videos > 0 },
    { label: "每段口播均有对应参考图和视频", done: canvasStats.semanticSegments === 0 || canvasStats.visualShots >= canvasStats.semanticSegments },
    { label: "关键节点已连接", done: nodes.length <= 1 || edges.length > 0 },
    { label: "高清输出已设置", done: nodes.some((node) => node.data.kind === "image" && node.data.resolution === "4K") || nodes.some((node) => node.data.kind === "video" && node.data.resolution === "1080p") },
    { label: "没有失败节点", done: canvasStats.failed === 0 },
  ], [canvasStats.failed, canvasStats.images, canvasStats.semanticSegments, canvasStats.texts, canvasStats.videos, canvasStats.visualShots, edges.length, nodes]);
  const canSplitFromScript = productionModeId !== "product-video" && scriptDraft.trim().length > 0 && promptPresets.length > 0;
  const getPendingCharacterReferenceNodes = () => nodesRef.current.filter((node) => (
    node.data.kind === "image"
    && node.data.assetRole === "character-reference"
    && node.data.candidateSelectionRequired
    && !node.data.selectedCandidateId
  ));
  const pendingCandidateNode = nodes.find((node) => (
    node.data.assetRole !== "character-reference"
    && node.data.candidateSelectionRequired
    && !node.data.selectedCandidateId
  ));
  const candidateNeedsGeneration = Boolean(pendingCandidateNode && !pendingCandidateNode.data.history.some((item) => item.outputUrl));
  const focusNodeForConfirmation = (node: WorkflowFlowNode) => {
    setSelectedId(node.id);
    window.setTimeout(() => {
      flowRef.current?.setCenter(node.position.x + 260, node.position.y + 320, {
        zoom: window.innerWidth <= 760 ? 0.52 : 0.72,
        duration: 220,
      });
    }, 0);
  };
  const prepareCharacterReferences = async () => {
    const pendingCharacters = getPendingCharacterReferenceNodes();
    if (pendingCharacters.length === 0) return false;
    const toGenerate = pendingCharacters.filter((node) => !node.data.history.some((item) => item.outputUrl));
    if (toGenerate.length === 0) {
      onNotice(`已有 ${pendingCharacters.length} 张角色定妆图等待确认；请逐张选定后再继续参考图队列`);
      return true;
    }
    if (!window.localStorage.getItem(TOKEN_KEY)) {
      onRequireLogin();
      onNotice("请先连接主平台，再生成角色定妆图");
      return true;
    }
    const lockedNodes = lockMediaNodeModels(["image"]);
    const lockedById = new Map(lockedNodes.map((node) => [node.id, node]));
    setRunningAll(true);
    setActiveRunStage("images");
    updateBatchControl("running");
    queueRuntimeNodes(toGenerate.map((node) => node.id));
    let failedCount = 0;
    try {
      nextImageSubmitAtRef.current = 0;
      const results = await Promise.allSettled(toGenerate.map(async (node) => {
        await waitForImageSubmissionSlot();
        await executeNode(node.id, nodesRef.current.length ? nodesRef.current : [lockedById.get(node.id)!], { trigger: "batch" });
      }));
      failedCount += results.filter((result) => result.status === "rejected").length;
      persistRunHistory((current) => current.map((record) => (
        record.canvasId === activeCanvasId && record.status === "draft"
          ? { ...record, nodes: snapshotRunNodes(nodesRef.current), edges: edgesRef.current }
          : record
      )));
    } finally {
      resetQueuedRuntimeNodes(toGenerate.map((node) => node.id));
      setRunningAll(false);
      setActiveRunStage(null);
      updateBatchControl("idle");
    }
    onNotice(failedCount > 0
      ? `角色定妆图已完成本轮尝试，${failedCount} 个节点未成功；请先确认成功候选，失败节点可单独重试`
      : `已生成 ${toGenerate.length} 个角色定妆图；请逐张确认身份与固定造型，确认前不会继续分镜参考图`);
    return true;
  };

  const hasUnconfirmedCharacterReferences = () => nodesRef.current.some((node) => (
    node.data.kind === "image"
    && node.data.assetRole === "character-reference"
    && node.data.candidateSelectionRequired
    && !node.data.selectedCandidateId
  ));

  const focusPendingCandidate = () => {
    if (!pendingCandidateNode) return false;
    focusNodeForConfirmation(pendingCandidateNode);
    if (candidateNeedsGeneration) {
      runNode(pendingCandidateNode.id);
    } else {
      onNotice("视觉候选已生成，请先在探索节点中选定 1 张，再继续生成其余关键帧");
    }
    return true;
  };

  function runFirstPendingAsset(kind: "image" | "video") {
    if (runningAll || nodesRef.current.some((node) => node.data.status === "running")) {
      onNotice("当前已有生成任务在运行，请等待完成或先暂停批量队列");
      return;
    }
    const executionOrder = getWorkflowExecutionOrder({ nodes: asDomainNodes(nodesRef.current), edges: edgesRef.current });
    const nodeId = executionOrder.find((id) => {
      const node = nodesRef.current.find((item) => item.id === id);
      return node?.data.kind === kind && !node.data.outputUrl;
    });
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) {
      onNotice(kind === "image" ? "所有参考图都已生成" : "所有视频都已生成");
      return;
    }
    setSelectedId(node.id);
    window.setTimeout(() => {
      flowRef.current?.setCenter(node.position.x + 260, node.position.y + 210, { zoom: 0.82, duration: 240 });
    }, 0);
    onNotice(kind === "image" ? `正在试生成：${node.data.title}` : `正在试生成：${node.data.title}`);
    runNode(node.id, { ignoreGenerationBlock: true, trigger: "manual" });
  }
  const handleGenerationStage = async (stage: GenerationStage) => {
    if (nodes.length === 0) {
      openScriptPanel();
      onNotice("请先粘贴文案并完成镜头拆分");
      return;
    }
    if (stage === "all") {
      await prepareCharacterReferences();
      if (hasUnconfirmedCharacterReferences()) {
        const pending = getPendingCharacterReferenceNodes()[0];
        if (pending) focusNodeForConfirmation(pending);
        onNotice("当前停在角色定妆图确认：请逐张选定身份锚点，再开始分镜参考图");
        return;
      }
      if (focusPendingCandidate()) return;
      await executeWorkflowStage("images");
      onNotice("参考图批量任务已完成；请逐镜预览并点击 ✓ 确认，之后再点击“生成视频”。");
      return;
    }
    if (stage !== "videos") {
      await prepareCharacterReferences();
      if (hasUnconfirmedCharacterReferences()) {
        const pending = getPendingCharacterReferenceNodes()[0];
        if (pending) focusNodeForConfirmation(pending);
        onNotice("请先确认每张角色定妆图；确认前不会提交分镜参考图");
        return;
      }
    }
    if (stage !== "videos" && focusPendingCandidate()) return;
    await executeWorkflowStage(stage);
  };

  const acceptanceDecorationSamplesRef = useRef<() => Promise<{ succeeded: number; failed: number; titles: string[] }>>(async () => ({ succeeded: 0, failed: 0, titles: [] }));
  const reportAcceptanceState = async (runId: string, phase: string) => {
    if (process.env.NODE_ENV === "production") return;
    try {
      await fetch("/api/canvas/acceptance-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          phase,
          nodes: nodesRef.current.map((node) => ({
            id: node.id,
            title: node.data.title,
            kind: node.data.kind,
            assetRole: node.data.assetRole,
            status: node.data.status,
            progressMessage: node.data.progressMessage,
            error: node.data.error,
            outputUrl: node.data.outputUrl,
            prompt: node.data.prompt,
            modelId: node.data.modelId,
            taskId: node.data.taskId,
            playbackStatus: node.data.playbackStatus,
            playbackError: node.data.playbackError,
            history: node.data.history.map((item) => ({
              id: item.id,
              outputUrl: item.outputUrl,
              createdAt: item.createdAt,
            })),
          })),
        }),
      });
    } catch {
      // The report is diagnostic-only and must never interrupt media generation.
    }
  };
  acceptanceDecorationSamplesRef.current = async () => {
    const runtime = nodesRef.current;
    const domain = { nodes: asDomainNodes(runtime), edges: edgesRef.current };
    const candidates = runtime
      .filter((node) => (
        node.data.kind === "image"
        && node.data.assetRole === "storyboard-keyframe"
        && !node.data.outputUrl
        && node.data.status !== "running"
      ))
      .map((node) => {
        const inputs = collectWorkflowInputs(domain, node.id);
        const resolvedPrompt = resolveWorkflowPrompt(node.data.prompt, inputs);
        const graphicSection = resolvedPrompt.match(/【图形特效】([^【\r\n]+)/u)?.[1]?.trim() || "";
        return {
          node,
          hasGraphicDecoration: Boolean(graphicSection) && !/^(?:无|不使用|不添加|不需要)/u.test(graphicSection),
        };
      })
      .sort((left, right) => left.node.position.y - right.node.position.y);

    const spreadPick = <T,>(items: T[], count: number) => {
      if (count <= 0) return [];
      if (count === 1) return items.slice(0, 1);
      if (items.length <= count) return items;
      return Array.from({ length: count }, (_, index) => items[Math.round(index * (items.length - 1) / (count - 1))]);
    };
    const decoratedCandidates = candidates.filter((item) => item.hasGraphicDecoration);
    const selected = spreadPick(decoratedCandidates, Math.min(3, decoratedCandidates.length));
    const selectedIds = new Set(selected.map((item) => item.node.id));
    if (selected.length < 3) {
      const fallbackCandidates = candidates.filter((item) => !selectedIds.has(item.node.id));
      spreadPick(fallbackCandidates, Math.min(3 - selected.length, fallbackCandidates.length)).forEach((item) => {
        selected.push(item);
        selectedIds.add(item.node.id);
      });
    }
    if (selected.length === 0) throw new Error("当前画布没有可用于装饰检查的待生成关键帧");

    const lockedNodes = lockMediaNodeModels(["image"]);
    const lockedById = new Map(lockedNodes.map((node) => [node.id, node]));
    const toGenerate = selected
      .map((item) => lockedById.get(item.node.id))
      .filter((node): node is WorkflowFlowNode => Boolean(node));
    const firstNode = toGenerate[0];
    setSelectedId(firstNode.id);
    window.setTimeout(() => {
      flowRef.current?.setCenter(firstNode.position.x + 260, firstNode.position.y + 210, { zoom: 0.82, duration: 320 });
    }, 0);
    setRunningAll(true);
    setActiveRunStage("images");
    updateBatchControl("running");
    queueRuntimeNodes(toGenerate.map((node) => node.id));
    onNotice(`装饰样图正在生成 ${toGenerate.length} 张代表性关键帧：${toGenerate.map((node) => node.data.title).join("、")}`);

    let failed = 0;
    try {
      nextImageSubmitAtRef.current = 0;
      const results = await Promise.allSettled(toGenerate.map(async (node) => {
        await waitForImageSubmissionSlot();
        await executeNode(node.id, nodesRef.current);
      }));
      failed += results.filter((result) => result.status === "rejected").length;
    } finally {
      resetQueuedRuntimeNodes(toGenerate.map((node) => node.id));
      setRunningAll(false);
      setActiveRunStage(null);
      updateBatchControl("idle");
    }
    const succeeded = toGenerate.filter((node) => Boolean(nodesRef.current.find((item) => item.id === node.id)?.data.outputUrl)).length;
    return { succeeded, failed, titles: toGenerate.map((node) => node.data.title) };
  };

  const acceptanceGenerationStageRef = useRef(handleGenerationStage);
  const acceptanceNoticeRef = useRef(onNotice);
  acceptanceGenerationStageRef.current = handleGenerationStage;
  acceptanceNoticeRef.current = onNotice;

  useEffect(() => {
    if (
      process.env.NODE_ENV === "production"
      || !hydrated
      || scriptCompiling
      || runningAll
      || nodes.length === 0
      || imageModels.length === 0
      || videoModels.length === 0
    ) return;
    const params = new URLSearchParams(window.location.search);
    const autoMode = params.get("autogen");
    if (autoMode !== "acceptance-images" && autoMode !== "decoration-samples" && autoMode !== "full-flow") return;
    if (params.has("demo")) return;

    const runId = params.get("run") || activeCanvasId;
    const phaseKey = canvasScopedStorageKey(`free-canvas-${autoMode}-${runId}`, storageScope);
    const phase = window.sessionStorage.getItem(phaseKey) || "pending";
    const characterNodes = nodes.filter((node) => (
      node.data.kind === "image"
      && node.data.assetRole === "character-reference"
      && node.data.candidateSelectionRequired
    ));
    const pendingCharacters = characterNodes.filter((node) => !node.data.selectedCandidateId);

    const finishAutoMode = (nextPhase: string) => {
      window.sessionStorage.setItem(phaseKey, nextPhase);
      params.delete("autogen");
      const nextUrl = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", nextUrl);
    };

    if (phase === "pending") {
      if (autoMode === "full-flow") {
        window.sessionStorage.setItem(phaseKey, "storyboard-images-running");
        void acceptanceGenerationStageRef.current("images")
          .then(async () => {
            const storyboardImages = nodesRef.current.filter((node) => node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe");
            const imageSucceeded = storyboardImages.filter((node) => Boolean(node.data.outputUrl)).length;
            const imageFailed = storyboardImages.length - imageSucceeded;
            await reportAcceptanceState(runId, imageFailed > 0 ? "storyboard-images-partial" : "storyboard-images-completed");
            if (imageFailed > 0) {
              finishAutoMode("storyboard-images-partial");
              acceptanceNoticeRef.current(`全流程已停在图片阶段：${imageSucceeded} 张成功、${imageFailed} 张失败；未继续提交视频费用`);
              return;
            }
            finishAutoMode("awaiting-reference-validation");
            await reportAcceptanceState(runId, "awaiting-reference-validation");
            acceptanceNoticeRef.current(`图片阶段已完成：${imageSucceeded} 张参考图等待逐镜确认；未自动提交视频费用。点击每张参考图的 ✓ 后再运行视频阶段`);
          })
          .catch(async (error) => {
            finishAutoMode("full-flow-failed");
            await reportAcceptanceState(runId, "full-flow-failed");
            acceptanceNoticeRef.current(error instanceof Error ? error.message : "全流程自动检查失败");
          });
        return;
      }
      if (pendingCharacters.length === 0) {
        window.sessionStorage.setItem(phaseKey, "character-confirmed");
        setNodes([...nodesRef.current]);
        return;
      }
      const retryCharacterIds = new Set(pendingCharacters.map((node) => node.id));
      if (nodesRef.current.some((node) => retryCharacterIds.has(node.id) && node.data.status === "failed")) {
        const retryReadyNodes = nodesRef.current.map((node) => retryCharacterIds.has(node.id) && node.data.status === "failed"
          ? {
              ...node,
              data: {
                ...node.data,
                status: "idle" as const,
                error: undefined,
                progressMessage: undefined,
              },
            }
          : node);
        nodesRef.current = retryReadyNodes;
        setNodes(retryReadyNodes);
      }
      window.sessionStorage.setItem(phaseKey, "character-generation");
      void acceptanceGenerationStageRef.current("images");
      return;
    }

    if (phase === "character-generation") {
      if (pendingCharacters.length === 0) {
        window.sessionStorage.setItem(phaseKey, "character-confirmed");
        setNodes([...nodesRef.current]);
        return;
      }
      const characterGenerationStarted = characterNodes.some((node) => (
        node.data.status === "queued"
        || node.data.status === "running"
        || node.data.status === "failed"
        || node.data.history.some((item) => Boolean(item.outputUrl))
      ));
      if (!characterGenerationStarted) {
        void acceptanceGenerationStageRef.current("images");
        return;
      }
      if (characterNodes.some((node) => node.data.status === "queued" || node.data.status === "running")) return;

      const generatedCharacters = pendingCharacters.flatMap((node) => {
        const candidate = node.data.history.find((item) => Boolean(item.outputUrl));
        return candidate?.outputUrl ? [{ node, candidate }] : [];
      });
      const failedCharacters = pendingCharacters.filter((node) => !node.data.history.some((item) => Boolean(item.outputUrl)));

      generatedCharacters.forEach(({ node, candidate }) => {
        selectImageCandidate(node.id, candidate.id, candidate.outputUrl || "");
      });

      if (failedCharacters.length > 0) {
        finishAutoMode("character-failed");
        void reportAcceptanceState(runId, "character-failed");
        acceptanceNoticeRef.current(`检查已停下：${failedCharacters.length} 个角色定妆图生成失败；请重试角色图，系统没有继续消耗分镜生图费用`);
        return;
      }

      window.sessionStorage.setItem(phaseKey, "character-confirmed");
      void reportAcceptanceState(runId, "character-confirmed");
      return;
    }

    if (phase === "character-confirmed") {
      const confirmableCharacters = pendingCharacters.flatMap((node) => {
        const candidate = node.data.history.find((item) => Boolean(item.outputUrl));
        return candidate?.outputUrl ? [{ node, candidate }] : [];
      });
      if (confirmableCharacters.length > 0) {
        confirmableCharacters.forEach(({ node, candidate }) => {
          selectImageCandidate(node.id, candidate.id, candidate.outputUrl || "");
        });
        return;
      }
      if (pendingCharacters.length > 0) {
        finishAutoMode("character-failed");
        void reportAcceptanceState(runId, "character-failed");
        return;
      }
      if (autoMode === "decoration-samples") {
        window.sessionStorage.setItem(phaseKey, "sample-generation");
        void acceptanceDecorationSamplesRef.current()
          .then(async ({ succeeded, failed, titles }) => {
            const reportPhase = failed > 0 ? "sample-partial" : "sample-completed";
            finishAutoMode(reportPhase);
            await reportAcceptanceState(runId, reportPhase);
            const generatedSamples = nodesRef.current.filter((node) => (
              node.data.kind === "image"
              && node.data.assetRole === "storyboard-keyframe"
              && Boolean(node.data.outputUrl)
            ));
            if (generatedSamples.length > 0) {
              window.setTimeout(() => flowRef.current?.fitView({ nodes: generatedSamples, padding: 0.16, maxZoom: 0.56, duration: 320 }), 80);
            }
            acceptanceNoticeRef.current(failed > 0
              ? `装饰样图已返回：${succeeded} 张成功、${failed} 张失败；当前仍为待确认状态，请检查角色一致、剧情道具、环境反馈和语义装饰`
              : `装饰样图已生成：${titles.join("、")}；当前仍为待确认状态，请检查角色一致、剧情道具、环境反馈和语义装饰是否同时成立`);
          })
          .catch(async (error) => {
            finishAutoMode("sample-failed");
            await reportAcceptanceState(runId, "sample-failed");
            acceptanceNoticeRef.current(error instanceof Error ? error.message : "装饰检查生成失败");
          });
        return;
      }
      window.sessionStorage.setItem(phaseKey, "storyboard-generation");
      void acceptanceGenerationStageRef.current("images")
        .then(async () => {
          const storyboardImages = nodesRef.current.filter((node) => node.data.kind === "image" && node.data.assetRole === "storyboard-keyframe");
          const imageSucceeded = storyboardImages.filter((node) => Boolean(node.data.outputUrl)).length;
          const imageFailed = storyboardImages.length - imageSucceeded;
          const reportPhase = imageFailed > 0 ? "storyboard-images-partial" : "storyboard-images-completed";
          finishAutoMode(reportPhase);
          await reportAcceptanceState(runId, reportPhase);
          acceptanceNoticeRef.current(imageFailed > 0
            ? `图片检查阶段完成：${imageSucceeded} 张成功、${imageFailed} 张失败；没有继续提交视频`
            : `批量生图已完成：${imageSucceeded} 张关键帧均已返回，请逐镜检查语义包装后再生成视频`);
        })
        .catch(async (error) => {
          finishAutoMode("storyboard-images-partial");
          await reportAcceptanceState(runId, "storyboard-images-partial");
          acceptanceNoticeRef.current(error instanceof Error ? error.message : "批量生图检查失败");
        });
    }
  }, [activeCanvasId, hydrated, imageModels.length, nodes, runningAll, scriptCompiling, selectImageCandidate, storageScope, videoModels.length]);

  const handleSplitAction = () => {
    if (canSplitFromScript && nodes.length === 0) {
      void createCanvasFromScript(scriptDraft, effectiveScriptStyleGuide, scriptRatioDraft);
      return;
    }
    setProPanelTab("setup");
    openScriptPanel();
  };

  return (
    <FreeNodeContext.Provider value={contextValue}>
      <section className="manual-workspace free-canvas-workspace">
        <div className="flow-surface free-flow-surface">
          {agentCanvasHandoff.status !== "hidden" && (
            <section
              aria-label="创作 Agent 画布交接预览"
              aria-live="polite"
              data-testid="agent-canvas-handoff-preview"
              style={{
                position: "absolute",
                zIndex: 45,
                top: 14,
                left: "50%",
                width: "min(760px, calc(100% - 32px))",
                transform: "translateX(-50%)",
                border: "1px solid rgba(118, 94, 219, 0.42)",
                borderRadius: 14,
                background: "rgba(255,255,255,0.97)",
                boxShadow: "0 14px 40px rgba(35, 27, 74, 0.18)",
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong style={{ display: "block", marginBottom: 4 }}>
                  {agentCanvasHandoff.status === "error" ? "Agent 交接不可用" : "创作 Agent 分镜交接"}
                </strong>
                <span style={{ color: "#687089", fontSize: 13, lineHeight: 1.5 }}>
                  {agentCanvasHandoff.status === "error"
                    ? agentCanvasHandoff.error
                    : `${agentCanvasHandoff.plan.segments.length} 段 · ${agentCanvasHandoff.plan.settings.aspectRatio} · ${agentCanvasHandoff.plan.settings.animationStyle}；确认后只建立可编辑节点，不自动生成。`}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {agentCanvasHandoff.status === "ready" && (
                  <button
                    type="button"
                    data-testid="agent-canvas-handoff-confirm"
                    onClick={confirmAgentCanvasHandoff}
                    style={{ border: 0, borderRadius: 9, background: "#6f55d9", color: "white", padding: "9px 13px", cursor: "pointer" }}
                  >
                    <ClipboardCheck size={15} style={{ marginRight: 5, verticalAlign: -3 }} />确认导入
                  </button>
                )}
                {agentCanvasHandoff.status === "imported" && <span style={{ color: "#17835d", fontSize: 13 }}>已导入；本次交接已消费</span>}
                <button
                  type="button"
                  aria-label="关闭 Agent 交接提示"
                  onClick={() => setAgentCanvasHandoff({ status: "hidden" })}
                  style={{ border: "1px solid #d8dbea", borderRadius: 9, background: "white", padding: "8px 10px", cursor: "pointer" }}
                >
                  <X size={15} />
                </button>
              </div>
            </section>
          )}

          {nodes.length === 0 && (
            <div className="flow-empty">
              <Frame size={31} />
              <strong>空白自由画布</strong>
              <span>打开右侧制作面板，粘贴文案后自动搭建完整流程</span>
            </div>
          )}

          <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={(instance) => {
              flowRef.current = instance;
              if (pendingViewportRef.current) {
                viewportRef.current = pendingViewportRef.current;
                void instance.setViewport(pendingViewportRef.current, { duration: 0 });
                pendingViewportRef.current = null;
              }
            }}
            onMoveEnd={(_, viewport) => {
              viewportRef.current = viewport;
              setViewportSaveTick((value) => value + 1);
            }}
            onNodeClick={(_, node) => selectNode(node)}
            onPaneClick={() => setSelectedId(null)}
            minZoom={0.04}
            maxZoom={2.4}
            snapToGrid
            snapGrid={[16, 16]}
            defaultEdgeOptions={{ animated: true, markerEnd: { type: MarkerType.ArrowClosed } }}
            deleteKeyCode={["Backspace", "Delete"]}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1.2} color="rgba(184, 189, 214, 0.42)" />
            <Controls showInteractive={false} position="bottom-right" />
            <MiniMap pannable zoomable position="bottom-right" maskColor="rgba(245, 246, 250, 0.58)" nodeColor={(node) => {
              const kind = (node.data as WorkflowNodeData).kind;
              return kind === "image" ? "#8f72df" : kind === "video" ? "#7f6cf1" : kind === "text" ? "#818796" : "#65758b";
            }} />
          </ReactFlow>

          {workStatus && (
            <button
              type="button"
              className={`free-work-status ${workStatus.state}`}
              aria-label="当前工作状态"
              aria-live="polite"
              onClick={() => { setProPanelTab("setup"); setProPanelOpen(true); }}
            >
              <span className="free-work-status-icon">
                {workStatus.state === "paused"
                  ? <Pause size={16} />
                  : workStatus.state === "stopping"
                    ? <Square size={14} />
                    : workStatus.state === "downloading"
                      ? <DownloadCloud size={16} />
                      : <LoaderCircle className="spin" size={17} />}
              </span>
              <span className="free-work-status-copy">
                <strong>{workStatus.title}</strong>
                <small>{workStatus.detail}</small>
              </span>
              {typeof workStatus.elapsed === "number" && <span className="free-work-status-time">{workStatus.elapsed}s</span>}
            </button>
          )}

          {(previewNode?.data.imagePreviewUrl || previewNode?.data.outputUrl) && previewNode && (previewNode.data.kind === "image" || previewNode.data.kind === "video") && (
            <div className="free-result-viewer" role="dialog" aria-modal="true" aria-label={`${previewNode.data.title}预览`} onClick={() => setPreviewNodeId(null)}>
              <section onClick={(event) => event.stopPropagation()}>
                <header>
                  <div>
                    <span>{previewNode.data.kind === "video" ? "视频结果" : "关键帧结果"}</span>
                    <strong>{previewNode.data.title}</strong>
                  </div>
                  <div className="free-result-viewer-actions">
                    <button type="button" onClick={() => downloadAsset(previewNode.id)}><Download size={16} />下载</button>
                    <button type="button" title="关闭预览" aria-label="关闭预览" onClick={() => setPreviewNodeId(null)}><X size={18} /></button>
                  </div>
                </header>
                <div className={`free-result-viewer-media ${previewNode.data.kind}`}>
                  {previewNode.data.kind === "image" ? (
                    <Image src={previewNode.data.imagePreviewUrl || previewNode.data.outputUrl} alt={previewNode.data.title} fill unoptimized sizes="90vw" />
                  ) : (
                    <video
                      src={videoPlaybackSrc(previewNode.data.outputUrl)}
                      controls
                      playsInline
                      preload="metadata"
                    />
                  )}
                </div>
              </section>
            </div>
          )}

          <aside className="free-tool-rail" aria-label="自由画布工具">
            {(["image", "video", "text", "upload"] as WorkflowNodeKind[]).map((kind) => (
              <button type="button" key={kind} onClick={() => addNode(kind)} title={`添加${KIND_LABEL[kind]}节点`}><KindIcon kind={kind} size={22} /><span>{KIND_LABEL[kind]}</span></button>
            ))}
            <button type="button" onClick={() => addNode("upload", "audio")} title="添加音频节点"><AudioLines size={22} /><span>音频</span></button>
            <button type="button" onClick={() => addNode("upload", "music")} title="添加音乐节点"><Music2 size={22} /><span>音乐</span></button>
            <button type="button" className={canvasMenuOpen ? "active" : ""} onClick={() => setCanvasMenuOpen((open) => !open)} title="当前画布"><Grid2X2 size={22} /><span>画布</span></button>
          </aside>

          {canvasMenuOpen && (
            <section className="free-canvas-menu" aria-label="当前画布">
              <header>当前画布</header>
              <p role="status" aria-live="polite">{persistenceMessage}</p>
              <div className="free-canvas-menu-actions">
                <button type="button" className="free-canvas-new" onClick={createNewCanvas}><Plus size={18} />新建画布</button>
                <button type="button" className="free-canvas-clear" onClick={clearCurrentCanvas} disabled={runningAll || nodes.length === 0}><Trash2 size={17} />清空当前</button>
                {persistenceState === "failed" && (
                  <button type="button" onClick={() => {
                    lastCanvasSaveHashRef.current.delete(activeCanvasId);
                    setPersistenceState("saving");
                    setViewportSaveTick((value) => value + 1);
                  }}><RefreshCw size={17} />重试保存</button>
                )}
              </div>
              <div className="free-canvas-list">
                <span>全部会话</span>
                {canvasSessions.map((session) => (
                  <article key={session.id} className={session.id === activeCanvasId ? "active" : ""}>
                    <button type="button" onClick={() => { void switchCanvas(session.id); }}>
                      <strong>{session.name}</strong>
                      <small>{relativeTime(session.updatedAt)} · {session.nodes.length} 个节点</small>
                    </button>
                    <div>
                      <input
                        value={session.name}
                        onChange={(event) => renameCanvas(session.id, event.target.value)}
                        aria-label="画布名称"
                      />
                      <button type="button" onClick={() => { void copyCanvas(session.id); }} title="复制账号画布" disabled={session.revision <= 0}><Copy size={17} /></button>
                      <button type="button" onClick={() => { void deleteCanvas(session.id); }} title="删除画布"><Trash2 size={17} /></button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="free-canvas-history">
                <div>
                  <span>生成历史</span>
                  <p>最近 5 条运行记录</p>
                </div>
                {latestRunRecord ? (
                  <button type="button" className={`free-canvas-history-latest ${latestRunRecord.status}`} onClick={() => restoreRunRecord(latestRunRecord)}>
                    <strong>{latestRunRecord.canvasName}</strong>
                    <small>
                      {runRecordStatusLabel(latestRunRecord)} · {latestRunRecord.events.filter((event) => event.status === "succeeded").length}/{latestRunRecord.events.length} 生成任务 · {formatHistoryTimestamp(latestRunRecord.startedAt)}
                    </small>
                  </button>
                ) : (
                  <div className="free-canvas-history-empty">暂无历史</div>
                )}
                <button type="button" className="free-canvas-history-open" onClick={() => { setProPanelTab("history"); setProPanelOpen(true); setCanvasMenuOpen(false); }}>
                  查看全部历史
                </button>
              </div>
            </section>
          )}

          {proPanelOpen && (
            <aside className={`free-pro-panel tab-${proPanelTab}`} aria-label="制作面板">
              <header className="free-pro-panel-header">
                <div>
                  <span>自由画布</span>
                  <strong>制作面板</strong>
                </div>
                <button type="button" title="关闭制作面板" aria-label="关闭制作面板" onClick={toggleProPanel}><X size={18} /></button>
              </header>

              <div className="free-production-progress" aria-label="制作进度">
                <button type="button" className={nodes.length > 0 ? "done" : "active"} onClick={handleSplitAction}>
                  <span>1</span><strong>{productionModeId === "anime-story" ? "导演拆解" : "镜头拆分"}</strong><small>{nodes.length > 0 ? `${canvasStats.visualShots} 个镜头` : productionModeId === "anime-story" ? "加载画布" : "先生成草稿"}</small>
                </button>
                <button type="button" className={canvasStats.completedImages === canvasStats.images && canvasStats.images > 0 ? "done" : nodes.length > 0 ? "active" : ""} disabled={runningAll || canvasStats.images === 0} onClick={() => handleGenerationStage("images")}>
                  <span>2</span><strong>{hasCharacterSetup ? "角色设定 + 批量生图" : "批量生图"}</strong><small>{canvasStats.completedImages}/{canvasStats.images} 张，5秒错峰提交</small>
                </button>
                <button type="button" className={canvasStats.completedVideos === canvasStats.videos && canvasStats.videos > 0 ? "done" : canvasStats.storyboardReferences > 0 && canvasStats.verifiedReferences === canvasStats.storyboardReferences ? "active" : ""} disabled={runningAll || canvasStats.videos === 0 || (canvasStats.storyboardReferences > 0 && canvasStats.verifiedReferences !== canvasStats.storyboardReferences)} onClick={() => handleGenerationStage("videos")}>
                  <span>3</span><strong>批量视频</strong><small>{canvasStats.completedVideos}/{canvasStats.videos} 条 · 参考图确认 {canvasStats.verifiedReferences}/{canvasStats.storyboardReferences} · {VIDEO_BATCH_SUBMIT_INTERVAL_MS / 1000}秒错峰</small>
                </button>
              </div>

              <div className="free-production-commands" aria-label="生成与下载操作">
                {!runningAll && (
                  <>
                    <button type="button" onClick={() => runFirstPendingAsset("image")} disabled={canvasStats.pendingImages === 0}><ImageIcon size={15} />试生成 1 张</button>
                    <button type="button" onClick={() => runFirstPendingAsset("video")} disabled={canvasStats.pendingVideos === 0 || canvasStats.completedImages === 0 || (canvasStats.storyboardReferences > 0 && canvasStats.verifiedReferences !== canvasStats.storyboardReferences)}><Video size={15} />试生成 1 条</button>
                  </>
                )}
                {runningAll && batchControl === "paused" && <button type="button" className="resume" onClick={resumeBatchGeneration}><Play size={15} />继续队列</button>}
                {runningAll && batchControl === "running" && <button type="button" onClick={pauseBatchGeneration}><Pause size={15} />暂停队列</button>}
                {runningAll && <button type="button" className="stop" onClick={stopBatchGeneration} disabled={batchControl === "stopping"}><Square size={14} />{batchControl === "stopping" ? "正在终止" : "终止队列"}</button>}
                <button type="button" onClick={() => void downloadAssets("image")} disabled={downloadBusy || canvasStats.completedImages === 0}><Download size={15} />下载参考图</button>
                <button type="button" onClick={() => void downloadAssets("video")} disabled={downloadBusy || canvasStats.completedVideos === 0}><Download size={15} />下载视频 + 文案TXT</button>
              </div>
              <p className="free-production-command-help">
                {runningAll
                  ? batchControl === "paused"
                    ? "队列已暂停；已提交的视频仍在生成，继续后只恢复查询和后续节点。"
                    : batchControl === "stopping"
                      ? "正在收口当前请求，不再提交新节点；已有结果会保留。"
                      : "批量执行中；暂停不会丢失结果，终止后可从未完成节点重新开始。"
                  : `先检查${hasCharacterSetup ? "角色设定图和" : ""}首张关键帧，再批量生图；图片每 ${IMAGE_BATCH_SUBMIT_INTERVAL_MS / 1000} 秒提交 1 张；视频每 ${VIDEO_BATCH_SUBMIT_INTERVAL_MS / 1000} 秒提交 1 条，已提交结果并发等待。`}
              </p>

              <nav className="free-pro-tabs" aria-label="制作面板栏目">
                <button type="button" className={proPanelTab === "setup" ? "active" : ""} onClick={() => setProPanelTab("setup")}><Settings2 size={15} />制作设置</button>
                <button type="button" className={proPanelTab === "history" ? "active" : ""} onClick={() => setProPanelTab("history")}><History size={15} />生成记录</button>
                <button type="button" className={proPanelTab === "quality" ? "active" : ""} onClick={() => setProPanelTab("quality")}><ClipboardCheck size={15} />检查与工具</button>
              </nav>

              <div className="free-pro-tools">
                <div className="free-pro-title"><Settings2 size={15} />画布工具</div>
                <div>
                  <button type="button" onClick={fitCanvas}><Maximize2 size={16} />适配画布</button>
                  <button type="button" onClick={tidyCanvas}><LayoutGrid size={16} />整理镜头</button>
                  <button type="button" onClick={focusSelectedNode} disabled={!selectedId}><Focus size={16} />定位节点</button>
                  <button type="button" onClick={duplicateSelectedNode} disabled={!selectedId}><Copy size={16} />复制节点</button>
                  <button type="button" onClick={applyHdDefaults}><MousePointer2 size={16} />高清默认值</button>
                  <button type="button" onClick={() => jsonInputRef.current?.click()}><FileJson size={16} />导入流程</button>
                  <button type="button" onClick={exportGraph}><Download size={16} />导出流程</button>
                  <button type="button" onClick={exportDiagnostics}><FileJson size={16} />导出诊断</button>
                  <button type="button" className="danger" onClick={clearCurrentCanvas} disabled={runningAll || nodes.length === 0}><Trash2 size={16} />清空画布</button>
                </div>
              </div>

              <section className="free-pro-section free-global-models">
                <div className="free-pro-title"><Layers3 size={15} />模型与输出规格</div>
                <p>选择模型，确认分辨率与费用后生成。</p>
                <div className="free-global-model-grid">
                  <label>
                    <span>生图模型</span>
                    <select value={canvasImageModelId} onChange={(event) => {
                      const nextModel = imageModels.find((model) => model.id === event.target.value);
                      setCanvasImageModelId(event.target.value);
                      setCanvasImageResolution(coerceImageResolution(nextModel, canvasImageResolution));
                    }}>
                      {!selectedCanvasImageModel && <option value={canvasImageModelId} disabled>已选图片模型暂不可读取，请手动选择</option>}
                      {imageModels.map((model) => (
                        <option key={model.id} value={model.id} disabled={Boolean(canvasModelAdmissionIssue(model, "image"))}>
                          {model.name} · ¥{Number(model.selling_price ?? 0).toFixed(2)}/张 · {getImageModelCapabilities(model).referenceCapabilityLabel}{canvasModelAdmissionIssue(model, "image") ? ` · ${canvasModelAdmissionIssue(model, "image")}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>生图分辨率</span>
                    <select
                      aria-label="全局图片分辨率"
                      value={canvasImageResolution}
                      disabled={canvasImageResolutionOptions.length <= 1}
                      onChange={(event) => setCanvasImageResolution(event.target.value as ImageResolution)}
                    >
                      {canvasImageResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
                    </select>
                    <small className="free-resolution-hint">
                      {canvasImageResolutionOptions.length > 1
                        ? `当前模型支持 ${canvasImageResolutionOptions.join(" / ")}`
                        : `当前模型固定 ${canvasImageResolutionOptions[0] || canvasImageResolution}`}
                    </small>
                  </label>
                  <label>
                    <span>视频模型</span>
                    <select
                      aria-label="全局视频生成模型"
                      value={canvasVideoModelId}
                      onChange={(event) => {
                        const nextModel = selectableCanvasVideoModels.find((model) => model.id === event.target.value);
                        setCanvasVideoModelId(event.target.value);
                        setCanvasVideoResolution(coerceCanvasVideoResolution(nextModel, canvasVideoResolution));
                      }}
                    >
                      {!selectedCanvasVideoModel && <option value={canvasVideoModelId} disabled>已选视频模型暂不可读取，请手动选择</option>}
                      {selectableCanvasVideoModels.map((model) => {
                        const modelTiming = getVideoDurationCapabilities(model);
                        const previewDuration = coerceVideoTargetDuration(model, storyTargetDurationSeconds);
                        const modelCharge = resolveVideoCharge(model, canvasVideoResolution, previewDuration);
                        const admissionIssue = canvasModelAdmissionIssue(model, "video") || (!model.supportsImageInput ? "当前流程需要图生视频模型" : "");
                        return (
                          <option key={model.id} value={model.id} disabled={Boolean(admissionIssue)}>
                            {model.name} · ¥{modelCharge.publicPrice.toFixed(2)}{modelCharge.billingUnit === "output_second" ? `/${modelCharge.billingQuantity}秒` : "/次"} · {modelTiming.mode === "fixed" ? `${modelTiming.defaultDuration}秒固定` : `可变时长（最长${modelTiming.maxDuration}秒）`}{admissionIssue ? ` · ${admissionIssue}` : ""}
                          </option>
                        );
                      })}
                    </select>
                    <small className="free-resolution-hint">只显示支持参考图驱动的模型，避免纯文生视频误入当前链路</small>
                  </label>
                  <label>
                    <span>视频分辨率</span>
                    <select
                      aria-label="全局视频分辨率"
                      value={selectedCanvasVideoResolution}
                      disabled={canvasVideoResolutionOptions.length <= 1}
                      onChange={(event) => setCanvasVideoResolution(event.target.value)}
                    >
                      {canvasVideoResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
                    </select>
                    <small className="free-resolution-hint">
                      {canvasVideoResolutionOptions.length > 1
                        ? `当前模型支持 ${canvasVideoResolutionOptions.join(" / ")}`
                        : `当前模型固定 ${canvasVideoResolutionOptions[0] || selectedCanvasVideoResolution}`}
                    </small>
                  </label>
                </div>
                {imageModels.length <= 1 && (
                  <small>当前可用图片模型较少，更多模型开放后会自动显示。</small>
                )}
                <button type="button" className="free-apply-models" disabled={!canvasImageModelId && !canvasVideoModelId} onClick={applyCanvasModels}>
                  <Check size={15} />应用到全部生成节点
                </button>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><WandSparkles size={15} />选择提示词制作类型</div>
                <p className="free-template-help">先选要生成哪类提示词。选中后，再填写接收模板信息，系统只在自由画布内部完成提示词编译和落卡。</p>
                <div className="free-template-grid">
                  {PRODUCTION_MODES.map((mode) => (
                    <button
                      type="button"
                      key={mode.id}
                      className={productionModeId === mode.id ? "active" : ""}
                      onClick={() => selectProductionMode(mode.id)}
                    >
                      <strong>{mode.title}</strong>
                      <span>{mode.summary}</span>
                    </button>
                  ))}
                </div>
                <div className="free-import-safety">
                  <CheckCircle2 size={15} />
                  <span>当前流程：{selectedProductionMode.agentName}{productionModeId === "anime-story" ? `｜${selectedStoryDirector.title}｜${storyTargetDurationSeconds}秒故事版` : ""}。{selectedProductionMode.workflowSummary}</span>
                </div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><Grid2X2 size={15} />辅助画布工具</div>
                <p className="free-template-help">这些是可插入工具，不代表主流程；需要探索画面或单独做图生视频时再用。</p>
                <div className="free-template-grid">
                  <button type="button" onClick={() => applyCanvasTemplate("image")}><strong>视觉方向探索</strong><span>全文 / 设定 → 4张候选 → 选1张</span></button>
                  <button type="button" onClick={() => applyCanvasTemplate("video")}><strong>已有图片转视频</strong><span>手动工具：已有单图 + 运镜 → 视频</span></button>
                </div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><FileText size={15} />接收模板与文案提交</div>
                <p className="free-template-help">
                  当前类型：{selectedProductionMode.title}。{productionModeId === "anime-story" ? "提交后会生成每段对应的参考图提示词和视频提示词，并自动加载到画布卡片。" : "提交后先拆出可编辑草稿，核对无误后再批量生成。"}
                </p>
                {productionModeId === "product-video" ? (
                  <div className="free-import-safety">
                    <CheckCircle2 size={15} />
                    <span>产品制作不走长文案分镜：上传真实产品参考图，填写广告卖点脚本，然后直接生成图生视频。</span>
                  </div>
                ) : (
                  <>
                    <button type="button" className="free-script-toggle" onClick={() => setScriptImporterOpen((open) => !open)}>
                      {scriptImporterOpen ? "收起文案输入" : "打开文案输入"}
                    </button>
                    {scriptImporterOpen && (
                      <div className="free-script-importer">
                        <div className="free-import-safety">
                          <CheckCircle2 size={15} />
                          <span>接收模板：先确认时长、比例、风格、参考图版本和模型，再粘贴分段文案提交；结果会按段自动落到参考图提示词、视频提示词、图片和视频卡片。</span>
                        </div>
                        {productionModeId === "anime-story" && (
                          <>
                            <label>
                              <span>提示词版本</span>
                              <select
                                value={storyDirectorMode}
                                onChange={(event) => setStoryDirectorMode(event.target.value as StoryboardDirectorMode)}
                              >
                                {STORY_DIRECTOR_OPTIONS.map((mode) => (
                                  <option key={mode.id} value={mode.id}>
                                    {mode.title} - {mode.summary}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>分段时长</span>
                              <select
                                value={storyTargetDurationSeconds}
                                onChange={(event) => {
                                  const seconds = Number(event.target.value);
                                  setStoryTargetDurationSeconds(seconds === 8 || seconds === 15 ? seconds : 10);
                                }}
                              >
                                {STORY_TARGET_DURATION_OPTIONS.map((seconds) => (
                                  <option key={seconds} value={seconds}>
                                    {seconds}秒 · {storyTargetShotLabel(seconds)}
                                  </option>
                                ))}
                              </select>
                              <small>参考图为4格或4格+底部全宽锚点；格子用于规划画面，不等于视频必须切同样次数。</small>
                            </label>
                            <label>
                              <span>视频比例</span>
                              <select value={scriptRatioDraft} onChange={(event) => setScriptRatioDraft(event.target.value as AspectRatio)}>
                                {RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}
                              </select>
                            </label>
                            <label>
                              <span>动画风格</span>
                              <select
                                value={animationStyleId}
                                onChange={(event) => setAnimationStyleId(event.target.value as AnimationStyleId)}
                              >
                                {ANIMATION_STYLE_OPTIONS.map((style) => (
                                  <option key={style.id} value={style.id}>
                                    {style.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>参考图版本</span>
                              <select
                                value={storyboardReferenceTextMode}
                                onChange={(event) => setStoryboardReferenceTextMode(event.target.value as StoryboardReferenceTextMode)}
                              >
                                {STORYBOARD_REFERENCE_TEXT_OPTIONS.map((mode) => (
                                  <option key={mode.id} value={mode.id}>
                                    {mode.title}
                                  </option>
                                ))}
                              </select>
                              <small>{STORYBOARD_REFERENCE_TEXT_OPTIONS.find((mode) => mode.id === storyboardReferenceTextMode)?.summary}</small>
                            </label>
                          </>
                        )}
                        {productionModeId !== "anime-story" && (
                          <label>
                            <span>画面比例</span>
                            <select value={scriptRatioDraft} onChange={(event) => setScriptRatioDraft(event.target.value as AspectRatio)}>
                              {RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}
                            </select>
                          </label>
                        )}
                        <label>
                          <span>{productionModeId === "anime-story" ? "分段文案" : "原始文案"}</span>
                          <textarea
                            value={scriptDraft}
                            onChange={(event) => setScriptDraft(event.target.value)}
                            placeholder={productionModeId === "anime-story"
                              ? "粘贴已经分好的文案，例如：\n1.【第一段口播文案】\n2.【第二段口播文案】\n系统会保持分段边界，每段生成一张参考图提示词卡和一条视频提示词卡。"
                              : "把完整文案粘贴到这里。点击镜头拆分后，系统会自动搭建口播段、视频提示词、生图提示词 / 自动关键帧和视频节点。"}
                          />
                        </label>
                        <button type="button" className="free-advanced-toggle" onClick={() => setAdvancedDraftOpen((open) => !open)}>
                          {advancedDraftOpen ? "收起高级设置" : "高级设置（可选）"}
                        </button>
                        {advancedDraftOpen && (
                          <div className="free-advanced-fields">
                            <label>
                              <span>一致性增强（可选）</span>
                              <select
                                aria-label="一致性增强"
                                value={consistencySourceDraft}
                                onChange={(event) => updateConsistencySourceDraft(event.target.value as ConsistencySource)}
                              >
                                <option value="explore">自动角色定妆图（推荐）</option>
                                <option value="auto">仅文字资产锁定（不生成角色图）</option>
                                <option value="upload">使用已有角色设定 / 宠物图（手动）</option>
                              </select>
                              <small className="free-consistency-hint">
                                {consistencySourceDraft === "explore"
                                  ? `系统先为每个主要角色生成1张纯净身份定妆图，再按角色出场关系自动绑定到对应分镜；若当前生图模型不支持参考图，系统会自动匹配可用模型，仍不可用时降级为文字资产锁定。`
                                  : consistencySourceDraft === "upload"
                                    ? `仅适合你已经拥有固定角色图的情况；系统会优先使用支持图像输入的图片模型保持身份，仍不可用时降级为文字资产锁定。`
                                    : `GPT-5.6 从全文提取具体角色资产，并把实际出场角色的品种或地域外观、年龄、体型、毛色五官、服装配饰和识别点完整写入每镜提示词；不向图片模型传角色定妆图，避免参考图压制剧情构图和语义装饰。`}
                              </small>
                            </label>
                            {productionModeId !== "anime-story" && (
                              <label>
                                <span>{productionModeId === "real-story" ? "视觉风格补充" : "视觉方向 / 节奏要求"}</span>
                                <input value={scriptStyleDraft} onChange={(event) => setScriptStyleDraft(event.target.value)} />
                              </label>
                            )}
                            <label>
                              <span>自动关键帧位置</span>
                              <select
                                value={keyframeStrategyDraft}
                                onChange={(event) => setKeyframeStrategyDraft(event.target.value as KeyframeStrategy)}
                              >
                                <option value="visual-anchor">最佳关键帧（推荐）</option>
                                <option value="action-start">动作首帧</option>
                              </select>
                              <small>{productionModeId === "anime-story"
                                ? "故事版流程：一段口播对应一张4/5格参考图和一个8/10/15秒视频；视频内部按剧情使用真实镜头，不按格硬切。"
                                : "每个分镜固定对应一段口播文案、一张自动关键帧和一个视频，时长为3到5秒。"}</small>
                            </label>
                            <label>
                              <span>画面修饰强度</span>
                              <select value={effectsLevelDraft} onChange={(event) => setEffectsLevelDraft(event.target.value as VisualEffectsLevel)}>
                                <option value="none">无包装，只靠表演与光影</option>
                                <option value="light">轻量包装</option>
                                <option value="rich">{productionModeId === "anime-story" ? "剧情强化（推荐）" : "丰富包装与比喻画面"}</option>
                              </select>
                            </label>
                          </div>
                        )}

                        <button type="button" className="free-assistant-toggle" onClick={() => setAssistantDraftOpen((open) => !open)}>
                          <WandSparkles size={15} />{assistantDraftOpen ? "收起补充要求" : "补充要求"}
                        </button>
                        {assistantDraftOpen && (
                          <label className="free-assistant-field">
                            <span>用大白话补充要求</span>
                            <textarea
                              value={assistantInstruction}
                              onChange={(event) => setAssistantInstruction(event.target.value)}
                              placeholder="例如：整体更温暖，第6个镜头重点表现主角犹豫，动作更可爱一点。"
                            />
                            <small>补充要求只影响本次拆镜，不会修改原模板。</small>
                          </label>
                        )}

                        <div className="free-import-safety">
                          <CheckCircle2 size={15} />
                          <span>{productionModeId === "anime-story"
                            ? `故事版导演会先读懂全文并转成微故事；当前采用${selectedStoryDirector.title}，每段生成${storyTargetDurationSeconds}秒视频单元，参考图先画出语义包装，再让视频模型延续。当前不创建配音或字幕任务。`
                            : "默认自动流程无需上传：系统会从全文提取角色与场景，先生成视频提示词，再反推可见的生图提示词，随后搭建自动关键帧和视频节点。当前不创建配音或字幕任务。"}</span>
                        </div>
                        <button type="button" disabled={scriptCompiling || promptPresets.length === 0} onClick={() => void createCanvasFromScript(scriptDraft, effectiveScriptStyleGuide, scriptRatioDraft)}>
                          {scriptCompiling ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
                          {scriptCompiling ? `${scriptCompileStageLabel} ${scriptCompileElapsedSeconds}s` : productionModeId === "anime-story" ? "导演拆解并加载画布" : "镜头拆分"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><History size={15} />生成历史</div>
                <p className="free-run-history-help">自动保存整次拆镜、出图和视频生成画布，可恢复全部卡片、连线及已有成品；最多保留最近 {CANVAS_HISTORY_MAX_RECORDS} 条，并保留 {CANVAS_HISTORY_RETENTION_DAYS} 天。</p>
                <div className="free-run-history-list">
                  {recentRunHistory.length === 0 && <div className="free-run-history-empty">还没有运行记录</div>}
                  {recentRunHistory.map((record) => {
                    const succeeded = record.events.filter((event) => event.status === "succeeded").length;
                    const failed = record.events.filter((event) => event.status === "failed" || event.status === "skipped").length;
                    const images = record.events.filter((event) => event.kind === "image" && event.outputUrl).length;
                    const videos = record.events.filter((event) => event.kind === "video" && event.outputUrl).length;
                    return (
                      <article key={record.id} className={`free-run-history-item ${record.status}`}>
                        <button type="button" className="free-run-history-main" onClick={() => restoreRunRecord(record)}>
                          <span><strong>{record.canvasName}</strong><em>{runRecordStatusLabel(record)}</em></span>
                          <small>{formatHistoryTimestamp(record.startedAt)} · {record.promptPreset}</small>
                          <small>{images} 张图片 · {videos} 条视频 · {succeeded}/{record.events.length} 生成任务{failed > 0 ? ` · ${failed} 个异常` : ""}</small>
                        </button>
                        <button type="button" className="free-run-history-delete" onClick={() => deleteRunRecord(record.id)} title="删除这条记录" aria-label="删除这条运行记录"><Trash2 size={14} /></button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><FileJson size={15} />运行日志</div>
                <p className="free-run-history-help">记录卡片、模型、触发入口、请求阶段、耗时和完整错误；失败项会同时写入浏览器控制台。</p>
                <div className="free-run-history-list">
                  {recentGenerationDiagnostics.length === 0 && <div className="free-run-history-empty">还没有生成日志</div>}
                  {recentGenerationDiagnostics.map((entry) => (
                    <article key={entry.id} className={`free-run-history-item ${entry.status === "failed" ? "failed" : "completed"}`}>
                      <div className="free-run-history-main">
                        <span><strong>{entry.title}</strong><em>{entry.status === "failed" ? "失败" : "成功"}</em></span>
                        <small>{formatHistoryTimestamp(entry.startedAt)} · {entry.trigger === "manual" ? "手动单张" : entry.trigger === "batch" ? "批量队列" : "系统"} · {entry.phase} · {(entry.durationMs / 1000).toFixed(1)}s</small>
                        <small>模型：{entry.modelId || "-"}{entry.detail ? ` · ${entry.detail}` : ""}</small>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="free-pro-tools"><div><button type="button" onClick={exportDiagnostics}><Download size={15} />导出完整日志</button></div></div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><ClipboardCheck size={15} />生产检查</div>
                <div className="free-check-list">
                  {checklist.map((item) => (
                    <span key={item.label} className={item.done ? "done" : ""}>
                      {item.done ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                      {item.label}
                    </span>
                  ))}
                </div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><Frame size={15} />画布概览</div>
                <div className="free-stat-grid">
                  <span><strong>{nodes.length}</strong>节点</span>
                  <span><strong>{edges.length}</strong>连线</span>
                  <span><strong>{canvasStats.images}</strong>图片</span>
                  <span><strong>{canvasStats.videos}</strong>视频</span>
                  <span><strong>{canvasStats.semanticSegments}</strong>口播文案</span>
                  <span><strong>{canvasStats.visualShots}</strong>分镜视频</span>
                  <span><strong>{formatDurationLabel(canvasStats.storyboardSeconds)}</strong>总时长</span>
                </div>
              </section>

              <section className="free-pro-section">
                <div className="free-pro-title"><Focus size={15} />选中节点</div>
                {selectedNode ? (
                  <div className="free-selected-summary">
                    <strong>{selectedNode.data.title}</strong>
                    <span>{visibleKindLabel(selectedNode.data)} · {selectedNode.data.status} · {selectedNode.data.resolution || "default"}</span>
                    <button type="button" onClick={duplicateSelectedNode}>复制这个节点</button>
                  </div>
                ) : (
                  <div className="free-selected-summary muted">未选中节点</div>
                )}
              </section>
            </aside>
          )}

          <div className="free-canvas-actions">
            <button type="button" className="run-all" title="按顺序执行下一阶段：角色确认 → 参考图生成与确认 → 视频" onClick={() => handleGenerationStage("all")} disabled={runningAll || scriptCompiling || nodes.length === 0}>
              {runningAll ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
              <span>按顺序执行</span>
            </button>
            {runningAll && batchControl === "paused" && <button type="button" className="batch-control resume" title="从当前未完成节点继续" onClick={resumeBatchGeneration}><Play size={16} /><span>继续</span></button>}
            {runningAll && batchControl === "running" && <button type="button" className="batch-control pause" title="暂停查询和后续提交，保留当前结果" onClick={pauseBatchGeneration}><Pause size={16} /><span>暂停</span></button>}
            {runningAll && <button type="button" className="batch-control stop" title="终止后续队列，保留已完成结果和任务 ID" onClick={stopBatchGeneration} disabled={batchControl === "stopping"}><Square size={14} /><span>{batchControl === "stopping" ? "终止中" : "终止"}</span></button>}
            <button type="button" className="download-all image-download" title="按分镜序号下载全部已完成参考图" onClick={() => void downloadAssets("image")} disabled={downloadBusy || canvasStats.completedImages === 0}>
              {downloadBusy ? <LoaderCircle className="spin" size={16} /> : <Images size={16} />}
              <span>下载参考图 {canvasStats.completedImages}</span>
            </button>
            <button type="button" className="download-all video-download" title="按分镜序号下载全部已完成视频，并附带口播文案对照 TXT" onClick={() => void downloadAssets("video")} disabled={downloadBusy || canvasStats.completedVideos === 0}>
              {downloadBusy ? <LoaderCircle className="spin" size={16} /> : <DownloadCloud size={16} />}
              <span>下载视频 + TXT {canvasStats.completedVideos}</span>
            </button>
            <button
              type="button"
              className="clear-canvas-action"
              title="一键清空当前画布"
              aria-label="一键清空当前画布"
              onClick={clearCurrentCanvas}
              disabled={runningAll || scriptCompiling || nodes.length === 0}
            >
              <Trash2 size={17} />
            </button>
            <button type="button" title="打开制作设置、生成记录和检查工具" aria-label="打开制作面板" aria-pressed={proPanelOpen} className={`panel-toggle ${proPanelOpen ? "active" : ""}`} onClick={toggleProPanel}><PanelRight size={17} /></button>
            <input ref={jsonInputRef} hidden type="file" accept="application/json" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importGraph(file);
              event.target.value = "";
            }} />
          </div>

          <div className="flow-count">{activeCanvas?.name || "新会话"} · {nodes.length} 节点 · {edges.length} 连线</div>
        </div>
      </section>
    </FreeNodeContext.Provider>
  );
}
