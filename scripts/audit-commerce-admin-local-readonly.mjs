#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const outputArgument = args.find((value) => value.startsWith("--output="));
  const outputFile = path.resolve(outputArgument?.slice("--output=".length) || ".codex-evidence/commerce-admin-local-readonly/report.json");
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_MAIN_SITE_REQUIRED");
  assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");

  const response = await fetch(`${origin}/api/admin/commerce`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok && body.ok === true, body.error || `COMMERCE_ADMIN_HTTP_${response.status}`);
  assert.equal(body.storage?.configuration, "local-acceptance", "Commerce configuration is not using the isolated local acceptance source");
  assert.equal(body.storage?.businessData, "local", "Commerce business data is not isolated in the local acceptance source");
  assert.ok(body.current?.releaseId, "No current Commerce release is loaded");

  const latestBy = (rows, field) => {
    const seen = new Set();
    return rows.filter((row) => {
      const key = String(row[field] || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const routes = latestBy(body.routes || [], "operation_id");
  const modelById = new Map((body.models || []).map((model) => [String(model.id), model]));
  const gpt56 = (body.models || []).filter((model) => model.kind === "agent" && /GPT[- ]?5\.6/iu.test(String(model.displayName || "")));
  assert.ok(gpt56.length >= 2, "GPT-5.6 primary and fallback models are not both present");
  const agentRoutes = routes.filter((route) => route.model_kind === "agent");
  const imageRoutes = routes.filter((route) => route.model_kind === "image");
  const videoRoutes = routes.filter((route) => route.model_kind === "video");
  const publishedRelease = (body.releases || []).find((release) => release.id === body.current.releaseId);
  assert.ok(publishedRelease?.is_current === true && publishedRelease?.status === "published", "Current Commerce release identity is inconsistent");
  const manifest = publishedRelease.manifest || {};
  const currentCardIds = new Set(Array.isArray(manifest.cardVersionIds) ? manifest.cardVersionIds.map(String) : []);
  const currentPromptIds = new Set(Array.isArray(manifest.promptVersionIds) ? manifest.promptVersionIds.map(String) : []);
  const currentKnowledgeIds = new Set(Array.isArray(manifest.knowledgeDocumentIds) ? manifest.knowledgeDocumentIds.map(String) : []);
  const currentRouteIds = new Set(Array.isArray(manifest.operationRouteIds) ? manifest.operationRouteIds.map(String) : []);
  const cardNames = new Map((body.cards || []).map((card) => [String(card.id), String(card.stable_key || card.id)]));
  const promptById = new Map((body.prompts || []).map((prompt) => [String(prompt.id), prompt]));
  const knowledgeById = new Map((body.knowledge || []).map((document) => [String(document.id), document]));
  const currentCards = (body.cardVersions || []).filter((card) => currentCardIds.has(String(card.id)));
  const currentRoutes = (body.routes || []).filter((route) => currentRouteIds.has(String(route.id)));
  const currentAgentRoutes = currentRoutes.filter((route) => route.model_kind === "agent");
  const currentImageRoutes = currentRoutes.filter((route) => route.model_kind === "image");
  const currentVideoRoutes = currentRoutes.filter((route) => route.model_kind === "video");
  const currentDirectors = currentCards.filter((card) => String(card.executor_type) === "director");
  const directorPromptAudit = currentDirectors.map((card) => {
    const promptId = String(card.prompt_version_id || "");
    const prompt = promptById.get(promptId);
    const content = String(prompt?.content || "").trim();
    const display = card.display && typeof card.display === "object" ? card.display : {};
    return {
      cardVersionId: String(card.id),
      stableKey: cardNames.get(String(card.card_id)) || String(card.card_id),
      name: String(display.name || cardNames.get(String(card.card_id)) || "未命名编导"),
      promptVersionId: promptId || null,
      promptKey: prompt ? String(prompt.prompt_key || "") : null,
      promptVersion: prompt ? Number(prompt.version || 0) : null,
      promptStatus: prompt ? String(prompt.status || "") : null,
      promptSource: prompt ? String(prompt.source || "") : null,
      contentCharacters: content.length,
      inCurrentRelease: Boolean(promptId && currentPromptIds.has(promptId)),
      contractTests: Array.isArray(card.test_cases) ? card.test_cases.length : 0,
      allContractTestsPassed: Array.isArray(card.test_cases) && card.test_cases.length >= 3 && card.test_cases.every((test) => test?.status === "passed"),
      knowledge: (Array.isArray(card.knowledge_document_ids) ? card.knowledge_document_ids : []).map((id) => {
        const document = knowledgeById.get(String(id));
        return {
          id: String(id),
          key: document ? String(document.knowledge_key || "") : null,
          name: document ? String(document.name || "") : null,
          version: document ? Number(document.version || 0) : null,
          enabled: document?.enabled === true,
          inCurrentRelease: currentKnowledgeIds.has(String(id)),
        };
      }),
    };
  });
  const incompleteDirectors = directorPromptAudit.filter((item) => !item.promptVersionId || !item.inCurrentRelease || item.contentCharacters < 100);
  const unresolvedKnowledgeIds = [...currentKnowledgeIds].filter((id) => !(body.knowledge || []).some((item) => String(item.id) === id));
  assert.ok(currentDirectors.length > 0, "Current Commerce release contains no director cards");
  assert.equal(incompleteDirectors.length, 0, "One or more published director cards lack a complete published prompt");
  assert.equal(unresolvedKnowledgeIds.length, 0, "Current Commerce release references missing knowledge documents");

  const routeModelAudit = currentRoutes.map((route) => {
    const primaryModelId = String(route.primary_model_id || "");
    const primary = modelById.get(primaryModelId);
    const fallbackModelIds = Array.isArray(route.fallback_model_ids) ? route.fallback_model_ids.map(String) : [];
    return {
      routeVersionId: String(route.id),
      operationId: String(route.operation_id || ""),
      label: String(route.label || route.operation_id || ""),
      modelKind: String(route.model_kind || ""),
      version: Number(route.version || 0),
      primary: primary ? {
        id: primaryModelId,
        displayName: String(primary.displayName || primaryModelId),
        publicPrice: primary.publicPrice,
        costPrice: primary.costPrice,
        billingUnit: primary.billingUnit,
        available: primary.available === true,
        verified: Boolean(primary.verifiedAt),
      } : { id: primaryModelId, missing: true },
      fallbacks: fallbackModelIds.map((id) => {
        const model = modelById.get(id);
        return model ? {
          id,
          displayName: String(model.displayName || id),
          publicPrice: model.publicPrice,
          costPrice: model.costPrice,
          billingUnit: model.billingUnit,
          available: model.available === true,
          verified: Boolean(model.verifiedAt),
        } : { id, missing: true };
      }),
      userSelectable: route.user_selectable === true,
      capabilityRequirements: route.capability_requirements || {},
    };
  });
  const unresolvedRouteModels = routeModelAudit.filter((route) => route.primary.missing || route.fallbacks.some((model) => model.missing));
  assert.equal(unresolvedRouteModels.length, 0, "Current Commerce release references models missing from the main catalog");

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    storage: body.storage,
    runtime: body.runtime,
    current: body.current,
    currentRelease: {
      id: publishedRelease.id,
      version: publishedRelease.release_version,
      status: publishedRelease.status,
      migrationBaseline: publishedRelease.validation_result?.migrationBaseline === true,
      validationOk: publishedRelease.validation_result?.ok === true,
    },
    counts: {
      cards: (body.cards || []).length,
      cardVersions: (body.cardVersions || []).length,
      prompts: (body.prompts || []).length,
      knowledge: (body.knowledge || []).length,
      routes: (body.routes || []).length,
      latestRoutes: routes.length,
      agentRoutes: agentRoutes.length,
      imageRoutes: imageRoutes.length,
      videoRoutes: videoRoutes.length,
      currentRoutes: currentRoutes.length,
      currentAgentRoutes: currentAgentRoutes.length,
      currentImageRoutes: currentImageRoutes.length,
      currentVideoRoutes: currentVideoRoutes.length,
    },
    gpt56: gpt56.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      publicPrice: model.publicPrice,
      costPrice: model.costPrice,
      billingUnit: model.billingUnit,
      available: model.available,
      verified: Boolean(model.verifiedAt),
    })),
    agentCatalog: (body.models || []).filter((model) => model.kind === "agent").map((model) => ({
      id: model.id,
      displayName: model.displayName,
      publicPrice: model.publicPrice,
      costPrice: model.costPrice,
      billingUnit: model.billingUnit,
      available: model.available,
      verified: Boolean(model.verifiedAt),
      configHash: model.configHash,
    })),
    currentRouteAudit: {
      unresolvedRouteModels,
      routes: routeModelAudit,
      agentModels: [...new Map(currentAgentRoutes.map((route) => {
        const id = String(route.primary_model_id || "");
        return [id, routeModelAudit.find((item) => item.operationId === String(route.operation_id || ""))?.primary];
      })).values()].filter(Boolean),
      imageModels: [...new Map(currentImageRoutes.map((route) => {
        const id = String(route.primary_model_id || "");
        return [id, routeModelAudit.find((item) => item.operationId === String(route.operation_id || ""))?.primary];
      })).values()].filter(Boolean),
      videoModels: [...new Map(currentVideoRoutes.map((route) => {
        const id = String(route.primary_model_id || "");
        return [id, routeModelAudit.find((item) => item.operationId === String(route.operation_id || ""))?.primary];
      })).values()].filter(Boolean),
    },
    publishedPromptAudit: {
      currentCardVersions: currentCards.length,
      currentPromptVersions: currentPromptIds.size,
      currentKnowledgeDocuments: currentKnowledgeIds.size,
      directorCards: currentDirectors.length,
      incompleteDirectors,
      unresolvedKnowledgeIds,
      directors: directorPromptAudit,
    },
    paidGenerationRequests: 0,
    providerRequests: 0,
    writes: 0,
    passed: true,
  };
  assert.doesNotMatch(JSON.stringify(report), /api_key|sk-[A-Za-z0-9]|secret:\/\//u, "Audit report contains a secret");
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
