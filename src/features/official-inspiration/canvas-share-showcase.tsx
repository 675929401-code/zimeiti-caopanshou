"use client";

import Image from "next/image";
import { AppScopedLink as Link } from "@/components/app-scoped-link";
import { useAppScopedRouter } from "@/hooks/use-app-scoped-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  AudioLines,
  Check,
  ClipboardList,
  Copy,
  Film,
  ImageIcon,
  LayoutGrid,
  List,
  Maximize2,
  Minus,
  Music2,
  Plus,
  Save,
  Type,
} from "lucide-react";
import { saveCanvasShowcaseReference } from "./canvas-handoff";
import type {
  CanvasShareShowcaseData,
  CanvasShowcaseEdge,
  CanvasShowcaseNode,
  CanvasShowcaseNodeKind,
} from "./canvas-showcase-data";
import {
  computeMiniMapHeight,
  computeMiniMapLayout,
  computeVisibleLogicalRect,
  isPointInsideLogicalRect,
  miniMapClientPointToLogical,
  resolveDraggedViewportCenter,
  type CanvasLogicalPoint,
} from "./canvas-minimap-geometry";
import styles from "./canvas-share-showcase.module.css";

const DEFAULT_NODE_WIDTH = 400;
const BOARD_PADDING = 80;
const MIN_BOARD_WIDTH = 1240;
const MIN_BOARD_HEIGHT = 760;
const MIN_ZOOM = 5;
const MAX_ZOOM = 125;
const DEFAULT_ZOOM = 100;
const INITIAL_VIEWPORT_OFFSET = 32;
const VIEWPORT_BOUNDARY_PADDING = 24;
const MINIMAP_WIDTH = 220;
const MINIMAP_MIN_HEIGHT = 96;
const MINIMAP_MAX_HEIGHT = 160;
const MINIMAP_PADDING = 8;

function isVideoNode(kind: CanvasShowcaseNodeKind): boolean {
  return kind === "video" || kind === "video-plan";
}

function isAudioNode(kind: CanvasShowcaseNodeKind): boolean {
  return kind === "audio" || kind === "music" || kind === "audio-plan";
}

function NodeIcon({ kind }: { kind: CanvasShowcaseNodeKind }) {
  if (kind === "image") return <ImageIcon size={15} />;
  if (isVideoNode(kind)) return <Film size={15} />;
  if (kind === "music") return <Music2 size={15} />;
  if (isAudioNode(kind)) return <AudioLines size={15} />;
  return <Type size={15} />;
}

function fallbackPosition(index: number) {
  return {
    x: (index % 4) * 520,
    y: Math.floor(index / 4) * 520,
  };
}

function nodeHeight(node: CanvasShowcaseNode): number {
  if (node.height) return node.height;
  if (node.imagePath || isVideoNode(node.kind)) return 470;
  if (isAudioNode(node.kind)) return 250;
  return 330;
}

function nodeWidth(node: CanvasShowcaseNode): number {
  return node.width || DEFAULT_NODE_WIDTH;
}

function buildFallbackEdges(nodes: readonly CanvasShowcaseNode[]): CanvasShowcaseEdge[] {
  return nodes.slice(1).map((node, index) => ({
    id: `fallback-edge-${index + 1}`,
    source: nodes[index]?.id || "",
    target: node.id,
  })).filter((edge) => edge.source);
}

interface BoardLayout {
  width: number;
  height: number;
  positions: ReadonlyMap<string, { x: number; y: number }>;
}

interface ViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value)));
}

function clampViewportTransform(
  transform: ViewportTransform,
  layout: Pick<BoardLayout, "width" | "height">,
  viewport: { width: number; height: number },
): ViewportTransform {
  const zoom = clampZoom(transform.zoom);
  const scale = zoom / 100;
  const clampAxis = (offset: number, boardSize: number, viewportSize: number) => {
    if (viewportSize <= 0) return offset;
    if (boardSize <= viewportSize - VIEWPORT_BOUNDARY_PADDING * 2) {
      return (viewportSize - boardSize) / 2;
    }
    const minimum = viewportSize - boardSize - VIEWPORT_BOUNDARY_PADDING;
    const maximum = VIEWPORT_BOUNDARY_PADDING;
    return Math.min(maximum, Math.max(minimum, offset));
  };

  return {
    x: clampAxis(transform.x, layout.width * scale, viewport.width),
    y: clampAxis(transform.y, layout.height * scale, viewport.height),
    zoom,
  };
}

function buildBoardLayout(nodes: readonly CanvasShowcaseNode[]): BoardLayout {
  const rawPositions = nodes.map((node, index) => node.position ?? fallbackPosition(index));
  const minX = Math.min(...rawPositions.map((position) => position.x));
  const minY = Math.min(...rawPositions.map((position) => position.y));
  const maxX = Math.max(...rawPositions.map((position, index) => position.x + nodeWidth(nodes[index])));
  const maxY = Math.max(...rawPositions.map((position, index) => position.y + nodeHeight(nodes[index])));
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    positions.set(node.id, {
      x: rawPositions[index].x - minX + BOARD_PADDING,
      y: rawPositions[index].y - minY + BOARD_PADDING,
    });
  });
  return {
    width: Math.max(MIN_BOARD_WIDTH, maxX - minX + BOARD_PADDING * 2),
    height: Math.max(MIN_BOARD_HEIGHT, maxY - minY + BOARD_PADDING * 2),
    positions,
  };
}

function edgePath(
  edge: CanvasShowcaseEdge,
  nodes: readonly CanvasShowcaseNode[],
  layout: BoardLayout,
): string | null {
  const sourceIndex = nodes.findIndex((node) => node.id === edge.source);
  const targetIndex = nodes.findIndex((node) => node.id === edge.target);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const source = nodes[sourceIndex];
  const target = nodes[targetIndex];
  const sourcePosition = layout.positions.get(source.id);
  const targetPosition = layout.positions.get(target.id);
  if (!sourcePosition || !targetPosition) return null;
  const startX = sourcePosition.x + nodeWidth(source);
  const startY = sourcePosition.y + Math.min(nodeHeight(source) * 0.5, 230);
  const endX = targetPosition.x;
  const endY = targetPosition.y + Math.min(nodeHeight(target) * 0.5, 230);
  const bend = Math.max(90, Math.abs(endX - startX) * 0.42);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function MediaPreview({ node }: { node: CanvasShowcaseNode }) {
  if (node.imagePath) {
    return (
      <div className={styles.nodeImage}>
        <Image
          src={node.imagePath}
          alt={node.imageAlt || "本地原创工作流参考图"}
          fill
          sizes="(max-width: 760px) 88vw, 400px"
        />
      </div>
    );
  }
  if (node.mediaPath && isVideoNode(node.kind)) {
    return (
      <div className={styles.videoPreview}>
        <video controls preload="metadata" poster={node.posterPath} playsInline>
          <source src={node.mediaPath} type={node.mediaType || "video/mp4"} />
          当前浏览器不支持视频预览。
        </video>
      </div>
    );
  }
  if (node.mediaPath && isAudioNode(node.kind)) {
    return (
      <div className={styles.audioPreview}>
        <div><AudioLines size={22} /><span>{node.durationLabel || "本地音频试听"}</span></div>
        <audio controls preload="metadata">
          <source src={node.mediaPath} type={node.mediaType || "audio/mp4"} />
          当前浏览器不支持音频预览。
        </audio>
      </div>
    );
  }
  return null;
}

function ShowcaseNodeCard({
  node,
  list,
  position,
  editable,
  onBodyChange,
}: {
  node: CanvasShowcaseNode;
  list?: boolean;
  position?: { x: number; y: number };
  editable?: boolean;
  onBodyChange?: (value: string) => void;
}) {
  const style = !list && position
    ? ({
      left: position.x,
      top: position.y,
      width: nodeWidth(node),
      height: nodeHeight(node),
    } as CSSProperties)
    : undefined;
  const planned = node.kind === "video-plan" || node.kind === "audio-plan" || node.status.includes("未");
  if (node.kind === "group" && !list) {
    return (
      <section
        className={styles.groupFrame}
        data-group-frame="true"
        data-node-id={node.id}
        style={style}
        aria-label={`${node.title}分组`}
      >
        <header><LayoutGrid size={14} /><strong>{node.title}</strong></header>
        <p>{node.body}</p>
      </section>
    );
  }
  return (
    <article
      className={list ? styles.listNode : styles.nodeCard}
      data-kind={node.kind}
      data-node-id={node.id}
      style={style}
    >
      {!list ? <span className={styles.inputPort} aria-hidden="true" /> : null}
      <header className={styles.nodeHeader}>
        <span className={styles.statusBadge} data-muted={planned || undefined}>
          <Check size={12} />{planned ? "创作方案" : "已完成"}
        </span>
        <span className={styles.nodeTitle}>
          <NodeIcon kind={node.kind} />
          {[node.order, node.title].filter(Boolean).join(" · ")}
        </span>
      </header>
      <MediaPreview node={node} />
      {editable ? (
        <label className={styles.editableBody}>
          <span>节点内容 / 提示词</span>
          <textarea
            aria-label={`${node.title}节点内容`}
            value={node.body}
            onChange={(event) => onBodyChange?.(event.target.value)}
          />
        </label>
      ) : <p>{node.body}</p>}
      {node.toolLabel ? <small className={styles.toolLabel}>{node.toolLabel}</small> : null}
      {!list ? <span className={styles.outputPort} aria-hidden="true" /> : null}
    </article>
  );
}

export function CanvasShowcaseEditorEntry({ showcase }: { showcase: CanvasShareShowcaseData }) {
  const router = useAppScopedRouter();
  const startedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState("");
  const editorHref = `/youcai/free-canvas?showcase=${encodeURIComponent(showcase.id)}`;

  const openEditor = useCallback(() => {
    router.prefetch(editorHref);
    if (!saveCanvasShowcaseReference(showcase)) {
      setErrorMessage("无法保存复制蓝图，请确认浏览器允许会话存储后重试。");
      return;
    }
    router.replace(editorHref);
  }, [editorHref, router, showcase]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    openEditor();
  }, [openEditor]);

  return (
    <main
      className={styles.page}
      data-canvas-shell="showcase-editor-entry"
      data-showcase-id={showcase.id}
    >
      <header className={styles.toolbar}>
        <div className={styles.titleGroup}>
          <span>正在复制示例</span>
          <h1>{showcase.title}</h1>
          <small>将进入真实可编辑自由画布，不会自动生成或扣费</small>
        </div>
        {errorMessage ? (
          <button type="button" className={styles.continueButton} onClick={openEditor}>重试进入画布</button>
        ) : null}
      </header>
      <p role="status" className={styles.handoffError} data-success={!errorMessage || undefined}>
        {errorMessage || "已准备可重放的画布蓝图，正在打开编辑器…"}
      </p>
    </main>
  );
}

export function CanvasShareShowcase({
  showcase,
  mode = "preview",
}: {
  showcase: CanvasShareShowcaseData;
  mode?: "preview" | "workspace";
}) {
  const router = useAppScopedRouter();
  const viewportRef = useRef<HTMLElement | null>(null);
  const miniMapRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const miniMapDragRef = useRef<{
    pointerId: number;
    grabOffset: CanvasLogicalPoint;
  } | null>(null);
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [viewportTransform, setViewportTransform] = useState<ViewportTransform>({
    x: INITIAL_VIEWPORT_OFFSET,
    y: INITIAL_VIEWPORT_OFFSET,
    zoom: DEFAULT_ZOOM,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [isMiniMapDragging, setIsMiniMapDragging] = useState(false);
  const [viewportSize, setViewportSize] = useState({
    width: MIN_BOARD_WIDTH,
    height: MIN_BOARD_HEIGHT,
  });
  const [statusMessage, setStatusMessage] = useState("");
  const [statusSuccess, setStatusSuccess] = useState(false);
  const [nodeBodies, setNodeBodies] = useState<Record<string, string>>(() => (
    Object.fromEntries(showcase.nodes.map((node) => [node.id, node.body]))
  ));
  const editorHref = `/youcai/free-canvas?showcase=${encodeURIComponent(showcase.id)}`;
  const editable = mode === "workspace";
  const draftKey = `youcai_canvas_workspace_draft:${showcase.id}`;
  const nodes = useMemo(() => showcase.nodes.map((node) => ({
    ...node,
    body: nodeBodies[node.id] ?? node.body,
  })), [nodeBodies, showcase.nodes]);
  const edges = useMemo(
    () => showcase.edges && showcase.edges.length > 0 ? showcase.edges : buildFallbackEdges(nodes),
    [nodes, showcase.edges],
  );
  const layout = useMemo(() => buildBoardLayout(nodes), [nodes]);
  const zoom = viewportTransform.zoom;
  const miniMapHeight = useMemo(() => computeMiniMapHeight(
    layout,
    MINIMAP_WIDTH,
    MINIMAP_MIN_HEIGHT,
    MINIMAP_MAX_HEIGHT,
    MINIMAP_PADDING,
  ), [layout]);

  const miniMapLayout = useMemo(() => computeMiniMapLayout(
    layout,
    MINIMAP_WIDTH,
    miniMapHeight,
    MINIMAP_PADDING,
  ), [layout, miniMapHeight]);

  const measureViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setViewportSize({
      width: viewport.clientWidth,
      height: viewport.clientHeight,
    });
  }, []);

  const miniMapViewport = useMemo(() => computeVisibleLogicalRect(
    viewportTransform,
    viewportSize,
    layout,
  ), [layout, viewportSize, viewportTransform]);
  const miniMapInteractive = miniMapViewport.width < layout.width - 1
    || miniMapViewport.height < layout.height - 1;

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const widthRatio = (viewport.clientWidth - 40) / layout.width;
    const heightRatio = (viewport.clientHeight - 40) / layout.height;
    const nextZoom = clampZoom(Math.min(DEFAULT_ZOOM, Math.floor(Math.min(widthRatio, heightRatio) * 100)));
    const scale = nextZoom / 100;
    setViewportTransform(clampViewportTransform({
      x: (viewport.clientWidth - layout.width * scale) / 2,
      y: (viewport.clientHeight - layout.height * scale) / 2,
      zoom: nextZoom,
    }, layout, { width: viewport.clientWidth, height: viewport.clientHeight }));
  }, [layout]);

  useEffect(() => {
    if (view !== "canvas") return;
    const frame = window.requestAnimationFrame(() => fitView());
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, showcase.id, view]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || view !== "canvas") return;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(viewport);
    measureViewport();
    return () => {
      observer.disconnect();
    };
  }, [measureViewport, view]);

  useEffect(() => {
    if (view !== "canvas" || viewportSize.width <= 0 || viewportSize.height <= 0) return;
    setViewportTransform((current) => clampViewportTransform(current, layout, viewportSize));
  }, [layout, viewportSize, view]);

  const zoomAroundPoint = useCallback((nextZoomValue: number, anchorX?: number, anchorY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const resolvedAnchorX = anchorX ?? rect.width / 2;
    const resolvedAnchorY = anchorY ?? rect.height / 2;
    const nextZoom = clampZoom(nextZoomValue);
    setViewportTransform((current) => {
      const currentScale = current.zoom / 100;
      const nextScale = nextZoom / 100;
      const logicalX = (resolvedAnchorX - current.x) / currentScale;
      const logicalY = (resolvedAnchorY - current.y) / currentScale;
      return clampViewportTransform({
        x: resolvedAnchorX - logicalX * nextScale,
        y: resolvedAnchorY - logicalY * nextScale,
        zoom: nextZoom,
      }, layout, { width: viewport.clientWidth, height: viewport.clientHeight });
    });
  }, [layout]);

  const beginPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("article[data-node-id], button, a, textarea, input, select, video, audio")) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportTransform.x,
      originY: viewportTransform.y,
    };
    viewport.setPointerCapture(event.pointerId);
    setIsPanning(true);
    event.preventDefault();
  };

  const movePan = (event: ReactPointerEvent<HTMLElement>) => {
    const pan = panRef.current;
    const viewport = viewportRef.current;
    if (!pan || pan.pointerId !== event.pointerId || !viewport) return;
    setViewportTransform((current) => clampViewportTransform({
      x: pan.originX + event.clientX - pan.startX,
      y: pan.originY + event.clientY - pan.startY,
      zoom: current.zoom,
    }, layout, { width: viewport.clientWidth, height: viewport.clientHeight }));
    event.preventDefault();
  };

  const endPan = (event: ReactPointerEvent<HTMLElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return;
    panRef.current = null;
    setIsPanning(false);
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId);
    }
  };

  const zoomWithWheel = useCallback((event: WheelEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("video, audio, textarea, input, select")) return;
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const delta = Math.max(-10, Math.min(10, -event.deltaY * 0.08));
    zoomAroundPoint(
      viewportTransform.zoom + delta,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }, [viewportTransform.zoom, zoomAroundPoint]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || view !== "canvas") return;
    viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", zoomWithWheel);
  }, [view, zoomWithWheel]);

  const miniMapLogicalPoint = useCallback((clientX: number, clientY: number) => {
    const miniMap = miniMapRef.current;
    if (!miniMap) return null;
    const rect = miniMap.getBoundingClientRect();
    return miniMapClientPointToLogical(
      { x: clientX, y: clientY },
      rect,
      { width: MINIMAP_WIDTH, height: miniMapHeight },
      miniMapLayout,
      layout,
    );
  }, [layout, miniMapHeight, miniMapLayout]);

  const navigateFromMiniMap = useCallback((logicalCenter: CanvasLogicalPoint) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setViewportTransform((current) => clampViewportTransform({
      x: viewport.clientWidth / 2 - logicalCenter.x * (current.zoom / 100),
      y: viewport.clientHeight / 2 - logicalCenter.y * (current.zoom / 100),
      zoom: current.zoom,
    }, layout, { width: viewport.clientWidth, height: viewport.clientHeight }));
  }, [layout]);

  const finishMiniMapDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (miniMapDragRef.current?.pointerId !== event.pointerId) return;
    miniMapDragRef.current = null;
    setIsMiniMapDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.stopPropagation();
  };

  const zoomButtonStep = zoom <= 25 ? 2 : zoom <= 50 ? 5 : 10;

  useEffect(() => {
    const defaults = Object.fromEntries(showcase.nodes.map((node) => [node.id, node.body]));
    if (!editable) {
      setNodeBodies(defaults);
      return;
    }
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) {
        setNodeBodies(defaults);
        return;
      }
      const parsed = JSON.parse(raw) as { nodeBodies?: unknown };
      if (!parsed.nodeBodies || typeof parsed.nodeBodies !== "object" || Array.isArray(parsed.nodeBodies)) {
        setNodeBodies(defaults);
        return;
      }
      const restored = Object.fromEntries(showcase.nodes.map((node) => {
        const candidate = (parsed.nodeBodies as Record<string, unknown>)[node.id];
        return [node.id, typeof candidate === "string" ? candidate : node.body];
      }));
      setNodeBodies(restored);
    } catch {
      setNodeBodies(defaults);
    }
  }, [draftKey, editable, showcase.nodes]);

  const prefetchEditor = useCallback(() => {
    router.prefetch(editorHref);
  }, [editorHref, router]);

  const continueCreating = () => {
    prefetchEditor();
    const saved = saveCanvasShowcaseReference(showcase);
    if (!saved) {
      setStatusSuccess(false);
      setStatusMessage("无法保存复制蓝图，请确认浏览器允许会话存储后重试。");
      return;
    }
    router.push(`/youcai/free-canvas?showcase=${encodeURIComponent(showcase.id)}`);
  };

  const saveWorkspaceDraft = () => {
    try {
      window.sessionStorage.setItem(draftKey, JSON.stringify({
        schemaVersion: 1,
        showcaseId: showcase.id,
        nodeBodies,
        savedAt: new Date().toISOString(),
      }));
      setStatusSuccess(true);
      setStatusMessage("当前画布草稿已保存在本次浏览器会话中。");
    } catch {
      setStatusSuccess(false);
      setStatusMessage("草稿保存失败，请确认浏览器允许会话存储后重试。");
    }
  };

  return (
    <div
      className={styles.page}
      data-canvas-shell={editable ? "showcase-workspace" : "showcase-preview"}
      data-showcase-id={showcase.id}
    >
      <header className={styles.toolbar}>
        <div className={styles.toolbarStart}>
          <Link href="/youcai/tools/canvas" className={styles.backButton}><ArrowLeft size={16} />返回</Link>
          <div className={styles.titleGroup}>
            <span>示例</span>
            <h1>{showcase.title}</h1>
            <small>{editable ? "独立可编辑工作区" : "只读预览 · 复制后可编辑"}</small>
          </div>
        </div>

        <div className={styles.toolbarActions}>
          <div className={styles.viewToggle} aria-label="切换展示方式">
            <button type="button" title="画布视图" aria-label="画布视图" data-active={view === "canvas" || undefined} onClick={() => setView("canvas")}>
              <LayoutGrid size={16} />
            </button>
            <button type="button" title="列表视图" aria-label="列表视图" data-active={view === "list" || undefined} onClick={() => setView("list")}>
              <List size={16} />
            </button>
          </div>
          <button
            type="button"
            className={styles.continueButton}
            onClick={editable ? saveWorkspaceDraft : continueCreating}
            onPointerEnter={editable ? undefined : prefetchEditor}
            onFocus={editable ? undefined : prefetchEditor}
          >
            {editable ? <Save size={15} /> : <Copy size={15} />}
            {editable ? "保存当前草稿" : "复制并继续创作"}
          </button>
        </div>
      </header>

      {statusMessage ? (
        <p role="status" className={styles.handoffError} data-success={statusSuccess || undefined}>
          {statusMessage}
        </p>
      ) : null}

      {view === "canvas" ? (
        <section
          ref={viewportRef}
          className={styles.canvasViewport}
          data-canvas-viewport="transform"
          data-panning={isPanning || undefined}
          data-zoom={zoom}
          aria-label="只读工作流画布"
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <div className={styles.canvasStage}>
            <div
              className={styles.canvasBoard}
              data-canvas-transform="true"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `translate3d(${viewportTransform.x}px, ${viewportTransform.y}px, 0) scale(${zoom / 100})`,
              } as CSSProperties}
            >
              <svg className={styles.edgeLayer} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
                <defs>
                  <marker id="showcase-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {edges.map((edge) => {
                  const path = edgePath(edge, nodes, layout);
                  return path ? <path key={edge.id} d={path} markerEnd="url(#showcase-arrow)" /> : null;
                })}
              </svg>
              {nodes.map((node) => (
                <ShowcaseNodeCard
                  node={node}
                  position={layout.positions.get(node.id)}
                  editable={editable}
                  onBodyChange={(value) => setNodeBodies((current) => ({ ...current, [node.id]: value }))}
                  key={node.id}
                />
              ))}
            </div>
          </div>

          <div
            className={styles.miniMap}
            data-dragging={isMiniMapDragging || undefined}
            data-interactive={miniMapInteractive || undefined}
            style={{ height: miniMapHeight }}
          >
            <svg
              ref={miniMapRef}
              width={MINIMAP_WIDTH}
              height={miniMapHeight}
              viewBox={`0 0 ${MINIMAP_WIDTH} ${miniMapHeight}`}
              role="navigation"
              aria-label={miniMapInteractive ? "画布导航缩略图，可拖动视口边框定位" : "画布导航缩略图，当前已显示完整画布"}
              data-minimap-for={showcase.id}
              onPointerDown={(event) => {
                if (event.button !== 0 || !miniMapInteractive) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                const pointer = miniMapLogicalPoint(event.clientX, event.clientY);
                if (!pointer) return;
                const viewportCenter = {
                  x: miniMapViewport.x + miniMapViewport.width / 2,
                  y: miniMapViewport.y + miniMapViewport.height / 2,
                };
                const grabbedViewport = isPointInsideLogicalRect(pointer, miniMapViewport);
                const grabOffset = grabbedViewport
                  ? { x: pointer.x - viewportCenter.x, y: pointer.y - viewportCenter.y }
                  : { x: 0, y: 0 };
                miniMapDragRef.current = { pointerId: event.pointerId, grabOffset };
                event.currentTarget.setPointerCapture(event.pointerId);
                setIsMiniMapDragging(true);
                if (!grabbedViewport) navigateFromMiniMap(pointer);
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerMove={(event) => {
                const drag = miniMapDragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                const pointer = miniMapLogicalPoint(event.clientX, event.clientY);
                if (!pointer) return;
                navigateFromMiniMap(resolveDraggedViewportCenter(pointer, drag.grabOffset));
                event.preventDefault();
                event.stopPropagation();
              }}
              onPointerUp={finishMiniMapDrag}
              onPointerCancel={finishMiniMapDrag}
            >
              <rect className={styles.miniMapBackground} width={MINIMAP_WIDTH} height={miniMapHeight} rx="10" />
              {nodes.map((node) => {
                const position = layout.positions.get(node.id);
                if (!position) return null;
                return (
                  <rect
                    key={node.id}
                    className={styles.miniMapNode}
                    data-kind={node.kind}
                    x={miniMapLayout.offsetX + position.x * miniMapLayout.scale}
                    y={miniMapLayout.offsetY + position.y * miniMapLayout.scale}
                    width={Math.max(2, nodeWidth(node) * miniMapLayout.scale)}
                    height={Math.max(2, nodeHeight(node) * miniMapLayout.scale)}
                    rx="1.5"
                  />
                );
              })}
              <rect
                className={styles.miniMapViewportMask}
                x={miniMapLayout.offsetX + miniMapViewport.x * miniMapLayout.scale}
                y={miniMapLayout.offsetY + miniMapViewport.y * miniMapLayout.scale}
                width={miniMapViewport.width * miniMapLayout.scale}
                height={miniMapViewport.height * miniMapLayout.scale}
                data-full-view={!miniMapInteractive || undefined}
                rx="2"
              />
            </svg>
          </div>
          <div className={styles.zoomControls}>
            <button type="button" aria-label="缩小" onClick={() => zoomAroundPoint(zoom - zoomButtonStep)}><Minus size={16} /></button>
            <span>{zoom}%</span>
            <button type="button" aria-label="放大" onClick={() => zoomAroundPoint(zoom + zoomButtonStep)}><Plus size={16} /></button>
            <button type="button" className={styles.fitButton} aria-label="适配视图" title="适配视图" onClick={() => fitView()}><Maximize2 size={15} /></button>
          </div>
        </section>
      ) : (
        <section className={styles.listView} aria-label="只读工作流列表">
          <div className={styles.listHeading}>
            <ClipboardList size={20} />
            <div><h2>{showcase.title}</h2><p>按创作顺序查看 {nodes.length} 个配置节点</p></div>
          </div>
          {nodes.map((node) => (
            <ShowcaseNodeCard
              node={node}
              list
              editable={editable}
              onBodyChange={(value) => setNodeBodies((current) => ({ ...current, [node.id]: value }))}
              key={node.id}
            />
          ))}
        </section>
      )}

    </div>
  );
}
