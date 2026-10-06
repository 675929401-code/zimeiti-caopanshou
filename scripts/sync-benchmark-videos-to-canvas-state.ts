import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const storageStatePath = ".tmp-e2e/benchmark-director-v8-live/storage-state.json";
const graphStorageKey = "ai-creation-studio-graph-v1";
const sessionsStorageKey = "ai-creation-studio-free-canvas-sessions-v1";
const activeSessionStorageKey = "ai-creation-studio-free-canvas-active-session-v1";
const modelId = "grok-imagine-video-1-5-fast-chA";

type CloudTask = {
  id: string;
  modelId: string;
  taskIdExternal: string;
  taskLabel: string;
  videoUrl: string;
  cardIndex: number;
  completedAt: string;
};

type StoredNode = {
  data: {
    kind: string;
    title: string;
    modelId?: string;
    lockedModelId?: string;
    taskId?: string;
    outputUrl?: string;
    providerContentUrl?: string;
    status?: string;
    progressMessage?: string;
    history?: Array<{ id: string; outputUrl: string; createdAt: string }>;
  };
};

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string };
  assert.ok(session.token, "本地验收会话不可用");
  const tasksResponse = await fetch(`${baseUrl}/api/bridge/video/active-tasks`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.ok(tasksResponse.ok, `任务恢复接口失败：HTTP ${tasksResponse.status}`);
  const taskPayload = await tasksResponse.json() as { recentlyCompleted?: CloudTask[] };
  const latestByShot = new Map<number, CloudTask>();
  for (const task of taskPayload.recentlyCompleted || []) {
    if (task.modelId !== modelId || !task.taskLabel.startsWith("对标验收分镜")) continue;
    const previous = latestByShot.get(task.cardIndex);
    if (!previous || Date.parse(task.completedAt) > Date.parse(previous.completedAt)) latestByShot.set(task.cardIndex, task);
  }
  assert.equal(latestByShot.size, 11, `只恢复到${latestByShot.size}/11条最终视频`);

  const storage = JSON.parse(await readFile(storageStatePath, "utf8")) as {
    origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  const origin = storage.origins?.find((item) => item.origin === baseUrl);
  assert.ok(origin, "恢复文件中没有本地画布数据");
  const graphEntry = origin.localStorage.find((item) => item.name === graphStorageKey);
  assert.ok(graphEntry, "恢复文件中没有画布图");
  const graph = JSON.parse(graphEntry.value) as { nodes?: StoredNode[]; edges?: unknown[] };
  let updated = 0;
  for (const [shot, task] of latestByShot) {
    const label = String(shot).padStart(2, "0");
    const node = graph.nodes?.find((item) => item.data.kind === "video" && item.data.title.startsWith(`分镜${label} · 关键帧生成视频`));
    assert.ok(node, `画布缺少分镜${label}视频节点`);
    const proxyUrl = `/api/video/proxy?id=${task.id}`;
    node.data.modelId = modelId;
    node.data.lockedModelId = modelId;
    node.data.taskId = task.taskIdExternal;
    node.data.outputUrl = proxyUrl;
    node.data.providerContentUrl = task.videoUrl;
    node.data.status = "succeeded";
    node.data.progressMessage = "真实视频已完成并通过验收";
    node.data.history = [
      { id: randomUUID(), outputUrl: proxyUrl, createdAt: task.completedAt },
      ...(node.data.history || []).filter((item) => item.outputUrl !== proxyUrl),
    ];
    updated += 1;
  }
  graphEntry.value = JSON.stringify(graph);
  const sessionsEntry = origin.localStorage.find((item) => item.name === sessionsStorageKey);
  const activeSessionEntry = origin.localStorage.find((item) => item.name === activeSessionStorageKey);
  if (sessionsEntry && activeSessionEntry) {
    const sessions = JSON.parse(sessionsEntry.value) as Array<{ id: string; nodes: StoredNode[]; edges: unknown[]; updatedAt?: string }>;
    const activeSession = sessions.find((session) => session.id === activeSessionEntry.value);
    assert.ok(activeSession, "验收恢复文件缺少活动画布会话");
    activeSession.nodes = graph.nodes || [];
    activeSession.edges = graph.edges || [];
    activeSession.updatedAt = new Date().toISOString();
    sessionsEntry.value = JSON.stringify(sessions);
  }
  await writeFile(storageStatePath, `${JSON.stringify(storage, null, 2)}\n`, "utf8");
  await writeFile(
    ".tmp-e2e/benchmark-director-v8-live/final-video-tasks.json",
    `${JSON.stringify([...latestByShot.values()].sort((a, b) => a.cardIndex - b.cardIndex), null, 2)}\n`,
    "utf8",
  );
  console.log(`已把${updated}条最终视频回填到验收画布状态`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
