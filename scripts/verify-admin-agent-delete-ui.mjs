import { chromium } from "playwright";
import { config as loadEnv } from "dotenv";
import { SignJWT } from "jose";

loadEnv({ path: ".env.local", quiet: true });

const baseUrl = "http://127.0.0.1:5000";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

let deleteRequests = 0;
const deleteRequestUrls = [];
const agentListRequests = [];
const consoleMessages = [];
const browserErrors = [];

page.on("console", (message) => {
  consoleMessages.push(message.text());
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => browserErrors.push(error.message));
await page.addInitScript(() => {
  localStorage.setItem("auth_token", "ui-contract-test-token");
  localStorage.setItem("auth_user", JSON.stringify({ id: "admin-1", role: "admin", displayName: "管理员" }));
  sessionStorage.setItem("app_state_admin_activeTab", JSON.stringify("agents"));
});

await page.route(`${baseUrl}/__codex_agent_delete_host`, async (route) => {
  await route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<iframe title="sandboxed-admin" sandbox="allow-scripts allow-same-origin allow-forms" src="${baseUrl}/admin" style="width:100vw;height:100vh;border:0"></iframe>`,
  });
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/auth/me") {
    await route.fulfill({ json: { user: { id: "admin-1", role: "admin", displayName: "管理员" } } });
    return;
  }
  if (url.pathname === "/api/admin/agents") {
    if (request.method() === "DELETE") {
      deleteRequests += 1;
      deleteRequestUrls.push(request.url());
      await route.fulfill({ json: { success: true, message: "已移入回收站" } });
      return;
    }
    agentListRequests.push(request.url());
    const trashed = url.searchParams.get("trash") === "1" || url.searchParams.get("trashed") === "true";
    await route.fulfill({
      json: {
        agents: trashed ? [{
          id: "agent-permanent-delete-contract",
          name: "永久删除链路测试智能体",
          description: "仅用于前端交互回归，不写数据库",
          category: "引流带货",
          source: "llm",
          model: "gpt-test",
          is_active: false,
          user_access: "hidden",
          sort_order: 20,
          deleted_at: "2026-08-17T00:00:00.000Z",
        }] : [{
          id: "agent-delete-contract",
          name: "删除链路测试智能体",
          description: "仅用于前端交互回归，不写数据库",
          category: "引流带货",
          source: "llm",
          model: "gpt-test",
          is_active: true,
          user_access: "available",
          sort_order: 10,
        }],
      },
    });
    return;
  }
  await route.fulfill({ json: {} });
});

await page.goto(`${baseUrl}/__codex_agent_delete_host`, { waitUntil: "domcontentloaded" });
const adminFrame = await page.waitForEvent("framenavigated", {
  predicate: (frame) => frame.url() === `${baseUrl}/admin`,
  timeout: 30_000,
}).catch(() => page.frames().find((frame) => frame.url() === `${baseUrl}/admin`));

if (!adminFrame) throw new Error("管理后台 iframe 未加载");
const deleteButton = adminFrame.getByRole("button", { name: "删除", exact: true }).first();
await deleteButton.waitFor({ state: "visible", timeout: 30_000 });
await deleteButton.click();
await page.waitForTimeout(300);

const confirmationVisible = await adminFrame.getByRole("heading", { name: "操作确认" }).isVisible().catch(() => false);
if (confirmationVisible) {
  await page.screenshot({ path: ".codex-screenshots/admin-agent-delete-confirm-fixed.png", fullPage: true });
  await adminFrame.getByPlaceholder("请输入管理员密码").fill("ui-contract-test-password");
  await adminFrame.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForFunction(() => true);
  await page.waitForTimeout(300);
}

await adminFrame.getByRole("button", { name: "回收站", exact: true }).click();
const permanentDeleteButton = adminFrame.getByRole("button", { name: "永久删除", exact: true }).first();
await permanentDeleteButton.waitFor({ state: "visible", timeout: 15_000 });
await permanentDeleteButton.click();
const permanentConfirmationVisible = await adminFrame.getByText("永久删除智能体（此操作无法恢复）", { exact: true })
  .isVisible().catch(() => false);
if (permanentConfirmationVisible) {
  await adminFrame.getByPlaceholder("请输入管理员密码").fill("ui-contract-test-password");
  await adminFrame.getByRole("button", { name: "确认", exact: true }).click();
  await page.waitForTimeout(300);
}
const result = {
  confirmationVisible,
  permanentConfirmationVisible,
  deleteRequests,
  deleteRequestHasEncodedId: deleteRequestUrls.some((url) => url.includes("id=agent-delete-contract")),
  permanentDeleteRequestValid: deleteRequestUrls.some((url) => url.includes("id=agent-permanent-delete-contract") && url.includes("permanent=1")),
  trashRequestUsesApiContract: agentListRequests.some((url) => url.includes("trash=1")),
  sandboxModalBlocked: consoleMessages.some((message) => /allow-modals|sandboxed/i.test(message)),
};

const extractPage = await context.newPage();
extractPage.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
extractPage.on("pageerror", (error) => browserErrors.push(error.message));
await extractPage.addInitScript(() => localStorage.clear());
await extractPage.goto(`${baseUrl}/extract`, { waitUntil: "domcontentloaded" });
const unaffectedExtractVisible = await extractPage.getByText("文案提取", { exact: false }).first()
  .waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);

const jwtSecret = process.env.JWT_SECRET?.trim() ?? '';
const adminToken = await new SignJWT({
  userId: "codex-delete-contract-admin",
  username: "codex-delete-contract-admin",
  role: "admin",
  displayName: "删除链路契约测试",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(new TextEncoder().encode(jwtSecret));
const serverHeaders = { Authorization: `Bearer ${adminToken}` };
const missingAgentId = `codex-delete-contract-missing-${Date.now()}`;
const [trashResponse, softDeleteResponse, permanentDeleteResponse] = await Promise.all([
  fetch(`${baseUrl}/api/admin/agents?trash=1`, { headers: serverHeaders }),
  fetch(`${baseUrl}/api/admin/agents?id=${encodeURIComponent(missingAgentId)}`, { method: "DELETE", headers: serverHeaders }),
  fetch(`${baseUrl}/api/admin/agents?id=${encodeURIComponent(missingAgentId)}&permanent=1`, { method: "DELETE", headers: serverHeaders }),
]);
const serverContract = {
  trashStatus: trashResponse.status,
  missingSoftDeleteStatus: softDeleteResponse.status,
  missingPermanentDeleteStatus: permanentDeleteResponse.status,
};
console.log(JSON.stringify({ ...result, unaffectedExtractVisible, browserErrorCount: browserErrors.length, serverContract }));

if (
  !result.confirmationVisible ||
  !result.permanentConfirmationVisible ||
  result.deleteRequests !== 2 ||
  !result.deleteRequestHasEncodedId ||
  !result.permanentDeleteRequestValid ||
  !result.trashRequestUsesApiContract ||
  result.sandboxModalBlocked ||
  !unaffectedExtractVisible ||
  browserErrors.length !== 0 ||
  serverContract.trashStatus !== 200 ||
  serverContract.missingSoftDeleteStatus !== 404 ||
  serverContract.missingPermanentDeleteStatus !== 404
) {
  process.exitCode = 1;
}

await browser.close();
