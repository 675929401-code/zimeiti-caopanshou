import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SHORT_DRAMA_ENTRY_CARDS,
  SHORT_DRAMA_FEATURED_TEMPLATE,
  SHORT_DRAMA_UTILITY_LINKS,
  SHORT_DRAMA_WORKFLOW_STEPS,
} from "../src/lib/short-drama-navigation";
import { INSPIRATION_EXAMPLES } from "../src/features/short-drama/inspiration-catalog";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const projectRoot = process.cwd();
const checks: CheckResult[] = [];
const require = createRequire(import.meta.url);

function check(name: string, condition: boolean, detail: string) {
  checks.push({ name, ok: condition, detail });
}

function read(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(relativePath: string): string {
  return createHash("sha256").update(readFileSync(join(projectRoot, relativePath))).digest("hex").toUpperCase();
}

function inspectMedia(relativePath: string) {
  const absolutePath = join(projectRoot, relativePath);
  const ffmpegPath = require("ffmpeg-static") as string | null;
  if (!ffmpegPath || !existsSync(ffmpegPath)) return null;
  const nullTarget = process.platform === "win32" ? "NUL" : "/dev/null";
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-i", absolutePath, "-f", "null", nullTarget], {
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const resolutionMatch = output.match(/Stream #.*Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!durationMatch || !resolutionMatch) return null;
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  return {
    duration,
    width: Number(resolutionMatch[1]),
    height: Number(resolutionMatch[2]),
    hasAudio: /Stream #.*Audio:/m.test(output),
    decodes: result.status === 0,
  };
}

function hasMp4Signature(relativePath: string): boolean {
  const bytes = readFileSync(join(projectRoot, relativePath));
  return bytes.length > 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function hasWebmSignature(relativePath: string): boolean {
  const bytes = readFileSync(join(projectRoot, relativePath));
  return bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

const requiredFiles = [
  "public/short-drama/assets-manifest.json",
  "src/app/short-drama/page.tsx",
  "src/app/short-drama/loading.tsx",
  "src/app/short-drama/error.tsx",
  "src/app/short-drama/short-drama.module.css",
  "src/app/inspiration/page.tsx",
  "src/app/inspiration/loading.tsx",
  "src/app/inspiration/error.tsx",
  "src/features/short-drama/short-drama-portal.tsx",
  "src/features/short-drama/formal-script-unavailable.tsx",
  "src/features/short-drama/inspiration-gallery.tsx",
  "src/features/short-drama/inspiration-catalog.ts",
  "src/features/short-drama/route-state.tsx",
  "src/features/short-drama/types.ts",
  "src/lib/short-drama-navigation.ts",
  "src/app/tools/text/formal-script/page.tsx",
  "src/app/youcai/tools/text/formal-script/page.tsx",
];

for (const relativePath of requiredFiles) {
  check(`file:${relativePath}`, existsSync(join(projectRoot, relativePath)), "required local source file exists");
}

check(
  "entry-card-count",
  SHORT_DRAMA_ENTRY_CARDS.length === 4,
  `expected 4 entry cards, found ${SHORT_DRAMA_ENTRY_CARDS.length}`,
);
check(
  "entry-card-titles",
  ["爽剧", "短剧", "正剧", "上传剧本"].every((title) =>
    SHORT_DRAMA_ENTRY_CARDS.some((entry) => entry.title === title)),
  "four required entry titles are configured",
);
check(
  "formal-drama-truthful-degradation",
  SHORT_DRAMA_ENTRY_CARDS.some((entry: { key: string; status?: string; href?: string | null; description?: string }) =>
    entry.key === "正剧" &&
    entry.status === "coming-soon" &&
    entry.href === null &&
    entry.description?.includes("暂不可用")),
  "正剧 remains visibly unavailable until an independent backend is accepted",
);

check(
  "workflow-six-steps",
  SHORT_DRAMA_WORKFLOW_STEPS.length === 6 &&
    SHORT_DRAMA_WORKFLOW_STEPS.map((step) => step.key).join(",") === "剧本,角色,场景,道具,分镜,视频",
  "workflow order is 剧本→角色→场景→道具→分镜→视频",
);

const allConfiguredHrefs = [
  ...SHORT_DRAMA_ENTRY_CARDS.flatMap((entry) => entry.href ? [entry.href] : []),
  ...SHORT_DRAMA_WORKFLOW_STEPS.map((step) => step.href),
  ...SHORT_DRAMA_UTILITY_LINKS.map((link) => link.href),
  SHORT_DRAMA_FEATURED_TEMPLATE.href,
  ...INSPIRATION_EXAMPLES.flatMap((example) => [example.primaryHref]),
];

check(
  "same-origin-links",
  allConfiguredHrefs.every((href) => href.startsWith("/") && !href.startsWith("//")),
  "every configured destination is a same-origin path",
);

for (const route of ["/storyboard-workbench", "/free-canvas", "/video", "/voice-studio", "/media-history"]) {
  check(
    `reused-route:${route}`,
    allConfiguredHrefs.some((href) => href === route || href.startsWith(`${route}?`)),
    `${route} is reused by the short-drama portal`,
  );
}

check(
  "pet-silent-template",
  SHORT_DRAMA_FEATURED_TEMPLATE.href === "/tools/text/general-script?profile=pet-silent-narration" &&
    SHORT_DRAMA_FEATURED_TEMPLATE.variables.join(",") === "文案,动画风格,视频尺寸" &&
    SHORT_DRAMA_FEATURED_TEMPLATE.constraints.includes("人物不张嘴") &&
    SHORT_DRAMA_FEATURED_TEMPLATE.constraints.includes("宠物不张嘴"),
  "宠物无对白口播 uses three variables and no-mouth-dialogue constraints",
);

const originalAssetPaths = [
  "/short-drama/hero-pipeline-v1.png",
  ...INSPIRATION_EXAMPLES.map((example) => example.imagePath),
];

const heroVideoAssets = [
  { relativePath: "public/short-drama/hero-pipeline-loop-v1.mp4", mime: "video/mp4" },
  { relativePath: "public/short-drama/hero-pipeline-loop-v1.webm", mime: "video/webm" },
] as const;

for (const assetPath of originalAssetPaths) {
  const localPath = join(projectRoot, "public", assetPath.replace(/^\//, ""));
  check(`asset:${assetPath}`, existsSync(localPath), "referenced original local asset exists");
}

for (const media of heroVideoAssets) {
  const absolutePath = join(projectRoot, media.relativePath);
  check(`media-file:${media.mime}`, existsSync(absolutePath), `${media.mime} hero loop exists`);
  if (!existsSync(absolutePath)) continue;
  const signatureOk = media.mime === "video/mp4"
    ? hasMp4Signature(media.relativePath)
    : hasWebmSignature(media.relativePath);
  check(`media-mime:${media.mime}`, signatureOk, `${media.mime} container signature matches its declared MIME`);
  const mediaInfo = inspectMedia(media.relativePath);
  check(`media-decode:${media.mime}`, Boolean(mediaInfo?.decodes), `${media.mime} decodes completely with local FFmpeg`);
  check(
    `media-duration:${media.mime}`,
    Boolean(mediaInfo && mediaInfo.duration >= 8 && mediaInfo.duration <= 12),
    `${media.mime} duration is ${mediaInfo?.duration ?? "unknown"} seconds`,
  );
  check(
    `media-dimensions:${media.mime}`,
    Boolean(mediaInfo && mediaInfo.width === 1914 && mediaInfo.height === 820),
    `${media.mime} dimensions are ${mediaInfo?.width ?? "unknown"}x${mediaInfo?.height ?? "unknown"}`,
  );
  check(`media-silent:${media.mime}`, mediaInfo?.hasAudio === false, `${media.mime} contains no audio stream`);
}

const assetManifest = JSON.parse(read("public/short-drama/assets-manifest.json")) as unknown;
const manifestAssets = isRecord(assetManifest) && Array.isArray(assetManifest.assets)
  ? assetManifest.assets.filter(isRecord)
  : [];
for (const media of heroVideoAssets) {
  const publicPath = `/${media.relativePath.replace(/^public\//, "")}`;
  const manifestEntry = manifestAssets.find((entry) => entry.path === publicPath);
  check(`manifest-entry:${media.mime}`, Boolean(manifestEntry), `${media.mime} is registered in assets-manifest.json`);
  if (!manifestEntry) continue;
  check(
    `manifest-metadata:${media.mime}`,
    manifestEntry.mimeType === media.mime &&
      manifestEntry.durationSeconds === 10 &&
      manifestEntry.width === 1914 &&
      manifestEntry.height === 820 &&
      manifestEntry.audio === false &&
      manifestEntry.derivedFrom === "/short-drama/hero-pipeline-v1.png",
    `${media.mime} manifest metadata matches the encoded media`,
  );
  check(
    `manifest-checksum:${media.mime}`,
    manifestEntry.sha256 === sha256(media.relativePath) &&
      manifestEntry.fileBytes === readFileSync(join(projectRoot, media.relativePath)).byteLength,
    `${media.mime} manifest checksum and byte length match the file`,
  );
}

check(
  "local-inspiration-assets-only",
  INSPIRATION_EXAMPLES.every((example) => example.imagePath.startsWith("/short-drama/") && !example.imagePath.startsWith("//")),
  "every inspiration image points to public/short-drama",
);

if (requiredFiles.every((relativePath) => existsSync(join(projectRoot, relativePath)))) {
  const portalSource = read("src/features/short-drama/short-drama-portal.tsx");
  const gallerySource = read("src/features/short-drama/inspiration-gallery.tsx");
  const catalogSource = read("src/features/short-drama/inspiration-catalog.ts");
  const navigationSource = read("src/lib/short-drama-navigation.ts");
  const formalUnavailableSource = read("src/features/short-drama/formal-script-unavailable.tsx");
  const formalMainPageSource = read("src/app/tools/text/formal-script/page.tsx");
  const formalYoucaiPageSource = read("src/app/youcai/tools/text/formal-script/page.tsx");
  const cssSource = read("src/app/short-drama/short-drama.module.css");
  const inspectedSource = [portalSource, gallerySource, catalogSource, navigationSource].join("\n");

  for (const stateName of ["loading", "signed-out", "unavailable", "error", "ready"]) {
    check(
      `project-state:${stateName}`,
      portalSource.includes(`kind: \"${stateName}\"`) || portalSource.includes(`kind === \"${stateName}\"`),
      `project library handles ${stateName}`,
    );
  }
  check("project-empty-state", portalSource.includes("还没有短剧项目"), "project library has an actionable empty state");
  check(
    "project-auth-boundary",
    portalSource.includes("登录后查看项目") && portalSource.includes("登录后刷新") && portalSource.includes("disabled={projectState.kind === \"loading\" || projectState.kind === \"signed-out\"}"),
    "signed-out project library exposes login guidance and cannot refresh into a dead action",
  );
  check(
    "project-api-read-only",
    portalSource.includes("/api/short-drama/projects") && !portalSource.includes("method: \"POST\"") && !portalSource.includes("method: \"DELETE\""),
    "portal only attempts a read-only project library request",
  );
  check(
    "project-api-contract-adapter",
    portalSource.includes("item.projectType") &&
      portalSource.includes("settings.aspectRatio") &&
      portalSource.includes("sourcePayload.currentStage") &&
      portalSource.includes("generating"),
    "portal adapts the core API projectType/settings/sourcePayload/status fields",
  );
check(
  "film-banner-local-image",
  portalSource.includes('src="/short-drama/previews/hero-pipeline-v1.webp"') &&
    portalSource.includes("影视创作工坊全流程横幅") &&
    portalSource.includes("自媒体操盘手原创 AI 影视制作流程横幅"),
  "film studio banner uses the lightweight local production pipeline preview and truthful workflow copy",
);
  check(
    "formal-route-degradation",
    formalUnavailableSource.includes("正剧独立工作流暂不可用") &&
      navigationSource.includes('href: null') &&
      navigationSource.includes('status: "coming-soon"') &&
      formalMainPageSource.includes('redirect("/tools/text/general-script")') &&
      formalYoucaiPageSource.includes('redirect("/youcai/tools/text/general-script")') &&
      !formalMainPageSource.includes("GeneralScriptOfficial") &&
      !formalYoucaiPageSource.includes("GeneralScriptOfficial"),
    "formal-script stays hidden while legacy URLs move directly to the accepted general-script workflow",
  );
  check(
    "reduced-motion-css",
    cssSource.includes("prefers-reduced-motion: reduce"),
    "the portal keeps a reduced-motion CSS branch for animated interactions",
  );
  check("scoped-css", !cssSource.includes(":global"), "short-drama CSS module contains no global escape");
  for (const selector of [
    ".root",
    ".entryGrid",
    ".projectGrid",
    ".featuredTemplate",
    ".templateTags",
    ".templateConstraints",
    ".workflowList",
    ".workflowCard",
    ".statePanel",
  ]) {
    check(`css-selector:${selector}`, cssSource.includes(selector), `${selector} is defined in the dedicated CSS module`);
  }
  check(
    "no-benchmark-assets",
    !/youcai\.art|github\.com\/oiuv|https?:\/\//i.test(inspectedSource),
    "new portal and inspiration sources contain no benchmark-domain or remote asset URLs",
  );
  check(
    "inspiration-empty-state",
    gallerySource.includes("没有匹配的灵感示例") && gallerySource.includes("清空筛选"),
    "inspiration filtering has an actionable empty state",
  );
}

const failed = checks.filter((result) => !result.ok);
const output = {
  ok: failed.length === 0,
  totals: {
    checks: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
  },
  failures: failed,
};

console.log(JSON.stringify(output, null, 2));
if (failed.length > 0) process.exitCode = 1;
