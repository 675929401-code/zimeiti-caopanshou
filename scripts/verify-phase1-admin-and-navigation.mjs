import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const base = "http://127.0.0.1:5000";
const out = path.resolve(".codex-evidence/phase1-repair-20260902/admin-navigation");
const user = { id: "phase1-fixture-admin", username: "fixture-admin", role: "admin", status: "active", credits: 100, cashBalance: 0 };
const plugins = [
  { id: "phase1-coze", name: "三合一文案提取工作流", role: "coze_multifunction_extract", type: "coze", is_active: true, price_per_use: 0.02, cost_price: 0.01, price_unit: "条", config: {} },
  { id: "phase1-video", name: "PPT6视频解析", role: "extract_video", type: "third_party", is_active: true, price_per_use: 0, cost_price: 0, price_unit: "次", config: {} },
];

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const writes = [];
  const errors = [];
  const pages = [];
  let includeTextPlugin = false;
  try {
    await context.addInitScript((fixtureUser) => {
      sessionStorage.setItem("entered_app", "1");
      sessionStorage.setItem("admin_activeTab", JSON.stringify("models"));
      localStorage.setItem("admin_activeTab", JSON.stringify("models"));
      localStorage.setItem("auth_token", "phase1-fixture-only");
      localStorage.setItem("auth_user", JSON.stringify(fixtureUser));
    }, user);
    await context.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== base) return route.abort("blockedbyclient");
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (req.method() !== "GET") {
        writes.push(`${req.method()} ${url.pathname}`);
        return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"fixture blocks writes"}' });
      }
      let body = {};
      if (url.pathname === "/api/auth/me") body = { user };
      else if (url.pathname === "/api/admin/plugins") {
        const roles = (url.searchParams.get("role") || "").split(",");
        body = { plugins: plugins.filter((plugin) => roles.includes(plugin.role) && (includeTextPlugin || plugin.role === "extract_video")), systemRoles: {} };
      }
      else if (url.pathname === "/api/admin/models") body = { models: [] };
      else if (url.pathname === "/api/settings/admin") body = { settings: { extract_price_per_use: 0 } };
      else if (url.pathname === "/api/credits") body = { credits: 100, cashBalance: 0 };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/admin`, { waitUntil: "networkidle", timeout: 45_000 });
    await page.screenshot({ path: path.join(out, "admin-entry.png"), fullPage: true });
    await writeFile(path.join(out, "admin-entry.txt"), (await page.locator("body").innerText()).slice(0, 8000));
    await page.getByRole("button", { name: "模型管理", exact: true }).click();
    await page.getByText("统一管理绘图、对话、视频、语音四类模型与文案提取", { exact: true }).waitFor();
    await page.getByRole("button", { name: /文案提取/ }).click();
    await page.getByRole("spinbutton").filter({ visible: true }).first().waitFor();
    const priceInputs = page.locator('input[type="number"]:visible');
    assert.ok(await priceInputs.count(), "extraction price input must be visible");
    assert.equal(await priceInputs.first().inputValue(), "0", "numeric zero must not fall back to 0.02 in the admin form");
    assert.ok((await page.locator("body").innerText()).includes("PPT6视频解析"));
    includeTextPlugin = true;
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /文案提取/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes("三合一文案提取工作流"));
    await page.screenshot({ path: path.join(out, "admin-extraction.png"), fullPage: true });
    pages.push({ route: "/admin", fixture: true, zeroPricePreserved: true, pluginNamesVisible: true });

    for (const [tab, label] of [["segment", "智能分段"], ["format", "文字排版"]]) {
      await page.goto(`${base}/tools?tab=${tab}`, { waitUntil: "networkidle", timeout: 45_000 });
      await page.locator("textarea:visible").first().waitFor();
      assert.ok((await page.locator("body").innerText()).includes(label));
      assert.equal(await page.locator("textarea:visible").first().isEnabled(), true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
      assert.equal(overflow, false, `${tab} page has horizontal overflow`);
      await page.screenshot({ path: path.join(out, `tools-${tab}.png`), fullPage: true });
      pages.push({ route: `/tools?tab=${tab}`, fixture: true, textareaEnabled: true, horizontalOverflow: false });
    }
    assert.deepEqual(errors, [], "browser page errors");
    const result = { checkedAt: new Date().toISOString(), passed: true, scope: "isolated UI fixture; all API requests intercepted", pages, errors, blockedWrites: writes, realApiCalls: 0, providerCalls: 0 };
    await writeFile(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
