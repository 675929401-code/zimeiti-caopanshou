import dotenv from "dotenv";
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";

dotenv.config({ path: ".env.local", quiet: true });

const base = "http://127.0.0.1:5000";
const expectedBuildId = process.argv[2] || "";
const localRuntimePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[name]) throw new Error(`missing runtime configuration: ${name}`);
}

const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const usersResult = await db.from("users").select("id,email,role,display_name,status,is_active").eq("is_active", true).limit(50);
if (usersResult.error) throw usersResult.error;
const users = usersResult.data || [];
const primary = users.find((user) => user.role === "admin" && user.status === "active")
  || users.find((user) => user.role === "admin") || users[0];
const secondary = users.find((user) => user.id !== primary?.id && user.status === "active")
  || users.find((user) => user.id !== primary?.id);
if (!primary || !secondary) throw new Error("two active local database users are required for isolation verification");

function jwtCandidates() {
  const candidates = [process.env.JWT_SECRET];
  try {
    const runtime = JSON.parse(fs.readFileSync(localRuntimePath, "utf8"));
    candidates.push(runtime?.jwtSecret, runtime?.process?.env?.JWT_SECRET);
  } catch {
    // The checked-in local secret remains a candidate when runtime metadata is unavailable.
  }
  return [...new Set(candidates.filter((value) => typeof value === "string" && value.length > 0))];
}

async function tokenFor(user) {
  for (const secret of jwtCandidates()) {
    const token = await new SignJWT({
      userId: user.id,
      username: user.email || "",
      role: user.role || "student",
      displayName: user.display_name || "",
    }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("20m")
      .sign(new TextEncoder().encode(secret));
    const response = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response || response.status !== 200) continue;
    const body = await response.json().catch(() => null);
    if (body?.user?.id === user.id && body?.user?.role === user.role) return token;
  }
  throw new Error(`NO_VALID_LOCAL_RUNTIME_SESSION_FOR_${user.role}`);
}

const tokenA = await tokenFor(primary);
const tokenB = await tokenFor(secondary);
async function api(path, token, init = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { status: response.status, body };
}

const report = {
  checkedAt: new Date().toISOString(), expectedBuildId,
  accounts: { primaryRole: primary.role, secondaryRole: secondary.role, distinct: primary.id !== secondary.id },
  api: {}, gallery: {}, favorite: {}, digitalPicker: {}, workspace: {}, consoleErrors: [], pageErrors: [],
};
const list = await api("/api/voice/list?page=1&limit=500", tokenA);
const listedVoices = list.body?.data?.voices || [];
report.api.voiceList = {
  status: list.status, total: list.body?.data?.total, returned: listedVoices.length,
  chineseOnly: listedVoices.every((voice) => String(voice.language || "").toLowerCase().startsWith("zh")
    || String(voice.speakerId || "").toLowerCase().includes("_zh_")),
};
const digitalVoices = await api("/api/digital-human/voices", tokenA);
report.api.digitalVoices = {
  status: digitalVoices.status, count: digitalVoices.body?.voices?.length,
  hasCredits: Number.isFinite(digitalVoices.body?.credits),
};

const favoritesA = await api("/api/voice/favorites", tokenA);
const favoritesB = await api("/api/voice/favorites", tokenB);
const idsA = new Set((favoritesA.body?.favorites || []).map((item) => item.voice_id));
const idsB = new Set((favoritesB.body?.favorites || []).map((item) => item.voice_id));
const candidate = listedVoices.find((voice) => !idsA.has(voice.speakerId) && !idsB.has(voice.speakerId));
if (!candidate) throw new Error("no clean favorite candidate is available");
report.favorite = {
  baselineA: favoritesA.body?.count, baselineB: favoritesB.body?.count,
  candidateName: candidate.name, candidateSpeakerId: candidate.speakerId,
};

let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
    const NativeAudio = window.Audio;
    window.__auditAudios = [];
    window.Audio = function Audio(source) {
      const audio = new NativeAudio(source);
      window.__auditAudios.push(audio);
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
  }, {
    token: tokenA,
    user: { id: primary.id, email: primary.email || "", role: primary.role, displayName: primary.display_name || "" },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
  });

  await page.goto(`${base}/voice-studio/voices`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByRole("heading", { name: "音色库" }).waitFor({ timeout: 30_000 });
  report.gallery.cardCount = await page.locator("[data-voice-id]").count();
  report.gallery.portraitCount = await page.locator('[role="img"][aria-label$="音色示意头像"]').count();
  report.gallery.oldImageCount = await page.locator("[data-voice-id] img").count();
  report.gallery.horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  let search = page.getByPlaceholder("搜索音色名称或 speaker_id...");
  await search.fill(candidate.name);
  await page.waitForTimeout(700);
  const favoriteButton = page.getByRole("button", { name: `收藏 ${candidate.name}` }).first();
  await favoriteButton.waitFor({ timeout: 20_000 });
  const postWait = page.waitForResponse((response) => response.url().includes("/api/voice/favorites")
    && response.request().method() === "POST", { timeout: 20_000 });
  await favoriteButton.click();
  report.favorite.uiAddStatus = (await postWait).status();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "音色库" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /我的收藏/ }).first().click();
  await page.waitForTimeout(1_000);
  report.favorite.persistedAfterReload = await page.locator(`[data-voice-id="${candidate.speakerId}"]`).count() === 1;
  const duringB = await api("/api/voice/favorites", tokenB);
  report.favorite.secondaryDoesNotSee = !(duringB.body?.favorites || []).some((item) => item.voice_id === candidate.speakerId);
  const cancelButton = page.getByRole("button", { name: `取消收藏 ${candidate.name}` }).first();
  const deleteWait = page.waitForResponse((response) => response.url().includes("/api/voice/favorites")
    && response.request().method() === "DELETE", { timeout: 20_000 });
  await cancelButton.click();
  report.favorite.uiDeleteStatus = (await deleteWait).status();

  await page.getByRole("button", { name: "全部" }).first().click();
  search = page.getByPlaceholder("搜索音色名称或 speaker_id...");
  await search.fill("爽快思思");
  await page.waitForTimeout(700);
  const playButton = page.getByRole("button", { name: /^试听 爽快思思 2\.0$/ }).first();
  await playButton.waitFor({ timeout: 20_000 });
  let previewPayload = null;
  const previewWait = page.waitForResponse((response) => response.url().includes("/api/voice/preview")
    && response.request().method() === "POST", { timeout: 30_000 }).catch(() => null);
  await playButton.click();
  const previewResponse = await previewWait;
  if (previewResponse) { try { previewPayload = await previewResponse.json(); } catch {} }
  await page.getByRole("button", { name: /^停止试听 爽快思思 2\.0$/ }).first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const audio = window.__auditAudios?.at(-1);
    return Boolean(audio && audio.readyState >= 2 && audio.error === null);
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(1_200);
  report.gallery.preview = {
    httpStatus: previewResponse?.status() || null, cacheHit: previewPayload?.cacheHit ?? null,
    ready: await page.evaluate(() => {
      const audio = window.__auditAudios.at(-1);
      return { readyState: audio.readyState, currentTime: audio.currentTime, paused: audio.paused,
        error: audio.error?.code || null, srcScheme: audio.currentSrc.split(":")[0] };
    }),
  };
  await page.getByRole("button", { name: /^停止试听 爽快思思 2\.0$/ }).first().click();
  await page.waitForTimeout(250);
  report.gallery.stopped = await page.evaluate(() => window.__auditAudios.at(-1).paused);

  await page.goto(`${base}/digital-human`, { waitUntil: "networkidle", timeout: 60_000 });
  const picker = page.getByRole("button", { name: "选择配音音色" });
  await picker.waitFor({ timeout: 30_000 });
  await picker.click();
  const digitalSearch = page.getByRole("textbox", { name: "搜索配音音色" });
  await digitalSearch.fill("爽快思思");
  await page.waitForTimeout(300);
  report.digitalPicker.searchResultCount = await page.getByRole("option").count();
  report.digitalPicker.portraitCount = await page.locator('#digital-voice-options [role="img"][aria-label$="音色示意头像"]').count();
  report.digitalPicker.favoriteTabVisible = await page.getByRole("button", { name: /收藏音色/ }).isVisible();
  const digitalPlay = page.getByRole("button", { name: /^试听 爽快思思 2\.0$/ }).first();
  await digitalPlay.click();
  await page.getByRole("button", { name: /^停止试听 爽快思思 2\.0$/ }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  report.digitalPicker.playing = await page.evaluate(() => {
    const audio = window.__auditAudios.at(-1);
    return { readyState: audio.readyState, currentTime: audio.currentTime, paused: audio.paused,
      error: audio.error?.code || null, srcScheme: audio.currentSrc.split(":")[0] };
  });
  await page.getByRole("button", { name: /^停止试听 爽快思思 2\.0$/ }).first().click();
  await page.waitForTimeout(200);
  report.digitalPicker.stopped = await page.evaluate(() => window.__auditAudios.at(-1).paused);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/voice-studio/workspace`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.getByRole("heading", { name: "语音合成工作台" }).waitFor({ timeout: 30_000 });
  const workspaceSearch = page.getByRole("textbox", { name: "选择音色搜索" });
  await workspaceSearch.fill("爽快思思");
  await page.waitForTimeout(300);
  const workspacePlay = page.locator('button[title="点击试听"]').first();
  await workspacePlay.click();
  await page.locator('button[title="停止试听"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  report.workspace.playing = await page.evaluate(() => {
    const audio = window.__auditAudios.at(-1);
    return { readyState: audio.readyState, currentTime: audio.currentTime, paused: audio.paused,
      error: audio.error?.code || null, srcScheme: audio.currentSrc.split(":")[0] };
  });
  await page.locator('button[title="停止试听"]').first().click();
  await page.waitForTimeout(200);
  report.workspace.stopped = await page.evaluate(() => window.__auditAudios.at(-1).paused);
  report.workspace.desktopHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "语音合成工作台" }).waitFor({ timeout: 30_000 });
  report.workspace.mobileHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await browser.close();
  browser = null;
} finally {
  if (browser) await browser.close().catch(() => {});
  const cleanup = await api(`/api/voice/favorites?voice_id=${encodeURIComponent(candidate.speakerId)}&engine=${encodeURIComponent(candidate.engine || "volcano")}`,
    tokenA, { method: "DELETE" }).catch(() => null);
  const finalA = await api("/api/voice/favorites", tokenA).catch(() => null);
  report.favorite.cleanupStatus = cleanup?.status || null;
  report.favorite.restored = finalA ? !(finalA.body?.favorites || []).some((item) => item.voice_id === candidate.speakerId) : false;
  console.log(JSON.stringify(report, null, 2));
}
