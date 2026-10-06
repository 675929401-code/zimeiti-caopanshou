import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/benchmark-director-v8-live";
const storageStatePath = `${outputDirectory}/storage-state.json`;

type GraphNode = {
  id: string;
  data: {
    kind: string;
    title: string;
    assetRole?: string;
    outputUrl?: string;
    selectedCandidateId?: string;
    status?: string;
    error?: string;
  };
};

async function main() {
  await mkdir(`${outputDirectory}/images`, { recursive: true });
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
  const submittedAt: number[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/bridge/image/generate") submittedAt.push(Date.now());
  });

  try {
    const response = await page.goto(`${baseUrl}/free-canvas?resume=benchmark-v9-roles`, { waitUntil: "networkidle", timeout: 90_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator(".free-pro-panel").waitFor({ state: "visible" });
    const imageStep = page.getByRole("button", { name: /2\s*批量生图/u });
    await imageStep.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await imageStep.isDisabled(), false, "批量生图按钮不可用");
    await imageStep.evaluate((element: HTMLButtonElement) => element.click());

    await page.waitForFunction(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      const images = (graph?.nodes || []).filter((node) => node.data.kind === "image");
      const roles = images.filter((node) => node.data.assetRole === "character-reference");
      return images.length === 13
        && images.every((node) => Boolean(node.data.outputUrl))
        && roles.length === 2
        && roles.every((node) => Boolean(node.data.selectedCandidateId));
    }, undefined, { timeout: 8 * 60_000 });

    const nodes = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      return graph?.nodes || [];
    });
    const roles = nodes.filter((node) => node.data.assetRole === "character-reference");
    await page.screenshot({ path: `${outputDirectory}/05-all-images-and-videos-complete.png`, fullPage: true });
    await context.storageState({ path: storageStatePath });
    assert.equal(roles.length, 2, "角色定妆节点数量错误");
    assert.equal(submittedAt.length, 13, `完整图片队列应提交2张角色图和11张关键帧，当前${submittedAt.length}`);
    const submitIntervals = submittedAt.slice(1).map((timestamp, index) => timestamp - submittedAt[index]);
    assert.ok(submitIntervals.every((interval) => interval >= 4_500), `图片提交间隔不足5秒：${submitIntervals.join(",")}ms`);
    assert.ok(roles.every((node) => node.data.status === "succeeded" && node.data.outputUrl && node.data.selectedCandidateId), "角色定妆图没有全部生成并自动确认");

    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      const imageResponse = await context.request.get(role.data.outputUrl!);
      assert.ok(imageResponse.ok(), `${role.data.title}下载失败：HTTP ${imageResponse.status()}`);
      await writeFile(`${outputDirectory}/images/role-${String(index + 1).padStart(2, "0")}.png`, await imageResponse.body());
    }
    await writeFile(`${outputDirectory}/role-generation-report.json`, `${JSON.stringify({
      imageGenerateRequests: submittedAt.length,
      submitIntervalsMs: submitIntervals,
      roles: roles.map((node) => ({ title: node.data.title, outputUrl: node.data.outputUrl, status: node.data.status })),
    }, null, 2)}\n`, "utf8");
    console.log(`角色图2/2、全部图片13/13已完成；最短提交间隔${Math.min(...submitIntervals)}ms`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
