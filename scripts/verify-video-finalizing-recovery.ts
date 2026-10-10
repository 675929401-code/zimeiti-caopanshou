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
  const activeQueryStart = activeTasks.indexOf("// 查询所有未完成的任务");
  const activeQueryEnd = activeTasks.indexOf("if (error)", activeQueryStart);
  assert.ok(activeQueryStart >= 0 && activeQueryEnd > activeQueryStart, "active task query must remain inspectable");
  const activeQuery = activeTasks.slice(activeQueryStart, activeQueryEnd);
  assert.doesNotMatch(activeQuery, /\.gte\("created_at"/u, "unfinished task recovery must not expire after three days");
  assert.doesNotMatch(activeTasks, /VIDEO_PAGE_HISTORY_RETENTION_DAYS/u, "unfinished task recovery must not keep a hidden age window");
  assert.match(activeQuery, /\.eq\("user_id", userId\)[\s\S]*\.is\("history_hidden_at", null\)[\s\S]*\.in\("status", \["pending", "queued", "processing", "generating", "finalizing", "billing_pending"\]\)/u,
    "unbounded recovery must preserve owner, visibility, and active-status safety boundaries");

  console.log("video finalizing recovery zero-cost verifier: PASS; unfinishedAgeWindow=none; paidRequests=0");
}

void main();
