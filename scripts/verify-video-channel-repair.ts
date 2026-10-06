import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from "../src/lib/video-error-policy";
import { containsForbiddenPublicModelKey, toPublicModelDto } from "../src/lib/public-model-dto";
import { generateLanmaoVideo } from "../src/lib/video-lanmao-proxy";
import type { VideoModelConfig } from "../src/lib/video-adapter";

const quota = classifyVideoProviderError("provider user quota is not enough", "Omni Flash 10秒 1080P");
assert.equal(quota.code, "CHANNEL_QUOTA_UNAVAILABLE");
assert.equal(quota.retryable, false);
assert.doesNotMatch(quota.publicMessage, /provider|quota/iu);

const scopedClientQuota = classifyVideoProviderError("Client Key 限定范围中的可用账号额度等待恢复", "Grok Imagine Video 1.5 Preview");
assert.equal(scopedClientQuota.code, "CHANNEL_QUOTA_UNAVAILABLE");
assert.equal(scopedClientQuota.category, "account_quota");

const signedDiagnostic = sanitizeVideoProviderDiagnostic("download video failed: status=403 url=https://media.example/video.mp4?q-ak=temporary&q-signature=secret");
assert.match(signedDiagnostic, /download video failed: status=403/u);
assert.match(signedDiagnostic, /video\.mp4\?\[redacted\]/u);
assert.doesNotMatch(signedDiagnostic, /q-ak|q-signature|temporary|secret/u);

const unavailable = classifyVideoProviderError("HTTP 503 service unavailable: distributor offline", "Grok Imagine 1.0 Super 20秒 渠道D");
assert.equal(unavailable.code, "CHANNEL_SERVICE_UNAVAILABLE");
assert.equal(unavailable.retryable, true);
assert.doesNotMatch(unavailable.publicMessage, /distributor|http|503/iu);

const missingRoute = classifyVideoProviderError("model_not_found: no available channel for model", "视频模型");
assert.equal(missingRoute.code, "MODEL_CHANNEL_UNAVAILABLE");
assert.match(missingRoute.publicMessage, /联系管理员检查该模型渠道配置/u);

const supplierRenderFailure = classifyVideoProviderError(
  '{"message":"generation failed: generate error: An error occurred.","type":"server_error"}',
  "MiniMax H3",
);
assert.equal(supplierRenderFailure.code, "CHANNEL_SERVICE_UNAVAILABLE");
assert.doesNotMatch(supplierRenderFailure.publicMessage, /server_error|generation failed/iu);

const missingSourceVideo = classifyVideoProviderError(
  "omni_video_edit 必须提供一条可公开访问的 HTTPS 源视频 URL，输出时长由源视频决定。",
  "Omni Video Edit",
);
assert.equal(missingSourceVideo.code, "VIDEO_INPUT_INVALID");
assert.equal(missingSourceVideo.retryable, false);
assert.match(missingSourceVideo.publicMessage, /必须先上传.*源视频/u);

const dto = toPublicModelDto("video", {
  id: "internal-grok-channel-d",
  name: "Grok Imagine 1.0 Super · 20秒 · 渠道D",
  provider: "internal-provider-name",
  model_name: "private-upstream-model-id",
  api_endpoint: "https://private.example/v1",
  api_key: "private-key",
  price_per_use: 1.5,
}, 0, { type: "video", supportsImageInput: true });
assert.equal(dto.displayName, "Grok Imagine 1.0 Super · 20秒");
assert.equal(dto.variantLabel, "D");
assert.equal(dto.publicPrice, 1.5);
assert.equal(containsForbiddenPublicModelKey(dto), false);
assert.doesNotMatch(JSON.stringify(dto), /internal-provider|private-upstream|private-key|private\.example/iu);

async function main() {
  const [billingSource, statusSource, streamSource, historySource, modelsSource] = await Promise.all([
    readFile(new URL("../src/lib/billing.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/video/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/video/stream/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/video/history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/video/models/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(
    billingSource,
    /export async function deductCash[\s\S]*?applyAtomicWalletOperation\(\{[\s\S]*?operationKind: 'cash_charge',[\s\S]*?idempotencyKey: referenceId/u,
  );
  assert.match(billingSource, /db\.rpc\('apply_wallet_operation_atomic'/u);
  assert.match(
    billingSource,
    /deductedAmount: result\.success && !result\.alreadyFulfilled \? numericAmount : 0/u,
  );
  assert.match(statusSource, /status: "finalizing"/u);
  assert.match(streamSource, /status: "finalizing"/u);
  assert.match(historySource, /classifyVideoProviderError\(rawError/u);
  assert.doesNotMatch(modelsSource, /select\(isAdmin[\s\S]*?\? "\*"/u);

  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || "GET";
  const body = typeof init?.body === "string"
    ? JSON.parse(init.body) as Record<string, unknown>
    : undefined;
  requests.push({ url, method, body });
  if (method === "GET" && url.endsWith("/v1/models")) {
    return new Response(JSON.stringify({ data: [{ id: "grok-imagine-1.0-video-super-20s" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ error: { message: "render cluster temporarily offline" } }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
  }) as typeof fetch;

  const channelD: VideoModelConfig = {
  id: "grok-imagine-1.0-super-20s-ch4",
  name: "Grok Imagine 1.0 Super · 20秒 · 渠道D",
  provider: "test-provider",
  api_endpoint: "https://video.example.test/v1",
  api_key: "test-key",
  protocol_type: "lanmao_video",
  price_per_use: 1.5,
  duration_seconds: 20,
  supports_image_input: true,
  model_name: "grok-imagine-1.0-video-super-20s",
  };

  try {
    const result = await generateLanmaoVideo(channelD, {
      prompt: "Reference image animation contract check",
      imageUrl: "https://cdn.example.test/reference.png",
      duration: 20,
      aspectRatio: "16:9",
    });
    assert.equal(result.status, "processing");
    assert.equal(result.submissionOutcome, "unknown");
    assert.equal(requests[0]?.method, "GET");
    assert.match(requests[0]?.url || "", /\/v1\/models$/u);
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(requests.some((request) => request.body?.model === "health_check"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("Video channel repair regression: PASS (error privacy, stable channel labels, free contract preflight, 503 diagnostics).");
}

void main();
