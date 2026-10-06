import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const page = read("src/app/video/page.tsx");
const activeRoute = read("src/app/api/video/active-tasks/route.ts");

const recoveryStart = page.indexOf("Recover only server-owned active jobs after refresh");
const recoveryEnd = page.indexOf("/* ── Load history ── */", recoveryStart);
assert(recoveryStart >= 0 && recoveryEnd > recoveryStart, "视频页缺少独立的活动任务恢复流程");
const recoveryBlock = page.slice(recoveryStart, recoveryEnd);

for (const marker of [
  'fetch("/api/video/active-tasks"',
  'Authorization: `Bearer ${auth.token}`',
  'cache: "no-store"',
  "isActiveVideoTaskStatus(status)",
  "row.taskId || row.id",
  "hasEditedInput",
  "不会重新提交或重复计费",
]) {
  assert(recoveryBlock.includes(marker), `活动任务恢复缺少标记: ${marker}`);
}
assert(!recoveryBlock.includes('/api/video/generate'), "刷新恢复不得调用视频生成接口");
assert(!recoveryBlock.includes('method: "POST"'), "刷新恢复必须保持只读 GET");
assert(page.includes("setTaskRecoveryAttempt((current) => current + 1)"), "恢复失败缺少用户主动重试入口");
assert(page.includes('/api/video/stream?${sseParams.toString()}'), "恢复后的任务缺少原任务 SSE 状态跟踪");

for (const marker of [
  'authorizeCurrentApiUser(request)',
  '!taskLabel.startsWith("digital-human:")',
  '!taskLabel.startsWith("分镜工作台")',
  '.filter((t: Record<string, unknown>) => belongsToGeneralVideoPage(t))',
  '.order("created_at", { ascending: false })',
  '.order("id", { ascending: false })',
  'modelId: toPublicModelId("video", String(t.model_id || ""))',
  "taskId: t.id",
  "const safeVideoUrl = await createVideoAccessUrl({",
  '"Cache-Control"',
]) {
  assert(activeRoute.includes(marker), `活动任务接口缺少标记: ${marker}`);
}
assert(!activeRoute.includes("content_url"), "活动任务接口不得向浏览器返回供应商轮询地址");
assert(!activeRoute.includes("task_id_external"), "活动任务接口不得向浏览器返回供应商任务编号");
assert(!activeRoute.includes('String(t.video_url || "")'), "最近完成任务不得返回供应商原始视频地址");

console.log("视频刷新恢复合同通过：账号鉴权、普通视频隔离、公开模型 ID、稳定倒序、只读恢复与原任务续查均已锁定。");
