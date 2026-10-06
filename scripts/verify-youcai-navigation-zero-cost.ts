import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const origin = String(process.env.BASE_URL || process.env.YOUCAI_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.match(origin, /^http:\/\/127\.0\.0\.1(?::\d+)?$/u, "LOCAL_ORIGIN_REQUIRED");
const staleBundleAllowed = process.argv.includes("--stale-ok");
const outputDir = path.resolve(
  ".codex-evidence",
  "production-readiness-20260825",
  "navigation",
);

const routes = [
  { path: "/youcai/assets", label: "个人资产", data: "GET /api/media-history + /api/storage/files" },
  { path: "/youcai/skills", label: "Skill 专家", data: "本地 Skill 目录 + localStorage 安装状态" },
  { path: "/youcai/tools", label: "创作中心", data: "6 个工具入口 + sessionStorage 预填" },
  { path: "/youcai/tools/text/text-chat", label: "创作 Agent", data: "未登录公开工作台外壳；提交前要求登录" },
  { path: "/youcai/tools/film-studio", label: "影视工坊", data: "公开项目入口；项目数据按账号读取" },
  { path: "/youcai/tools/canvas", label: "漫剧画布", data: "公开案例与本地工作台入口" },
  { path: "/youcai/inspiration", label: "灵感广场", data: "224 件本地库存配置：162 图片 / 44 视频 / 18 音频" },
  { path: "/youcai/youcai-tv", label: "漫剧TV", data: "公开展示页；未上线时明确空态" },
  { path: "/youcai/articles", label: "帮助中心", data: "GET /api/help" },
  { path: "/youcai/recharge", label: "积分充值", data: "统一账户余额；支付仅在用户确认后创建" },
  { path: "/youcai/referral", label: "推荐计划", data: "GET 邀请码 / 记录 / 权益；不自动创建邀请码" },
  { path: "/youcai/profile", label: "个人中心", data: "GET 身份 / 余额 / 资产 / 存储摘要" },
] as const;

const retiredRoutes = [
  "/youcai/creative-horizon",
  "/youcai/navigation",
  "/creative-horizon",
  "/navigation",
] as const;

const publicSurfaceSlots = ["文本", "图像", "音频", "视频", "创作 Agent", "影视工坊"] as const;

const navLabels = [
  "个人资产", "Skill 专家", "创作中心", "创作 Agent", "影视工坊", "漫剧画布",
  "灵感广场", "漫剧TV", "帮助中心", "积分充值", "推荐计划",
];

type RouteEvidence = {
  path: string;
  label: string;
  dataSource: string;
  status: number | null;
  finalPath: string;
  title: string;
  heading: string;
  buttonLabels: string[];
  linkTargets: string[];
  unexpectedLocalLinks: string[];
  visibleBrandLeaks: string[];
  bodySignals: string[];
  layout: {
    viewportHeight: number;
    documentHeight: number;
    mainClientHeight: number;
    mainScrollHeight: number;
    mainOverflowY: string;
    mainScrollMoved: boolean;
  };
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function recordErrors(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const shellSource = fs.readFileSync(path.resolve("src/components/app-route-shell.tsx"), "utf8");
  const helpSource = fs.readFileSync(path.resolve("src/features/youcai-help/youcai-help-center.tsx"), "utf8");
  const inspirationSource = fs.readFileSync(path.resolve("src/features/official-inspiration/inspiration-data.ts"), "utf8");
  assert.match(shellSource, /data-testid="youcai-account-profile-link"/u);
  assert.match(shellSource, /href="\/profile"/u);
  assert.match(shellSource, /hasPublishedNavigation/u);
  assert.match(shellSource, /if \(!hasPublishedNavigation\) return true;/u);
  assert.doesNotMatch(shellSource, /视界杯|世界杯|资源导航|creative-horizon|href:\s*"\/navigation"/u);
  assert.match(helpSource, /漫剧工作台/u);
  assert.doesNotMatch(helpSource, /视界杯|世界杯|资源导航|creative-horizon|\/navigation/u);
  assert.match(inspirationSource, /normalizeWorkspaceBrand/u);
  const browser = await chromium.launch({ headless: true });
  const errors: string[] = [];
  const blockedWrites: string[] = [];
  const evidence: RouteEvidence[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase();
      if (["GET", "HEAD", "OPTIONS"].includes(method)) {
        await route.continue();
        return;
      }
      blockedWrites.push(`${method} ${route.request().url()}`);
      await route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    recordErrors(page, errors);

    for (const route of routes) {
      const response = await page.goto(`${origin}${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(900);
      const status = response?.status() ?? null;
      assert.ok(status !== null && status < 400, `${route.path} HTTP ${status}`);

      const body = await page.locator("body").innerText();
      const heading = await page.locator("h1, h2").first().textContent().catch(() => "") || "";
      const buttonLabels = unique((await page.getByRole("button").allInnerTexts()).map((item) => item.trim()));
      const linkTargets = unique(await page.locator("a[href]").evaluateAll((anchors) => (
        anchors.map((anchor) => anchor.getAttribute("href") || "")
      )));
      const unexpectedLocalLinks = linkTargets.filter((href) => {
        if (!href.startsWith("/")) return false;
        if (href === "/") return false; // 明确的“返回主页”入口
        if (href.startsWith("/youcai")) return false;
        if (/^\/(login|register|forgot-password|reset-password|payment)(\?|\/|$)/u.test(href)) return false;
        return true;
      });

      for (const label of navLabels) {
        assert.ok(linkTargets.some((href) => href.startsWith("/youcai")) && body.includes(label), `${route.path} 缺少导航 ${label}`);
      }
      assert.doesNotMatch(body, /视界杯|世界杯|资源导航/u, `${route.path} 仍显示已退役入口`);
      assert.deepEqual(unexpectedLocalLinks, [], `${route.path} 存在非预期跨分支链接`);

      const layout = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('[data-testid="manju-content"]');
        if (!main) throw new Error("MANJU_CONTENT_SCROLLER_MISSING");
        const before = main.scrollTop;
        if (main.scrollHeight > main.clientHeight + 2) {
          main.scrollTop = Math.min(160, main.scrollHeight - main.clientHeight);
        }
        const result = {
          viewportHeight: window.innerHeight,
          documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
          mainClientHeight: main.clientHeight,
          mainScrollHeight: main.scrollHeight,
          mainOverflowY: getComputedStyle(main).overflowY,
          mainScrollMoved: main.scrollTop > before,
        };
        main.scrollTop = before;
        return result;
      });
      assert.ok(layout.documentHeight <= layout.viewportHeight + 2, `${route.path} 页面根节点出现纵向断层`);
      assert.match(layout.mainOverflowY, /auto|scroll|overlay/u, `${route.path} 缺少独立内容滚动区`);
      if (layout.mainScrollHeight > layout.mainClientHeight + 2) {
        assert.equal(layout.mainScrollMoved, true, `${route.path} 内容区无法纵向滚动`);
      }

      // “主站” is deliberate account/model-boundary copy on tool pages. Only
      // product-name leakage is a branding failure in the Manju surface.
      const visibleBrandLeaks = ["有彩视界", "有彩世界", "自媒体操盘手"]
        .filter((needle) => body.includes(needle));
      if (!staleBundleAllowed) {
        assert.deepEqual(visibleBrandLeaks, [], `${route.path} 存在旧品牌或主站话术`);
      }

      evidence.push({
        path: route.path,
        label: route.label,
        dataSource: route.data,
        status,
        finalPath: new URL(page.url()).pathname,
        title: await page.title(),
        heading: heading.trim(),
        buttonLabels,
        linkTargets,
        unexpectedLocalLinks,
        visibleBrandLeaks,
        layout,
        bodySignals: unique([
          body.includes("请先登录") || body.includes("登录后") ? "auth-empty-state" : "",
          body.includes("暂无") || body.includes("即将上线") ? "honest-empty-state" : "",
          body.includes("加载失败") || body.includes("暂时无法") ? "load-error-state" : "",
        ]),
      });
    }

    const redirects: Array<{ path: string; finalPath: string; status: number | null }> = [];
    for (const retiredPath of retiredRoutes) {
      const response = await page.goto(`${origin}${retiredPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const finalPath = new URL(page.url()).pathname;
      assert.equal(finalPath, "/youcai", `已退役地址没有回到漫剧工作台首页：${retiredPath}`);
      redirects.push({ path: retiredPath, finalPath, status: response?.status() ?? null });
    }

    await page.goto(`${origin}/youcai`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("official-home-page").waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      (slots) => slots.every((slot) => document.body.innerText.includes(slot)),
      publicSurfaceSlots,
      { timeout: 30_000 },
    );
    const homepageBody = await page.locator("body").innerText();
    for (const slot of publicSurfaceSlots) {
      assert.ok(homepageBody.includes(slot), `漫剧首页缺少公开可观察功能槽位：${slot}`);
    }
    const returnHome = page.getByRole("link", { name: "返回自媒体操盘手主页", exact: true });
    await returnHome.click();
    await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    await page.waitForTimeout(900);
    const returnHomeFinalPath = new URL(page.url()).pathname;
    assert.equal(returnHomeFinalPath, "/", "返回主页没有回到主站根路径");

    await page.goto(`${origin}/youcai/skills`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("youcai-skill-expert-page").first().waitFor();
    await page.getByRole("button", { name: /公开分享 15/u }).click();
    assert.equal(await page.getByTestId("youcai-skill-card").count(), 15);
    await page.getByTestId("youcai-skill-card").first().getByRole("button").first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: /关闭 Skill 详情/u }).click();

    await page.goto(`${origin}/youcai/inspiration`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "视频", exact: true }).click();
    assert.match(await page.getByTestId("inspiration-result-count").innerText(), /当前显示/u);
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await page.locator("article button").first().click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "关闭详情" }).click();

    const suppressedTelemetryWrites = blockedWrites.filter((item) => item === `POST ${origin}/api/announcements/events`);
    const unexpectedWriteAttempts = blockedWrites.filter((item) => !suppressedTelemetryWrites.includes(item));
    assert.deepEqual(unexpectedWriteAttempts, [], "零费用审计只允许拦截返回主站后的公告展示统计，不得出现其他写请求");
    const pageErrors = errors.filter((item) => item.startsWith("pageerror:"));
    assert.deepEqual(pageErrors, [], "导航页不应发生 pageerror");

    const report = {
      checkedAt: new Date().toISOString(),
      origin,
      staleBundleAllowed,
      scope: "fresh unauthenticated context; zero-cost GET/HEAD/OPTIONS only",
      sourceChecks: {
        accountProfileLink: true,
        helpBrandNormalization: true,
        inspirationAuthorBrandNormalization: true,
        retiredLabelsAbsent: true,
        publicSurfaceSlots: [...publicSurfaceSlots],
      },
      redirects,
      returnHomeFinalPath,
      writes: {
        allowed: 0,
        blocked: blockedWrites.length,
        suppressedTelemetryWrites,
        unexpectedWriteAttempts,
        requests: blockedWrites,
      },
      errors,
      routes: evidence,
    };
    fs.writeFileSync(path.join(outputDir, "youcai-navigation-zero-cost.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      ok: true,
      routes: evidence.length,
      retiredRedirects: redirects.length,
      returnHomeFinalPath,
      allowedWrites: 0,
      blockedWrites: blockedWrites.length,
      unexpectedWriteAttempts: unexpectedWriteAttempts.length,
      pageErrors: pageErrors.length,
      brandLeaks: evidence.flatMap((item) => item.visibleBrandLeaks.map((leak) => `${item.path}:${leak}`)),
      evidence: path.join(outputDir, "youcai-navigation-zero-cost.json"),
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
