import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  summarizeManjuAudioModels,
  summarizeManjuImageModels,
  summarizeManjuTextModels,
  summarizeManjuVideoModels,
  unavailableManjuFamily,
} from "../src/lib/manju-workbench-status";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const text = summarizeManjuTextModels([
  {
    id: "legacy-text",
    name: "既有文案模型",
    model_name: "text-model",
    api_endpoint: "https://example.invalid/v1",
    api_key: "secret://text",
    is_active: true,
    is_hidden: false,
    user_access: "available",
  },
  {
    id: "pending-text",
    name: "待验收文案模型",
    model_name: "pending-model",
    api_endpoint: "https://example.invalid/v1",
    api_key: "secret://pending",
    is_active: true,
    is_hidden: false,
    user_access: "pending_model_activation",
  },
]);
assert.equal(text.models[0].acceptance, "legacy_unverified");
assert.equal(text.models[0].userAvailable, true);
assert.equal(text.models[1].acceptance, "evidence_pending");
assert.equal(text.models[1].userAvailable, false);
assert.equal(text.evidenceComplete, 0, "既有可见模型不能冒充已完成 canary 验收");

const image = summarizeManjuImageModels([{
  id: "pending-cover-model-1000-abcdefgh",
  name: "待验收生图模型",
  model_name: "image-model",
  api_endpoint: "https://example.invalid/v1",
  api_key: "secret://image",
  is_active: true,
  is_hidden: false,
}]);
assert.equal(image.models[0].acceptance, "evidence_pending");
assert.equal(image.models[0].userAvailable, false);

const video = summarizeManjuVideoModels([
  {
    id: "pending-video",
    name: "待验收视频模型",
    model_name: "video-model",
    provider: "provider",
    protocol_type: "openai_compatible",
    api_endpoint: "https://example.invalid/v1",
    api_key: "secret://video",
    api_protocol_config: {
      __model_activation_gate: {
        schema: "media_model_activation_gate.v1",
        state: "pending",
      },
    },
    is_active: true,
    is_hidden: false,
  },
  {
    id: "legacy-video",
    name: "既有视频模型",
    model_name: "legacy-video-model",
    provider: "provider",
    protocol_type: "openai_compatible",
    api_endpoint: "https://example.invalid/v1",
    api_key: "secret://legacy-video",
    api_protocol_config: {},
    is_active: true,
    is_hidden: false,
  },
]);
assert.equal(video.models[0].acceptance, "evidence_pending");
assert.equal(video.models[0].userAvailable, false);
assert.equal(video.models[1].acceptance, "legacy_unverified");
assert.equal(video.models[1].userAvailable, true);

const audio = summarizeManjuAudioModels([{
  id: "audio-1",
  name: "既有音频模型",
  modelId: "audio-model",
  resourceId: "audio-resource",
  apiKey: "secret://audio",
  isActive: true,
}]);
assert.equal(audio.models[0].acceptance, "legacy_unverified");
assert.equal(audio.evidenceComplete, 0);

const failedFamily = unavailableManjuFamily("image", "生图模型", "cover_models", "读取失败");
assert.equal(failedFamily.records, 0);
assert.equal(failedFamily.loadError, "读取失败");

const serialized = JSON.stringify({ text, image, video, audio });
for (const secret of ["secret://text", "secret://pending", "secret://image", "secret://video", "secret://audio"]) {
  assert.equal(serialized.includes(secret), false, "安全状态对象不得携带密钥或密钥引用");
}

const shell = source("src/components/app-route-shell.tsx");
assert.match(shell, /data-testid="youcai-account-profile-link"/);
assert.match(shell, /href="\/profile"/);
assert.match(shell, /进入个人中心/);
assert.match(shell, /AppScopedLink/u);
assert.match(shell, /\/login\?redirect=%2Fyoucai%2Fprofile/u);
assert.match(shell, /漫剧工作台/);

const routePolicy = source("src/lib/youcai-routes.ts");
assert.doesNotMatch(routePolicy, /\"\/profile\"/);

const profile = source("src/features/youcai-account/youcai-account-page.tsx");
for (const endpoint of ["/api/auth/me", "/api/user/assets", "/api/media-history?limit=20", "/api/storage/files?limit=1&offset=0&quota=true"]) {
  assert.ok(profile.includes(endpoint), `个人中心必须读取真实接口：${endpoint}`);
}
for (const branchPath of ["/assets", "/recharge", "/referral", "/media-history"]) {
  assert.ok(profile.includes(`href=\"${branchPath}\"`), `个人中心必须保留分支入口：${branchPath}`);
}

const assets = source("src/features/official-core-routes/official-assets-route.tsx");
assert.match(assets, /这不是“暂无资产”/);
assert.match(assets, /统一账户生成记录与个人存储索引/);
assert.ok(assets.includes("/api/media-history"));
assert.ok(assets.includes("/api/storage/files"));
assert.ok(assets.includes("加载更多存储文件"));
assert.ok(assets.includes("加载更多生成记录"));
assert.ok(assets.includes("个存储文件总数"));
assert.ok(assets.includes("个存储文件已加载"));
assert.match(assets, /\/api\/storage\/files\/\$\{encodeURIComponent\(item\.id\)\}\/content/);
assert.doesNotMatch(assets, /storage_key/, "个人资产客户端不得依赖 storage_key 访问内容");

const storageFilesRoute = source("src/app/api/storage/files/route.ts");
assert.match(storageFilesRoute, /countUserFiles/);
assert.match(storageFilesRoute, /pagination:/);
assert.match(storageFilesRoute, /nextOffset/);
assert.doesNotMatch(storageFilesRoute, /storage_key:\s*file\.storage_key/, "文件列表不得下发 storage_key");

const storageContentRoute = source("src/app/api/storage/files/[id]/content/route.ts");
assert.match(storageContentRoute, /\.eq\("id", id\)/);
assert.match(storageContentRoute, /\.eq\("user_id", user\.userId\)/);
assert.match(storageContentRoute, /storageManager\.getSignedUrl/);
assert.match(storageContentRoute, /new NextResponse\(upstream\.body/);
assert.doesNotMatch(storageContentRoute, /NextResponse\.json\(\{\s*url:\s*signedUrl/, "同源内容路由不得泄露签名地址");

const storageManager = source("src/storage/object/manager.ts");
assert.match(storageManager, /countUserFiles/);
assert.match(storageManager, /\.range\(offset, offset \+ limit - 1\)/);

const mediaHistoryRoute = source("src/app/api/media-history/route.ts");
assert.match(mediaHistoryRoute, /searchParams\.get\("offset"\)/);
assert.match(mediaHistoryRoute, /hasMore/);
assert.match(mediaHistoryRoute, /nextOffset/);
assert.match(mediaHistoryRoute, /loadVideoRows/);
assert.match(mediaHistoryRoute, /loadImageMessages/);

const rechargeRoute = source("src/app/youcai/recharge/page.tsx");
const billingPage = source("src/features/youcai-billing/youcai-billing-pages.tsx");
assert.match(rechargeRoute, /YoucaiRechargePage/);
assert.match(billingPage, /RechargeDialog/);

const adminPage = source("src/app/admin/page.tsx");
assert.match(adminPage, /manju-workbench/);
assert.match(adminPage, /ManjuWorkbenchAdminTab/);

const statusRoute = source("src/app/api/admin/manju-workbench/status/route.ts");
assert.match(statusRoute, /shared-pools-no-branch-allowlist/);
assert.match(statusRoute, /Cache-Control/);
assert.doesNotMatch(statusRoute, /api_key\s*:/, "后台响应不得直接返回原始密钥字段");

console.log("PASS verify-manju-account-admin");
