/**
 * 路由×角色验收矩阵（只读）：访客 / 普通用户 / 管理员 逐页打开，记录最终 URL、首屏文本、控制台错误与 5xx 接口。
 * 前置：5000 已运行 runningLatest=true；ui-check/handoff-storage-state.json 为管理员登录态。
 * 用法：node scripts/verify-route-role-matrix.mjs
 * 说明：会创建并删除一个临时 student 账号用于权限矩阵，不产生付费调用。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("F:/总项目文件/Skill存储系统/01_网页开发项目/自媒体操盘手/当前版本/package.json");
const { chromium } = require("playwright");
const runtime = JSON.parse(fs.readFileSync("F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json", "utf8").replace(/^\uFEFF/u, ""));
const service = { apikey: runtime.serviceRoleKey, Authorization: `Bearer ${runtime.serviceRoleKey}` };
const statePath = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/本地预览日志/ui-check/handoff-storage-state.json";

const routes = ["/", "/storyboard-workbench", "/video", "/voice-studio", "/cover", "/image-workbench", "/media-history", "/profile", "/tools", "/free-canvas", "/admin", "/youcai", "/commerce"];
const results = { admin: {}, guest: {}, student: {} };
let browser;
let student;

try {
  browser = await chromium.launch({ headless: true });

  // 学生账号
  const crypto = await import("node:crypto");
  const uname = `zz_sweep_${Date.now().toString(36)}`;
  const password = "Probe#12345";
  const salt = crypto.randomBytes(16).toString("hex");
  const created = await (await fetch(`${runtime.supabaseUrl}/rest/v1/users`, {
    method: "POST", headers: { ...service, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ username: uname, password_hash: `${salt}:${crypto.createHash("sha256").update(salt + password).digest("hex")}`, display_name: "巡检学生", role: "student", credits: 0, cash_balance: 0, is_active: true, status: "active" }),
  })).json();
  student = created[0].id;
  const sessionId = `probe-${crypto.randomUUID()}`;
  const now = Date.now();
  await fetch(`${runtime.supabaseUrl}/rest/v1/user_auth_sessions`, {
    method: "POST", headers: { ...service, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ user_id: student, session_id: sessionId, created_at: new Date(now).toISOString(), expires_at: new Date(now + 3600_000).toISOString(), revoked_at: null, revoke_reason: null }),
  });
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload = { userId: student, username: uname, role: "student", displayName: "巡检学生", sessionId, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 1800 };
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const token = `${unsigned}.${crypto.createHmac("sha256", runtime.jwtSecret).update(unsigned).digest("base64url")}`;

  const contexts = {
    admin: await browser.newContext({ storageState: statePath, viewport: { width: 1280, height: 800 } }),
    guest: await browser.newContext({ viewport: { width: 1280, height: 800 } }),
    student: await browser.newContext({ viewport: { width: 1280, height: 800 } }),
  };
  await contexts.guest.addInitScript(() => sessionStorage.setItem("entered_app", "1"));
  await contexts.student.addCookies([{ name: "auth_token", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  await contexts.student.addInitScript((v) => { sessionStorage.setItem("entered_app", "1"); localStorage.setItem("auth_token", v); }, token);

  for (const [role, context] of Object.entries(contexts)) {
    const page = await context.newPage();
    for (const route of routes) {
      const errors = [];
      const onErr = (e) => errors.push(String(e).slice(0, 80));
      const onConsole = (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 80)); };
      page.on("pageerror", onErr);
      page.on("console", onConsole);
      try {
        await page.goto(`http://127.0.0.1:5000${route}`, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(1800);
        const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 70);
        results[role][route] = { url: page.url().replace("http://127.0.0.1:5000", ""), text: body, errors: [...new Set(errors)].slice(0, 2) };
      } catch (error) {
        results[role][route] = { error: String(error).slice(0, 90) };
      }
      page.off("pageerror", onErr);
      page.off("console", onConsole);
    }
    await page.close();
  }
} catch (error) {
  results.fatal = String(error).slice(0, 200);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (student) {
    await fetch(`${runtime.supabaseUrl}/rest/v1/user_auth_sessions?user_id=eq.${student}`, { method: "DELETE", headers: service });
    await fetch(`${runtime.supabaseUrl}/rest/v1/users?id=eq.${student}`, { method: "DELETE", headers: service });
  }
  console.log(JSON.stringify(results, null, 1));
}
