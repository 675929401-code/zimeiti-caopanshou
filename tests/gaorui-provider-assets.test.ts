import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GaoruiProviderAssetError,
  gaoruiCredentialBindingFingerprint,
  prepareGaoruiPersonAsset,
  type GaoruiAssetDependencies,
  type PrepareGaoruiPersonAssetInput,
} from "../src/lib/server/gaorui-provider-assets";
import { assertGaoruiTrustedPersonAsset, type GaoruiTrustedPersonAsset } from "../src/lib/gaorui-provider-asset-contract";
import { readGaoruiPersonAssetAdmission, GAORUI_PERSON_ASSET_FEE_SCHEMA, type GaoruiAssetPreparationAuthorization } from "../src/lib/gaorui-person-asset-admission";
import { prepareGaoruiPersonVideoExecution } from "../src/lib/server/gaorui-person-video-execution";
import { gaoruiSeedanceNativeBody } from "../src/lib/gaorui-seedance-native-contract";
import type { VideoModelConfig } from "../src/lib/video-adapter";
import { buildVideoTaskIdentity } from "../src/lib/video-terminal-finalizer";

type Row = Record<string, unknown>;
const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const OWNED = "20000000-0000-4000-8000-000000000001";
const OPERATION = "30000000-0000-4000-8000-000000000001";
const AUDIO = "20000000-0000-4000-8000-000000000002";
const TASK = buildVideoTaskIdentity(USER, "gaorui-owned-asset-fixture").taskIdInternal;
const officialReady = () => ({ object: "asset", asset_id: "asset_fixture", asset_url: "Asset://asset_fixture",
  asset_type: "Image", status: "ready", model: "seedance-2.0-fast", visibility: "private",
  content: { type: "image_url", role: "reference_image", subject_type: "person", status: "ready",
    image_url: { url: "Asset://asset_fixture", asset_id: "asset_fixture", status: "ready" } } });

function modelFor(input: PrepareGaoruiPersonAssetInput): VideoModelConfig {
  return { id: input.modelId, name: "fixture", provider: "gaorui", api_endpoint: input.endpoint, api_key: input.secret,
    protocol_type: "gaorui_video", price_per_use: 1, duration_seconds: 4, supports_image_input: true, model_name: input.modelName,
    api_protocol_config: { workspace_surfaces: ["digital-human"] } } as VideoModelConfig;
}
function feeConfig(input: PrepareGaoruiPersonAssetInput): Row {
  const now = Date.now();
  return { schema: GAORUI_PERSON_ASSET_FEE_SCHEMA, enabled: true, providerOrigin: "https://gaorui.cc",
    modelId: input.modelId, modelName: input.modelName, credentialBindingFingerprint: input.credentialBindingFingerprint,
    verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
    evidenceRef: "fixture:verified-zero-fee", authorizationId: "fixture-authorization", feeCny: 0, maxChargeCny: 0 };
}
function authorize(input: PrepareGaoruiPersonAssetInput) {
  const model = modelFor(input);
  const admission = readGaoruiPersonAssetAdmission({ ...model, api_protocol_config: { ...model.api_protocol_config,
    gaorui_person_asset_fee_authorization: feeConfig(input) } });
  assert.equal(admission.ready, true);
  input.authorization = admission.authorization!;
}

function fixture() {
  const input: PrepareGaoruiPersonAssetInput = {
    userId: USER, ownedAssetId: OWNED, modelId: "model-fixture", modelName: "seedance-2.0-fast",
    endpoint: "https://gaorui.cc/v1/videos", secret: "ram-only-fixture-credential",
    credentialBindingFingerprint: "",
    authorization: undefined as unknown as GaoruiAssetPreparationAuthorization,
  };
  input.credentialBindingFingerprint = gaoruiCredentialBindingFingerprint(input);
  authorize(input);
  const state = {
    bytes: Buffer.from("same-sized-owned-object"),
    row: { id: OWNED, user_id: USER, file_category: "image", source: "digital-human-input", storage_provider: "tencent_cos",
      storage_key: "digital-human-inputs/image/owned.png", content_type: "image/png", file_size: 23, created_at: "2026-10-30T00:00:00Z", meta: {} } as Row | null,
    operations: new Map<string, Row>(), posts: 0, signedKeys: [] as string[], bodies: [] as Row[],
    audio: { id: AUDIO, user_id: USER, file_category: "audio", source: "digital-human-input", storage_provider: "tencent_cos",
      storage_key: "digital-human-inputs/audio/owned.wav", content_type: "audio/wav", file_size: 20, meta: {} } as Row,
    task: { id: TASK, user_id: USER, provider_asset_preparation: null } as Row,
    requireTaskLinkBeforePost: false, failTaskWrite: false,
    failSettle: false,
    respond: async (): Promise<Response> => Response.json(officialReady()),
  };
  state.row!.file_size = state.bytes.length;
  const db = {
    from(table: string) {
      const filters: Row = {};
      let update: Row | undefined;
      const query = { select(_columns: string) { return query; },
        update(value: Row) { update = value; return query; },
        eq(key: string, value: unknown) { filters[key] = value; return query; },
        is(key: string, value: unknown) { filters[key] = value; return query; },
        async maybeSingle() {
          const selected = table === "video_tasks" ? state.task : filters.id === AUDIO ? state.audio : state.row;
          const match = selected && Object.entries(filters).every(([key, value]) =>
            (key === "provider_asset_preparation->>operation_id" ? (selected.provider_asset_preparation as Row)?.operation_id : selected[key]) === value);
          if (update && state.failTaskWrite) return { data: null, error: { code: "fixture" } };
          if (match && update) Object.assign(selected, update);
          return { data: match ? { ...selected } : null, error: null };
        } };
      return query;
    },
    async rpc(name: string, params: Row) {
      const key = String(params.p_scope_key);
      if (name === "claim_gaorui_provider_person_asset_v1") {
        let operation = state.operations.get(key);
        const claimed = !operation;
        if (!operation) {
          operation = { scope_key: key, operation_id: OPERATION, claim_token: params.p_claim_token, scope: params.p_scope, state: "submitting", result: null };
          state.operations.set(key, operation);
        }
        return { data: { ...operation, claimed }, error: null };
      }
      assert.equal(name, "settle_gaorui_provider_person_asset_v1");
      if (state.failSettle) return { data: null, error: { message: "not exposed" } };
      const operation = state.operations.get(key)!;
      assert.equal(operation.claim_token, params.p_claim_token);
      assert.equal(operation.state, "submitting");
      operation.state = params.p_state;
      operation.result = params.p_result;
      operation.error_code = params.p_error_code;
      return { data: { state: params.p_state }, error: null };
    },
  } as unknown as SupabaseClient;
  const deps: GaoruiAssetDependencies = {
    db,
    storage: {
      async readBounded(key, maxBytes, timeoutMs, provider) {
        assert.equal(key, state.row?.storage_key);
        assert.equal(maxBytes, 20 * 1024 * 1024); assert.equal(timeoutMs, 20_000); assert.equal(provider, "tencent_cos");
        return state.bytes;
      },
      async getSignedUrl(key, options, provider) {
        state.signedKeys.push(key); assert.equal(options.expireTime, 3600); assert.equal(provider, "tencent_cos");
        return `https://owned-bucket.cos.example/${key}?q-signature=ram-signature`;
      },
    },
    fetch: (async (url, init) => {
      state.posts++;
      if (state.requireTaskLinkBeforePost) {
        assert.equal((state.task.provider_asset_preparation as Row).operation_id, OPERATION);
        assert.equal((state.task.provider_asset_preparation as Row).state, "submitting");
      }
      assert.equal(url, "https://gaorui.cc/v1/assets/uploads");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Row).Authorization, `Bearer ${input.secret}`);
      state.bodies.push(JSON.parse(String(init?.body)));
      return state.respond();
    }) as typeof fetch,
  };
  return { input, state, deps };
}

async function rejectsCode(action: () => Promise<unknown>, code: string, expectedState?: string) {
  await assert.rejects(action, (error: unknown) => error instanceof GaoruiProviderAssetError
    && error.code === code && (expectedState === undefined || error.state === expectedState));
}

function assertTrusted(asset: GaoruiTrustedPersonAsset, input: PrepareGaoruiPersonAssetInput, extra: Row = {}) {
  return assertGaoruiTrustedPersonAsset(asset, { userId: input.userId, ownedAssetId: input.ownedAssetId,
    modelId: input.modelId, modelName: input.modelName, endpoint: input.endpoint,
    credentialBindingFingerprint: input.credentialBindingFingerprint, sourceUrl: asset.sourceUrl,
    nativeRole: "reference_image", ...extra });
}

test("server signs the actual owned key and creates exactly the documented person asset", async () => {
  const { input, state, deps } = fixture();
  const asset = await prepareGaoruiPersonAsset({ ...input, clientUrl: "https://unowned.example/evil.png" } as PrepareGaoruiPersonAssetInput, deps);
  assert.equal(asset.assetUrl, "asset://asset_fixture"); assert.equal(asset.ownedAssetId, OWNED);
  assert.equal(asset.assetId, "asset_fixture"); assert.equal(state.posts, 1);
  assert.deepEqual(state.bodies[0], { url: asset.sourceUrl, model: "seedance-2.0-fast", mode: "asset", type: "image", role: "reference_image", subject_type: "person", purpose: "person_reference" });
  assert.equal(state.bodies[0].url, "https://owned-bucket.cos.example/digital-human-inputs/image/owned.png?q-signature=ram-signature");
  assert.equal(assertTrusted(asset, input).assetUrl, asset.assetUrl);
  assert.equal(assertTrusted(asset, input, { nativeRole: "first_frame" }).assetUrl, asset.assetUrl);
  assert.equal(Object.isFrozen(asset), true);
  assert.equal(JSON.stringify([...state.operations.values()]).includes(input.secret), false);
});

test("ready mapping is reused only after ownership and content are checked again", async () => {
  const { input, state, deps } = fixture();
  const first = await prepareGaoruiPersonAsset(input, deps);
  const second = await prepareGaoruiPersonAsset(input, deps);
  assert.equal(state.posts, 1); assert.equal(first.assetId, second.assetId);
  state.row = null;
  await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE");
  assert.equal(state.posts, 1);
});

test("parallel identical scopes have a single POST and other callers remain pending", async () => {
  const { input, state, deps } = fixture();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => prepareGaoruiPersonAsset(input, deps)));
  assert.equal(state.posts, 1); assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  for (const item of results) if (item.status === "rejected") assert.equal(item.reason.code, "GAORUI_ASSET_NOT_READY");
  await prepareGaoruiPersonAsset(input, deps); assert.equal(state.posts, 1);
});

for (const [label, patch] of [
  ["another account", { user_id: OTHER }], ["audio category", { file_category: "audio" }],
  ["unapproved source", { source: "voice-generation" }], ["deleted row", { deleted_at: "2026-10-30" }],
  ["deleted metadata", { meta: { deleted: true } }], ["pending upload", { source: "digital-human-upload-pending" }],
  ["unsupported storage", { storage_provider: "local" }], ["non-image MIME", { content_type: "application/octet-stream" }],
] as const) {
  test(`rejects ${label} before an operation or POST`, async () => {
    const { input, state, deps } = fixture(); Object.assign(state.row!, patch);
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE");
    assert.equal(state.posts, 0); assert.equal(state.operations.size, 0);
  });
}

test("does not accept client provider IDs/URIs, missing budget authority, or forged credential scope", async () => {
  const { input, state, deps } = fixture();
  for (const ownedAssetId of ["asset://asset_fixture", "asset_fixture"]) {
    await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, ownedAssetId }, deps), "GAORUI_ASSET_INPUT_INVALID");
  }
  await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, authorization: undefined } as unknown as PrepareGaoruiPersonAssetInput, deps), "GAORUI_ASSET_FEE_UNVERIFIED");
  await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, credentialBindingFingerprint: "f".repeat(64) }, deps), "GAORUI_ASSET_CREDENTIAL_BINDING_INVALID");
  assert.equal(state.posts, 0);
});

test("wrong model/origin cannot create an operation", async () => {
  const { input, state, deps } = fixture();
  await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, modelName: "seedance-2.0" }, deps), "GAORUI_ASSET_INPUT_INVALID");
  for (const endpoint of ["https://gaorui.cc.attacker.example/v1", "http://gaorui.cc/v1", "https://name@gaorui.cc/v1"]) {
    await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, endpoint }, deps), "GAORUI_ASSET_ENDPOINT_INVALID");
  }
  assert.equal(state.posts, 0);
});

test("content changes and credential rotation produce different durable scopes", async () => {
  const { input, state, deps } = fixture();
  await prepareGaoruiPersonAsset(input, deps);
  state.bytes = Buffer.from("changed-owned-object!!"); state.row!.file_size = state.bytes.length;
  await prepareGaoruiPersonAsset(input, deps);
  input.secret = "rotated-ram-only-fixture";
  input.credentialBindingFingerprint = gaoruiCredentialBindingFingerprint(input);
  authorize(input);
  await prepareGaoruiPersonAsset(input, deps);
  assert.equal(state.posts, 3); assert.equal(state.operations.size, 3);
});

for (const outcome of ["network", "invalid-json", "http", "processing", "failed"] as const) {
  test(`${outcome} outcome remains durable and never re-POSTs`, async () => {
    const { input, state, deps } = fixture();
    state.respond = async () => {
      if (outcome === "network") throw new Error("sensitive upstream detail must not escape");
      if (outcome === "invalid-json") return new Response("lost response", { status: 200 });
      if (outcome === "http") return Response.json({ message: "secret-like detail" }, { status: 500 });
      return Response.json({ status: outcome, asset_task_id: "task-fixture" });
    };
    const expected = outcome === "network" || outcome === "invalid-json" ? "submission_unknown" : outcome === "http" ? "reconciliation_required" : outcome;
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), expected === "submission_unknown" ? "GAORUI_ASSET_SUBMISSION_UNKNOWN" : "GAORUI_ASSET_NOT_READY", expected);
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_NOT_READY", expected);
    assert.equal(state.posts, 1); assert.equal([...state.operations.values()][0].state, expected);
    if (outcome === "processing") assert.equal(([...state.operations.values()][0].result as Row).provider_task_id, "task-fixture");
  });
}

for (const [label, patch] of [
  ["missing status", { status: undefined }], ["wrong model", { model: "seedance-2.0" }],
  ["wrong asset type", { asset_type: "Video" }], ["public visibility", { visibility: "public" }],
  ["different ID", { asset_url: "Asset://asset_other" }], ["HTTP URL", { asset_url: "https://provider.example/asset" }],
  ["nested mismatch", { content: { type: "image_url", role: "first_frame" } }],
  ["alias mismatch", { "asset-id": "asset_other" }], ["conflicting type", { type: "video" }],
  ["different source", { source_url: "https://unowned.example/source.png" }],
  ["different purpose", { purpose: "unrelated" }],
] as const) {
  test(`ready response rejects ${label} and cannot authorize a video`, async () => {
    const { input, state, deps } = fixture();
    state.respond = async () => Response.json({ ...officialReady(), ...patch });
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_NOT_READY", "reconciliation_required");
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_NOT_READY", "reconciliation_required");
    assert.equal(state.posts, 1);
  });
}

test("failed settlement leaves its claim closed and never duplicates an unknown POST", async () => {
  const { input, state, deps } = fixture(); state.failSettle = true;
  await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_SETTLEMENT_UNAVAILABLE", "reconciliation_required");
  await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_NOT_READY", "submitting");
  assert.equal(state.posts, 1);
});

test("a deletion or same-key content change during the provider request cannot issue authority", async () => {
  for (const mutation of ["delete", "content"] as const) {
    const { input, state, deps } = fixture();
    state.respond = async () => {
      if (mutation === "delete") state.row = null;
      else state.bytes = Buffer.from("replaced-owned-object!");
      return Response.json(officialReady());
    };
    await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), mutation === "delete" ? "GAORUI_PERSON_ASSET_NOT_OWNED_IMAGE" : "GAORUI_PERSON_ASSET_CONTENT_CHANGED");
    assert.equal(state.posts, 1);
  }
});

test("opaque authority rejects serialization, changed scope, missing required scope, and other roles", async () => {
  const { input, deps } = fixture(); const asset = await prepareGaoruiPersonAsset(input, deps);
  assert.throws(() => assertTrusted({ ...asset }, input), /GAORUI_PERSON_ASSET_UNTRUSTED/u);
  assert.throws(() => assertTrusted(JSON.parse(JSON.stringify(asset)), input), /GAORUI_PERSON_ASSET_UNTRUSTED/u);
  for (const patch of [{ userId: OTHER }, { ownedAssetId: "other" }, { modelId: "other" },
    { modelName: "seedance-2.0" }, { sourceUrl: "https://unowned.example/image.png" },
    { credentialBindingFingerprint: "other" }, { userId: undefined }, { nativeRole: "last_frame" }]) {
    assert.throws(() => assertTrusted(asset, input, patch), /GAORUI_PERSON_ASSET_SCOPE_MISMATCH/u);
  }
});

test("unexpected dependency details are converted to safe error codes", async () => {
  const { input, deps } = fixture(); deps.db.from = () => { throw new Error("private credential detail"); };
  await rejectsCode(() => prepareGaoruiPersonAsset(input, deps), "GAORUI_ASSET_PREPARATION_UNAVAILABLE");
});

test("fee admission stays read-only and closed for absent, paid, expired, or wrong-scope authority", () => {
  const { input, state } = fixture(); const model = modelFor(input);
  assert.equal(readGaoruiPersonAssetAdmission({ ...model }).code, "GAORUI_ASSET_FEE_UNVERIFIED");
  const valid = feeConfig(input);
  for (const patch of [{ feeCny: 0.1, maxChargeCny: 0.1 }, { feeCny: undefined }, { enabled: false },
    { modelId: "wrong" }, { modelName: "seedance-2.0" }, { providerOrigin: "https://other.example" },
    { credentialBindingFingerprint: "invalid" }, { verifiedAt: "invalid" }, { expiresAt: "2000-01-01T00:00:00Z" },
    { evidenceRef: "" }, { authorizationId: "" }]) {
    const admission = readGaoruiPersonAssetAdmission({ ...model, api_protocol_config: { ...model.api_protocol_config,
      gaorui_person_asset_fee_authorization: { ...valid, ...patch } } });
    assert.equal(admission.required, true); assert.equal(admission.ready, false); assert.equal(admission.authorization, undefined);
  }
  assert.equal(readGaoruiPersonAssetAdmission({ ...model, model_name: "seedance-2.0" }).required, false);
  assert.equal(readGaoruiPersonAssetAdmission({ ...model, name: "plain", api_protocol_config: {} }, { surface: "video" }).required, false);
  assert.equal(state.posts, 0); assert.equal(state.operations.size, 0);
});

test("serialized fee authority cannot bypass the independent fee gate", async () => {
  const { input, state, deps } = fixture();
  await rejectsCode(() => prepareGaoruiPersonAsset({ ...input, authorization: { ...input.authorization } }, deps), "GAORUI_ASSET_FEE_UNVERIFIED");
  assert.equal(state.operations.size, 0); assert.equal(state.posts, 0);
});

function executionInput(input: PrepareGaoruiPersonAssetInput) {
  return { userId: USER, ownedPersonAssetId: OWNED, ownedAudioAssetId: AUDIO, model: modelFor(input), taskInternalId: TASK,
    originalParams: { prompt: "fixture", duration: 4, aspectRatio: "16:9", resolution: "720p",
      imageUrl: "https://original.example/person.png?old-signature=1", audioUrl: "https://original.example/audio.wav?old-signature=1" },
    authorization: input.authorization };
}

test("execution converts only runtime photo+audio to owned signed reference mode and links before asset POST", async () => {
  const { input, state, deps } = fixture(); state.requireTaskLinkBeforePost = true;
  const request = executionInput(input); const snapshot = JSON.stringify(request.originalParams);
  const execution = await prepareGaoruiPersonVideoExecution(request, deps);
  assert.equal(JSON.stringify(request.originalParams), snapshot);
  assert.equal(execution.imageUrl, undefined); assert.equal(execution.inputOwnerId, USER);
  assert.equal(execution.referenceImageUrl, execution.gaoruiTrustedPersonAssets![0].sourceUrl);
  assert.match(execution.audioUrl!, /digital-human-inputs\/audio\/owned\.wav\?q-signature=/u);
  const body = gaoruiSeedanceNativeBody(request.model, execution);
  assert.equal(JSON.stringify(body).includes("asset://asset_fixture"), true);
  assert.equal(JSON.stringify(body).includes("https://original.example"), false);
  assert.deepEqual(state.task.provider_asset_preparation, { schema: "gaorui_person_asset_preparation.v1", operation_id: OPERATION, state: "ready", asset_submission_outcome: "ready" });
  assert.equal(JSON.stringify(state.task).includes("asset://"), false);
  assert.equal(JSON.stringify(state.task).includes(input.secret), false);
});

test("execution with no fee authority stops before claim or any provider request", async () => {
  const { input, state, deps } = fixture();
  await rejectsCode(() => prepareGaoruiPersonVideoExecution({ ...executionInput(input), authorization: undefined }, deps), "GAORUI_ASSET_FEE_UNVERIFIED");
  assert.equal(state.posts, 0); assert.equal(state.operations.size, 0); assert.equal(state.task.provider_asset_preparation, null);
});

test("execution rejects stale credential authority and invalid internal task IDs before claim", async () => {
  const { input, state, deps } = fixture(); const request = executionInput(input);
  await rejectsCode(() => prepareGaoruiPersonVideoExecution({ ...request, model: { ...request.model, api_key: "rotated-fixture-key" } }, deps), "GAORUI_ASSET_FEE_SCOPE_MISMATCH");
  await rejectsCode(() => prepareGaoruiPersonVideoExecution({ ...request, taskInternalId: "40000000-0000-4000-8000-000000000001" }, deps), "GAORUI_PERSON_ASSET_EXECUTION_SCOPE_INVALID");
  assert.equal(state.posts, 0); assert.equal(state.operations.size, 0);
});

test("ready asset reuse links the new reserved video task without another asset POST", async () => {
  const { input, state, deps } = fixture();
  await prepareGaoruiPersonVideoExecution(executionInput(input), deps);
  const secondTask = buildVideoTaskIdentity(USER, "gaorui-owned-asset-second-fixture").taskIdInternal;
  state.task = { id: secondTask, user_id: USER, provider_asset_preparation: null };
  await prepareGaoruiPersonVideoExecution({ ...executionInput(input), taskInternalId: secondTask }, deps);
  assert.equal(state.posts, 1);
  assert.equal((state.task.provider_asset_preparation as Row).operation_id, OPERATION);
  assert.equal((state.task.provider_asset_preparation as Row).state, "ready");
});

test("execution checks the current audio owner and video mode before preparing any asset", async () => {
  for (const mutation of ["audio-owner", "audio-source", "invalid-duration", "extra-reference"] as const) {
    const { input, state, deps } = fixture(); const request = executionInput(input);
    if (mutation === "audio-owner") state.audio.user_id = OTHER;
    if (mutation === "audio-source") state.audio.source = "unapproved";
    if (mutation === "invalid-duration") request.originalParams.duration = 100;
    if (mutation === "extra-reference") Object.assign(request.originalParams, { referenceImageUrl: "https://extra.example/image.png" });
    await assert.rejects(() => prepareGaoruiPersonVideoExecution(request, deps), GaoruiProviderAssetError);
    assert.equal(state.posts, 0); assert.equal(state.operations.size, 0);
  }
});

test("asset unknown returns its operation ID, persists independent state, and cannot reach video submission", async () => {
  const { input, state, deps } = fixture(); state.requireTaskLinkBeforePost = true;
  state.respond = async () => { throw new Error("lost provider reply"); };
  let videoPosts = 0;
  await assert.rejects(async () => {
    await prepareGaoruiPersonVideoExecution(executionInput(input), deps);
    videoPosts++;
  }, (error: unknown) => error instanceof GaoruiProviderAssetError && error.state === "submission_unknown" && error.operationId === OPERATION);
  assert.equal(state.posts, 1); assert.equal(videoPosts, 0);
  assert.deepEqual(state.task.provider_asset_preparation, { schema: "gaorui_person_asset_preparation.v1", operation_id: OPERATION, state: "submission_unknown", asset_submission_outcome: "unknown" });
  await assert.rejects(() => prepareGaoruiPersonVideoExecution(executionInput(input), deps));
  assert.equal(state.posts, 1);
});

test("task linkage failure after claim prevents the asset POST and keeps its operation closed", async () => {
  const { input, state, deps } = fixture(); state.failTaskWrite = true;
  await assert.rejects(() => prepareGaoruiPersonVideoExecution(executionInput(input), deps),
    (error: unknown) => error instanceof GaoruiProviderAssetError && error.operationId === OPERATION);
  assert.equal(state.posts, 0); assert.equal(state.operations.size, 1);
  state.failTaskWrite = false;
  await rejectsCode(() => prepareGaoruiPersonVideoExecution(executionInput(input), deps), "GAORUI_ASSET_NOT_READY", "submitting");
  assert.equal(state.posts, 0);
});

test("migration exposes only service-role RPCs and contains no media/business backfill", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261030080000_gaorui_provider_asset_operations.sql", import.meta.url), "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql, /REVOKE ALL ON TABLE public\.gaorui_provider_asset_operations FROM PUBLIC, anon, authenticated, service_role/u);
  assert.equal((sql.match(/SECURITY DEFINER/gu) || []).length, 2);
  assert.equal((sql.match(/SET search_path = pg_catalog, public/gu) || []).length, 2);
  assert.equal((sql.match(/OWNER TO zimeiti_owner/gu) || []).length, 3);
  assert.equal((sql.match(/GRANT EXECUTE[\s\S]*?TO service_role;/gu) || []).length, 2);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE|DELETE FROM) public\.(?:user_files|platform_settings|wallet|users)\b/iu);
  assert.match(sql, /ON CONFLICT \(scope\) DO NOTHING/u);
  assert.match(sql, /v_operation\.state <> 'submitting'/u);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS provider_asset_preparation jsonb/u);
  assert.match(sql, /CHECK \(provider_asset_preparation IS NULL OR jsonb_typeof\(provider_asset_preparation\) = 'object'\)/u);
});
