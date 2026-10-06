import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page, type Locator } from "playwright";

// Read-only browser acceptance through the ordinary login flow. Credentials
// stay in the environment; this verifier never mints a privileged test token.
const base = process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local preview only");
const out = path.resolve(process.env.VERIFY_OUTPUT_DIR || ".codex-evidence/video-model-controls");
type Model = { id: string; displayName: string; publicPrice: number; capabilities: Record<string, unknown> };
const rows: { surface: string; id: string; name: string; checks: string[] }[] = [];
const strings = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
const sorted = (v: string[]) => [...v].sort();
function durations(m: Model) {
  const c = m.capabilities;
  if (c.durationMode === "fixed") return [Number(c.defaultDuration)];
  if (c.durationMode === "discrete") return strings(c.nativeDurations).map(Number);
  const min = Number(c.minDuration), max = Number(c.maxDuration), step = Number(c.durationStep || 1);
  assert.ok(min > 0 && max >= min && step > 0, m.displayName + ": invalid duration range");
  return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => Math.round((min + i * step) * 10) / 10);
}
function price(m: Model, resolution: string) {
  const match = strings(m.capabilities.resolutionPrices).find(v => v.startsWith(resolution + "="));
  return match ? Number(match.slice(match.indexOf("=") + 1)) : m.publicPrice;
}
async function catalog(surface: string): Promise<Model[]> {
  const response = await fetch(base + "/api/video/models?surface=" + surface);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.models) && data.models.length > 0, surface + ": empty catalog");
  const models: Model[] = data.models;
  for (const m of models) {
    assert.match(m.id, /^pm_[A-Za-z0-9_-]{16,120}$/u);
    assert.ok(m.displayName && Number.isFinite(m.publicPrice) && m.publicPrice >= 0);
    assert.equal(m.capabilities.available, true, m.displayName + ": unavailable model leaked");
  }
  assert.equal(new Set(models.map(m => m.id)).size, models.length);
  return models;
}
async function closed(p: Page) { await p.getByRole("option").first().waitFor({ state: "hidden" }); }
async function escape(p: Page, trigger: Locator) {
  const before = p.url();
  await trigger.click();
  await p.getByRole("option").first().waitFor();
  await p.keyboard.press("Escape");
  await closed(p);
  await p.waitForTimeout(150); // Let the former erroneous navigation commit.
  assert.equal(p.url(), before, "Escape must dismiss the selector without leaving the workbench");
}
async function video(p: Page, models: Model[]) {
  await p.goto(base + "/video", { waitUntil: "domcontentloaded" });
  const selector = p.getByRole("combobox", { name: "视频模型", exact: true });
  await selector.waitFor();
  await selector.click();
  await p.getByRole("option").first().waitFor();
  assert.equal(await p.getByRole("option").count(), models.length);
  for (const m of models) assert.equal(await p.getByRole("option").filter({ has: p.getByText(m.displayName, { exact: true }) }).count(), 1);
  await p.keyboard.press("Escape"); await closed(p);
  assert.equal(new URL(p.url()).pathname, "/video");
  for (const m of models) {
    const c = m.capabilities;
    await selector.click();
    await p.getByRole("option").filter({ has: p.getByText(m.displayName, { exact: true }) }).click(); await closed(p);
    assert.equal((await selector.innerText()).trim(), m.displayName);
    const card = p.getByText("任务1", { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');
    assert.equal(await card.getByLabel("任务1源视频链接").count(), c.supportsSourceVideoInput ? 1 : 0);
    if (c.supportsSourceVideoInput) {
      assert.equal(await card.getByText(c.requiresSourceVideo ? /^源视频 \*/u : /^源视频（可选）/u).count(), 1, m.displayName + ": source-video requirement label mismatch");
    }
    assert.equal(await card.getByText(/^参考音频（最多/u).count(), c.supportsAudioInput ? 1 : 0);
    if (!c.supportsImageInput) assert.equal(await card.getByText(/^参考图|^首帧|^尾帧/u).count(), 0, m.displayName + ": image controls leaked");
    if (c.requiresFirstFrame) assert.equal(await card.getByText("首帧 *", { exact: true }).count(), 1, `${m.displayName}: required first-frame control missing; card=${(await card.innerText()).slice(0, 500)}`);
    if (c.requiresLastFrame) assert.equal(await card.getByText("尾帧 *", { exact: true }).count(), 1, `${m.displayName}: required last-frame control missing; card=${(await card.innerText()).slice(0, 500)}`);
    const res = strings(c.resolutionOptions);
    const field = p.locator("label").filter({ hasText: /^视频分辨率$/u }).locator("..");
    if (res.length > 1) {
      const resolution = p.getByRole("combobox", { name: "视频分辨率", exact: true });
      await resolution.click();
      const labels = await p.getByRole("option").allTextContents();
      assert.equal(labels.length, res.length);
      for (const value of res) assert.ok(labels.some(label => label.toLowerCase().startsWith(value.toLowerCase()) && label.includes("¥" + price(m, value).toFixed(2))), m.displayName + ": " + value + " price mismatch");
      await p.getByRole("option").last().click(); await closed(p);
      await escape(p, resolution);
    } else assert.ok((await field.innerText()).includes(res[0] || "模型自动决定"));
    const duration = p.getByRole("combobox", { name: "默认视频时长", exact: true }), expected = durations(m);
    if (c.requiresSourceVideo) {
      assert.equal(await duration.count(), 0);
      assert.ok(await p.getByText("随源视频时长", { exact: true }).count() > 0);
    } else if (expected.length > 1) {
      await duration.click();
      assert.deepEqual((await p.getByRole("option").allTextContents()).map(v => Number.parseFloat(v)), expected);
      await p.getByRole("option").first().click(); await closed(p);
    } else {
      assert.equal(await duration.count(), 0);
      assert.ok(await p.getByText("固定 " + expected[0] + " 秒", { exact: true }).count() > 0);
    }
    await escape(p, selector);
    rows.push({ surface: "video", id: m.id, name: m.displayName, checks: ["selection", "input-mode", "resolution-prices", "duration", "escape"] });
  }
  await p.screenshot({ path: path.join(out, "video-controls.png"), fullPage: false });
  const selected = await selector.innerText();
  await p.reload({ waitUntil: "domcontentloaded" }); await selector.waitFor();
  await p.waitForFunction(name => document.querySelector('[aria-label="视频模型"]')?.textContent?.trim() === name.trim(), selected);
}
async function storyboard(p: Page, models: Model[]) {
  await p.goto(base + "/storyboard-workbench", { waitUntil: "domcontentloaded" });
  await p.locator(".sbw-video-model-list button").first().waitFor();
  // Each storyboard card supplies one image, no separate last-frame or audio.
  const selectable = models.filter(m => {
    const c = m.capabilities;
    return c.supportsImageInput && !c.requiresSourceVideo && !c.requiresLastFrame && Number(c.minReferenceAudios || 0) === 0
      && Number(c.minReferenceImages || 0) <= 1 && c.maxReferenceImages !== 0 && c.workflowInputMode !== "image_audio_lipsync";
  });
  assert.equal(await p.locator(".sbw-video-model-list button").count(), selectable.length);
  for (const m of selectable) {
    const button = p.getByRole("button", { name: "选择视频模型：" + m.displayName, exact: true });
    assert.equal(await button.count(), 1); assert.equal(await button.isEnabled(), true);
    await button.click(); assert.match(await button.getAttribute("class") || "", /is-active/u);
    const field = p.locator(".sbw-toolbar .sbw-control-group.is-video");
    const resolution = p.getByLabel("视频分辨率", { exact: true }), res = strings(m.capabilities.resolutionOptions);
    if (res.length > 1) {
      assert.deepEqual(sorted(await resolution.locator("option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))), sorted(res));
      assert.ok(res.includes(await resolution.inputValue())); await resolution.selectOption(res[res.length - 1]);
    } else assert.ok((await field.innerText()).includes(res[0] || "清晰度自动"));
    const duration = p.getByLabel("视频时长", { exact: true }), expected = durations(m);
    if (expected.length > 1) {
      assert.deepEqual((await duration.locator("option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).map(Number), expected);
      await duration.selectOption(String(expected[0]));
    } else assert.ok((await field.innerText()).includes("固定 " + expected[0] + " 秒"));
    if (res.length > 1) {
      const seconds = expected.length > 1 ? Number(await duration.inputValue()) : expected[0];
      const labels = await resolution.locator("option").allTextContents();
      for (const value of res) {
        const charge = price(m, value) * (m.capabilities.billingUnit === "output_second" ? seconds : 1);
        assert.ok(labels.some(label => label.startsWith(value) && label.includes("¥" + charge.toFixed(2))), m.displayName + ": storyboard quote mismatch");
      }
    }
    rows.push({ surface: "storyboard", id: m.id, name: m.displayName, checks: ["selection", "input-compatibility", "resolution-prices", "duration"] });
  }
  await p.screenshot({ path: path.join(out, "storyboard-controls.png"), fullPage: false });
}
export async function main() {
  const username = process.env.VERIFY_USERNAME, password = process.env.VERIFY_PASSWORD;
  await mkdir(out, { recursive: true });
  const localToken = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim();
  let session: { token: string; user: { id: string; [key: string]: unknown } };
  if (localToken) {
    const identity = await fetch(base + "/api/auth/me", { headers: { Authorization: `Bearer ${localToken}` } });
    assert.equal(identity.status, 200, "Local session verification failed");
    const body = await identity.json();
    assert.ok(body.user?.id);
    session = { token: localToken, user: body.user };
  } else {
    assert.ok(username && password, "Set VERIFY_USERNAME and VERIFY_PASSWORD for the normal login flow");
    const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200, "Local login failed");
    session = await login.json(); assert.ok(session.token && session.user?.id);
  }
  const [vm, sm] = await Promise.all([catalog("video-page"), catalog("storyboard-workbench")]);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const errors: string[] = []; let paidRequests = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ token, user }) => { localStorage.setItem("auth_token", token); localStorage.setItem("auth_user", JSON.stringify(user)); }, { token: session.token, user: session.user });
    const p = await context.newPage(); p.setDefaultTimeout(15_000);
    p.on("pageerror", e => errors.push(e.message));
    p.on("request", r => { if (r.method() === "POST" && /\/api\/(video\/generate|image\/generate)/u.test(r.url())) paidRequests++; });
    await video(p, vm); await storyboard(p, sm);
    assert.equal(paidRequests, 0, "Changing controls must not start generation"); assert.deepEqual(errors, [], "Browser runtime errors");
    await writeFile(path.join(out, "controls.json"), JSON.stringify({ status: "passed", checkedAt: new Date().toISOString(), paidRequests, browserErrors: errors, models: rows }, null, 2));
    console.log(JSON.stringify({ status: "passed", videoModels: vm.length, storyboardModels: rows.filter(r => r.surface === "storyboard").length, paidRequests }));
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e instanceof Error ? e.message : "Verification failed"); process.exitCode = 1; });
}
