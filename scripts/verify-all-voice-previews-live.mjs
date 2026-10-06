import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";

dotenv.config({ path: ".env.local", quiet: true });
const base = "http://127.0.0.1:5000";
for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`missing runtime configuration: ${name}`);
}
const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const users = await db.from("users").select("id,email,role,display_name,status,is_active")
  .eq("is_active", true).eq("role", "admin").limit(10);
if (users.error) throw users.error;
const user = users.data?.find((item) => item.status === "active") || users.data?.[0];
if (!user) throw new Error("active administrator is required");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim() || await new SignJWT({
  userId: user.id,
  username: user.email || "",
  role: user.role,
  displayName: user.display_name || "",
}).setProtectedHeader({ alg: "HS256" }).setIssuedAt()
  .setExpirationTime("30m").sign(new TextEncoder().encode(process.env.JWT_SECRET));
const listResponse = await fetch(`${base}/api/voice/list?page=1&limit=500`);
const listBody = await listResponse.json();
const voices = listBody?.data?.voices || [];
if (listResponse.status !== 200 || voices.length !== listBody?.data?.total) throw new Error("voice catalog is incomplete");

const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
const report = { checkedAt: new Date().toISOString(), total: voices.length, cacheHits: 0, cacheMisses: 0,
  playable: 0, failed: [], statuses: {}, durationKnown: 0 };
try {
  for (const voice of voices) {
    const response = await fetch(`${base}/api/voice/preview`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ speakerId: voice.speakerId }),
    });
    report.statuses[response.status] = (report.statuses[response.status] || 0) + 1;
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body?.success || !body?.data?.audioUrl) {
      report.failed.push({ speakerId: voice.speakerId, stage: "api", status: response.status });
      continue;
    }
    if (body.cacheHit) report.cacheHits += 1; else report.cacheMisses += 1;
    const playback = await page.evaluate(async (audioUrl) => {
      const comma = audioUrl.indexOf(",");
      const metadata = audioUrl.slice(0, comma);
      const base64 = audioUrl.slice(comma + 1);
      const mime = metadata.match(/data:(.*?);/)?.[1] || "audio/mpeg";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const audio = new Audio(objectUrl);
      return new Promise((resolve) => {
        let finished = false;
        const done = (value) => {
          if (finished) return;
          finished = true;
          audio.pause();
          audio.src = "";
          URL.revokeObjectURL(objectUrl);
          resolve(value);
        };
        const timeout = setTimeout(() => done({ ok: false, stage: "timeout", error: audio.error?.code || null }), 8_000);
        audio.onerror = () => { clearTimeout(timeout); done({ ok: false, stage: "decode", error: audio.error?.code || null }); };
        audio.onplaying = () => {
          const startedAt = performance.now();
          const check = () => {
            if (audio.currentTime > 0 || performance.now() - startedAt > 1_000) {
              clearTimeout(timeout);
              done({ ok: audio.currentTime > 0, stage: "play", error: audio.error?.code || null,
                readyState: audio.readyState, duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
            } else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        };
        audio.play().catch((error) => { clearTimeout(timeout); done({ ok: false, stage: error.name || "play", error: audio.error?.code || null }); });
      });
    }, body.data.audioUrl);
    if (playback.ok) {
      report.playable += 1;
      if (playback.duration > 0) report.durationKnown += 1;
    } else report.failed.push({ speakerId: voice.speakerId, ...playback });
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
if (report.failed.length || report.playable !== voices.length) process.exitCode = 1;
