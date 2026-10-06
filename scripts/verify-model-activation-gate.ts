import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MODEL_ACTIVATION_GATE_KEY,
  PENDING_TEXT_USER_ACCESS,
  ModelActivationGateError,
  assertOrdinaryAdminUpdateDoesNotActivate,
  assertVideoModelActivationReady,
  forceNewVideoModelPending,
  imageActivationStorageUnavailable,
  inspectVideoModelActivationReadiness,
  isActivationGatedImageId,
  isActivationGatedTextUserAccess,
  issueVideoModelAcceptanceEvidence,
  newPendingImageModelId,
  persistVideoModelAcceptanceEvidence,
  preserveVideoAcceptanceForWorkspaceSurfaceUpdate,
  preservePersistedVideoActivationGate,
  textActivationStorageUnavailable,
  type VideoActivationBinding,
} from "../src/lib/model-activation-gate";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function fixtureBinding(): VideoActivationBinding {
  const pending = forceNewVideoModelPending({
    id: "pending-video-fixture",
    model_name: "fixture-video-v1",
    provider: "fixture-provider",
    protocol_type: "openai_compatible",
    api_endpoint: "https://fixture.invalid/v1/video/generations",
    api_key: "fixture-provider-key-for-tests",
    api_protocol_config: {
      resolution_options: ["720p"],
      persist_result_immediately: true,
      [MODEL_ACTIVATION_GATE_KEY]: {
        schema: "forged-client-gate",
        state: "evidence_ready",
      },
    },
    is_active: true,
    is_hidden: false,
  });
  assert.equal(pending.is_active, true);
  assert.equal(pending.is_hidden, false);
  assert.equal(
    (pending.api_protocol_config[MODEL_ACTIVATION_GATE_KEY] as Record<string, unknown>).state,
    "pending",
  );
  return pending;
}

function verifyPureGate(): void {
  const pending = fixtureBinding();
  assert.doesNotThrow(
    () => assertOrdinaryAdminUpdateDoesNotActivate(
      "video",
      pending.id,
      pending.api_protocol_config,
      { is_active: true },
    ),
  );
  assert.doesNotThrow(() => assertOrdinaryAdminUpdateDoesNotActivate(
    "video",
    "legacy-video",
    { resolution_options: ["720p"] },
    { is_active: true, is_hidden: false },
  ));

  const preserved = preservePersistedVideoActivationGate(
    pending.api_protocol_config,
    {
      resolution_options: ["1080p"],
      [MODEL_ACTIVATION_GATE_KEY]: { schema: "client-forgery", state: "accepted" },
    },
  );
  assert.equal(
    (preserved[MODEL_ACTIVATION_GATE_KEY] as Record<string, unknown>).state,
    "pending",
    "ordinary admin updates must preserve the server-persisted gate",
  );
  assert.deepEqual(preserved.resolution_options, ["1080p"]);

  assert.doesNotThrow(() => assertOrdinaryAdminUpdateDoesNotActivate("video", pending.id, pending.api_protocol_config, { is_hidden: false }));
  assert.doesNotThrow(() => assertOrdinaryAdminUpdateDoesNotActivate("image", newPendingImageModelId(), null, { is_hidden: false }));
  assert.deepEqual(inspectVideoModelActivationReadiness(pending), {
    gated: true,
    ready: false,
    reason: "acceptance_evidence_not_persisted",
  });
  const checkedAt = new Date(Date.now() - 1_000).toISOString();
  const evidence = issueVideoModelAcceptanceEvidence(pending, {
    secretResolution: { evidenceRef: "secret:fixture-01", checkedAt },
    endpointConnectivity: { evidenceRef: "endpoint:fixture-01", checkedAt },
    protocolFixture: { evidenceRef: "protocol:fixture-01", checkedAt },
    canary: { evidenceRef: "canary:fixture-01", checkedAt },
    resultPersistence: { evidenceRef: "persist:fixture-01", checkedAt },
  }, {
    evidenceId: "acceptance:fixture-01",
    issuedAt: checkedAt,
    issuedBy: "server-runner-01",
  });
  const evidenceReady = {
    ...pending,
    api_protocol_config: persistVideoModelAcceptanceEvidence(pending.api_protocol_config, evidence),
  };
  const readiness = inspectVideoModelActivationReadiness(evidenceReady);
  assert.equal(readiness.ready, true);
  assert.equal(assertVideoModelActivationReady(evidenceReady), "acceptance:fixture-01");

  const workspaceConfig = {
    ...(evidenceReady.api_protocol_config as Record<string, unknown>),
    workspace_surfaces: ["ai-video", "storyboard", "free-canvas"],
  };
  const workspaceRebound = {
    ...evidenceReady,
    api_protocol_config: preserveVideoAcceptanceForWorkspaceSurfaceUpdate(evidenceReady, workspaceConfig),
  };
  assert.equal(inspectVideoModelActivationReadiness(workspaceRebound).ready, true,
    "workspace placement changes must not invalidate provider acceptance");
  assert.throws(() => preserveVideoAcceptanceForWorkspaceSurfaceUpdate(evidenceReady, {
    ...workspaceConfig,
    resolution_options: ["1080p"],
  }), /只有工作台展示范围变更/u, "provider contract changes must not reuse acceptance");

  const staleBinding = { ...evidenceReady, api_endpoint: "https://changed.invalid/v1/video/generations" };
  assert.equal(inspectVideoModelActivationReadiness(staleBinding).reason, "acceptance_evidence_binding_stale");

  const waivedCanary = structuredClone(evidenceReady);
  const waivedGate = waivedCanary.api_protocol_config[MODEL_ACTIVATION_GATE_KEY] as Record<string, unknown>;
  const waivedEvidence = waivedGate.evidence as Record<string, unknown>;
  const waivedChecks = waivedEvidence.checks as Record<string, Record<string, unknown>>;
  waivedChecks.canary.status = "waived";
  assert.equal(inspectVideoModelActivationReadiness(waivedCanary).ready, false, "canary waiver must never activate");

  const missingPersistence = structuredClone(evidenceReady);
  const persistenceGate = missingPersistence.api_protocol_config[MODEL_ACTIVATION_GATE_KEY] as Record<string, unknown>;
  const persistenceEvidence = persistenceGate.evidence as Record<string, unknown>;
  const persistenceChecks = persistenceEvidence.checks as Record<string, Record<string, unknown>>;
  persistenceChecks.result_persistence.status = "failed";
  assert.equal(inspectVideoModelActivationReadiness(missingPersistence).ready, false);

  const pendingImageId = newPendingImageModelId(1_787_300_000_000, "fixtureentropy01");
  assert.equal(isActivationGatedImageId(pendingImageId), true);
  assert.doesNotThrow(
    () => assertOrdinaryAdminUpdateDoesNotActivate("image", pendingImageId, null, { is_active: true }),
  );
  assert.doesNotThrow(() => assertOrdinaryAdminUpdateDoesNotActivate(
    "image",
    "legacy-cover-model",
    null,
    { is_active: true, is_hidden: false },
  ));
  assert.equal(isActivationGatedTextUserAccess(PENDING_TEXT_USER_ACCESS), true);
  assert.doesNotThrow(
    () => assertOrdinaryAdminUpdateDoesNotActivate(
      "text",
      "pending-text",
      PENDING_TEXT_USER_ACCESS,
      { is_active: true },
    ),
  );
  assert.doesNotThrow(() => assertOrdinaryAdminUpdateDoesNotActivate(
    "text",
    "legacy-text",
    "available",
    { is_active: true, is_hidden: false },
  ));
  assert.throws(imageActivationStorageUnavailable, /没有可安全持久化/u);
  assert.throws(textActivationStorageUnavailable, /没有可安全持久化/u);
}

function verifyRouteWiring(): void {
  const unified = source("src/app/api/admin/models/route.ts");
  const videos = source("src/app/api/admin/video-models/route.ts");
  const covers = source("src/app/api/admin/cover-models/route.ts");
  const coverItem = source("src/app/api/admin/cover-models/[id]/route.ts");
  const videoTest = source("src/app/api/admin/video-test/route.ts");
  const activate = source("src/app/api/admin/models/activate/route.ts");
  const publicVideos = source("src/app/api/video/models/route.ts");
  const publicImages = source("src/app/api/cover-models/route.ts");
  const publicText = source("src/app/api/chat-models/route.ts");
  const visibilityInvariantMigration = source("supabase/migrations/20260923183000_model_resource_visibility_invariant.sql");

  assert.match(unified, /const id = newPendingImageModelId\(\)/u);
  assert.match(unified, /const pendingVideoRecord = forceNewVideoModelPending/u);
  assert.match(unified, /user_access: PENDING_TEXT_USER_ACCESS[\s\S]*is_active: false[\s\S]*is_hidden: false/u);
  assert.doesNotMatch(unified, /activation_required: true/u);
  assert.ok((unified.match(/assertOrdinaryAdminUpdateDoesNotActivate/gu) || []).length >= 1);
  assert.match(unified, /pendingImageConfigurationUpdate\(currentDrawingModel, updateFields\)/u);
  assert.match(unified, /prepareVideoModelBindingUpdate\(\{ id, \.\.\.currentVideoModel \}, updateFields\)/u);
  assert.ok((videos.match(/prepareVideoModelBindingUpdate\(/gu) || []).length >= 2);
  assert.doesNotMatch(unified, /\.neq\("is_hidden", true\)/u, "admin must still list pending hidden models");
  assert.match(videos, /writeRecord = forceNewVideoModelPending\(record\)/u);
  assert.match(videos, /preservePersistedVideoActivationGate/u);
  assert.match(covers, /const id = newPendingImageModelId\(\)/u);
  assert.match(covers, /is_active: true[\s\S]*is_hidden: false/u);
  assert.match(coverItem, /pendingImageConfigurationUpdate\(current.data, updateFields\)/u);
  assert.doesNotMatch(videoTest, /\.update\(\{\s*is_hidden:\s*false/u);
  assert.match(videoTest, /result\.activationRequired = model\.is_active !== true/u);
  const fundingClassification = videoTest.indexOf("if (isQuotaError(text))");
  const credentialClassification = videoTest.indexOf("if (resp.status === 401 || resp.status === 403)");
  assert.ok(fundingClassification > 0 && credentialClassification > fundingClassification,
    "HTTP 401/403 provider funding bodies must be classified before credential rejection");
  assert.match(activate, /assertPublishedModelPoolEntry/u);
  assert.match(activate, /assertVideoModelActivationReady\(model\)/u);
  assert.match(activate, /\.update\(\{ is_active: true \}\)/u);
  assert.doesNotMatch(activate, /\.update\(\{[^}]*is_hidden/u);
  assert.match(activate, /\.update\(\{ is_active: true, user_access: "available", updated_at: activationTimestamp \}\)[\s\S]*\.eq\("updated_at", model\.updated_at\)/u,
    "text activation must compare-and-set the exact validated row version");
  assert.doesNotMatch(activate, /\.eq\("is_active", false\)/u,
    "active-but-pending models must remain repairable after a catalog publication");
  assert.match(activate, /IMAGE_VALIDATION_PUBLICATION_REQUIRED/u);
  assert.doesNotMatch(activate, /\.from\("cover_models"\)[\s\S]*\.update/u);
  assert.match(activate, /\.from\("llm_models"\)[\s\S]*user_access: "available"/u);
  assert.match(activate, /assertFreshLlmModelValidationEvidence/u);
  assert.match(activate, /llm_model_validation_evidence/u);
  assert.doesNotMatch(activate, /body\.(?:evidence|acceptance_evidence|checks)/u);
  assert.match(publicVideos, /configuredForSubmission[\s\S]*m\.is_active === true && configuredForSubmission && priceReady/u);
  assert.doesNotMatch(publicVideos, /baseAvailable\s*=\s*[\s\S]{0,180}activation\.ready/u);
  assert.doesNotMatch(publicVideos, /baseAvailable\s*=\s*[\s\S]{0,220}healthDecision\.blocksProduction/u);
  assert.match(publicVideos, /\.eq\("is_hidden", false\)/u);
  assert.match(publicImages, /readImagePublicationStates\(dbClient\)/u);
  assert.match(publicImages, /\.eq\("is_hidden", false\)/u,
    "public image catalog must read the visible resource pool");
  assert.match(publicImages, /available: priceReady && publicationState\?\.available === true/u,
    "public image DTO must still expose the independent submission gate");
  assert.match(publicImages, /model\.is_active !== true[\s\S]*disabledImageModelMessage\(model\)/u,
    "disabled image models must expose a precise public reason");
  assert.match(visibilityInvariantMigration, /provider IS DISTINCT FROM 'retired_configuration'/u);
  for (const table of ["cover_models", "llm_models", "video_models"]) {
    assert.match(visibilityInvariantMigration, new RegExp(`BEFORE INSERT OR UPDATE ON public\\.${table}`, "u"));
  }
  assert.match(publicText, /\.eq\("is_active", true\)/u);
  assert.match(publicText, /(?:\.eq|\.neq)\("is_hidden", (?:false|true)\)/u);
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network forbidden in verify-model-activation-gate");
  };
  try {
    verifyPureGate();
    verifyRouteWiring();
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("PASS verify-model-activation-gate (zero network, zero database writes)");
}

void main();
