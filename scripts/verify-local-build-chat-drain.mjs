import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isLocalBuildChatDrainActive,
  localBuildChatDrainResponse,
} from "../src/lib/local-build-chat-drain.ts";
import {
  assertNoActiveLocalLlmRequests,
  inspectActiveLocalLlmRequests,
} from "./local-build-active-llm-guard.mjs";

const runtime = {
  supabaseUrl: "http://127.0.0.1:54321",
  serviceRoleKey: "fixture-service-role-key",
};
const now = new Date("2026-10-04T09:11:39.000Z");

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

assert.equal(isLocalBuildChatDrainActive({
  environment: { LOCAL_ACCEPTANCE_PREVIEW: "true" },
  projectRoot: "F:/fixture",
  fileExists: (target) => target.endsWith(".codex-build.lock"),
}), true);
assert.equal(isLocalBuildChatDrainActive({
  environment: { LOCAL_ACCEPTANCE_PREVIEW: "false" },
  fileExists: () => true,
}), false, "production must not expose the local build drain gate");
assert.equal(isLocalBuildChatDrainActive({
  environment: {
    LOCAL_ACCEPTANCE_PREVIEW: "true",
    LOCAL_ACCEPTANCE_SOURCE_ROOT: "F:/verified-source-root",
  },
  fileExists: (target) => target === "F:\\verified-source-root\\.codex-build.lock",
}), true, "standalone runtime must resolve the build lock from its explicit source root");

const drainResponse = localBuildChatDrainResponse();
assert.equal(drainResponse.status, 503);
assert.equal(drainResponse.headers.get("Retry-After"), "5");
assert.deepEqual(await drainResponse.json(), {
  error: "本地版本正在更新，当前未调用模型或扣费。请等待更新完成后再发送。",
  code: "LOCAL_BUILD_DRAINING",
  retryable: true,
  retry_safe: true,
  provider_call_started: false,
  charged: false,
});

const active = await inspectActiveLocalLlmRequests({
  runtime,
  now,
  fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("state"), "eq.running");
    assert.equal(parsed.searchParams.get("provider_call_started_at"), "not.is.null");
    assert.equal(parsed.searchParams.get("lease_expires_at"), `gt.${now.toISOString()}`);
    assert.equal(init.headers.Authorization, "Bearer fixture-service-role-key");
    return response([{
      record_id: "a".repeat(56) + "572e8ae9",
      provider_call_started_at: "2026-10-04T09:10:42.095Z",
      lease_expires_at: "2026-10-04T09:25:42.055Z",
      created_at: "2026-10-04T09:10:42.055Z",
    }]);
  },
});
assert.equal(active.length, 1);
assert.equal(active[0].recordSuffix, "572e8ae9");

await assert.rejects(
  assertNoActiveLocalLlmRequests({ runtime, now, fetchImpl: async () => response([{
    record_id: "a".repeat(56) + "572e8ae9",
    provider_call_started_at: "2026-10-04T09:10:42.095Z",
    lease_expires_at: "2026-10-04T09:25:42.055Z",
    created_at: "2026-10-04T09:10:42.055Z",
  }]) }),
  /Refusing to build while 1 provider-dispatched LLM request/u,
);

assert.deepEqual(await assertNoActiveLocalLlmRequests({
  runtime,
  now,
  fetchImpl: async () => response([]),
}), []);

await assert.rejects(
  assertNoActiveLocalLlmRequests({ runtime, now, fetchImpl: async () => response({ error: "unavailable" }, 503) }),
  /Unable to prove that local chat is drained/u,
);

const buildSource = fs.readFileSync(new URL("./run-build.mjs", import.meta.url), "utf8");
const routeSource = fs.readFileSync(new URL("../src/app/api/llm/route.ts", import.meta.url), "utf8");
const lockIndex = buildSource.indexOf("acquireBuildLock(buildLock)");
const drainIndex = buildSource.indexOf("await assertNoActiveLocalLlmRequests()");
const stopIndex = buildSource.indexOf("stopOwnedLocalPreview(root)");
const revisionIndex = buildSource.indexOf("const revision = ensureSourceVersion(root)");
assert.ok(lockIndex > 0 && drainIndex > lockIndex && stopIndex > drainIndex && revisionIndex > stopIndex,
  "builder must own the lock, drain active chat and stop only the owned preview before changing the source version");
assert.match(buildSource, /LOCAL_BUILD_PREVIEW_OWNER_MISMATCH/u,
  "builder must refuse to stop an unverified port owner");
const routeFunctionIndex = routeSource.indexOf("export async function POST(request: Request)");
const routeDrainIndex = routeSource.indexOf("if (isLocalBuildChatDrainActive())", routeFunctionIndex);
const routeBodyIndex = routeSource.indexOf("const body = await request.json()", routeFunctionIndex);
assert.ok(routeDrainIndex > routeFunctionIndex && routeDrainIndex < routeBodyIndex,
  "LLM route must reject a draining build before parsing or dispatching the request");

console.log(JSON.stringify({
  verifier: "local-build-chat-drain",
  passed: true,
  providerCalls: 0,
  paidCalls: 0,
  databaseWrites: 0,
  checks: {
    localBuildLockBlocksNewChat: "passed",
    standaloneUsesExplicitSourceRoot: "passed",
    productionIgnoresLocalLock: "passed",
    activeProviderRequestBlocksBuild: "passed",
    emptyActiveSetAllowsBuild: "passed",
    unreadableStateFailsClosed: "passed",
    lockOwnedBeforeDrainAndVersionMutation: "passed",
    ownedPreviewStoppedAfterDrain: "passed",
    requestRejectedBeforeBodyOrProviderWork: "passed",
  },
}, null, 2));
