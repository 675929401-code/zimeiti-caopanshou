import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

export async function main() {
  const origin = process.env.LOCAL_NAV_ORIGIN;
  const token = process.env.LOCAL_NAV_ADMIN_TOKEN;
  assert.equal(origin, "http://127.0.0.1:5000");
  assert.ok(token);
  const user = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY).user;
  const output = ".codex-evidence/director-refinement-20261023/browser";
  await fs.mkdir(output, { recursive: true });
  const runtime = JSON.parse(await fs.readFile(".next/local-source-fingerprint.v1.json", "utf8"));
  assert.equal(runtime.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, "SOURCE_CHANGED_BEFORE_BROWSER");
  const version = await (await fetch(`${origin}/api/version`)).json();
  assert.equal(runtime.buildId, version.buildId);
  const report = { startedAt: new Date().toISOString(), runtime: { buildId: version.buildId, sourceVersion: version.sourceVersion }, pages: [], llmRequests: 0, paidMediaRequests: 0, errors: [], cases: [] };
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    sessionStorage.setItem("entered_app", "1");
  }, { token, user });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/llm") {
      report.llmRequests += 1;
      if (!process.argv.includes("--text-canary") || report.llmRequests > 3) return route.abort("blockedbyclient");
    }
    if (request.method() === "POST" && /\/(?:image|video)\/(?:generate|submit)/u.test(url.pathname)) {
      report.paidMediaRequests += 1;
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message.slice(0, 500)));
  try {
    for (const [name, route] of [["workbench", "/storyboard-workbench"], ["video", "/video"], ["marketplace", "/"]]) {
      await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator("main, .sbw-root, .marketplace-shell, .voice-studio-root").first().waitFor({ state: "visible", timeout: 45000 });
      await page.screenshot({ path: `${output}/${name}.png`, fullPage: false });
      report.pages.push({ route, title: await page.title(), visible: true });
    }
    const selectAgent = async () => {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator('[aria-label^="打开智能体："][aria-label*="高能版"]').click();
      await page.getByTestId("agent-preset-intake").waitFor();
    };
    await selectAgent();
    assert.equal(await page.locator("#preset-visual_asset_mode").count(), 1);
    await page.screenshot({ path: `${output}/director-intake.png`, fullPage: false });
    if (process.argv.includes("--text-canary")) {
      const cases = [
        { id: "ordinary-continuity", copy: "1.【柯基把玩具推到主人脚边，抬头看着她。】\n2.【主人拿起玩具，柯基却绕过球，靠着她的裤腿坐下。】", ratio: "16:9", notes: "女主人始终穿橘色棉质卫衣、深蓝直筒牛仔裤、白色运动鞋，黑色高马尾；蓝色项圈。全片四格，英文注释。", mode: "普通模式" },
        { id: "reference-assets-first", copy: "1.【金毛在门边停住，男主人蹲下，等它自己靠近。】", ratio: "9:16", notes: "男主人墨绿卫衣、卡其长裤、白鞋；金毛深蓝项圈。请先完成人物宠物三视图。", mode: "参考图模式" },
      ];
      for (const [index, item] of cases.entries()) {
        if (index) await selectAgent();
        await page.locator("#preset-segmented_copy").fill(item.copy);
        await page.locator("#preset-video_ratio").selectOption(item.ratio);
        await page.locator("#preset-special_notes").fill(item.notes);
        const options = await page.locator("#preset-visual_asset_mode option").evaluateAll(elements => elements.map(element => element.value));
        await page.locator("#preset-visual_asset_mode").selectOption(options.find(value => value.includes(item.mode)) || item.mode);
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/llm" && response.request().method() === "POST", { timeout: 360000 });
        await page.getByTestId("agent-preset-intake").getByRole("button", { name: "开始", exact: true }).click();
        const response = await responsePromise;
        const requestBody = response.request().postDataJSON();
        const originalUser = [...(requestBody.messages || [])].reverse().find(message => message.role === "user");
        await fs.writeFile(`${output}/${item.id}.input.txt`, typeof originalUser?.content === "string" ? originalUser.content : JSON.stringify(originalUser?.content));
        const body = await response.text();
        await fs.writeFile(`${output}/${item.id}.response.txt`, body);
        const content = body.split("\n").filter(line => line.startsWith("data:")).flatMap(line => {
          try { const value = JSON.parse(line.slice(5).trim()); return [value.choices?.[0]?.delta?.content || value.choices?.[0]?.message?.content || value.content || ""]; } catch { return []; }
        }).join("");
        await fs.writeFile(`${output}/${item.id}.output.txt`, content || body);
        await page.screenshot({ path: `${output}/${item.id}.png`, fullPage: false });
        report.cases.push({ id: item.id, status: response.status(), characters: (content || body).length, complete: true });
        await fs.writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
      }
    }
    assert.equal(runtime.fingerprint, computeLocalBuildFingerprint(process.cwd()).fingerprint, "SOURCE_CHANGED_DURING_BROWSER");
    assert.equal(report.paidMediaRequests, 0);
    report.finishedAt = new Date().toISOString();
    report.runningLatest = true;
  } finally {
    await fs.writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}
