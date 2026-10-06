import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const outputDir = path.resolve(".codex-artifacts", "20260824-manju-agent-chain");

async function createAdminSession() {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) throw new Error(error?.message || "找不到本地验收账号");
  const user = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "本地验收"),
    role: "admin" as const,
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  const token = await createToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    sessionId: `manga-agent-delivery-${randomUUID()}`,
  });
  return { token, user };
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const session = await createAdminSession();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const paidRequests: string[] = [];
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && /\/(?:llm|chat|generate|image-generation|video-generation)(?:\/|$)/iu.test(pathname)) {
      paidRequests.push(pathname);
    }
  });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, session);
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/youcai/tools/text/text-chat`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="official-agent-page"]');

    const composer = page.getByRole("textbox", { name: "创作需求", exact: true });
    await composer.waitFor({ state: "visible" });
    const guideText = (await composer.getAttribute("placeholder") || "").replace(/\s+/gu, " ");
    assert.match(guideText, /Agent 可以调用 Skill/u);
    assert.match(guideText, /真实媒体生成由对应工作台/u);
    assert.match(guideText, /Enter 发送/u);
    assert.match(guideText, /# 快捷提示词/u);

    const modelSelect = page.locator("select").first();
    await modelSelect.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll("select option").length >= 1);
    const labels = await modelSelect.locator("option").allTextContents();
    assert.ok(labels.length >= 5, `文案兼容模型应足够丰富，当前仅 ${labels.length} 个`);
    assert.equal(new Set(labels).size, labels.length, "模型选择不应包含重复显示项");
    assert.equal(labels.every((label) => label.trim().length > 0), true, "模型显示名不得为空");
    assert.match(await page.locator("body").innerText(), /仅文案 · 不自动切换 · 扣费以服务端结果为准/u);

    await page.screenshot({ path: path.join(outputDir, "agent-desktop.png"), fullPage: false });

    await page.getByTestId("agent-command-trigger").click();
    await page.getByTestId("agent-command-menu").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "关闭命令与创作技能" }).click();
    await page.getByTestId("agent-shortcut-trigger").click();
    await page.getByTestId("agent-shortcut-popover").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "关闭提示词库" }).click();
    await page.getByTestId("agent-wechat-control").click();
    const wechatDialog = page.getByTestId("agent-control-dialog-wechat");
    await wechatDialog.waitFor({ state: "visible" });
    await wechatDialog.getByLabel("关闭").click();

    await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "漫剧工作台", exact: true }).click();
    await page.locator('[data-admin-panel="manju-workbench"]').waitFor({ state: "visible" });
    await page.getByRole("button", { name: "前往统一模型管理" }).waitFor({ state: "visible" });
    const adminText = await page.locator('[data-admin-panel="manju-workbench"]').innerText();
    assert.match(adminText, /漫剧工作台/u);
    assert.match(adminText, /只读/u);
    await page.screenshot({ path: path.join(outputDir, "admin-manju-desktop.png"), fullPage: false });

    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(`${baseUrl}/youcai/tools/text/text-chat`, { waitUntil: "networkidle" });
    await mobile.waitForSelector('[data-testid="official-agent-page"]');
    await mobile.getByRole("textbox", { name: "创作需求", exact: true }).waitFor({ state: "visible" });
    const overflow = await mobile.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    assert.equal(overflow, 0);
    await mobile.screenshot({ path: path.join(outputDir, "agent-mobile.png"), fullPage: false });
    await mobile.close();

    const report = {
      ok: true,
      cost: "text canaries already completed; this verifier performs no generation",
      chatModelCount: labels.length,
      modelLabels: labels,
      composerContractVisible: true,
      commandAndPromptPanels: true,
      wechatControlDialog: true,
      manjuAdminEntryVisible: true,
      manjuAdminMode: "configuration control plane with read-only runtime audit",
      desktopAndMobileScreenshots: true,
      paidRequests,
    };
    assert.deepEqual(paidRequests, [], "Agent 零费用验收不得提交生成请求");
    fs.writeFileSync(path.join(outputDir, "delivery-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main();
