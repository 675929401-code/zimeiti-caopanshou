import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const graphKey = "ai-creation-studio-graph-v1";
const sessionsKey = "ai-creation-studio-free-canvas-sessions-v1";
const activeSessionKey = "ai-creation-studio-free-canvas-active-session-v1";
const runHistoryKey = "ai-creation-studio-free-canvas-run-history-v1";
const diagnosticsKey = "ai-creation-studio-free-canvas-diagnostics-v1";

async function run() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(({ token, graphKey, sessionsKey, activeSessionKey, runHistoryKey, diagnosticsKey }) => {
      if (sessionStorage.getItem("free-canvas-clear-test-ready") !== "1") {
        localStorage.clear();
        sessionStorage.clear();
        sessionStorage.setItem("free-canvas-clear-test-ready", "1");
        const now = new Date().toISOString();
        const canvasId = "canvas:clear-e2e";
        const node = {
          id: "clear-e2e:text",
          type: "workflow",
          position: { x: 120, y: 160 },
          data: {
            kind: "text",
            title: "待清空测试节点",
            prompt: "验证一键清空",
            outputText: "",
            outputUrl: "",
            taskId: "",
            providerContentUrl: "",
            modelId: "",
            aspectRatio: "16:9",
            durationSeconds: 5,
            resolution: "1K",
            imageMode: "text-to-image",
            imageCount: 1,
            videoMode: "first-frame",
            status: "idle",
            history: [],
          },
        };
        const graph = {
          schemaVersion: 1,
          id: "manual-workflow",
          name: "手动节点工作流",
          nodes: [node],
          edges: [],
          updatedAt: now,
        };
        localStorage.setItem(graphKey, JSON.stringify(graph));
        localStorage.setItem(sessionsKey, JSON.stringify([{
          id: canvasId,
          name: "一键清空测试",
          createdAt: now,
          updatedAt: now,
          nodes: [node],
          edges: [],
        }]));
        localStorage.setItem(activeSessionKey, canvasId);
        localStorage.setItem(runHistoryKey, JSON.stringify([{
          id: "run:clear-e2e",
          canvasId,
          canvasName: "一键清空测试",
          status: "draft",
          sourceScript: "验证一键清空",
          styleGuide: "",
          aspectRatio: "16:9",
          promptPreset: "测试",
          imageModelId: "",
          videoModelId: "",
          startedAt: now,
          events: [],
          nodes: [node],
          edges: [],
        }]));
        localStorage.setItem(diagnosticsKey, JSON.stringify([{
          id: "diagnostic:clear-e2e",
          canvasId,
          status: "succeeded",
          startedAt: now,
        }]));
      }
      localStorage.setItem("auth_token", token);
    }, { token: session.token, graphKey, sessionsKey, activeSessionKey, runHistoryKey, diagnosticsKey });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    let acceptClear = false;

    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("dialog", async (dialog) => {
      assert.match(dialog.message(), /清空当前画布/u);
      if (acceptClear) await dialog.accept();
      else await dialog.dismiss();
    });

    await page.goto(`${baseUrl}/free-canvas`, { waitUntil: "domcontentloaded" });
    const clearButton = page.getByRole("button", { name: "一键清空当前画布" });
    await clearButton.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: unknown[] } | null;
      return Boolean(graph?.nodes?.length);
    }, graphKey, { timeout: 30_000 });

    const initialNodeCount = await page.evaluate((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: unknown[] } | null;
      return graph?.nodes?.length || 0;
    }, graphKey);
    assert.ok(initialNodeCount > 0, "测试画布应包含初始节点");

    await clearButton.click();
    await page.waitForTimeout(250);
    const countAfterCancel = await page.evaluate((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: unknown[] } | null;
      return graph?.nodes?.length || 0;
    }, graphKey);
    assert.equal(countAfterCancel, initialNodeCount, "取消确认后不应清空画布");

    acceptClear = true;
    await clearButton.click();
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: unknown[]; edges?: unknown[] } | null;
      return graph?.nodes?.length === 0 && graph?.edges?.length === 0;
    }, graphKey, { timeout: 10_000 });

    const persisted = await page.evaluate(({ sessionsKey, activeSessionKey }) => {
      const activeId = localStorage.getItem(activeSessionKey);
      const sessions = JSON.parse(localStorage.getItem(sessionsKey) || "[]") as Array<{
        id: string;
        nodes?: unknown[];
        edges?: unknown[];
      }>;
      return sessions.find((item) => item.id === activeId) || null;
    }, { sessionsKey, activeSessionKey });
    assert.ok(persisted, "应保留当前画布会话");
    assert.equal(persisted.nodes?.length, 0, "当前画布会话节点应为空");
    assert.equal(persisted.edges?.length, 0, "当前画布会话连线应为空");
    const relatedRecords = await page.evaluate(({ runHistoryKey, diagnosticsKey }) => ({
      runHistory: JSON.parse(localStorage.getItem(runHistoryKey) || "[]") as Array<{ canvasId?: string }>,
      diagnostics: JSON.parse(localStorage.getItem(diagnosticsKey) || "[]") as Array<{ canvasId?: string }>,
    }), { runHistoryKey, diagnosticsKey });
    assert.equal(relatedRecords.runHistory.length, 0, "当前画布运行记录应清空");
    assert.equal(relatedRecords.diagnostics.length, 0, "当前画布诊断日志应清空");
    await page.getByText("当前画布已清空，模型、比例与制作设置已保留").waitFor({ timeout: 10_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction((key) => {
      const graph = JSON.parse(localStorage.getItem(key) || "null") as { nodes?: unknown[]; edges?: unknown[] } | null;
      return graph?.nodes?.length === 0 && graph?.edges?.length === 0;
    }, graphKey, { timeout: 30_000 });
    await page.getByText(/0 节点 · 0 连线/u).waitFor({ timeout: 10_000 });
    await mkdir(".tmp-e2e", { recursive: true });
    await page.screenshot({ path: ".tmp-e2e/free-canvas-cleared.png", fullPage: true });

    assert.deepEqual(pageErrors, [], `页面运行错误：${pageErrors.join(" | ")}`);
    console.log(JSON.stringify({
      passed: true,
      initialNodeCount,
      persistedAfterReload: { nodes: 0, edges: 0 },
      screenshot: ".tmp-e2e/free-canvas-cleared.png",
    }, null, 2));
  } finally {
    await browser.close();
  }
}

void run();
