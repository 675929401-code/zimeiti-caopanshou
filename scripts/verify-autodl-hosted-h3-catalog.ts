import assert from "node:assert/strict";

import {
  AUTODL_HOSTED_H3_CATALOG_SCHEMA,
  AUTODL_HOSTED_H3_WORKFLOWS,
  RETIRED_AUTODL_HOSTED_H3_WORKFLOWS,
  autoDLHostedH3BindingSha256,
  autoDLHostedH3ContractSha256,
  buildAutoDLHostedH3CatalogRecords,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";
import { inspectVideoModelActivationReadiness } from "../src/lib/model-activation-gate";
import { AUTODL_COMFYUI_SECRET_REF } from "../src/lib/provider-secret";

const EXPECTED_CONTRACT_HASHES: Readonly<Record<string, string>> = {
  "minimax_h3_lightx2v_v5": "8ce29a5a6dcd74afc10eb213c60af795bd21e9b5f130bd51a116e04ea6a01e7c",
  "minimax_h3_lightx2v_no_pic": "bbc60e13665ae3be0aacda054eccb55ac22818c36a39577ca0d5d552910e7d6b",
  "minimax_h3_lightx2v": "b57db39b57419ef33b9be71dcd93c128635a539001e271e290a6e737be48b632",
  "minimax_h3_lightx2v_v5_15s": "3c43fc12f11b0e77c8d7b4d70a670f0677be7f6b205b49dba31c4bbdfdad045e",
  "minimax_h3_image_audio_to_video": "88c1411813ebaf9d807279f142c817e6bf69054f88a62843060da3251af8d686",
  "minimax_h3_image_audio_to_video_v2": "f4065b8fa9adac55f6f2ea157f5f9e6c402a64bd8fb04d3ff57062cfb677e38a",
  "minimax_h3_image_audio_to_video_v2_15s": "dc9cd302c5c5969b266528a40ad5e890a77b0a79273dc3743d64bff5a5249304"
};

const EXPECTED_INPUT_MODES: Readonly<Record<string, string>> = {
  text_to_video: "text",
  multi_image_to_video: "multi_image",
  first_last_frame_to_video: "first_last_frame",
  image_audio_lipsync: "image_audio_lipsync",
  multi_image_audio_to_video: "multi_image_audio",
};

function byWorkflow(workflowId: string) {
  const spec = [...AUTODL_HOSTED_H3_WORKFLOWS, ...RETIRED_AUTODL_HOSTED_H3_WORKFLOWS]
    .find((item) => item.workflowId === workflowId);
  assert.ok(spec, `missing workflow ${workflowId}`);
  return spec;
}

function recordByWorkflow(workflowId: string) {
  const record = buildAutoDLHostedH3CatalogRecords().find((item) => item.model_name === workflowId);
  assert.ok(record, `missing record ${workflowId}`);
  return record;
}

async function main() {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("ZERO_NETWORK_FIXTURE_FETCH_FORBIDDEN");
  };

  try {
    const allWorkflowEvidence = [...AUTODL_HOSTED_H3_WORKFLOWS, ...RETIRED_AUTODL_HOSTED_H3_WORKFLOWS];
    assert.equal(AUTODL_HOSTED_H3_WORKFLOWS.length, 3);
    assert.equal(RETIRED_AUTODL_HOSTED_H3_WORKFLOWS.length, 4);
    assert.equal(allWorkflowEvidence.length, 7);
    assert.equal(new Set(AUTODL_HOSTED_H3_WORKFLOWS.map((item) => item.workflowId)).size, 3);
    assert.equal(new Set(AUTODL_HOSTED_H3_WORKFLOWS.map((item) => item.modelId)).size, 3);
    assert.equal(new Set(allWorkflowEvidence.map((item) => item.workflowId)).size, 7);
    assert.equal(new Set(allWorkflowEvidence.map((item) => item.modelId)).size, 7);

    for (const spec of allWorkflowEvidence) {
      assert.equal(autoDLHostedH3ContractSha256(spec), EXPECTED_CONTRACT_HASHES[spec.workflowId]);
    }

    const records = buildAutoDLHostedH3CatalogRecords();
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map(autoDLHostedH3BindingSha256)).size, 3);

    for (const [index, spec] of AUTODL_HOSTED_H3_WORKFLOWS.entries()) {
      const record = records[index];
      const config = record.api_protocol_config;
      assert.equal(record.provider, "autodl_comfyui_workflow");
      assert.equal(record.protocol_type, "autodl_comfyui_workflow");
      assert.equal(record.api_key, AUTODL_COMFYUI_SECRET_REF);
      assert.equal(record.is_active, true);
      assert.equal(record.is_hidden, false);
      assert.equal(config.schema, AUTODL_HOSTED_H3_CATALOG_SCHEMA);
      assert.equal(config.workflow_id, spec.workflowId);
      assert.equal(config.workflow_input_mode, EXPECTED_INPUT_MODES[spec.kind]);
      assert.equal(config.duration_field, spec.duration.field);
      assert.equal(config.supports_prompt, spec.prompt !== null);
      assert.equal(config.required_reference_images, spec.images.filter((field) => field.required).length);
      assert.equal(config.required_reference_audios, spec.audios.filter((field) => field.required).length);
      assert.equal(config.persist_result_immediately, true);
      assert.equal(config.supports_remote_cancel, false);
      assert.equal(config.billing_unit, "output_second");
      assert.equal((config.resolution_cost_prices as Record<string,number>)["480p"], 0.02);
      assert.equal((config.resolution_cost_prices as Record<string,number>)["768p"], 0.03);
      assert.equal((config.resolution_prices as Record<string,number>)["768p"], 0.04);
      assert.equal(record.cost_price, 0.03);
      assert.equal(record.price_per_use, 0.04);
      assert.deepEqual(config.adapter_compatibility, { status: "ready", limitations: [] });
      assert.equal(config.official_contract_sha256, EXPECTED_CONTRACT_HASHES[spec.workflowId]);
      assert.equal(autoDLHostedH3ContractSha256(spec), EXPECTED_CONTRACT_HASHES[spec.workflowId]);
      assert.match(autoDLHostedH3BindingSha256(record), /^[a-f0-9]{64}$/u);
      assert.deepEqual(inspectVideoModelActivationReadiness(record), {
        gated: true,
        ready: false,
        reason: "acceptance_evidence_not_persisted",
      });
    }

    const multiImage = recordByWorkflow("minimax_h3_lightx2v_v5");
    assert.equal(multiImage.requires_image, true);
    assert.equal(multiImage.max_duration, 10);
    assert.deepEqual(multiImage.api_protocol_config.resolution_options, ["480p", "768p", "1080p"]);
    assert.deepEqual(multiImage.api_protocol_config.aspect_ratios, ["9:16", "16:9", "1:1"]);
    assert.equal(multiImage.api_protocol_config.max_reference_images, 9);
    assert.equal((multiImage.api_protocol_config.resolution_prices as Record<string, number>)["1080p"], 0.10);

    assert.equal((multiImage.api_protocol_config.resolution_cost_prices as Record<string, number>)["1080p"], 0.09);
    const saved = new Map([[multiImage.id, { api_protocol_config: { resolution_prices: { "480p": 0, "768p": 0.08, "1080p": 0.25 } } }]]);
    const preserved = buildAutoDLHostedH3CatalogRecords({ persistedById: saved }).find(row => row.id === multiImage.id)!;
    assert.deepEqual(preserved.api_protocol_config.resolution_prices, { "480p": 0, "768p": 0.08, "1080p": 0.25 });
    assert.equal(preserved.cost_price, 0.03);
    const textToVideo = recordByWorkflow("minimax_h3_lightx2v_no_pic");
    assert.equal(textToVideo.supports_image_input, false);
    assert.equal(textToVideo.requires_image, false);
    assert.equal(textToVideo.max_duration, 15);
    assert.deepEqual(textToVideo.api_protocol_config.resolution_options, ["480p", "768p"]);

    const firstLast = byWorkflow("minimax_h3_lightx2v");
    assert.deepEqual(firstLast.images.map(item => item.field), ["first_frame", "last_frame"]);
    assert.equal(firstLast.images.every(item => item.required), true);

    const lipSync = byWorkflow("minimax_h3_image_audio_to_video");
    assert.equal(lipSync.duration.field, "audio_duration");
    assert.equal(lipSync.prompt, null);
    assert.equal(lipSync.images.filter(item => item.required).length, 1);
    assert.equal(lipSync.audios.filter(item => item.required).length, 1);

    const multiAudio = recordByWorkflow("minimax_h3_image_audio_to_video_v2");
    assert.equal(multiAudio.api_protocol_config.max_reference_images, 9);
    assert.equal(multiAudio.api_protocol_config.max_reference_audios, 3);
    assert.equal(multiAudio.api_protocol_config.required_reference_images, 0);
    assert.equal(multiAudio.api_protocol_config.required_reference_audios, 0);
    assert.equal((multiAudio.api_protocol_config.resolution_prices as Record<string, number>)["1080p"], 0.11);

    assert.equal((multiAudio.api_protocol_config.resolution_cost_prices as Record<string, number>)["1080p"], 0.10);
    const fifteenSecondSpecs = allWorkflowEvidence.filter((spec) => spec.duration.max === 15);
    assert.equal(fifteenSecondSpecs.length, 5);
    assert.equal(byWorkflow("minimax_h3_lightx2v_v5_15s").resolutions.some((item) => item.aspect_ratio === "1:1"), true);
    assert.equal(byWorkflow("minimax_h3_image_audio_to_video_v2_15s").resolutions.some((item) => item.tier === "1080p"), false);

    assert.equal(fetchCalls, 0, "catalog fixture must not perform network requests");
    console.log(JSON.stringify({
      passed: true,
      schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
      workflow_count: allWorkflowEvidence.length,
      configured_workflow_count: AUTODL_HOSTED_H3_WORKFLOWS.length,
      retired_evidence_count: RETIRED_AUTODL_HOSTED_H3_WORKFLOWS.length,
      paid_generation_calls: 0,
      network_calls: fetchCalls,
      hashes: EXPECTED_CONTRACT_HASHES,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main();
