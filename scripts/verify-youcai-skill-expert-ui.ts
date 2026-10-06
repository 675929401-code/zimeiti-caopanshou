import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const origin = "http://127.0.0.1:5000";
const outputDir = path.resolve(".codex-artifacts", "20260824-youcai-skill-expert-acceptance");
const EXPECTED_TOTAL_SKILLS = 36;
const EXPECTED_OFFICIAL_SKILLS = 21;
const EXPECTED_COMMUNITY_SKILLS = 15;

async function closeWithTimeout(
  closeable: { close(): Promise<void> },
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[youcai-skill-expert-ui] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[youcai-skill-expert-ui] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function captureRuntimeErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];

  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
    const page = await desktop.newPage();
    await captureRuntimeErrors(page, errors);

    await page.goto(`${origin}/youcai/skills`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByTestId("youcai-skill-expert-page").waitFor();
    assert.equal(await page.getByTestId("youcai-skill-card").count(), EXPECTED_TOTAL_SKILLS);
    assert.equal(await page.getByRole("link", { name: "Skill 专家" }).getAttribute("data-active"), "true");
    assert.match(await page.locator("body").innerText(), new RegExp(`平台目录 ${EXPECTED_OFFICIAL_SKILLS}`, "u"));
    assert.match(await page.locator("body").innerText(), new RegExp(`公开分享 ${EXPECTED_COMMUNITY_SKILLS}`, "u"));
    await page.screenshot({ path: path.join(outputDir, "desktop-skill-store.png"), fullPage: true });

    await page.getByRole("button", { name: new RegExp(`公开分享 ${EXPECTED_COMMUNITY_SKILLS}`, "u") }).click();
    assert.equal(await page.getByTestId("youcai-skill-card").count(), EXPECTED_COMMUNITY_SKILLS);
    await page.screenshot({ path: path.join(outputDir, "desktop-community-filter.png"), fullPage: false });

    const voiceoverCard = page.getByTestId("youcai-skill-card").filter({ hasText: "口播与配音导演" });
    await voiceoverCard.getByRole("button", { name: /查看 口播与配音导演 详情/u }).click();
    await page.getByRole("dialog", { name: "口播与配音导演" }).waitFor();
    assert.match(await page.getByRole("dialog").innerText(), /执行边界/u);
    assert.match(await page.getByRole("dialog").innerText(), /安装状态：无发布包/u);
    assert.match(await page.getByRole("dialog").innerText(), /内置 36 项运行目录/u);
    await page.screenshot({ path: path.join(outputDir, "desktop-skill-detail.png"), fullPage: false });
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "在 Agent 中创作" }).count(), 1);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "安装 Skill" }).count(), 0);
    await page.getByRole("button", { name: "关闭 Skill 详情" }).click();

    await page.getByRole("button", { name: new RegExp(`平台目录 ${EXPECTED_OFFICIAL_SKILLS}`, "u") }).click();
    const adCard = page.getByTestId("youcai-skill-card").filter({ hasText: "商业广告脚本" });
    await adCard.getByRole("button", { name: "去创作" }).click();
    await page.waitForURL(/\/youcai\/tools\/text\/text-chat\?command=/u);
    const composer = page.getByRole("textbox", { name: "创作需求", exact: true });
    await composer.waitFor();
    assert.equal(await composer.inputValue(), "/ad-script-master ");
    assert.match(await page.locator("body").innerText(), /已载入 \/ad-script-master/u);
    await page.screenshot({ path: path.join(outputDir, "desktop-agent-command-prefill.png"), fullPage: false });

    await composer.fill("/");
    const commandMenu = page.getByRole("listbox", { name: "命令与创作技能" });
    await commandMenu.waitFor();
    assert.ok(await commandMenu.getByRole("option").count() >= 8);
    await page.screenshot({ path: path.join(outputDir, "desktop-agent-command-menu.png"), fullPage: false });

    await page.goto(`${origin}/youcai/assets`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(await page.getByRole("link", { name: "Skill 专家" }).count(), 1);
    await page.screenshot({ path: path.join(outputDir, "desktop-regression-assets.png"), fullPage: false });

    await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /Skill 商店/u);
    await page.screenshot({ path: path.join(outputDir, "desktop-regression-storyboard.png"), fullPage: false });
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const mobilePage = await mobile.newPage();
    await captureRuntimeErrors(mobilePage, errors);
    await mobilePage.goto(`${origin}/youcai/skills`, { waitUntil: "networkidle", timeout: 60_000 });
    await mobilePage.getByTestId("youcai-skill-expert-page").waitFor();
    assert.equal(await mobilePage.getByTestId("youcai-skill-card").count(), EXPECTED_TOTAL_SKILLS);
    await mobilePage.screenshot({ path: path.join(outputDir, "mobile-skill-store.png"), fullPage: false });
    await mobilePage.getByRole("button", { name: "打开导航" }).click();
    const drawer = mobilePage.getByTestId("film-studio-mobile-drawer");
    await drawer.getByRole("link", { name: "Skill 专家" }).waitFor();
    assert.equal(await drawer.getByRole("link", { name: "Skill 专家" }).getAttribute("data-active"), "true");
    await mobilePage.screenshot({ path: path.join(outputDir, "mobile-skill-navigation.png"), fullPage: false });
    await mobile.close();

    const actionableErrors = errors.filter((message) => (
      !/favicon|ResizeObserver loop|Failed to load resource.*401|Failed to load resource.*404/u.test(message)
    ));
    assert.deepEqual(actionableErrors, [], `浏览器出现错误：\n${actionableErrors.join("\n")}`);

    const report = {
      ok: true,
      paidGenerationTriggered: false,
      desktop: {
        viewport: "1440x960",
        cards: EXPECTED_TOTAL_SKILLS,
        communityFilterCards: EXPECTED_COMMUNITY_SKILLS,
        detailDialog: true,
        builtinSkillInstallBlocked: true,
        builtinSkillAgentAction: true,
        commandPrefill: "/ad-script-master ",
        slashCommandMenu: true,
      },
      mobile: {
        viewport: "390x844",
        cards: EXPECTED_TOTAL_SKILLS,
        navigationDrawer: true,
        activeSkillNavigation: true,
      },
      regressions: ["/youcai/assets", "/storyboard-workbench"],
      screenshots: fs.readdirSync(outputDir).sort(),
      runtimeErrors: actionableErrors,
    };
    fs.writeFileSync(path.join(outputDir, "acceptance-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closeWithTimeout(browser, "browser.close");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
