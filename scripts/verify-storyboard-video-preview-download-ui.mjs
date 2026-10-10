import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const componentPath = path.join(root, "src", "components", "storyboard-workbench.tsx");
const cssPath = path.join(root, "src", "app", "storyboard-workbench", "storyboard-workbench.css");
const [source, css] = await Promise.all([
  readFile(componentPath, "utf8"),
  readFile(cssPath, "utf8"),
]);

const videoDownloadStart = source.indexOf("async function openVideoDownload");
const videoDownloadEnd = source.indexOf("type PreviewMedia", videoDownloadStart);
assert.ok(videoDownloadStart >= 0 && videoDownloadEnd > videoDownloadStart, "video download helper must exist");
const videoDownload = source.slice(videoDownloadStart, videoDownloadEnd);
assert.match(videoDownload, /if \(!taskId\) throw new Error/u, "video downloads must reject records without a task id");
assert.match(videoDownload, /scope: "download"/u, "video downloads must request a download-scope ticket");
assert.match(videoDownload, /triggerDownload\(ticketUrl, filename\)/u, "only the ticket URL may reach the browser download");
assert.doesNotMatch(videoDownload, /catch\s*\(/u, "ticket failures must not fall back to an old URL");
assert.doesNotMatch(videoDownload, /triggerDownload\(url/u, "video downloads must not use the stored playback URL");
assert.match(source, /openVideoDownload\([\s\S]*?\.catch\(\(error\) => setNotice/u, "ticket failures must be surfaced to the user");
assert.match(source, /disabled=\{!card\.videoTaskId\}/u, "video downloads without a task id must remain unavailable");

assert.match(source, /const PREVIEW_ZOOM_MIN = 0\.7;/u, "preview minimum zoom must be 70%");
assert.match(source, /const PREVIEW_ZOOM_MAX = 1\.4;/u, "preview maximum zoom must be 140%");
assert.match(source, /createPortal\([\s\S]*document\.body/u, "the lightbox must portal to document.body");
assert.match(source, /role="toolbar" aria-label="媒体预览工具栏"/u, "the lightbox toolbar must be named");
assert.match(source, /document\.addEventListener\("keydown", closeOnEscape, true\)/u, "Escape must close the lightbox from the capture phase");
assert.match(source, /event\.target === event\.currentTarget && close\(\)/u, "backdrop clicks must close the lightbox");
assert.match(source, /requestFullscreen\(\)/u, "the lightbox must offer native fullscreen");
assert.match(source, /<video[^>]*controls autoPlay playsInline/u, "lightbox video must keep controls and inline playback");

assert.match(css, /\.sbw-lightbox\s*\{[\s\S]*?z-index:\s*1100;/u, "portal lightbox must clear the application stacking contexts");
assert.match(css, /\.sbw-lightbox-toolbar button:focus-visible/u, "toolbar controls must expose keyboard focus");
assert.match(css, /\.sbw-lightbox-stage\s*\{[\s\S]*?overflow:\s*auto;/u, "zoomed media must remain navigable");

console.log(JSON.stringify({
  ok: true,
  checks: 19,
  providerCalls: 0,
  generationCalls: 0,
  billingWrites: 0,
}, null, 2));
