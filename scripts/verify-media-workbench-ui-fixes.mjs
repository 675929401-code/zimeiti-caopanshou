import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  cover: await readFile(new URL("../src/components/cover-studio.tsx", import.meta.url), "utf8"),
  coverCss: await readFile(new URL("../src/app/cover/cover-studio-v2.css", import.meta.url), "utf8"),
  globals: await readFile(new URL("../src/app/globals.css", import.meta.url), "utf8"),
  storyboard: await readFile(new URL("../src/components/storyboard-workbench.tsx", import.meta.url), "utf8"),
  storyboardCss: await readFile(new URL("../src/app/storyboard-workbench/storyboard-workbench.css", import.meta.url), "utf8"),
  video: await readFile(new URL("../src/app/video/page.tsx", import.meta.url), "utf8"),
  videoHistory: await readFile(new URL("../src/components/video-history-gallery.tsx", import.meta.url), "utf8"),
};

const checks = [
  ["cover toolbar uses grid", files.coverCss.includes(".cover-single-toolbar {\n  display: grid;")],
  ["cover stage accepts variable toolbar height", files.coverCss.includes(".cover-rebuild-stage {\n  display: flex;")],
  ["cover active ratio has solid contrast", files.coverCss.includes("background: linear-gradient(135deg, #087f96, #245ed0);")],
  ["cover preview surfaces use scoped palette", files.coverCss.includes("--cover-preview-surface: #10283b;") && files.coverCss.includes(".cover-rebuild-shell .cover-main-preview.is-running")],
  ["cover enlarged image remains available by clicking result", files.cover.includes('className="cover-result-image-button"')],
  ["cover redundant enlarge toolbar action removed", !files.cover.includes(">放大预览</button>")],
  ["cover preview footer wraps", files.coverCss.includes(".cover-preview-meta {\n  min-width: 0;\n  flex-wrap: wrap;")],
  ["invalid primary alpha CSS removed", !/var\(--primary\)\s*\/\s*\d/.test(files.globals) && !/var\(--primary\)\s*\/\s*\d/.test(files.video)],
  ["video result poster falls back to first frame", files.video.includes("poster={task.thumbnailUrl || task.firstFrameUrl || undefined}")],
  ["video page owns one history heading", files.video.includes("retentionDays={3} hideToolbar") && files.videoHistory.includes("!hideToolbar && <div className={styles.toolbar}")],
  ["video input images open an accessible preview", files.video.includes("setInputImagePreview({ src: task.firstFrameUrl") && files.video.includes('aria-label="关闭图片预览"')],
  ["storyboard light ratio is legible", files.storyboardCss.includes('html[data-mode="light"] .sbw-root .sbw-ratio-control button.is-active') && files.storyboardCss.includes("background: #0e7490;")],
  ["storyboard history media is not cropped", /\.sbw-history-project-media img,[\s\S]*?object-fit: contain;/.test(files.storyboardCss)],
  ["storyboard import notice is removed", !files.storyboard.includes("导入智能体输出")],
];

for (const [name, passed] of checks) assert.equal(passed, true, name);
console.log(`media workbench UI regression: ${checks.length}/${checks.length} assertions passed`);
