import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const outputDir = path.resolve(".codex-artifacts", "20260824-official-agent-authenticated");
const cdpEndpoint = "http://127.0.0.1:9333";

function normalize(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function sanitizedEndpoint(value: string) {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

async function visibleOverlayTexts(page: Page) {
  return page
    .locator('[role="dialog"]:visible, [role="listbox"]:visible, [data-radix-popper-content-wrapper]:visible')
    .allInnerTexts();
}

async function dismissOverlays(page: Page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  assert.ok(context, "未连接到受控官网测试窗口");
  const page = context.pages().find((candidate) => candidate.url().includes("youcai.art"))
    ?? context.pages()[0];
  assert.ok(page, "受控窗口没有可用页面");

  const network = new Map<string, { method: string; endpoint: string; status?: number }>();
  page.on("response", (response) => {
    if (!response.url().includes("youcai.art/api/")) return;
    const item = {
      method: response.request().method(),
      endpoint: sanitizedEndpoint(response.url()),
      status: response.status(),
    };
    network.set(`${item.method} ${item.endpoint}`, item);
  });

  await page.goto("https://youcai.art/tools/text/text-chat", {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await dismissOverlays(page);
  const bodyText = normalize(await page.locator("body").innerText());
  assert.match(bodyText, /全能 AI 创作 Agent/u, "当前不是登录态 Agent 空页面");

  const selectCatalog = await page.locator("select").evaluateAll((selects: HTMLSelectElement[]) => selects.map((select) => ({
    value: select.value,
    options: [...select.options].map((option) => ({
      value: option.value,
      label: option.text,
      disabled: option.disabled,
    })),
  })));

  async function inspectButton(locator: ReturnType<Page["locator"]>) {
    await locator.click();
    await page.waitForTimeout(250);
    const overlays = (await visibleOverlayTexts(page)).map(normalize).filter(Boolean);
    await dismissOverlays(page);
    return overlays;
  }

  const commands = await inspectButton(page.getByLabel("打开命令与创作技能"));
  const shortcuts = await inspectButton(page.getByTitle("快捷提示词"));
  const imageReference = await inspectButton(page.getByLabel("引用个人图片"));
  const videoReference = await inspectButton(page.getByLabel("引用个人视频"));
  const audioReference = await inspectButton(page.getByLabel("引用个人音频"));
  const wechat = await inspectButton(page.getByLabel(/连接微信创作|管理微信创作连接/u));
  const paidAuthorization = await inspectButton(
    page.getByLabel(/开启当前会话的积分消费授权|关闭当前会话的积分消费授权/u),
  );
  const memory = await inspectButton(page.getByRole("button", { name: "记忆", exact: true }));

  const apiSummary = await page.evaluate(async () => {
    const endpoints = [
      "/api/text-chat/commands",
      "/api/text-chat/conversations",
      "/api/user/shortcuts",
      "/api/user/assets?page=1&limit=24&type=image",
    ];
    const [commandsResponse, conversationsResponse, shortcutsResponse, imageAssetsResponse] = await Promise.all(
      endpoints.map(async (endpoint) => {
        const response = await fetch(endpoint);
        return { status: response.status, body: await response.json().catch(() => null) };
      }),
    );
    const commandsBody = commandsResponse.body as { commands?: unknown[] } | unknown[] | null;
    const commandItems = Array.isArray(commandsBody)
      ? commandsBody
      : Array.isArray(commandsBody?.commands)
        ? commandsBody.commands
        : [];
    const conversationsBody = conversationsResponse.body as { conversations?: unknown[] } | unknown[] | null;
    const conversationItems = Array.isArray(conversationsBody)
      ? conversationsBody
      : Array.isArray(conversationsBody?.conversations)
        ? conversationsBody.conversations
        : [];
    const shortcutBody = shortcutsResponse.body as { shortcuts?: unknown[] } | unknown[] | null;
    const shortcutItems = Array.isArray(shortcutBody)
      ? shortcutBody
      : Array.isArray(shortcutBody?.shortcuts)
        ? shortcutBody.shortcuts
        : [];
    const assetsBody = imageAssetsResponse.body as Record<string, unknown> | null;
    const assetList = Array.isArray(assetsBody)
      ? assetsBody
      : Array.isArray(assetsBody?.assets)
        ? assetsBody.assets
        : Array.isArray(assetsBody?.data)
          ? assetsBody.data
          : [];
    return {
      commandStatus: commandsResponse.status,
      commandCount: commandItems.length,
      commandKinds: [...new Set(commandItems.flatMap((item) => (
        item && typeof item === "object" && "kind" in item
          ? [String((item as { kind: unknown }).kind)]
          : []
      )))],
      conversationStatus: conversationsResponse.status,
      conversationCount: conversationItems.length,
      conversationKeys: conversationItems[0] && typeof conversationItems[0] === "object"
        ? Object.keys(conversationItems[0] as object)
        : [],
      shortcutStatus: shortcutsResponse.status,
      shortcutCount: shortcutItems.length,
      shortcutKeys: shortcutItems[0] && typeof shortcutItems[0] === "object"
        ? Object.keys(shortcutItems[0] as object)
        : [],
      imageAssetStatus: imageAssetsResponse.status,
      imageAssetCount: assetList.length,
      imageAssetKeys: assetList[0] && typeof assetList[0] === "object"
        ? Object.keys(assetList[0] as object)
        : [],
    };
  });

  const redactPersonalOverlay = (items: string[]) => items.map((item) => {
    if (/提示词库/u.test(item)) return item.replace(/提示词库[\s\S]*/u, "提示词库 [个人内容已省略]");
    if (/Agent 记忆/u.test(item)) return item.replace(/Agent 记忆[\s\S]*/u, "Agent 记忆 [个人内容已省略]");
    if (/选择图片|选择视频|选择音频/u.test(item)) {
      return item.replace(/(选择图片|选择视频|选择音频)[\s\S]*/u, "$1 [素材内容已省略]");
    }
    return item;
  });

  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    source: "official authenticated page in a controlled browser session",
    modelCatalog: selectCatalog,
    overlays: {
      commands,
      shortcuts: redactPersonalOverlay(shortcuts),
      imageReference: redactPersonalOverlay(imageReference),
      videoReference: redactPersonalOverlay(videoReference),
      audioReference: redactPersonalOverlay(audioReference),
      wechat,
      paidAuthorization,
      memory: redactPersonalOverlay(memory),
    },
    apiSummary,
    network: [...network.values()],
    safety: {
      messagesSent: 0,
      assetsModified: 0,
      memoriesModified: 0,
      authorizationToggled: false,
      mediaGenerated: false,
      creditsSpentByThisAudit: 0,
      personalContentsRecorded: false,
    },
  };
  fs.writeFileSync(
    path.join(outputDir, "authenticated-agent-ui-report.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

void main();
