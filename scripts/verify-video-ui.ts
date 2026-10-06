import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const sessionResponse = phone && password
      ? await context.request.post(`${baseUrl}/api/auth/login`, {
          headers: { "User-Agent": "Mozilla/5.0 Video UI verification" },
          data: { phone, password },
        })
      : await context.request.get(`${baseUrl}/api/auth/dev-session`, {
          headers: { "x-local-workbench": "ai-creation-studio-local" },
        });
    const session = await sessionResponse.json() as {
      token?: string;
      user?: Record<string, unknown>;
      error?: string;
    };
    if (!phone && !password && sessionResponse.status() === 404) {
      console.log("Video UI verification skipped: production-mode local server blocks /api/auth/dev-session; set CANVAS_TEST_PHONE/CANVAS_TEST_PASSWORD for authenticated UI checks.");
      return;
    }
    assert.ok(
      sessionResponse.ok() && session.token && session.user,
      session.error || "视频工作台UI测试会话不可用",
    );
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
    await page.goto(`${baseUrl}/video`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(new URL(page.url()).pathname, "/video", "视频工作台登录恢复失败");

    // 显式切到当前健康的范围时长模型，验证任务卡的目标时长契约；
    // 被健康门禁暂停的模型应保持不可点击，不能作为验收依赖。
    const modelTrigger = page.getByRole("combobox").first();
    await modelTrigger.click();
    await page.screenshot({ path: ".codex-screenshots/video-page-channel-health-gate-20260816.png", fullPage: false });
    await page.getByRole("option").filter({ hasText: "Grok Imagine Video 1.5 Fast · 15秒" }).first().click();
    await page.locator('[data-slot="select-content"]').waitFor({ state: "hidden" });

    const durationTrigger = page.getByLabel("任务1目标时长");
    await durationTrigger.click();
    await page.locator('[role="option"]:visible').filter({ hasText: "3.5秒" }).first().click();
    await page.locator('[data-slot="select-content"]').waitFor({ state: "hidden" });
    await page.locator("textarea").first().fill("目标总时长：4秒。0-1秒：起势；1-3秒：完成核心动作；3-4秒：稳定落幅。");
    await page.getByText("提示词写了 4 秒，实际以任务卡的 3.5 秒为准。", { exact: true }).waitFor();
    await page.getByText(/模型先生成 \d+(?:\.\d+)? 秒，完成后自动裁成 3\.5 秒。/).waitFor();
    assert.match(await durationTrigger.textContent() || "", /3\.5/);

    await page.screenshot({ path: ".codex-screenshots/video-page-chain-acceptance-20260816.png", fullPage: true });
    assert.deepEqual(browserErrors, [], `视频制作页出现浏览器错误: ${browserErrors.join(" | ")}`);

    for (const regressionPath of ["/", "/cover"]) {
      browserErrors.length = 0;
      await page.goto(`${baseUrl}${regressionPath}`, { waitUntil: "networkidle", timeout: 60_000 });
      assert.equal(new URL(page.url()).pathname, regressionPath, `${regressionPath} 回归页面导航异常`);
      assert.deepEqual(browserErrors, [], `${regressionPath} 回归页面出现浏览器错误: ${browserErrors.join(" | ")}`);
    }
    console.log("Video UI verification passed.");
  } finally {
    await browser.close();
  }
}

void main();
