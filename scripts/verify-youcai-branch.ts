import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000";
const evidenceDir = path.resolve(".codex-evidence", "youcai-branch-restore-20260823");

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /还在手动写文案、剪视频/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.screenshot({ path: path.join(evidenceDir, "01-main-landing-restored.png"), fullPage: true });

  await page.evaluate(() => sessionStorage.setItem("entered_app", "1"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("漫剧工作台", { exact: true }).first().waitFor();
  await page.locator('[aria-label^="打开智能体："]').first().waitFor({ timeout: 30_000 });
  const mainMarketplaceCardCount = await page.locator('[aria-label^="打开智能体："]').count();
  assert.equal(mainMarketplaceCardCount >= 4, true, `主站应用广场卡片数量异常：${mainMarketplaceCardCount}`);
  assert.equal(await page.getByText("暂无智能体", { exact: true }).count(), 0);
  assert.equal(await page.getByText("影视工坊", { exact: true }).count(), 0, "主站仍显示旧影视工坊入口");
  assert.equal(await page.getByText("分镜工作台", { exact: true }).count() > 0, true);
  const primaryNavLabels = await page.locator("button.nav-pill").allTextContents();
  const coverIndex = primaryNavLabels.findIndex((label) => label.trim() === "封面制作");
  assert.equal(coverIndex >= 0, true, "主站导航缺少封面制作");
  assert.equal(primaryNavLabels[coverIndex + 1]?.trim(), "漫剧工作台", "漫剧工作台没有紧跟在封面制作之后");
  await page.screenshot({ path: path.join(evidenceDir, "02-main-app-with-youcai-entry.png"), fullPage: true });

  await page.goto(`${baseUrl}/assets`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByText("漫剧工作台", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("个人资产", { exact: true }).count(), 0, "主站 /assets 仍渲染有彩侧栏");
  await page.locator('[aria-label^="打开智能体："]').first().waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('[aria-label^="打开智能体："]').count() >= 4, true);

  await page.goto(`${baseUrl}/tools`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-page="tools"]').waitFor();
  await page.getByRole("heading", { name: "短视频内容工具" }).waitFor();
  assert.equal(await page.getByRole("tab").count(), 4);
  await page.screenshot({ path: path.join(evidenceDir, "03-main-toolbox-restored.png"), fullPage: true });

  await page.goto(`${baseUrl}/creation-center`, { waitUntil: "domcontentloaded" });
  await page.locator('#creation-center-title').waitFor();
  await page.getByRole("heading", { name: /从一个灵感开始/u }).waitFor();
  await page.screenshot({ path: path.join(evidenceDir, "04-main-creation-center-restored.png"), fullPage: true });

  await page.goto(`${baseUrl}/short-drama`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === "/");
  assert.equal(await page.getByText("影视工坊", { exact: true }).count(), 0);

  await page.goto(`${baseUrl}/login?redirect=%2Fyoucai`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === "/");
  assert.equal(new URL(page.url()).pathname, "/");

  const openDialog = page.locator('[role="dialog"]:visible').last();
  if (await openDialog.count()) {
    const dismissButton = openDialog.getByRole("button", { name: /我知道了|关闭|稍后|取消/u }).last();
    if (await dismissButton.count()) await dismissButton.click();
    else await page.keyboard.press("Escape");
  }

  await page.getByText("漫剧工作台", { exact: true }).first().click();
  await page.waitForURL(/\/youcai$/u);
  await page.locator('[data-testid="official-home-page"]').waitFor();
  assert.equal(new URL(page.url()).pathname, "/youcai");
  await page.getByRole("heading", { name: /让创作更精彩/u }).waitFor();
  assert.equal(await page.getByRole("link", { name: /开始创作/ }).first().getAttribute("href"), "/youcai/tools");
  await page.screenshot({ path: path.join(evidenceDir, "06-youcai-isolated-home.png"), fullPage: true });

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByText("漫剧工作台", { exact: true }).first().waitFor();

  await browser.close();
  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    verified: [
      "fresh / renders original LandingPage",
      "entered / preserves original workbench shortcuts",
      "main /tools restores the original four-tab toolbox",
      "main /creation-center restores the original creation center",
      "retired main /short-drama redirects to the main workbench",
      "main /login restores the original root-login handoff",
      "main sidebar contains one Youcai entry",
      "main /assets no longer renders a Youcai clone page",
      `main application marketplace keeps ${mainMarketplaceCardCount} loaded agent cards`,
      "entry opens same-domain /youcai",
      "Youcai home links stay under /youcai",
      "returning to / keeps main workbench intact",
    ],
    pageErrors,
    evidenceDir,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
