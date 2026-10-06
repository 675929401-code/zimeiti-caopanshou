import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const origin = "https://youcai.art";
const outputDir = path.resolve(".codex-artifacts", "20260824-official-agent-reverse");

function containsAll(source: string, needles: string[]) {
  return needles.every((needle) => source.includes(needle));
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  try {
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const publicHomeText = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
    assert.match(publicHomeText, /创作 Agent/u);
    assert.match(publicHomeText, /直接生成图片、音乐、音频或视频/u);
    await page.screenshot({ path: path.join(outputDir, "official-home-public.png"), fullPage: false });

    await page.goto(`${origin}/tools/text/text-chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const publicAgentUrl = page.url();
    const publicAgentText = (await page.locator("body").innerText()).replace(/\s+/gu, " ");
    await page.screenshot({ path: path.join(outputDir, "official-agent-public-state.png"), fullPage: false });

    async function inspectClick(label: string, locator: ReturnType<typeof page.locator>) {
      await locator.click();
      await page.waitForTimeout(350);
      const overlays = await page
        .locator('[role="dialog"]:visible, [role="listbox"]:visible, [data-radix-popper-content-wrapper]:visible')
        .allInnerTexts();
      await page.screenshot({ path: path.join(outputDir, `official-${label}.png`), fullPage: false });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      return overlays.map((text) => text.replace(/\s+/gu, " ").trim()).filter(Boolean);
    }

    const interactionStates = {
      commands: await inspectClick("commands", page.getByLabel("打开命令与创作技能")),
      shortcuts: await inspectClick("shortcuts", page.getByTitle("快捷提示词")),
      imageReference: await inspectClick("image-reference", page.getByLabel("引用个人图片")),
      videoReference: await inspectClick("video-reference", page.getByLabel("引用个人视频")),
      audioReference: await inspectClick("audio-reference", page.getByLabel("引用个人音频")),
      wechat: await inspectClick("wechat", page.getByLabel(/连接微信创作|管理微信创作连接/u)),
      paidAuthorization: await inspectClick(
        "paid-authorization",
        page.getByLabel(/开启当前会话的积分消费授权|关闭当前会话的积分消费授权/u),
      ),
      memory: await inspectClick("memory", page.getByRole("button", { name: "记忆", exact: true })),
    };

    const html = await (await context.request.get(`${origin}/tools/text/text-chat`)).text();
    const chunkMatch = html.match(/\/_next\/static\/chunks\/app\/tools\/text\/text-chat\/page-[^"']+\.js/u);
    assert.ok(chunkMatch, "未找到对标 Agent 页面脚本");
    const chunkUrl = `${origin}${chunkMatch[0]}`;
    const chunk = await (await context.request.get(chunkUrl)).text();

    const contract = {
      placeholderCallsSkillsDirectly: chunk.includes("Agent 可以调用技能、联网搜索，并直接生成图片、音频、音乐或视频"),
      slashOpensCommandAndSkills: containsAll(chunk, ["命令与创作技能", "打开命令与创作技能", 'N("/")']),
      hashOpensQuickPrompts: containsAll(chunk, ["快捷提示词", 'w.endsWith("#")']),
      mediaButtonsReferenceAssets: containsAll(chunk, ["引用个人图片", "引用个人视频", "引用个人音频"]),
      mediaButtonsDoNotDeclareWorkbenchNavigation: !containsAll(chunk, ["引用个人图片", "/tools/image"]),
      perConversationPaidAuthorization: containsAll(chunk, ["paidToolAuthorizationEnabled", "授权仅对当前会话有效", "同意并开启"]),
      memoryHasBackendCrud: containsAll(chunk, ["/api/text-chat/memories", "编辑记忆", "删除记忆", "全局偏好", "项目记忆"]),
      wechatHasBindingBackend: containsAll(chunk, ["/api/text-chat/weixin-binding", "微信创作已连接", "连接微信创作"]),
      conversationStreamEndpoint: chunk.includes('/api/text-chat/conversations/".concat(o,"/messages'),
      directToolKinds: containsAll(chunk, ["generate_image", "edit_image", "generate_video", "generate_music", "generate_audio"]),
      streamShowsToolProgress: containsAll(chunk, ["skill-token", "video_task", "音乐创作失败", "视频任务提交失败"]),
      noHiddenSystemPromptInClientBundle: !chunk.includes("system_prompt") && !chunk.includes("systemPrompt"),
    };
    for (const [name, passed] of Object.entries(contract)) {
      assert.equal(passed, true, `${name} 未满足`);
    }

    const report = {
      ok: true,
      source: "official public page and its public client bundle",
      publicHomeVerified: true,
      publicAgentUrl,
      publicAgentRequiresAuthenticatedState: !/创作 Agent/u.test(publicAgentText),
      hiddenPromptAvailable: false,
      chunkUrl,
      contract,
      interactionStates,
      limits: [
        "未接管用户已有登录会话，因此没有触发登录态按钮或任何付费生成",
        "前端公开资源可证明按钮事件、接口名和状态机，但不能证明服务端隐藏提示词原文",
      ],
    };
    fs.writeFileSync(path.join(outputDir, "official-agent-reverse-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();
