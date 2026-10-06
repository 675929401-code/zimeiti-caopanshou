#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const execute = process.argv.includes("--execute");

function channelFromName(value) {
  return String(value || "").match(/渠道\s*([A-Z])/iu)?.[1]?.toUpperCase() || "";
}

function publicDisplayName(value) {
  return String(value || "").replace(/\s*渠道\s*[A-Z]\b/giu, "").replace(/\s{2,}/gu, " ").trim();
}

async function json(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(150_000),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function probe(candidate) {
  const clientRequestId = `llm_${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const { response, payload } = await json(`${origin}/api/llm`, {
    method: "POST",
    headers: { "Idempotency-Key": clientRequestId },
    body: JSON.stringify({
      client_request_id: clientRequestId,
      messages: [{ role: "user", content: "只回复这六个字，不要解释，不要标点：文案链路通过" }],
      modelId: candidate.publicId,
      model_overridden: true,
      stream: false,
      agentId: "__free_chat__",
      agentName: "Claude 4.6 渠道验收",
      conversationId: `conv_${crypto.randomUUID()}`,
      deepThinkingType: 0,
      deepThinkingOverridden: true,
      enableWebSearch: false,
      enableWebSearchOverridden: true,
      maxReplyTokens: 64,
      timeout: 120,
    }),
  });
  const output = String(payload?.choices?.[0]?.message?.content || payload?.content || "").trim();
  return {
    id: candidate.id,
    publicId: candidate.publicId,
    name: candidate.name,
    channel: candidate.channel,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: response.ok,
    instructionPassed: output.replace(/[\s，。！？,.!?]/gu, "").includes("文案链路通过"),
    outputChars: output.length,
    errorCode: String(payload?.code || ""),
    error: String(payload?.error || "").slice(0, 240),
  };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "real local main-site origin is required");
  assert.ok(token, "verified local administrator token is required");

  const [{ response: identityResponse, payload: identity }, { response: modelsResponse, payload: adminModels }, publicResponse] = await Promise.all([
    json(`${origin}/api/auth/me`),
    json(`${origin}/api/admin/models`),
    fetch(`${origin}/api/chat-models`, { cache: "no-store", signal: AbortSignal.timeout(15_000) }),
  ]);
  const publicModels = await publicResponse.json();
  assert.ok(identityResponse.ok && identity.user?.role === "admin", "administrator identity verification failed");
  assert.ok(modelsResponse.ok && Array.isArray(adminModels.models), "administrator model catalog unavailable");
  assert.ok(publicResponse.ok && Array.isArray(publicModels.models), "public chat model catalog unavailable");

  const candidates = adminModels.models
    .filter((model) => model.model_type === "text" && String(model.model_name).toLowerCase() === "claude-sonnet-4-6")
    .map((model) => {
      const channel = channelFromName(model.name);
      const expectedDisplayName = publicDisplayName(model.name);
      const published = publicModels.models.find((item) => String(item.variantLabel || "").toUpperCase() === channel
        && String(item.displayName || "").toLowerCase() === expectedDisplayName.toLowerCase());
      return {
        id: String(model.id),
        name: String(model.name),
        channel,
        publicId: String(published?.id || ""),
        active: model.is_active !== false,
        hidden: model.is_hidden === true,
        userAccess: String(model.user_access || ""),
        credentialConfigured: model.api_key_configured === true,
        endpointHost: (() => { try { return new URL(String(model.api_endpoint || model.proxy_url || "")).host; } catch { return ""; } })(),
        published: Boolean(published?.id),
      };
    })
    .sort((a, b) => a.channel.localeCompare(b.channel));

  assert.ok(candidates.length > 0, "no Claude 4.6 candidate exists in the real model pool");
  const eligible = candidates.filter((item) => item.active && !item.hidden && item.userAccess !== "hidden" && item.credentialConfigured && item.publicId);
  const channelCandidates = [];
  for (const item of eligible.sort((a, b) => Number(/\bMax\b/iu.test(a.name)) - Number(/\bMax\b/iu.test(b.name)))) {
    if (!channelCandidates.some((candidate) => candidate.channel === item.channel)) channelCandidates.push(item);
  }
  const results = execute ? await Promise.all(channelCandidates.map(probe)) : [];
  const passed = results.filter((item) => item.upstreamOk && item.instructionPassed).sort((a, b) => a.elapsedMs - b.elapsedMs);
  const selected = passed[0] || null;
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    mode: execute ? "single-real-call-per-channel" : "inspect-only",
    realProviderCalls: results.length,
    automaticRetries: 0,
    candidates,
    results,
    selected: selected ? { id: selected.id, name: selected.name, channel: selected.channel, elapsedMs: selected.elapsedMs } : null,
  };
  const outDir = path.resolve(".codex-evidence/claude46-channel-selection");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, execute ? `live-${Date.now()}.json` : "inspect.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, output }, null, 2));
  if (execute && !selected) process.exitCode = 2;
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("/verify-claude46-channel-selection-local.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
