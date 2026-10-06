import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const expected = [
  {
    id: "canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
    cover: "/youcai-media/v1/canvas-showcases/paper-fox/06-cover.jpg",
    nodes: 13,
    edges: 17,
  },
  {
    id: "cmsyrsury01e3caezkqyg5l5l",
    cover: "/youcai-media/v1/images/cmojwg45f038f110s9yuy8hua.png",
    nodes: 78,
    edges: 71,
  },
  {
    id: "cmsyrvsqh01jgcaez3xadrsob",
    cover: "/youcai-media/v1/canvas-showcases/m8/01-cockpit-family.jpg",
    nodes: 139,
    edges: 148,
  },
  {
    id: "cmt37buny005u85fyne9adfac",
    cover: "/youcai-media/v1/images/cmt1m9fmb02vk7fsayssbhkzx.png",
    nodes: 85,
    edges: 14,
  },
] as const;

assert.equal(CANVAS_SHARE_SHOWCASES.length, expected.length, "exactly four independent showcase cards are required");

const mediaOwnerByPath = new Map<string, string>();
for (const contract of expected) {
  const showcase = CANVAS_SHARE_SHOWCASES.find((candidate) => candidate.id === contract.id);
  assert.ok(showcase, `missing showcase ${contract.id}`);
  assert.equal(showcase.coverImage, contract.cover, `${contract.id} uses the wrong public card cover`);
  assert.equal(showcase.nodes.length, contract.nodes, `${contract.id} node contract drifted`);
  assert.equal(showcase.edges.length, contract.edges, `${contract.id} edge contract drifted`);

  const localCover = path.join(root, "public", contract.cover.replace(/^\//, ""));
  assert.ok(fs.existsSync(localCover), `missing local cover ${contract.cover}`);
  assert.ok(fs.statSync(localCover).size > 0, `empty local cover ${contract.cover}`);

  const nodeIds = showcase.nodes.map((node) => node.id);
  assert.equal(new Set(nodeIds).size, nodeIds.length, `${contract.id} contains duplicate node ids`);
  const nodeIdSet = new Set(nodeIds);
  const edgeIds = showcase.edges.map((edge) => edge.id);
  assert.equal(new Set(edgeIds).size, edgeIds.length, `${contract.id} contains duplicate edge ids`);
  for (const edge of showcase.edges) {
    assert.ok(nodeIdSet.has(edge.source), `${contract.id} edge ${edge.id} has a missing source`);
    assert.ok(nodeIdSet.has(edge.target), `${contract.id} edge ${edge.id} has a missing target`);
  }

  const localMedia = showcase.nodes
    .map((node) => node.imagePath || node.mediaPath)
    .filter((mediaPath): mediaPath is string => Boolean(mediaPath));
  assert.equal(new Set(localMedia).size, localMedia.length, `${contract.id} silently repeats showcase media`);
  for (const mediaPath of localMedia) {
    const existingOwner = mediaOwnerByPath.get(mediaPath);
    assert.equal(existingOwner, undefined, `${contract.id} reuses media owned by ${existingOwner}: ${mediaPath}`);
    mediaOwnerByPath.set(mediaPath, contract.id);
  }
}

assert.equal(
  new Set(CANVAS_SHARE_SHOWCASES.map((showcase) => showcase.coverImage)).size,
  CANVAS_SHARE_SHOWCASES.length,
  "showcase card covers must be independent",
);

const showcaseSource = read("src/features/official-inspiration/canvas-showcase-data.ts");
assert.doesNotMatch(showcaseSource, /index\s*%\s*pool\.length/, "media pools must not cycle into repeated/cross-case assets");
assert.doesNotMatch(showcaseSource, /canvas-showcases\/official-covers/, "obsolete mismatched cover directory is still referenced");

const handoffSource = read("src/features/official-inspiration/canvas-handoff.ts");
assert.match(handoffSource, /const id\s*=\s*`showcase:\$\{showcase\.id\}:\$\{node\.id\}`/, "copied nodes must be namespace-isolated by showcase id");
assert.match(handoffSource, /raw\s*=\s*target\.getItem\(key\)[\s\S]*?removeStaleCanvasShowcaseHandoffs\(target\)/, "showcase handoff must be consumed once");

const manualCanvasSource = read("src/components/manual-canvas.tsx");
assert.match(manualCanvasSource, /initialReferenceRef\.current\?\.workflow\s*\?\s*currentNodes/, "imported graphs must fit all nodes");
assert.match(manualCanvasSource, /pendingViewportRef\.current\s*=\s*reference\?\.workflow\s*\?\s*null/, "anonymous imported graphs must not restore the synthetic viewport");
assert.match(manualCanvasSource, /pendingViewportRef\.current\s*=\s*importedSession\s*\?\s*null/, "account imported graphs must not restore the synthetic viewport");
assert.match(manualCanvasSource, /minZoom=\{0\.04\}/, "large official graphs need a low enough fit-view zoom floor");

const shareSource = read("src/features/official-inspiration/canvas-share-showcase.tsx");
assert.match(shareSource, /requestAnimationFrame\(\(\)\s*=>\s*fitView\(\)\)/, "read-only showcase must initially fit the complete graph");

const canvasCss = read("src/app/free-canvas-original.css");
assert.match(canvasCss, /\.free-flow-surface \.react-flow__minimap svg\s*\{[^}]*height:\s*100% !important/s, "minimap SVG height must be bounded by its shell");
assert.match(canvasCss, /contain:\s*layout paint size/, "minimap must contain large snapshot geometry");
assert.match(canvasCss, /vector-effect:\s*non-scaling-stroke/, "graph edges must stay visually bounded while zooming");

const shellSource = read("src/components/free-canvas-shell.tsx");
assert.match(shellSource, /\/api\/cover-models\?surface=storyboard-workbench/, "Canvas image nodes must use the published main-site image catalog");
assert.match(shellSource, /\/api\/video\/models\?surface=storyboard-workbench/, "Canvas video nodes must use the published main-site video catalog");
assert.match(shellSource, /\/api\/voice\/pricing/, "Canvas audio nodes must use the main-site pricing catalog");
assert.match(shellSource, /selling_price\s*>\s*0/, "image models without published pricing must be unavailable");
assert.match(shellSource, /pricePerUse\s*>\s*0/, "video models without published pricing must be unavailable");
assert.match(shellSource, /voicePricing=\{voicePricing\}/, "voice pricing metadata must reach the Canvas node editor");

console.log(JSON.stringify({
  ok: true,
  checks: 41,
  networkRequests: 0,
  paidCalls: 0,
  showcases: CANVAS_SHARE_SHOWCASES.map((showcase) => ({
    id: showcase.id,
    coverImage: showcase.coverImage,
    nodes: showcase.nodes.length,
    edges: showcase.edges.length,
    localMedia: showcase.nodes.filter((node) => node.imagePath || node.mediaPath).length,
  })),
}, null, 2));
