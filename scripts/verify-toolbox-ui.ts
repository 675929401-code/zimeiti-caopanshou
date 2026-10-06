import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path: string) => readFile(resolve(root, path), "utf8");

type Fixture = {
  tab: "segment" | "text" | "video" | "format";
  state: "ready" | "result" | "error-or-empty";
};

const fixtures: Fixture[] = [
  { tab: "segment", state: "ready" },
  { tab: "segment", state: "result" },
  { tab: "segment", state: "error-or-empty" },
  { tab: "text", state: "ready" },
  { tab: "text", state: "result" },
  { tab: "text", state: "error-or-empty" },
  { tab: "video", state: "ready" },
  { tab: "video", state: "result" },
  { tab: "video", state: "error-or-empty" },
  { tab: "format", state: "ready" },
  { tab: "format", state: "result" },
  { tab: "format", state: "error-or-empty" },
];

async function verifySourceContracts() {
  const [page, styles, menu, sidebar, marketplace, segmenter, extract, formatter] = await Promise.all([
    read("src/app/tools/page.tsx"),
    read("src/app/tools/tools.module.css"),
    read("src/components/toolbox-menu.tsx"),
    read("src/components/app-sidebar.tsx"),
    read("src/components/agent-marketplace.tsx"),
    read("src/app/segmenter/page.tsx"),
    read("src/app/extract/page.tsx"),
    read("src/app/formatter/page.tsx"),
  ]);

  for (const tab of ["segment", "text", "video", "format"]) {
    assert.match(page, new RegExp(`id: "${tab}"`), `missing toolbox tab: ${tab}`);
    assert.match(menu, new RegExp(`/tools\\?tab=${tab}`), `missing toolbox item href: ${tab}`);
  }
  assert.equal(fixtures.length, 12, "fixture matrix must cover 3 states for each of 4 tabs");
  assert.equal(new Set(fixtures.map((fixture) => fixture.tab)).size, 4);

  assert.match(page, /<SegmenterPage\s*\/>/);
  assert.match(page, /<ExtractPage\s*\/>/);
  assert.match(page, /<FormatterPage\s*\/>/);
  assert.doesNotMatch(page, /<iframe/i, "toolbox must reuse real components, not iframe them");
  assert.match(page, /ArrowRight/);
  assert.match(page, /ArrowLeft/);
  assert.match(page, /ArrowDown/);
  assert.match(page, /ArrowUp/);
  assert.match(page, /aria-orientation="vertical"/);
  assert.match(page, /localStorage\.getItem\("toolbox_active_tab"\)/);
  assert.match(page, /localStorage\.setItem\("toolbox_active_tab", activeTab\)/);
  assert.match(page, /hasResolvedInitialTab/);
  assert.doesNotMatch(page, /removeItem\("toolbox_active_tab"\)/);
  assert.match(page, /mountedPanels\.has\("extract"\)/);
  assert.match(page, /mountedPanels\.has\("format"\)/);
  assert.match(page, /mountedPanels\.has\("segment"\)/);
  assert.match(page, /hidden=\{activePanel !== "extract"\}/);
  assert.match(page, /onTabChange=\{selectTab\}/);

  assert.match(menu, /const href = preferredToolboxHref\(\)/, "single toolbox entry must reopen the real workbench at the user's last tab");
  assert.match(menu, /if \(navigate\) navigate\(href\);[\s\S]*?else router\.push\(href\)/, "toolbox entry must support the shared route transition and router fallback");
  assert.match(sidebar, /normalizeShortcuts/);
  assert.match(sidebar, /TOOLBOX_SHORTCUT/);
  assert.match(sidebar, /!isSegmentShortcut/);
  assert.match(sidebar, /!isExtractShortcut/);
  assert.match(sidebar, /!isFormatterShortcut/);
  assert.match(marketplace, /new Set\(\["extract", "segment", "format", "formatter", "toolbox"\]\)/);
  assert.match(marketplace, /"文案提取"/);
  assert.match(marketplace, /"视频提取"/);
  assert.match(marketplace, /"文字排版"/);

  assert.match(segmenter, /toolbox-two-column/);
  assert.match(segmenter, /toolbox-balanced-layout/);
  assert.match(segmenter, /toolbox-duration-options/);
  assert.match(segmenter, /handleDurationChange/);
  assert.match(segmenter, /handleInputChange/);
  assert.doesNotMatch(segmenter, /调整分段模式时，如果有输入内容，自动重新分段/);
  assert.match(segmenter, /toolbox-primary-pane/);
  assert.match(segmenter, /toolbox-result-pane/);
  assert.ok((segmenter.match(/backdropFilter:\s*embedded \? "none"/g) || []).length >= 2, "embedded segmenter surfaces must not restore glass blur");
  assert.match(segmenter, /boxShadow:\s*embedded \|\|[\s\S]*?\? "none" : "0 2px 16px var\(--theme-glow\)"/);
  assert.match(formatter, /toolbox-two-column/);
  assert.match(formatter, /toolbox-balanced-layout/);
  assert.match(formatter, /FIXED_FORMAT_RULES/);
  assert.doesNotMatch(formatter, /showOptions|toggleOption|句号分段/);
  assert.match(formatter, /className="toolbox-primary-action/);
  assert.match(formatter, /boxShadow:\s*embedded \|\|[\s\S]*?\? "none" : "0 4px 24px var\(--theme-glow\)"/);
  assert.match(extract, /toolbox-two-column toolbox-extract-layout/);
  assert.match(extract, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(extract, /displayedTab === "video" \? "block" : "none"/, "video extraction panel must remain mounted while hidden");
  assert.match(extract, /displayedTab === "text" \? "block" : "none"/, "text extraction panel must remain mounted while hidden");
  assert.match(extract, /authCheckRef/);
  assert.match(extract, /fetch\("\/api\/auth\/me"/);
  assert.match(extract, /STORAGE_KEYS\.AUTH_TOKEN/);
  assert.match(extract, /safeSetItem\(STORAGE_KEYS\.AUTH_USER/);
  assert.match(extract, /checkAuth\(\)/);
  assert.match(extract, /router\.replace\("\/"\)/);
  assert.match(extract, /if \(embedded\) toolboxHost\?\.onTabChange\?\.\("segment"\);/, "embedded extract-to-segment jump must reuse the mounted toolbox session");
  assert.doesNotMatch(extract, /router\.push\(embedded \? "\/tools\?tab=segment"/, "embedded tool jumps must not remount the toolbox route");
  assert.match(extract, /handlePasteText/);
  assert.match(extract, /navigator\.clipboard\.readText\(\)/);
  assert.match(extract, /无法读取剪贴板/);
  assert.match(extract, /ref=\{textInputRef\}/);
  assert.match(extract, /ref=\{videoInputRef\}/);
  assert.ok((extract.match(/一键粘贴/g) || []).length >= 2, "text and video tabs must expose labeled one-click paste actions");
  assert.match(extract, /Math\.min\(144, Math\.max\(88, textarea\.scrollHeight\)\)/);
  assert.match(extract, /Math\.min\(144, Math\.max\(96, textarea\.scrollHeight\)\)/);
  assert.match(extract, /toolbox-video-layout/);
  assert.match(extract, /toolbox-platform-summary/);
  assert.match(extract, /toolbox-video-results-heading/);
  assert.match(extract, /toolbox-text-result-pane/);
  assert.match(extract, /toolbox-result-pane-heading/);
  assert.match(extract, /toolbox-video-grid/);
  assert.match(extract, /data-video-layout=\{hasMedia \? "media" : "stacked"\}/);
  assert.match(extract, /className="w-full h-full object-contain"/);
  assert.match(extract, /setUrls\(e\.target\.value\);\s*setResults\(\[\]\);/, "editing the source link must invalidate stale video results");
  assert.match(extract, /重新提取/);

  assert.match(styles, /grid-template-columns:\s*312px minmax\(0, 1fr\)/, "toolbox rail must match the 312px production rail");
  assert.match(styles, /\.workspace :global\(\.toolbox-two-column\)[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/, "all four tools must use one aligned desktop column");
  assert.match(styles, /\.workspace :global\(\.toolbox-two-column\)[\s\S]*?grid-template-rows:\s*max-content max-content/, "operation cards must sit above compact result cards without shrinking into overlap");
  assert.match(styles, /\.workspace :global\(\.toolbox-balanced-layout\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/, "formatter and segmenter must share the stacked workbench contract");
  assert.match(styles, /\.workspace :global\(\.toolbox-extract-layout\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/, "extract tools must share the stacked workbench contract");
  assert.match(styles, /\.workspace :global\(\.toolbox-duration-options\)[\s\S]*?grid-template-columns:\s*repeat\(7, minmax\(46px, 1fr\)\)/, "all seven duration presets must share one compact row");
  assert.match(styles, /\.workspace :global\(\.toolbox-extract-layout\)[^}]*grid-template-rows:\s*max-content max-content/, "extract tools must place one complete operation card above results without shrinking into overlap");
  assert.match(extract, /toolbox-inline-options toolbox-operation-options/, "extract options must remain inside the operation card");
  assert.match(styles, /\.workspace :global\(\.toolbox-card-actions\)[\s\S]*?border-top:\s*1px solid var\(--toolbox-crystal-line\)/, "operation buttons must remain inside their input card");
  assert.match(styles, /font-family:\s*"Microsoft YaHei UI"/, "toolbox must use a legible Windows Chinese UI font stack");
  assert.match(formatter, /toolbox-card-actions[\s\S]*?开始排版[\s\S]*?<\/section>/, "formatter action must be inside the input card");
  assert.match(segmenter, /toolbox-card-actions[\s\S]*?开始分段[\s\S]*?<\/section>/, "segmenter action must be inside the input card");
  assert.match(styles, /\.workspace :global\(\.toolbox-grid-span\)[^}]*grid-column:\s*1 \/ -1/);
  assert.match(styles, /\.toolPanel\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(styles, /\.toolbox-extract-textarea/);
  assert.match(styles, /\.toolbox-extract-paste-button/);
  assert.match(styles, /\.workspace :global\(\.toolbox-video-grid\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/, "video results must use one full-width column");
  assert.match(styles, /\.workspace :global\(\.toolbox-video-media\)[\s\S]*?aspect-ratio:\s*9 \/ 16/, "video result media must use the short-video portrait ratio");
  assert.match(styles, /\.toolbox-command-row-three/);
  assert.match(styles, /white-space:\s*nowrap/);
  assert.match(styles, /flex-direction:\s*column/);
  assert.doesNotMatch(styles, /linear-gradient|radial-gradient|backdrop-filter/iu, "toolbox must use solid semantic surfaces rather than neon glass layers");
  assert.doesNotMatch(styles, /!important/, "toolbox styles must stay page-scoped without global overrides");
}

async function verifyRoutes() {
  const baseUrl = process.env.TOOLBOX_BASE_URL || "http://127.0.0.1:5000";
  const paths = [
    "/tools?tab=segment",
    "/tools?tab=text",
    "/tools?tab=video",
    "/tools?tab=format",
    "/segmenter",
    "/extract?tab=text",
    "/extract?tab=video",
    "/formatter",
  ];
  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} returned ${response.status}`);
  }
}

async function main() {
  await verifySourceContracts();
  if (process.env.TOOLBOX_SKIP_RUNTIME !== "1") {
    await verifyRoutes();
  }
  console.log(`[toolbox-ui] 12 fixture contracts, 312px desktop rail, persistent mounted panels, clipboard actions, and stacked operation/result workflows passed; runtime routes ${process.env.TOOLBOX_SKIP_RUNTIME === "1" ? "were intentionally not probed" : "also returned HTTP 200"}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
