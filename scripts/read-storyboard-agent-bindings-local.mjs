#!/usr/bin/env node
import assert from "node:assert/strict";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

const targetIds = new Set([
  "agent-1786633444187-594spj",
  "agent-1786843330392-emdjv2",
]);
const targetNames = new Set(["3D故事导演｜电影叙事", "3D故事导演｜高能版"]);

async function read(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(stepUpToken ? { "x-admin-step-up": stepUpToken } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}`);
  return body;
}

const [admin, bots, chat] = await Promise.all([
  read("/api/admin/agents?include_internal=1&include_configuration=1"),
  read("/api/bots?shape=agents"),
  read("/api/chat-models"),
]);

function project(rows, label) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => targetIds.has(String(row?.id || "")) || targetNames.has(String(row?.name || "")))
    .map((row) => ({
      source: label,
      id: String(row.id || ""),
      name: String(row.name || ""),
      modelId: row.model_id == null ? null : String(row.model_id),
      model: String(row.model || ""),
      active: row.is_active !== false,
      userAccess: row.user_access == null ? null : String(row.user_access),
    }));
}

const adminRows = project(admin.agents, "admin");
const botRows = project(bots.agents, "bots");
const chatRows = (Array.isArray(chat.models) ? chat.models : [])
  .filter((row) => ["gpt-6.1-sol", "gpt-5.6-sol"].includes(String(row?.model_name || "")))
  .map((row) => ({
    source: "chat-models",
    id: String(row.id || ""),
    modelName: String(row.model_name || ""),
    active: row.is_active === true,
    hidden: row.is_hidden === true,
    userAccess: row.user_access == null ? null : String(row.user_access),
  }));

assert.equal(adminRows.length, 2, "ADMIN_STORYBOARD_AGENT_COUNT_MISMATCH");
assert.equal(botRows.length, 2, "BOT_STORYBOARD_AGENT_COUNT_MISMATCH");
for (const row of [...adminRows, ...botRows]) {
  assert.equal(row.modelId, "76b48548-6542-4908-a9f7-10835d2528bb", `${row.source}:${row.id}:GPT61_MODEL_ID_REQUIRED`);
  assert.equal(row.model, "gpt-6.1-sol", `${row.source}:${row.id}:GPT61_MODEL_NAME_REQUIRED`);
}

console.log(JSON.stringify({
  passed: true,
  checkedAt: new Date().toISOString(),
  origin,
  bindings: [...adminRows, ...botRows],
  chatModels: chatRows,
  providerRequests: 0,
  paidGenerationRequests: 0,
}, null, 2));
