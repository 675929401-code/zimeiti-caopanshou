import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const page = read("src/app/admin/page.tsx");
const securityCenter = read("src/components/admin/security-center-admin-tab.tsx");
const panel = read("src/components/admin/security-event-investigation.tsx");
const route = read("src/app/api/admin/security-events/[id]/investigation/route.ts");
const service = read("src/lib/server/security-event-investigation.ts");
const loginRoute = read("src/app/api/auth/login/route.ts");

assert.match(page, /import\("@\/components\/admin\/security-center-admin-tab"\)/u, "管理员页必须加载独立安全中心组件");
assert.match(page, /<SecurityCenterAdminTab[\s\S]*?sensitiveUnlocked=\{sensitiveUnlocked\}/u, "安全中心入口必须传递再次验证状态");
assert.match(securityCenter, /高\/严重风险关联账号 Top10/u, "风险榜必须表达为关联账号，不能直接归因账号本人");
assert.match(securityCenter, /不等于账号持有人实施攻击/u, "列表必须声明账号关联的证据边界");
assert.doesNotMatch(securityCenter, /高\/严重风险用户 Top10/u, "风险榜不得退回到直接归因账号本人的旧文案");
assert.match(securityCenter, /<SecurityEventInvestigation/u, "安全事件展开区必须接入调查组件");
assert.match(securityCenter, /sensitiveUnlocked=\{sensitiveUnlocked\}/u, "调查入口必须绑定再次验证状态");

assert.match(panel, /normalizedReason\.length < 8/u, "调查揭示必须要求具体原因");
assert.match(panel, /ADMIN_STEP_UP_REQUIRED/u, "调查揭示必须处理再次验证门禁");
assert.match(panel, /cache: "no-store"/u, "调查请求不得使用浏览器缓存");
assert.match(panel, /if \(sensitiveUnlocked\) return;\s*setInvestigation\(null\)/u, "解锁失效时必须从 DOM 移除调查结果");
assert.doesNotMatch(panel, /localStorage|sessionStorage/u, "完整 IP 调查组件不得把证据写入浏览器存储");
for (const label of ["主体归因", "网络线索", "地区与网络情报", "设备与自动化特征", "同网络关联", "同账号关联", "证据缺口与口径"]) {
  assert.ok(panel.includes(label), `调查面板缺少 ${label}`);
}
for (const field of ["province", "city", "county", "precision", "statement", "proxyChainStatus", "rawIpStored"]) {
  assert.ok(panel.includes(field), `调查面板缺少 ${field} 证据字段`);
}

assert.match(route, /authorizeAdminCapability\([\s\S]*?"security\.manage"/u, "调查接口必须使用 security.manage");
assert.match(route, /requireStepUp:\s*true/u, "调查接口必须要求再次验证");
assert.match(route, /privateResponse\(authorizationResult\.response\)/u, "鉴权拒绝响应也必须按会话隔离且禁止缓存");
assert.match(route, /appendAdminGovernanceAudit/u, "调查接口必须记录单条揭示审计");
assert.match(route, /SECURITY_INVESTIGATION_AUDIT_UNAVAILABLE/u, "审计失败时必须拒绝返回原始证据");
assert.match(route, /reason[^\n]{0,120}(?:length|trim)/u, "调查接口必须校验调查原因");
assert.match(route, /Cache-Control["']?:?\s*["'][^"']*private[^"']*no-store[^"']*max-age=0/iu, "敏感响应必须 private/no-store/max-age=0");
assert.match(service, /targeting_registered_student/u, "失败登录命中学员账号必须与本人攻击分类分离");
assert.match(service, /provider_not_configured/u, "未配置地理数据源时必须显式报告，不能伪造地区");
assert.match(service, /privacy_preserving_hash_only/u, "仅保存哈希时必须显式报告不可逆证据状态");
assert.doesNotMatch(service, /whois\.pconline|ip-api\.com|fetch\s*\(\s*["'`]https?:/iu, "调查读取不得把原始 IP 临时发送给未审核第三方");

assert.match(loginRoute, /getClientIP/u, "登录事件必须使用统一 IP 解析函数");
assert.doesNotMatch(loginRoute, /function getClientIP/u, "登录接口不得继续维护重复且可漂移的 IP 解析器");

console.log(JSON.stringify({
  status: "passed",
  scope: "security-investigation-attribution",
  guarantees: [
    "account association is not presented as attacker identity",
    "raw IP reveal requires reason, permission and step-up",
    "sensitive evidence is not persisted in browser storage",
    "missing raw IP, proxy chain and geolocation are explicit",
    "login uses the shared client IP parser",
  ],
}, null, 2));
