import 'server-only';
import { startVideoHistoryWorker, stopVideoHistoryWorker, videoHistoryWorkerStatus } from '@/lib/video-history-worker';
import {
  startUserContentRetentionWorker,
  stopUserContentRetentionWorker,
  userContentRetentionWorkerStatus,
} from '@/lib/user-content-retention-worker';
import {
  commerceRollingWorkerStatus,
  startCommerceRollingWorker,
  stopCommerceRollingWorker,
} from '@/commerce/server/rolling-video-worker';
import {
  commerceOrdinaryWorkerStatus,
  startCommerceOrdinaryWorker,
  stopCommerceOrdinaryWorker,
} from '@/commerce/server/ordinary-worker';

import {
  digitalVideoQueueWorkerStatus,
  startDigitalVideoQueueWorker,
  stopDigitalVideoQueueWorker,
} from '@/lib/digital-video-queue-worker';
import {
  digitalHumanLongWorkerStatus,
  startDigitalHumanLongWorker,
  stopDigitalHumanLongWorker,
} from '@/lib/digital-human-long-worker';

type RuntimeState = {
  started: boolean;
  stopping: boolean;
  signalHandlersInstalled: boolean;
  shutdown?: Promise<boolean>;
};

const runtimeGlobal = globalThis as typeof globalThis & { __mediaQueueWorkerRuntime?: RuntimeState };

function state() {
  return runtimeGlobal.__mediaQueueWorkerRuntime ??= {
    started: false,
    stopping: false,
    signalHandlersInstalled: false,
  };
}

function drainTimeoutMs() {
  const parsed = Number(process.env.MEDIA_QUEUE_WORKER_DRAIN_MS || 25_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(60_000, Math.trunc(parsed))) : 25_000;
}

export async function stopMediaQueueWorkerRuntime(reason = 'shutdown') {
  const runtime = state();
  if (runtime.shutdown) return runtime.shutdown;
  runtime.stopping = true;
  runtime.shutdown = Promise.all([
    stopVideoHistoryWorker(drainTimeoutMs()),
    stopUserContentRetentionWorker(drainTimeoutMs()),
    stopDigitalVideoQueueWorker(drainTimeoutMs()),
    stopDigitalHumanLongWorker(drainTimeoutMs()),
    stopCommerceRollingWorker(drainTimeoutMs()),
    stopCommerceOrdinaryWorker(drainTimeoutMs()),
  ]).then((results) => {
    runtime.started = false;
    const drained = results.every(Boolean);
    console.info('[MediaQueueWorker] stopped', { reason, drained });
    return drained;
  });
  return runtime.shutdown;
}

function installSignalHandlers() {
  const runtime = state();
  if (runtime.signalHandlersInstalled) return;
  runtime.signalHandlersInstalled = true;
  const shutdownAndExit = (reason: string) => {
    void stopMediaQueueWorkerRuntime(reason).finally(() => {
      if (process.env.MEDIA_QUEUE_WORKER_PROCESS === '1') process.exit(0);
    });
  };
  // PM2 uses the message path so the worker can drain before kill_timeout.
  process.on('message', (message) => {
    if (message === 'shutdown') shutdownAndExit('pm2-shutdown');
  });
  // Direct execution and container supervisors use signals as a fallback.
  process.once('SIGINT', () => shutdownAndExit('SIGINT'));
  process.once('SIGTERM', () => shutdownAndExit('SIGTERM'));
}

export function startMediaQueueWorkerRuntime() {
  if (process.env.MEDIA_QUEUE_WORKER_PROCESS !== '1') return false;
  const runtime = state();
  if (runtime.started || runtime.stopping) return false;
  process.env.DIGITAL_VIDEO_QUEUE_WORKER = '1';
  process.env.DIGITAL_HUMAN_LONG_WORKER = '1';
  const ordinary = startDigitalVideoQueueWorker();
  const videoHistory = startVideoHistoryWorker();
  const userContentRetention = startUserContentRetentionWorker();
  const long = startDigitalHumanLongWorker();
  const commerceRolling = startCommerceRollingWorker();
  const commerceOrdinary = startCommerceOrdinaryWorker();
  runtime.started = Boolean(ordinary || long || videoHistory || userContentRetention || commerceRolling || commerceOrdinary);
  installSignalHandlers();
  console.info('[MediaQueueWorker] started', {
    pid: process.pid,
    instance: process.env.NODE_APP_INSTANCE || process.env.pm_id || '0',
    ordinary: Boolean(ordinary),
    videoHistory: Boolean(videoHistory),
    userContentRetention: Boolean(userContentRetention),
    long: Boolean(long),
    commerceRolling: Boolean(commerceRolling),
    commerceOrdinary: Boolean(commerceOrdinary),
  });
  return runtime.started;
}

export function mediaQueueWorkerRuntimeStatus() {
  const runtime = state();
  return {
    started: runtime.started,
    stopping: runtime.stopping,
    ordinary: digitalVideoQueueWorkerStatus(),
    videoHistory: videoHistoryWorkerStatus(),
    userContentRetention: userContentRetentionWorkerStatus(),
    long: digitalHumanLongWorkerStatus(),
    commerceRolling: commerceRollingWorkerStatus(),
    commerceOrdinary: commerceOrdinaryWorkerStatus(),
  };
}
