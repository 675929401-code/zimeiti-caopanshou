import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.H3_VALIDATION_BASE_URL || "http://127.0.0.1:5000";
const imageLabel = "Qwen Image 2512 HQ · 自租 PRO6000（16:9=3640×2048 实测输出）";
const videoLabel = "MiniMax H3 Turbo · 自租实例（480p 原生 / 1080p增强 / 2K增强）";
const expectHidden = process.argv.includes("--expect-hidden");

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const sessionResponse = await context.request.get(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    const session = await sessionResponse.json() as { token?: string; user?: Record<string, unknown>; error?: string };
    assert.ok(sessionResponse.ok() && session.token && session.user, session.error || "本地 UI 验收会话不可用");
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
    }, { token: session.token, user: session.user });

    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));

    await page.goto(`${baseUrl}/image-workbench`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(new URL(page.url()).pathname, "/image-workbench");
    const imageSelect = page.locator("#image-workbench-model");
    if (expectHidden) {
      assert.equal(await imageSelect.locator("option", { hasText: imageLabel }).count(), 0, "隐藏期 H3 生图模型不应出现在工作台");
      assert.deepEqual(browserErrors, [], `AI 生图工作台出现浏览器错误: ${browserErrors.join(" | ")}`);
      browserErrors.length = 0;
      await page.goto(`${baseUrl}/video`, { waitUntil: "networkidle", timeout: 60_000 });
      assert.equal(new URL(page.url()).pathname, "/video");
      const hiddenModelTrigger = page.getByRole("combobox").first();
      await hiddenModelTrigger.click();
      assert.equal(await page.getByRole("option").filter({ hasText: videoLabel }).count(), 0, "隐藏期 H3 视频模型不应出现在工作台");
      await page.keyboard.press("Escape");
      assert.deepEqual(browserErrors, [], `AI 视频创作台出现浏览器错误: ${browserErrors.join(" | ")}`);
      for (const regressionPath of ["/", "/cover"]) {
        browserErrors.length = 0;
        await page.goto(`${baseUrl}${regressionPath}`, { waitUntil: "networkidle", timeout: 60_000 });
        assert.equal(new URL(page.url()).pathname, regressionPath);
        const unexpected: string[] = (browserErrors as string[]).filter((message: string) => (
          regressionPath !== "/" || !message.startsWith("Failed to fetch agents: TypeError: Failed to fetch")
        ));
        assert.deepEqual(unexpected, [], `${regressionPath} 出现非基线浏览器错误: ${unexpected.join(" | ")}`);
      }
      console.log("AutoDL H3 hidden-state UI isolation verification passed (no generation submitted). ");
      return;
    }
    const imageOption = imageSelect.locator("option", { hasText: imageLabel });
    assert.equal(await imageOption.count(), 1, "H3 生图模型应只出现一次");
    const imageOptionValue = await imageOption.getAttribute("value");
    assert.ok(imageOptionValue, "H3 生图模型缺少公开选择值");
    await imageSelect.selectOption(imageOptionValue);
    assert.match(await imageSelect.locator("option:checked").textContent() || "", /Qwen Image 2512 HQ · 自租 PRO6000/u);
    await page.getByText("当前模型仅用于文生图", { exact: true }).waitFor();
    const ratioSection = page.locator("section").filter({ has: page.getByText("画面比例", { exact: true }) }).first();
    const ratios = (await ratioSection.locator("button").allTextContents()).map((value) => value.trim()).filter(Boolean);
    assert.deepEqual(ratios, ["16:9"], "H3 生图只能公开已真实验收的16:9画幅");
    assert.deepEqual(browserErrors, [], `AI 生图工作台出现浏览器错误: ${browserErrors.join(" | ")}`);

    browserErrors.length = 0;
    await page.goto(`${baseUrl}/video`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(new URL(page.url()).pathname, "/video");
    const modelTrigger = page.getByRole("combobox").first();
    await modelTrigger.click();
    await page.getByRole("option").filter({ hasText: videoLabel }).click();
    await page.locator('[data-slot="select-content"]').waitFor({ state: "hidden" });
    assert.match(await modelTrigger.textContent() || "", /MiniMax H3 Turbo/u);

    const resolutionGroup = page.getByText("视频分辨率", { exact: true }).locator("..");
    const resolutionTrigger = resolutionGroup.getByRole("combobox");
    await resolutionTrigger.click();
    const resolutionOptions = (await page.locator('[role="option"]:visible').allTextContents())
      .map((value) => value.trim())
      .filter(Boolean);
    assert.deepEqual(
      resolutionOptions.map((value) => value.replace(/\s*·.*$/u, "")),
      ["480p 原生", "1080p增强", "2K增强"],
      "H3 视频分辨率标签未严格区分原生/增强",
    );
    await page.keyboard.press("Escape");
    await page.getByText(/不宣称为逐组合直接实测/u).waitFor();
    const durationGroup = page.getByText("默认镜头时长", { exact: true }).locator("..");
    const durationTrigger = durationGroup.locator('button[role="combobox"]');
    await durationTrigger.waitFor({ state: "visible" });
    // The video page refreshes model health in the background, which can
    // replace the trigger between Playwright's stability checks. Invoke the
    // already-visible trigger synchronously so the UI contract, not polling
    // timing, is what this verification measures.
    await durationTrigger.evaluate((element) => (element as HTMLButtonElement).click());
    const durationOptions = (await page.locator('[role="option"]:visible').allTextContents())
      .map((value) => value.trim())
      .filter((value) => /^\d+秒$/u.test(value));
    assert.deepEqual(durationOptions, ["5秒", "10秒", "15秒"], "H3 视频时长选项不是 5/10/15 秒");
    await page.keyboard.press("Escape");
    assert.deepEqual(browserErrors, [], `AI 视频创作台出现浏览器错误: ${browserErrors.join(" | ")}`);

    for (const regressionPath of ["/", "/cover"]) {
      browserErrors.length = 0;
      await page.goto(`${baseUrl}${regressionPath}`, { waitUntil: "networkidle", timeout: 60_000 });
      assert.equal(new URL(page.url()).pathname, regressionPath);
      const unexpected: string[] = (browserErrors as string[]).filter((message: string) => (
        regressionPath !== "/" || !message.startsWith("Failed to fetch agents: TypeError: Failed to fetch")
      ));
      assert.deepEqual(unexpected, [], `${regressionPath} 出现非基线浏览器错误: ${unexpected.join(" | ")}`);
    }

    console.log("AutoDL H3 workbench UI verification passed (no generation submitted). ");
  } finally {
    await browser.close();
  }
}

void main();
