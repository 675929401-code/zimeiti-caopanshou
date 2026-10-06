import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const targetPath = "/youcai/tools/text/text-chat";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const writes: Array<{ method: string; url: string }> = [];

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());

    if (method === "GET" && url.pathname === "/api/storage/files") {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ files: [], total: 0, limit: 100, offset: 0 }),
      });
      return;
    }

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
      return;
    }

    writes.push({ method, url: request.url() });
    await route.abort("blockedbyclient");
  });

  try {
    await page.goto(`${baseUrl}${targetPath}`, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, targetPath);

    const composer = page.getByRole("textbox", { name: "创作需求", exact: true });
    await composer.fill("");
    await page.getByLabel("打开命令与创作技能").click();
    const commandMenu = page.getByRole("listbox", { name: "命令与创作技能" });
    await commandMenu.waitFor({ state: "visible" });
    assert.equal(await composer.inputValue(), "/");
    assert.equal(new URL(page.url()).pathname, targetPath);
    await page.keyboard.press("Escape");
    await commandMenu.waitFor({ state: "hidden" });

    const marker = "零付费同页交互验收";
    await composer.fill(marker);

    const cases = [
      {
        trigger: page.getByTitle("快捷提示词"),
        panel: page.getByRole("dialog", { name: "提示词库" }),
      },
      {
        trigger: page.getByLabel("引用个人图片"),
        panel: page.getByRole("dialog", { name: "选择图片" }),
      },
      {
        trigger: page.getByLabel("引用个人视频"),
        panel: page.getByRole("dialog", { name: "选择视频" }),
      },
      {
        trigger: page.getByLabel("引用个人音频"),
        panel: page.getByRole("dialog", { name: "选择音频" }),
      },
    ] as const;

    for (const item of cases) {
      await item.trigger.click();
      await item.panel.waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).pathname, targetPath);
      assert.equal(await composer.inputValue(), marker);
      await page.keyboard.press("Escape");
      await item.panel.waitFor({ state: "hidden" });
    }

    assert.deepEqual(writes, []);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      path: targetPath,
      samePagePanels: ["commands", "prompts", "image", "video", "audio"],
      writes,
    }, null, 2)}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();
