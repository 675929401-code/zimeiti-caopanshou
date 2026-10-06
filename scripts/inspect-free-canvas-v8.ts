import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  if (!sessionResponse.ok || !session.token) throw new Error(session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/free-canvas?inspect=v8`, { waitUntil: "networkidle", timeout: 60_000 });
    if (!response?.ok()) throw new Error(`页面返回 ${response?.status()}`);
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator('aside[aria-label="制作面板"]').waitFor();
    await page.getByRole("button", { name: "打开文案输入" }).click();
    const data = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll("button")].map((element, index) => ({
        index,
        text: element.textContent?.replace(/\s+/g, " ").trim(),
        aria: element.getAttribute("aria-label"),
        className: element.className,
      })),
      inputs: [...document.querySelectorAll("input, textarea, select")].map((element, index) => ({
        index,
        tag: element.tagName,
        aria: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
        className: element.className,
        options: element instanceof HTMLSelectElement
          ? [...element.options].map((option) => ({ value: option.value, text: option.textContent }))
          : undefined,
      })),
    }));
    console.log(JSON.stringify(data, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
