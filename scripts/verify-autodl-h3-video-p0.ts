import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AUTODL_H3_SELFHOST_PROTOCOL,
  AUTODL_H3_SELFHOST_PROVIDER,
  AUTODL_H3_SELFHOST_SECRET_REF,
  AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
  AUTODL_H3_SELFHOST_VIDEO_MODEL,
  assertAutodlH3SelfhostModelBinding,
  fetchAutodlH3SelfhostResult,
  redactAutodlH3SelfhostResultUrl,
} from "../src/lib/autodl-h3-selfhost";
import {
  requireStableVideoStorageUrl,
  withAutodlH3VideoFinalizationLock,
} from "../src/lib/video-persistence";
import { shouldAutomaticallyRetryVideoFailure } from "../src/lib/video-retry-policy";

async function verifyExactOriginFetch() {
  const originalFetch = globalThis.fetch;
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = "a".repeat(64);
  const resultUrl = `http://127.0.0.1:16011/v1/files/h3_fixture?expires=${expires}&sig=${signature}`;
  let fetchCount = 0;
  try {
    globalThis.fetch = async (input, init) => {
      fetchCount += 1;
      assert.equal(String(input), resultUrl);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).has("authorization"), false, "H3 /v1/files must not receive Authorization");
      return new Response(new Uint8Array([0, 0, 0, 24]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    };

    const { response } = await fetchAutodlH3SelfhostResult(
      resultUrl,
      AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
      { timeoutMs: 1_000 },
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCount, 1);
    const redacted = redactAutodlH3SelfhostResultUrl(resultUrl, AUTODL_H3_SELFHOST_VIDEO_ENDPOINT);
    assert.equal(redacted, "http://127.0.0.1:16011/v1/files/h3_fixture?signed=redacted");
    assert.equal(redacted.includes(signature), false);

    await assert.rejects(
      fetchAutodlH3SelfhostResult(
        `https://cross-origin.invalid/v1/files/h3_fixture?expires=${expires}&sig=${signature}`,
        AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
      ),
      /跨域/u,
    );
    assert.equal(fetchCount, 1, "cross-origin result must fail before fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyStableStorageAndLocalLock() {
  assert.equal(
    requireStableVideoStorageUrl("object://tencent_cos/videos%2Fgenerated%2Fh3.mp4", "autodl_h3_selfhost"),
    "object://tencent_cos/videos%2Fgenerated%2Fh3.mp4",
  );
  assert.throws(
    () => requireStableVideoStorageUrl("http://127.0.0.1:16011/v1/files/h3_fixture", "autodl_h3_selfhost"),
    /稳定对象存储/u,
  );
  assert.equal(
    requireStableVideoStorageUrl("https://legacy-cdn.invalid/video.mp4", "openai_compatible"),
    "https://legacy-cdn.invalid/video.mp4",
    "legacy protocols retain their previous behavior",
  );

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withAutodlH3VideoFinalizationLock("external:h3_fixture", async () => {
    await firstMayFinish;
    return "first";
  });
  await Promise.resolve();
  const second = await withAutodlH3VideoFinalizationLock("external:h3_fixture", async () => "second");
  assert.deepEqual(second, { acquired: false });
  releaseFirst();
  assert.deepEqual(await first, { acquired: true, value: "first" });
}

function verifyRouteSourceGates() {
  const root = process.cwd();
  const statusSource = fs.readFileSync(path.join(root, "src/app/api/video/status/route.ts"), "utf8");
  const streamSource = fs.readFileSync(path.join(root, "src/app/api/video/stream/route.ts"), "utf8");
  const downloadSource = fs.readFileSync(path.join(root, "src/app/api/video/proxy-download/route.ts"), "utf8");
  const proxySource = fs.readFileSync(path.join(root, "src/app/api/video/proxy/route.ts"), "utf8");
  const activeTasksSource = fs.readFileSync(path.join(root, "src/app/api/video/active-tasks/route.ts"), "utf8");
  const terminalSource = fs.readFileSync(path.join(root, "src/lib/video-terminal-finalizer.ts"), "utf8");

  for (const [name, source] of [["status", statusSource], ["stream", streamSource]] as const) {
    assert.match(source, /finalizeVideoGenerationSuccess/u, `${name} must delegate to the unified terminal finalizer`);
  }
  assert.match(terminalSource, /persistStableVideoFromUrl/u, "terminal finalizer must use the stable persistence gate");
  assert.match(terminalSource, /providerProtocol:\s*String\(model\.protocol_type \|\| ""\)/u);
  assert.match(terminalSource, /providerEndpoint:\s*String\(model\.api_endpoint \|\| ""\)/u);
  assert.match(terminalSource, /status:\s*"finalizing"[\s\S]{0,320}price_charged:\s*0/u, "failed persistence must remain uncharged");
  assert.match(terminalSource, /executeCashDeduction\([\s\S]*finalize_video_generation_task_atomic/u, "billing must settle before atomic delivery");

  assert.match(downloadSource, /fetchAutodlH3SelfhostResult/u);
  assert.match(downloadSource, /!isAutodlH3Selfhost\(fallbackInfo\.protocolType\)/u);
  assert.match(downloadSource, /&&\s*!isAutodlH3Selfhost\(fallbackInfo\.protocolType\)/u);
  assert.equal(
    downloadSource.includes("Bearer ${fallbackInfo.apiKey}") && downloadSource.includes("isAutodlH3TemporaryFallback"),
    true,
    "legacy authorization remains present while H3 has an earlier dedicated branch",
  );

  assert.match(proxySource, /isAutodlH3TemporarySource\s*=\s*isAutodlH3Selfhost\s*&&\s*!selectedFromStorage/u);
  assert.match(proxySource, /const directResult = isAutodlH3TemporarySource/u);
  assert.match(activeTasksSource, /isAutodlH3Task[\s\S]{0,320}createVideoAccessUrl/u);
  assert.doesNotMatch(activeTasksSource, /videoUrl:\s*t\.video_url\s*\|\|\s*""/u);
}

function verifyH3FailureCannotAutoResubmit() {
  const retryableMessage = "task_failed: 视频生成失败，请重试";
  assert.equal(shouldAutomaticallyRetryVideoFailure({
    errorMessage: retryableMessage,
    automaticRetryAllowed: false,
    hasRetried: false,
  }), false, "H3 terminal failure must never schedule a second generation POST");
  assert.equal(shouldAutomaticallyRetryVideoFailure({
    errorMessage: retryableMessage,
    automaticRetryAllowed: true,
    hasRetried: false,
  }), true, "legacy retry behavior must remain unchanged");

  const root = process.cwd();
  const streamSource = fs.readFileSync(path.join(root, "src/app/api/video/stream/route.ts"), "utf8");
  const pageSource = fs.readFileSync(path.join(root, "src/app/video/page.tsx"), "utf8");
  assert.match(streamSource, /event === "failed" && isAutodlH3Selfhost\(config\.protocol_type\)[\s\S]{0,120}automaticRetryAllowed: false/u);
  assert.match(pageSource, /automaticRetryAllowed:\s*data\.automaticRetryAllowed/u);
}

function verifyH3PostSuccessFinalizationStaysNonTerminal() {
  const streamSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/video/stream/route.ts"),
    "utf8",
  );
  const activePollMarker = "// 轮询上游";
  const activePollStart = streamSource.lastIndexOf(activePollMarker);
  assert.ok(activePollStart >= 0, "active SSE poll loop must remain present");
  const activePollSource = streamSource.slice(activePollStart);
  const successStart = activePollSource.indexOf('if (result.status === "success" && result.videoUrl)');
  const failedStart = activePollSource.indexOf('if (result.status === "failed")', successStart);
  assert.ok(successStart >= 0 && failedStart > successStart, "provider-success handling must remain isolated from provider failure handling");

  const successBranch = activePollSource.slice(successStart, failedStart);
  assert.match(successBranch, /finalizeVideoStreamSuccess\([\s\S]*providerVideoUrl: result\.videoUrl/u);
  assert.match(successBranch, /outcome\.state === "completed" && outcome\.playbackUrl[\s\S]*send\("completed"/u);
  assert.match(successBranch, /outcome\.state === "billing_pending"[\s\S]*videoUrl:\s*""[\s\S]*priceCharged:\s*0/u);
  assert.match(successBranch, /processingStage:\s*"finalizing"[\s\S]*videoUrl:\s*""[\s\S]*priceCharged:\s*0/u);

  const completedRowStart = streamSource.indexOf('if (existingTask?.status === "completed")');
  const failedRowStart = streamSource.indexOf("// DB 中已失败", completedRowStart);
  assert.ok(completedRowStart >= 0 && failedRowStart > completedRowStart, "completed-row recovery branch must remain present");
  const completedRowBranch = streamSource.slice(completedRowStart, failedRowStart);
  assert.match(completedRowBranch, /finalizeVideoStreamSuccess\([\s\S]*existingTask\.video_url/u);
  assert.match(completedRowBranch, /outcome\.state === "completed" && outcome\.playbackUrl[\s\S]*send\("completed"/u);
  assert.match(completedRowBranch, /videoUrl:\s*""[\s\S]*priceCharged:\s*0/u, "re-attestation pending states must never expose a provider URL or charge");
}

function verifyH3CredentialBindingBeforeResolution() {
  const exactBinding = {
    kind: "video" as const,
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    protocolType: AUTODL_H3_SELFHOST_PROTOCOL,
    modelName: AUTODL_H3_SELFHOST_VIDEO_MODEL,
    apiEndpoint: AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  };
  assert.equal(assertAutodlH3SelfhostModelBinding(exactBinding), true);
  assert.throws(
    () => assertAutodlH3SelfhostModelBinding({ ...exactBinding, protocolType: "openai_compatible" }),
    /协议/u,
  );
  assert.throws(
    () => assertAutodlH3SelfhostModelBinding({ ...exactBinding, provider: "legacy-provider" }),
    /成对/u,
  );
  assert.equal(assertAutodlH3SelfhostModelBinding({
    kind: "video",
    provider: "legacy-provider",
    protocolType: "openai_compatible",
    modelName: "legacy-video",
    apiEndpoint: "https://legacy.invalid/v1/video/generations",
    apiKey: "legacy-key",
  }), false, "legacy provider bindings must remain unchanged");

  const root = process.cwd();
  const runtimeRoutes = [
    "src/app/api/video/generate/route.ts",
    "src/app/api/video/status/route.ts",
    "src/app/api/video/stream/route.ts",
    "src/app/api/video/cancel/route.ts",
    "src/app/api/video/detect-protocol/route.ts",
    "src/app/api/video/proxy/route.ts",
    "src/app/api/video/proxy-download/route.ts",
  ];
  for (const route of runtimeRoutes) {
    const source = fs.readFileSync(path.join(root, route), "utf8");
    const bindingIndex = source.indexOf("assertAutodlH3SelfhostModelBinding({");
    const secretResolutionIndex = source.indexOf("resolveProviderSecret(");
    assert.ok(bindingIndex >= 0, `${route} must enforce the H3 credential binding`);
    assert.ok(secretResolutionIndex < 0 || bindingIndex < secretResolutionIndex, `${route} must bind H3 before resolving a secret`);
  }

  const adminSource = fs.readFileSync(path.join(root, "src/app/api/admin/models/route.ts"), "utf8");
  assert.match(
    adminSource,
    /\.select\("provider,protocol_type,model_name,api_endpoint,api_key,api_protocol_config,duration_seconds,max_duration,is_active,is_hidden"\)/u,
    "H3 admin update must lock both credential binding and the activated capability profile",
  );
  assert.match(adminSource, /protocolType:\s*fields\.protocol_type/u);
}

async function main() {
  await verifyExactOriginFetch();
  await verifyStableStorageAndLocalLock();
  verifyRouteSourceGates();
  verifyH3FailureCannotAutoResubmit();
  verifyH3PostSuccessFinalizationStaysNonTerminal();
  verifyH3CredentialBindingBeforeResolution();
  console.log("AutoDL H3 video P0 verification passed (mock/static only; zero network and zero paid requests).\n");
}

void main();
