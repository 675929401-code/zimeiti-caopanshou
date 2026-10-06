import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const root = process.cwd();
const output = path.resolve(".codex-evidence/media-history-page-preview-contract-20260929");
fs.mkdirSync(output, { recursive: true });

function packagePath(name) {
  const packageRoot = path.join(root, "node_modules/.pnpm");
  const entry = fs.readdirSync(packageRoot).find((value) => value.startsWith(`${name}@`));
  assert.ok(entry, `${name} must be installed`);
  return path.join(packageRoot, entry, "node_modules", name);
}

const { build } = require(packagePath("esbuild"));
const pageSource = fs.readFileSync(path.join(root, "src/app/media-history/page.tsx"), "utf8");
const previewStart = pageSource.indexOf("function LazyMediaPreview(");
const previewEnd = pageSource.indexOf("\nexport default function MediaHistoryPage", previewStart);
assert.ok(previewStart >= 0 && previewEnd > previewStart, "must extract the actual LazyMediaPreview source");
const lazyMediaPreviewSource = pageSource.slice(previewStart, previewEnd);

const fixtureSource = `
  import React, { useEffect, useRef, useState } from "react";
  import { createRoot } from "react-dom/client";
  import { MediaHistoryVideoPreview } from "./src/components/media-history-video-preview";

  type MediaStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
  interface MediaHistoryItem {
    id: string;
    kind: "image" | "video";
    title: string;
    status: MediaStatus;
    previewPath: string;
    thumbnailPath: string;
  }

  const styles = new Proxy({}, { get: (_target, key) => String(key) }) as Record<string, string>;
  const FixtureIcon = (props: Record<string, unknown>) => <span {...props} />;
  const Film = FixtureIcon;
  const FileImage = FixtureIcon;
  const RefreshCw = FixtureIcon;
  async function acquireThumbnailFetchSlot(_signal: AbortSignal): Promise<() => void> {
    return () => undefined;
  }

  ${lazyMediaPreviewSource}

  const token = "fixture-account-token";
  const items: Array<{ wrapper: string; item: MediaHistoryItem }> = [
    { wrapper: "completed-image", item: { id: "image:visible", kind: "image", title: "完成图片", status: "completed", previewPath: "/api/media-history/content?id=visible", thumbnailPath: "" } },
    { wrapper: "completed-video", item: { id: "video:visible", kind: "video", title: "完成视频", status: "completed", previewPath: "/api/video/storage/visible-video", thumbnailPath: "/api/video/thumbnail/visible-video" } },
    { wrapper: "processing-image", item: { id: "image:processing", kind: "image", title: "处理中图片", status: "processing", previewPath: "/api/media-history/content?id=processing", thumbnailPath: "" } },
    { wrapper: "failed-video", item: { id: "video:failed", kind: "video", title: "失败视频", status: "failed", previewPath: "/api/video/storage/failed-video", thumbnailPath: "/api/video/thumbnail/failed-video" } },
    { wrapper: "offscreen-image", item: { id: "image:offscreen", kind: "image", title: "视区外图片", status: "completed", previewPath: "/api/media-history/content?id=offscreen", thumbnailPath: "" } },
  ];

  function Fixture() {
    return <main>
      {items.map(({ wrapper, item }, index) => <section
        key={item.id}
        data-fixture={wrapper}
        className={index === items.length - 1 ? "offscreen" : "onscreen"}
      ><LazyMediaPreview item={item} token={token} /></section>)}
    </main>;
  }

  createRoot(document.getElementById("root")!).render(<Fixture />);
`;

const bundle = await build({
  stdin: { contents: fixtureSource, resolveDir: root, loader: "tsx" },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
});

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const origin = "http://media-history-page.test";
const requests = [];
const pageErrors = [];
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, "fixture must block every external request");
    assert.equal(request.method(), "GET", "fixture must never issue a mutation");
    if (url.pathname === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<div id="root"></div><style>
          body{margin:0;background:#071a22;color:white}.onscreen,.offscreen{height:180px;margin:12px}.offscreen{margin-top:1800px}
          .preview{position:relative;height:180px;width:320px}.preview img,.preview video{width:100%;height:100%;object-fit:cover}
        </style><script src="/fixture.js"></script>`,
      });
    }
    if (url.pathname === "/fixture.js") {
      return route.fulfill({ contentType: "text/javascript", body: bundle.outputFiles[0].text });
    }
    const headers = await request.allHeaders();
    requests.push({ path: url.pathname, query: url.search, method: request.method(), authorization: headers.authorization || "" });
    assert.equal(headers.authorization, "Bearer fixture-account-token", "protected previews must use the account token in a header");
    if (url.pathname === "/api/media-history/content" || url.pathname.startsWith("/api/video/thumbnail/")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
    }
    throw new Error(`unexpected fixture request: ${url.pathname}`);
  });

  await page.goto(origin);
  await page.getByAltText("完成图片 图片预览").waitFor();
  await page.getByAltText("完成视频 视频首帧").waitFor();
  await page.getByText("生成完成后显示作品预览").waitFor();
  await page.getByText("任务未交付，暂无可用预览").waitFor();

  assert.equal(await page.locator("[data-media-preview]").count(), 5, "every fixture card must mount LazyMediaPreview");
  assert.equal(requests.filter((request) => request.query.includes("id=visible")).length, 1, "visible completed image must fetch once");
  assert.equal(requests.filter((request) => request.path === "/api/video/thumbnail/visible-video").length, 1, "visible completed video must fetch its first frame once");
  assert.equal(requests.some((request) => request.query.includes("id=processing")), false, "processing image must remain a placeholder");
  assert.equal(requests.some((request) => request.path.includes("failed-video")), false, "failed video must remain a placeholder");
  assert.equal(requests.some((request) => request.query.includes("id=offscreen")), false, "offscreen image must not fetch before intersection");

  await page.locator('[data-fixture="offscreen-image"]').scrollIntoViewIfNeeded();
  await page.getByAltText("视区外图片 图片预览").waitFor();
  assert.equal(requests.filter((request) => request.query.includes("id=offscreen")).length, 1, "offscreen image must fetch exactly once after intersection");
  assert.deepEqual(pageErrors, []);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests.every((request) => request.authorization === "Bearer fixture-account-token"));

  await page.screenshot({ path: path.join(output, "lazy-previews.png"), fullPage: true });
  const report = {
    ok: true,
    mode: "actual LazyMediaPreview source bundled into an isolated browser; all HTTP responses are fixtures",
    checks: [
      "every card mounts LazyMediaPreview",
      "completed image renders authenticated Blob preview",
      "completed video renders authenticated first-frame thumbnail",
      "processing and failed records stay placeholders without media reads",
      "offscreen image waits for IntersectionObserver then loads once",
    ],
    requests,
    pageErrors,
    supplierRequests: 0,
    databaseWrites: 0,
    paidRequests: 0,
  };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
