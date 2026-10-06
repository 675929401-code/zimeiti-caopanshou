import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const proxyRoute = read("src/app/api/video/proxy/route.ts");
const downloadRoute = read("src/app/api/video/proxy-download/route.ts");
const statusRoute = read("src/app/api/video/status/route.ts");
const taskStatusService = read("src/lib/video-task-status.ts");
const terminalFinalizer = read("src/lib/video-terminal-finalizer.ts");
const storageRoute = read("src/app/api/video/storage/[taskId]/route.ts");
const videoMediaAuth = read("src/lib/video-media-auth.ts");
const safeMediaFetchSource = read("src/lib/safe-media-fetch.ts");
const safeFetchSource = read("src/lib/safe-fetch.ts");
const canvas = read("src/components/manual-canvas.tsx");

const directFetch = proxyRoute.indexOf("await safeMediaFetch(videoUrl");
const fallbackFetch = proxyRoute.indexOf("await safeMediaFetch(contentUrl");
assert(directFetch >= 0, "视频代理缺少 safeMediaFetch 原始地址请求");
assert(fallbackFetch > directFetch, "视频代理必须先安全探测原始地址，再安全请求 /content 备用接口");
assert(!/await\s+fetch\(\s*(?:videoUrl|contentUrl)/u.test(proxyRoute), "视频代理不得绕过 safeMediaFetch 直连远程媒体");
assert(!proxyRoute.includes("跳过已知被墙CDN"), "视频代理仍在按域名硬编码跳过原始地址");
assert(!downloadRoute.includes("BLOCKED_CDN_DOMAINS"), "下载代理仍在按域名硬编码跳过原始地址");

const downloadDirectFetch = downloadRoute.indexOf("await safeMediaFetch(effectiveUrl");
const downloadFallbackFetch = downloadRoute.indexOf("downloadFromUrl(contentUrl");
assert(downloadDirectFetch >= 0, "下载代理缺少 safeMediaFetch 原始地址请求");
assert(downloadFallbackFetch > downloadDirectFetch, "下载代理的安全备用顺序不正确");
assert(downloadRoute.includes("await safeMediaFetch(downloadUrl"), "下载辅助函数必须统一使用 safeMediaFetch");
assert(!/await\s+fetch\(\s*(?:effectiveUrl|contentUrl|downloadUrl)/u.test(downloadRoute), "下载代理不得绕过 safeMediaFetch 直连远程媒体");

for (const marker of [
  "await safeFetchStream(current",
  "authorization,",
  "trustedHostnames,",
  "current = new URL(location, current)",
]) {
  assert(safeMediaFetchSource.includes(marker), `safeMediaFetch 安全封装缺少标记: ${marker}`);
}
for (const marker of ['sanitizedHeaders(options.headers)', 'authorizationOrigin === target.url.origin', 'redirect: "manual"', 'AbortSignal.timeout(timeoutMs)']) {
  assert(safeFetchSource.includes(marker), `safeFetchStream 安全封装缺少标记: ${marker}`);
}

assert(statusRoute.includes("readOwnedVideoTaskStatus"), "状态路由未委托账号归属的视频状态服务");
assert(taskStatusService.includes("finalizeVideoGenerationSuccess"), "视频状态服务未委托统一成功终态器");
assert(taskStatusService.includes("finalizeVideoGenerationFailure"), "视频状态服务未委托统一失败终态器");
assert(terminalFinalizer.includes('import { createVideoAccessUrl } from "@/lib/video-access-ticket"'), "统一终态器缺少短时媒体票据封装");
assert(
  /const playbackUrl = await createVideoAccessUrl\(\{\s*taskId: input\.taskIdInternal,\s*userId: input\.userId,\s*role: input\.userRole,\s*scope: "playback",\s*\}\)/u.test(terminalFinalizer),
  "播放地址必须使用任务与用户绑定的短时媒体票据",
);
assert(
  terminalFinalizer.indexOf('String(finalized.status || "") !== "completed"')
    < terminalFinalizer.indexOf("const playbackUrl = await createVideoAccessUrl"),
  "必须在原子终态确认完成后才签发播放票据",
);
assert(!statusRoute.includes("?token=${encodeURIComponent(token)}"), "播放地址泄露主登录令牌");
assert(storageRoute.includes('params.set("media_ticket", await createVideoAccessTicket({'), "存储回退缺少任务绑定媒体票据");
assert(storageRoute.includes('authorizeVideoMediaRequest(req, taskId, "playback")'), "存储路由未委托统一媒体鉴权");
assert(videoMediaAuth.includes("verifyVideoAccessTicket(ticket, { taskId, scope })"), "统一媒体鉴权未校验任务与播放票据范围");
assert(!storageRoute.includes("params.set(\"token\""), "存储路由仍把主登录令牌转发到代理 URL");

assert(canvas.includes('headers: { Range: "bytes=0-63" }'), "播放器缺少小字节源探测");
assert(canvas.includes("context.regenerateNode(id)"), "失败卡片缺少重新生成入口");
assert(canvas.includes("只检查现有任务，不会重新提交或扣费"), "免费重检与重新生成没有明确区分");
assert(canvas.includes("重新生成会创建新的${kindLabel}任务，可能再次计费"), "重新生成缺少二次计费确认");

async function main() {
  const sourceUrl = process.argv[2];
  if (sourceUrl) {
    const response = await fetch(sourceUrl, {
      headers: { Range: "bytes=0-63" },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    assert([200, 206].includes(response.status), `真实媒体源返回 ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    assert(contentType.startsWith("video/") || contentType.includes("octet-stream"), `真实媒体源类型异常：${contentType}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length > 0, "真实媒体源没有返回字节");
    const header = bytes.subarray(0, 32).toString("latin1");
    assert(
      header.includes("ftyp")
        || header.includes("webm")
        || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
      "真实媒体源头部不是可识别视频容器",
    );
    console.log(`媒体源验证通过：HTTP ${response.status} · ${contentType} · ${bytes.length} bytes`);
  }

  console.log("视频交付链路回归检查通过：safeMediaFetch、源选择、鉴权 URL、预检和失败恢复均符合规则。");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
