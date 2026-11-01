import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// Re-check the reference-image mode after the explicit asset-schema fix (v3.1.1).
const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

const OUT_DIR = path.resolve(".codex-evidence/high-energy-v311-refmode-20261022");
const message = [
  "分段文案：", "1.【夏天带狗出门，柏油路正午能到六十度，先用手背贴地试五秒，烫就换草地。】", "",
  "分段时长：10秒版：每段3-4个镜头",
  "视频比例：16:9",
  "动画风格：皮克斯式高能3D宠物科普动画",
  "主人性别：文案优先，未指定默认女主人",
  "狗狗品种：文案优先，未指定默认柯基",
  "特殊备注：首次建立角色",
  "视觉资产模式：参考图模式",
].join("\n");

const clientRequestId = `high-energy-v311-refmode-${crypto.randomUUID()}`;
const res = await fetch(`${origin}/api/llm`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": clientRequestId },
  cache: "no-store", signal: AbortSignal.timeout(300_000),
  body: JSON.stringify({
    client_request_id: clientRequestId,
    messages: [{ role: "user", content: message }],
    agentId: "agent-1786843330392-emdjv2", agentName: "3D故事导演｜高能版",
    stream: false, maxContextRounds: 0, enable_web_search: false,
  }),
});
const payload = await res.json().catch(() => ({}));
assert.ok(res.ok, `LLM_HTTP_${res.status}`);
const content = String(payload?.choices?.[0]?.message?.content || "");
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, "raw.txt"), content, "utf8");

const m = content.match(/<!--\s*storyboard_director_output:v1\s*([\s\S]*?)-->/i);
assert.ok(m, "MACHINE_COMMENT_MISSING");
const pkg = JSON.parse(m[1]);
await fs.writeFile(path.join(OUT_DIR, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

const assets = pkg?.visual_asset_plan?.assets || [];
const refs = pkg?.segments?.[0]?.visual_asset_refs || [];
const report = {
  schemaVersion: "high_energy_v311_refmode.v1",
  checkedAt: new Date().toISOString(),
  replyCharacters: content.length,
  mode: pkg?.visual_asset_plan?.mode ?? null,
  assetCount: assets.length,
  assetFields: assets.map((a) => ({
    id: a.id ?? null,
    role: a.role ?? null,
    name: a.name ?? null,
    identityLockLength: String(a.identity_lock || "").length,
    referencePromptCount: (a.reference_prompts || []).length,
    refKinds: (a.reference_prompts || []).map((r) => r.kind),
    hasLegacyFieldNames: Boolean(a.asset_id || a.asset_type || a.description),
  })),
  segmentRefCount: refs.length,
  refsMatchAssets: refs.every((r) => assets.some((a) => a.id === r.asset_id && a.role === r.role)),
  rightsBasisInVisibleText: /权利依据/u.test(content),
  paidImageOrVideoRequests: 0,
};
await fs.writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
