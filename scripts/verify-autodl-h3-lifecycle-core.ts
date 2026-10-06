import assert from "node:assert/strict";

import {
  AutodlH3LifecycleController,
  type AutodlH3LifecycleControllerConfig,
  type AutodlH3LifecycleStore,
  InMemoryAutodlH3LifecycleStore,
  buildAutodlH3ClientRequestId,
  createAutodlH3PublicTaskId,
  enqueueAutodlH3VideoJob,
  isStableAutodlH3ResultAssetUrl,
  markAutodlH3JobProgress,
  sanitizeAutodlH3Diagnostic,
} from "../src/lib/autodl-h3-lifecycle";

const instanceUuid = "pro-test-instance";
const userId = "00000000-0000-4000-8000-000000000001";

function requestIdentity(seed: string) {
  const clientRequestId = buildAutodlH3ClientRequestId({ userId, idempotencyKey: seed });
  return {
    clientRequestId,
    publicTaskId: createAutodlH3PublicTaskId({ userId, clientRequestId }),
  };
}

async function testIdempotencyAndTerminalIdle(): Promise<void> {
  let nowMs = Date.parse("2026-08-21T00:00:00.000Z");
  const store = new InMemoryAutodlH3LifecycleStore(() => new Date(nowMs));
  const identity = requestIdentity("client-request-0001");
  const input = {
    userId,
    modelId: "h3-model",
    idempotencyKey: identity.clientRequestId,
    publicTaskId: identity.publicTaskId,
    videoTaskInternalId: `vt_${identity.publicTaskId}`,
    instanceUuid,
    requestPayload: { prompt: "test", duration: 5, idempotencyKey: identity.clientRequestId },
  };
  const first = await enqueueAutodlH3VideoJob(input, { store });
  const replay = await enqueueAutodlH3VideoJob(input, { store });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.publicTaskId, first.publicTaskId);

  const claimed = await store.claimNextJob(instanceUuid, "worker-a", 30);
  assert.ok(claimed);
  await store.transitionClaimedJob({
    jobId: claimed.id,
    owner: "worker-a",
    leaseToken: claimed.leaseToken,
    state: "QUEUED",
    upstreamTaskId: "upstream-1",
  });
  const active = await store.claimActiveJob(instanceUuid, "worker-a", 30);
  assert.ok(active);
  const fence = {
    jobId: active.id,
    publicTaskId: first.publicTaskId,
    userId,
    leaseOwner: "worker-a",
    leaseToken: active.leaseToken,
  };
  await markAutodlH3JobProgress({ ...fence, state: "RUNNING", progress: 30 }, { store });
  await markAutodlH3JobProgress({ ...fence, state: "PERSISTING", progress: 95 }, { store });
  const monotonic = await markAutodlH3JobProgress({ ...fence, state: "PERSISTING", progress: 20 }, { store });
  assert.equal(monotonic?.progress, 95, "progress may never move backwards");
  const stale = await markAutodlH3JobProgress({ ...fence, leaseToken: active.leaseToken - 1, state: "FINALIZING" }, { store });
  assert.equal(stale, null, "stale fencing token must not mutate progress");
  await assert.rejects(() => store.transitionClaimedJob({
    jobId: active.id,
    owner: "worker-a",
    leaseToken: active.leaseToken,
    state: "SUCCEEDED",
    resultAssetUrl: "object://tencent_cos/video/final.mp4",
  }), /ATOMIC_SETTLEMENT/);
  await store.transitionClaimedJob({
    jobId: active.id,
    owner: "worker-a",
    leaseToken: active.leaseToken,
    state: "FAILED_TERMINAL",
    errorCode: "TEST_TERMINAL",
  });

  const lease = await store.acquireInstanceLease(instanceUuid, "worker-a", 30);
  assert.ok(lease);
  const idleSince = new Date(nowMs).toISOString();
  const idling = await store.updateInstanceState({
    instanceUuid,
    owner: "worker-a",
    leaseToken: lease.leaseToken,
    lifecycleState: "IDLE_GRACE",
    lastActivityAt: lease.lastActivityAt,
    idleSince,
    lastErrorCode: null,
    lastErrorMessage: null,
  });
  assert.ok(idling);
  const epochBeforeReplay = idling.activityEpoch;
  nowMs += 120_000;
  assert.equal(await markAutodlH3JobProgress({ ...fence, state: "FINALIZING" }, { store }), null);
  const afterReplay = await store.acquireInstanceLease(instanceUuid, "worker-a", 30);
  assert.ok(afterReplay);
  assert.equal(afterReplay.activityEpoch, epochBeforeReplay, "terminal polling must not advance activity epoch");
  assert.equal(afterReplay.idleSince, idleSince, "terminal polling must not clear idle_since");
}

function controllerConfig(ownerId: string): AutodlH3LifecycleControllerConfig {
  return {
    enabled: true,
    dryRun: false,
    allowPowerActions: true,
    instanceUuid,
    ownerId,
    leaseSeconds: 30,
    idleGraceMs: 300_000,
    retryDelayMs: 30_000,
    maxDispatchAttempts: 3,
    startupDeadlineMs: 720_000,
    powerActionDeadlineMs: 180_000,
  };
}

function controllerDependencies(store: AutodlH3LifecycleStore, now: () => Date, onPowerOff: () => void) {
  return {
    store,
    now,
    instanceClient: {
      async getStatus() { return { powerState: "running" as const }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { return { accepted: true }; },
      async powerOff() { onPowerOff(); return { accepted: true }; },
    },
    tunnel: {
      async ensureReady() { return { ready: true }; },
      async isReady() { return true; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
  };
}

async function testIdleBoundaryAndEnqueueRace(): Promise<void> {
  let nowMs = Date.parse("2026-08-21T01:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = new InMemoryAutodlH3LifecycleStore(now);
  let powerOffCalls = 0;
  const controller = new AutodlH3LifecycleController({
    ...controllerDependencies(store, now, () => { powerOffCalls += 1; }),
    config: controllerConfig("worker-boundary"),
  });
  assert.equal((await controller.tick()).action, "idle_wait");
  nowMs += 299_000;
  assert.equal((await controller.tick()).action, "idle_wait");
  assert.equal(powerOffCalls, 0);
  nowMs += 1_000;
  assert.equal((await controller.tick()).action, "power_off_requested");
  assert.equal(powerOffCalls, 1);

  nowMs = Date.parse("2026-08-21T02:00:00.000Z");
  const raceStore = new InMemoryAutodlH3LifecycleStore(now);
  let racePowerOffCalls = 0;
  const originalConfirm = raceStore.confirmShutdown.bind(raceStore);
  let racedPublicTaskId = "";
  raceStore.confirmShutdown = async input => {
    const identity = requestIdentity("client-request-race");
    racedPublicTaskId = identity.publicTaskId;
    await enqueueAutodlH3VideoJob({
      userId,
      modelId: "h3-model",
      idempotencyKey: identity.clientRequestId,
      publicTaskId: identity.publicTaskId,
      videoTaskInternalId: `vt_${identity.publicTaskId}`,
      instanceUuid,
      requestPayload: { prompt: "race", idempotencyKey: identity.clientRequestId },
    }, { store: raceStore });
    return originalConfirm(input);
  };
  const raceController = new AutodlH3LifecycleController({
    ...controllerDependencies(raceStore, now, () => { racePowerOffCalls += 1; }),
    config: controllerConfig("worker-race"),
  });
  await raceController.tick();
  nowMs += 300_000;
  assert.equal((await raceController.tick()).action, "idle_wait");
  assert.equal(racePowerOffCalls, 0, "enqueue between shutdown gates must cancel power_off");
  const racedJob = await raceStore.getJobByPublicTaskId(racedPublicTaskId, userId);
  assert.equal(racedJob?.state, "WAITING_POWER");
}

async function enqueueFixture(
  store: InMemoryAutodlH3LifecycleStore,
  seed: string,
): Promise<string> {
  const identity = requestIdentity(seed);
  await enqueueAutodlH3VideoJob({
    userId,
    modelId: "h3-model",
    idempotencyKey: identity.clientRequestId,
    publicTaskId: identity.publicTaskId,
    videoTaskInternalId: `vt_${identity.publicTaskId}`,
    instanceUuid,
    requestPayload: { prompt: seed, duration: 10, idempotencyKey: identity.clientRequestId },
  }, { store });
  return identity.publicTaskId;
}

async function testWakeReadyDispatchAndMultiWorkerFence(): Promise<void> {
  let nowMs = Date.parse("2026-08-21T03:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = new InMemoryAutodlH3LifecycleStore(now);
  const publicTaskId = await enqueueFixture(store, "client-request-wake-dispatch");
  let powerState: "stopped" | "starting" | "running" = "stopped";
  let powerOnCalls = 0;
  let dispatchCalls = 0;
  let tunnelReady = false;
  const dependencies = {
    store,
    now,
    instanceClient: {
      async getStatus() { return { powerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { powerOnCalls += 1; return { accepted: true }; },
      async powerOff() { throw new Error("not expected"); },
    },
    tunnel: {
      async ensureReady() { return { ready: tunnelReady }; },
      async isReady() { return tunnelReady; },
    },
    dispatcher: {
      async dispatch() { dispatchCalls += 1; return { upstreamTaskId: "upstream-wake-1" }; },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
  };
  const controllerA = new AutodlH3LifecycleController({
    ...dependencies,
    config: controllerConfig("worker-wake-a"),
  });
  const controllerB = new AutodlH3LifecycleController({
    ...dependencies,
    config: controllerConfig("worker-wake-b"),
  });

  const firstPair = await Promise.all([controllerA.tick(), controllerB.tick()]);
  assert.equal(firstPair.filter(result => result.action === "power_on_requested").length, 1);
  assert.equal(firstPair.filter(result => result.action === "lease_busy").length, 1);
  assert.equal(powerOnCalls, 1, "two workers may issue only one normal power_on");
  assert.equal((await controllerA.tick()).action, "starting");
  assert.equal(powerOnCalls, 1, "STARTING + stopped must not repeat power_on");

  powerState = "starting";
  assert.equal((await controllerA.tick()).action, "starting");
  powerState = "running";
  assert.equal((await controllerA.tick()).action, "not_ready");
  assert.equal(dispatchCalls, 0, "job must wait for tunnel and gateway readiness");
  tunnelReady = true;
  assert.equal((await controllerA.tick()).action, "dispatched");
  assert.equal(dispatchCalls, 1);
  const dispatched = await store.getJobByPublicTaskId(publicTaskId, userId);
  assert.equal(dispatched?.state, "QUEUED");
  assert.equal(dispatched?.upstreamTaskId, "upstream-wake-1");

  const leaseA = await store.acquireInstanceLease("pro-fence-instance", "worker-old", 30);
  assert.ok(leaseA);
  nowMs += 31_000;
  const leaseB = await store.acquireInstanceLease("pro-fence-instance", "worker-new", 30);
  assert.ok(leaseB && leaseB.leaseToken > leaseA.leaseToken);
  const staleWrite = await store.updateInstanceState({
    instanceUuid: "pro-fence-instance",
    owner: leaseA.leaseOwner,
    leaseToken: leaseA.leaseToken,
    lifecycleState: "OFF",
    lastActivityAt: null,
    idleSince: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  });
  assert.equal(staleWrite, null, "expired worker fencing token must not mutate instance state");
}

async function testPowerActionCrashRecovery(): Promise<void> {
  let nowMs = Date.parse("2026-08-21T04:00:00.000Z");
  const now = () => new Date(nowMs);
  const wakeStore = new InMemoryAutodlH3LifecycleStore(now);
  await enqueueFixture(wakeStore, "client-request-power-on-crash");
  let powerOnCalls = 0;
  const wakeController = new AutodlH3LifecycleController({
    store: wakeStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState: "stopped" as const }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() {
        powerOnCalls += 1;
        if (powerOnCalls === 1) throw new Error("simulated crash after durable START_REQUESTED");
        return { accepted: true };
      },
      async powerOff() { throw new Error("not expected"); },
    },
    tunnel: {
      async ensureReady() { return { ready: false }; },
      async isReady() { return false; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-on-recovery"),
  });
  assert.equal((await wakeController.tick()).action, "faulted");
  assert.equal(powerOnCalls, 1);
  nowMs += 179_000;
  assert.equal((await wakeController.tick()).action, "starting");
  assert.equal(powerOnCalls, 1, "power_on replay must wait for official-status deadline");
  nowMs += 1_000;
  assert.equal((await wakeController.tick()).action, "power_on_requested");
  assert.equal(powerOnCalls, 2, "unknown power_on outcome receives one status-gated replay");
  assert.equal((await wakeController.tick()).action, "starting");
  assert.equal(powerOnCalls, 2, "accepted replay must converge without a third call");

  nowMs = Date.parse("2026-08-21T05:00:00.000Z");
  const stopStore = new InMemoryAutodlH3LifecycleStore(now);
  let powerState: "running" | "stopping" | "stopped" = "running";
  let powerOffCalls = 0;
  const stopController = new AutodlH3LifecycleController({
    store: stopStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { throw new Error("not expected"); },
      async powerOff() {
        powerOffCalls += 1;
        if (powerOffCalls === 1) throw new Error("simulated crash after durable STOP_REQUESTED");
        return { accepted: true };
      },
    },
    tunnel: {
      async ensureReady() { return { ready: true }; },
      async isReady() { return true; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-off-recovery"),
  });
  assert.equal((await stopController.tick()).action, "idle_wait");
  nowMs += 300_000;
  assert.equal((await stopController.tick()).action, "faulted");
  assert.equal(powerOffCalls, 1);
  nowMs += 179_000;
  assert.equal((await stopController.tick()).action, "stopping");
  assert.equal(powerOffCalls, 1, "power_off replay must wait for official-status deadline");
  nowMs += 1_000;
  assert.equal((await stopController.tick()).action, "power_off_requested");
  assert.equal(powerOffCalls, 2, "unknown power_off outcome receives one status-gated replay");
  assert.equal((await stopController.tick()).action, "stopping");
  assert.equal(powerOffCalls, 2, "STOPPING + running must not repeat power_off");
  powerState = "stopping";
  assert.equal((await stopController.tick()).action, "stopping");
  powerState = "stopped";
  assert.equal((await stopController.tick()).action, "no_job");
  const stoppedLease = await stopStore.acquireInstanceLease(instanceUuid, "worker-power-off-recovery", 30);
  assert.equal(stoppedLease?.lifecycleState, "OFF", "official stopped status must converge lifecycle state to OFF");

  nowMs = Date.parse("2026-08-21T06:00:00.000Z");
  const failedReplayStore = new InMemoryAutodlH3LifecycleStore(now);
  await enqueueFixture(failedReplayStore, "client-request-power-on-replay-fails");
  let failedReplayPowerState: "stopped" | "starting" | "running" = "stopped";
  let failedReplayCalls = 0;
  const failedReplayController = new AutodlH3LifecycleController({
    store: failedReplayStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState: failedReplayPowerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { failedReplayCalls += 1; throw new Error("unknown power_on outcome"); },
      async powerOff() { throw new Error("not expected"); },
    },
    tunnel: {
      async ensureReady() { return { ready: false }; },
      async isReady() { return false; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-on-replay-fails"),
  });
  assert.equal((await failedReplayController.tick()).action, "faulted");
  nowMs += 180_000;
  assert.deepEqual(await failedReplayController.tick(), { action: "faulted", code: "POWER_ON_REPLAY_FAILED" });
  nowMs += 600_000;
  assert.deepEqual(await failedReplayController.tick(), { action: "faulted", code: "POWER_ON_REPLAY_FAILED" });
  assert.equal(failedReplayCalls, 2, "failed safe replay must fail closed without an unbounded third power_on");
  failedReplayPowerState = "starting";
  assert.equal((await failedReplayController.tick()).action, "starting");
  failedReplayPowerState = "running";
  assert.equal((await failedReplayController.tick()).action, "not_ready", "official running must reconcile a late power_on success");

  nowMs = Date.parse("2026-08-21T07:00:00.000Z");
  const failedStopReplayStore = new InMemoryAutodlH3LifecycleStore(now);
  let failedStopPowerState: "running" | "stopping" | "stopped" = "running";
  let failedStopReplayCalls = 0;
  const failedStopReplayController = new AutodlH3LifecycleController({
    store: failedStopReplayStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState: failedStopPowerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { throw new Error("not expected"); },
      async powerOff() { failedStopReplayCalls += 1; throw new Error("unknown power_off outcome"); },
    },
    tunnel: {
      async ensureReady() { return { ready: true }; },
      async isReady() { return true; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-off-replay-fails"),
  });
  assert.equal((await failedStopReplayController.tick()).action, "idle_wait");
  nowMs += 300_000;
  assert.equal((await failedStopReplayController.tick()).action, "faulted");
  nowMs += 180_000;
  assert.deepEqual(await failedStopReplayController.tick(), { action: "faulted", code: "POWER_OFF_REPLAY_FAILED" });
  nowMs += 600_000;
  assert.deepEqual(await failedStopReplayController.tick(), { action: "faulted", code: "POWER_OFF_REPLAY_FAILED" });
  assert.equal(failedStopReplayCalls, 2, "failed safe replay must fail closed without an unbounded third power_off");
  failedStopPowerState = "stopping";
  assert.equal((await failedStopReplayController.tick()).action, "stopping");
  failedStopPowerState = "stopped";
  assert.equal((await failedStopReplayController.tick()).action, "no_job", "official stopped must reconcile a late power_off success");
}

async function testSecondCrashAfterReplayIsDurablyFenced(): Promise<void> {
  let nowMs = Date.parse("2026-08-21T08:00:00.000Z");
  const now = () => new Date(nowMs);
  const wakeStore = new InMemoryAutodlH3LifecycleStore(now);
  await enqueueFixture(wakeStore, "client-request-power-on-second-crash");
  let wakePowerState: "stopped" | "starting" | "running" | "unknown" = "stopped";
  let powerOnCalls = 0;
  const originalWakeUpdate = wakeStore.updateInstanceState.bind(wakeStore);
  let crashBeforeReplayAcceptedState = true;
  wakeStore.updateInstanceState = async input => {
    if (input.lifecycleState === "STARTING" && powerOnCalls === 2 && crashBeforeReplayAcceptedState) {
      crashBeforeReplayAcceptedState = false;
      throw new Error("simulated second crash before STARTING persist");
    }
    return originalWakeUpdate(input);
  };
  const wakeController = new AutodlH3LifecycleController({
    store: wakeStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState: wakePowerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() {
        powerOnCalls += 1;
        if (powerOnCalls === 1) throw new Error("ambiguous first power_on");
        return { accepted: true };
      },
      async powerOff() { throw new Error("not expected"); },
    },
    tunnel: {
      async ensureReady() { return { ready: false }; },
      async isReady() { return false; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-on-second-crash"),
  });
  assert.equal((await wakeController.tick()).action, "faulted");
  nowMs += 180_000;
  assert.equal((await wakeController.tick()).action, "faulted");
  assert.equal(powerOnCalls, 2);
  wakePowerState = "unknown";
  assert.deepEqual(await wakeController.tick(), { action: "faulted", code: "POWER_ON_REPLAY_IN_FLIGHT" });
  wakePowerState = "stopped";
  nowMs += 600_000;
  assert.deepEqual(await wakeController.tick(), { action: "faulted", code: "POWER_ON_REPLAY_IN_FLIGHT" });
  assert.equal(powerOnCalls, 2, "second crash after replay must never issue a third power_on");
  wakePowerState = "starting";
  assert.equal((await wakeController.tick()).action, "starting", "official starting must clear ambiguous replay fault");
  wakePowerState = "running";
  assert.equal((await wakeController.tick()).action, "not_ready");
  assert.equal(powerOnCalls, 2);

  nowMs = Date.parse("2026-08-21T09:00:00.000Z");
  const stopStore = new InMemoryAutodlH3LifecycleStore(now);
  let stopPowerState: "running" | "stopping" | "stopped" | "unknown" = "running";
  let powerOffCalls = 0;
  const originalStopUpdate = stopStore.updateInstanceState.bind(stopStore);
  let crashBeforeReplayStoppingState = true;
  stopStore.updateInstanceState = async input => {
    if (input.lifecycleState === "STOPPING" && powerOffCalls === 2 && crashBeforeReplayStoppingState) {
      crashBeforeReplayStoppingState = false;
      throw new Error("simulated second crash before STOPPING persist");
    }
    return originalStopUpdate(input);
  };
  const stopController = new AutodlH3LifecycleController({
    store: stopStore,
    now,
    instanceClient: {
      async getStatus() { return { powerState: stopPowerState }; },
      async getSnapshot() { return { instanceUuid }; },
      async powerOn() { throw new Error("not expected"); },
      async powerOff() {
        powerOffCalls += 1;
        if (powerOffCalls === 1) throw new Error("ambiguous first power_off");
        return { accepted: true };
      },
    },
    tunnel: {
      async ensureReady() { return { ready: true }; },
      async isReady() { return true; },
    },
    dispatcher: {
      async dispatch() { throw new Error("not expected"); },
      async recoverUnknownDispatch() { return { outcome: "unknown" as const }; },
      async reconcile() { throw new Error("not expected"); },
      async getActivity() {
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 0 };
      },
    },
    config: controllerConfig("worker-power-off-second-crash"),
  });
  assert.equal((await stopController.tick()).action, "idle_wait");
  nowMs += 300_000;
  assert.equal((await stopController.tick()).action, "faulted");
  nowMs += 180_000;
  assert.equal((await stopController.tick()).action, "faulted");
  assert.equal(powerOffCalls, 2);
  stopPowerState = "unknown";
  assert.deepEqual(await stopController.tick(), { action: "faulted", code: "POWER_OFF_REPLAY_IN_FLIGHT" });
  stopPowerState = "running";
  nowMs += 600_000;
  assert.deepEqual(await stopController.tick(), { action: "faulted", code: "POWER_OFF_REPLAY_IN_FLIGHT" });
  assert.equal(powerOffCalls, 2, "second crash after replay must never issue a third power_off");
  stopPowerState = "stopping";
  assert.equal((await stopController.tick()).action, "stopping", "official stopping must clear ambiguous replay fault");
  stopPowerState = "stopped";
  assert.equal((await stopController.tick()).action, "no_job");
  assert.equal(powerOffCalls, 2);
}

function testSanitizers(): void {
  assert.equal(isStableAutodlH3ResultAssetUrl("object://tencent_cos/video/final.mp4"), true);
  assert.equal(isStableAutodlH3ResultAssetUrl("object://tencent_cos/video/../secret"), false);
  assert.equal(isStableAutodlH3ResultAssetUrl("object://tencent_cos/video/%252e%252e/secret"), false);
  assert.equal(isStableAutodlH3ResultAssetUrl("https://host.example/final.mp4?token=secret"), false);
  assert.equal(isStableAutodlH3ResultAssetUrl("https://host.example/final.mp4"), true);
  const sentinel = "SENTINEL_SECRET_VALUE_123456789012345678901234567890";
  const sanitized = sanitizeAutodlH3Diagnostic(`failed https://host/path?token=${sentinel}&sig=${sentinel}`);
  assert.equal(sanitized.includes(sentinel), false);
}

async function main(): Promise<void> {
  testSanitizers();
  await testIdempotencyAndTerminalIdle();
  await testIdleBoundaryAndEnqueueRace();
  await testWakeReadyDispatchAndMultiWorkerFence();
  await testPowerActionCrashRecovery();
  await testSecondCrashAfterReplayIsDurablyFenced();
  console.log("AutoDL H3 lifecycle core: zero-network verification passed");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "verification failed");
  process.exitCode = 1;
});
