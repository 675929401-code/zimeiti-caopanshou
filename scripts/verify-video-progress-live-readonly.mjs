#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const ACTIVE = new Set(["pending", "queued", "processing", "generating", "finalizing"]);

async function getJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname} failed (${response.status}): ${payload.error || "unknown"}`);
  return payload;
}

function summarize(tasks) {
  return tasks.reduce((counts, task) => {
    const status = String(task.status || "unknown");
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "real local main-site origin is required");
  assert.ok(token, "verified local administrator token is required");

  const [identity, activePayload, videoPayload, storyboardPayload] = await Promise.all([
    getJson("/api/auth/me"),
    getJson("/api/video/active-tasks"),
    getJson("/api/video/history?surface=video-page&limit=200&offset=0"),
    getJson("/api/video/history?surface=storyboard-workbench&limit=200&offset=0"),
  ]);
  assert.equal(identity.user?.role, "admin", "administrator identity verification failed");

  const activeTasks = Array.isArray(activePayload.activeTasks) ? activePayload.activeTasks : [];
  const recent = Array.isArray(activePayload.recentlyCompleted) ? activePayload.recentlyCompleted : [];
  const videoTasks = Array.isArray(videoPayload.tasks) ? videoPayload.tasks : [];
  const storyboardTasks = Array.isArray(storyboardPayload.tasks) ? storyboardPayload.tasks : [];
  assert.equal(new Set(activeTasks.map((task) => task.id)).size, activeTasks.length, "duplicate active task ids returned");
  assert.ok(activeTasks.every((task) => ACTIVE.has(String(task.status))), "active task API returned a terminal task");
  assert.ok(activeTasks.every((task) => !String(task.taskLabel || "").startsWith("分镜工作台")
    && !String(task.taskLabel || "").startsWith("digital-human:")), "ordinary video recovery leaked another surface");
  assert.ok(videoTasks.every((task) => !String(task.taskLabel || "").startsWith("分镜工作台")
    && !String(task.taskLabel || "").startsWith("digital-human:")), "ordinary video history leaked another surface");
  assert.ok(storyboardTasks.every((task) => String(task.taskLabel || "").startsWith("分镜工作台")), "storyboard history leaked another surface");
  assert.ok([...videoTasks, ...storyboardTasks]
    .filter((task) => task.status === "failed")
    .every((task) => Number(task.priceCharged || 0) === 0), "a failed video task retained a charge");

  const activeWire = JSON.stringify(activePayload);
  assert.ok(!activeWire.includes("taskIdExternal"), "active recovery leaked a provider task id");
  assert.ok(!activeWire.includes("providerResultUrl"), "active recovery leaked a provider result URL");

  let refreshComparison = [];
  if (activeTasks.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const refreshed = await getJson("/api/video/active-tasks");
    const refreshedById = new Map((refreshed.activeTasks || []).map((task) => [task.id, task]));
    refreshComparison = activeTasks.map((before) => {
      const after = refreshedById.get(before.id);
      const beforeSync = Date.parse(String(before.providerLastPolledAt || ""));
      const afterSync = Date.parse(String(after?.providerLastPolledAt || ""));
      return {
        id: before.id,
        persistedAfterRefresh: Boolean(after) || recent.some((task) => task.id === before.id),
        providerSyncAdvanced: Number.isFinite(beforeSync) && Number.isFinite(afterSync) ? afterSync >= beforeSync : null,
        progressBefore: before.progress,
        progressAfter: after?.progress ?? null,
      };
    });
    assert.ok(refreshComparison.every((item) => item.persistedAfterRefresh), "an active task disappeared after refresh");
    assert.ok(refreshComparison.every((item) => item.providerSyncAdvanced !== false), "provider synchronization moved backwards");
  }

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    realApis: true,
    mockedResponses: 0,
    writeRequests: 0,
    active: { count: activeTasks.length, statuses: summarize(activeTasks), refreshComparison },
    recentlyCompleted: { count: recent.length, playable: recent.filter((task) => Boolean(task.videoUrl)).length },
    videoPageHistory: { count: videoTasks.length, statuses: summarize(videoTasks) },
    storyboardHistory: { count: storyboardTasks.length, statuses: summarize(storyboardTasks) },
    failedTasksCharged: [...videoTasks, ...storyboardTasks].filter((task) => task.status === "failed" && Number(task.priceCharged || 0) > 0).length,
  };
  const outDir = path.resolve(".codex-evidence/video-progress-live-readonly");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, "report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, output }, null, 2));
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("/verify-video-progress-live-readonly.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
