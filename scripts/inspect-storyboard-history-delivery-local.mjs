import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Run through with-local-admin-session.mjs. Credentials remain in memory.
export async function main(argv = []) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  assert.equal(origin, "http://127.0.0.1:5000");
  assert.ok(token && identity.user?.id, "Authenticated local identity required");
  const headers = { Authorization: `Bearer ${token}` };
  const phase = argv.find(value => value.startsWith("--phase="))?.slice(8) || "diagnosis";
  assert.match(phase, /^[a-z0-9-]+$/u);
  const version = await fetch(`${origin}/api/version`).then(response => response.json());
  const response = await fetch(`${origin}/api/video/history?surface=storyboard-workbench&limit=100`, {
    headers, signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  assert.ok(response.ok && Array.isArray(payload.tasks), "Storyboard history read failed");
  const tasks = payload.tasks;
  const dbOrigin = new URL(process.env.COZE_SUPABASE_URL || "");
  assert.equal(dbOrigin.origin, "http://127.0.0.1:54321");
  const dbQuery = new URL("/rest/v1/video_tasks", dbOrigin);
  dbQuery.searchParams.set("select", "id,status,storage_url,video_url,provider_result_url,source_expired_at,history_hidden_at,completed_at");
  dbQuery.searchParams.set("user_id", `eq.${identity.user.id}`);
  dbQuery.searchParams.set("task_label", "like.分镜工作台*");
  dbQuery.searchParams.set("limit", "100");
  const dbResponse = await fetch(dbQuery, { headers: { apikey: process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.COZE_SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(10_000) });
  const dbRows = await dbResponse.json();
  assert.ok(dbResponse.ok && Array.isArray(dbRows), "Scoped local task metadata read failed");
  const report = {
    checkedAt: new Date().toISOString(), phase, sourceVersion: version.sourceVersion,
    buildId: version.buildId, historyStatus: response.status, retentionDays: payload.retentionDays,
    storedMedia: dbRows.map(row => ({ taskId: row.id, status: row.status,
      hasStorage: Boolean(row.storage_url), hasVideo: Boolean(row.video_url),
      hasProviderResult: Boolean(row.provider_result_url),
      ownedStorage: String(row.storage_url || "").startsWith("object://tencent_cos/"),
      sourceExpiredAt: row.source_expired_at, historyHiddenAt: row.history_hidden_at,
    })),
    tasks: tasks.map(task => ({
      taskId: task.id, status: task.status, cardIndex: task.cardIndex,
      completedAt: task.completedAt, hasPlayback: Boolean(task.videoUrl),
      hasThumbnail: Boolean(task.thumbnailUrl),
      thumbnailKind: String(task.thumbnailUrl || "").includes("/api/video/thumbnail/") ? "video-frame-ticket" : task.thumbnailUrl ? "reference-or-remote" : "missing",
      deliveryState: task.deliveryState || null, retainedUntil: task.retainedUntil || null,
    })), probes: [],
  };
  if (argv.includes("--probe")) {
    for (const task of tasks.filter(item => item.status === "completed" && item.videoUrl).slice(0, 2)) {
      const accessResponse = await fetch(`${origin}/api/video/access-ticket?${new URLSearchParams({ taskId: task.id, scope: "playback" })}`, {
        headers, signal: AbortSignal.timeout(15_000),
      });
      const access = await accessResponse.json();
      const probe = { taskId: task.id, accessStatus: accessResponse.status };
      if (accessResponse.ok && typeof access.url === "string" && access.url.startsWith("/")) {
        const playback = await fetch(new URL(access.url, origin), {
          headers: { Range: "bytes=0-65535" }, signal: AbortSignal.timeout(45_000),
        });
        Object.assign(probe, {
          playbackStatus: playback.status, contentType: playback.headers.get("content-type"),
          contentRange: playback.headers.get("content-range"), contentLength: playback.headers.get("content-length"),
        });
        const chunks = [];
        let bytes = 0;
        const reader = playback.body?.getReader();
        if (reader) {
          try {
            while (bytes < 65536) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const bounded = Buffer.from(chunk.value).subarray(0, 65536 - bytes);
              chunks.push(bounded); bytes += bounded.length;
            }
          } finally { await reader.cancel().catch(() => {}); }
        }
        const body = Buffer.concat(chunks);
        Object.assign(probe, { bytesRead: bytes, prefixSha256: createHash("sha256").update(body).digest("hex"), mp4Header: body.subarray(0, 32).includes(Buffer.from("ftyp")) });
      }
      report.probes.push(probe);
    }
  }
  const output = path.join(process.cwd(), ".codex-evidence", "storyboard-history-20261023", `live-${phase}.json`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
