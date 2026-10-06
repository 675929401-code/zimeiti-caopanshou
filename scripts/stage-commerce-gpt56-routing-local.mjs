#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function latestByVersion(rows, field) {
  const latest = new Map();
  for (const row of rows) {
    const key = String(row[field] || "");
    if (!key) continue;
    const prior = latest.get(key);
    if (!prior || Number(row.version) > Number(prior.version)) latest.set(key, row);
  }
  return [...latest.values()];
}

function preferredModel(models, role) {
  const pattern = role === "primary" ? /GPT[- ]?5\.6[\s\S]*Sol/iu : /GPT[- ]?5\.6[\s\S]*Terra/iu;
  const candidates = models.filter((model) => model.kind === "agent" && model.available === true && pattern.test(String(model.displayName || "")));
  candidates.sort((left, right) => {
    const score = (model) => (/故事板|长输出/iu.test(String(model.displayName || "")) ? 0 : 100)
      + (Number(model.publicPrice) > 0 ? 10 : 0)
      + (Number(model.costPrice) > 0 ? 5 : 0);
    return score(right) - score(left) || String(left.displayName).localeCompare(String(right.displayName), "zh-CN");
  });
  assert.ok(candidates[0], `GPT-5.6 ${role} model is unavailable`);
  return candidates[0];
}

async function request(origin, token, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `${pathname} HTTP ${response.status}`);
  return payload;
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const apply = args.includes("--apply");
  const outputArgument = args.find((value) => value.startsWith("--output="));
  const outputFile = path.resolve(outputArgument?.slice("--output=".length) || ".codex-evidence/commerce-gpt56-routing-local/report.json");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_MAIN_SITE_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");

  const overview = await request(origin, token, "/api/admin/commerce");
  assert.equal(overview.storage?.configuration, "local-acceptance", "LOCAL_ACCEPTANCE_CONFIGURATION_REQUIRED");
  assert.equal(overview.storage?.businessData, "local", "LOCAL_ACCEPTANCE_BUSINESS_DATA_REQUIRED");
  const primary = preferredModel(overview.models || [], "primary");
  const fallback = preferredModel(overview.models || [], "fallback");
  assert.notEqual(primary.id, fallback.id, "GPT-5.6 primary and fallback must be distinct");

  const agentRoutes = latestByVersion(overview.routes || [], "operation_id")
    .filter((row) => row.model_kind === "agent")
    .sort((left, right) => String(left.operation_id).localeCompare(String(right.operation_id), "en"));
  assert.ok(agentRoutes.length > 0, "No Commerce Agent routes found");

  const pending = agentRoutes.filter((route) => {
    const fallbacks = Array.isArray(route.fallback_model_ids) ? route.fallback_model_ids.map(String) : [];
    return String(route.primary_model_id || "") !== primary.id || fallbacks.length !== 1 || fallbacks[0] !== fallback.id;
  });
  const written = [];
  if (apply) {
    for (const route of pending) {
      const saved = await request(origin, token, "/api/admin/commerce/routes", {
        operationId: String(route.operation_id),
        label: String(route.label || route.operation_id),
        modelKind: "agent",
        primaryModelId: primary.id,
        fallbackModelIds: [fallback.id],
        capabilityRequirements: route.capability_requirements && typeof route.capability_requirements === "object" ? route.capability_requirements : {},
        userSelectable: false,
        changeNote: "本地验收草稿：带货 Agent 对话与编导统一采用 GPT-5.6 Sol，Terra 作为候补；未发布。",
      });
      written.push({ operationId: String(route.operation_id), version: Number(saved.version?.version || 0) });
    }
  }

  const priceReady = (model) => Number(model.publicPrice) > 0 && Number(model.costPrice) > 0;
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    mode: apply ? "local-draft-write" : "dry-run",
    primary: { id: primary.id, displayName: primary.displayName, priceReady: priceReady(primary) },
    fallback: { id: fallback.id, displayName: fallback.displayName, priceReady: priceReady(fallback) },
    agentRouteCount: agentRoutes.length,
    pendingBeforeRun: pending.length,
    written,
    currentReleaseId: overview.current?.releaseId || null,
    currentReleaseUnchanged: true,
    publicationBlockedBy: [
      ...(!priceReady(primary) ? ["GPT-5.6 Sol 固定售价或成本未配置"] : []),
      ...(!priceReady(fallback) ? ["GPT-5.6 Terra 固定售价或成本未配置"] : []),
      "草稿路由尚未完成真实 canary 与发布校验",
    ],
    paidGenerationRequests: 0,
    providerRequests: 0,
    passed: true,
  };
  assert.doesNotMatch(JSON.stringify(report), /api[_-]?key|sk-[A-Za-z0-9]|secret:\/\//iu, "Report contains a secret");
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
