import fs from "fs";
import path from "path";
import {
  createVideoAccessTicket,
  createVideoAccessUrl,
  verifyVideoAccessTicket,
} from "../src/lib/video-access-ticket";
import { getSupabaseClient } from "../src/storage/database/supabase-client";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const checks: Array<{ name: string; pass: boolean }> = [];
const check = (name: string, pass: boolean) => checks.push({ name, pass });

async function main() {
  const taskId = "vt_ticket_test_01";
  const { data: users, error: userError } = await getSupabaseClient()
    .from("users")
    .select("id,role,status,is_active")
    .eq("is_active", true)
    .limit(1);
  if (userError || !users?.[0]) throw new Error("ACTIVE_LOCAL_USER_REQUIRED");
  const userId = String(users[0].id);
  const role = users[0].role === "admin" ? "admin" : "student";
  const playbackTicket = await createVideoAccessTicket({
    taskId,
    userId,
    role,
    scope: "playback",
    ttlSeconds: 60,
  });

  check(
    "播放票据仅对正确任务和用途有效",
    (await verifyVideoAccessTicket(playbackTicket, { taskId, scope: "playback" }))?.userId === userId,
  );
  check(
    "播放票据不能用于下载",
    await verifyVideoAccessTicket(playbackTicket, { taskId, scope: "download" }) === null,
  );
  check(
    "播放票据不能跨任务使用",
    await verifyVideoAccessTicket(playbackTicket, { taskId: `${taskId}_other`, scope: "playback" }) === null,
  );
  check(
    "篡改票据会被拒绝",
    await verifyVideoAccessTicket(`${playbackTicket.slice(0, -1)}x`, { taskId, scope: "playback" }) === null,
  );

  const playbackUrl = await createVideoAccessUrl({ taskId, userId, role: "student", scope: "playback" });
  const downloadUrl = await createVideoAccessUrl({
    taskId,
    userId,
    role: "student",
    scope: "download",
    filename: "test.mp4",
  });
  const thumbnailTicket = await createVideoAccessTicket({ taskId, userId, role, scope: "thumbnail" });
  const thumbnailUrl = await createVideoAccessUrl({ taskId, userId, role, scope: "thumbnail" });
  check("播放地址使用短期媒体票据", playbackUrl.startsWith("/api/video/proxy?") && playbackUrl.includes("media_ticket="));
  check("下载地址使用独立用途票据", downloadUrl.startsWith("/api/video/proxy-download?") && downloadUrl.includes("media_ticket="));
  check("缩略图票据仅对缩略图用途有效",
    (await verifyVideoAccessTicket(thumbnailTicket, { taskId, scope: "thumbnail" }))?.userId === userId
      && await verifyVideoAccessTicket(thumbnailTicket, { taskId, scope: "playback" }) === null);
  check("缩略图地址使用短期媒体票据",
    thumbnailUrl.startsWith(`/api/video/thumbnail/${taskId}?`) && thumbnailUrl.includes("media_ticket="));

  const relevantFiles = [
    "src/app/api/video/export/route.ts",
    "src/app/api/video/generate/route.ts",
    "src/app/api/video/history/route.ts",
    "src/app/api/video/thumbnail/[taskId]/route.ts",
    "src/app/api/video/poll/route.ts",
    "src/app/api/video/proxy/route.ts",
    "src/app/api/video/proxy-download/route.ts",
    "src/app/api/video/status/route.ts",
    "src/app/api/video/stream/route.ts",
    "src/app/api/video/storage/[taskId]/route.ts",
    "src/app/video/page.tsx",
    "src/components/manual-canvas.tsx",
    "src/components/storyboard-workbench.tsx",
  ];
  const relevantSource = relevantFiles.map(read).join("\n");
  check("视频链路不再拼接长期登录token", !relevantSource.includes("searchParams.set(\"token\"") && !relevantSource.includes("?token=${"));
  check("历史接口不向用户返回内部存储地址", !read("src/app/api/video/history/route.ts").includes("storageUrl"));
  const downloadProxySource = read("src/app/api/video/proxy-download/route.ts");
  check("下载代理不接受任意URL", !downloadProxySource.includes('searchParams.get("url")'));
  check(
    "下载代理优先按本地任务ID定位",
    downloadProxySource.indexOf('.eq("id", taskId)') >= 0
      && downloadProxySource.indexOf('.eq("id", taskId)') < downloadProxySource.indexOf('.eq("task_id_external", taskId)'),
  );

  const pollSource = read("src/app/api/video/poll/route.ts");
  check("旧轮询委托统一状态接口", pollSource.includes('GET as getVideoStatus') && pollSource.includes("getVideoStatus(new NextRequest"));
  check("旧轮询不再独立扣费", !pollSource.includes("deductCash") && !pollSource.includes("recordRevenue") && !pollSource.includes("persistVideoFromUrl"));

  const failed = checks.filter((item) => !item.pass);
  for (const item of checks) console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

void main();
