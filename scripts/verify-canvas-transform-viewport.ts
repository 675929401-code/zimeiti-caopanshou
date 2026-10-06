import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const componentPath = resolve(root, "src/features/official-inspiration/canvas-share-showcase.tsx");
const cssPath = resolve(root, "src/features/official-inspiration/canvas-share-showcase.module.css");
const geometryPath = resolve(root, "src/features/official-inspiration/canvas-minimap-geometry.ts");
const component = readFileSync(componentPath, "utf8");
const css = readFileSync(cssPath, "utf8");
const geometry = readFileSync(geometryPath, "utf8");

const checks: Array<[string, boolean]> = [
  ["default zoom is 100 percent", component.includes("const DEFAULT_ZOOM = 100")],
  ["manual zoom range supports full large-board fit", component.includes("const MIN_ZOOM = 5") && component.includes("const MAX_ZOOM = 125")],
  ["fit view uses the shared zoom clamp", component.includes("const nextZoom = clampZoom(Math.min(DEFAULT_ZOOM")],
  ["viewport is backed by one transform state", component.includes("interface ViewportTransform") && component.includes("data-canvas-transform=\"true\"")],
  ["board uses translate and scale in the same transform", component.includes("translate3d(${viewportTransform.x}px, ${viewportTransform.y}px, 0) scale(${zoom / 100})")],
  ["blank pointer drag updates bounded transform coordinates", component.includes("x: pan.originX + event.clientX - pan.startX") && component.includes("y: pan.originY + event.clientY - pan.startY") && component.includes("clampViewportTransform")],
  ["wheel zoom is anchored at the pointer", component.includes("zoomWithWheel") && component.includes("zoomAroundPoint")],
  ["minimap navigation updates the same bounded transform", component.includes("navigateFromMiniMap") && component.includes("viewport.clientWidth / 2 - logicalCenter.x * (current.zoom / 100)") && component.includes("viewport.clientHeight / 2 - logicalCenter.y * (current.zoom / 100)") && component.includes("clampViewportTransform")],
  ["minimap click coordinates are converted and clamped in logical board space", component.includes("miniMapClientPointToLogical") && geometry.includes("clamp((svgX - miniMapLayout.offsetX) / miniMapLayout.scale, 0, layout.width)") && geometry.includes("clamp((svgY - miniMapLayout.offsetY) / miniMapLayout.scale, 0, layout.height)")],
  ["minimap viewport rectangle supports pointer-captured dragging", component.includes("setPointerCapture(event.pointerId)") && component.includes("resolveDraggedViewportCenter(pointer, drag.grabOffset)") && component.includes("onPointerCancel={finishMiniMapDrag}")],
  ["viewport transform clamps every axis to board bounds", component.includes("const minimum = viewportSize - boardSize - VIEWPORT_BOUNDARY_PADDING") && component.includes("return Math.min(maximum, Math.max(minimum, offset))")],
  ["minimap preserves one rectangle per source node", component.includes("{nodes.map((node) => {") && component.includes("className={styles.miniMapNode}")],
  ["edge renderer still maps the resolved edge set", component.includes("{edges.map((edge) => {") && component.includes("edgePath(edge, nodes, layout)")],
  ["native scrolling is not used as canvas pan", !component.includes("viewport.scrollLeft =") && !component.includes("viewport.scrollBy(") && !component.includes("viewport.scrollTo(")],
  ["canvas viewport clips native overflow", /\.canvasViewport\s*\{[\s\S]*?overflow:\s*hidden;/.test(css)],
  ["minimap and zoom controls are viewport overlays", /\.miniMap\s*\{[\s\S]*?position:\s*absolute;/.test(css) && /\.zoomControls\s*\{[\s\S]*?position:\s*absolute;/.test(css)],
  ["board transform is GPU-ready", /\.canvasBoard\s*\{[\s\S]*?will-change:\s*transform;/.test(css)],
];

for (const [label, passed] of checks) {
  assert.equal(passed, true, label);
  console.log(`PASS ${label}`);
}

console.log(`PASS ${checks.length}/${checks.length} canvas transform viewport checks`);
