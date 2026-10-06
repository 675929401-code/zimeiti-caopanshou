import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:5000";
const evidenceDir = path.resolve(".codex-evidence/official-clone-phase1-20260823");

interface PageAudit {
  path: string;
  status: number | null;
  pageErrors: string[];
  failedRequests: string[];
  externalRequests: string[];
}

async function auditedGoto(page: Page, pathname: string): Promise<PageAudit> {
  const audit: PageAudit = { path: pathname, status: null, pageErrors: [], failedRequests: [], externalRequests: [] };
  const onError = (error: Error) => audit.pageErrors.push(error.message);
  const onFailed = (request: { url(): string; failure(): { errorText?: string } | null }) => {
    const url = request.url();
    const reason = request.failure()?.errorText || "failed";
    if (reason === "net::ERR_ABORTED" && url.includes("_rsc=")) return;
    audit.failedRequests.push(`${url} :: ${reason}`);
  };
  const onRequest = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(baseURL).origin && !url.protocol.startsWith("data")) {
      audit.externalRequests.push(request.url());
    }
  };
  page.on("pageerror", onError);
  page.on("requestfailed", onFailed);
  page.on("request", onRequest);
  const response = await page.goto(`${baseURL}${pathname}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1_000);
  audit.status = response?.status() ?? null;
  page.off("pageerror", onError);
  page.off("requestfailed", onFailed);
  page.off("request", onRequest);
  return audit;
}

async function main() {
  await mkdir(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  const audits: PageAudit[] = [];

  audits.push(await auditedGoto(page, "/tools/film-studio"));
  assert.equal(audits.at(-1)?.status, 200);
  await page.getByTestId("film-studio-banner").waitFor();
  assert.equal(await page.getByTestId("film-entry-drama-script").getAttribute("href"), "/tools/text/drama-script");
  assert.equal(await page.getByTestId("film-entry-general-script").getAttribute("href"), "/tools/text/general-script");
  assert.equal(await page.getByTestId("film-entry-upload-script").getAttribute("href"), "/tools/text/upload-script");
  assert.equal(await page.getByTestId("film-entry-long-script").isDisabled(), true);
  await page.screenshot({ path: path.join(evidenceDir, "film-studio-desktop.png"), fullPage: true });

  audits.push(await auditedGoto(page, "/tools/text/drama-script"));
  assert.equal(audits.at(-1)?.status, 200);
  await page.getByTestId("drama-script-profile").waitFor();
  await page.screenshot({ path: path.join(evidenceDir, "drama-script-step1.png"), fullPage: true });
  await page.getByRole("button", { name: /下一步/ }).click();
  const brief = page.locator("textarea").first();
  await brief.fill("一名被家族轻视的年轻医生在婚宴上发现父亲留下的证据，决定用专业能力和完整证据链逐步反击并保护母亲。请保持快节奏和因果闭环。");
  await page.screenshot({ path: path.join(evidenceDir, "drama-script-step2-filled.png"), fullPage: true });
  const dramaResponse = page.waitForResponse((response) => response.url().includes("/api/short-drama/drama-script") && response.request().method() === "POST");
  await page.getByTestId("drama-script-generate").click();
  assert.equal((await dramaResponse).status(), 401);
  await page.getByText(/请先登录|未授权|登录/).last().waitFor({ timeout: 10_000 });

  audits.push(await auditedGoto(page, "/tools/text/upload-script"));
  assert.equal(audits.at(-1)?.status, 200);
  await page.getByTestId("upload-script-workbench").waitFor();
  const accept = await page.locator('input[type="file"]').getAttribute("accept");
  assert.match(accept || "", /\.txt/);
  assert.match(accept || "", /\.md/);
  assert.match(accept || "", /\.docx/);
  await page.screenshot({ path: path.join(evidenceDir, "upload-script-desktop.png"), fullPage: true });

  const projectId = "00000000-0000-4000-8000-000000000001";
  audits.push(await auditedGoto(page, `/tools/film-studio/projects/${projectId}?step=script`));
  assert.equal(audits.at(-1)?.status, 200);
  await page.getByText("请先登录主站").waitFor();
  await page.screenshot({ path: path.join(evidenceDir, "project-workbench-signed-out.png"), fullPage: true });

  const api = desktop.request;
  const unauthDrama = await api.post(`${baseURL}/api/short-drama/drama-script`, {
    data: {
      operation: "generate",
      profileId: "drama-script",
      clientRequestId: "drama-script-e2e-unauth-0001",
      input: {
        theme: "revenge",
        storyType: "auto",
        tone: "爽文",
        batchEpisodeCount: 1,
        totalEpisodeCount: null,
        brief: "这是一个只用于验证未登录边界的完整需求，不应触发任何模型请求或保存操作。",
        videoSize: "9:16"
      }
    }
  });
  assert.equal(unauthDrama.status(), 401);
  const unauthProject = await api.get(`${baseURL}/api/short-drama/projects/${projectId}`);
  assert.equal(unauthProject.status(), 401);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const mobilePage = await mobile.newPage();
  const mobileFilm = await auditedGoto(mobilePage, "/tools/film-studio");
  assert.equal(mobileFilm.status, 200);
  audits.push(mobileFilm);
  const bodyWidth = await mobilePage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert.ok(bodyWidth.scrollWidth <= bodyWidth.clientWidth + 1, `mobile overflow ${JSON.stringify(bodyWidth)}`);
  await mobilePage.screenshot({ path: path.join(evidenceDir, "film-studio-mobile.png"), fullPage: true });
  const mobileDrama = await auditedGoto(mobilePage, "/tools/text/drama-script");
  assert.equal(mobileDrama.status, 200);
  audits.push(mobileDrama);
  await mobilePage.screenshot({ path: path.join(evidenceDir, "drama-script-mobile.png"), fullPage: true });

  await mobile.close();
  await desktop.close();
  await browser.close();

  for (const audit of audits) {
    assert.equal(audit.pageErrors.length, 0, `${audit.path} page errors: ${audit.pageErrors.join(" | ")}`);
    assert.equal(audit.failedRequests.length, 0, `${audit.path} failed requests: ${audit.failedRequests.join(" | ")}`);
    assert.equal(audit.externalRequests.length, 0, `${audit.path} external requests: ${audit.externalRequests.join(" | ")}`);
  }

  const report = {
    ok: true,
    baseURL,
    timestamp: new Date().toISOString(),
    audits,
    assertions: {
      officialFilmRoutes: true,
      dramaRouteRealUnauthBoundary: true,
      uploadExtensions: ["txt", "md", "docx"],
      projectOwnerBoundary: true,
      noPaidGenerationTriggered: true,
      mobileNoHorizontalOverflow: true,
    },
  };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
