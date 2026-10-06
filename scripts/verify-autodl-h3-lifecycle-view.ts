import assert from "node:assert/strict";

import {
  buildAutodlH3LifecycleView,
  type AutodlH3InstanceObservation,
} from "../src/lib/autodl-h3-lifecycle-view";
import type { AutodlH3InstanceState, AutodlH3Job, AutodlH3JobState } from "../src/lib/autodl-h3-lifecycle";

const now = Date.parse("2026-08-21T15:00:00.000Z");

function job(state: AutodlH3JobState, progress = 0): AutodlH3Job {
  return {
    id: "job-internal-do-not-expose",
    publicTaskId: "h3q_0123456789abcdef",
    clientRequestId: "h3cr_private_client_request",
    videoTaskInternalId: "vt_private",
    userId: "user-private",
    modelId: "minimax-h3-turbo-selfhost-pro6000",
    instanceUuid: "instance-private",
    requestPayload: { prompt: "must-not-leak" },
    state,
    upstreamTaskId: "gateway-private-task-id",
    contentUrl: "http://127.0.0.1/private",
    resultAssetUrl: null,
    progress,
    attemptCount: 1,
    notBefore: null,
    leaseOwner: "worker-private",
    leaseToken: 9,
    leaseExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-08-21T14:55:00.000Z",
    updatedAt: "2026-08-21T14:59:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

function instance(
  lifecycleState: AutodlH3InstanceState,
  idleSince: string | null = null,
): AutodlH3InstanceObservation {
  return {
    lifecycleState,
    idleSince,
    stateChangedAt: "2026-08-21T14:59:00.000Z",
    updatedAt: "2026-08-21T14:59:00.000Z",
  };
}

function view(taskState: AutodlH3JobState, instanceState: AutodlH3InstanceState, progress = 0, idleSince: string | null = null) {
  return buildAutodlH3LifecycleView({
    job: job(taskState, progress),
    instance: instance(instanceState, idleSince),
    nowMs: now,
    idleGraceSeconds: 300,
  });
}

const queuedOff = view("ACCEPTED", "OFF");
assert.equal(queuedOff.headline, "任务已排队，等待自动开机");
assert.equal(queuedOff.progress, null, "queued/power states must not invent a percentage");

const poweringOn = view("ACCEPTED", "STARTING");
assert.equal(poweringOn.headline, "正在开机");

const bootstrapping = view("WAITING_READY", "BOOTSTRAPPING");
assert.equal(bootstrapping.headline, "实例已 running，正在建隧道/预热网关");

const dispatching = view("DISPATCHING", "BUSY");
assert.equal(dispatching.headline, "正在提交 H3");

const gpuRunning = view("RUNNING", "BUSY", 42);
assert.equal(gpuRunning.headline, "GPU 正在生成");
assert.equal(gpuRunning.progress, 42, "only observed RUNNING progress may be shown");

const resultPersisting = view("PERSISTING", "BUSY", 95);
assert.equal(resultPersisting.headline, "正在转存结果");
assert.equal(resultPersisting.progress, null, "result stages use labels, not the legacy 95% placeholder");

const idleCountdown = view("SUCCEEDED", "IDLE_GRACE", 100, "2026-08-21T14:59:30.000Z");
assert.equal(idleCountdown.idleRemainingSeconds, 270);
assert.match(idleCountdown.headline, /空闲倒计时 04:30/u);
assert.equal(idleCountdown.monitorComplete, false);

const stopping = view("SUCCEEDED", "STOPPING", 100);
assert.match(stopping.headline, /正在关机/u);
assert.equal(stopping.monitorComplete, false);

const poweredOff = view("SUCCEEDED", "OFF", 100);
assert.match(poweredOff.headline, /实例已关机/u);
assert.equal(poweredOff.monitorComplete, true);

const safeJson = JSON.stringify(poweredOff);
for (const forbidden of [
  "instance-private",
  "gateway-private-task-id",
  "h3cr_private_client_request",
  "worker-private",
  "must-not-leak",
]) {
  assert.equal(safeJson.includes(forbidden), false, `view leaked private field: ${forbidden}`);
}

console.log(JSON.stringify({
  status: "passed",
  stagesVerified: [
    "queued",
    "powering_on",
    "instance_running_gateway_warmup",
    "dispatching",
    "gpu_running",
    "result_persisting",
    "idle_countdown",
    "powering_off",
    "powered_off",
  ],
  fakeProgressRemoved: true,
  privateFieldsLeaked: false,
  networkRequests: 0,
}));
