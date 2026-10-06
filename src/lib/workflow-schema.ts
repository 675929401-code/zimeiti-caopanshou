import { z } from "zod";
import { AspectRatioSchema, type StoryboardCard } from "@/lib/studio-schema";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export const WorkflowNodeKindSchema = z.enum(["text", "image", "video", "upload"]);
export const WorkflowNodeStatusSchema = z.enum(["idle", "queued", "running", "succeeded", "failed"]);
export const WorkflowHistoryItemSchema = z.object({
  id: z.string().min(1),
  batchIndex: z.number().int().nonnegative().optional(),
  outputUrl: z.string().optional(),
  outputText: z.string().optional(),
  taskId: z.string().max(160).optional(),
  modelId: z.string().max(160).optional(),
  publicModelName: z.string().max(240).optional(),
  actualCost: z.number().nonnegative().optional(),
  creditsCharged: z.number().nonnegative().optional(),
  retailPriceRmb: z.number().nonnegative().optional(),
  billingUnit: z.string().max(80).optional(),
  billingReferenceId: z.string().max(160).optional(),
  assetId: z.string().max(512).optional(),
  storageKey: z.string().max(2_048).optional(),
  historyRecordId: z.string().max(160).optional(),
  createdAt: z.string().datetime(),
});

export const WorkflowNodeDataSchema = z.object({
  kind: WorkflowNodeKindSchema,
  title: z.string().min(1),
  prompt: z.string().default(""),
  outputText: z.string().default(""),
  outputUrl: z.string().default(""),
  sourceMediaKind: z.enum(["image", "audio", "music"]).optional(),
  audioMode: z.enum(["upload", "tts", "seed-audio"]).optional(),
  voiceId: z.string().max(160).optional(),
  taskId: z.string().default(""),
  clientRequestId: z.string().max(128).optional(),
  clientRequestFingerprint: z.string().max(16_384).optional(),
  imageClientTraceId: z.string().max(128).optional(),
  imageClientIdempotencyKey: z.string().max(128).optional(),
  imageRequestFingerprint: z.string().max(16_384).optional(),
  pendingPersistUrl: z.string().optional(),
  pendingPersistIndex: z.number().int().nonnegative().optional(),
  pendingPersistWidth: z.number().int().positive().optional(),
  pendingPersistHeight: z.number().int().positive().optional(),
  pendingPersistCharge: z.number().nonnegative().optional(),
  pendingPersistCashRemaining: z.number().nonnegative().nullable().optional(),
  providerContentUrl: z.string().default(""),
  modelId: z.string().default(""),
  publicModelName: z.string().max(240).optional(),
  estimatedCost: z.number().nonnegative().optional(),
  assetId: z.string().max(512).optional(),
  storageKey: z.string().max(2_048).optional(),
  historyRecordId: z.string().max(160).optional(),
  billingReferenceId: z.string().max(160).optional(),
  actualCost: z.number().nonnegative().optional(),
  creditsCharged: z.number().nonnegative().optional(),
  retailPriceRmb: z.number().nonnegative().optional(),
  billingUnit: z.string().max(80).optional(),
  cashRemaining: z.number().nonnegative().nullable().optional(),
  completedAt: z.string().datetime().optional(),
  aspectRatio: AspectRatioSchema.default("9:16"),
  durationSeconds: z.number().positive().default(10),
  resolution: z.string().default("720p"),
  imageMode: z.enum(["text-to-image", "image-to-image", "grid", "edit"]).default("text-to-image"),
  imageCount: z.number().int().min(1).max(4).default(1),
  candidateSelectionRequired: z.boolean().optional(),
  selectedCandidateId: z.string().optional(),
  assetRole: z.enum(["character-reference", "storyboard-keyframe", "storyboard-end-frame"]).optional(),
  workflowRole: z.enum([
    "source-brief",
    "director-config",
    "narration",
    "director-card",
    "image-prompt",
    "storyboard-reference",
    "video-prompt",
    "video-output",
    "post-production",
    "character-reference",
  ]).optional(),
  storyboardSegmentId: z.string().max(80).optional(),
  storyboardDirectorMode: z.enum(["high_energy", "cinematic", "lyrical"]).optional(),
  storyboardPanelCount: z.union([z.literal(4), z.literal(5)]).optional(),
  storyboardLayout: z.enum(["two_by_two", "four_plus_panorama"]).optional(),
  actualShotCount: z.number().int().min(3).max(5).optional(),
  referenceValidationStatus: z.enum(["pending", "verified", "rejected"]).optional(),
  characterId: z.string().max(60).optional(),
  characterName: z.string().max(80).optional(),
  castIds: z.array(z.string().max(60)).max(4).optional(),
  modelLocked: z.boolean().optional(),
  lockedModelId: z.string().max(120).optional(),
  videoMode: z.enum(["first-frame", "multimodal"]).default("first-frame"),
  semanticOrder: z.number().int().positive().optional(),
  visualOrder: z.number().int().positive().optional(),
  timelineDurationSeconds: z.number().positive().optional(),
  requiresExactDuration: z.boolean().optional(),
  allowDurationTrim: z.boolean().optional(),
  ambientSoundOnly: z.boolean().optional(),
  playbackStatus: z.enum(["unchecked", "validating", "ready", "failed"]).optional(),
  playbackError: z.string().max(300).optional(),
  generationBlockedReason: z.string().max(300).optional(),
  shotRole: z.string().max(40).optional(),
  transition: z.enum(["cut", "dissolve", "match-cut", "graphic", "hold"]).optional(),
  optionalInput: z.boolean().optional(),
  status: WorkflowNodeStatusSchema.default("idle"),
  progressMessage: z.string().max(120).optional(),
  error: z.string().optional(),
  history: z.array(WorkflowHistoryItemSchema).default([]),
});

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("workflow").default("workflow"),
  position: z.object({ x: z.number(), y: z.number() }),
  data: WorkflowNodeDataSchema,
});

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
});

export const WorkflowGraphSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  updatedAt: z.string().datetime(),
});

export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKindSchema>;
export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;
export type WorkflowNodeData = z.infer<typeof WorkflowNodeDataSchema>;
export type WorkflowNodeRecord = z.infer<typeof WorkflowNodeSchema>;
export type WorkflowEdgeRecord = z.infer<typeof WorkflowEdgeSchema>;
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

function nodeId(cardId: string, kind: "text" | "image" | "video") {
  return `${cardId}:${kind}`;
}

export function createWorkflowFromStoryboards(
  storyboards: StoryboardCard[],
  defaults: { imageModelId?: string; videoModelId?: string } = {},
): WorkflowGraph {
  const nodes: WorkflowNodeRecord[] = [];
  const edges: WorkflowEdgeRecord[] = [];
  const rowHeight = 410;

  for (const [index, card] of storyboards.entries()) {
    const y = index * rowHeight;
    const textId = nodeId(card.id, "text");
    const imageId = nodeId(card.id, "image");
    const videoId = nodeId(card.id, "video");
    nodes.push(
      {
        id: textId,
        type: "workflow",
        position: { x: 0, y },
        data: {
          kind: "text",
          title: `${card.title} · 文案`,
          prompt: card.narration || card.imagePrompt,
          outputText: card.narration || "",
          outputUrl: "",
          taskId: "",
          providerContentUrl: "",
          modelId: "",
          aspectRatio: card.aspectRatio || "9:16",
          durationSeconds: Math.max(1, card.endSeconds - card.startSeconds),
          resolution: "720p",
          imageMode: "text-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "idle",
          history: [],
        },
      },
      {
        id: imageId,
        type: "workflow",
        position: { x: 540, y },
        data: {
          kind: "image",
          title: `${card.title} · ${card.referenceStrategy === "first-last" ? "首帧" : "图片"}`,
          prompt: card.referenceStrategy === "first-last"
            ? card.keyframePrompt || card.imagePrompt
            : card.imageRoute === "keyframe-img2img"
            ? [card.keyframePrompt, card.refinementPrompt].filter(Boolean).join("\n")
            : card.imagePrompt,
          outputText: "",
          outputUrl: "",
          taskId: "",
          providerContentUrl: "",
          modelId: card.modelId || defaults.imageModelId || "",
          aspectRatio: card.aspectRatio || "9:16",
          durationSeconds: 10,
          resolution: "1K",
          imageMode: card.imageRoute === "keyframe-img2img" ? "image-to-image" : "text-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "idle",
          history: [],
        },
      },
      {
        id: videoId,
        type: "workflow",
        position: { x: card.referenceStrategy === "first-last" ? 1620 : 1080, y },
        data: {
          kind: "video",
          title: `${card.title} · 视频`,
          prompt: card.videoPrompt,
          outputText: "",
          outputUrl: "",
          taskId: "",
          providerContentUrl: "",
          modelId: card.videoModelId || defaults.videoModelId || "",
          aspectRatio: card.aspectRatio || "9:16",
          durationSeconds: card.durationSeconds || Math.max(1, card.endSeconds - card.startSeconds),
          resolution: card.resolution || "720p",
          imageMode: "text-to-image",
          imageCount: 1,
          videoMode: card.referenceStrategy === "first-last" ? "multimodal" : "first-frame",
          status: "idle",
          history: [],
        },
      },
    );
    if (card.referenceStrategy === "first-last") {
      nodes.push({
        id: `${card.id}:end-frame`,
        type: "workflow",
        position: { x: 1080, y },
        data: {
          kind: "image",
          title: `${card.title} · 尾帧`,
          prompt: card.endFramePrompt,
          outputText: "",
          outputUrl: "",
          taskId: "",
          providerContentUrl: "",
          modelId: card.modelId || defaults.imageModelId || "",
          aspectRatio: card.aspectRatio || "9:16",
          durationSeconds: 10,
          resolution: "1K",
          imageMode: "image-to-image",
          imageCount: 1,
          videoMode: "first-frame",
          status: "idle",
          history: [],
        },
      });
    }
    edges.push(
      { id: `${textId}->${imageId}`, source: textId, target: imageId },
      { id: `${imageId}->${videoId}`, source: imageId, target: videoId },
    );
    if (card.referenceStrategy === "first-last") {
      const endFrameId = `${card.id}:end-frame`;
      edges.push(
        { id: `${imageId}->${endFrameId}`, source: imageId, target: endFrameId },
        { id: `${endFrameId}->${videoId}`, source: endFrameId, target: videoId },
      );
    }
  }

  return WorkflowGraphSchema.parse({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: "口播视频工作流",
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  });
}

export function getWorkflowExecutionOrder(graph: Pick<WorkflowGraph, "nodes" | "edges">): string[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, [] as string[]]));

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
  const ordered: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const target of outgoing.get(id) || []) {
      const next = (indegree.get(target) || 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }

  if (ordered.length !== nodeIds.size) throw new Error("节点之间存在循环连接，请删除回路后再执行");
  return ordered;
}

export function collectWorkflowInputs(
  graph: Pick<WorkflowGraph, "nodes" | "edges">,
  targetId: string,
): {
  texts: string[];
  imageUrls: string[];
  imageSources: Array<{
    id: string;
    title: string;
    imageMode: WorkflowNodeData["imageMode"];
    imageCount: number;
    outputUrl: string;
  }>;
  audioUrls: string[];
  audioSources: Array<{
    id: string;
    title: string;
    sourceMediaKind: "audio" | "music";
    outputUrl: string;
  }>;
} {
  const sources = new Set(graph.edges.filter((edge) => edge.target === targetId).map((edge) => edge.source));
  const upstream = graph.nodes.filter((node) => sources.has(node.id));
  const imageSources = upstream
    .filter((node) => node.data.outputUrl && (
      node.data.kind === "image"
      || (node.data.kind === "upload" && node.data.sourceMediaKind !== "audio" && node.data.sourceMediaKind !== "music")
    ))
    .map((node) => ({
      id: node.id,
      title: node.data.title,
      imageMode: node.data.imageMode,
      imageCount: node.data.imageCount,
      outputUrl: node.data.outputUrl,
    }));
  const audioSources = upstream
    .filter((node) => (
      node.data.kind === "upload"
      && Boolean(node.data.outputUrl)
      && (node.data.sourceMediaKind === "audio" || node.data.sourceMediaKind === "music")
    ))
    .map((node) => ({
      id: node.id,
      title: node.data.title,
      sourceMediaKind: node.data.sourceMediaKind as "audio" | "music",
      outputUrl: node.data.outputUrl,
    }));
  return {
    texts: upstream.map((node) => node.data.outputText || (node.data.kind === "text" ? node.data.prompt : "")).filter(Boolean),
    imageUrls: imageSources.map((source) => source.outputUrl),
    imageSources,
    audioUrls: audioSources.map((source) => source.outputUrl),
    audioSources,
  };
}

export function resolveWorkflowPrompt(template: string, inputs: { texts: string[]; imageUrls: string[] }): string {
  const text = inputs.texts.join("\n");
  const imageUrl = inputs.imageUrls[0] || "";
  const resolved = template
    .replaceAll("{{input.text}}", text)
    .replaceAll("{{input.imageUrl}}", imageUrl)
    .trim();
  return resolved || text;
}
