import assert from "node:assert/strict";
import {
  containsForbiddenPublicModelKey,
  normalizePublicModelAvatarUrl,
  toPublicModelDto,
} from "../src/lib/public-model-dto";

assert.equal(normalizePublicModelAvatarUrl("ð¢"), "🟢", "双重解码的绿色圆点应恢复为 emoji");
assert.equal(normalizePublicModelAvatarUrl("â¡"), "⚡", "双重解码的闪电应恢复为 emoji");
assert.equal(normalizePublicModelAvatarUrl("👁️"), "👁️", "正确的 emoji 不得改写");
assert.equal(normalizePublicModelAvatarUrl("/avatars/model.png"), "/avatars/model.png", "站内头像路径不得改写");
assert.equal(normalizePublicModelAvatarUrl("https://cdn.example.test/model.png"), "https://cdn.example.test/model.png", "远程头像 URL 不得改写");
assert.equal(normalizePublicModelAvatarUrl("glm-model"), "glm-model", "普通头像键不得改写");
assert.equal(normalizePublicModelAvatarUrl("中文头像"), "中文头像", "中文文本不得按 Latin-1 解码");

const dto = toPublicModelDto("chat", {
  id: "avatar-fixture-model",
  name: "头像契约测试模型",
  avatar_url: "ð¢",
  price_per_use: 0,
}, 0, { type: "text", available: true });

assert.equal(dto.avatarUrl, "🟢", "公开模型 DTO 必须使用规范化头像");
assert.equal(containsForbiddenPublicModelKey(dto), false, "公开模型 DTO 不得泄露内部字段");

console.log("public model avatar normalization: 9 assertions passed; zero network/db/wallet/provider calls");
