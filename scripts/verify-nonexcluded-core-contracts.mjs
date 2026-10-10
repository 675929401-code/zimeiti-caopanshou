#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, ".codex-evidence", "full-surface-acceptance-20261003");
const evidencePath = path.join(evidenceDir, "nonexcluded-core-contracts.json");

const tests = [
  ["身份/深链", "verify-auth-deeplink-zero-cost.ts"],
  ["身份/当前会话", "verify-auth-me-readonly-contract.ts"],
  ["身份/邮箱验证码", "verify-qq-email-verification-zero-cost.ts"],
  ["会员/权限快照", "verify-member-permission-contract.mjs"],
  ["会员/隐私财务媒体", "verify-member-privacy-finance-media-gates.ts"],
  ["公告/客户端策略", "verify-announcement-client-policy.ts"],
  ["公告/推送界面", "verify-announcement-push-ui.ts"],
  ["帮助中心", "verify-help-center.ts"],
  ["导航/性能合同", "verify-navigation-performance-contract.ts"],
  ["工具箱/UI合同", "verify-toolbox-ui.ts", {
    mode: "zero-network-static",
    env: { TOOLBOX_SKIP_RUNTIME: "1" },
  }],
  ["提取/一期零成本", "verify-extract-phase1-zero-cost.ts"],
  ["提取/定价失败关闭", "verify-extraction-pricing-fail-closed-zero-cost.ts"],
  ["提取/工具交接链", "verify-extract-tool-chain-zero-cost.ts"],
  ["提取/商业闭环", "verify-extraction-commercial-closure-zero-cost.ts"],
  ["聊天/客户端可靠性", "verify-chat-client-reliability-zero-cost.ts"],
  ["聊天/错误分类", "verify-chat-error-taxonomy-zero-cost.ts"],
  ["聊天/发布模型门禁", "verify-chat-published-model-gate-zero-cost.ts"],
  ["图片/交付", "verify-image-delivery-p0.ts"],
  ["视频/页面链安全", "verify-video-page-chain-safety.ts", {
    mode: "zero-network-static",
    env: { VIDEO_PAGE_STATIC_ONLY: "1" },
  }],
  ["语音/客户端接口", "verify-voice-client-api-contract.ts"],
  ["媒体历史", "verify-media-history-contract.ts"],
  ["数字人/合同", "verify-digital-human-contracts.ts"],
  ["后台/当前鉴权", "verify-admin-current-authorization.ts"],
  ["后台/权限覆盖", "verify-admin-permission-coverage.ts"],
  ["后台/权限目录", "verify-admin-permission-catalog-coverage.ts"],
  ["后台/分包隐藏", "verify-admin-bundle-concealment.mjs"],
  ["后台/能力隐藏", "verify-admin-capability-concealment.mjs"],
  ["后台/超级管理员界面", "verify-super-admin-permission-ui.ts"],
  ["安全/P0审计", "verify-security-p0-audit-hardening.ts"],
  ["安全/案件控制面", "verify-security-case-control-plane.ts"],
  ["安全/事件可靠性", "verify-security-event-reliability.ts"],
  ["安全/调查归因", "verify-security-investigation-contract.ts"],
  ["安全/乱码和脱敏", "verify-security-auxiliary-log-display.ts"],
  ["运维/健康监测", "verify-health-monitor-contract.ts"],
  ["运维/飞行日志", "verify-operation-flight-recorder.ts"],
  ["运维/客户端遥测安全", "verify-client-error-telemetry-security.ts"],
  ["设置/品牌合同", "verify-platform-branding-contract.ts"],
  ["设置/权威来源", "verify-platform-settings-authority.ts"],
  ["设置/绕过门禁", "verify-platform-configuration-bypass-gate.ts"],
];

function commandFor(file) {
  const target = `./scripts/${file}`;
  if (file.endsWith(".ts")) {
    return [process.execPath, ["./scripts/run-node-maintenance-tsx.mjs", target]];
  }
  return [process.execPath, [target]];
}

const startedAt = new Date().toISOString();
const results = [];

for (const [domain, file, options = {}] of tests) {
  const [command, args] = commandFor(file);
  const started = Date.now();
  const childEnv = { ...process.env, ACCEPTANCE_ZERO_COST: "1" };
  delete childEnv.TOOLBOX_SKIP_RUNTIME;
  delete childEnv.VIDEO_PAGE_STATIC_ONLY;
  Object.assign(childEnv, options.env ?? {});
  const child = spawnSync(command, args, {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`.trim();
  const result = {
    domain,
    file,
    mode: options.mode ?? "zero-cost-contract",
    environmentOverrides: Object.keys(options.env ?? {}).sort(),
    status: child.status === 0 ? "passed" : "failed",
    exitCode: typeof child.status === "number" ? child.status : null,
    signal: child.signal ?? null,
    durationMs: Date.now() - started,
    outputTail: output.slice(-4000),
  };
  results.push(result);
  process.stdout.write(`${result.status === "passed" ? "PASS" : "FAIL"} ${domain} (${file})\n`);
}

const report = {
  schemaVersion: 1,
  scope: "nonexcluded-core-source-and-zero-cost-contracts",
  excluded: ["commerce/带货 Agent", "Manju/漫剧/短剧工作台"],
  startedAt,
  finishedAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((item) => item.status === "passed").length,
  failed: results.filter((item) => item.status === "failed").length,
  results,
};

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`Evidence: ${evidencePath}\n`);
process.stdout.write(`Summary: ${report.passed}/${report.total} passed\n`);
process.exit(report.failed === 0 ? 0 : 1);
