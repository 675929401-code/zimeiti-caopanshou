import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, request } from "playwright";

const origin = "https://youcai.art";
const outputDir = path.resolve(".codex-artifacts", "20260824-official-skill-system");

interface PublicSkill {
  id: string;
  source: string;
  title: string;
  commandName: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  priceCredits: number;
  installed: boolean;
  enabled: boolean;
  agentAutoInvokeEnabled: boolean;
  author: string;
}

type PublicSkillDetail = PublicSkill & {
  parameters?: Record<string, unknown>;
  references?: unknown[];
};

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const api = await request.newContext();
  const storeResponse = await api.get(`${origin}/api/skills/store?`);
  assert.equal(storeResponse.status(), 200, "Skill 商店公开接口不可用");
  const storePayload = await storeResponse.json() as { success?: boolean; skills?: PublicSkill[] };
  assert.equal(storePayload.success, true, "Skill 商店返回失败状态");
  assert.ok(Array.isArray(storePayload.skills), "Skill 商店缺少 skills 数组");
  const skills = storePayload.skills;

  const officialSkills = skills.filter((skill) => skill.source === "official");
  const communitySkills = skills.filter((skill) => skill.source !== "official");
  assert.ok(officialSkills.length > 0, "没有公开的官方 Skill");
  assert.ok(communitySkills.length > 0, "没有公开的社区 Skill");
  assert.ok(officialSkills.every((skill) => skill.installed && skill.enabled), "官方 Skill 并非全部内置启用");
  assert.ok(officialSkills.every((skill) => skill.agentAutoInvokeEnabled), "官方 Skill 并非全部允许 Agent 自动调用");

  const officialSkillDetails: PublicSkillDetail[] = [];
  for (const skill of officialSkills) {
    const detailResponse = await api.get(
      `${origin}/api/skills/store/${encodeURIComponent(skill.id)}`,
    );
    assert.equal(detailResponse.status(), 200, `${skill.id} 详情接口不可用`);
    const detailPayload = await detailResponse.json() as {
      success?: boolean;
      skill?: PublicSkillDetail;
    };
    assert.equal(detailPayload.success, true, `${skill.id} 详情返回失败状态`);
    assert.ok(detailPayload.skill, `${skill.id} 详情缺少 skill`);
    officialSkillDetails.push(detailPayload.skill);
  }

  fs.writeFileSync(
    path.join(outputDir, "official-skill-store-public.json"),
    JSON.stringify(storePayload, null, 2),
  );
  fs.writeFileSync(
    path.join(outputDir, "official-skill-details-public.json"),
    JSON.stringify({ success: true, skills: officialSkillDetails }, null, 2),
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const observedRequests: Array<{ method: string; url: string; postData: string | null }> = [];
  page.on("request", (event) => {
    if (event.url().includes("/api/") || event.isNavigationRequest()) {
      observedRequests.push({
        method: event.method(),
        url: event.url(),
        postData: event.postData(),
      });
    }
  });

  await page.goto(`${origin}/skills`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.screenshot({ path: path.join(outputDir, "official-skills-public.png"), fullPage: true });

  await page.getByText("商业广告脚本", { exact: true }).click();
  const dialog = page
    .locator('[role="dialog"]:visible')
    .filter({ hasText: "商业广告脚本" })
    .filter({ hasText: "/ad-script-master" })
    .first();
  await dialog.waitFor({ state: "visible" });
  const detailText = (await dialog.innerText()).replace(/\s+/gu, " ").trim();
  assert.match(detailText, /\/ad-script-master/u);
  assert.match(detailText, /平台兼容 Skill/u);
  assert.match(detailText, /不具备脚本、电脑、Shell、MCP、Hook 或任意网络权限/u);
  await page.screenshot({ path: path.join(outputDir, "official-skill-detail.png"), fullPage: false });

  await page.getByRole("button", { name: "在对话中创作" }).click();
  await page.waitForTimeout(900);
  const unauthenticatedCreateUrl = page.url();
  assert.match(unauthenticatedCreateUrl, /\/login\?redirect=%2Fskills/u);
  await page.screenshot({ path: path.join(outputDir, "official-skill-create-login-guard.png"), fullPage: false });

  const skillsHtml = await (await api.get(`${origin}/skills`)).text();
  const scriptUrls = [...skillsHtml.matchAll(/src="([^"]+\.js)"/gu)]
    .map((match) => new URL(match[1], origin).href);
  const relevantChunks: Array<{ url: string; text: string }> = [];
  for (const scriptUrl of scriptUrls) {
    const chunkText = await (await api.get(scriptUrl)).text();
    if (
      chunkText.includes("/api/skills/store")
      || chunkText.includes("在对话中创作")
      || chunkText.includes("agentAutoInvokeEnabled")
    ) {
      relevantChunks.push({ url: scriptUrl, text: chunkText });
    }
  }
  assert.ok(relevantChunks.length > 0, "未找到 Skill 页面公开客户端代码");
  const publicClientText = relevantChunks.map((chunk) => chunk.text).join("\n");
  const publicSkillApiPaths = [...new Set(
    [...publicClientText.matchAll(/\/api\/skills\/[A-Za-z0-9_?&=./{}:`"'()\-]+/gu)]
      .map((match) => match[0]),
  )].sort();
  const publicClientContract = {
    hasStoreApi: publicClientText.includes("/api/skills/store"),
    hasInstallFlow: publicClientText.includes("安装"),
    exposesAutoInvokeFlag: publicClientText.includes("agentAutoInvokeEnabled"),
    exposesCommandName: publicClientText.includes("commandName"),
    hasConversationCreateAction: publicClientText.includes("在对话中创作"),
    hasImportFlow: publicClientText.includes("导入 Skill"),
    hasAgentCreateFlow: publicClientText.includes("通过 Agent 创建"),
  };
  Object.entries(publicClientContract).forEach(([name, passed]) => {
    assert.equal(passed, true, `公开客户端契约缺少 ${name}`);
  });

  const report = {
    ok: true,
    capturedAt: new Date().toISOString(),
    source: "official public page, public API and public client bundle",
    counts: {
      total: skills.length,
      official: officialSkills.length,
      community: communitySkills.length,
    },
    officialCommands: officialSkills.map((skill) => ({
      id: skill.id,
      title: skill.title,
      command: `/${skill.commandName}`,
      version: skill.version,
      category: skill.category,
      tags: skill.tags,
      installed: skill.installed,
      enabled: skill.enabled,
      agentAutoInvokeEnabled: skill.agentAutoInvokeEnabled,
      priceCredits: skill.priceCredits,
      parameterNames: Object.keys(
        officialSkillDetails.find((detail) => detail.id === skill.id)?.parameters ?? {},
      ),
    })),
    relationship: {
      explicitInvocation: "用户输入 /skill-name 显式指定 Skill",
      automaticInvocation: "主 Agent 根据 Skill 描述和 agentAutoInvokeEnabled 自动选择",
      toolBoundary: "Skill 产出受控专业文本或结构，真实媒体由主 Agent 的受控 Tool 继续执行",
      securityBoundary: "公开卡片声明平台兼容 Skill 不具备脚本、电脑、Shell、MCP、Hook 或任意网络权限",
    },
    unauthenticatedCreateUrl,
    publicClientContract,
    publicSkillApiPaths,
    publicClientChunks: relevantChunks.map((chunk) => chunk.url),
    observedRequests,
    limitations: [
      "本报告不声称获得服务端隐藏系统提示词原文",
      "登录态显式调用、自动调用、对话工具事件和付费媒体执行需要在受控登录会话继续验证",
      "本轮没有安装社区 Skill，没有创建会话，也没有触发任何付费生成",
    ],
  };
  fs.writeFileSync(path.join(outputDir, "official-skill-system-report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  await context.close();
  await browser.close();
  await api.dispose();
}

void main();
