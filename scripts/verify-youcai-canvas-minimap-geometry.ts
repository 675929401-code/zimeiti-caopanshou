import assert from "node:assert/strict";

import {
  computeMiniMapHeight,
  computeMiniMapLayout,
  computeVisibleLogicalRect,
  isPointInsideLogicalRect,
  miniMapClientPointToLogical,
  resolveDraggedViewportCenter,
} from "../src/features/official-inspiration/canvas-minimap-geometry";

const graph = { width: 11_210, height: 4_576 };
const miniMapWidth = 220;
const miniMapHeight = computeMiniMapHeight(graph, miniMapWidth, 96, 160, 8);

assert.equal(miniMapHeight, 99, "超宽画布的缩略导航应随宽高比收窄，不能保留大块空白");

const miniMapLayout = computeMiniMapLayout(graph, miniMapWidth, miniMapHeight, 8);
assert.ok(miniMapLayout.scale > 0, "缩略导航比例必须有效");
assert.ok(miniMapLayout.offsetX >= 7.9, "缩略图横向应保留边距");
assert.ok(miniMapLayout.offsetY >= 7.9, "缩略图纵向应保留边距");

const visibleWhenCanvasStartsInsideViewport = computeVisibleLogicalRect(
  { x: 100, y: 50, zoom: 50 },
  { width: 1_000, height: 800 },
  { width: 4_000, height: 2_000 },
);
assert.deepEqual(
  visibleWhenCanvasStartsInsideViewport,
  { x: 0, y: 0, width: 1_800, height: 1_500 },
  "画布 transform 为正值时，可见框不得延伸到逻辑画布之外",
);

const logicalPoint = miniMapClientPointToLogical(
  { x: 270, y: 199 },
  { left: 50, top: 100, width: 440, height: 198 },
  { width: miniMapWidth, height: miniMapHeight },
  miniMapLayout,
  graph,
);
assert.ok(Math.abs(logicalPoint.x - graph.width / 2) < 1, "CSS 缩放后的缩略图横坐标映射应保持准确");
assert.ok(Math.abs(logicalPoint.y - graph.height / 2) < 1, "CSS 缩放后的缩略图纵坐标映射应保持准确");

const viewportFrame = { x: 400, y: 200, width: 600, height: 300 };
const grabbedPoint = { x: 550, y: 300 };
assert.equal(isPointInsideLogicalRect(grabbedPoint, viewportFrame), true, "视口边框内部应可被拖动");

const originalCenter = {
  x: viewportFrame.x + viewportFrame.width / 2,
  y: viewportFrame.y + viewportFrame.height / 2,
};
const grabOffset = {
  x: grabbedPoint.x - originalCenter.x,
  y: grabbedPoint.y - originalCenter.y,
};
assert.deepEqual(
  resolveDraggedViewportCenter(grabbedPoint, grabOffset),
  originalCenter,
  "按住视口边框时不得先跳到鼠标位置",
);
assert.deepEqual(
  resolveDraggedViewportCenter({ x: 750, y: 450 }, grabOffset),
  { x: 900, y: 500 },
  "拖动时应保留抓取点偏移并连续移动视口",
);

console.log("PASS canvas minimap geometry: dynamic aspect ratio");
console.log("PASS canvas minimap geometry: transform clipping and CSS coordinate mapping");
console.log("PASS canvas minimap geometry: grab-offset viewport dragging");
