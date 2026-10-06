#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildVideoCancellationTransport,
  supportsConfirmedVideoCancellation,
} from "../src/lib/video-cancellation";
import {
  buildVideoRoutingSnapshot,
  parseVideoRoutingSnapshot,
  resolveVideoRoutingCredential,
} from "../src/lib/video-routing-snapshot";

async function main() {
  const route = await readFile("src/app/api/video/cancel/route.ts", "utf8");
  const runtime = await readFile("src/lib/video-cancellation-runtime.ts", "utf8");
  let assertions = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    assertions += 1;
  };

  const submittedModel = {
    id: "relay-a-video",
    name: "Relay A Video",
    provider: "relay-a",
    api_endpoint: "https://relay-a.example/openai/v1/videos",
    api_key: "secret://secure-skill-video-enterprise",
    protocol_type: "secure_skill_enterprise_video",
    model_name: "video-a-v1",
    duration_seconds: 10,
    supports_image_input: true,
    api_protocol_config: {
      supports_remote_cancel: true,
      cancel_method: "DELETE",
      cancel_path: "/v1/jobs/{id}",
      cancel_task_id_placement: "path",
      cancel_confirm_path: "/v1/jobs/{id}",
    },
  };
  const snapshot = buildVideoRoutingSnapshot(submittedModel);
  const changedCatalogModel = {
    ...submittedModel,
    api_endpoint: "https://relay-b.example/v9/videos",
    protocol_type: "openai_compatible",
    model_name: "video-b-v9",
    api_protocol_config: { supports_remote_cancel: false },
  };
  const changedSnapshot = buildVideoRoutingSnapshot(changedCatalogModel);
  const parsed = parseVideoRoutingSnapshot(JSON.parse(JSON.stringify(snapshot)), submittedModel.id);

  check(parsed.configVersion !== changedSnapshot.configVersion, "catalog route changes produce a different immutable version");
  check(parsed.apiEndpoint === "https://relay-a.example/openai/v1/videos", "accepted task cancellation retains relay A endpoint");
  check(parsed.protocolType === "secure_skill_enterprise_video", "accepted task cancellation retains relay A protocol");
  check(parsed.modelName === "video-a-v1", "accepted task cancellation retains the submitted provider model identity");
  check(supportsConfirmedVideoCancellation(parsed.protocolType, parsed.apiProtocolConfig), "cancellation capability comes from the accepted snapshot");
  check(!supportsConfirmedVideoCancellation(changedSnapshot.protocolType, changedSnapshot.apiProtocolConfig), "changed catalog capability is distinct and ignored");
  const transport = buildVideoCancellationTransport({
    protocolType: parsed.protocolType,
    apiEndpoint: parsed.apiEndpoint,
    protocolConfig: parsed.apiProtocolConfig,
    taskId: "provider-task-a",
  });
  check(transport.url.startsWith("https://relay-a.example/"), "cancel URL remains on relay A after catalog changes to relay B");
  check(!transport.url.includes("relay-b.example"), "cancel URL never switches to the current catalog relay");

  let credentialLookups = 0;
  const credential = await resolveVideoRoutingCredential({
    snapshot: parsed,
    resolveSecret: (reference) => `resolved:${String(reference)}`,
    lookupModelCredential: async () => {
      credentialLookups += 1;
      throw new Error("direct secret reference must not reload the model catalog");
    },
  });
  check(credential === "resolved:secret://secure-skill-video-enterprise" && credentialLookups === 0,
    "direct credential references resolve without reading mutable catalog routing");

  const legacySnapshot = buildVideoRoutingSnapshot({ ...submittedModel, api_key: "legacy-inline-secret-value" });
  const rotatedCredential = await resolveVideoRoutingCredential({
    snapshot: legacySnapshot,
    resolveSecret: (reference) => `resolved:${String(reference)}`,
    lookupModelCredential: async (modelId) => {
      credentialLookups += 1;
      assert.equal(modelId, submittedModel.id);
      return "secret://secure-skill-video-enterprise";
    },
  });
  check(rotatedCredential.startsWith("resolved:secret://") && credentialLookups === 1,
    "legacy tasks may reload only the credential field through the frozen model reference");

  assert.throws(() => parseVideoRoutingSnapshot(snapshot, "different-internal-model"), /VIDEO_ROUTING_MODEL_ID_MISMATCH/u);
  assertions += 1;
  assert.throws(() => parseVideoRoutingSnapshot(null, submittedModel.id), /VIDEO_ROUTING_SNAPSHOT_VERSION_UNSUPPORTED/u);
  assertions += 1;

  check(route.includes("requestVideoTaskCancellation"), "cancel route delegates to the shared cancellation runtime");
  check(runtime.includes("parseVideoRoutingSnapshot(task.routing_snapshot, effectiveModelId)"), "cancellation binds snapshot to the task internal model id");
  check(runtime.includes("supportsConfirmedVideoCancellation(routingSnapshot.protocolType, routingSnapshot.apiProtocolConfig)"), "cancel capability uses snapshot protocol/config");
  check(runtime.includes("buildVideoCancellationTransport"), "cancel endpoint is built from the frozen snapshot");
  check(runtime.includes('.select("api_key")'), "legacy rotation lookup is limited to the credential column");
  check(!runtime.includes('.select("provider, model_name, api_endpoint, api_key, protocol_type, api_protocol_config")'), "cancellation never reloads mutable routing fields");

  console.log(JSON.stringify({
    passed: true,
    assertions,
    frozenCancellationHost: new URL(parsed.apiEndpoint).host,
    changedCatalogHost: new URL(changedSnapshot.apiEndpoint).host,
    networkRequests: 0,
    realDatabaseWrites: 0,
    paidModelCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
