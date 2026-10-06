export interface CanvasLogicalSize {
  width: number;
  height: number;
}

export interface CanvasViewportTransform {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasLogicalPoint {
  x: number;
  y: number;
}

export interface CanvasLogicalRect extends CanvasLogicalPoint, CanvasLogicalSize {}

export interface MiniMapLayout {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface MiniMapClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function computeMiniMapHeight(
  layout: CanvasLogicalSize,
  width: number,
  minimumHeight: number,
  maximumHeight: number,
  padding: number,
): number {
  const safeWidth = Math.max(1, layout.width);
  const contentWidth = Math.max(1, width - padding * 2);
  const proportionalHeight = padding * 2 + contentWidth * (layout.height / safeWidth);
  return Math.round(clamp(proportionalHeight, minimumHeight, maximumHeight));
}

export function computeMiniMapLayout(
  layout: CanvasLogicalSize,
  width: number,
  height: number,
  padding: number,
): MiniMapLayout {
  const scale = Math.min(
    Math.max(1, width - padding * 2) / Math.max(1, layout.width),
    Math.max(1, height - padding * 2) / Math.max(1, layout.height),
  );
  return {
    scale,
    offsetX: (width - layout.width * scale) / 2,
    offsetY: (height - layout.height * scale) / 2,
  };
}

export function computeVisibleLogicalRect(
  transform: CanvasViewportTransform,
  viewport: CanvasLogicalSize,
  layout: CanvasLogicalSize,
): CanvasLogicalRect {
  const scale = Math.max(0.0001, transform.zoom / 100);
  const left = clamp(-transform.x / scale, 0, layout.width);
  const right = clamp((viewport.width - transform.x) / scale, 0, layout.width);
  const top = clamp(-transform.y / scale, 0, layout.height);
  const bottom = clamp((viewport.height - transform.y) / scale, 0, layout.height);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function miniMapClientPointToLogical(
  clientPoint: CanvasLogicalPoint,
  clientRect: MiniMapClientRect,
  viewBox: CanvasLogicalSize,
  miniMapLayout: MiniMapLayout,
  layout: CanvasLogicalSize,
): CanvasLogicalPoint {
  const svgX = (clientPoint.x - clientRect.left) * viewBox.width / Math.max(1, clientRect.width);
  const svgY = (clientPoint.y - clientRect.top) * viewBox.height / Math.max(1, clientRect.height);
  return {
    x: clamp((svgX - miniMapLayout.offsetX) / miniMapLayout.scale, 0, layout.width),
    y: clamp((svgY - miniMapLayout.offsetY) / miniMapLayout.scale, 0, layout.height),
  };
}

export function isPointInsideLogicalRect(
  point: CanvasLogicalPoint,
  rect: CanvasLogicalRect,
): boolean {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

export function resolveDraggedViewportCenter(
  pointer: CanvasLogicalPoint,
  grabOffset: CanvasLogicalPoint,
): CanvasLogicalPoint {
  return {
    x: pointer.x - grabOffset.x,
    y: pointer.y - grabOffset.y,
  };
}
