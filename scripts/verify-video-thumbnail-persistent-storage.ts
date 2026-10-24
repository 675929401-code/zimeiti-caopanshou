import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const proxyRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/video/proxy/route.ts"),
  "utf8",
);
const thumbnailRoute = readFileSync(
  resolve(process.cwd(), "src/app/api/video/thumbnail/[taskId]/route.ts"),
  "utf8",
);

assert.match(
  proxyRoute,
  /const trustedMediaHostnames = \[\.\.\.new Set\(\[[\s\S]*?\.\.\.trustedRelayHostnamesFromEnv\(\),[\s\S]*?trustedPersistentStorageHostname,[\s\S]*?trustedProviderResultHostname,[\s\S]*?\]\.filter\(Boolean\)\)\];/u,
  "视频代理必须为已验证的永久对象存储地址建立精确 hostname 信任列表",
);
assert.match(
  proxyRoute,
  /await validateSafeUrl\(videoUrl, \{\s*trustedHostnames: trustedMediaHostnames,/u,
  "URL 安全校验与实际回源必须复用同一 hostname 信任边界",
);

const directFetch = proxyRoute.match(
  /await safeMediaFetch\(videoUrl, \{[\s\S]*?trustedHostnames: trustedMediaHostnames,[\s\S]*?\}\);/u,
);
assert.ok(directFetch, "截首帧的直接媒体回源缺少永久存储 hostname 信任列表");

const fallbackFetch = proxyRoute.match(
  /await safeMediaFetch\(contentUrl, \{[\s\S]*?trustedHostnames: trustedMediaHostnames,[\s\S]*?\}\);/u,
);
assert.ok(fallbackFetch, "供应商 content 备用回源缺少统一 hostname 信任列表");

assert.match(
  thumbnailRoute,
  /createVideoAccessUrl\(\{[\s\S]*?scope: "playback",[\s\S]*?forCapture: true,/u,
  "首帧接口必须通过任务绑定的内部播放票据进入截帧回源",
);
assert.match(
  thumbnailRoute,
  /await extractVideoThumbnail\(new URL\(relativeVideoUrl, origin\)\.toString\(\),/u,
  "首帧接口必须从受控内部代理下载视频后截帧",
);

console.log("视频永久存储首帧回源合同通过：安全校验与实际流式回源共用精确 hostname 信任边界。");
