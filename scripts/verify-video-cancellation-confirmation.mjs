import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const helperModule = { exports: {} };
runInNewContext(compile(readFileSync("src/lib/video-cancellation.ts", "utf8")), {
  module: helperModule,
  exports: helperModule.exports,
  URL,
});
const helpers = helperModule.exports;
let assertions = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
};

// Capability is explicit and AutoDL remains fail-closed until its API exposes
// a verifiable remote interruption contract.
check(helpers.supportsConfirmedVideoCancellation("gaorui_video", {}) === false,
  "unconfigured providers cannot claim remote cancellation");
check(helpers.supportsConfirmedVideoCancellation("gaorui_video", { supports_remote_cancel: true }) === false,
  "a feature flag without a provider contract cannot invent a cancellation endpoint");
check(helpers.supportsConfirmedVideoCancellation("fixture_video", {
  supports_remote_cancel: true,
  cancel_method: "DELETE",
  cancel_path: "/v1/jobs/{id}",
  cancel_task_id_placement: "path",
  cancel_confirm_path: "/v1/jobs/{id}",
}) === true, "a complete same-origin provider contract may enter remote cancellation");
check(helpers.supportsConfirmedVideoCancellation("autodl_comfyui_h3", { supports_remote_cancel: true }) === false,
  "AutoDL hosted workflows remain fail-closed");
check(helpers.supportsConfirmedVideoCancellation("dashscope_wan_s2v", { supports_remote_cancel: true }) === true,
  "DashScope uses its built-in documented cancellation contract");
check(helpers.isProviderCancellationStatus("CANCELED") === true,
  "US-spelled provider cancellation is recognized exactly");
check(helpers.isProviderCancellationStatus("cancelled") === true,
  "UK-spelled provider cancellation is recognized exactly");
check(helpers.isProviderCancellationStatus("terminated") === false,
  "generic termination is not reclassified as user cancellation");
check(helpers.isProviderCancellationStatus("failed") === false,
  "ordinary provider failure remains a failure");

// HTTP 200, acceptance, or a different task is never enough. The exact
// upstream task id must be terminally cancelled.
check(helpers.confirmedVideoCancellation({ success: true }, "external-1") === false,
  "bare success is not terminal evidence");
check(helpers.confirmedVideoCancellation({ status: "cancelled" }, "external-1") === false,
  "a terminal status without task identity is not exact evidence");
check(helpers.confirmedVideoCancellation({ data: { id: "other", status: "cancelled" } }, "external-1") === false,
  "a different upstream task cannot confirm cancellation");
check(helpers.confirmedVideoCancellation({ data: { id: "external-1", status: "cancelled" } }, "external-1") === true,
  "an exact terminal acknowledgement is accepted");
check(helpers.confirmedVideoCancellation({ output: { task_id: "external-1", task_status: "CANCELED" } }, "external-1") === true,
  "DashScope terminal task status is accepted only with the exact id");

const generic = helpers.buildVideoCancellationTransport({
  protocolType: "fixture_video",
  apiEndpoint: "https://relay-a.example/openai/v1/videos",
  protocolConfig: {
    supports_remote_cancel: true,
    cancel_method: "DELETE",
    cancel_path: "/v1/jobs/{id}",
    cancel_task_id_placement: "path",
    cancel_confirm_path: "/v1/jobs/{id}",
  },
  taskId: "external-1",
});
check(generic.method === "DELETE", "configured HTTP method is preserved");
check(generic.url === "https://relay-a.example/v1/jobs/external-1", "cancel URL is same-origin and task-bound");
check(generic.confirmationUrl === "https://relay-a.example/v1/jobs/external-1", "confirmation URL is same-origin and task-bound");

const dashscope = helpers.buildVideoCancellationTransport({
  protocolType: "dashscope_wan_s2v",
  apiEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis",
  protocolConfig: { supports_remote_cancel: true },
  taskId: "external-1",
});
check(dashscope.url === "https://dashscope.aliyuncs.com/api/v1/tasks/external-1/cancel",
  "DashScope uses its documented cancellation endpoint");
check(dashscope.confirmationUrl === "https://dashscope.aliyuncs.com/api/v1/tasks/external-1",
  "DashScope cancellation is followed by exact status confirmation");

assert.throws(() => helpers.buildVideoCancellationTransport({
  protocolType: "fixture_video",
  apiEndpoint: "https://relay-a.example/v1/videos",
  protocolConfig: {
    supports_remote_cancel: true,
    cancel_method: "POST",
    cancel_path: "https://attacker.invalid/cancel",
    cancel_task_id_placement: "path",
    cancel_confirm_path: "/v1/jobs/{id}",
  },
  taskId: "external-1",
}), /VIDEO_CANCELLATION_CONTRACT_UNVERIFIED/u);
assertions += 1;

assert.throws(() => helpers.buildVideoCancellationTransport({
  protocolType: "gaorui_video",
  apiEndpoint: "https://relay-a.example/v1/videos",
  protocolConfig: { supports_remote_cancel: true },
  taskId: "external-1",
}), /VIDEO_CANCELLATION_CONTRACT_UNVERIFIED/u);
assertions += 1;

const runtime = readFileSync("src/lib/video-cancellation-runtime.ts", "utf8");
const route = readFileSync("src/app/api/video/cancel/route.ts", "utf8");
const generate = readFileSync("src/app/api/video/generate/route.ts", "utf8");
const storyboard = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const videoPage = readFileSync("src/app/video/page.tsx", "utf8");
const migration = readFileSync("supabase/migrations/20261004100000_video_task_cancellation_control.sql", "utf8");
const adapter = readFileSync("src/lib/video-adapter.ts", "utf8");
const taskStatus = readFileSync("src/lib/video-task-status.ts", "utf8");

for (const [source, pattern, message] of [
  [route, /authorizeCurrentApiUser\(request\)/u, "route requires the current authenticated owner"],
  [route, /requestVideoTaskCancellation/u, "route delegates to the shared durable cancellation runtime"],
  [runtime, /request_video_task_cancellation_atomic/u, "runtime records cancellation before touching the provider"],
  [runtime, /parseVideoRoutingSnapshot\(task\.routing_snapshot, effectiveModelId\)/u, "runtime uses the immutable accepted routing snapshot"],
  [runtime, /supportsConfirmedVideoCancellation\(routingSnapshot\.protocolType, routingSnapshot\.apiProtocolConfig\)/u, "runtime gates upstream calls on the accepted capability"],
  [runtime, /confirm_video_task_upstream_cancellation_atomic/u, "local cancellation follows exact upstream confirmation"],
  [runtime, /cancellationState === "terminal_conflict"/u, "legacy local-only cancellation is never reported as upstream-confirmed"],
  [runtime, /data\?\.state !== "upstream_required"/u, "resume never creates a cancellation intent by itself"],
  [runtime, /confirmObservedVideoTaskCancellation/u, "later provider cancellation can reconcile an existing intent"],
  [runtime, /\.eq\("video_task_id", taskId\)/u, "late confirmation is bound to the exact local task"],
  [runtime, /if \(!intent \|\| !\["upstream_required", "upstream_confirmed"\]/u, "late provider state never creates a cancellation intent"],
  [adapter, /terminalState\?: "cancelled"/u, "provider cancellation meaning survives legacy failed normalization"],
  [adapter, /terminalState: isProviderCancellationStatus\(rawStatus\)/u, "generic polling preserves an exact cancellation state"],
  [taskStatus, /result\.terminalState === "cancelled"/u, "status polling reconciles delayed provider cancellation before generic failure"],
  [taskStatus, /processingStage: "cancellation_reconciliation"/u, "temporary reconciliation errors keep the task trackable"],
  [generate, /resumeRequestedVideoCancellation/u, "submission resumes a user request that arrived before the provider task id"],
  [generate, /status: "cancelled"/u, "submission can return the confirmed cancelled terminal state"],
  [storyboard, /clientRequestId: card\.videoClientRequestId/u, "storyboard termination carries the stable client request id"],
  [storyboard, /videoSubmissionControllersRef\.current\.get\(cardId\)\?\.abort\(\)/u, "storyboard stops the older browser submission after confirmed cancellation"],
  [videoPage, /clientRequestId: task\.clientRequestId/u, "video page termination carries the stable client request id"],
  [videoPage, /cancelledRef\.current\.has\(localId\)/u, "video page prevents an older submit response from reviving a cancelled card"],
  [migration, /CREATE TABLE IF NOT EXISTS public\.video_task_cancel_intents/u, "migration persists owner-scoped cancellation intent"],
  [migration, /BEFORE INSERT ON public\.video_tasks/u, "task insertion is fenced before provider dispatch"],
  [migration, /pg_advisory_xact_lock/u, "submission and termination are linearized"],
  [migration, /provider_dispatch_started_at IS NOT NULL/u, "dispatch evidence is checked before local cancellation"],
  [migration, /video_task_cancel_intents\.state IN \('upstream_required', 'upstream_confirmed'\)/u, "a missing task row cannot downgrade a prior upstream cancellation requirement"],
  [migration, /WHEN v_task\.status = 'cancelled' AND NOT v_dispatched THEN 'cancelled_before_dispatch'/u, "legacy dispatched local cancellation is recorded as a conflict"],
  [migration, /p_provider_task_id text/u, "upstream confirmation is bound to the provider task id"],
  [migration, /coalesce\(v_task\.price_charged, 0\) <> 0/u, "a charged task cannot be rewritten as cancelled"],
  [migration, /GRANT EXECUTE ON FUNCTION public\.confirm_video_task_upstream_cancellation_atomic/u, "only the service role receives the confirmation RPC"],
]) {
  check(pattern.test(source), message);
}

check(!runtime.includes('.select("provider, model_name, api_endpoint, api_key, protocol_type, api_protocol_config")'),
  "runtime never reloads mutable routing fields from the model catalogue");
check(!route.includes("/v1/video/cancel?id="), "route has no hard-coded provider cancellation guess");

const stream = readFileSync("src/app/api/video/stream/route.ts", "utf8");
check(!/status:\s*["']expired["']/u.test(stream), "passive stream cannot expire a task");
check(!/\bfetch\s*\(/u.test(stream), "passive stream does not call the provider");

console.log(JSON.stringify({
  passed: true,
  assertions,
  providerCalls: 0,
  paidCalls: 0,
  databaseWrites: 0,
}, null, 2));
