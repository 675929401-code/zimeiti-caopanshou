import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const AI_VIDEO_H3_AUDIO_MODEL = "MiniMax H3 · AutoDL托管渠道（多图多音频）";
const STORYBOARD_H3_MODEL_PATTERN = /MiniMax H3/u;

type PublicVideoModel = {
  id?: string;
  displayName?: string;
  capabilities?: {
    billingUnit?: string;
    defaultDuration?: number;
    defaultResolution?: string;
    supportsAudioInput?: boolean;
    workspaceSurfaces?: string[];
  };
};

type VerificationSession = {
  token: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    role: "admin";
    credits?: number;
    cashBalance?: number;
  };
};

async function closeWithTimeout(label: string, close: () => Promise<unknown>, timeoutMs = 3_000) {
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    close().then(() => true).catch(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!closed) console.warn(`${label} close timed out after ${timeoutMs}ms; forcing verifier exit`);
}

async function fetchPublicModels(baseUrl: string, surface: string) {
  const response = await fetch(`${baseUrl}/api/video/models?surface=${encodeURIComponent(surface)}`);
  const payload = await response.json() as { models?: PublicVideoModel[]; error?: string };
  assert.ok(response.ok && Array.isArray(payload.models), payload.error || `${surface} 模型接口不可用`);
  return payload.models;
}

async function createVerificationSession(baseUrl: string): Promise<VerificationSession> {
  try {
    const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
      headers: { "x-local-workbench": "ai-creation-studio-local" },
    });
    const session = await sessionResponse.json() as VerificationSession & { error?: string };
    if (sessionResponse.ok && session.token && session.user) return session;
  } catch {
    // Local production-mode servers intentionally keep dev-session unavailable.
  }

  const db = getSupabaseClient();
  const { data, error } = await db
    .from("users")
    .select("id, username, display_name, credits, cash_balance")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  assert.ok(data && !error, error?.message || "本地验收管理员账号不可用");

  const user: VerificationSession["user"] = {
    id: String(data.id),
    username: String(data.username),
    displayName: String(data.display_name || "本地验收"),
    role: "admin",
    credits: Number(data.credits || 0),
    cashBalance: Number(data.cash_balance || 0),
  };
  const token = await createToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    sessionId: `verify-video-models-${randomUUID()}`,
  });
  return { token, user };
}

async function main() {
  const baseUrl = process.env.LOCAL_APP_URL || "http://127.0.0.1:5000";
  const session = await createVerificationSession(baseUrl);

  const [aiVideoModels, storyboardModels] = await Promise.all([
    fetchPublicModels(baseUrl, "video-page"),
    fetchPublicModels(baseUrl, "storyboard-workbench"),
  ]);
  const aiVideoH3AudioModels = aiVideoModels.filter((model) => model.displayName === AI_VIDEO_H3_AUDIO_MODEL);
  assert.equal(aiVideoH3AudioModels.length, 1, "AI 视频制作必须且只能出现一个 AutoDL H3 多图多音频渠道");
  const aiVideoH3AudioModel = aiVideoH3AudioModels[0];
  assert.equal(aiVideoH3AudioModel.capabilities?.billingUnit, "output_second", "AI 视频制作 H3 多音频渠道没有按输出秒计费");
  assert.equal(aiVideoH3AudioModel.capabilities?.defaultDuration, 10, "AI 视频制作 H3 多音频渠道默认时长不是 10 秒");
  assert.equal(aiVideoH3AudioModel.capabilities?.defaultResolution, "768p", "AI 视频制作 H3 多音频渠道默认分辨率不是 768p");

  assert.equal(
    storyboardModels.filter((model) => model.displayName === AI_VIDEO_H3_AUDIO_MODEL).length,
    0,
    "分镜工作台不应展示需要音频输入的 H3 多音频渠道",
  );
  assert.ok(
    storyboardModels.some((model) => STORYBOARD_H3_MODEL_PATTERN.test(String(model.displayName || ""))),
    "分镜工作台必须至少展示一个可用的 MiniMax H3 图生视频模型",
  );
  assert.equal(
    storyboardModels.filter((model) => model.capabilities?.supportsAudioInput).length,
    0,
    "分镜工作台公开模型接口不应返回音频输入型模型",
  );

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ token, user }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
    }, { token: session.token, user: session.user });

    const page = await context.newPage();
    const paidRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/video/generate")) paidRequests.push(request.url());
    });

    const adminResponse = await page.goto(`${baseUrl}/admin?verify=autodl-new-channel`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    assert.equal(adminResponse?.status(), 200, "管理后台无法打开");
    await page.getByText("模型管理", { exact: true }).first().click();
    await page.getByText(AI_VIDEO_H3_AUDIO_MODEL, { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });

    const storyboardResponse = await page.goto(`${baseUrl}/storyboard-workbench?verify=autodl-new-channel`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    assert.equal(storyboardResponse?.status(), 200, "分镜工作台无法打开");
    const storyboardModel = page
      .getByRole("button", { name: /选择视频模型：MiniMax H3/u })
      .filter({ hasNotText: "多图多音频" })
      .first();
    await storyboardModel.waitFor({ state: "visible", timeout: 30_000 });
    const storyboardModelText = await storyboardModel.innerText();
    assert.match(storyboardModelText, /需参考图/u, "分镜工作台 H3 模型没有展示当前参考图输入要求");
    assert.doesNotMatch(storyboardModelText, /多图多音频/u, "分镜工作台误选了音频输入型 H3 模型");

    const videoResponse = await page.goto(`${baseUrl}/video?verify=autodl-new-channel`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    assert.equal(videoResponse?.status(), 200, "AI 视频制作页面无法打开");
    const modelField = page.locator("label:visible").filter({ hasText: "视频模型" }).locator("..");
    await modelField.locator("button").first().click({ force: true });
    await page.getByRole("option", { name: new RegExp(AI_VIDEO_H3_AUDIO_MODEL) }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.keyboard.press("Escape");

    assert.deepEqual(paidRequests, [], "只读验收不得提交任何付费视频生成请求");
    await closeWithTimeout("context", () => context.close());
  } finally {
    await closeWithTimeout("browser", () => browser.close());
  }

  console.log(JSON.stringify({
    status: "passed",
    channel: AI_VIDEO_H3_AUDIO_MODEL,
    surfaces: ["admin", "video-page"],
    storyboardSurface: "filters audio-input H3 channel; keeps compatible H3 image-to-video models",
    defaultDuration: 10,
    defaultResolution: "768p",
    paidCalls: 0,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
