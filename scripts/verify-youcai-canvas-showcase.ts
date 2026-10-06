import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  canvasShowcaseHandoffKey,
  consumeCanvasShowcaseReference,
  INSPIRATION_CANVAS_HANDOFF_KEY,
  saveCanvasShowcaseReference,
  type CanvasHandoffStorage,
} from "../src/features/official-inspiration/canvas-handoff";
import { getCanvasShareShowcase } from "../src/features/official-inspiration/canvas-showcase-data";

class MemoryStorage implements CanvasHandoffStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function assertDirectedAcyclicGraph(
  nodeIds: ReadonlySet<string>,
  graphEdges: ReadonlyArray<{ source: string; target: string }>,
): void {
  const indegree = new Map([...nodeIds].map((nodeId) => [nodeId, 0]));
  const outgoing = new Map([...nodeIds].map((nodeId) => [nodeId, [] as string[]]));
  for (const edge of graphEdges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = [...nodeIds].filter((nodeId) => indegree.get(nodeId) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const source = queue.shift();
    if (!source) continue;
    visited += 1;
    for (const target of outgoing.get(source) ?? []) {
      const nextIndegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }
  assert.equal(visited, nodeIds.size, "paper fox workflow must remain a directed acyclic graph");
}

const showcase = getCanvasShareShowcase("canvas-showcase-78f7a4a9ce11-paper-fox-adventure");
assert(showcase, "paper fox showcase must exist");
assert.equal(showcase.nodes.length, 13, "paper fox showcase must expose the current official 13-node workflow");
assert.equal(showcase.edges?.length, 17, "paper fox showcase must expose the current official 17-edge workflow");

const kindCounts = showcase.nodes.reduce<Record<string, number>>((counts, node) => {
  counts[node.kind] = (counts[node.kind] || 0) + 1;
  return counts;
}, {});
assert.equal(kindCounts.image, 3);
assert.equal(kindCounts.video, 3);
assert.equal(kindCounts.music, 1);
assert.equal(kindCounts.audio, 1);
assert.equal(kindCounts.text, 5);

const storyVideoNodes = showcase.nodes.filter((node) => node.kind === "video");
assert.deepEqual(storyVideoNodes.map((node) => node.id), ["fox-video-a", "fox-video-b", "fox-video-preview"]);
assert.equal(new Set(storyVideoNodes.map((node) => node.mediaPath)).size, 3, "all three official video result nodes must use distinct playable local media");
const detachedPreview = showcase.nodes.find((node) => node.id === "fox-video-preview");
assert.equal(detachedPreview?.order, "", "the official extra video result is intentionally unnumbered");
assert.equal(detachedPreview?.title, "视频");

const nodeIds = new Set(showcase.nodes.map((node) => node.id));
for (const edge of showcase.edges || []) {
  assert(nodeIds.has(edge.source), `missing edge source ${edge.source}`);
  assert(nodeIds.has(edge.target), `missing edge target ${edge.target}`);
}
assertDirectedAcyclicGraph(nodeIds, showcase.edges || []);

const edgeKeys = new Set((showcase.edges || []).map((edge) => `${edge.source}->${edge.target}`));
const requiredDirectDependencies = [
  ["fox-brief", "fox-character"],
  ["fox-brief", "fox-scene"],
  ["fox-brief", "fox-cover"],
  ["fox-character", "fox-cover"],
  ["fox-scene", "fox-cover"],
  ["fox-storyboard", "fox-video-a"],
  ["fox-character", "fox-video-a"],
  ["fox-scene", "fox-video-a"],
  ["fox-video-a", "fox-publish"],
  ["fox-video-b", "fox-publish"],
] as const;
for (const [source, target] of requiredDirectDependencies) {
  assert(edgeKeys.has(`${source}->${target}`), `missing direct workflow dependency ${source}->${target}`);
}
assert.equal(
  [...edgeKeys].some((edge) => edge.startsWith("fox-video-preview->") || edge.endsWith("->fox-video-preview")),
  false,
  "the official unnumbered video result must remain detached instead of being invented into the story workflow",
);

for (const node of showcase.nodes) {
  for (const publicPath of [node.imagePath, node.mediaPath, node.posterPath].filter(Boolean) as string[]) {
    assert(publicPath.startsWith("/") && !publicPath.startsWith("//"), `${node.id} must use a local public asset`);
    assert(!/^https?:/i.test(publicPath), `${node.id} must not reuse remote benchmark media`);
    assert(existsSync(path.join(process.cwd(), "public", publicPath.slice(1))), `${node.id} asset does not exist: ${publicPath}`);
  }
}

const storage = new MemoryStorage();
assert.equal(saveCanvasShowcaseReference(showcase, storage), true);
assert.equal(storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY), null, "showcase handoff must not use the global inspiration key");
const scopedKey = canvasShowcaseHandoffKey(showcase.id);
assert(storage.getItem(scopedKey), "scoped handoff must be stored before navigation");
const imported = consumeCanvasShowcaseReference(showcase.id, storage);
assert(imported, "handoff must be consumable");
assert.equal(imported.inspirationId, showcase.id);
assert.equal(imported.title, showcase.title);
assert.equal(imported.schemaVersion, "official_inspiration_reference.v2");
assert.match(imported.prompt, new RegExp(`${showcase.nodes.length} 个节点`));
assert.match(imported.prompt, new RegExp(`${showcase.edges?.length ?? 0} 条`));
for (const node of showcase.nodes) assert(imported.prompt.includes(node.title), `handoff missing node title ${node.title}`);
assert(imported.workflow, "showcase handoff must include a structured workflow");
assert.equal(imported.workflow.name, showcase.title);
assert.equal(imported.workflow.nodes.length, showcase.nodes.length, "all showcase nodes must remain independent nodes");
assert.equal(imported.workflow.edges.length, showcase.edges?.length, "all showcase edges must remain real edges");
assert.equal(new Set(imported.workflow.nodes.map((node) => node.id)).size, showcase.nodes.length);
for (const edge of imported.workflow.edges) {
  const importedNodeIds = new Set(imported.workflow.nodes.map((node) => node.id));
  assert(importedNodeIds.has(edge.source), `structured handoff missing edge source ${edge.source}`);
  assert(importedNodeIds.has(edge.target), `structured handoff missing edge target ${edge.target}`);
}
assert.equal(storage.getItem(scopedKey), null, "handoff must be consumed exactly once");
assert.equal(consumeCanvasShowcaseReference(showcase.id, storage), null, "handoff must not be imported twice");

const pageSource = readFileSync("src/app/youcai/share/canvas/[shareId]/page.tsx", "utf8");
const componentSource = readFileSync("src/features/official-inspiration/canvas-share-showcase.tsx", "utf8");
const componentStyles = readFileSync("src/features/official-inspiration/canvas-share-showcase.module.css", "utf8");
assert(!pageSource.includes("AppRouteShell"), "public share page must remain a full-width canvas without the app sidebar");
assert(componentSource.includes("<video controls"), "share page must render local video previews");
assert(componentSource.includes("<audio controls"), "share page must render local audio/music previews");
assert(componentSource.includes("saveCanvasShowcaseReference"), "copy action must persist the complete editable blueprint");
assert(!componentSource.includes("进入创作画布"), "showcase preview must not render a second nested-canvas footer action");
assert(!componentSource.includes("styles.footer"), "showcase preview must not reserve a second footer shell");
assert.match(componentStyles, /\.page\s*\{[\s\S]*?height:\s*100dvh[\s\S]*?overflow:\s*hidden/u, "showcase page must be a single viewport shell");
assert.match(componentStyles, /\.canvasViewport\s*\{[\s\S]*?flex:\s*1 1 auto[\s\S]*?overflow:\s*auto/u, "only the workflow viewport may scroll in canvas mode");
const manualCanvasSource = readFileSync("src/components/manual-canvas.tsx", "utf8");
const freeCanvasShellSource = readFileSync("src/components/free-canvas-shell.tsx", "utf8");
assert(manualCanvasSource.includes("if (reference.workflow)"), "free canvas must import the structured graph");
assert(manualCanvasSource.includes("reference.workflow.edges"), "free canvas must restore real edges");
assert.match(manualCanvasSource, /本次导入未触发生成或扣费/u);
assert.match(manualCanvasSource, /session\.sourceReferenceId === preferredReferenceId/u, "query-selected showcase must restore only its own saved session");
assert.match(freeCanvasShellSource, /preferredReferenceId=\{expectedShowcaseId \|\| canvasHandoff\?\.inspirationId\}/u, "free canvas shell must pin the selected showcase id");

console.log(JSON.stringify({
  ok: true,
  title: showcase.title,
  nodes: showcase.nodes.length,
  edges: showcase.edges?.length,
  kindCounts,
  localMediaNodes: showcase.nodes.filter((node) => node.imagePath || node.mediaPath).length,
  handoff: {
    oneShot: true,
    promptLength: imported.prompt.length,
    imagePath: imported.imagePath,
    structuredNodes: imported.workflow.nodes.length,
    structuredEdges: imported.workflow.edges.length,
  },
}, null, 2));
