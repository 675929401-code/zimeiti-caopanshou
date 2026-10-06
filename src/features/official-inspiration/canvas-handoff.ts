import type {
  InspirationMediaType,
  OfficialInspirationItem,
} from "./inspiration-data";
import type {
  CanvasShareShowcaseData,
  CanvasShowcaseNodeKind,
} from "./canvas-showcase-data";

export const INSPIRATION_CANVAS_HANDOFF_KEY = "official_inspiration_canvas_reference_v1";
const CANVAS_SHOWCASE_HANDOFF_KEY_PREFIX = `${INSPIRATION_CANVAS_HANDOFF_KEY}:showcase:`;

export type CanvasHandoffNodeKind = "text" | "image" | "video" | "upload";
export type CanvasHandoffNodeStatus = "idle" | "succeeded";
export type InspirationHandoffMediaType = "image" | "video" | "audio";
export type InspirationHandoffMediaRole = "primary" | "preview-fallback";

export interface CanvasHandoffWorkflowNode {
  id: string;
  kind: CanvasHandoffNodeKind;
  sourceKind: CanvasShowcaseNodeKind;
  title: string;
  prompt: string;
  outputUrl: string;
  position: { x: number; y: number };
  status: CanvasHandoffNodeStatus;
}

export interface CanvasHandoffWorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasHandoffWorkflow {
  name: string;
  nodes: CanvasHandoffWorkflowNode[];
  edges: CanvasHandoffWorkflowEdge[];
}

export interface InspirationCanvasHandoff {
  schemaVersion: "official_inspiration_reference.v1" | "official_inspiration_reference.v2";
  source: "local-original-showcase";
  inspirationId: string;
  title: string;
  prompt: string;
  imagePath: string;
  mediaPath: string;
  mediaType: InspirationHandoffMediaType;
  mediaRole: InspirationHandoffMediaRole;
  createdAt: string;
  autoImport: boolean;
  note: string;
  workflow?: CanvasHandoffWorkflow;
}

export interface CanvasHandoffStorage {
  readonly length?: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
}

function resolveSessionStorage(storage?: CanvasHandoffStorage): CanvasHandoffStorage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function removeStaleCanvasShowcaseHandoffs(storage: CanvasHandoffStorage): void {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") return;
  const staleKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(CANVAS_SHOWCASE_HANDOFF_KEY_PREFIX)) staleKeys.push(key);
  }
  staleKeys.forEach((key) => storage.removeItem(key));
}

function isSafeLocalMediaPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /[?#]/u.test(value)
  ) return false;
  try {
    let decoded = value;
    for (let depth = 0; depth < 3; depth += 1) {
      const next = decodeURIComponent(decoded);
      if (
        !next.startsWith("/")
        || next.startsWith("//")
        || next.includes("\\")
        || /[\u0000-\u001f\u007f]/u.test(next)
        || /[?#]/u.test(next)
        || next.split("/").some((segment) => segment === "." || segment === "..")
      ) return false;
      if (next === decoded) return true;
      decoded = next;
    }
    return !/%[0-9a-f]{2}/iu.test(decoded);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanvasHandoffNodeKind(value: unknown): value is CanvasHandoffNodeKind {
  return value === "text" || value === "image" || value === "video" || value === "upload";
}

function isCanvasShowcaseNodeKind(value: unknown): value is CanvasShowcaseNodeKind {
  return value === "text" || value === "image" || value === "video" || value === "audio"
    || value === "music" || value === "video-plan" || value === "audio-plan" || value === "group";
}

function isInspirationHandoffMediaType(value: unknown): value is InspirationHandoffMediaType {
  return value === "image" || value === "video" || value === "audio";
}

function isInspirationHandoffMediaRole(value: unknown): value is InspirationHandoffMediaRole {
  return value === "primary" || value === "preview-fallback";
}

function parseHandoffWorkflow(value: unknown): CanvasHandoffWorkflow | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 200) return null;
  if (!Array.isArray(value.edges) || value.edges.length > 400) return null;

  const nodes: CanvasHandoffWorkflowNode[] = [];
  const nodeIds = new Set<string>();
  for (const candidate of value.nodes) {
    if (!isRecord(candidate) || !isRecord(candidate.position)) return null;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const prompt = typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
    const outputUrl = typeof candidate.outputUrl === "string" ? candidate.outputUrl : "";
    const x = Number(candidate.position.x);
    const y = Number(candidate.position.y);
    if (
      !id || id.length > 240 || nodeIds.has(id)
      || !title || title.length > 240
      || !prompt || prompt.length > 30_000
      || !isCanvasHandoffNodeKind(candidate.kind)
      || !isCanvasShowcaseNodeKind(candidate.sourceKind)
      || (outputUrl && !isSafeLocalMediaPath(outputUrl))
      || !Number.isFinite(x) || !Number.isFinite(y)
      || (candidate.status !== "idle" && candidate.status !== "succeeded")
    ) return null;
    nodeIds.add(id);
    nodes.push({
      id,
      kind: candidate.kind,
      sourceKind: candidate.sourceKind,
      title,
      prompt,
      outputUrl,
      position: { x, y },
      status: candidate.status,
    });
  }

  const edges: CanvasHandoffWorkflowEdge[] = [];
  const edgeIds = new Set<string>();
  for (const candidate of value.edges) {
    if (!isRecord(candidate)) return null;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const source = typeof candidate.source === "string" ? candidate.source.trim() : "";
    const target = typeof candidate.target === "string" ? candidate.target.trim() : "";
    if (
      !id || id.length > 240 || edgeIds.has(id)
      || !nodeIds.has(source) || !nodeIds.has(target) || source === target
    ) return null;
    edgeIds.add(id);
    edges.push({ id, source, target });
  }

  return { name: value.name.trim(), nodes, edges };
}

export function parseInspirationCanvasReference(value: string | null): InspirationCanvasHandoff | null {
  if (!value) return null;
  try {
    const payload = JSON.parse(value) as Partial<InspirationCanvasHandoff>;
    if (
      (payload.schemaVersion !== "official_inspiration_reference.v1"
        && payload.schemaVersion !== "official_inspiration_reference.v2")
      || payload.source !== "local-original-showcase"
      || typeof payload.inspirationId !== "string"
      || !payload.inspirationId.trim()
      || typeof payload.title !== "string"
      || !payload.title.trim()
      || typeof payload.prompt !== "string"
      || !payload.prompt.trim()
      || !isSafeLocalMediaPath(payload.imagePath)
      || (payload.mediaPath !== undefined && !isSafeLocalMediaPath(payload.mediaPath))
      || (payload.mediaType !== undefined && !isInspirationHandoffMediaType(payload.mediaType))
      || (payload.mediaRole !== undefined && !isInspirationHandoffMediaRole(payload.mediaRole))
      || typeof payload.createdAt !== "string"
    ) return null;
    const workflow = payload.workflow === undefined ? undefined : parseHandoffWorkflow(payload.workflow);
    if (payload.schemaVersion === "official_inspiration_reference.v2" && !workflow) return null;
    if (payload.workflow !== undefined && !workflow) return null;
    const mediaPath = payload.mediaPath || payload.imagePath;
    const mediaType = isInspirationHandoffMediaType(payload.mediaType) ? payload.mediaType : "image";
    const mediaRole = isInspirationHandoffMediaRole(payload.mediaRole)
      ? payload.mediaRole
      : mediaPath === payload.imagePath ? "preview-fallback" : "primary";
    return {
      schemaVersion: payload.schemaVersion,
      source: "local-original-showcase",
      inspirationId: payload.inspirationId.trim(),
      title: payload.title.trim(),
      prompt: payload.prompt.trim(),
      imagePath: payload.imagePath,
      mediaPath,
      mediaType,
      mediaRole,
      createdAt: payload.createdAt,
      autoImport: payload.autoImport === true,
      note: typeof payload.note === "string" ? payload.note : "",
      workflow: workflow ?? undefined,
    };
  } catch {
    return null;
  }
}

function toHandoffNodeKind(kind: CanvasShowcaseNodeKind): CanvasHandoffNodeKind {
  if (kind === "image") return "image";
  if (kind === "video" || kind === "video-plan") return "video";
  if (kind === "audio" || kind === "music" || kind === "audio-plan") return "upload";
  return "text";
}

function compileShowcaseWorkflow(showcase: CanvasShareShowcaseData): CanvasHandoffWorkflow {
  const nodeIdBySource = new Map<string, string>();
  const nodes = showcase.nodes.map((node, index): CanvasHandoffWorkflowNode => {
    const id = `showcase:${showcase.id}:${node.id}`;
    nodeIdBySource.set(node.id, id);
    const outputUrl = node.imagePath || node.mediaPath || "";
    const prompt = [
      node.body,
      node.toolLabel ? `工作台状态：${node.toolLabel}` : "",
      `原始节点类型：${node.kind}`,
    ].filter(Boolean).join("\n\n");
    return {
      id,
      kind: toHandoffNodeKind(node.kind),
      sourceKind: node.kind,
      title: [node.order, node.title].filter(Boolean).join(" · "),
      prompt,
      outputUrl: isSafeLocalMediaPath(outputUrl) ? outputUrl : "",
      position: node.position || {
        x: (index % 4) * 560,
        y: Math.floor(index / 4) * 430,
      },
      status: outputUrl || node.kind === "text" || node.kind === "group" || /已完成|已配置/u.test(node.status)
        ? "succeeded"
        : "idle",
    };
  });
  const edges = (showcase.edges || []).flatMap((edge): CanvasHandoffWorkflowEdge[] => {
    const source = nodeIdBySource.get(edge.source);
    const target = nodeIdBySource.get(edge.target);
    if (!source || !target || source === target) return [];
    return [{
      id: `showcase:${showcase.id}:${edge.id}`,
      source,
      target,
    }];
  });
  return { name: showcase.title, nodes, edges };
}

type InspirationCanvasReferenceInput = Pick<
  OfficialInspirationItem,
  "id" | "title" | "prompt" | "imagePath"
> & Partial<Pick<
  OfficialInspirationItem,
  "mediaType" | "mediaPath" | "availability" | "availabilityNote" | "sourceNote"
>>;

function toInspirationHandoffMediaType(mediaType?: InspirationMediaType): InspirationHandoffMediaType {
  if (mediaType === "视频") return "video";
  if (mediaType === "音频") return "audio";
  return "image";
}

function toInspirationSourceKind(mediaType: InspirationHandoffMediaType): CanvasShowcaseNodeKind {
  if (mediaType === "video") return "video";
  if (mediaType === "audio") return "audio";
  return "image";
}

function compileInspirationWorkflow(
  item: InspirationCanvasReferenceInput,
  mediaPath: string,
  mediaType: InspirationHandoffMediaType,
  mediaRole: InspirationHandoffMediaRole,
): CanvasHandoffWorkflow {
  const promptNodeId = `inspiration:${item.id}:prompt`;
  const mediaNodeId = `inspiration:${item.id}:media`;
  const sourceKind = toInspirationSourceKind(mediaType);
  const mediaKind: CanvasHandoffNodeKind = mediaType === "audio"
    ? "upload"
    : mediaRole === "preview-fallback"
      ? "upload"
      : mediaType;
  const mediaLabel = mediaType === "audio" ? "音频" : mediaType === "video" ? "视频" : "图片";
  const mediaPrompt = [
    `素材编号：${item.id}`,
    `素材语义类型：${mediaLabel}`,
    `本地媒体路径：${mediaPath}`,
    mediaRole === "preview-fallback"
      ? "当前条目没有可播放的原媒体文件；此节点保留本地预览图作为只读降级引用。"
      : "此路径指向已经存在的本地素材，仅作为引用导入，不会自动提交生成或扣费。",
    mediaType === "audio"
      ? "当前画布尚无音频原生节点，因此使用可选上传节点承载只读音频引用；媒体类型与本地路径必须原样保留。"
      : "进入画布后可连接新节点进行二次创作；原始媒体引用保持不变。",
    item.sourceNote ? `素材来源：${item.sourceNote}` : "",
    item.availabilityNote ? `可用状态：${item.availabilityNote}` : "",
  ].filter(Boolean).join("\n");
  return {
    name: item.title,
    nodes: [
      {
        id: promptNodeId,
        kind: "text",
        sourceKind: "text",
        title: `灵感提示词 · ${item.title}`,
        prompt: item.prompt,
        outputUrl: "",
        position: { x: 140, y: 120 },
        status: "succeeded",
      },
      {
        id: mediaNodeId,
        kind: mediaKind,
        sourceKind,
        title: `${mediaRole === "preview-fallback" ? "只读预览" : "只读媒体引用"} · ${item.title}`,
        prompt: mediaPrompt,
        outputUrl: mediaPath,
        position: { x: 680, y: 120 },
        status: "succeeded",
      },
    ],
    edges: [{
      id: `inspiration:${item.id}:prompt-to-media`,
      source: promptNodeId,
      target: mediaNodeId,
    }],
  };
}

export function saveInspirationCanvasReference(
  item: InspirationCanvasReferenceInput,
  storage?: CanvasHandoffStorage,
): boolean {
  const target = resolveSessionStorage(storage);
  if (!target || !isSafeLocalMediaPath(item.imagePath)) return false;
  if (item.mediaPath !== undefined && !isSafeLocalMediaPath(item.mediaPath)) return false;
  const mediaType = toInspirationHandoffMediaType(item.mediaType);
  const hasPrimaryMedia = mediaType === "image"
    || (item.availability !== "planned" && Boolean(item.mediaPath));
  const mediaPath = item.mediaPath || item.imagePath;
  const mediaRole: InspirationHandoffMediaRole = hasPrimaryMedia ? "primary" : "preview-fallback";
  const payload: InspirationCanvasHandoff = {
    schemaVersion: "official_inspiration_reference.v2",
    source: "local-original-showcase",
    inspirationId: item.id,
    title: item.title,
    prompt: item.prompt,
    imagePath: item.imagePath,
    mediaPath,
    mediaType,
    mediaRole,
    createdAt: new Date().toISOString(),
    autoImport: true,
    note: mediaType === "audio"
      ? "已建立只读音频媒体引用；画布暂无音频原生节点，因此使用降级节点保留媒体类型和本地路径。"
      : "已建立结构化媒体引用；进入画布后创建独立会话，原始素材不会自动触发生成或扣费。",
    workflow: compileInspirationWorkflow(item, mediaPath, mediaType, mediaRole),
  };
  const serialized = JSON.stringify(payload);
  if (!parseInspirationCanvasReference(serialized)) return false;
  try {
    target.setItem(INSPIRATION_CANVAS_HANDOFF_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

function compileShowcaseBlueprint(showcase: CanvasShareShowcaseData): string {
  const nodes = showcase.nodes.map((node) => [
    `## ${[node.order, node.title].filter(Boolean).join("｜")}`,
    `节点类型：${node.kind}`,
    node.body,
    node.toolLabel ? `工作台状态：${node.toolLabel}` : "",
  ].filter(Boolean).join("\n"));
  const edges = (showcase.edges || []).map((edge) => `${edge.source} -> ${edge.target}`);
  return [
    `# ${showcase.title}`,
    showcase.description,
    "",
    "## 总体提示词",
    showcase.prompt,
    "",
    `## 可编辑工作流蓝图（${showcase.nodes.length} 个节点）`,
    ...nodes,
    "",
    `## 连线结构（${edges.length} 条）`,
    ...(edges.length > 0 ? edges : ["当前示例使用顺序节点，进入画布后可自行建立连线。"]),
    "",
    "复制说明：当前分享页为只读静态示例，进入画布后先导入可编辑蓝图与本地原创参考图；任何模型选择、参数、积分与生成操作都需在工作台内再次确认。",
  ].join("\n");
}

export function saveCanvasShowcaseReference(
  showcase: CanvasShareShowcaseData,
  storage?: CanvasHandoffStorage,
): boolean {
  const target = resolveSessionStorage(storage);
  if (!target) return false;
  const firstImage = showcase.nodes.find((node) => isSafeLocalMediaPath(node.imagePath));
  const imagePath = firstImage?.imagePath || showcase.coverImage;
  if (!isSafeLocalMediaPath(imagePath)) return false;
  const firstMediaNode = showcase.nodes.find((node) => isSafeLocalMediaPath(node.mediaPath)) || firstImage;
  const mediaPath = firstMediaNode?.mediaPath || firstMediaNode?.imagePath || imagePath;
  if (!isSafeLocalMediaPath(mediaPath)) return false;
  const mediaType: InspirationHandoffMediaType = firstMediaNode?.kind === "video"
    ? "video"
    : firstMediaNode?.kind === "audio" || firstMediaNode?.kind === "music"
      ? "audio"
      : "image";
  const payload: InspirationCanvasHandoff = {
    schemaVersion: "official_inspiration_reference.v2",
    source: "local-original-showcase",
    inspirationId: showcase.id,
    title: showcase.title,
    prompt: compileShowcaseBlueprint(showcase),
    imagePath,
    mediaPath,
    mediaType,
    mediaRole: "primary",
    createdAt: new Date().toISOString(),
    autoImport: true,
    note: `已复制 ${showcase.nodes.length} 个节点和 ${(showcase.edges || []).length} 条连线；作为独立可编辑画布会话导入。`,
    workflow: compileShowcaseWorkflow(showcase),
  };
  const serialized = JSON.stringify(payload);
  if (!parseInspirationCanvasReference(serialized)) return false;
  try {
    target.removeItem(INSPIRATION_CANVAS_HANDOFF_KEY);
    removeStaleCanvasShowcaseHandoffs(target);
    target.setItem(canvasShowcaseHandoffKey(showcase.id), serialized);
    return true;
  } catch {
    return false;
  }
}

export function canvasShowcaseHandoffKey(showcaseId: string): string {
  return `${CANVAS_SHOWCASE_HANDOFF_KEY_PREFIX}${encodeURIComponent(showcaseId.trim())}`;
}

/**
 * Read a showcase handoff without deleting it.
 *
 * The free Canvas uses this replayable read while an anonymous draft is still
 * memory-only. The handoff is acknowledged only after the imported document is
 * confirmed by the account persistence API, so an anonymous -> authenticated
 * scope change or a refresh can safely replay the same public graph.
 */
export function readCanvasShowcaseReference(
  showcaseId: string,
  storage?: CanvasHandoffStorage,
): InspirationCanvasHandoff | null {
  const expectedId = showcaseId.trim();
  if (!expectedId || expectedId.length > 240) return null;
  const target = resolveSessionStorage(storage);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(canvasShowcaseHandoffKey(expectedId));
  } catch {
    return null;
  }
  const payload = parseInspirationCanvasReference(raw);
  return payload?.inspirationId === expectedId ? payload : null;
}

/** Remove a replayable showcase handoff after its account copy is durable. */
export function acknowledgeCanvasShowcaseReference(
  showcaseId: string,
  storage?: CanvasHandoffStorage,
): boolean {
  const expectedId = showcaseId.trim();
  if (!expectedId || expectedId.length > 240) return false;
  const target = resolveSessionStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(canvasShowcaseHandoffKey(expectedId));
    target.removeItem(INSPIRATION_CANVAS_HANDOFF_KEY);
    return true;
  } catch {
    return false;
  }
}

export function consumeCanvasShowcaseReference(
  showcaseId: string,
  storage?: CanvasHandoffStorage,
): InspirationCanvasHandoff | null {
  const expectedId = showcaseId.trim();
  if (!expectedId || expectedId.length > 240) return null;
  const target = resolveSessionStorage(storage);
  if (!target) return null;
  const key = canvasShowcaseHandoffKey(expectedId);
  let raw: string | null = null;
  try {
    raw = target.getItem(key);
    target.removeItem(INSPIRATION_CANVAS_HANDOFF_KEY);
    removeStaleCanvasShowcaseHandoffs(target);
  } catch {
    return null;
  }
  const payload = parseInspirationCanvasReference(raw);
  return payload?.inspirationId === expectedId ? payload : null;
}

export function consumeInspirationCanvasReference(
  storage?: CanvasHandoffStorage,
): InspirationCanvasHandoff | null {
  const target = resolveSessionStorage(storage);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(INSPIRATION_CANVAS_HANDOFF_KEY);
    if (raw !== null) target.removeItem(INSPIRATION_CANVAS_HANDOFF_KEY);
  } catch {
    return null;
  }
  return parseInspirationCanvasReference(raw);
}
