import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createToken } from "../src/lib/auth";
import { getSupabaseClient } from "../src/storage/database/supabase-client";
import { runFfmpeg } from "../src/lib/video-postprocess";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const actions = ["trim", "concat", "mute", "extract-audio", "replace-audio", "subtitle-region", "gif"] as const;

async function main() {
  assert.equal(new URL(baseUrl).hostname, "127.0.0.1", "This test is restricted to the local preview");
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const evidenceDir = path.resolve(".tmp-e2e", "local-media-real-e2e", runId);
  await mkdir(evidenceDir, { recursive: true });
  const sourcePath = path.join(evidenceDir, "input.mp4");
  const audioPath = path.join(evidenceDir, "input.wav");
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sourcePath], 30_000);
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2", audioPath], 30_000);
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  const audioBytes = new Uint8Array(await readFile(audioPath));

  // Read the requested, active administrator only. No users, sessions, balances,
  // provider jobs, or production media are created or modified by this test.
  const { data: admin, error } = await getSupabaseClient().from("users")
    .select("id,username,role,is_active")
    .eq("username", process.env.VERIFY_ADMIN_USERNAME || "18685178259")
    .eq("role", "admin").eq("is_active", true).maybeSingle();
  assert.ok(!error && admin?.id, "Requested active administrator is unavailable");
  const token = await createToken({ userId: String(admin.id), username: String(admin.username), role: "admin", displayName: "本地媒体验证", sessionId: `local-media-${randomUUID()}` });
  const endpoint = `${baseUrl}/api/video/local-media/process`;
  const unauthenticated = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(60_000) });
  assert.equal(unauthenticated.status, 401, "Media processing must reject anonymous requests");

  const results = [];
  for (const action of actions) {
    const form = new FormData();
    form.set("action", action);
    form.append("videos", new Blob([sourceBytes], { type: "video/mp4" }), "input.mp4");
    if (action === "concat") form.append("videos", new Blob([sourceBytes], { type: "video/mp4" }), "input-2.mp4");
    if (action === "replace-audio") form.set("audio", new Blob([audioBytes], { type: "audio/wav" }), "replacement.wav");
    form.set("startSeconds", "0.2");
    form.set("endSeconds", "1.2");
    const started = performance.now();
    const extension = action === "gif" ? ".gif" : action === "extract-audio" ? ".mp3" : ".mp4";
    const expectedType = action === "gif" ? "image/gif" : action === "extract-audio" ? "audio/mpeg" : "video/mp4";
    let status = 0;
    let bytes = 0;
    let decodes = false;
    let contentType = "";
    let errorMessage = "";
    let download = false;
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(60_000) });
      status = response.status;
      contentType = response.headers.get("content-type") || "";
      download = (response.headers.get("content-disposition") || "").startsWith("attachment;");
      const buffer = Buffer.from(await response.arrayBuffer());
      bytes = buffer.length;
      if (response.ok && contentType.startsWith(expectedType)) {
        const output = path.join(evidenceDir, `${action}${extension}`);
        await writeFile(output, buffer);
        await runFfmpeg(["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], 30_000);
        decodes = true;
      } else {
        errorMessage = `Unexpected HTTP ${status} or media type ${contentType}`;
      }
    } catch (caught) {
      errorMessage = caught instanceof Error ? caught.name : "UnknownError";
    }
    const result = { action, status, contentType, bytes, decodes, download, durationMs: Math.round(performance.now() - started), ok: status === 200 && decodes && download && bytes > 100, error: errorMessage || undefined };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = { runId, baseUrl, authenticated: true, externalProviderCalls: 0, databaseWrites: 0, anonymousStatus: unauthenticated.status, actions: results, passed: results.filter((r) => r.ok).length, total: actions.length };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${evidenceDir}`);
  assert.equal(report.passed, report.total, "Some local media HTTP operations failed");
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "Local media verification failed"); process.exitCode = 1; });
