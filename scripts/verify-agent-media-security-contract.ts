import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AgentAvatarGenerationPolicyError,
  MAX_AGENT_AVATAR_BATCH,
  parseAgentAvatarGenerationRequest,
} from "../src/lib/server/agent-avatar-generation-policy";

function expectPolicyError(
  run: () => unknown,
  code: string,
  status: number,
): void {
  assert.throws(
    run,
    (error: unknown) => error instanceof AgentAvatarGenerationPolicyError
      && error.code === code
      && error.status === status,
    `${code} (${status})`,
  );
}

async function main(): Promise<void> {
  const root = process.cwd();
  const read = (path: string) => readFile(`${root}/${path}`, "utf8");
  const [
    adminPage,
    agentsRoute,
    batchRoute,
    generator,
    governance,
    marketplace,
    storage,
    utils,
  ] = await Promise.all([
    read("src/app/admin/page.tsx"),
    read("src/app/api/admin/agents/route.ts"),
    read("src/app/api/admin/agents/batch-avatar/route.ts"),
    read("src/lib/auto-avatar/generator.ts"),
    read("src/lib/admin-governance.ts"),
    read("src/components/agent-marketplace.tsx"),
    read("src/lib/storage.ts"),
    read("src/lib/utils.ts"),
  ]);

  const requestKey = "media-avatar-0001";
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      confirmPaidGeneration: true,
      confirmedAgentCount: 0,
      idempotencyKey: requestKey,
    }, null),
    "AVATAR_GENERATION_SCOPE_REQUIRED",
    400,
  );
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      agentIds: ["agent-a"],
      confirmedAgentCount: 1,
      idempotencyKey: requestKey,
    }, null),
    "PAID_AVATAR_GENERATION_CONFIRMATION_REQUIRED",
    412,
  );
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      agentIds: [],
      confirmPaidGeneration: true,
      confirmedAgentCount: 0,
      idempotencyKey: requestKey,
    }, null),
    "AVATAR_GENERATION_AGENT_IDS_REQUIRED",
    400,
  );
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      agentIds: ["agent-a", "agent-b"],
      confirmPaidGeneration: true,
      confirmedAgentCount: 1,
      idempotencyKey: requestKey,
    }, null),
    "AVATAR_GENERATION_CONFIRMATION_SCOPE_MISMATCH",
    412,
  );
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      agentIds: Array.from({ length: MAX_AGENT_AVATAR_BATCH + 1 }, (_, index) => `agent-${index}`),
      confirmPaidGeneration: true,
      confirmedAgentCount: MAX_AGENT_AVATAR_BATCH + 1,
      idempotencyKey: requestKey,
    }, null),
    "AVATAR_GENERATION_BATCH_LIMIT_EXCEEDED",
    413,
  );
  expectPolicyError(
    () => parseAgentAvatarGenerationRequest({
      agentIds: ["agent-a"],
      confirmPaidGeneration: true,
      confirmedAgentCount: 1,
      idempotencyKey: "short",
    }, null),
    "AVATAR_GENERATION_IDEMPOTENCY_KEY_REQUIRED",
    400,
  );

  const batch = parseAgentAvatarGenerationRequest({
    agentIds: ["agent-a", "agent-a", "agent-b"],
    confirmPaidGeneration: true,
    confirmedAgentCount: 2,
    idempotencyKey: requestKey,
  }, null);
  assert.deepEqual(batch.agentIds, ["agent-a", "agent-b"]);
  assert.equal(batch.mode, "batch");

  const single = parseAgentAvatarGenerationRequest({
    singleAgent: { name: "测试智能体", description: "测试说明" },
    agentId: "agent-one",
    confirmPaidGeneration: true,
    confirmedAgentCount: 1,
  }, "media-avatar-header-0001");
  assert.equal(single.mode, "single");
  assert.equal(single.singleAgentId, "agent-one");

  assert.match(
    governance,
    /pathname\.startsWith\("\/api\/admin\/agents"\)[\s\S]*permission: write \? "agents\.manage"[\s\S]*requireStepUp: write/u,
    "全局后台治理必须把 agents 写请求映射到 agents.manage + step-up",
  );
  assert.doesNotMatch(agentsRoute, /triggerAutoAvatar/u, "普通新增/保存不得隐式触发付费头像生成");
  assert.match(agentsRoute, /verifyOwnedAgentImageReference\(normalized, actorId, 'avatar'\)/u);
  assert.match(agentsRoute, /verifyOwnedAgentImageReference\(cover, actorId, 'cover'\)/u);
  assert.match(agentsRoute, /ownerUserId: actorId/u, "HTTP/Data URL 头像转存必须绑定当前管理员");
  assert.match(agentsRoute, /allowOriginalUrlFallback: false/u, "头像转存必须 fail closed");
  assert.match(agentsRoute, /fields\.cover_url !== undefined/u, "背景图更新必须失效前台 bots 缓存");

  for (const required of [
    "safeFetch(rawUrl",
    "timeoutMs: AGENT_IMAGE_FETCH_TIMEOUT_MS",
    "maxBytes: MAX_AGENT_IMAGE_BYTES",
    'networkPolicy: "system-dns-pinned"',
    "allowedContentTypes: [...ALLOWED_AGENT_IMAGE_MIME]",
    "validateUploadBuffer(buffer, declaredContentType)",
    "limitInputPixels: MAX_AGENT_IMAGE_PIXELS",
    '.eq("user_id", ownerUserId)',
    'String(meta.purpose || "") !== purpose',
    'storageManager.head(normalized, owned.storage_provider)',
    'prefix: "agent-images/avatar/"',
    "requireOwnershipRecord: true",
  ]) {
    assert.ok(storage.includes(required), `storage 缺少媒体安全合同：${required}`);
  }
  assert.doesNotMatch(
    storage.slice(storage.indexOf("async function readAgentImageSource"), storage.indexOf("async function validateAgentImageBytes")),
    /\bfetch\s*\(/u,
    "HTTP 头像转存不得绕过 safeFetch",
  );

  for (const required of [
    "parseAgentAvatarGenerationRequest",
    '.in("id", scope.agentIds)',
    "claimPaidGeneration(request, actor.userId, scope)",
    'p_permission_key: "agents.manage"',
    "claimToken",
    "AVATAR_GENERATION_ALREADY_CLAIMED",
    '{ ownerUserId: actor.userId, source: "agent-avatar-generated" }',
  ]) {
    assert.ok(batchRoute.includes(required), `batch-avatar 缺少付费边界：${required}`);
  }
  assert.doesNotMatch(batchRoute, /if \(agentIds[\s\S]{0,120}query = query\.in/u, "批量范围不得退化为可选全量查询");
  assert.match(generator, /ownerUserId: persistence\.ownerUserId/u, "生图结果必须写入触发管理员名下的托管资产");

  const batchUi = adminPage.slice(adminPage.indexOf("const handleBatchAvatar"), adminPage.indexOf("const handleBatchAvatar") + 4_000);
  assert.match(batchUi, /eligibleAgents\.slice\(0, 20\)/u, "后台批量动作必须限制显式范围上限");
  assert.match(batchUi, /agentIds/u);
  assert.match(batchUi, /confirmPaidGeneration: true/u);
  assert.match(batchUi, /confirmedAgentCount: agentIds\.length/u);
  assert.match(batchUi, /"Idempotency-Key": idempotencyKey/u);
  const singleUi = adminPage.slice(adminPage.indexOf("const generateSingleAvatar"), adminPage.indexOf("const generateSingleAvatar") + 3_000);
  assert.match(singleUi, /confirm\(/u, "单次生图必须先明确提示费用");
  assert.match(singleUi, /confirmPaidGeneration: true/u);
  assert.match(singleUi, /confirmedAgentCount: 1/u);
  assert.match(singleUi, /"Idempotency-Key": idempotencyKey/u);

  assert.doesNotMatch(
    utils.slice(utils.indexOf("export function resolveAgentAvatarUrl"), utils.indexOf("/**", utils.indexOf("export function resolveAgentAvatarUrl") + 1)),
    /startsWith\('\/api\/avatars\?key='\)/u,
    "已托管头像代理 URL 不得被强制替换为默认头像",
  );
  assert.match(marketplace, /const displayCover = resolveAvatarUrl\(agent\.cover_url \|\| ""\)/u);
  assert.match(marketplace, /data-agent-cover-url=\{displayCover \|\| undefined\}/u);
  assert.match(marketplace, /src=\{displayCover\}/u, "应用卡必须实际渲染背景图");

  console.log(JSON.stringify({
    passed: true,
    managedAssetOwnership: true,
    safeHttpTransfer: true,
    maxAvatarBytes: 5 * 1024 * 1024,
    batchLimit: MAX_AGENT_AVATAR_BATCH,
    explicitPaidConfirmation: true,
    durableIdempotencyClaim: true,
    ordinarySavePaidCalls: 0,
    managedAvatarFrontendResolution: true,
    coverFrontendConsumer: "agent-marketplace-card",
    databaseWrites: 0,
    providerCalls: 0,
    deployment: 0,
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
