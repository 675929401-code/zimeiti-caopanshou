import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { UploadValidationError, validateUploadBuffer } from "../src/lib/file-upload-security";

async function main(): Promise<void> {
const root = process.cwd();
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

const [adminPage, assetRoute, agentsRoute, autoAvatarGenerator, batchAvatarRoute, storage] = await Promise.all([
  read("src/app/admin/page.tsx"),
  read("src/app/api/admin/agents/assets/route.ts"),
  read("src/app/api/admin/agents/route.ts"),
  read("src/lib/auto-avatar/generator.ts"),
  read("src/app/api/admin/agents/batch-avatar/route.ts"),
  read("src/lib/storage.ts"),
]);

assert.match(adminPage, /handleAddCoverUpload/u, "新增智能体必须支持背景图上传");
assert.match(adminPage, /handleEditCoverUpload/u, "编辑智能体必须支持背景图替换");
assert.match(adminPage, /setAddAgentCoverUrl\(""\)/u, "新增背景图必须支持清除");
assert.match(adminPage, /cover_url: ""/u, "编辑背景图必须支持清除");
assert.ok(
  (adminPage.match(/accept="image\/png,image\/jpeg,image\/webp"/gu) || []).length >= 4,
  "新增/编辑头像和背景图必须统一限制为 PNG/JPEG/WebP",
);
assert.doesNotMatch(
  adminPage.slice(adminPage.indexOf("{/* 应用图标 + App背景图 */}"), adminPage.indexOf("{/* 底部操作按钮 */}")),
  /填写(?:图标|背景图)URL/u,
  "新增表单不应继续接受图片 URL",
);
assert.match(adminPage, /5 \* 1024 \* 1024/u, "浏览器端必须统一 5MB 门禁");
assert.match(adminPage, /handleCancelAddAgent[\s\S]*discardPendingAgentImage/u, "取消新增必须回收待提交图片");
assert.match(adminPage, /handleCancelEdit[\s\S]*discardPendingAgentImage/u, "取消编辑必须回收待提交图片");
assert.ok(
  (adminPage.match(/if \(pendingAddAvatarKey\) void discardPendingAgentImage\(pendingAddAvatarKey\)/gu) || []).length >= 2,
  "新增表单改选候选头像时必须回收待提交人工头像",
);
assert.ok(
  (adminPage.match(/if \(pendingEditAvatarKey\) void discardPendingAgentImage\(pendingEditAvatarKey\)/gu) || []).length >= 2,
  "编辑表单改选候选头像时必须回收待提交人工头像",
);
assert.match(adminPage, /obsoleteKeys\.forEach\(\(key\) => void discardPendingAgentImage\(key\)\)/u, "替换保存后必须清理旧图片");
assert.ok((adminPage.match(/previousPending[\s\S]{0,300}discardPendingAgentImage/gu) || []).length >= 4, "连续替换必须清理前一张待提交图片");

for (const required of [
  'authorizeAdminCapability(request, "agents.manage"',
  "requireStepUp: true",
  'new Set(["image/png", "image/jpeg", "image/webp"])',
  "validateUploadBuffer(original",
  "sharp(source",
  "requireOwnershipRecord: true",
  "prefix: `agent-images/${purpose}/`",
  "storageManager.head(input.key, input.provider)",
  "storageManager.read(input.key, input.provider)",
  "assetId: owned.id",
  "deletedAssetId: owned.id",
  "export async function PUT(request: NextRequest)",
  "sweepOwnedOrphans",
  "storage_key",
  '.eq("avatar", key)',
  '.eq("cover_url", key)',
]) {
  assert.ok(assetRoute.includes(required), `上传 API 缺少合同：${required}`);
}

assert.match(agentsRoute, /AGENT_IMAGE_TRANSFER_FAILED/u, "头像外链转存失败必须 fail closed");
assert.doesNotMatch(
  agentsRoute.slice(agentsRoute.indexOf("async function storeAvatarIfNeeded"), agentsRoute.indexOf("// GET - List all agents")),
  /return avatar;\s*\n\s*\}\s*$/u,
  "头像转存失败不能回退原始外链",
);
assert.ok(
  (agentsRoute.match(/assertManagedCoverReference\(/gu) || []).length >= 3,
  "背景图新增和编辑都必须只保存平台托管 key",
);
assert.match(assetRoute, /crypto\.createHash\("sha256"\)\.update\(storedBytes\)/u, "持久化后必须回读并核对真实字节摘要");
assert.match(assetRoute, /validateUploadBuffer\(storedBytes, head\.contentType\)/u, "持久化后必须复核真实 MIME");
assert.match(assetRoute, /metadata\.width[\s\S]*expectedWidth[\s\S]*metadata\.height[\s\S]*expectedHeight/u, "持久化后必须复核真实尺寸");

assert.match(storage, /allowOriginalUrlFallback === false[\s\S]*throw new Error/u, "智能体链必须可禁止失败后回退原始外链");
assert.match(agentsRoute, /persistAvatar\(normalized, agentId, \{[\s\S]*allowOriginalUrlFallback: false,[\s\S]*ownerUserId: actorId/u, "智能体外链转存必须 fail closed 且绑定管理员归属");
assert.doesNotMatch(agentsRoute, /const forceGenerate = updateData\.auto_generate_avatar/u, "更新接口不得保留强制覆盖人工头像的自动任务入口");
assert.match(autoAvatarGenerator, /persistAvatar\(imageUrl, label, \{[\s\S]*allowOriginalUrlFallback: false/u, "自动头像存储失败不得回退供应商外链");
assert.match(autoAvatarGenerator, /select\("id,avatar"\)[\s\S]*shouldGenerateAvatar\(currentAvatar\)/u, "自动头像落库前必须重新核对当前头像");
assert.match(autoAvatarGenerator, /currentAvatar === null[\s\S]*\.is\("avatar", null\)[\s\S]*\.eq\("avatar", currentAvatar\)/u, "自动头像必须用 compare-and-set 防止竞态覆盖");
assert.ok((batchAvatarRoute.match(/MANUAL_AVATAR_PRESERVED/gu) || []).length >= 4, "单个和批量自动任务都必须保留人工头像");
assert.ok(batchAvatarRoute.indexOf("shouldGenerateAvatar(agent.avatar)") < batchAvatarRoute.indexOf("`batch-avatar-${agent.id}`"), "批量任务必须在付费生成前跳过已有头像");

const png = await sharp({
  create: { width: 256, height: 256, channels: 4, background: "#5b6cff" },
}).png().toBuffer();
const jpeg = await sharp({
  create: { width: 640, height: 640, channels: 3, background: "#faf7ef" },
}).jpeg().toBuffer();
const webp = await sharp({
  create: { width: 1600, height: 900, channels: 3, background: "#18212f" },
}).webp().toBuffer();

assert.equal(validateUploadBuffer(png, "image/png").contentType, "image/png");
assert.equal(validateUploadBuffer(jpeg, "image/jpeg").contentType, "image/jpeg");
assert.equal(validateUploadBuffer(webp, "image/webp").contentType, "image/webp");
assert.throws(
  () => validateUploadBuffer(png, "image/jpeg"),
  (error: unknown) => error instanceof UploadValidationError && error.code === "FILE_SIGNATURE_MISMATCH",
  "伪造 MIME 必须被拒绝",
);
assert.throws(
  () => validateUploadBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), "image/svg+xml"),
  (error: unknown) => error instanceof UploadValidationError && error.code === "ACTIVE_CONTENT_FORBIDDEN",
  "SVG/主动内容必须被拒绝",
);

console.log(JSON.stringify({
  passed: true,
  formats: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 5 * 1024 * 1024,
  createAndEditCoverUpload: true,
  previewReplaceClear: true,
  managedStorageKeyOnly: true,
  durableAssetReceipt: true,
  persistedObjectVerified: true,
  cancelReplaceAndOrphanRecovery: true,
  manualAvatarPriority: true,
  automaticAvatarCompareAndSet: true,
  storageFailureExternalFallback: false,
  adminCapability: "agents.manage",
  stepUpRequired: true,
  forgedMimeRejected: true,
  svgRejected: true,
  paidCalls: 0,
  productionWrites: 0,
  deployment: 0,
}, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
