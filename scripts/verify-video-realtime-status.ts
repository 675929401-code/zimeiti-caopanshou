import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { pollVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";

async function main() {
const server = createServer((request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (path === "/query/completed") {
    response.end(JSON.stringify({ data: { status: "completed", video_url: "https://cdn.example.test/video.mp4", progress: 1 } }));
    return;
  }
  if (path === "/query/completed-no-url") {
    response.end(JSON.stringify({ data: { status: "completed", progress: 1 } }));
    return;
  }
  if (path === "/query/failed") {
    response.end(JSON.stringify({ data: { status: "failed", error_message: "内容审核未通过" } }));
    return;
  }
  if (path === "/query/balance") {
    response.statusCode = 402;
    response.end(JSON.stringify({ error: { message: "余额不足，请充值" } }));
    return;
  }
  if (path === "/query/progress") {
    response.end(JSON.stringify({ data: { status: "processing", progress: 0.42, message: "正在渲染" } }));
    return;
  }

  response.statusCode = 503;
  response.end(JSON.stringify({ message: "upstream temporarily unavailable" }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const config: VideoModelConfig = {
  id: "mock-unified-video",
  name: "Mock Unified Video",
  provider: "mock",
  api_endpoint: `${baseUrl}/v1/chat/completions`,
  api_key: "test-only",
  protocol_type: "unified_video",
  price_per_use: 0,
  duration_seconds: 10,
  supports_image_input: true,
};

try {
  const completed = await pollVideoTask(config, "task-completed", `${baseUrl}/query/completed`);
  assert.equal(completed.status, "success");
  assert.equal(completed.videoUrl, "https://cdn.example.test/video.mp4");

  const waitingForUrl = await pollVideoTask(config, "task-completed-no-url", `${baseUrl}/query/completed-no-url`);
  assert.equal(waitingForUrl.status, "processing");
  assert.equal(waitingForUrl.progress, null);
  assert.match(waitingForUrl.error || "", /等待播放地址/);

  const failed = await pollVideoTask(config, "task-failed", `${baseUrl}/query/failed`);
  assert.equal(failed.status, "failed");
  assert.match(failed.error || "", /审核未通过/);

  const insufficientBalance = await pollVideoTask(config, "task-balance", `${baseUrl}/query/balance`);
  assert.equal(insufficientBalance.status, "failed");
  assert.match(insufficientBalance.error || "", /余额不足/);

  const processing = await pollVideoTask(config, "task-progress", `${baseUrl}/query/progress`);
  assert.equal(processing.status, "processing");
  assert.equal(processing.progress, 0.42);
  assert.match(processing.error || "", /正在渲染/);

  const temporaryFailure = await pollVideoTask(config, "task-temporary", `${baseUrl}/query/temporary`);
  assert.equal(temporaryFailure.status, "processing");
  assert.match(temporaryFailure.error || "", /temporarily unavailable/);

  console.log(JSON.stringify({
    passed: true,
    cases: ["nested-completed", "completed-awaiting-url", "failed", "insufficient-balance", "progress", "temporary-upstream-error"],
    paidCalls: 0,
  }, null, 2));
} finally {
  server.close();
  await once(server, "close");
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
