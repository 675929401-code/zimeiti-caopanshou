import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const projectRoot = process.cwd();
const baseUrl = process.env.H3_VALIDATION_BASE_URL || "http://127.0.0.1:5000";
const imageLabel = "Qwen Image 2512 HQ · 自租 PRO6000（16:9=3640×2048 实测输出）";
const videoLabel = "MiniMax H3 Turbo · 自租实例（480p 原生 / 1080p增强 / 2K增强）";

type PublicModel = {
  id: string;
  displayName: string;
  name?: string;
  capabilities?: Record<string, unknown>;
};

async function source(path: string) {
  return readFile(resolve(projectRoot, path), "utf8");
}

async function verifyStaticContract() {
  const [coverRoute, videoRoute, workbench] = await Promise.all([
    source("src/app/api/cover-models/route.ts"),
    source("src/app/api/video/models/route.ts"),
    source("src/components/storyboard-workbench.tsx"),
  ]);

  assert.match(
    coverRoute,
    /surface === "image-workbench"\s*\|\| surface === "storyboard-workbench"/u,
    "生图 selfhost 没有被精确限制在 image-workbench/storyboard-workbench",
  );
  assert.match(
    coverRoute,
    /if \(\/qwen\[\\s_-\]\*image\/u\.test\(identity\)\) return "qwen";/u,
    "公共生图 DTO 没有精确标注 qwen family",
  );
    assert.match(videoRoute, /modelMatchesSurface/u, "视频模型没有统一按工作台 surface 筛选");
    assert.match(videoRoute, /workspaceSurfaceList/u, "视频模型没有统一归一化工作台归属");
  assert.match(
    workbench,
    /fetch\("\/api\/cover-models\?surface=storyboard-workbench"\)/u,
    "分镜页没有显式请求 storyboard-workbench 生图 surface",
  );
  assert.match(
    workbench,
    /type StoryboardImageFamily = "gpt" \| "gemini" \| "qwen";/u,
    "分镜页没有精确新增 qwen family",
  );
  assert.doesNotMatch(
    workbench,
    /const families: StoryboardImageFamily\[\] = \[[^\]]*"other"/u,
    "分镜页错误放开了全部 other 生图模型",
  );
  assert.match(
    workbench,
    /function supportedWorkbenchRatios\(imageModel\?: ImageModel, videoModel\?: VideoModel\)/u,
    "分镜页没有图片与视频共同画幅函数",
  );
}

function withoutTarget(models: PublicModel[], target: string) {
  return models.filter((model) => model.displayName !== target).map((model) => model.id);
}

function modelChannel(model: PublicModel) {
  const identity = `${model.displayName || ""} ${model.name || ""}`.toLowerCase();
  if (/autodl|自租/u.test(identity)) return "autodl";
  if (/seedance|豆包|即梦/u.test(identity)) return "seedance";
  if (/grok|xai/u.test(identity)) return "grok";
  if (/veo|gemini|google/u.test(identity)) return "google";
  if (/omni/u.test(identity)) return "omni";
  if (/minimax|h3/u.test(identity)) return "minimax";
  return "other";
}

function assertContiguousChannels(models: PublicModel[]) {
  const seen = new Set<string>();
  let previous = "";
  for (const model of models) {
    const channel = modelChannel(model);
    if (channel !== previous) {
      assert.ok(!seen.has(channel), `渠道 ${channel} 在列表中被拆散，未保持连续分组`);
      seen.add(channel);
      previous = channel;
    }
  }
}

async function verifyLocalUi() {
  const parsedBase = new URL(baseUrl);
  assert.ok(
    ["127.0.0.1", "localhost"].includes(parsedBase.hostname),
    "本地 UI 验收只允许访问 localhost/127.0.0.1",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const getModels = async (path: string): Promise<PublicModel[]> => {
      const response = await context.request.get(`${baseUrl}${path}`);
      const data = await response.json() as { models?: PublicModel[]; error?: string };
      assert.ok(response.ok(), data.error || `${path} 请求失败`);
      return Array.isArray(data.models) ? data.models : [];
    };

    const [coverDefault, coverImage, coverStoryboard, coverOther] = await Promise.all([
      getModels("/api/cover-models"),
      getModels("/api/cover-models?surface=image-workbench"),
      getModels("/api/cover-models?surface=storyboard-workbench"),
      getModels("/api/cover-models?surface=unrelated-surface"),
    ]);
    assert.equal(coverImage.filter((model) => model.displayName === imageLabel).length, 1);
    assert.equal(coverStoryboard.filter((model) => model.displayName === imageLabel).length, 1);
    assert.equal(coverDefault.filter((model) => model.displayName === imageLabel).length, 0);
    assert.equal(coverOther.filter((model) => model.displayName === imageLabel).length, 0);
    assert.deepEqual(withoutTarget(coverImage, imageLabel), coverDefault.map((model) => model.id));
    assert.deepEqual(withoutTarget(coverStoryboard, imageLabel), coverDefault.map((model) => model.id));
    assert.deepEqual(coverOther.map((model) => model.id), coverDefault.map((model) => model.id));

    const [videoDefault, videoPage, videoStoryboard, videoOther] = await Promise.all([
      getModels("/api/video/models"),
      getModels("/api/video/models?surface=video-page"),
      getModels("/api/video/models?surface=storyboard-workbench"),
      getModels("/api/video/models?surface=unrelated-surface"),
    ]);
    assert.equal(videoPage.filter((model) => model.displayName === videoLabel).length, 1);
    assert.equal(videoStoryboard.filter((model) => model.displayName === videoLabel).length, 1);
    assert.equal(videoDefault.filter((model) => model.displayName === videoLabel).length, 0);
    assert.equal(videoOther.filter((model) => model.displayName === videoLabel).length, 0);
    assert.ok(videoPage.every((model) => {
      const surfaces = Array.isArray(model.capabilities?.workspaceSurfaces) ? model.capabilities?.workspaceSurfaces : [];
      return surfaces.includes("ai-video") && !surfaces.includes("digital-human");
    }), "AI 视频工作台包含了不属于 ai-video 的模型");
    assert.ok(videoStoryboard.every((model) => {
      const surfaces = Array.isArray(model.capabilities?.workspaceSurfaces) ? model.capabilities?.workspaceSurfaces : [];
      const identity = `${model.displayName || ""} ${model.name || ""}`.toLowerCase();
      const isDigitalHuman = surfaces.includes("digital-human")
        || /数字人|口播|口型|对口型|lip[\s_-]*sync|talking[\s_-]*head/u.test(identity);
      return !isDigitalHuman
        && (surfaces.includes("storyboard") || surfaces.includes("ai-video"))
        && model.capabilities?.requiresSourceVideo !== true;
    }), "分镜工作台包含了错误的模型归属或源视频编辑模型");
    assert.ok(videoStoryboard.length >= 10, `分镜工作台模型数量异常：仅返回 ${videoStoryboard.length} 个`);
    assertContiguousChannels(videoStoryboard);
    assert.deepEqual(videoOther.map((model) => model.id), videoDefault.map((model) => model.id));

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
    const generationRequests: string[] = [];
    const browserErrors: string[] = [];
    const blockedExternalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/image/generate" || url.pathname === "/api/video/generate") {
        generationRequests.push(`${request.method()} ${url.pathname}`);
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        blockedExternalRequests.push(url.origin);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.equal(new URL(page.url()).pathname, "/storyboard-workbench");
    // The rail keeps only the concise model identity visible; full names stay
    // in the model API contract and button accessibility metadata.
    const imageButton = page.locator(".sbw-image-model-list button").filter({ hasText: "Qwen Image 2512 HQ" });
    // Video cards intentionally use a compact visible label now; the full
    // model identity remains available through the button title for QA and
    // accessibility without forcing the rail to grow vertically.
    const videoButton = page.locator(".sbw-video-model-list button").filter({ hasText: "MiniMax H3 Turbo" });
    assert.equal(await imageButton.count(), 1, "分镜页 Qwen selfhost 应恰好出现一次");
    assert.equal(await videoButton.count(), 1, "分镜页 H3 selfhost 应恰好出现一次");

    await imageButton.click();
    await videoButton.click();
    await page.waitForTimeout(100);
    assert.ok((await imageButton.getAttribute("class") || "").includes("is-active"));
    assert.ok((await videoButton.getAttribute("class") || "").includes("is-active"));

    // Add cards locally (without submitting a generation request) so the
    // independent workspace scroll path is exercised with a long run.
    const addCardButton = page.locator(".sbw-add-card");
    for (let index = 0; index < 7; index += 1) await addCardButton.click();
    await page.waitForTimeout(100);

    const scrollMetrics = await page.locator(".sbw-workspace").evaluate((element) => {
      const node = element as HTMLElement;
      const before = {
        headerTop: document.querySelector(".sbw-root > .sub-page-header")?.getBoundingClientRect().top ?? -1,
        railTop: document.querySelector(".sbw-model-rail")?.getBoundingClientRect().top ?? -1,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      };
      node.scrollTop = Math.min(240, Math.max(1, node.scrollHeight - node.clientHeight));
      const after = {
        headerTop: document.querySelector(".sbw-root > .sub-page-header")?.getBoundingClientRect().top ?? -1,
        railTop: document.querySelector(".sbw-model-rail")?.getBoundingClientRect().top ?? -1,
        scrollTop: node.scrollTop,
      };
      return { before, after };
    });
    assert.ok(scrollMetrics.before.scrollHeight > scrollMetrics.before.clientHeight, "右侧分镜卡片区没有独立滚动高度");
    assert.ok(scrollMetrics.after.scrollTop > 0, "右侧分镜卡片区滚动条未生效");
    assert.ok(Math.abs(scrollMetrics.after.headerTop - scrollMetrics.before.headerTop) < 1, "顶部导航随卡片滚动了");
    assert.ok(Math.abs(scrollMetrics.after.railTop - scrollMetrics.before.railTop) < 1, "左侧模型栏随卡片滚动了");

    const ratioButtons = page.locator(".sbw-ratio-control button");
    assert.deepEqual((await ratioButtons.allTextContents()).map((value) => value.trim()), ["16:9", "9:16", "1:1"]);
    assert.deepEqual(
      await ratioButtons.evaluateAll((buttons) => buttons.map((button) => (button as HTMLButtonElement).disabled)),
      [false, true, true],
      "Qwen/H3 共同画幅必须只剩16:9",
    );
    assert.ok((await ratioButtons.nth(0).getAttribute("class") || "").includes("is-active"));

    const imageControl = page.locator(".sbw-control-group.is-image");
    assert.equal(await imageControl.getByText("2K", { exact: true }).count(), 1, "Qwen 分镜生图必须固定2K");
    const videoResolution = page.locator('select[aria-label="视频分辨率"]');
    const videoDuration = page.locator('select[aria-label="视频时长"]');
    assert.deepEqual(await videoResolution.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), ["480p", "1080p", "2K"]);
    assert.deepEqual(await videoDuration.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), ["5", "10", "15"]);
    assert.deepEqual(generationRequests, [], "UI 回归不得提交任何生图或视频生成请求");
    assert.deepEqual(browserErrors, [], `分镜页出现浏览器错误: ${browserErrors.join(" | ")}`);

    console.log(JSON.stringify({
      passed: true,
      surface: "storyboard-workbench",
      selfhost: { image: 1, video: 1 },
      sharedAspectRatios: ["16:9"],
      oldCoverModelOrderPreserved: true,
      oldVideoModelOrderPreserved: true,
      storyboardVideoModels: videoStoryboard.length,
      cardWorkspaceScroll: scrollMetrics,
      generationRequests: 0,
      blockedExternalRequestOrigins: [...new Set(blockedExternalRequests)],
    }, null, 2));
  } finally {
    await browser.close();
  }
}

async function main() {
  await verifyStaticContract();
  if (!process.argv.includes("--static-only")) await verifyLocalUi();
  else console.log("AutoDL H3 storyboard surface static verification passed (zero network). ");
}

void main();
