import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const [sidebar, panel] = await Promise.all([
  read("src/components/app-sidebar.tsx"),
  read("src/components/admin/WhiteLabelReadinessPanel.tsx"),
]);

assert.match(sidebar, /const publishedWechat = platformBranding\.brand\.contact\.wechat\.trim\(\)/u);
assert.match(sidebar, /publishedWechat\s*\? `微信：\$\{publishedWechat\}`\s*:\s*platformBranding\.brand\.slogan\s*\|\|\s*platformBranding\.brand\.description/u);
assert.doesNotMatch(sidebar, /\/api\/admin\/white-label/u, "侧栏不得读取后台白标草稿");
assert.match(sidebar, /usePlatformBranding\(\)/u, "侧栏应继续复用公开已发布品牌读取器");

for (const contract of [
  /brandSlogan/u,
  /brandDescription/u,
  /contact\.wechat/u,
  /contact_wechat_qr_primary/u,
  /contact_wechat_qr_secondary/u,
  /draftAssetIds/u,
  /assetIds/u,
  /upload\.set\("action", "upload-asset"\)/u,
  /write\("save-draft"\)/u,
  /write\("publish"\)/u,
]) {
  assert.match(panel, contract);
}

for (const copy of [
  "保存草稿不会公开",
  "草稿尚未发布，不会出现在公开页面",
  "发布品牌版本",
  "这不等于客户域名已经上线",
  "仍需 CNAME / 网关 / TLS",
]) {
  assert.ok(panel.includes(copy), `缺少草稿/发布边界文案：${copy}`);
}

assert.match(panel, /data-testid="white-label-brand-slogan"/u);
assert.match(panel, /data-testid="white-label-brand-description"/u);
assert.match(panel, /data-testid="white-label-wechat-qr-settings"/u);
assert.match(panel, /data-testid="white-label-publish-chain"/u);
assert.match(panel, /data-testid="white-label-publish"/u);
assert.match(panel, /URL\.createObjectURL\(file\)/u, "上传后应提供本地预览");
assert.match(panel, /delete assetIds\[purpose\]/u, "二维码应支持从草稿移除");
assert.doesNotMatch(panel, /\/api\/admin\/branding\/assets/u, "白标二维码不得复用 default 全局品牌资产入口");

console.log("white-label UI closure source verification passed");
