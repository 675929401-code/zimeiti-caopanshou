import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const origin = "http://127.0.0.1:5000";
const runtime = JSON.parse((await fs.readFile("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8")).replace(/^\uFEFF/u, ""));
const headers = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
const actor = (await (await fetch(`${runtime.supabaseUrl}/rest/v1/users?select=id,username,display_name,role&username=eq.18685178259&limit=1`, { headers })).json())[0];
assert.ok(actor, "Local acceptance actor is required");
const sessionId = `storyboard-preflight-${randomUUID()}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await fetch(`${runtime.supabaseUrl}/rest/v1/user_auth_sessions`, {
  method: "POST", headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ user_id: actor.id, session_id: sessionId, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), revoked_at: null, revoke_reason: null }),
});
const results = [];
try {
  const token = await new SignJWT({ userId: actor.id, username: actor.username, role: actor.role, displayName: actor.display_name || actor.username, sessionId })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("30m").sign(new TextEncoder().encode(runtime.jwtSecret));
  const catalog = await (await fetch(`${origin}/api/video/models?surface=storyboard-workbench`, { signal: AbortSignal.timeout(30_000) })).json();
  const startIndex = Math.max(0, Number(process.env.PREFLIGHT_START_INDEX || 0));
  const models = (catalog.models || []).slice(startIndex);
  for (const [index, model] of models.entries()) {
    const absoluteIndex = startIndex + index;
    const capabilities = model.capabilities || {};
    const requestId = `storyboard-preflight-${Date.now()}-${index}`;
    const minimumImages = Math.max(0, Number(capabilities.minReferenceImages || 0));
    const includeFirstFrame = Boolean(capabilities.requiresImage || capabilities.requiresFirstFrame || capabilities.showFirstFrame || minimumImages > 0);
    const aspectRatios = Array.isArray(capabilities.aspectRatios) ? capabilities.aspectRatios : [];
    const body = {
      model_id: model.id, prompt: "A ceramic cup on a wooden table, gentle camera movement, no text.",
      duration: 999,
      aspect_ratio: includeFirstFrame && capabilities.firstFrameRatioPolicy === "adaptive" ? "adaptive" : aspectRatios[0] || "16:9",
      resolution_tier: capabilities.defaultResolution || capabilities.resolutionOptions?.[0] || "720p",
      surface: "storyboard-workbench", client_request_id: requestId, task_label: "零费用交付预检",
    };
    if (capabilities.requiresSourceVideo) body.source_video_url = "https://fixture.invalid/source.mp4";
    if (includeFirstFrame) body.image_url = "https://fixture.invalid/first.png";
    if (capabilities.requiresLastFrame) body.last_frame_url = "https://fixture.invalid/last.png";
    if (minimumImages > 1) body.reference_image_urls = Array.from({ length: minimumImages }, (_, i) => `https://fixture.invalid/ref-${i}.png`);
    if (Number(capabilities.minReferenceAudios || 0) > 0) {
      body.audio_url = "https://fixture.invalid/voice.mp3";
      body.reference_audio_urls = ["https://fixture.invalid/voice.mp3"];
    }
    if (capabilities.billingUnit === "token") body.tokenBilling = { hasReferenceVideo: false, maxChargeYuan: 9999, priceVersion: model.tokenPricing.priceVersion };
    let record;
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = Date.now();
      const response = await fetch(`${origin}/api/video/generate`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": requestId },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      record = {
        name: model.displayName, http: response.status, code: payload.error_code || "", parameter: payload.parameter || "",
        taskSubmitted: payload.task_submitted, elapsedMs: Date.now() - startedAt, message: String(payload.error || payload.message || "").slice(0, 160),
      };
      record.durationRejected = /时长|duration/iu.test(record.message) || record.parameter === "duration";
      if (response.status !== 429) break;
      await sleep(61_000);
    }
    results.push(record);
    console.log(JSON.stringify({ phase: "model-preflight", index: absoluteIndex + 1, total: catalog.models.length, ...record }));
    assert.equal(record.durationRejected, true, `${record.name}: ${record.http} ${record.code} ${record.message}`);
    assert.equal(record.taskSubmitted, false, `${record.name}: unexpected provider submission`);
    if (index < models.length - 1) await sleep(8_100);
  }
  console.log(JSON.stringify({ passed: true, total: results.length, providerSubmissions: 0, chargedRequests: 0, results }, null, 2));
} finally {
  await fetch(`${runtime.supabaseUrl}/rest/v1/user_auth_sessions?session_id=eq.${sessionId}`, { method: "DELETE", headers: { ...headers, Prefer: "return=minimal" } });
  console.log("TEMP_SESSION_CLEANED");
}
