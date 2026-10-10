import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shouldReturnUnauthenticatedVisitorHome } from "../src/lib/auth-route-boundary";

const projectRoot = process.cwd();
const appContextSource = fs.readFileSync(path.join(projectRoot, "src/contexts/app-context.tsx"), "utf8");

for (const pathname of [
  "/cover",
  "/tools?tab=text",
  "/voice-studio/workspace",
  "/storyboard-workbench",
  "/admin",
]) {
  assert.equal(
    shouldReturnUnauthenticatedVisitorHome(pathname),
    true,
    `${pathname} 必须在无登录会话时返回首页`,
  );
}

for (const pathname of [
  "/",
  "/admin/login",
  "/admin/superzhujunguo",
  "/login",
  "/register",
  "/forgot-password",
  "/about",
  "/announcements",
  "/articles",
  "/articles/demo",
  "/demo/experience",
  "/help",
  "/help/storyboard-prompt-image-video",
  "/payment/result",
  "/share/canvas/public-token",
  "/commerce/canvas-share/public-token",
]) {
  assert.equal(
    shouldReturnUnauthenticatedVisitorHome(pathname),
    false,
    `${pathname} 是明确公开入口，不应被深链边界误伤`,
  );
}

assert.match(
  appContextSource,
  /!token[\s\S]*?shouldReturnUnauthenticatedVisitorHome\(window\.location\.pathname\)[\s\S]*?replaceWithPublicHome\(\)/u,
  "AppProvider 缺少无 token 二级页面回首页接线",
);
assert.match(
  appContextSource,
  /res\.status === 401 \|\| res\.status === 403 \|\| res\.status === 404[\s\S]*?replaceWithPublicHome\(reason\)/u,
  "失效或撤销会话仍必须清理并返回首页",
);
assert.match(
  appContextSource,
  /res\.status >= 500 && cachedUser[\s\S]*?SET_AUTH/u,
  "临时服务故障不得误清理已有可恢复登录",
);

console.log(JSON.stringify({
  passed: true,
  protectedSecondaryRoutes: 5,
  publicRoutes: 16,
  providerRequests: 0,
  databaseWrites: 0,
}, null, 2));
