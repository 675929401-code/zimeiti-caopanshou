import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(
  process.cwd(),
  "public/short-drama/tool-alignment-manifest.v1.json",
);

const expectedCategoryCounts = {
  text: 10,
  image: 16,
  video: 27,
  audio: 12,
  canvas: 1,
  "film-studio": 1,
} as const;

const expectedStatusCounts = {
  implemented: 1,
  reused_main_capability: 18,
  model_binding_required: 39,
  not_planned: 9,
} as const;

const expectedSlugs = [
  "minimax-music",
  "volcengine-audio",
  "minimax-tts",
  "mimo-tts",
  "mimo-voice-design",
  "mimo-voice-clone",
  "minimax-file-upload",
  "minimax-voice-clone",
  "minimax-voice-design",
  "minimax-voice-activate",
  "minimax-lyrics-generation",
  "minimax-music-cover-preprocess",
  "canvas",
  "drama-workbench",
  "image-chat",
  "image-edit",
  "kling-image",
  "openrouter-image",
  "qwen-image",
  "volcengine-image",
  "character-sheet",
  "storyboard",
  "jimeng-tilesr",
  "jimeng-face-pretty",
  "drama-cast",
  "drama-prop",
  "drama-scene",
  "image-edit-grounding",
  "image-layer-decomposition",
  "seedance-portrait-validation",
  "text-chat",
  "drama-script",
  "general-script",
  "image-prompt",
  "upload-script",
  "script-brief",
  "audio-prompt",
  "video-prompt",
  "drama-cast-scene",
  "drama-shot-prompt",
  "video-chat",
  "seedance-video",
  "minimax-video",
  "kling-video",
  "jimeng-dreamactor-m20",
  "jimeng-omnihuman-v15",
  "happyhorse-t2v",
  "happyhorse-i2v",
  "happyhorse-r2v",
  "wanx-t2v",
  "wanx-i2v",
  "wanx-r2v",
  "happyhorse-video-edit",
  "pippit-video",
  "pippit-video-2",
  "wanx-video-edit",
  "volcengine-video",
  "pippit-marketing",
  "aliyun-super-resolve",
  "aliyun-erase-subtitles",
  "aliyun-video-cover",
  "video-edit",
  "drama-shot-video",
  "seedance-25-video",
  "aliyun-detect-shot",
  "minimax-h3-context-ir",
  "minimax-h3-regeneration",
] as const;

type Category = keyof typeof expectedCategoryCounts;
type AlignmentStatus = keyof typeof expectedStatusCounts;

type AlignmentTool = {
  slug: string;
  name: string;
  category: string;
  localRoute: string;
  status: string;
  acceptanceId: string;
};

type Manifest = {
  schemaVersion: string;
  snapshot: {
    source: string;
    capturedAt: string;
    activeTotal: number;
    categoryCounts: Record<string, number>;
  };
  coverageCounts: Record<string, number>;
  tools: AlignmentTool[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error("tool alignment verification failed: " + message);
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

assert(
  manifest.schemaVersion === "short-drama-tool-alignment.v1",
  "unexpected schemaVersion",
);
assert(
  manifest.snapshot.source === "https://youcai.art/api/tools",
  "unexpected snapshot source",
);
assert(manifest.snapshot.capturedAt === "2026-08-23", "unexpected snapshot date");
assert(manifest.snapshot.activeTotal === 67, "snapshot activeTotal must be 67");
assert(Array.isArray(manifest.tools), "tools must be an array");
assert(manifest.tools.length === 67, "tools length must be 67");

const allowedCategories = new Set<Category>(
  Object.keys(expectedCategoryCounts) as Category[],
);
const allowedStatuses = new Set<AlignmentStatus>(
  Object.keys(expectedStatusCounts) as AlignmentStatus[],
);
const observedCategoryCounts = Object.fromEntries(
  Object.keys(expectedCategoryCounts).map((category) => [category, 0]),
) as Record<Category, number>;
const observedStatusCounts = Object.fromEntries(
  Object.keys(expectedStatusCounts).map((status) => [status, 0]),
) as Record<AlignmentStatus, number>;
const slugs = new Set<string>();
const acceptanceIds = new Set<string>();

manifest.tools.forEach((tool, index) => {
  assert(typeof tool.slug === "string" && tool.slug.length > 0, "empty slug at index " + index);
  assert(tool.slug === expectedSlugs[index], "unexpected slug or order at index " + index);
  assert(!slugs.has(tool.slug), "duplicate slug: " + tool.slug);
  slugs.add(tool.slug);

  assert(typeof tool.name === "string" && tool.name.trim().length > 0, "empty name: " + tool.slug);
  assert(allowedCategories.has(tool.category as Category), "invalid category: " + tool.category);
  observedCategoryCounts[tool.category as Category] += 1;

  assert(allowedStatuses.has(tool.status as AlignmentStatus), "invalid status: " + tool.status);
  observedStatusCounts[tool.status as AlignmentStatus] += 1;

  assert(
    /^\/(?!\/)[^\\\s]*$/.test(tool.localRoute) && !tool.localRoute.includes("://"),
    "localRoute must be site-internal: " + tool.slug,
  );
  assert(
    /^ALIGN-(AUDIO|CANVAS|FILM|IMAGE|TEXT|VIDEO)-\d{3}$/.test(tool.acceptanceId),
    "invalid acceptanceId: " + tool.slug,
  );
  assert(!acceptanceIds.has(tool.acceptanceId), "duplicate acceptanceId: " + tool.acceptanceId);
  acceptanceIds.add(tool.acceptanceId);
});

for (const [category, expected] of Object.entries(expectedCategoryCounts)) {
  assert(
    manifest.snapshot.categoryCounts[category] === expected,
    "snapshot category count mismatch: " + category,
  );
  assert(
    observedCategoryCounts[category as Category] === expected,
    "observed category count mismatch: " + category,
  );
}

for (const [status, expected] of Object.entries(expectedStatusCounts)) {
  assert(
    manifest.coverageCounts[status] === expected,
    "declared coverage count mismatch: " + status,
  );
  assert(
    observedStatusCounts[status as AlignmentStatus] === expected,
    "observed status count mismatch: " + status,
  );
}

const implemented = manifest.tools.filter((tool) => tool.status === "implemented");
assert(
  implemented.length === 1 && implemented[0]?.slug === "general-script",
  "only general-script may be marked implemented in this snapshot",
);
assert(
  implemented[0]?.localRoute === "/tools/text/general-script",
  "general-script must use its implemented local route",
);

console.log("PASS short-drama tool alignment manifest");
console.log("tools=67 categories=text:10,image:16,video:27,audio:12,canvas:1,film-studio:1");
console.log("coverage=implemented:1,reused_main_capability:18,model_binding_required:39,not_planned:9");
console.log("network_calls=0");
