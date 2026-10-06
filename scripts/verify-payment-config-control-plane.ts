import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PlatformSettingValidationError,
  parsePlatformSettingPatch,
} from "../src/lib/platform-settings-contract";

const projectRoot = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(projectRoot, relativePath), "utf8");

const paymentConfigRoute = read("src/app/api/admin/payment-config/route.ts");
const paymentConfigRequestBody = read("src/lib/server/payment-config-request-body.ts");
const paymentMethodsRoute = read("src/app/api/admin/payment-methods/route.ts");
const paymentCreateRoute = read("src/app/api/payment/create/route.ts");
const paymentNotifyRoute = read("src/app/api/payment/notify/route.ts");
const adminPage = read("src/app/admin/page.tsx");
const paymentTab = read("src/components/admin/payment-config-admin-tab.tsx");
const adminGovernance = read("src/lib/admin-governance.ts");
const platformSettingsContract = read("src/lib/platform-settings-contract.ts");
const generalAdminSettingsRoute = read("src/app/api/settings/admin/route.ts");
const adminGovernanceAuthority = read("src/lib/server/admin-governance-authority.ts");
const sensitiveUnlockControl = read("src/components/admin/admin-sensitive-unlock-control.tsx");
const platformSecretSettings = read("src/lib/server/platform-secret-settings.ts");
const xunhupay = read("src/lib/xunhupay.ts");
const rechargeDialog = read("src/components/recharge-dialog.tsx");
const adminUnlockRoute = read("src/app/api/admin/access-control/unlock/route.ts");

const checks: string[] = [];

function pass(name: string, condition: unknown): void {
  assert.ok(condition, name);
  checks.push(name);
  console.log(`PASS ${name}`);
}

function blockBetween(source: string, start: string, end: string, label: string): string {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `${label}: missing start marker ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `${label}: missing end marker ${end}`);
  return source.slice(startIndex, endIndex);
}

function paymentSettingRejected(key: string, value: string, code: string): boolean {
  try {
    parsePlatformSettingPatch({ [key]: value }, "payment");
    return false;
  } catch (error) {
    return error instanceof PlatformSettingValidationError
      && error.code === code
      && error.settingKey === key;
  }
}

const paymentSettingKeysBlock = blockBetween(
  platformSettingsContract,
  "export const PAYMENT_PLATFORM_SETTING_KEYS = [",
  "] as const;",
  "payment config whitelist",
);
const paymentSettingKeys = [...paymentSettingKeysBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
const expectedPaymentSettingKeys = [
  "xunhu_appid",
  "xunhu_secret",
  "xunhu_gateway",
  "xunhu_gateway_backup",
  "xunhu_wap_url",
  "xunhu_refund_gateway",
  "xunhu_refund_gateway_backup",
  "epay_pid",
  "epay_key",
  "epay_gateway",
];
pass(
  "专用 payment-config 接口只接受支付配置白名单",
  JSON.stringify(paymentSettingKeys) === JSON.stringify(expectedPaymentSettingKeys)
    && paymentConfigRoute.includes('parsePlatformSettingPatch(body, "payment")')
    && platformSettingsContract.includes("const PAYMENT_KEY_SET = new Set<string>(PAYMENT_PLATFORM_SETTING_KEYS)"),
);

pass(
  "payment-config 请求体按实际流字节数限制为 64KiB",
  paymentConfigRoute.includes('import { readBoundedPaymentConfigBody } from "@/lib/server/payment-config-request-body"')
    && paymentConfigRequestBody.includes("export const MAX_PAYMENT_CONFIG_BODY_BYTES = 64 * 1024")
    && paymentConfigRequestBody.includes("request.body.getReader()")
    && paymentConfigRequestBody.includes("totalBytes += value.byteLength")
    && paymentConfigRequestBody.includes("totalBytes > MAX_PAYMENT_CONFIG_BODY_BYTES")
    && paymentConfigRequestBody.includes("await reader.cancel()")
    && paymentConfigRequestBody.includes("reader.releaseLock()")
    && paymentConfigRequestBody.includes('new TextDecoder("utf-8", { fatal: true })')
    && paymentConfigRoute.includes('error.code === "PAYMENT_CONFIG_REQUEST_TOO_LARGE" ? 413 : 400')
    && !paymentConfigRoute.includes("request.json()"),
);

const acceptedXunhuGatewaySettings = [
  ["xunhu_gateway", "https://api.xunhupay.com/payment/do.html"],
  ["xunhu_gateway_backup", "https://api.dpweixin.com/payment/do.html"],
  ["xunhu_refund_gateway", "https://api.xunhupay.com/payment/refund.html"],
  ["xunhu_refund_gateway_backup", "https://api.dpweixin.com/payment/refund.html"],
  ["xunhu_gateway", "https://pay.partner-company.com/xunhu/create"],
  ["xunhu_wap_url", "https://merchant-company.com/payment"],
] as const;
pass(
  "迅虎官方主备网关和公网 HTTPS 自定义域名保持可配置",
  acceptedXunhuGatewaySettings.every(([key, value]) => (
    parsePlatformSettingPatch({ [key]: value }, "payment").values[key] === value
  )),
);

const rejectedXunhuGatewaySettings = [
  ["xunhu_gateway", "http://api.xunhupay.com/payment/do.html"],
  ["xunhu_gateway", "https://localhost/payment/do.html"],
  ["xunhu_gateway", "https://127.1/payment/do.html"],
  ["xunhu_gateway", "https://10.0.0.2/payment/do.html"],
  ["xunhu_gateway", "https://172.16.0.2/payment/do.html"],
  ["xunhu_gateway", "https://192.168.1.2/payment/do.html"],
  ["xunhu_gateway", "https://169.254.169.254/latest/meta-data"],
  ["xunhu_gateway", "https://[::1]/payment/do.html"],
  ["xunhu_gateway", "https://[fc00::1]/payment/do.html"],
  ["xunhu_gateway", "https://[fe80::1]/payment/do.html"],
  ["xunhu_gateway", "https://192.0.2.1/payment/do.html"],
  ["xunhu_gateway", "https://198.18.0.1/payment/do.html"],
  ["xunhu_gateway", "https://198.51.100.1/payment/do.html"],
  ["xunhu_gateway", "https://203.0.113.1/payment/do.html"],
  ["xunhu_gateway", "https://[2001:db8::1]/payment/do.html"],
  ["xunhu_gateway", "https://payments/payment/do.html"],
  ["xunhu_gateway", "https://payments.internal/payment/do.html"],
  ["xunhu_gateway", "https://payments.local/payment/do.html"],
  ["xunhu_wap_url", "http://merchant-company.com/payment"],
  ["xunhu_wap_url", "https://127.0.0.1/payment"],
] as const;
pass(
  "迅虎网关拒绝 HTTP、回环、私网和链路本地目标",
  rejectedXunhuGatewaySettings.every(([key, value]) => (
    paymentSettingRejected(key, value, "INVALID_XUNHU_GATEWAY_URL")
  )),
);

const gatewayValidationIndex = paymentConfigRoute.indexOf("await validateXunhuGatewayTargets(patch.values)");
const settingsReadIndex = paymentConfigRoute.indexOf('database.from("platform_settings")');
pass(
  "迅虎出站网关写库前执行公网 DNS 校验且官方可信主机精确列举",
  paymentConfigRoute.includes('import { validateSafeUrl } from "@/lib/safe-fetch"')
    && paymentConfigRoute.includes('const TRUSTED_XUNHU_GATEWAY_HOSTS = ["api.xunhupay.com", "api.dpweixin.com"] as const')
    && paymentConfigRoute.includes("allowedPorts: [443]")
    && paymentConfigRoute.includes("trustedHostnames: [...TRUSTED_XUNHU_GATEWAY_HOSTS]")
    && gatewayValidationIndex >= 0
    && settingsReadIndex > gatewayValidationIndex,
);

const generalAdminKeysBlock = blockBetween(
  platformSettingsContract,
  "export const ADMIN_PLATFORM_SETTING_KEYS = [",
  "] as const;",
  "general admin settings whitelist",
);
pass(
  "支付配置已从通用 admin 设置接口移除",
  expectedPaymentSettingKeys.every((key) => !generalAdminKeysBlock.includes(`"${key}"`))
    && !generalAdminSettingsRoute.includes("clearXunhuConfigCache")
    && !generalAdminSettingsRoute.includes("clearEpayConfigCache"),
);

pass(
  "payment-config 在后台权限映射和路由内都强制 step-up",
  adminGovernance.includes("payment-config|payment-methods")
    && adminGovernance.includes('permission: "payment.settings.manage", requireStepUp: true, operation: "payment_settings"')
    && paymentConfigRoute.includes('authorizeAdminCapability(request, "payment.settings.manage"')
    && paymentConfigRoute.includes("requireStepUp: true"),
);

pass(
  "支付密钥只返回 configured 标记而不返回原值",
  paymentConfigRoute.includes("const settings = redactPlatformSettings(data || [])")
    && platformSecretSettings.includes('"xunhu_secret"')
    && platformSecretSettings.includes('"epay_key"')
    && platformSecretSettings.includes("settings[`${item.setting_key}_configured`] = Boolean(item.setting_value?.trim())")
    && platformSecretSettings.includes("continue;"),
);

pass(
  "空白或遮罩密钥在保存时被忽略以保留服务端原密钥",
  paymentConfigRoute.includes("!isPlatformSecretSettingKey(key) || !isBlankOrMaskedSecret(value)")
    && platformSecretSettings.includes("isBlankOrMaskedSecret"),
);

const changedPaymentConfigBlock = blockBetween(paymentConfigRoute, "if (changedKeys.length) {", "const resultAudited", "payment config cache invalidation");
const upsertIndex = changedPaymentConfigBlock.indexOf('.from("platform_settings").upsert');
const clearXunhuIndex = changedPaymentConfigBlock.indexOf("clearXunhuConfigCache()");
const clearEpayIndex = changedPaymentConfigBlock.indexOf("clearEpayConfigCache()");
pass(
  "支付配置成功写入后清理迅虎与易支付缓存",
  upsertIndex >= 0 && clearXunhuIndex > upsertIndex && clearEpayIndex > upsertIndex,
);

pass(
  "支付配置变更在写库前保留严格审计意图",
  changedPaymentConfigBlock.includes('"PAYMENT_CONFIG_PATCH_AUTHORIZED"')
    && changedPaymentConfigBlock.indexOf("intentAudited") < upsertIndex
    && changedPaymentConfigBlock.includes('"PAYMENT_CONFIG_AUDIT_UNAVAILABLE"')
    && adminGovernanceAuthority.includes("return true;")
    && adminGovernanceAuthority.includes("return false;"),
);

const navigationBlock = blockBetween(
  adminPage,
  "const ADMIN_PRIMARY_NAVIGATION:",
  "const ADMIN_TABS_BY_KEY",
  "admin primary navigation",
);
pass(
  "payment 是可直达且无二级重复层的独立一级导航",
  navigationBlock.includes('{ root: "payment", title: "支付系统", tabs: ["payment"] }')
    && adminPage.includes('{ key: "payment", label: "支付配置"'),
);

pass(
  "支付配置锁定时清空敏感状态且解锁变化会重新读取",
  paymentTab.includes("if (!token || !sensitiveUnlocked)")
    && paymentTab.includes("setConfigLoaded(false)")
    && paymentTab.includes("xunhu_secret: \"\"")
    && paymentTab.includes("epay_key: \"\"")
    && /void loadPaymentConfig\(\);[\s\S]*?\[sensitiveUnlocked, token\]/u.test(paymentTab),
);

pass(
  "支付配置解锁状态按到期时间自动失效并可重新触发读取",
  adminPage.includes("const sensitiveUnlocked = useAdminStepUpReady(")
    && sensitiveUnlockControl.includes("export function useAdminStepUpReady")
    && sensitiveUnlockControl.includes("window.setInterval(update, 15_000)"),
);

pass(
  "员工敏感操作只接受本人登录密码，平台管理密码仅供超级管理员应急",
  adminUnlockRoute.includes('const managementPasswordAllowed = access.adminLevel === "super_admin"')
    && adminUnlockRoute.includes('ADMIN_STEP_UP_METHOD_FORBIDDEN')
    && adminUnlockRoute.includes('managementPasswordAllowed && mode !== "login"')
    && sensitiveUnlockControl.includes('state?.access.adminLevel === "super_admin"')
    && sensitiveUnlockControl.includes('mode: managementPasswordAllowed ? mode : "login"'),
);

pass(
  "支付配置读取成功前禁止空表单覆盖服务端值",
  paymentTab.includes('if (!configLoaded || configLoading)')
    && paymentTab.includes('disabled={configSaving || configLoading || (sensitiveUnlocked && !configLoaded)}')
    && paymentTab.includes('"支付配置尚未成功读取，请重新读取后再保存"'),
);

const dedicatedConfigCalls = paymentTab.match(/fetch\("\/api\/admin\/payment-config"/gu) || [];
pass(
  "后台支付配置读写只使用专用 payment-config API",
  dedicatedConfigCalls.length === 2
    && !paymentTab.includes("/api/settings/admin")
    && paymentTab.includes("await loadPaymentConfig()"),
);

const providerSelect = blockBetween(
  paymentTab,
  "<label className={labelCls}>支付提供商</label>",
  "</select>",
  "payment provider select",
);
const providerOptions = [...providerSelect.matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]);
pass(
  "后台不提供 custom 支付商选项",
  JSON.stringify(providerOptions) === JSON.stringify(["xunhupay", "epay"])
    && !/\bcustom\b/iu.test(providerSelect),
);

const publicPaymentMethodColumns = "id,name,code,icon,provider,is_active,sort_order,created_at,updated_at";
const publicColumnSelections = paymentMethodsRoute.match(
  new RegExp(`\\.select\\(\"${publicPaymentMethodColumns}\"\\)`, "gu"),
) || [];
pass(
  "payment-methods 的列表和写入回包明确列出公开字段",
  publicColumnSelections.length === 3
    && paymentMethodsRoute.includes('.select("code,provider")')
    && !/\.from\("payment_methods"\)\s*\.select\("\*"/u.test(paymentMethodsRoute),
);

const providerWhitelist = blockBetween(
  paymentMethodsRoute,
  "const PAYMENT_PROVIDER_CODES:",
  "function normalizePaymentMethodText",
  "payment method provider whitelist",
);
pass(
  "payment-methods 对 provider 与 code 组合执行固定白名单",
  providerWhitelist.includes('xunhupay: new Set(["wechat", "wxpay", "alipay"])')
    && providerWhitelist.includes('epay: new Set(["wechat", "wxpay", "wechat_epay", "alipay", "alipay_epay", "qqpay"])')
    && !/\bcustom\s*:/iu.test(providerWhitelist)
    && paymentMethodsRoute.includes('validateProviderMethod(provider || "xunhupay", code)')
    && paymentMethodsRoute.includes("validateProviderMethod(provider ?? currentMethod.provider, code ?? currentMethod.code)")
    && paymentMethodsRoute.includes('return NextResponse.json({ error: "该支付提供商已存在相同编码" }, { status: 409 })'),
);

pass(
  "充值选择使用支付方式记录 ID 并拒绝旧客户端歧义选择",
  rechargeDialog.includes("id: m.id")
    && rechargeDialog.includes("key={method.id}")
    && rechargeDialog.includes("paymentMethodId: selectedMethod.id")
    && paymentCreateRoute.includes('const paymentMethodId = typeof body.paymentMethodId === "string"')
    && paymentCreateRoute.includes("matchedMethods.length > 1")
    && paymentCreateRoute.includes('status: 409'),
);

pass(
  "支付创建接口把 alipay_epay 路由到易支付支付宝通道",
  /params\.normalizedMethod === "alipay"\s*\|\|\s*params\.normalizedMethod === "alipay_epay"[\s\S]*?\? "alipay"/u.test(paymentCreateRoute)
    && paymentCreateRoute.includes('type PaymentProvider = "xunhupay" | "epay"')
    && paymentCreateRoute.includes('.select("id, code, provider")'),
);

pass(
  "迅虎创建订单响应必须携带有效签名",
  xunhupay.includes("if (!result.hash)")
    && xunhupay.includes("迅虎支付创建响应缺少签名")
    && xunhupay.includes("!verifyResponseSign(result, secret)"),
);

pass(
  "迅虎支付不再编译旧 zyuani8 域名兜底",
  !/zyuani8(?:\.com)?/iu.test(xunhupay)
    && !/zyuani8(?:\.com)?/iu.test(paymentCreateRoute)
    && xunhupay.includes("const DEFAULT_WAP_URL = process.env.XUNHU_WAP_URL?.trim() || ''"),
);

pass(
  "易支付同步返回只回到当前站点结果页",
  paymentNotifyRoute.includes('new URL("/payment/result", request.nextUrl.origin)')
    && paymentNotifyRoute.includes('resultUrl.searchParams.set("order", outTradeNo)')
    && !paymentNotifyRoute.includes("COZE_PROJECT_DOMAIN_DEFAULT"),
);

console.log(JSON.stringify({
  verifier: "payment-config-control-plane",
  passed: checks.length,
  checks,
}, null, 2));
