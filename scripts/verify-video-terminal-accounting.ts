import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const generate = read("src/app/api/video/generate/route.ts");
const status = read("src/app/api/video/status/route.ts");
const statusService = read("src/lib/video-task-status.ts");
const stream = read("src/app/api/video/stream/route.ts");
const historyWorker = read("src/lib/video-history-worker.ts");
const accounting = read("src/lib/video-terminal-accounting.ts");
const finalizer = read("src/lib/video-terminal-finalizer.ts");
const terminalMigration = read("supabase/migrations/20260825180000_video_terminal_billing_p0.sql");

const checks: Array<{ name: string; pass: boolean }> = [];
const check = (name: string, pass: boolean) => checks.push({ name, pass });
const count = (source: string, pattern: RegExp) => source.match(pattern)?.length || 0;

check("三类新建提交路径各记录一次 submission", count(generate, /recordVideoSubmission\(channelConfig\.id\)/g) === 3);
check(
  "H3 生命周期提交只在新建队列任务时计数",
  /if \(queued\.created\) \{\s*await recordVideoSubmission\(channelConfig\.id\)/u.test(generate),
);
check(
  "同步成功在终态持久化前独立记录提交",
  /if \(isSyncCompleted\) \{[\s\S]*?recordVideoSubmission\(channelConfig\.id\)[\s\S]*?finalizeVideoGenerationSuccess\(/u.test(generate),
);
check(
  "普通异步提交成功后才计入 submission",
  generate.indexOf("result = await submitVideoTask") < generate.lastIndexOf("await recordVideoSubmission(channelConfig.id)"),
);
check("仅提交阶段失败由终态记录补记 submission", count(generate, /countSubmission:\s*true/g) === 1);
check("生成路由等待统计完成，不遗留 fire-and-forget", !/void\s+recordVideo(?:Submission|TerminalOutcome)/u.test(generate));
check("状态轮询不直接改模型统计列", !/\.update\(\{[\s\S]*?\b(?:total_requests|success_count|fail_count)\b/u.test(status));
check("SSE 轮询不直接改模型统计列", !/\.update\(\{[\s\S]*?\b(?:total_requests|success_count|fail_count)\b/u.test(stream));
check("状态入口委托统一归属状态服务", /readOwnedVideoTaskStatus/u.test(status));
check("状态服务成功统一委托原子终态器", /finalizeVideoStatusSuccess[\s\S]*?finalizeVideoGenerationSuccess\(/u.test(statusService));
check("状态服务两个失败分支都先抢终态锁", count(statusService, /claimTaskFinalization\(supabase,\s*existingTask\.id\)/g) === 2);
check("SSE 只读取账号归属快照", /readOwnedVideoTaskStatus/u.test(stream));
check("SSE 不轮询供应商、不竞争终态锁", !/pollVideoTask|claimTaskFinalization|finalizeVideoGeneration(?:Success|Failure)/u.test(stream));
check("后台 Worker 独占主动状态刷新", /refreshOwnedVideoTaskStatus/u.test(historyWorker));
check(
  "无业务追踪行时成功路径拒绝结算与交付",
  statusService.includes("VIDEO_RESERVATION_REQUIRED") && !stream.includes("finalizeVideoGenerationSuccess"),
);
check(
  "成功终态仅在原子 RPC 首次完成时记账",
  /finalize_video_generation_task_atomic[\s\S]*?const newlyCompleted = finalized\.already_completed !== true[\s\S]*?if \(newlyCompleted\) \{\s*await recordVideoTerminalOutcome/u.test(finalizer),
);
check(
  "数据库终态 RPC 行锁并区分重放",
  /finalize_video_generation_task_atomic[\s\S]*?FOR UPDATE[\s\S]*?'already_completed', true[\s\S]*?'already_completed', false/u.test(terminalMigration),
);
check("共享模块区分提交计数与终态计数", /recordVideoSubmission[\s\S]*total_requests[\s\S]*recordVideoTerminalOutcome/u.test(accounting));
check("成功终态会清除旧错误", /last_error:\s*outcome === "fail"[^\n]*:\s*null/u.test(accounting));
check("通道健康只在终态增加一次样本", /video_channel_health[\s\S]*total_requests:\s*toCount\(health\.total_requests\) \+ 1/u.test(accounting));
check("旧的分散健康更新器已清除", !/updateChannelHealth/u.test(`${generate}\n${status}\n${stream}`));

const failed = checks.filter((item) => !item.pass);
for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
