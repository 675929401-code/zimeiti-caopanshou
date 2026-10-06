import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPublicHttpsVideoAssetUrl, isPublicVideoAssetUrl } from "../src/lib/video-public-url";

const root = process.cwd();
const baseUrl = String(process.env.BASE_URL || process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000").replace(/\/+$/u, "");

async function source(relativePath: string) {
  return readFile(resolve(root, relativePath), "utf8");
}

async function main() {
  assert.equal(isPublicVideoAssetUrl("blob:https://example.com/id"), false);
  assert.equal(isPublicVideoAssetUrl("http://127.0.0.1:5000/uploads/a.png"), false);
  assert.equal(isPublicVideoAssetUrl("http://localhost:5000/uploads/a.png"), false);
  assert.equal(isPublicVideoAssetUrl("http://192.168.1.8/a.png"), false);
  assert.equal(isPublicVideoAssetUrl("https://cdn.example.com/a.png"), true);
  assert.equal(isPublicHttpsVideoAssetUrl("http://cdn.example.com/a.png"), false);
  assert.equal(isPublicHttpsVideoAssetUrl("https://cdn.example.com/a.png"), true);

  const [
    page,
    modelsRoute,
    generateRoute,
    uploadRoute,
    billing,
    statusRoute,
    statusService,
    streamRoute,
    historyWorker,
    pollRoute,
    terminalFinalizer,
    walletMigration,
    terminalMigration,
  ] = await Promise.all([
    source("src/app/video/page.tsx"),
    source("src/app/api/video/models/route.ts"),
    source("src/app/api/video/generate/route.ts"),
    source("src/app/api/video/reference-upload/route.ts"),
    source("src/lib/billing.ts"),
    source("src/app/api/video/status/route.ts"),
    source("src/lib/video-task-status.ts"),
    source("src/app/api/video/stream/route.ts"),
    source("src/lib/video-history-worker.ts"),
    source("src/app/api/video/poll/route.ts"),
    source("src/lib/video-terminal-finalizer.ts"),
    source("supabase/migrations/20260825121000_atomic_wallet_payment_fulfillment.sql"),
    source("supabase/migrations/20260926133000_video_upstream_direct_delivery.sql"),
  ]);
  assert.match(page, /\/api\/video\/models\?surface=video-page/u);
  assert.match(page, /\/api\/video\/reference-upload/u);
  assert.match(page, /surface:\s*"video-page"/u);
  assert.match(page, /const selectable = model\.available/u,
    "视频模型只按实时目录可用性进入提交链路");
  assert.doesNotMatch(page, /currentModel\.generationReady === false/u,
    "内部验收状态不得成为视频提交的第二道门槛");
  assert.match(page, /data-video-model-id=\{model\.id\}[\s\S]*?disabled=\{!selectable\}/u,
    "真正不可用的模型不得在视频页提交");
  assert.match(page, /视频模型目录加载中/u, "模型请求尚未完成时必须显示加载态");
  assert.match(page, /视频模型目录加载失败，请刷新页面重试/u, "目录错误必须与真实空目录区分");
  assert.match(page, /当前暂无可用视频模型，请稍后刷新重试/u, "真实空目录必须给客户可执行的重试提示");
  assert.doesNotMatch(page, /请联系管理员配置|待充值|上游余额|管理员显式恢复\s*canary/u, "客户视频页不得暴露内部运维措辞");
  assert.doesNotMatch(
    modelsRoute,
    /\.from\(["']video_channel_health["']\)/u,
    "临时渠道健康状态不得从公共目录隐藏已配置模型；健康门禁只在提交时执行",
  );
  assert.doesNotMatch(modelsRoute, /待充值：|成本价或销售价缺失|管理员显式恢复\s*canary|渠道连续失败\s*\$\{/u, "公开模型目录不得泄露内部定价、余额或恢复策略");
  assert.match(generateRoute, /CHANNEL_HEALTH_BLOCKED/u);
  assert.ok(
    generateRoute.indexOf("CHANNEL_HEALTH_BLOCKED") < generateRoute.indexOf("result = await submitVideoTask"),
    "健康门禁必须在视频提交前执行",
  );
  assert.doesNotMatch(generateRoute, /ImageGenerationClient|needsAutoRef/u, "视频提交不能隐式调用生图绕过登记与费用门禁");
  assert.match(generateRoute, /validateVideoInputContract\(inputContract/u);
  assert.match(uploadRoute, /providerType:\s*"tencent_cos"/u);
  assert.match(uploadRoute, /getSignedUrl/u);
  assert.match(
    billing,
    /export async function deductCash[\s\S]*?applyAtomicWalletOperation\(\{[\s\S]*?operationKind: 'cash_charge',[\s\S]*?idempotencyKey: referenceId/u,
    "现金扣费必须委托原子钱包并使用 referenceId 作稳定幂等键",
  );
  assert.match(billing, /db\.rpc\('apply_wallet_operation_atomic'/u, "原子钱包必须由数据库 RPC 执行");
  for (const marker of [
    "UNIQUE (user_id, operation_kind, idempotency_key)",
    "ON CONFLICT (user_id, operation_kind, idempotency_key) DO NOTHING",
    "FROM public.users",
    "FOR UPDATE",
    "INSERT INTO public.wallet_ledger_entries",
    "SET status = 'completed'",
  ]) {
    assert(walletMigration.includes(marker), `原子钱包迁移缺少幂等/行锁/流水语义: ${marker}`);
  }
  assert.match(statusRoute, /readOwnedVideoTaskStatus/u, "状态入口必须委托统一的归属校验与状态服务");
  assert.match(statusService, /finalizeVideoGenerationSuccess/u, "统一状态服务必须委托终态器");
  assert.match(streamRoute, /readOwnedVideoTaskStatus/u, "SSE 必须只读取账号归属的状态快照");
  assert.doesNotMatch(streamRoute, /pollVideoTask|finalizeVideoGenerationSuccess|finalizeVideoGenerationFailure/u, "SSE 不得轮询供应商或竞争终态");
  assert.match(historyWorker, /refreshOwnedVideoTaskStatus/u, "后台视频 Worker 必须负责主动状态刷新");
  const successFinalizationFlow = terminalFinalizer.slice(
    terminalFinalizer.indexOf("async function finalizeVideoGenerationSuccessUnlocked"),
  );
  assert.ok(
    successFinalizationFlow.indexOf("const billing = await executeCashDeduction({")
      < successFinalizationFlow.indexOf('const { data: finalizeData, error: finalizeError } = await db.rpc("finalize_video_generation_task_atomic"'),
    "视频终态器必须先完成幂等钱包操作，再提交原子交付终态",
  );
  assert.match(
    terminalFinalizer,
    /billingIdempotencyKey = String\(task\.billing_idempotency_key[\s\S]*?idempotencyKey: billingIdempotencyKey/u,
    "视频扣费必须使用任务中持久化的稳定幂等键",
  );
  assert.match(
    terminalMigration,
    /finalize_video_generation_task_atomic[\s\S]*?FOR UPDATE[\s\S]*?'already_completed', true[\s\S]*?'already_completed', false/u,
    "视频交付终态必须在数据库行锁内识别重放",
  );
  assert.match(pollRoute, /GET as getVideoStatus/u, "旧轮询入口必须委托统一状态接口");

  if (process.env.VIDEO_PAGE_STATIC_ONLY === "1") {
    console.log("video-page chain safety static verification passed; networkCalls=0; paidRequest=0");
    return;
  }

  const modelsResponse = await fetch(`${baseUrl}/api/video/models?surface=video-page`);
  const modelsPayload = await modelsResponse.json() as {
    models?: Array<{
      id: string;
      displayName: string;
      capabilities?: {
        available?: boolean;
        generationReady?: boolean;
        availabilityMessage?: string;
      };
    }>;
  };
  assert.ok(modelsResponse.ok && Array.isArray(modelsPayload.models), "视频制作页模型接口不可用");
  assert.ok(modelsPayload.models.length > 0, "视频制作页应展示已配置模型目录");
  assert.ok(modelsPayload.models.every((model) => model.id && model.displayName), "公共模型项必须有稳定ID和名称");
  assert.ok(
    modelsPayload.models.every((model) => !Object.hasOwn(model.capabilities || {}, "activationReady")
      && !Object.hasOwn(model.capabilities || {}, "readinessMessage")
      && typeof model.capabilities?.generationReady === "boolean"),
    "公共模型目录不得暴露内部验收字段，并应按实时可用性返回生成状态",
  );
  // Do not POST /generate here: a live channel can recover between catalog read
  // and submission. The source assertion above proves the paid route performs
  // the health gate, while this runtime assertion proves health never hides the
  // model catalog. Together they remain a zero-cost test.
  console.log(`video-page chain safety verification passed; visibleModels=${modelsPayload.models.length}; paidRequest=0`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
