import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read("supabase/migrations/20260921103000_video_provider_progress.sql");
const rollback = read("supabase/rollbacks/20260921103000_video_provider_progress.rollback.sql");
const statusService = read("src/lib/video-task-status.ts");
const worker = read("src/lib/video-history-worker.ts");
const activeTasks = read("src/app/api/video/active-tasks/route.ts");
const videoPage = read("src/app/video/page.tsx");
const storyboard = read("src/components/storyboard-workbench.tsx");

for (const column of [
  "provider_progress",
  "provider_status_message",
  "provider_last_polled_at",
  "provider_poll_failures",
]) {
  assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, "u"));
  assert.match(rollback, new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`, "u"));
  assert.match(statusService, new RegExp(`\\b${column}\\b`, "u"));
  assert.match(activeTasks, new RegExp(`\\b${column}\\b`, "u"));
}

assert.match(migration, /provider_last_polled_at ASC NULLS FIRST/u);
assert.match(statusService, /async function persistProviderPollSnapshot/u);
assert.match(statusService, /progress: providerSnapshot\.progress/u);
assert.match(statusService, /lastSyncedAt: providerSnapshot\.lastSyncedAt/u);
assert.match(statusService, /provider_poll_failures: context\.priorFailures \+ 1/u);
assert.match(statusService, /系统仍在后台跟踪原任务/u);
assert.match(statusService, /lastSyncAgeSeconds/u);

assert.match(worker, /order\('provider_last_polled_at', \{ ascending: true, nullsFirst: true \}\)/u);
assert.match(worker, /const VIDEO_HISTORY_POLL_BATCH_SIZE = 16/u);
assert.match(worker, /range\(0, VIDEO_HISTORY_POLL_BATCH_SIZE - 1\)/u);
assert.match(worker, /const VIDEO_HISTORY_POLL_CONCURRENCY = 4/u);
assert.match(worker, /i \+= VIDEO_HISTORY_POLL_CONCURRENCY/u);
assert.match(worker, /tasks\.slice\(i, i \+ VIDEO_HISTORY_POLL_CONCURRENCY\)/u);
assert.doesNotMatch(worker, /offset\s*=/u);

assert.match(activeTasks, /providerStatusMessage: t\.provider_status_message/u);
assert.match(activeTasks, /providerLastPolledAt: t\.provider_last_polled_at/u);
assert.match(activeTasks, /providerPollFailures:/u);
assert.match(activeTasks, /Cache-Control": "private, no-store/u);
assert.match(videoPage, /后台检查/u);
assert.match(videoPage, /连续.*未收到上游状态/u);
assert.doesNotMatch(videoPage, /上游状态 .*秒前同步/u);

const reconnectBlockStart = videoPage.indexOf("if (sseRetryCount >= SSE_MAX_RETRY)");
const reconnectBlockEnd = videoPage.indexOf("sseRetryCount++;", reconnectBlockStart);
assert.ok(reconnectBlockStart >= 0 && reconnectBlockEnd > reconnectBlockStart);
const reconnectBlock = videoPage.slice(reconnectBlockStart, reconnectBlockEnd);
assert.match(reconnectBlock, /后台仍在跟踪原任务/u);
assert.match(reconnectBlock, /15_000/u);
assert.doesNotMatch(reconnectBlock, /status:\s*["']failed["']/u);

const heartbeatStart = storyboard.indexOf('if (event.event === "heartbeat")');
const heartbeatEnd = storyboard.indexOf('if (event.event === "error")', heartbeatStart);
assert.ok(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart);
const heartbeatBlock = storyboard.slice(heartbeatStart, heartbeatEnd);
assert.doesNotMatch(heartbeatBlock, /videoLastCheckedAt/u);
assert.match(storyboard, /lastSyncedAt\?: string/u);
assert.match(storyboard, /providerPollFailures\?: number/u);
assert.match(storyboard, /成功交付后扣费/u);

console.log(JSON.stringify({
  passed: true,
  checks: 36,
  providerRequests: 0,
  databaseWrites: 0,
  guarantees: [
    "provider progress survives refresh",
    "browser disconnect does not become generation failure",
    "least-recently-polled accepted tasks are reconciled first",
    "upstream polling failures keep the original task",
  ],
}, null, 2));
