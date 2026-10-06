import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/components/manual-canvas.tsx"), "utf8");

function sliceFunction(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `缺少函数：${startMarker}`);
  assert.ok(end > start, `无法确定函数边界：${startMarker}`);
  return source.slice(start, end);
}

const checkpoint = sliceFunction(
  "async function ensureActiveCanvasPersistedForGeneration()",
  "useEffect(() => {",
);
assert.match(checkpoint, /buildCanvasDocument\(activeSession, nodesRef\.current, edgesRef\.current\)/u);
assert.match(checkpoint, /await persistCanvasDocument\(snapshot\.session, snapshot\.document\)/u);
assert.match(checkpoint, /revision <= 0/u);
assert.match(checkpoint, /未调用上游、未扣费/u);

const batch = sliceFunction(
  "async function executeWorkflowStage(stage: GenerationStage)",
  "async function uploadAsset",
);
assert.ok(
  batch.indexOf("await ensureActiveCanvasPersistedForGeneration()")
    < batch.indexOf("lockMediaNodeModels("),
  "批量生成必须先保存画布，再锁定模型并启动任务",
);

const runNode = sliceFunction(
  "function runNode(nodeId: string, options: NodeExecutionOptions = {})",
  "function regenerateNode",
);
assert.match(runNode, /node\.data\.kind === "image" \|\| node\.data\.kind === "video" \|\| generatedAudio/u);
assert.ok(
  runNode.indexOf("await ensureActiveCanvasPersistedForGeneration()")
    < runNode.indexOf("return executeNode("),
  "单节点生成必须在 executeNode 前完成账号持久化",
);

const regenerate = sliceFunction(
  "function regenerateNode(nodeId: string)",
  "function runFirstPendingAsset",
);
assert.ok(
  regenerate.indexOf("await ensureActiveCanvasPersistedForGeneration()")
    < regenerate.indexOf("replaceRuntimeNode(nodesRef.current, nodeId"),
  "重新生成必须先保存原结果，再清空运行态",
);
assert.match(regenerate, /replaceRuntimeNode\(nodesRef\.current, nodeId, previousData\)/u);
assert.match(regenerate, /persistenceCheckpointConfirmed: true/u);

console.log("PASS canvas generation persistence gate (batch, single node, regenerate rollback)");
