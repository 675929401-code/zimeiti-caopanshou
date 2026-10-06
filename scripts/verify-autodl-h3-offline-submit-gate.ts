import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeAutodlH3SelfhostGateway } from "../src/lib/video-autodl-h3-selfhost";

const originalFetch = globalThis.fetch;
const endpoint = "http://127.0.0.1:16011/v1/video/generations";

async function main() {
try {
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), "http://127.0.0.1:16011/health/ready");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.headers, undefined, "readiness must not send the gateway credential");
    return new Response(JSON.stringify({ status: "ready" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  assert.deepEqual(await probeAutodlH3SelfhostGateway(endpoint), { ready: true, reason: "ready" });
  assert.equal(calls, 1, "readiness must perform exactly one GET");

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(
    await probeAutodlH3SelfhostGateway(endpoint),
    { ready: false, reason: "unreachable" },
    "an unreachable loopback gateway must fail closed",
  );

  const root = process.cwd();
  const route = await readFile(path.join(root, "src/app/api/video/generate/route.ts"), "utf8");
  const workbench = await readFile(path.join(root, "src/components/storyboard-workbench.tsx"), "utf8");
  const gateIndex = route.indexOf('error_code: "H3_SELFHOST_NOT_READY"');
  const directSubmitIndex = route.indexOf("result = await submitVideoTask");
  assert.ok(gateIndex > 0 && directSubmitIndex > gateIndex, "offline gate must precede direct submission");
  assert.match(route, /task_submitted:\s*false/u);
  assert.match(route, /stableH3ClientRequestId = buildAutodlH3ClientRequestId\(\{/u);
  assert.match(route, /idempotencyKey:\s*stableH3ClientRequestId/u);
  assert.match(route, /idempotencyKey:\s*taskIdentity\.providerIdempotencyKey/u);
  assert.doesNotMatch(route, /exactAutodlH3Selfhost \? `h3-video-\$\{traceId\}`/u);
  assert.match(workbench, /outputSecondPrice\.toFixed\(2\)/u);
  assert.match(workbench, /model\.durationMode === "fixed" \? `\$\{model\.durationSeconds\}秒` : `\$\{model\.minDuration\}-\$\{model\.maxDuration\}秒`/u);

  console.log("AutoDL H3 offline submission gate passed (mock only; zero network and zero generation)." );
} finally {
  globalThis.fetch = originalFetch;
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
