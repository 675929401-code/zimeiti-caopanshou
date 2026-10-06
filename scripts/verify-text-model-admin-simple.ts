import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const dialog = source("src/components/unified-model-dialog.tsx");
const route = source("src/app/api/admin/models/route.ts");

const formStart = dialog.indexOf("const renderTextModelForm");
const formEnd = dialog.indexOf("return createPortal", formStart);
assert.ok(formStart > 0 && formEnd > formStart, "text form boundary missing");
const textForm = dialog.slice(formStart, formEnd);

for (const required of [
  "中转站接口",
  "API 基础地址",
  "API 密钥",
  "模型名称",
  "输入成本",
  "输出成本",
  "缓存成本",
  "利润率(%)",
  "上下文长度(Token)",
  "深度思考",
]) assert.ok(textForm.includes(required), `missing simplified field: ${required}`);

for (const removed of [
  "模型类型选择",
  "模型简介",
  "模型图标",
  "模型排序",
  "模型调用频率",
  "账号关联模型",
  "模型扣费类型",
  "单次扣除金额",
  "基础费用",
  "联网搜索",
  "上下文轮次",
  "调用超时时间",
  "图片解析",
  "文件解析",
  "管理员备注",
]) assert.equal(textForm.includes(removed), false, `legacy field remains visible: ${removed}`);

assert.ok(dialog.includes('value: "secure_skill"'));
assert.ok(dialog.includes('endpoint: "https://token.secure-skill.com/v1"'));
assert.ok(dialog.includes('billing_mode: form.model_type === "text" ? "token"'));
assert.ok(dialog.includes('token_billing_enabled: form.model_type === "text"'));
assert.ok(dialog.includes('saveData.cost_per_use = 0'));
assert.ok(dialog.includes('saveData.cost_price = 0'));
assert.ok(dialog.includes('saveData.enable_web_search = false'));
assert.equal(textForm.includes("/api/admin/llm-test"), false, "new-model form must not trigger a provider test");

assert.ok(route.includes("function textTokenConfigurationError"));
assert.ok(route.includes('code: "TEXT_TOKEN_CONFIGURATION_REQUIRED"'));
assert.ok(route.includes('billing_mode: "token"'));
assert.ok(route.includes("token_billing_enabled: true"));
assert.ok(route.includes("input_cost_per_million: Number(fields.input_cost_per_million)"));
assert.ok(route.includes("cached_cost_per_million: Number(fields.cached_cost_per_million)"));
assert.ok(route.includes("updateFields.billing_mode = \"token\""));
assert.ok(route.includes("updateFields.cost_per_use = 0"));

console.log(JSON.stringify({
  verifier: "text-model-admin-simple",
  passed: true,
  fields: 10,
  removedLegacyFields: 15,
  providerCalls: 0,
  databaseWrites: 0,
  paidCalls: 0,
}, null, 2));
