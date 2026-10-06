import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const root = process.cwd();
  const history = await readFile(path.join(root, "src/app/api/video/history/route.ts"), "utf8");
  const activeTasks = await readFile(path.join(root, "src/app/api/video/active-tasks/route.ts"), "utf8");
  const presentation = await readFile(path.join(root, "src/lib/video-history-presentation.ts"), "utf8");

  const activeStatuses = '["pending", "queued", "processing", "generating", "finalizing", "billing_pending"]';

  assert.equal(
    history.split(`.in("status", ${activeStatuses})`).length - 1,
    2,
    "video history must restore finalizing tasks in both active query paths",
  );
  assert.match(history, /sortVideoHistoryBySubmission\([^)]+\)/u, "video history must use the shared submission-time ordering");
  assert.match(presentation, /time\(b\.createdAt\) - time\(a\.createdAt\)/u, "shared history ordering must be newest submission first");
  assert.match(
    history,
    /generating:\s*7,[\s\S]*finalizing:\s*6,[\s\S]*processing:\s*5/u,
    "dedupe priority must retain the newest in-flight finalizing task",
  );
  assert.equal(
    activeTasks.includes(`.in("status", ${activeStatuses})`),
    true,
    "active task recovery must include finalizing",
  );

  console.log("video finalizing recovery verifier: PASS");
}

void main();
