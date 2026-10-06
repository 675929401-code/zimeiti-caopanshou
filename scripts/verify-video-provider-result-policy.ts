import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trustedVideoProviderResultHostname } from "../src/lib/video-provider-result-url";

const currentOmniResult = "https://media-r2-pg-us.quillbox.win/media-pg/7a1d071532004bde7d8437cbab200748.mp4";

assert.equal(
  trustedVideoProviderResultHostname(currentOmniResult, { protocolType: "gaorui_video" }),
  "media-r2-pg-us.quillbox.win",
  "当前 Omni Flash 上游结果域名没有进入高瑞渠道的精确安全白名单",
);

for (const hostname of [
  "ark-acg-cn-beijing.tos-cn-beijing.volces.com",
  "file-proxy.gaorui.cc",
  "file-proxy.quillbox.win",
  "file-proxy2.quillbox.win",
  "media-9000.gaorui.cc",
  "oss-us.file-download.life",
]) {
  assert.equal(
    trustedVideoProviderResultHostname(`https://${hostname}/delivery/task.mp4?signature=kept`, { protocolType: "gaorui_video" }),
    hostname,
  );
}

for (const hostname of ["flow.secure-skill.com", "source.openclaw-token.shop"]) {
  assert.equal(
    trustedVideoProviderResultHostname(`https://${hostname}/delivery/task.mp4?signature=kept`, { protocolType: "secure_skill_grok_video" }),
    hostname,
  );
}

assert.equal(
  trustedVideoProviderResultHostname("https://flow-content.google/delivery/task.mp4?signature=kept", {
    protocolType: "secure_skill_flow_jobs",
  }),
  "flow-content.google",
  "Secure Skill Flow 成品域名必须仅在 Flow Jobs 协议中获得精确信任",
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://flow-content.google/delivery/task.mp4", {
    protocolType: "secure_skill_grok_video",
  }),
  /VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN/u,
  "Flow 成品域名不得扩散到其他 Secure Skill 协议",
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://flow-content.google.evil.example/task.mp4", {
    protocolType: "secure_skill_flow_jobs",
  }),
  /VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN/u,
);

assert.equal(
  trustedVideoProviderResultHostname("https://cdn.provider.example/jobs/123/content", {
    protocolType: "custom_video",
    apiProtocolConfig: { result_hostnames: ["cdn.provider.example"] },
  }),
  "cdn.provider.example",
  "模型协议配置的精确结果域名没有生效",
);

assert.equal(
  trustedVideoProviderResultHostname("https://cdn.openaicn.com/results/task.mp4", {
    protocolType: "newapi_video",
    apiEndpoint: "https://n.lconai.com",
  }),
  "cdn.openaicn.com",
  "LConAI NewAPI 的精确 CDN 应只在精确 LConAI 端点下获得信任",
);
assert.equal(
  trustedVideoProviderResultHostname("https://cdn.openaicn.com/results/task.mp4", {
    protocolType: "newapi_video",
    apiEndpoint: "https://other-newapi.example",
  }),
  "",
  "LConAI CDN 不得扩散到其他 NewAPI 端点",
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://cdn.openaicn.com.evil.example/task.mp4", {
    protocolType: "newapi_video",
    apiEndpoint: "https://n.lconai.com",
  }),
  /VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN/u,
);

assert.equal(
  trustedVideoProviderResultHostname("https://public-video.example/result/task.mp4", { protocolType: "unknown_video" }),
  "",
  "未知渠道不得从数据库结果地址自动获得 DNS 安全绕过",
);

assert.throws(
  () => trustedVideoProviderResultHostname("https://media-r2-pg-us.quillbox.win.evil.example/task.mp4", { protocolType: "gaorui_video" }),
  /VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN/u,
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://source.openclaw-token.shop.evil.example/task.mp4", { protocolType: "secure_skill_grok_video" }),
  /VIDEO_PROVIDER_RESULT_HOST_FORBIDDEN/u,
);
assert.throws(
  () => trustedVideoProviderResultHostname("http://media-r2-pg-us.quillbox.win/task.mp4", { protocolType: "gaorui_video" }),
  /VIDEO_PROVIDER_RESULT_HTTPS_REQUIRED/u,
);
assert.throws(
  () => trustedVideoProviderResultHostname(["https://", "user:secret@media-r2-pg-us.quillbox.win/task.mp4"].join(""), { protocolType: "gaorui_video" }),
  /VIDEO_PROVIDER_RESULT_CREDENTIALS_FORBIDDEN/u,
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://media-r2-pg-us.quillbox.win:8443/task.mp4", { protocolType: "gaorui_video" }),
  /VIDEO_PROVIDER_RESULT_PORT_FORBIDDEN/u,
);
assert.throws(
  () => trustedVideoProviderResultHostname("https://media-r2-pg-us.quillbox.win/task.mp4#redirect", { protocolType: "gaorui_video" }),
  /VIDEO_PROVIDER_RESULT_FRAGMENT_FORBIDDEN/u,
);
assert.equal(
  trustedVideoProviderResultHostname("https://127.0.0.1/private.mp4", {
    protocolType: "custom_video",
    apiProtocolConfig: { result_hostnames: ["127.0.0.1"] },
  }),
  "",
  "私网 IP 不能通过模型配置进入精确信任列表",
);

const proxyRouteSource = readFileSync(
  fileURLToPath(new URL("../src/app/api/video/proxy/route.ts", import.meta.url)),
  "utf8",
);

assert.match(
  proxyRouteSource,
  /const supportsProviderContentFallback = model\?\.protocol_type === ["']gaorui_video["']\s*\|\|\s*CDN_DOMAINS\.some/u,
  "gaorui_video 应在任一已通过上游安全校验的结果域名失败时启用受鉴权 /content 兜底",
);
assert.match(
  proxyRouteSource,
  /!isAutoDLComfy\s*&&\s*!isAutodlH3Selfhost\s*&&\s*supportsProviderContentFallback/u,
  "AutoDL 专用协议不得误入通用供应商 /content 兜底",
);
assert.doesNotMatch(
  proxyRouteSource,
  /const supportsProviderContentFallback\s*=\s*(?:true|Boolean\(model\))/u,
  "非 gaorui 协议不得被全局放行到 /content 兜底",
);
assert.ok(
  proxyRouteSource.indexOf("trustedVideoProviderResultHostname(videoUrl")
    < proxyRouteSource.indexOf("const supportsProviderContentFallback"),
  "供应商结果地址必须先通过协议白名单校验，再决定 /content 兜底",
);
assert.ok(
  proxyRouteSource.indexOf("await validateSafeUrl(videoUrl")
    < proxyRouteSource.indexOf("const supportsProviderContentFallback"),
  "结果地址必须先通过 DNS/私网安全校验，再决定 /content 兜底",
);

console.log(JSON.stringify({
  passed: true,
  checks: 28,
  currentOmniResultHost: "media-r2-pg-us.quillbox.win",
  gaoruiProtocolContentFallback: true,
  otherProtocolsRemainDomainBound: true,
  privateAndUntrustedResultsRejected: true,
  networkRequests: 0,
}, null, 2));
