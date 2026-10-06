import assert from "node:assert/strict";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const targetPath = "/youcai/tools/text/text-chat";
const expectedPlaceholder = [
  "描述你的创作需求，Agent 可以调用 Skill 输出文案、生图提示词、视频提示词或声音方案。",
  "图片可随消息引用；真实媒体生成由对应工作台的已发布模型提交与计费。",
  "Enter 发送 · / 命令与技能 · # 快捷提示词",
].join("\n");

const mockUser = {
  id: "verify-agent-zero-cost-user",
  username: "创作Agent零付费验收用户",
  role: "user",
  themePreference: "coze",
};

const mockModel = {
  id: "mock-agent-image-capable-model",
  displayName: "零付费验收模型",
  variantLabel: "只读夹具",
  capabilities: {
    imageParsing: true,
    fileParsing: true,
  },
};

const files = [
  {
    id: "fixture-image-role",
    file_name: "猫咪角色参考.png",
    file_category: "image",
    content_type: "image/png",
    source: "角色",
    created_at: "2026-08-24T10:03:00.000Z",
  },
  {
    id: "fixture-image-scene",
    file_name: "雨夜咖啡馆场景.png",
    file_category: "image",
    content_type: "image/png",
    source: "场景",
    created_at: "2026-08-24T10:02:00.000Z",
  },
  {
    id: "fixture-video-shot",
    file_name: "夜景分镜.mp4",
    file_category: "video",
    content_type: "video/mp4",
    source: "分镜",
    created_at: "2026-08-24T10:01:00.000Z",
  },
  {
    id: "fixture-audio-music",
    file_name: "治愈配乐.mp3",
    file_category: "audio",
    content_type: "audio/mpeg",
    source: "音乐",
    created_at: "2026-08-24T10:00:00.000Z",
  },
] as const;

async function installReadOnlyRoutes(
  context: BrowserContext,
  writes: Array<{ method: string; url: string }>,
) {
  const transparentPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );

  const fulfillJson = (route: Route, body: unknown) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const url = new URL(request.url());

    if (method === "GET" && url.pathname === "/api/auth/me") {
      await fulfillJson(route, { user: mockUser });
      return;
    }

    if (method === "GET" && url.pathname === "/api/settings") {
      await fulfillJson(route, { settings: { theme: "coze" } });
      return;
    }

    if (method === "GET" && url.pathname === "/api/settings/layout") {
      await fulfillJson(route, { layout: null });
      return;
    }

    if (method === "GET" && url.pathname === "/api/credits") {
      await fulfillJson(route, { credits: 5000.5, cashBalance: 20 });
      return;
    }

    if (method === "GET" && url.pathname === "/api/bots") {
      await fulfillJson(route, { agents: [] });
      return;
    }

    if (method === "GET" && url.pathname === "/api/youcai/chat-models") {
      await fulfillJson(route, {
        models: [mockModel],
        policy: {
          defaultModelId: mockModel.id,
          selection: "zero-cost-fixture",
          fallback: "block-send-no-compatible-model",
        },
      });
      return;
    }

    if (method === "GET" && url.pathname === "/api/conversations/history") {
      await fulfillJson(route, { conversations: [] });
      return;
    }

    if (method === "GET" && url.pathname === "/api/storage/files") {
      const kind = url.searchParams.get("category");
      const offset = Number(url.searchParams.get("offset") || "0");
      const matches = files.filter((file) => file.file_category === kind);
      const pageFiles = kind === "image" ? matches.slice(offset, offset + 1) : offset === 0 ? matches : [];
      const nextOffset = offset + pageFiles.length;
      await fulfillJson(route, {
        files: pageFiles,
        pagination: {
          hasMore: nextOffset < matches.length,
          nextOffset,
        },
      });
      return;
    }

    if (method === "GET" && /\/api\/storage\/files\/fixture-image-[^/]+\/content$/u.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
      return;
    }

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
      return;
    }

    writes.push({ method, url: request.url() });
    await route.abort("blockedbyclient");
  });
}

function assertSameRoute(page: Page) {
  const current = new URL(page.url());
  assert.equal(current.pathname, targetPath);
  assert.equal(current.search, "");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const writes: Array<{ method: string; url: string }> = [];

  await context.addInitScript((user) => {
    localStorage.setItem("auth_token", "zero-cost-readonly-token");
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "chat");
    localStorage.removeItem("active_conversation_id");
    localStorage.removeItem("conv_cache");
    localStorage.setItem("user_theme_preference", "coze");
    localStorage.setItem("xuefeng-user-shortcuts", JSON.stringify([
      {
        id: "fixture-prompt",
        name: "零付费测试提示词",
        content: "请按[1]三段结构输出测试结果",
        category: "文本",
        scenes: ["文本"],
      },
    ]));
  }, mockUser);
  await installReadOnlyRoutes(context, writes);
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}${targetPath}`, { waitUntil: "networkidle" });
    assertSameRoute(page);

    const composer = page.getByRole("textbox", { name: "创作需求", exact: true });
    assert.equal(await composer.getAttribute("placeholder"), expectedPlaceholder);
    assert.equal(await composer.getAttribute("rows"), "1");
    assert.equal(await page.getByRole("heading", { name: "全能 AI 创作 Agent" }).count(), 1);
    assert.equal(await page.locator("button").filter({ hasText: /我想做一部短剧|根据今日抖音热点|Seedream 5\.0 Lite|放下疲惫|轻快治愈|赛博朋克/u }).count(), 6);

    await page.getByLabel("打开命令与创作技能").click();
    const commandMenu = page.getByRole("listbox", { name: "命令与创作技能" });
    await commandMenu.waitFor({ state: "visible" });
    await commandMenu.getByRole("option", { name: /\/help/u }).waitFor({ state: "visible" });
    await commandMenu.getByRole("option", { name: /\/skills/u }).waitFor({ state: "visible" });
    await composer.press("ArrowDown");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), "/skills ");
    assertSameRoute(page);

    await composer.fill("");
    await page.getByTitle("快捷提示词").click();
    const promptLibrary = page.getByRole("dialog", { name: "提示词库" });
    await promptLibrary.waitFor({ state: "visible" });
    await promptLibrary.getByText("零付费测试提示词", { exact: true }).click();
    assert.equal(await composer.inputValue(), "请按三段结构输出测试结果");
    assertSameRoute(page);

    await page.getByTitle("快捷提示词").click();
    await promptLibrary.getByRole("button", { name: "新建提示词", exact: true }).click();
    const createPromptDialog = page.getByRole("dialog", { name: "新建提示词" });
    await createPromptDialog.getByPlaceholder("给提示词起一个名称").fill("新增测试提示词");
    await createPromptDialog.getByPlaceholder("输入要插入创作输入框的提示词").fill("新增内容[1]");
    await createPromptDialog.getByRole("button", { name: "保存", exact: true }).click();
    await createPromptDialog.waitFor({ state: "hidden" });
    await page.getByTitle("快捷提示词").click();
    await promptLibrary.getByRole("button", { name: "编辑提示词 新增测试提示词" }).click();
    const editPromptDialog = page.getByRole("dialog", { name: "编辑提示词" });
    await editPromptDialog.getByPlaceholder("给提示词起一个名称").fill("已编辑测试提示词");
    await editPromptDialog.getByRole("button", { name: "保存", exact: true }).click();
    await editPromptDialog.waitFor({ state: "hidden" });
    await page.getByTitle("快捷提示词").click();
    await promptLibrary.getByText("已编辑测试提示词", { exact: true }).waitFor({ state: "visible" });
    await promptLibrary.getByRole("button", { name: "删除提示词 已编辑测试提示词" }).click();
    assert.equal(await promptLibrary.getByText("已编辑测试提示词", { exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await promptLibrary.waitFor({ state: "hidden" });
    assertSameRoute(page);

    await composer.fill("");
    await page.getByLabel("引用个人图片").click();
    const imageDialog = page.getByRole("dialog", { name: "选择图片" });
    await imageDialog.waitFor({ state: "visible" });
    for (const label of ["全部", "角色", "场景", "道具", "风格", "图片", "收藏"]) {
      assert.equal(await imageDialog.getByRole("button", { name: new RegExp(`${label}$`, "u") }).count(), 1);
    }
    for (const sort of ["newest", "oldest", "name"]) {
      await imageDialog.getByLabel("素材排序").selectOption(sort);
      assert.equal(await imageDialog.getByLabel("素材排序").inputValue(), sort);
    }
    await imageDialog.getByRole("button", { name: /角色$/u }).click();
    await imageDialog.getByTestId("agent-asset-card-fixture-image-role").waitFor({ state: "visible" });
    assert.equal(await imageDialog.getByTestId("agent-asset-card-fixture-image-scene").count(), 0);
    await imageDialog.getByRole("button", { name: "全部", exact: true }).click();
    const imageSearch = imageDialog.getByLabel("搜索文件名或提示词");
    await imageSearch.fill("咖啡馆");
    await imageDialog.getByTestId("agent-asset-card-fixture-image-scene").waitFor({ state: "visible" });
    assert.equal(await imageDialog.getByTestId("agent-asset-card-fixture-image-role").count(), 0);
    await imageSearch.fill("");
    await imageDialog.getByRole("button", { name: "收藏 猫咪角色参考.png" }).click();
    await imageDialog.getByRole("button", { name: /收藏$/u }).click();
    await imageDialog.getByTestId("agent-asset-card-fixture-image-role").waitFor({ state: "visible" });
    assert.equal(await imageDialog.getByTestId("agent-asset-card-fixture-image-scene").count(), 0);
    await imageDialog.getByTestId("agent-asset-card-fixture-image-role").getByRole("button", { name: "引用", exact: true }).click();
    await imageDialog.waitFor({ state: "hidden" });
    await page.getByTestId("agent-attachment-fixture-image-role").waitFor({ state: "visible" });
    assert.match(await composer.inputValue(), /@图片1/u);
    assertSameRoute(page);

    await page.getByLabel("引用个人视频").click();
    const videoDialog = page.getByRole("dialog", { name: "选择视频" });
    await videoDialog.waitFor({ state: "visible" });
    for (const label of ["全部", "分镜", "成片", "视频", "收藏"]) {
      assert.equal(await videoDialog.getByRole("button", { name: new RegExp(`${label}$`, "u") }).count(), 1);
    }
    await videoDialog.getByTestId("agent-asset-card-fixture-video-shot").getByRole("button", { name: "引用", exact: true }).click();
    await videoDialog.waitFor({ state: "hidden" });
    await page.getByTestId("agent-attachment-fixture-video-shot").waitFor({ state: "visible" });
    assert.match(await composer.inputValue(), /@图片1\s+@视频1/u);
    assertSameRoute(page);

    await page.getByLabel("引用个人音频").click();
    const audioDialog = page.getByRole("dialog", { name: "选择音频" });
    await audioDialog.waitFor({ state: "visible" });
    for (const label of ["全部", "音乐", "语音", "音频", "音效", "收藏"]) {
      assert.equal(await audioDialog.getByRole("button", { name: new RegExp(`${label}$`, "u") }).count(), 1);
    }
    await audioDialog.getByTestId("agent-asset-card-fixture-audio-music").getByRole("button", { name: "引用", exact: true }).click();
    await audioDialog.waitFor({ state: "hidden" });
    await page.getByTestId("agent-attachment-fixture-audio-music").waitFor({ state: "visible" });
    assert.match(await composer.inputValue(), /@图片1\s+@视频1\s+@音频1/u);
    assertSameRoute(page);

    await page.getByLabel("发送创作需求").click();
    await page.getByRole("status").getByText(/已阻止发送和扣费/u).waitFor({ state: "visible" });
    assert.match(await composer.inputValue(), /@图片1\s+@视频1\s+@音频1/u);
    await page.getByTestId("agent-attachment-fixture-image-role").waitFor({ state: "visible" });
    await page.getByTestId("agent-attachment-fixture-video-shot").waitFor({ state: "visible" });
    await page.getByTestId("agent-attachment-fixture-audio-music").waitFor({ state: "visible" });
    assertSameRoute(page);

    const accountControls = [
      { label: "微信", dialogId: "agent-control-dialog-wechat" },
      { label: "积分消费授权", dialogId: "agent-control-dialog-authorization" },
      { label: "记忆", dialogId: "agent-control-dialog-memory" },
    ] as const;
    for (const control of accountControls) {
      await page.getByRole("button", { name: control.label, exact: true }).click();
      const dialog = page.getByTestId(control.dialogId);
      await dialog.waitFor({ state: "visible" });
      await dialog.getByTestId("agent-control-fail-closed").waitFor({ state: "visible" });
      assertSameRoute(page);
      await dialog.getByLabel("关闭", { exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
    }

    assert.deepEqual(writes, []);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      route: targetPath,
      exactPlaceholder: true,
      samePagePanels: 5,
      promptCrud: ["create", "edit", "delete"],
      assetControls: ["category", "search", "sort", "favorite"],
      selectedFixtures: ["image", "video", "audio"],
      paginatedImageFixtures: 2,
      unsupportedMediaFailClosed: true,
      preservedOnBlock: true,
      samePageAccountControls: accountControls.map((control) => control.label),
      writes,
    }, null, 2)}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();
