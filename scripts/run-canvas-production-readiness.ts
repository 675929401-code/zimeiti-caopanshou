import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { chromium, type Download, type Locator, type Page } from "playwright";

const BASE_URL = "http://127.0.0.1:5000";
const MARKER = "[PRD-E2E-20260823-CANVAS]";
const EVIDENCE_DIR = resolve(".codex-evidence", "production-readiness-20260823", "canvas");
const SCREENSHOT_DIR = join(EVIDENCE_DIR, "screenshots");
const DOWNLOAD_DIR = join(EVIDENCE_DIR, "downloads");
const CANARY_GUARD_PATH = join(EVIDENCE_DIR, "real-canary-submission.guard.json");
const TOKEN_KEY = "auth_token";
const HANDOFF_KEY = "official_inspiration_canvas_reference_v1";
const SESSIONS_KEY = "ai-creation-studio-free-canvas-sessions-v1";
const ACTIVE_SESSION_KEY = "ai-creation-studio-free-canvas-active-session-v1";
const IMAGE_MODEL_ID = "pm_7ZoWNH7zuZkVso7_OHgGzYfl";
const VIDEO_MODEL_ID = "pm_eY5Mkb2Yon-w3uzwnuSdyY7R";
const IMAGE_PROMPT = `${MARKER} 一只橙色纸艺狐狸站在浅青色摄影棚背景中，单一主体，无文字，16:9 横向构图，简洁清晰。`;
const VIDEO_PROMPT = `${MARKER} 橙色纸艺狐狸面向镜头轻轻挥动右爪一次，固定机位，背景保持不变，动作自然，1秒，无旁白。`;

const SHOWCASES = [
  { id: "canvas-showcase-78f7a4a9ce11-paper-fox-adventure", nodes: 13, edges: 17, images: 3, videos: 3, audios: 2 },
  { id: "cmsyrsury01e3caezkqyg5l5l", nodes: 78, edges: 71, images: 67, videos: 2, audios: 1 },
  { id: "cmsyrvsqh01jgcaez3xadrsob", nodes: 139, edges: 148, images: 106, videos: 11, audios: 3 },
  { id: "cmt37buny005u85fyne9adfac", nodes: 85, edges: 14, images: 28, videos: 0, audios: 0 },
] as const;

type JsonRecord = Record<string, unknown>;
type CanvasNodeProjection = {
  id: string;
  kind: string;
  sourceMediaKind: string;
  title: string;
  status: string;
  progressMessage: string;
  taskId: string;
  modelId: string;
  publicModelName: string;
  estimatedCost: number | null;
  actualCost: number | null;
  billingReferenceId: string;
  assetId: string;
  storageKey: string;
  historyRecordId: string;
  completedAt: string;
  resultPath: string;
  historyCount: number;
};

type CanvasSessionProjection = {
  id: string;
  name: string;
  updatedAt: string;
  nodes: CanvasNodeProjection[];
  edges: Array<{ id: string; source: string; target: string }>;
};

type NetworkCall = {
  kind: "image" | "video";
  endpoint: string;
  at: string;
  request: JsonRecord;
  response?: JsonRecord;
};

const report: JsonRecord = {
  schemaVersion: 1,
  marker: MARKER,
  startedAt: new Date().toISOString(),
  preview: BASE_URL,
  identity: { account: "sandbox-admin", role: "admin", sandbox: true },
  constraints: {
    buildRun: false,
    previewRestarted: false,
    tokenPersisted: false,
    stateChangingGenerationAuthorized: true,
  },
  steps: [],
  blockers: [],
};

let secretToken = "";
let secretUserId = "";

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function publicUrlPath(value: unknown): string {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.startsWith("data:")) return "data:image/*;base64,[redacted]";
  if (raw.startsWith("blob:")) return "blob:[ephemeral]";
  try {
    const parsed = new URL(raw, BASE_URL);
    return parsed.origin === BASE_URL ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.slice(0, 240).replace(/[?#].*$/u, "");
  }
}

function sanitizeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error || "unknown error");
  if (secretToken) text = text.replaceAll(secretToken, "[redacted-token]");
  if (secretUserId) text = text.replaceAll(secretUserId, "[redacted-user]");
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|key|signature|credential|secret)=[^\s&#]*)/giu, "[redacted-query]")
    .slice(0, 800);
}

function promptSummary(value: unknown): string {
  const text = String(value || "");
  if (!text) return "";
  return `${text.includes(MARKER) ? MARKER : "[unmarked]"} sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)} chars:${text.length}`;
}

function safeNumber(value: unknown): number | null {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function projectRequest(kind: "image" | "video", raw: unknown): JsonRecord {
  const body = asRecord(raw);
  if (kind === "image") {
    return {
      modelId: String(body.modelId || ""),
      inputSummary: promptSummary(body.prompt),
      aspectRatio: String(body.aspectRatio || ""),
      resolution: String(body.resolution || ""),
      referenceCount: Array.isArray(body.referenceImageUrls) ? body.referenceImageUrls.length : 0,
      clientTraceId: String(body.clientTraceId || ""),
      clientIdempotencyKeyPresent: Boolean(body.clientIdempotencyKey),
      strictSingleSubmit: body.strictSingleSubmit === true,
      noRetry: body.noRetry === true,
    };
  }
  return {
    modelId: String(body.model_id || ""),
    inputSummary: promptSummary(body.prompt),
    durationSeconds: safeNumber(body.duration),
    aspectRatio: String(body.aspect_ratio || ""),
    resolution: String(body.resolution_tier || body.resolution || ""),
    imagePath: publicUrlPath(body.image_url),
    referenceImageCount: Array.isArray(body.reference_image_urls) ? body.reference_image_urls.length : 0,
    audioPath: publicUrlPath(body.audio_url),
    referenceAudioCount: Array.isArray(body.reference_audio_urls) ? body.reference_audio_urls.length : 0,
    clientRequestId: String(body.client_request_id || ""),
  };
}

function projectResponse(kind: "image" | "video", status: number, raw: unknown): JsonRecord {
  const body = asRecord(raw);
  const images = Array.isArray(body.images) ? body.images.map(asRecord) : [];
  return {
    httpStatus: status,
    ok: status >= 200 && status < 300,
    status: String(body.status || ""),
    taskId: String(body.taskId || body.traceId || body.task_id || ""),
    publicModelName: String(body.modelUsed || body.model_name || ""),
    modelId: String(body.modelIdUsed || ""),
    cashCharged: safeNumber(body.cashCharged ?? body.priceCharged ?? (kind === "video" && body.status === "completed" ? body.price : null)),
    cashRemaining: safeNumber(body.cashRemaining),
    resultPath: publicUrlPath(kind === "image" ? images[0]?.url : body.video_url),
    width: safeNumber(images[0]?.width),
    height: safeNumber(images[0]?.height),
    errorCode: String(body.code || body.error_code || ""),
    error: body.error ? sanitizeError(body.error) : "",
  };
}

function evidenceReplacer(key: string, value: unknown) {
  if (/^(?:token|auth[_-]?token|access[_-]?token|refresh[_-]?token|cookie|set-cookie|authorization|secret|password|api[_-]?key|user[_-]?id)$/iu.test(key)) {
    throw new Error(`Forbidden evidence field: ${key}`);
  }
  if (typeof value === "string" && /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)) {
    throw new Error("JWT-like value reached evidence payload");
  }
  return value;
}

async function writeEvidenceJson(name: string, value: unknown) {
  const json = JSON.stringify(value, evidenceReplacer, 2);
  if ((secretToken && json.includes(secretToken)) || (secretUserId && json.includes(secretUserId))) {
    throw new Error("Sensitive value reached evidence payload");
  }
  await writeFile(join(EVIDENCE_DIR, name), `${json}\n`, "utf8");
}

function addStep(name: string, status: "passed" | "failed" | "blocked", detail: unknown) {
  (report.steps as unknown[]).push({ name, status, at: new Date().toISOString(), detail });
  if (status !== "passed") (report.blockers as unknown[]).push({ name, status, detail });
}

async function checkpoint(label: string) {
  report.lastCheckpoint = { label, at: new Date().toISOString() };
  await writeEvidenceJson("canvas-production-readiness.partial.json", report);
}

async function armRealCanaryGuard() {
  const payload = {
    schemaVersion: 1,
    marker: MARKER,
    armedAt: new Date().toISOString(),
    imageModelId: IMAGE_MODEL_ID,
    videoModelId: VIDEO_MODEL_ID,
    imageInputSummary: promptSummary(IMAGE_PROMPT),
    videoInputSummary: promptSummary(VIDEO_PROMPT),
  };
  try {
    await writeFile(CANARY_GUARD_PATH, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      addStep("real-canary-rerun-guard", "blocked", {
        reason: "同一验收目录已经武装过真实提交；必须先按既有任务和资产对账，禁止自动再次生成",
      });
      throw new Error("REAL_CANARY_ALREADY_ARMED_RECONCILE_ONLY");
    }
    throw error;
  }
  addStep("real-canary-rerun-guard", "passed", { marker: MARKER, atomicCreate: true, tokenPersisted: false });
}

function projectCanvasNode(node: unknown): CanvasNodeProjection {
  const record = asRecord(node);
  const data = asRecord(record.data);
  const history = Array.isArray(data.history) ? data.history : [];
  return {
    id: String(record.id || ""),
    kind: String(data.kind || ""),
    sourceMediaKind: String(data.sourceMediaKind || ""),
    title: String(data.title || ""),
    status: String(data.status || ""),
    progressMessage: String(data.progressMessage || ""),
    taskId: String(data.taskId || ""),
    modelId: String(data.modelId || ""),
    publicModelName: String(data.publicModelName || ""),
    estimatedCost: safeNumber(data.estimatedCost),
    actualCost: safeNumber(data.actualCost),
    billingReferenceId: String(data.billingReferenceId || ""),
    assetId: String(data.assetId || ""),
    storageKey: String(data.storageKey || ""),
    historyRecordId: String(data.historyRecordId || ""),
    completedAt: String(data.completedAt || ""),
    resultPath: publicUrlPath(data.outputUrl),
    historyCount: history.length,
  };
}

function durableNodeProjection(node: CanvasNodeProjection | null) {
  if (!node) return null;
  return {
    id: node.id,
    kind: node.kind,
    sourceMediaKind: node.sourceMediaKind,
    status: node.status,
    taskId: node.taskId,
    modelId: node.modelId,
    publicModelName: node.publicModelName,
    estimatedCost: node.estimatedCost,
    actualCost: node.actualCost,
    billingReferenceId: node.billingReferenceId,
    assetId: node.assetId,
    storageKey: node.storageKey,
    historyRecordId: node.historyRecordId,
    completedAt: node.completedAt,
    resultPath: node.resultPath,
    historyCount: node.historyCount,
  };
}

async function inspectLoadedMedia(locator: Locator) {
  type MediaHealth = {
    tag: string;
    path: string;
    visible: boolean;
    readyState: number;
    durationSeconds: number | null;
    videoWidth: number | null;
    videoHeight: number | null;
    errorCode: number;
    controls: boolean;
  };
  await locator.evaluateAll((elements) => {
    for (const element of elements) (element as HTMLMediaElement).load();
  });
  let snapshot: MediaHealth[] = [];
  const deadline = Date.now() + 20_000;
  do {
    snapshot = await locator.evaluateAll((elements) => {
      const rows: Array<{
        tag: string;
        path: string;
        visible: boolean;
        readyState: number;
        durationSeconds: number | null;
        videoWidth: number | null;
        videoHeight: number | null;
        errorCode: number;
        controls: boolean;
      }> = [];
      for (const element of elements) {
        const media = element as HTMLMediaElement;
        const bounds = media.getBoundingClientRect();
        let path = "";
        try { path = new URL(media.currentSrc || media.src).pathname; } catch { path = String(media.currentSrc || media.src).replace(/[?#].*$/u, ""); }
        rows.push({
          tag: media.tagName.toLowerCase(),
          path,
          visible: bounds.width > 0 && bounds.height > 0,
          readyState: media.readyState,
          durationSeconds: Number.isFinite(media.duration) ? Number(media.duration.toFixed(3)) : null,
          videoWidth: media instanceof HTMLVideoElement ? media.videoWidth : null,
          videoHeight: media instanceof HTMLVideoElement ? media.videoHeight : null,
          errorCode: media.error?.code || 0,
          controls: media.controls,
        });
      }
      return rows;
    });
    if (snapshot.every((item) => item.readyState >= 1 || item.errorCode !== 0)) return snapshot;
    await locator.page().waitForTimeout(250);
  } while (Date.now() < deadline);
  return snapshot;
}

async function readActiveSession(page: Page): Promise<CanvasSessionProjection | null> {
  const raw = await page.evaluate(({ sessionsKey, activeKey }) => {
    const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as JsonRecord[];
    const activeId = localStorage.getItem(activeKey) || "";
    return sessions.find((session) => session.id === activeId) || null;
  }, { sessionsKey: SESSIONS_KEY, activeKey: ACTIVE_SESSION_KEY });
  if (!raw) return null;
  const record = asRecord(raw);
  return {
    id: String(record.id || ""),
    name: String(record.name || ""),
    updatedAt: String(record.updatedAt || ""),
    nodes: Array.isArray(record.nodes) ? record.nodes.map(projectCanvasNode) : [],
    edges: Array.isArray(record.edges) ? record.edges.map((edge) => {
      const item = asRecord(edge);
      return { id: String(item.id || ""), source: String(item.source || ""), target: String(item.target || "") };
    }) : [],
  };
}

async function selectedFlowNode(page: Page): Promise<Locator> {
  return page.locator(".react-flow__node").filter({ has: page.locator(".free-node-shell.selected") }).first();
}

async function connectNodes(page: Page, sourceId: string, targetId: string) {
  const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`).first();
  const target = page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target`).first();
  const edgeCountBefore = await page.locator(".react-flow__edge").count();
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox, `连接端点不可见: ${sourceId} -> ${targetId}`);
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 16 });
  await page.mouse.up();
  try {
    await page.waitForFunction((count) => document.querySelectorAll(".react-flow__edge").length > count, edgeCountBefore, { timeout: 3_000 });
    return;
  } catch {
    await source.click({ force: true });
    await target.click({ force: true });
    await page.waitForFunction((count) => document.querySelectorAll(".react-flow__edge").length > count, edgeCountBefore, { timeout: 5_000 });
  }
}

async function waitForSavedNode(page: Page, nodeId: string, accepted: string[], timeoutMs: number) {
  const transitions: Array<{ at: string; status: string; progressMessage: string }> = [];
  let previous = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await readActiveSession(page);
    const node = session?.nodes.find((item) => item.id === nodeId);
    if (node) {
      const key = `${node.status}|${node.progressMessage}`;
      if (key !== previous) {
        transitions.push({ at: new Date().toISOString(), status: node.status, progressMessage: node.progressMessage });
        previous = key;
      }
      if (accepted.includes(node.status)) return { node, transitions, timedOut: false };
    }
    await page.waitForTimeout(1_000);
  }
  const session = await readActiveSession(page);
  return { node: session?.nodes.find((item) => item.id === nodeId) || null, transitions, timedOut: true };
}

async function inspectShowcase(page: Page, expected: typeof SHOWCASES[number]) {
  await page.goto(`${BASE_URL}/youcai/share/canvas/${expected.id}`, { waitUntil: "domcontentloaded" });
  await page.locator("article[data-node-id]").first().waitFor({ state: "visible", timeout: 30_000 });
  const counts = {
    nodes: await page.locator("article[data-node-id]").count(),
    edges: await page.locator('section[aria-label="只读工作流画布"] svg[aria-hidden="true"] > path[marker-end]').count(),
    images: await page.locator('article[data-kind="image"] img').count(),
    videos: await page.locator('article[data-kind="video"] video source[src]').count(),
    audios: await page.locator('article[data-kind="audio"] audio source[src], article[data-kind="music"] audio source[src]').count(),
  };
  assert.deepEqual(counts, {
    nodes: expected.nodes,
    edges: expected.edges,
    images: expected.images,
    videos: expected.videos,
    audios: expected.audios,
  });

  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('article[data-kind="image"] img')];
    return images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, undefined, { timeout: 30_000 });

  const imageVisibility = await page.locator('article[data-kind="image"] img').evaluateAll((images) => images.map((image) => {
    const item = image as HTMLImageElement;
    return { visible: item.getBoundingClientRect().width > 0, naturalWidth: item.naturalWidth, naturalHeight: item.naturalHeight };
  }));
  const mediaSources = await page.locator('article[data-kind="video"] source[src], article[data-kind="audio"] source[src], article[data-kind="music"] source[src]').evaluateAll((sources) => sources.map((source) => {
    const src = (source as HTMLSourceElement).src;
    try { return new URL(src).pathname; } catch { return src.replace(/[?#].*$/u, ""); }
  }));
  const mediaHealth = await inspectLoadedMedia(page.locator('article[data-kind="video"] video, article[data-kind="audio"] audio, article[data-kind="music"] audio'));
  assert.ok(imageVisibility.every((item) => item.visible && item.naturalWidth > 0 && item.naturalHeight > 0), `${expected.id} 图片未全部可见`);
  assert.equal(mediaSources.length, expected.videos + expected.audios);
  assert.equal(mediaHealth.length, expected.videos + expected.audios);
  assert.ok(mediaHealth.every((item) => item.visible
    && item.controls
    && item.readyState >= 1
    && item.errorCode === 0
    && Number(item.durationSeconds) > 0
    && (item.tag !== "video" || (Number(item.videoWidth) > 0 && Number(item.videoHeight) > 0))), `${expected.id} 视频/音频没有全部加载到可判定媒体终态`);

  const zoomLabel = page.locator('section[aria-label="只读工作流画布"] button[aria-label="缩小"]').locator("..").locator("span");
  const zoomBefore = await zoomLabel.textContent();
  await page.getByRole("button", { name: "放大" }).click();
  const zoomAfterIn = await zoomLabel.textContent();
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "适配视图" }).click();
  const viewportScroll = await page.locator('section[aria-label="只读工作流画布"]').evaluate((element) => {
    element.scrollTo({ left: element.scrollWidth, top: element.scrollHeight, behavior: "auto" });
    return {
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    };
  });
  await page.getByRole("button", { name: "列表视图" }).click();
  await page.locator('section[aria-label="只读工作流列表"]').waitFor({ state: "visible" });
  const listNodes = await page.locator('section[aria-label="只读工作流列表"] article[data-node-id]').count();
  assert.equal(listNodes, expected.nodes);
  assert.notEqual(zoomBefore, zoomAfterIn);
  assert.ok(viewportScroll.scrollWidth > viewportScroll.clientWidth || viewportScroll.scrollHeight > viewportScroll.clientHeight, `${expected.id} 画布没有可滚动区域`);
  assert.ok(viewportScroll.scrollLeft > 0 || viewportScroll.scrollTop > 0, `${expected.id} 画布滚动没有发生`);
  await page.getByRole("button", { name: "画布视图" }).click();
  await page.screenshot({ path: join(SCREENSHOT_DIR, `showcase-${expected.id}.png`), fullPage: true });

  const handoffCaptureKey = `${HANDOFF_KEY}:production-readiness-capture`;
  await page.evaluate(({ handoffKey, captureKey }) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function captureCanvasHandoff(this: Storage, key: string, value: string) {
      if (this === window.sessionStorage && key === handoffKey) {
        originalSetItem.call(window.localStorage, captureKey, value);
      }
      originalSetItem.call(this, key, value);
    };
  }, { handoffKey: HANDOFF_KEY, captureKey: handoffCaptureKey });
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/youcai/free-canvas", { timeout: 30_000 }),
    page.getByRole("button", { name: "复制并继续创作" }).click(),
  ]);
  const handoffState = await page.evaluate(({ handoffKey, captureKey }) => {
    const captured = localStorage.getItem(captureKey);
    localStorage.removeItem(captureKey);
    return {
      captured: JSON.parse(captured || "null") as unknown,
      consumed: sessionStorage.getItem(handoffKey) === null,
    };
  }, { handoffKey: HANDOFF_KEY, captureKey: handoffCaptureKey });
  const handoff = handoffState.captured;
  const handoffRecord = asRecord(handoff);
  const workflow = asRecord(handoffRecord.workflow);
  const handoffNodes = Array.isArray(workflow.nodes) ? workflow.nodes.map(asRecord) : [];
  const handoffEdges = Array.isArray(workflow.edges) ? workflow.edges.map(asRecord) : [];
  const handoffAudioKinds = handoffNodes.filter((node) => node.sourceKind === "audio" || node.sourceKind === "music").length;
  assert.equal(handoffNodes.length, expected.nodes);
  assert.equal(handoffEdges.length, expected.edges);
  assert.equal(handoffAudioKinds, expected.audios);
  assert.equal(handoffState.consumed, true, "真实 ManualCanvas 必须消费一次性 handoff");

  await page.waitForFunction(({ sessionsKey, activeKey, nodeCount, edgeCount }) => {
    const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as JsonRecord[];
    const active = sessions.find((session) => session.id === localStorage.getItem(activeKey));
    return Array.isArray(active?.nodes) && active.nodes.length === nodeCount && Array.isArray(active?.edges) && active.edges.length === edgeCount;
  }, { sessionsKey: SESSIONS_KEY, activeKey: ACTIVE_SESSION_KEY, nodeCount: expected.nodes, edgeCount: expected.edges }, { timeout: 30_000 });
  const copied = await readActiveSession(page);
  assert.ok(copied);
  const copiedAudioKinds = copied.nodes.filter((node) => node.sourceMediaKind === "audio" || node.sourceMediaKind === "music").length;
  const copiedAudioIds = new Set(copied.nodes.filter((node) => node.sourceMediaKind === "audio" || node.sourceMediaKind === "music").map((node) => node.id));
  const copiedAudioEdges = copied.edges.filter((edge) => copiedAudioIds.has(edge.source) || copiedAudioIds.has(edge.target)).length;
  const copiedNodeIds = copied.nodes.map((node) => node.id).sort();
  const handoffNodeIds = handoffNodes.map((node) => String(node.id || "")).sort();
  const copiedEdges = copied.edges.map((edge) => `${edge.source}->${edge.target}`).sort();
  const expectedEdges = handoffEdges.map((edge) => `${String(edge.source || "")}->${String(edge.target || "")}`).sort();
  assert.deepEqual(copiedNodeIds, handoffNodeIds);
  assert.deepEqual(copiedEdges, expectedEdges);
  assert.equal(copiedAudioKinds, expected.audios);
  const copiedAudioHealth = await inspectLoadedMedia(page.locator(".free-node-shell.kind-upload audio"));
  assert.equal(copiedAudioHealth.length, copiedAudioKinds);
  assert.ok(copiedAudioHealth.every((item) => item.visible && item.controls && item.readyState >= 1 && item.errorCode === 0 && Number(item.durationSeconds) > 0), `${expected.id} 复制后的音频/音乐节点不可真实试听`);
  let copiedAudioDownload: JsonRecord | null = null;
  if (expected.id === SHOWCASES[0].id) {
    const firstAudioNode = copied.nodes.find((node) => node.sourceMediaKind === "audio" || node.sourceMediaKind === "music");
    if (!firstAudioNode) throw new Error("SHOWCASE_AUDIO_DOWNLOAD_NODE_MISSING");
    const audioNode = page.locator(`.react-flow__node[data-id="${firstAudioNode.id}"]`);
    await audioNode.locator(".workflow-node-head").click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 45_000 }),
      audioNode.getByRole("button", { name: "下载素材" }).click(),
    ]);
    copiedAudioDownload = { status: "passed", ...(await saveDownload(download, "showcase-audio-sample.mp3")) };
  }

  return {
    id: expected.id,
    counts,
    listNodes,
    imageVisibility,
    mediaSources,
    mediaHealth,
    zoom: { before: zoomBefore, afterIn: zoomAfterIn },
    viewportScroll,
    copy: {
      destinationPath: new URL(page.url()).pathname,
      handoffConsumed: handoffState.consumed,
      nodesConsistent: true,
      edgesConsistent: true,
      audioMusicSemanticCount: copiedAudioKinds,
      audioMusicConnectedEdgeCount: copiedAudioEdges,
      audioPlayers: copiedAudioHealth.length,
      audioHealth: copiedAudioHealth,
      audioDownload: copiedAudioDownload,
      reactFlowNodes: await page.locator(".react-flow__node").count(),
      reactFlowEdges: await page.locator(".react-flow__edge").count(),
    },
  };
}

async function fetchMediaAsDataUrl(value: string, expectedPrefix: "image/" | "audio/"): Promise<string> {
  const target = new URL(value, BASE_URL);
  const headers: Record<string, string> = {};
  if (target.origin === BASE_URL) headers.authorization = `Bearer ${secretToken}`;
  const response = await fetch(target, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`MEDIA_DOWNLOAD_${response.status}`);
  const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  if (!contentType.startsWith(expectedPrefix)) throw new Error(`MEDIA_CONTENT_TYPE_${contentType || "missing"}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= 0 || buffer.length > 25 * 1024 * 1024) throw new Error(`IMAGE_SIZE_${buffer.length}`);
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function saveDownload(download: Download, fileName: string) {
  const target = join(DOWNLOAD_DIR, fileName);
  await download.saveAs(target);
  const info = await stat(target);
  assert.ok(info.size > 0, `${fileName} 下载为空`);
  return { fileName, bytes: info.size };
}

async function main() {
  await Promise.all([
    mkdir(EVIDENCE_DIR, { recursive: true }),
    mkdir(SCREENSHOT_DIR, { recursive: true }),
    mkdir(DOWNLOAD_DIR, { recursive: true }),
  ]);
  loadEnv({ path: resolve(".env.local"), override: false, quiet: true });
  Reflect.set(process.env, "NODE_ENV", "development");

  const [
    { NextRequest },
    { GET: devSessionGET },
    { getSupabaseClient },
    { POST: persistImagePOST },
  ] = await Promise.all([
    import("next/server"),
    import("../src/app/api/auth/dev-session/route"),
    import("../src/storage/database/supabase-client"),
    import("../src/app/api/bridge/image/persist/route"),
  ]);

  const sessionResponse = await devSessionGET(new NextRequest(`${BASE_URL}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  }));
  if (sessionResponse.status !== 200) throw new Error(`DEV_SESSION_STATUS_${sessionResponse.status}`);
  const routeSession = await sessionResponse.json() as {
    success?: boolean;
    sandbox?: boolean;
    token?: string;
    user?: { id?: string; username?: string; role?: string; credits?: number; cashBalance?: number };
  };
  const db = getSupabaseClient();
  assert.equal(routeSession.success, true);
  assert.equal(routeSession.sandbox, true);
  assert.equal(routeSession.user?.role, "admin");
  const selectedToken = routeSession.token || "";
  const selectedUserId = routeSession.user?.id || "";
  assert.ok(selectedToken);
  assert.ok(selectedUserId);
  secretToken = selectedToken;
  secretUserId = selectedUserId;
  const accountHash = createHash("sha256").update(selectedUserId).digest("hex").slice(0, 16);
  report.identity = { account: "sandbox-admin", accountHash, role: "admin", sandbox: true };
  addStep("sandbox-admin-session", "passed", {
    account: "sandbox-admin",
    accountHash,
    role: "admin",
    sandbox: true,
    routeStatus: 200,
    officialRouteSessionUsed: true,
  });

  const readBalances = async () => {
    const result = await db.from("users").select("credits,cash_balance").eq("id", secretUserId).single();
    if (result.error || !result.data) throw new Error("BALANCE_QUERY_FAILED");
    return { credits: Number(result.data.credits), cash: Number(result.data.cash_balance) };
  };
  const startBalances = await readBalances();
  report.startBalances = startBalances;
  report.referenceBaseline = { credits: 5000.5, cash: 20 };
  report.referenceBaselineMatched = startBalances.credits === 5000.5 && startBalances.cash === 20;
  addStep("starting-balance", "passed", { ...startBalances, referenceBaselineMatched: report.referenceBaselineMatched });

  const supabaseUrl = process.env.COZE_SUPABASE_URL || "";
  const supabaseKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !supabaseKey) throw new Error("SUPABASE_OPENAPI_PROBE_CONFIG_MISSING");
  const openApiResponse = await fetch(`${supabaseUrl}/rest/v1/`, {
    headers: { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, accept: "application/openapi+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!openApiResponse.ok) throw new Error(`SUPABASE_OPENAPI_PROBE_${openApiResponse.status}`);
  const openApi = asRecord(await openApiResponse.json());
  const definitions = asRecord(openApi.definitions || asRecord(asRecord(openApi.components).schemas));
  const conversationsDefinition = asRecord(definitions.conversations);
  const messagesDefinition = asRecord(definitions.conversation_messages);
  const conversationProperties = asRecord(conversationsDefinition.properties);
  const messageProperties = asRecord(messagesDefinition.properties);
  const idContract = {
    conversationsId: asRecord(conversationProperties.id),
    conversationMessagesId: asRecord(messageProperties.id),
    conversationMessagesConversationId: asRecord(messageProperties.conversation_id),
  };
  assert.equal(idContract.conversationsId.format, "text");
  assert.equal(idContract.conversationMessagesId.format, "text");
  assert.equal(idContract.conversationMessagesConversationId.format, "text");
  report.databaseIdContract = idContract;
  addStep("canvas-history-id-column-contract", "passed", idContract);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(({ origin, key, value }) => {
    try {
      if (location.origin === origin) localStorage.setItem(key, value);
    } catch {
      // about:blank and restricted frames are intentionally ignored.
    }
  }, { origin: BASE_URL, key: TOKEN_KEY, value: secretToken });
  const page = await context.newPage();

  const networkCalls: NetworkCall[] = [];
  const requestCallMap = new WeakMap<object, NetworkCall>();
  let latestImageRaw: JsonRecord = {};
  let latestVideoRaw: JsonRecord = {};
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    const kind = pathname === "/api/bridge/image/generate" || pathname === "/api/image/generate"
      ? "image"
      : pathname === "/api/bridge/video/generate" || pathname === "/api/video/generate"
        ? "video"
        : null;
    if (!kind) return;
    let raw: unknown = {};
    try { raw = request.postDataJSON(); } catch { raw = {}; }
    const call: NetworkCall = { kind, endpoint: pathname, at: new Date().toISOString(), request: projectRequest(kind, raw) };
    networkCalls.push(call);
    requestCallMap.set(request, call);
  });
  page.on("response", (response) => {
    const call = requestCallMap.get(response.request());
    if (!call) return;
    void response.json().then((raw: unknown) => {
      const body = asRecord(raw);
      call.response = projectResponse(call.kind, response.status(), body);
      if (call.kind === "image") latestImageRaw = body;
      if (call.kind === "video") latestVideoRaw = body;
    }).catch(() => {
      call.response = { httpStatus: response.status(), ok: response.ok(), error: "non-json response" };
    });
  });

  try {
    await page.goto(`${BASE_URL}/youcai/tools/canvas`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("official-canvas-page").waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" }));
    await page.waitForTimeout(100);
    const bannerVideo = page.locator('video[aria-label="多模态节点工作流循环视频"]');
    const bannerVideoSourceBeforePlay = await bannerVideo.locator("source").count();
    await page.getByRole("button", { name: "播放画布创作演示" }).click();
    const bannerVideoSource = publicUrlPath(await page.locator('video[aria-label="多模态节点工作流循环视频"] source').getAttribute("src"));
    await page.getByRole("button", { name: "停止画布创作演示并释放视频流量" }).click();
    const landing = {
      showcaseCards: await page.locator("article").filter({ has: page.getByText("精选示例") }).count(),
      bannerVisible: await page.locator('[aria-label="无限画布工作流动态演示"]').isVisible(),
      bannerVideoSourceBeforePlay,
      bannerVideoSource,
      bodyScroll: await page.evaluate(() => ({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight, scrollY })),
    };
    assert.equal(landing.showcaseCards, 4);
    assert.equal(landing.bannerVisible, true);
    assert.equal(landing.bannerVideoSourceBeforePlay, 0, "画布横幅视频不应在用户播放前请求 13 MB 媒体");
    assert.equal(landing.bannerVideoSource, "/youcai-media/v1/featured/canvas-banner-youcai.mp4", "画布横幅播放按钮没有绑定已治理的本地媒体");
    assert.ok(landing.bodyScroll.scrollY > 0, "漫剧画布入口页没有发生实际滚动");
    await page.screenshot({ path: join(SCREENSHOT_DIR, "canvas-landing.png"), fullPage: true });
    report.landing = landing;
    addStep("canvas-landing-buttons-scroll", "passed", landing);

    const showcases: unknown[] = [];
    for (const expected of SHOWCASES) {
      try {
        const result = await inspectShowcase(page, expected);
        showcases.push({ ...result, status: "passed" });
        addStep(`showcase-${expected.id}`, "passed", { nodes: expected.nodes, edges: expected.edges, mediaVisible: true, copyConsistent: true });
      } catch (error) {
        const detail = sanitizeError(error);
        showcases.push({ id: expected.id, status: "failed", error: detail });
        addStep(`showcase-${expected.id}`, "failed", { error: detail });
      }
    }
    report.showcases = showcases;
    await checkpoint("showcases-complete");

    await page.goto(`${BASE_URL}/youcai/free-canvas`, { waitUntil: "domcontentloaded" });
    await page.getByTitle("当前画布", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    const compatibilityRoute = {
      requestedPath: "/youcai/free-canvas",
      finalPath: new URL(page.url()).pathname,
      staticWorkspaceNodes: await page.locator("article[data-node-id]").count(),
      manualCanvasNodes: await page.locator(".react-flow__node").count(),
    };
    assert.equal(compatibilityRoute.finalPath, "/youcai/free-canvas");
    assert.equal(compatibilityRoute.staticWorkspaceNodes, 0);
    report.compatibilityRoute = compatibilityRoute;
    addStep("youcai-free-canvas-route", "passed", compatibilityRoute);

    await page.goto(`${BASE_URL}/youcai/free-canvas`, { waitUntil: "domcontentloaded" });
    await page.getByTitle("当前画布", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTitle("当前画布", { exact: true }).click();
    await page.getByRole("button", { name: "新建画布" }).click();
    const canvasName = `${MARKER} ${new Date().toISOString()}`;
    const activeNameInput = page.locator('section[aria-label="当前画布"] article.active input[aria-label="画布名称"]');
    if (!await activeNameInput.isVisible()) await page.getByTitle("当前画布", { exact: true }).click();
    await activeNameInput.fill(canvasName);
    await page.getByTitle("当前画布", { exact: true }).click();

    await page.getByTitle("添加文本节点").click();
    const textFlow = await selectedFlowNode(page);
    const textNodeId = String(await textFlow.getAttribute("data-id"));
    await textFlow.locator("textarea").fill(IMAGE_PROMPT);
    await textFlow.getByRole("button", { name: "应用正文" }).click();

    await page.getByTitle("添加图片节点").click();
    const imageFlow = await selectedFlowNode(page);
    const imageNodeId = String(await imageFlow.getAttribute("data-id"));
    await imageFlow.locator("textarea").fill("{{input.text}}");
    const imageModelSelect = imageFlow.locator('select[aria-label="图片生成模型"]');
    await imageModelSelect.waitFor({ state: "visible" });
    const imageModelOptions = await imageModelSelect.locator("option").evaluateAll((options) => options.map((option) => ({ value: (option as HTMLOptionElement).value, label: (option as HTMLOptionElement).textContent || "" })));
    assert.ok(imageModelOptions.some((option) => option.value === IMAGE_MODEL_ID), `图片模型不可用: ${JSON.stringify(imageModelOptions)}`);
    const selectedImageModelName = String(imageModelOptions.find((option) => option.value === IMAGE_MODEL_ID)?.label || "").split(" · ", 1)[0].trim();
    await imageModelSelect.selectOption(IMAGE_MODEL_ID);
    await imageFlow.locator("select").nth(1).selectOption("16:9");
    await imageFlow.locator('select[aria-label="生成数量"]').selectOption("1");
    await imageFlow.locator('select[aria-label="图片分辨率"]').selectOption("1K");

    await page.getByTitle("添加视频节点").click();
    const videoFlow = await selectedFlowNode(page);
    const videoNodeId = String(await videoFlow.getAttribute("data-id"));
    await videoFlow.locator("textarea").fill(VIDEO_PROMPT);
    const videoModelSelect = videoFlow.locator('select[title="视频生成模型"]');
    await videoModelSelect.waitFor({ state: "visible" });
    const videoModelOptions = await videoModelSelect.locator("option").evaluateAll((options) => options.map((option) => ({ value: (option as HTMLOptionElement).value, label: (option as HTMLOptionElement).textContent || "" })));
    assert.ok(videoModelOptions.some((option) => option.value === VIDEO_MODEL_ID), `视频模型不可用: ${JSON.stringify(videoModelOptions)}`);
    const selectedVideoModelName = String(videoModelOptions.find((option) => option.value === VIDEO_MODEL_ID)?.label || "").split(" · ", 1)[0].trim();
    await videoModelSelect.selectOption(VIDEO_MODEL_ID);
    await videoFlow.locator("select").nth(1).selectOption("16:9");
    await videoFlow.locator('select[aria-label="目标视频时长"]').selectOption("1");

    const edgeCountBefore = await page.locator(".react-flow__edge").count();
    await connectNodes(page, textNodeId, imageNodeId);
    await page.waitForFunction((count) => document.querySelectorAll(".react-flow__edge").length === count + 1, edgeCountBefore);
    await connectNodes(page, imageNodeId, videoNodeId);
    await page.waitForFunction((count) => document.querySelectorAll(".react-flow__edge").length === count + 2, edgeCountBefore);
    await page.waitForTimeout(1_000);

    const createdSession = await readActiveSession(page);
    if (!createdSession) throw new Error("CREATED_CANVAS_SESSION_MISSING");
    assert.ok(createdSession.name.includes(MARKER));
    assert.equal(createdSession.nodes.length, 3);
    assert.equal(createdSession.edges.length, 2);
    report.createdCanvas = {
      name: createdSession.name,
      nodeKinds: createdSession.nodes.map((node) => node.kind),
      nodeIds: { text: textNodeId, image: imageNodeId, video: videoNodeId },
      edgeCount: createdSession.edges.length,
      savedBeforeGeneration: true,
    };
    addStep("create-edit-connect-autosave", "passed", report.createdCanvas);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(({ sessionsKey, activeKey, marker, nodeCount, edgeCount }) => {
      const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as JsonRecord[];
      const active = sessions.find((session) => session.id === localStorage.getItem(activeKey));
      return String(active?.name || "").includes(marker)
        && Array.isArray(active?.nodes) && active.nodes.length === nodeCount
        && Array.isArray(active?.edges) && active.edges.length === edgeCount;
    }, { sessionsKey: SESSIONS_KEY, activeKey: ACTIVE_SESSION_KEY, marker: MARKER, nodeCount: 3, edgeCount: 2 }, { timeout: 30_000 });
    const preGenerationReload = await readActiveSession(page);
    assert.equal(preGenerationReload?.nodes.length, 3);
    assert.equal(preGenerationReload?.edges.length, 2);
    report.preGenerationReload = { nodes: 3, edges: 2, markerRestored: preGenerationReload?.name.includes(MARKER) === true };
    addStep("pre-generation-refresh-recovery", "passed", report.preGenerationReload);
    await checkpoint("canvas-created-and-reloaded");

    if (process.env.CANVAS_PREFLIGHT_ONLY === "1") {
      report.preflightOnly = true;
      report.deploymentGap = ["real-image-video-canary-not-run-by-latest-closeout-instruction"];
      addStep("real-image-video-canary", "blocked", {
        reason: "最新收口指令要求没有既有真实成功产物时直接判定不可生产，不再发起模型调用",
        generationSubmissionCount: { image: 0, video: 0 },
      });
      await checkpoint("preflight-only-before-real-generation");
      return;
    }

    await page.locator(`.react-flow__node[data-id="${imageNodeId}"] .workflow-node-head`).click();
    const selectedImageFlow = page.locator(`.react-flow__node[data-id="${imageNodeId}"]`);
    const imageSubmitCountBefore = networkCalls.filter((call) => call.kind === "image").length;
    await selectedImageFlow.getByTitle("生成图片").waitFor({ state: "visible" });
    await armRealCanaryGuard();
    await selectedImageFlow.getByTitle("生成图片").click();
    const imageTerminal = await waitForSavedNode(page, imageNodeId, ["succeeded", "failed"], 360_000);
    await page.waitForTimeout(1_000);
    const imageCalls = networkCalls.filter((call) => call.kind === "image").slice(imageSubmitCountBefore);
    const imageCall = imageCalls.at(-1);
    const imageResponse = imageCall?.response || projectResponse("image", 0, latestImageRaw);
    report.imageCanary = {
      publicModelName: String(imageTerminal.node?.publicModelName || imageResponse.publicModelName || selectedImageModelName),
      publicModelId: String(imageCall?.request.modelId || IMAGE_MODEL_ID),
      taskId: String(imageResponse.taskId || imageTerminal.node?.taskId || ""),
      inputSummary: String(imageCall?.request.inputSummary || promptSummary(IMAGE_PROMPT)),
      resolution: imageResponse.width && imageResponse.height
        ? `${imageResponse.width}x${imageResponse.height}`
        : String(imageCall?.request.resolution || "1K"),
      aspectRatio: String(imageCall?.request.aspectRatio || "16:9"),
      terminalStatus: imageTerminal.node?.status || "missing",
      resultPath: imageTerminal.node?.resultPath || String(imageResponse.resultPath || ""),
      estimatedCost: imageTerminal.node?.estimatedCost,
      actualDeduct: imageTerminal.node?.actualCost ?? safeNumber(imageResponse.cashCharged),
      cashRemaining: safeNumber(imageResponse.cashRemaining),
      statusTransitions: imageTerminal.transitions,
      submissionCount: imageCalls.length,
      requestExactlyOnceFields: {
        clientTraceIdPresent: Boolean(imageCall?.request.clientTraceId),
        clientIdempotencyKeyPresent: imageCall?.request.clientIdempotencyKeyPresent === true,
        strictSingleSubmit: imageCall?.request.strictSingleSubmit === true,
        noRetry: imageCall?.request.noRetry === true,
      },
      timedOut: imageTerminal.timedOut,
      error: imageResponse.error || "",
    };
    const imageExactlyOnce = imageCalls.length === 1
      && Boolean(imageCall?.request.clientTraceId)
      && imageCall?.request.clientIdempotencyKeyPresent === true
      && imageCall?.request.strictSingleSubmit === true
      && imageCall?.request.noRetry === true;
    await page.screenshot({ path: join(SCREENSHOT_DIR, "real-image-terminal.png"), fullPage: true });
    const imageSucceeded = imageTerminal.node?.status === "succeeded" && Boolean(imageTerminal.node.resultPath);
    addStep("real-image-node-canary", imageSucceeded ? "passed" : "failed", report.imageCanary);
    addStep("real-image-exactly-once-submit", imageExactlyOnce ? "passed" : "failed", {
      submissionCount: imageCalls.length,
      requestExactlyOnceFields: asRecord(report.imageCanary).requestExactlyOnceFields,
    });
    await checkpoint("image-canary-terminal");

    let sourcePersistResult: JsonRecord | null = null;
    if (imageSucceeded) {
      try {
        const rawNode = await page.evaluate(({ sessionsKey, activeKey, nodeId }) => {
        const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as JsonRecord[];
        const active = sessions.find((session) => session.id === localStorage.getItem(activeKey));
        return Array.isArray(active?.nodes) ? active.nodes.find((node: JsonRecord) => node.id === nodeId)?.data || null : null;
      }, { sessionsKey: SESSIONS_KEY, activeKey: ACTIVE_SESSION_KEY, nodeId: imageNodeId }) as unknown;
      const rawNodeData = asRecord(rawNode);
      const rawImages = Array.isArray(latestImageRaw.images) ? latestImageRaw.images.map(asRecord) : [];
      const rawImageUrl = String(rawNodeData.outputUrl || rawImages[0]?.url || "");
      assert.ok(rawImageUrl, "真实图片结果 URL 缺失");
      const dataUrl = await fetchMediaAsDataUrl(rawImageUrl, "image/");
      const traceCandidates = [imageResponse.taskId, imageTerminal.node?.taskId, imageCall?.request.clientTraceId].map(String);
      const sourceTraceId = traceCandidates.find((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
      const nodeAlreadyPermanent = Boolean(imageTerminal.node?.assetId && imageTerminal.node.storageKey && imageTerminal.node.historyRecordId);
      if (nodeAlreadyPermanent && !sourceTraceId) throw new Error("PERMANENT_IMAGE_NODE_MISSING_ORIGINAL_UUID_TRACE");
      const persistTraceId = sourceTraceId || randomUUID();
      const persistBody = {
        url: dataUrl,
        clientTraceId: persistTraceId,
        title: `${MARKER} canvas image`,
        modelId: String(imageCall?.request.modelId || IMAGE_MODEL_ID),
        width: safeNumber(imageResponse.width) || undefined,
        height: safeNumber(imageResponse.height) || undefined,
        cashCharged: safeNumber(imageResponse.cashCharged) || 0,
        cashRemaining: safeNumber(imageResponse.cashRemaining),
      };
      const persistOnce = async () => {
        const body = JSON.stringify(persistBody);
        const response = await persistImagePOST(new Request(`${BASE_URL}/api/bridge/image/persist`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secretToken}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        }));
        const result = asRecord(await response.json());
        if (!response.ok) throw new Error(`SOURCE_IMAGE_PERSIST_${response.status}:${sanitizeError(result.error)}`);
        return result;
      };
      const firstPersist = await persistOnce();
      const replayPersist = await persistOnce();
      assert.equal(firstPersist.persisted, true);
      assert.equal(firstPersist.temporary, false);
      assert.equal(replayPersist.idempotentReplay, true);
      assert.equal(replayPersist.assetId, firstPersist.assetId);
      assert.equal(replayPersist.storageKey, firstPersist.storageKey);
      assert.equal(replayPersist.historyRecordId, firstPersist.historyRecordId);
      if (nodeAlreadyPermanent) {
        assert.equal(firstPersist.idempotentReplay, true);
        assert.equal(firstPersist.assetId, imageTerminal.node!.assetId);
        assert.equal(firstPersist.storageKey, imageTerminal.node!.storageKey);
        assert.equal(firstPersist.historyRecordId, imageTerminal.node!.historyRecordId);
      }

      const [assetResult, messageResult, storageKeyRows] = await Promise.all([
        db.from("user_files").select("id,file_category,source,created_at,storage_key,storage_provider").eq("id", String(firstPersist.assetId)).eq("user_id", secretUserId).single(),
        db.from("conversation_messages").select("id,content,created_at").eq("id", String(firstPersist.historyRecordId)).eq("user_id", secretUserId).single(),
        db.from("user_files").select("id").eq("user_id", secretUserId).eq("storage_key", String(firstPersist.storageKey)),
      ]);
      if (assetResult.error || !assetResult.data || messageResult.error || !messageResult.data || storageKeyRows.error) {
        throw new Error("IMAGE_OWNERSHIP_OR_HISTORY_MISSING");
      }
      const gallery = asRecord(JSON.parse(String(messageResult.data.content || "{}")));
      const galleryBilling = asRecord(gallery.billing);
      const galleryImages = Array.isArray(gallery.images) ? gallery.images.map(asRecord) : [];
      const controlledImageContent = await fetch(`${BASE_URL}/api/storage/files/${encodeURIComponent(String(firstPersist.assetId))}/content`, {
        headers: { authorization: `Bearer ${secretToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      const controlledImageBytes = controlledImageContent.ok
        ? Buffer.from(await controlledImageContent.arrayBuffer()).length
        : 0;
      assert.ok(
        controlledImageContent.ok
        && controlledImageBytes > 0
        && String(controlledImageContent.headers.get("content-type") || "").startsWith("image/"),
      );
      sourcePersistResult = {
        persisted: true,
        temporary: false,
        successfulReplayIdempotent: true,
        originalNodeWasPermanent: nodeAlreadyPermanent,
        firstCallWasReplay: firstPersist.idempotentReplay === true,
        assetId: String(assetResult.data.id),
        historyRecordId: String(messageResult.data.id),
        type: String(assetResult.data.file_category || ""),
        source: String(assetResult.data.source || ""),
        createdAt: String(assetResult.data.created_at || messageResult.data.created_at || ""),
        resultPath: publicUrlPath(firstPersist.url),
        storageKeyPath: publicUrlPath(String(firstPersist.storageKey || "")),
        storageProvider: String(assetResult.data.storage_provider || ""),
        ownershipRowsForStorageKey: Array.isArray(storageKeyRows.data) ? storageKeyRows.data.length : 0,
        modelId: String(galleryBilling.modelId || IMAGE_MODEL_ID),
        actualDeduct: safeNumber(galleryBilling.cashCharged),
        dimensions: galleryImages[0]?.width && galleryImages[0]?.height ? `${galleryImages[0].width}x${galleryImages[0].height}` : "",
        controlledContent: {
          httpStatus: controlledImageContent.status,
          bytes: controlledImageBytes,
          contentType: String(controlledImageContent.headers.get("content-type") || ""),
        },
      };
      assert.equal(sourcePersistResult.ownershipRowsForStorageKey, 1);
      report.imagePermanentAsset = sourcePersistResult;
        addStep("image-permanent-asset-history-replay", "passed", sourcePersistResult);
      } catch (error) {
        const detail = sanitizeError(error);
        report.imagePermanentAsset = { status: "failed", error: detail };
        addStep("image-permanent-asset-history-replay", "failed", report.imagePermanentAsset);
      }
    } else {
      addStep("image-permanent-asset-history-replay", "blocked", { reason: "真实生图未成功，未伪造资产落库" });
    }

    try {
      const sourceMusicPath = "/youcai-media/v1/canvas-showcases/paper-fox/10-theme-song.mp3";
      const musicDataUrl = await fetchMediaAsDataUrl(`${BASE_URL}${sourceMusicPath}`, "audio/");
      const musicTraceId = randomUUID();
      const musicPersistBody = {
        url: musicDataUrl,
        clientTraceId: musicTraceId,
        mediaKind: "music",
        title: `${MARKER} music semantic canary`,
      };
      const persistMusic = async () => {
        const body = JSON.stringify(musicPersistBody);
        const response = await persistImagePOST(new Request(`${BASE_URL}/api/bridge/image/persist`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secretToken}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        }));
        const result = asRecord(await response.json());
        if (!response.ok) throw new Error(`SOURCE_MUSIC_PERSIST_${response.status}:${sanitizeError(result.error)}`);
        return result;
      };
      const firstMusicPersist = await persistMusic();
      const replayMusicPersist = await persistMusic();
      assert.equal(firstMusicPersist.persisted, true);
      assert.equal(firstMusicPersist.temporary, false);
      assert.equal(firstMusicPersist.mediaKind, "music");
      assert.equal(replayMusicPersist.idempotentReplay, true);
      assert.equal(replayMusicPersist.assetId, firstMusicPersist.assetId);
      assert.equal(replayMusicPersist.storageKey, firstMusicPersist.storageKey);
      assert.equal(replayMusicPersist.historyRecordId, firstMusicPersist.historyRecordId);
      const [musicAsset, musicMessage] = await Promise.all([
        db.from("user_files").select("id,file_category,source,created_at,storage_key,storage_provider,content_type").eq("id", String(firstMusicPersist.assetId)).eq("user_id", secretUserId).single(),
        db.from("conversation_messages").select("id,content,created_at").eq("id", String(firstMusicPersist.historyRecordId)).eq("user_id", secretUserId).single(),
      ]);
      if (musicAsset.error || !musicAsset.data || musicMessage.error || !musicMessage.data) throw new Error("MUSIC_OWNERSHIP_OR_HISTORY_MISSING");
      const musicHistory = asRecord(JSON.parse(String(musicMessage.data.content || "{}")));
      const controlledContent = await fetch(`${BASE_URL}/api/storage/files/${encodeURIComponent(String(firstMusicPersist.assetId))}/content`, {
        headers: { authorization: `Bearer ${secretToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      const controlledBytes = controlledContent.ok ? Buffer.from(await controlledContent.arrayBuffer()).length : 0;
      assert.equal(String(musicAsset.data.file_category), "audio");
      assert.equal(String(musicHistory.type), "audio_gallery");
      assert.equal(String(musicHistory.mediaKind), "music");
      assert.ok(controlledContent.ok && controlledBytes > 0 && String(controlledContent.headers.get("content-type") || "").startsWith("audio/"));
      report.musicPermanentAsset = {
        publicModelName: "not-applicable-uploaded-local-showcase-music",
        publicModelId: "not-applicable",
        taskId: musicTraceId,
        inputSummary: `${MARKER} local showcase music upload`,
        terminalStatus: "succeeded",
        resultPath: publicUrlPath(firstMusicPersist.url),
        assetId: String(musicAsset.data.id),
        storageKeyPath: publicUrlPath(String(musicAsset.data.storage_key || "")),
        storageProvider: String(musicAsset.data.storage_provider || ""),
        historyRecordId: String(musicMessage.data.id),
        type: String(musicAsset.data.file_category || ""),
        source: String(musicAsset.data.source || ""),
        createdAt: String(musicAsset.data.created_at || musicMessage.data.created_at || ""),
        actualDeduct: 0,
        successfulReplayIdempotent: true,
        controlledContent: { httpStatus: controlledContent.status, bytes: controlledBytes, contentType: String(controlledContent.headers.get("content-type") || "") },
      };
      addStep("music-permanent-asset-and-controlled-playback", "passed", report.musicPermanentAsset);
    } catch (error) {
      report.musicPermanentAsset = { terminalStatus: "failed", error: sanitizeError(error) };
      addStep("music-permanent-asset-and-controlled-playback", "failed", report.musicPermanentAsset);
    }

    let videoTerminal: Awaited<ReturnType<typeof waitForSavedNode>> | null = null;
    if (imageSucceeded) {
      await page.locator(`.react-flow__node[data-id="${videoNodeId}"] .workflow-node-head`).click();
      const selectedVideoFlow = page.locator(`.react-flow__node[data-id="${videoNodeId}"]`);
      const videoSubmitCountBefore = networkCalls.filter((call) => call.kind === "video").length;
      await selectedVideoFlow.getByTitle("生成视频").click();
      videoTerminal = await waitForSavedNode(page, videoNodeId, ["succeeded", "failed"], 480_000);
      await page.waitForTimeout(1_000);
      const videoCalls = networkCalls.filter((call) => call.kind === "video").slice(videoSubmitCountBefore);
      const videoCall = videoCalls.at(-1);
      const videoResponse = videoCall?.response || projectResponse("video", 0, latestVideoRaw);
      report.videoCanary = {
        publicModelName: String(videoTerminal.node?.publicModelName || videoResponse.publicModelName || selectedVideoModelName),
        publicModelId: String(videoCall?.request.modelId || VIDEO_MODEL_ID),
        taskId: String(videoTerminal.node?.taskId || videoResponse.taskId || ""),
        inputSummary: String(videoCall?.request.inputSummary || promptSummary(VIDEO_PROMPT)),
        durationSeconds: safeNumber(videoCall?.request.durationSeconds) || 1,
        resolution: String(videoCall?.request.resolution || ""),
        aspectRatio: String(videoCall?.request.aspectRatio || "16:9"),
        terminalStatus: videoTerminal.node?.status || "missing",
        resultPath: videoTerminal.node?.resultPath || String(videoResponse.resultPath || ""),
        estimatedCost: videoTerminal.node?.estimatedCost,
        actualDeduct: videoTerminal.node?.actualCost ?? safeNumber(videoResponse.cashCharged),
        billingReferenceId: videoTerminal.node?.billingReferenceId || "",
        statusTransitions: videoTerminal.transitions,
        submissionCount: videoCalls.length,
        clientRequestId: String(videoCall?.request.clientRequestId || ""),
        usedGeneratedImagePath: String(videoCall?.request.imagePath || ""),
        timedOut: videoTerminal.timedOut,
        error: videoResponse.error || "",
      };
      await page.screenshot({ path: join(SCREENSHOT_DIR, "real-video-terminal.png"), fullPage: true });
      const videoSucceeded = videoTerminal.node?.status === "succeeded" && Boolean(videoTerminal.node.resultPath);
      addStep("real-generated-image-to-video-canary", videoSucceeded ? "passed" : "failed", report.videoCanary);
      const videoExactlyOnce = videoCalls.length === 1 && Boolean(videoCall?.request.clientRequestId);
      addStep("real-video-exactly-once-submit", videoExactlyOnce ? "passed" : "failed", {
        submissionCount: videoCalls.length,
        clientRequestIdPresent: Boolean(videoCall?.request.clientRequestId),
      });
      await checkpoint("video-canary-terminal");
    } else {
      report.videoCanary = { terminalStatus: "blocked", reason: "上游真实图片未成功，未伪造图生视频输入" };
      addStep("real-generated-image-to-video-canary", "blocked", report.videoCanary);
    }

    const videoTaskQuery = await db
      .from("video_tasks")
      .select("id,model_id,task_id_external,task_label,prompt,first_frame_url,aspect_ratio,resolution,duration_seconds,status,error_message,price_charged,created_at,completed_at,content_url,video_url,storage_url")
      .eq("user_id", secretUserId)
      .eq("prompt", VIDEO_PROMPT)
      .gte("created_at", String(report.startedAt))
      .order("created_at", { ascending: false });
    if (videoTaskQuery.error) {
      addStep("video-task-database-reconciliation", "failed", { error: sanitizeError(videoTaskQuery.error.message) });
    } else {
      const videoCanaryRecord = asRecord(report.videoCanary);
      const videoRows = (videoTaskQuery.data || []).map((row: JsonRecord) => ({
        historyRecordId: String(row.id || ""),
        internalModelRecordPresent: Boolean(row.model_id),
        publicModelId: String(videoCanaryRecord.publicModelId || VIDEO_MODEL_ID),
        publicModelName: String(videoCanaryRecord.publicModelName || selectedVideoModelName),
        taskId: String(row.task_id_external || ""),
        taskLabel: String(row.task_label || ""),
        inputSummary: promptSummary(row.prompt),
        usedGeneratedImagePath: publicUrlPath(row.first_frame_url),
        aspectRatio: String(row.aspect_ratio || ""),
        resolution: String(row.resolution || ""),
        durationSeconds: safeNumber(row.duration_seconds),
        status: String(row.status || ""),
        error: row.error_message ? sanitizeError(row.error_message) : "",
        actualDeduct: safeNumber(row.price_charged),
        resultPath: publicUrlPath(row.storage_url || row.video_url || row.content_url),
        createdAt: String(row.created_at || ""),
        completedAt: String(row.completed_at || ""),
      }));
      report.videoTaskRows = videoRows;
      const terminalVideo = asRecord(report.videoCanary);
      const shouldHaveTask = String(terminalVideo.taskId || "").length > 0 || networkCalls.some((call) => call.kind === "video");
      const unique = !shouldHaveTask || videoRows.length === 1;
      addStep("video-task-database-reconciliation", unique ? "passed" : "failed", { matchingRows: videoRows.length, uniquePromptTask: unique, rows: videoRows });
      const completedVideoRow = videoRows.find((row: JsonRecord) => row.status === "completed" && row.historyRecordId);
      if (completedVideoRow) {
        const controlledPath = `/api/video/storage/${encodeURIComponent(String(completedVideoRow.historyRecordId))}`;
        const controlledResponse = await fetch(`${BASE_URL}${controlledPath}`, {
          headers: { authorization: `Bearer ${secretToken}`, range: "bytes=0-1023" },
          signal: AbortSignal.timeout(30_000),
        });
        const controlledBytes = controlledResponse.ok ? Buffer.from(await controlledResponse.arrayBuffer()).length : 0;
        report.videoControlledContent = {
          path: controlledPath,
          httpStatus: controlledResponse.status,
          contentType: String(controlledResponse.headers.get("content-type") || ""),
          bytes: controlledBytes,
        };
        const contentPassed = controlledResponse.ok
          && controlledBytes > 0
          && String(controlledResponse.headers.get("content-type") || "").startsWith("video/");
        addStep("video-controlled-result-access", contentPassed ? "passed" : "failed", report.videoControlledContent);
      } else {
        addStep("video-controlled-result-access", "blocked", { reason: "视频未完成，无法验证受控成片读取" });
      }
    }

    const generationCountsBeforeReplay = {
      image: networkCalls.filter((call) => call.kind === "image").length,
      video: networkCalls.filter((call) => call.kind === "video").length,
    };
    let replayEvidence: JsonRecord = { attempted: false };
    if (imageTerminal.node?.status === "succeeded") {
      await page.getByLabel("打开制作面板").click();
      const imageBatch = page.locator(".free-production-progress button").filter({ hasText: "批量生图" });
      await imageBatch.click();
      await page.waitForTimeout(3_000);
      if (videoTerminal?.node?.status === "succeeded") {
        const videoBatch = page.locator(".free-production-progress button").filter({ hasText: "批量视频" });
        if (await videoBatch.isEnabled()) {
          await videoBatch.click();
          await page.waitForTimeout(3_000);
        }
      } else if (videoTerminal?.node?.status === "failed" && videoTerminal.node.taskId) {
        const continueOriginal = page.getByTitle("继续查询原任务，不会重复提交或扣费");
        if (await continueOriginal.count()) {
          await continueOriginal.click();
          await page.waitForTimeout(3_000);
        }
      }
      const generationCountsAfterReplay = {
        image: networkCalls.filter((call) => call.kind === "image").length,
        video: networkCalls.filter((call) => call.kind === "video").length,
      };
      replayEvidence = {
        attempted: true,
        before: generationCountsBeforeReplay,
        after: generationCountsAfterReplay,
        newImageSubmissions: generationCountsAfterReplay.image - generationCountsBeforeReplay.image,
        newVideoSubmissions: generationCountsAfterReplay.video - generationCountsBeforeReplay.video,
      };
      const noDuplicate = replayEvidence.newImageSubmissions === 0 && replayEvidence.newVideoSubmissions === 0;
      addStep("batch-replay-no-duplicate-submit", noDuplicate ? "passed" : "failed", replayEvidence);
      await page.getByLabel("关闭制作面板").click();
    } else {
      addStep("batch-replay-no-duplicate-submit", "blocked", { reason: "真实图片没有完成，未执行可能产生重复费用的批量动作" });
    }
    report.batchReplay = replayEvidence;

    let freshAudioMusicLive = false;
    let freshMusicNodeId = "";
    const audioTool = page.getByTitle("添加音频节点");
    const musicTool = page.getByTitle("添加音乐节点");
    const freshControlsAvailable = await audioTool.count() === 1 && await musicTool.count() === 1;
    if (freshControlsAvailable) {
      try {
        await audioTool.click();
        const audioFlow = await selectedFlowNode(page);
        const audioNodeId = String(await audioFlow.getAttribute("data-id"));
        await musicTool.click();
        const musicFlow = await selectedFlowNode(page);
        freshMusicNodeId = String(await musicFlow.getAttribute("data-id"));
        const musicResponse = await fetch(`${BASE_URL}/youcai-media/v1/canvas-showcases/paper-fox/10-theme-song.mp3`, { signal: AbortSignal.timeout(30_000) });
        if (!musicResponse.ok) throw new Error(`SHOWCASE_MUSIC_DOWNLOAD_${musicResponse.status}`);
        const musicBuffer = Buffer.from(await musicResponse.arrayBuffer());
        await musicFlow.locator('input[type="file"]').setInputFiles({ name: "canvas-music-semantic.mp3", mimeType: "audio/mpeg", buffer: musicBuffer });
        const uploadedMusic = await waitForSavedNode(page, freshMusicNodeId, ["succeeded", "failed"], 90_000);
        const musicHealth = uploadedMusic.node?.status === "succeeded"
          ? await inspectLoadedMedia(page.locator(`.react-flow__node[data-id="${freshMusicNodeId}"] audio`))
          : [];
        const edgesBeforeMusic = await page.locator(".react-flow__edge").count();
        await connectNodes(page, freshMusicNodeId, videoNodeId);
        await page.waitForFunction((count) => document.querySelectorAll(".react-flow__edge").length === count + 1, edgesBeforeMusic);
        await page.waitForTimeout(800);
        const audioMusicSession = await readActiveSession(page);
        const audioNode = audioMusicSession?.nodes.find((node) => node.id === audioNodeId) || null;
        const musicNode = audioMusicSession?.nodes.find((node) => node.id === freshMusicNodeId) || null;
        freshAudioMusicLive = Boolean(
          audioNode?.kind === "upload"
          && audioNode.sourceMediaKind === "audio"
          && musicNode?.kind === "upload"
          && musicNode.sourceMediaKind === "music"
          && musicNode.status === "succeeded"
          && musicNode.resultPath
          && musicNode.assetId
          && musicNode.storageKey
          && musicNode.historyRecordId
          && musicHealth.length === 1
          && Number(musicHealth[0]?.readyState || 0) >= 1
          && musicHealth[0]?.errorCode === 0
          && audioMusicSession?.edges.some((edge) => edge.source === freshMusicNodeId && edge.target === videoNodeId)
        );
        report.freshAudioMusicNodes = {
          controlsAvailable: true,
          audioSemantic: audioNode?.sourceMediaKind || "",
          musicSemantic: musicNode?.sourceMediaKind || "",
          musicAssetId: musicNode?.assetId || "",
          musicStorageKeyPath: publicUrlPath(musicNode?.storageKey || ""),
          musicHistoryRecordId: musicNode?.historyRecordId || "",
          connectedToVideo: audioMusicSession?.edges.some((edge) => edge.source === freshMusicNodeId && edge.target === videoNodeId) === true,
          playerHealth: musicHealth,
        };
        addStep("fresh-audio-music-node-semantics", freshAudioMusicLive ? "passed" : "failed", report.freshAudioMusicNodes);
      } catch (error) {
        report.freshAudioMusicNodes = { controlsAvailable: true, status: "failed", error: sanitizeError(error) };
        addStep("fresh-audio-music-node-semantics", "failed", report.freshAudioMusicNodes);
      }
    } else {
      report.freshAudioMusicNodes = { controlsAvailable: false, reason: "当前 5000 bundle 尚未部署音频/音乐节点按钮" };
      addStep("fresh-audio-music-node-semantics", "blocked", report.freshAudioMusicNodes);
    }

    const downloads: unknown[] = [];
    const downloadCanvasAsset = async (nodeId: string, fileName: string) => {
      const sessionProjection = await readActiveSession(page);
      const title = sessionProjection?.nodes.find((node) => node.id === nodeId)?.title || "";
      if (!title) throw new Error(`DOWNLOAD_NODE_MISSING_${nodeId}`);
      const nodeLocator = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
      await nodeLocator.locator(".workflow-node-head").click();
      const button = nodeLocator.getByLabel(`下载${title}`);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 45_000 }),
        button.click(),
      ]);
      return saveDownload(download, fileName);
    };
    if (imageTerminal.node?.status === "succeeded") {
      try {
        const item = await downloadCanvasAsset(imageNodeId, "canvas-canary-image.png");
        downloads.push({ type: "image", status: "passed", ...item });
      } catch (error) {
        downloads.push({ type: "image", status: "failed", error: sanitizeError(error) });
      }
    }
    if (videoTerminal?.node?.status === "succeeded") {
      try {
        const item = await downloadCanvasAsset(videoNodeId, "canvas-canary-video.mp4");
        downloads.push({ type: "video", status: "passed", ...item });
      } catch (error) {
        downloads.push({ type: "video", status: "failed", error: sanitizeError(error) });
      }
    }
    if (freshAudioMusicLive && freshMusicNodeId) {
      try {
        const musicNode = page.locator(`.react-flow__node[data-id="${freshMusicNodeId}"]`);
        await musicNode.locator(".workflow-node-head").click();
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 45_000 }),
          musicNode.getByRole("button", { name: "下载素材" }).click(),
        ]);
        downloads.push({ type: "music", status: "passed", ...(await saveDownload(download, "canvas-canary-music.mp3")) });
      } catch (error) {
        downloads.push({ type: "music", status: "failed", error: sanitizeError(error) });
      }
    }
    report.downloads = downloads;
    addStep("generated-material-download", downloads.length > 0 && downloads.every((item) => asRecord(item).status === "passed") ? "passed" : "failed", downloads);

    const beforeDuplicate = await readActiveSession(page);
    if (!beforeDuplicate) throw new Error("DUPLICATE_SOURCE_SESSION_MISSING");
    const nodesBeforeDuplicate = beforeDuplicate.nodes.length;
    const edgesBeforeDuplicate = beforeDuplicate.edges.length;
    let expectedNodesAfterDuplicate = nodesBeforeDuplicate;
    if (imageSucceeded) {
      const sourceGeneratedImage = beforeDuplicate.nodes.find((node) => node.id === imageNodeId) || null;
      const idsBeforeDuplicate = new Set(beforeDuplicate.nodes.map((node) => node.id));
      await page.locator(`.react-flow__node[data-id="${imageNodeId}"] .workflow-node-head`).click();
      await page.getByLabel("打开制作面板").click();
      await page.getByRole("button", { name: "复制节点", exact: true }).click();
      await page.waitForTimeout(800);
      const afterDuplicate = await readActiveSession(page);
      if (!afterDuplicate) throw new Error("DUPLICATE_RESULT_SESSION_MISSING");
      const clonedImage = afterDuplicate.nodes.find((node) => !idsBeforeDuplicate.has(node.id)) || null;
      const cloneRuntimeCleared = Boolean(
        sourceGeneratedImage?.status === "succeeded"
        && sourceGeneratedImage.resultPath
        && clonedImage
        && clonedImage.kind === "image"
        && clonedImage.status === "idle"
        && !clonedImage.resultPath
        && !clonedImage.taskId
        && !clonedImage.publicModelName
        && clonedImage.actualCost === null
        && !clonedImage.billingReferenceId
        && !clonedImage.assetId
        && !clonedImage.storageKey
        && !clonedImage.historyRecordId
        && !clonedImage.completedAt
        && clonedImage.historyCount === 0
      );
      expectedNodesAfterDuplicate = nodesBeforeDuplicate + 1;
      assert.equal(afterDuplicate.nodes.length, expectedNodesAfterDuplicate);
      assert.equal(afterDuplicate.edges.length, edgesBeforeDuplicate);
      report.nodeDuplicate = {
        sourceKind: sourceGeneratedImage?.kind || "",
        sourceHadGeneratedResult: Boolean(sourceGeneratedImage?.resultPath),
        clonedKind: clonedImage?.kind || "",
        cloneRuntimeCleared,
        nodesBefore: nodesBeforeDuplicate,
        nodesAfter: afterDuplicate.nodes.length,
        edgesBefore: edgesBeforeDuplicate,
        edgesAfter: afterDuplicate.edges.length,
      };
      addStep("duplicate-generated-media-clears-runtime-state", cloneRuntimeCleared ? "passed" : "failed", report.nodeDuplicate);
      await page.getByLabel("关闭制作面板").click();
    } else {
      report.nodeDuplicate = { status: "blocked", reason: "真实生图未成功，未用空节点冒充生成媒体复制验收" };
      addStep("duplicate-generated-media-clears-runtime-state", "blocked", report.nodeDuplicate);
    }

    const imageBeforeReload = (await readActiveSession(page))?.nodes.find((node) => node.id === imageNodeId) || null;
    const videoBeforeReload = (await readActiveSession(page))?.nodes.find((node) => node.id === videoNodeId) || null;
    const imageBeforeDurable = durableNodeProjection(imageBeforeReload);
    const videoBeforeDurable = durableNodeProjection(videoBeforeReload);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(({ sessionsKey, activeKey, marker, expectedNodes }) => {
      const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as JsonRecord[];
      const active = sessions.find((session) => session.id === localStorage.getItem(activeKey));
      return String(active?.name || "").includes(marker) && Array.isArray(active?.nodes) && active.nodes.length >= expectedNodes;
    }, { sessionsKey: SESSIONS_KEY, activeKey: ACTIVE_SESSION_KEY, marker: MARKER, expectedNodes: expectedNodesAfterDuplicate }, { timeout: 30_000 });
    const finalSession = await readActiveSession(page);
    const imageAfterReload = finalSession?.nodes.find((node) => node.id === imageNodeId) || null;
    const videoAfterReload = finalSession?.nodes.find((node) => node.id === videoNodeId) || null;
    const imageAfterDurable = durableNodeProjection(imageAfterReload);
    const videoAfterDurable = durableNodeProjection(videoAfterReload);
    const imageStable = JSON.stringify(imageBeforeDurable) === JSON.stringify(imageAfterDurable);
    const videoStable = JSON.stringify(videoBeforeDurable) === JSON.stringify(videoAfterDurable);
    report.refreshRecovery = {
      canvasNameRestored: finalSession?.name.includes(MARKER) === true,
      nodeCount: finalSession?.nodes.length || 0,
      edgeCount: finalSession?.edges.length || 0,
      image: imageAfterReload,
      video: videoAfterReload,
      imageBefore: imageBeforeDurable,
      imageAfter: imageAfterDurable,
      videoBefore: videoBeforeDurable,
      videoAfter: videoAfterDurable,
      imageStable,
      videoStable,
    };
    const refreshPassed = Boolean(finalSession?.name.includes(MARKER))
      && finalSession!.nodes.length === expectedNodesAfterDuplicate
      && finalSession!.edges.length === edgesBeforeDuplicate
      && imageStable
      && videoStable
      && Boolean(imageAfterReload?.resultPath)
      && (videoBeforeReload?.status !== "succeeded" || Boolean(videoAfterReload?.resultPath));
    addStep("post-generation-refresh-field-recovery", refreshPassed ? "passed" : "failed", report.refreshRecovery);
    await page.screenshot({ path: join(SCREENSHOT_DIR, "canvas-after-reload.png"), fullPage: true });

    const videoRows = Array.isArray(report.videoTaskRows) ? report.videoTaskRows.map(asRecord) : [];
    const billingReferences = new Set<string>();
    for (const row of videoRows) {
      if (row.historyRecordId) billingReferences.add(`video:${String(row.historyRecordId)}`);
      if (row.taskId) billingReferences.add(`video:${String(row.taskId)}`);
    }
    if (imageAfterReload?.billingReferenceId) billingReferences.add(imageAfterReload.billingReferenceId);
    const transactionsResult = await db
      .from("cash_transactions")
      .select("id,type,amount,balance_after,description,reference_id,created_at")
      .eq("user_id", secretUserId)
      .gte("created_at", String(report.startedAt))
      .order("created_at", { ascending: true });
    if (transactionsResult.error) {
      addStep("cash-transaction-reconciliation", "failed", { error: sanitizeError(transactionsResult.error.message) });
    } else {
      const relatedTransactions = (transactionsResult.data || [])
        .filter((row: JsonRecord) => billingReferences.has(String(row.reference_id || "")))
        .map((row: JsonRecord) => ({
          transactionId: String(row.id || ""),
          type: String(row.type || ""),
          amount: safeNumber(row.amount),
          balanceAfter: safeNumber(row.balance_after),
          referenceId: String(row.reference_id || ""),
          createdAt: String(row.created_at || ""),
        }));
      const consumeCount = relatedTransactions.filter((row: JsonRecord) => row.type === "consume").length;
      const refundCount = relatedTransactions.filter((row: JsonRecord) => /refund|退款/iu.test(String(row.type || ""))).length;
      report.billingTransactions = { references: [...billingReferences], rows: relatedTransactions, consumeCount, refundCount };
      addStep("cash-transaction-reconciliation", consumeCount <= 1 ? "passed" : "failed", report.billingTransactions);
    }

    const revenueTaskIds = [
      String(asRecord(report.imageCanary).taskId || ""),
      ...videoRows.map((row) => String(row.taskId || "")),
    ].filter(Boolean);
    if (revenueTaskIds.length > 0) {
      const revenueResult = await db
        .from("revenue_records")
        .select("id,task_id,model_id,cost_price,selling_price,is_admin,record_type,credits_charged,cash_charged,created_at")
        .eq("user_id", secretUserId)
        .in("task_id", revenueTaskIds)
        .gte("created_at", String(report.startedAt));
      if (revenueResult.error) {
        addStep("recorded-cost-reconciliation", "failed", { error: sanitizeError(revenueResult.error.message) });
      } else {
        const revenueRows = (revenueResult.data || []).map((row: JsonRecord) => ({
          recordId: String(row.id || ""),
          taskId: String(row.task_id || ""),
          publicModelId: String(row.record_type) === "image" ? IMAGE_MODEL_ID : VIDEO_MODEL_ID,
          internalModelMatchesKnownPublicId: [IMAGE_MODEL_ID, VIDEO_MODEL_ID].includes(String(row.model_id || "")),
          recordType: String(row.record_type || ""),
          recordedCostPrice: safeNumber(row.cost_price),
          sellingPrice: safeNumber(row.selling_price),
          isAdmin: row.is_admin === true,
          creditsCharged: safeNumber(row.credits_charged),
          cashCharged: safeNumber(row.cash_charged),
          createdAt: String(row.created_at || ""),
        }));
        report.recordedCosts = {
          rows: revenueRows,
          recordedCostPriceTotal: revenueRows.reduce((sum: number, row: { recordedCostPrice: number | null }) => sum + (row.recordedCostPrice || 0), 0),
          providerSettlementCost: "unknown-not-exposed-by-this-chain",
        };
        addStep("recorded-cost-reconciliation", "passed", report.recordedCosts);
      }
    } else {
      addStep("recorded-cost-reconciliation", "blocked", { reason: "没有真实任务 ID 可用于成本记录核对" });
    }

    const mediaHistoryResponse = await fetch(`${BASE_URL}/api/media-history?page=1&pageSize=100`, {
      headers: { authorization: `Bearer ${secretToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    const mediaHistoryBody = asRecord(await mediaHistoryResponse.json().catch(() => ({})));
    const mediaItemsCandidate = Array.isArray(mediaHistoryBody.items)
      ? mediaHistoryBody.items
      : Array.isArray(mediaHistoryBody.data)
        ? mediaHistoryBody.data
        : [];
    const mediaItems = mediaItemsCandidate.map(asRecord);
    const persistedHistoryId = String(sourcePersistResult?.historyRecordId || "");
    const videoInternalIds = new Set(videoRows.map((row) => String(row.historyRecordId || "")));
    const matchingHistory = mediaItems.filter((item) => {
      const id = String(item.id || "");
      return (persistedHistoryId && id === `image:${persistedHistoryId}:0`)
        || [...videoInternalIds].some((videoId) => id === `video:${videoId}`);
    }).map((item) => ({
      id: String(item.id || ""),
      type: String(item.kind || ""),
      status: String(item.status || ""),
      publicModelName: String(item.publicModelName || ""),
      publicModelId: String(item.kind) === "image" ? IMAGE_MODEL_ID : VIDEO_MODEL_ID,
      resultPath: publicUrlPath(item.previewPath),
      downloadPath: publicUrlPath(item.downloadPath),
      source: String(item.source || ""),
      cost: safeNumber(item.cost),
      createdAt: String(item.createdAt || item.created_at || ""),
    }));
    report.mediaHistory = { httpStatus: mediaHistoryResponse.status, matchingItems: matchingHistory };
    const imageHistoryRecovered = !persistedHistoryId || matchingHistory.some((item) => item.type === "image" && String(item.id).startsWith("image:") && Boolean(item.resultPath) && Boolean(item.downloadPath));
    const videoHistoryRecovered = videoInternalIds.size === 0 || matchingHistory.some((item) => item.type === "video" && String(item.id).startsWith("video:") && Boolean(item.resultPath) && Boolean(item.downloadPath));
    addStep("personal-media-history", mediaHistoryResponse.ok && imageHistoryRecovered && videoHistoryRecovered ? "passed" : "failed", report.mediaHistory);

    const endBalances = await readBalances();
    report.endBalances = endBalances;
    report.actualBilling = {
      creditsDelta: Number((endBalances.credits - startBalances.credits).toFixed(6)),
      cashDelta: Number((endBalances.cash - startBalances.cash).toFixed(6)),
      actualUserCreditsCharged: Number((startBalances.credits - endBalances.credits).toFixed(6)),
      actualUserCashCharged: Number((startBalances.cash - endBalances.cash).toFixed(6)),
      providerSettlementCost: "unknown-not-exposed-by-this-chain",
      adminExpectedPlatformDeduct: 0,
    };
    const adminPlatformDeductIsZero = asRecord(report.actualBilling).actualUserCreditsCharged === 0
      && asRecord(report.actualBilling).actualUserCashCharged === 0;
    addStep("ending-balance-and-actual-deduct", adminPlatformDeductIsZero ? "passed" : "failed", report.actualBilling);

    const sourceFiles = [
      "src/components/manual-canvas.tsx",
      "src/components/free-canvas-shell.tsx",
      "src/lib/workflow-schema.ts",
      "src/lib/studio-canvas-types.ts",
      "src/app/api/bridge/image/persist/route.ts",
      "src/app/youcai/free-canvas/page.tsx",
      "src/app/youcai/tools/canvas/workspace/new/page.tsx",
      "src/app/youcai/tools/canvas/workspace/[showcaseId]/page.tsx",
      "src/app/youcai/tools/canvas/workspace/inspiration/[itemId]/page.tsx",
      "src/features/official-core-routes/official-canvas-route.tsx",
      "src/features/official-inspiration/canvas-share-showcase.tsx",
      "src/features/official-inspiration/official-inspiration-gallery.tsx",
      "scripts/verify-canvas-production-fixes.ts",
      "scripts/run-canvas-production-readiness.ts",
    ];
    const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => {
      const content = await readFile(resolve(file));
      return [file, createHash("sha256").update(content).digest("hex")];
    })));
    const buildId = await readFile(resolve(".next", "BUILD_ID"), "utf8").then((value) => value.trim()).catch(() => "unavailable");
    const showcaseRecords = Array.isArray(report.showcases) ? report.showcases.map(asRecord) : [];
    const audioPlayers = showcaseRecords.reduce((sum, item) => sum + safeNumber(asRecord(item.copy).audioPlayers)!, 0);
    const copiedAudioKinds = showcaseRecords.reduce((sum, item) => sum + (safeNumber(asRecord(item.copy).audioMusicSemanticCount) || 0), 0);
    const imageNetwork = networkCalls.filter((call) => call.kind === "image");
    const videoNetwork = networkCalls.filter((call) => call.kind === "video");
    const liveCapabilities = {
      audioMusicSemantic: copiedAudioKinds === SHOWCASES.reduce((sum, item) => sum + item.audios, 0) && audioPlayers === copiedAudioKinds,
      freshAudioMusicNodeControls: freshAudioMusicLive,
      permanentImageNode: Boolean(imageAfterReload?.assetId && imageAfterReload.storageKey && imageAfterReload.historyRecordId),
      imageExactlyOnceRequest: imageNetwork.length === 1 && imageNetwork[0]?.request.clientIdempotencyKeyPresent === true && imageNetwork[0]?.request.strictSingleSubmit === true && imageNetwork[0]?.request.noRetry === true,
      videoClientRequestId: videoNetwork.length === 1 && Boolean(videoNetwork[0]?.request.clientRequestId),
      videoNoDuplicateOnCompletedBatch: asRecord(report.batchReplay).newVideoSubmissions === 0,
      taskBillingAssetFieldsAfterReload: Boolean(
        imageAfterReload?.taskId
        && imageAfterReload.modelId
        && imageAfterReload.publicModelName
        && imageAfterReload.actualCost !== null
        && imageAfterReload.billingReferenceId
        && imageAfterReload.assetId
        && imageAfterReload.storageKey
        && imageAfterReload.historyRecordId
        && (!videoAfterReload || videoAfterReload.status !== "succeeded" || (
          videoAfterReload.taskId
          && videoAfterReload.modelId
          && videoAfterReload.publicModelName
          && videoAfterReload.billingReferenceId
          && videoAfterReload.actualCost !== null
        )),
      ),
    };
    report.source = {
      fileHashesSha256: sourceHashes,
      directPersistHandler: sourcePersistResult ? "passed" : imageSucceeded ? "failed" : "blocked",
      staticVerifier: "run-separately",
    };
    report.live5000 = {
      runtime: "next start -p 5000",
      buildId,
      capabilities: liveCapabilities,
      network: networkCalls,
    };
    report.audioMusic = {
      showcasedAndCopiedSemanticCount: copiedAudioKinds,
      renderedAudioPlayers: audioPlayers,
      expectedCount: SHOWCASES.reduce((sum, item) => sum + item.audios, 0),
      connectionsVerifiedPerShowcase: showcaseRecords.map((item) => ({ id: item.id, connectedEdges: asRecord(item.copy).audioMusicConnectedEdgeCount || 0 })),
      permanentUpload: report.musicPermanentAsset || null,
      freshCanvasNodes: report.freshAudioMusicNodes || null,
    };
    const deploymentGap = Object.entries(liveCapabilities).filter(([, passed]) => !passed).map(([capability]) => capability);
    report.deploymentGap = deploymentGap;
    report.current5000DoesNotProvePatchedSource = deploymentGap.length > 0;
  } catch (error) {
    const detail = sanitizeError(error);
    report.unhandledFailure = detail;
    addStep("production-readiness-harness", "failed", { error: detail });
  } finally {
    report.network = networkCalls;
    if (!report.endBalances) {
      try {
        const endBalances = await readBalances();
        report.endBalances = endBalances;
        report.actualBilling = {
          creditsDelta: Number((endBalances.credits - startBalances.credits).toFixed(6)),
          cashDelta: Number((endBalances.cash - startBalances.cash).toFixed(6)),
          actualUserCreditsCharged: Number((startBalances.credits - endBalances.credits).toFixed(6)),
          actualUserCashCharged: Number((startBalances.cash - endBalances.cash).toFixed(6)),
          providerSettlementCost: "unknown-not-exposed-by-this-chain",
        };
      } catch (error) {
        report.balanceReadFailure = sanitizeError(error);
      }
    }
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    report.endedAt = new Date().toISOString();
    const steps = (report.steps as JsonRecord[]) || [];
    const failed = steps.filter((step) => step.status === "failed").map((step) => step.name);
    const blocked = steps.filter((step) => step.status === "blocked").map((step) => step.name);
    const imageCompleted = asRecord(report.imageCanary).terminalStatus === "succeeded";
    const videoCompleted = asRecord(report.videoCanary).terminalStatus === "succeeded";
    const deploymentGap = Array.isArray(report.deploymentGap) ? report.deploymentGap : ["live-runtime-capability-audit-incomplete"];
    report.summary = {
      passedSteps: steps.filter((step) => step.status === "passed").length,
      failedSteps: failed,
      blockedSteps: blocked,
      realImageCompleted: imageCompleted,
      realVideoCompleted: videoCompleted,
      realGeneratedAssetCount: Number(imageCompleted) + Number(videoCompleted),
      actualUserCashCharged: asRecord(report.actualBilling).actualUserCashCharged ?? null,
      actualUserCreditsCharged: asRecord(report.actualBilling).actualUserCreditsCharged ?? null,
      sourceFixesApplied: true,
      currentLiveDeploymentGap: deploymentGap,
      productionReady: failed.length === 0 && blocked.length === 0 && imageCompleted && videoCompleted && deploymentGap.length === 0,
    };
    await writeEvidenceJson("canvas-production-readiness.json", report);
  }
}

void main().catch(async (error) => {
  const imageCompleted = asRecord(report.imageCanary).terminalStatus === "succeeded";
  const videoCompleted = asRecord(report.videoCanary).terminalStatus === "succeeded";
  const recordedNetwork = Array.isArray(report.network) ? report.network.map(asRecord) : [];
  const fallback = {
    schemaVersion: 1,
    marker: MARKER,
    startedAt: report.startedAt,
    endedAt: new Date().toISOString(),
    fatal: sanitizeError(error),
    realGeneratedAssetCount: Number(imageCompleted) + Number(videoCompleted),
    generationSubmissionCount: {
      image: recordedNetwork.filter((item) => item.kind === "image").length,
      video: recordedNetwork.filter((item) => item.kind === "video").length,
    },
    actualBilling: report.actualBilling || null,
    productionReady: false,
  };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeEvidenceJson("canvas-production-readiness-fatal.json", fallback);
  process.exitCode = 1;
});
