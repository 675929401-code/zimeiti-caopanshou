import assert from "node:assert/strict";
import { chromium, request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const storageStatePath = ".tmp-e2e/benchmark-director-v8-live/storage-state.json";

async function main() {
  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: storageStatePath });
  await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
  const page = await context.newPage();
  const responses: Array<{ status: number; body: string }> = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname !== "/api/bridge/video/generate") return;
    responses.push({ status: response.status(), body: (await response.text().catch(() => "")).slice(0, 1200) });
  });

  try {
    await page.goto(`${baseUrl}/free-canvas?inspect=video-models`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator(".free-pro-panel").waitFor({ state: "visible" });
    const select = page.getByLabel("全局视频生成模型");
    const models = await select.locator("option").evaluateAll((options) => options.map((option) => ({
      id: (option as HTMLOptionElement).value,
      label: (option as HTMLOptionElement).textContent?.trim() || "",
      disabled: (option as HTMLOptionElement).disabled,
    })));
    const selected = await select.inputValue();
    const videoNodes = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: Array<{ data: Record<string, unknown> }> } | null;
      return (graph?.nodes || []).filter((node) => node.data.kind === "video").map((node) => ({
        title: node.data.title,
        modelId: node.data.modelId,
        status: node.data.status,
        taskId: node.data.taskId,
        outputUrl: node.data.outputUrl,
        modelLocked: node.data.modelLocked,
      }));
    });
    console.log(JSON.stringify({ selected, models, videoNodes }, null, 2));

    await page.getByRole("button", { name: /3\s*批量视频/u }).evaluate((element: HTMLButtonElement) => element.click());
    await page.waitForTimeout(35_000);
    const notice = await page.locator(".free-page-notice").innerText().catch(() => "");
    const after = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: Array<{ data: Record<string, unknown> }> } | null;
      return (graph?.nodes || []).filter((node) => node.data.kind === "video").map((node) => ({
        title: node.data.title,
        modelId: node.data.modelId,
        status: node.data.status,
        taskId: node.data.taskId,
        error: node.data.error,
        progressMessage: node.data.progressMessage,
      }));
    });
    console.log(JSON.stringify({ notice, responses, after }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
