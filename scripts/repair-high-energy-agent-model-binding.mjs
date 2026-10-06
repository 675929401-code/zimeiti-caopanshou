#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const execute = process.argv.includes("--execute");
const agentId = "agent-1786843330392-emdjv2";
const expectedAgentName = "3D故事导演｜高能版";
const modelId = "ca7d18b2-198c-4b78-8a95-0228a722436e";
const backupDir = path.resolve(".codex-backups/agent-model-binding-20260923");

assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002"].includes(origin), "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function readJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${new URL(url).pathname} failed with ${response.status}: ${body?.error || "unknown error"}`);
  return body;
}

const adminAgents = await readJson(`${origin}/api/admin/agents`, { headers });
const adminModels = await readJson(`${origin}/api/admin/models`, { headers });
const before = (adminAgents.agents || []).find((agent) => agent.id === agentId);
const targetModel = (adminModels.models || []).find((model) => model.id === modelId);
assert.ok(before, "TARGET_AGENT_NOT_FOUND");
assert.equal(before.name, expectedAgentName, "TARGET_AGENT_IDENTITY_MISMATCH");
assert.ok(targetModel, "TARGET_MODEL_NOT_FOUND");
assert.equal(targetModel.model_type, "text", "TARGET_MODEL_MUST_BE_TEXT_CHAT");

const plan = {
  origin,
  execute,
  agent: { id: before.id, name: before.name, source: before.source, model: before.model, model_id: before.model_id },
  targetModel: { id: targetModel.id, name: targetModel.name, model: targetModel.model, is_active: targetModel.is_active },
};

if (!execute) {
  console.log(JSON.stringify({ mode: "plan", ...plan }, null, 2));
  process.exit(0);
}

await fs.mkdir(backupDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const beforePath = path.join(backupDir, `${runId}.before.json`);
await fs.writeFile(beforePath, `${JSON.stringify({ capturedAt: new Date().toISOString(), agent: before, targetModel }, null, 2)}\n`, { flag: "wx" });

const update = await readJson(`${origin}/api/admin/agents`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ agentId, model_id: modelId }),
});
assert.equal(update.agent?.id, agentId, "UPDATED_AGENT_ID_MISMATCH");
assert.equal(update.agent?.model_id, modelId, "UPDATED_MODEL_BINDING_MISMATCH");

const publicAgents = await readJson(`${origin}/api/bots?shape=agents`, { headers: { Authorization: `Bearer ${token}` } });
const publicAgent = (publicAgents.agents || []).find((agent) => agent.id === agentId);
assert.ok(publicAgent, "PUBLIC_AGENT_READBACK_MISSING");
assert.equal(publicAgent.model_id, modelId, "PUBLIC_AGENT_MODEL_ID_MISMATCH");
assert.ok(publicAgent.model_public_id, "PUBLIC_AGENT_MODEL_ID_NOT_EXPOSED");

const chatCatalog = await readJson(`${origin}/api/chat-models`, { headers: { Authorization: `Bearer ${token}` } });
assert.ok((chatCatalog.models || []).some((model) => model.id === publicAgent.model_public_id), "BOUND_MODEL_NOT_IN_CHAT_CATALOG");

const readback = {
  repairedAt: new Date().toISOString(),
  agent: {
    id: publicAgent.id,
    name: publicAgent.name,
    source: publicAgent.source,
    model: publicAgent.model,
    model_id: publicAgent.model_id,
    model_public_id: publicAgent.model_public_id,
  },
  chatCatalogCount: (chatCatalog.models || []).length,
  backup: path.relative(process.cwd(), beforePath),
  paidGenerationRequests: 0,
};
await fs.writeFile(path.join(backupDir, `${runId}.readback.json`), `${JSON.stringify(readback, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ success: true, ...readback }, null, 2));
