#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { pollVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { resolveProviderSecret } from "../src/lib/provider-secret";
import { refreshOwnedVideoTaskStatus } from "../src/lib/video-task-status";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

function argument(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

async function main() {
  const taskId = argument("task-id");
  const evidencePath = argument("evidence");
  assert.match(taskId, /^vt_[a-zA-Z0-9]{8,100}$/u, "VIDEO_TASK_ID_REQUIRED");
  assert.ok(process.argv.includes("--confirm-status-only"), "EXPLICIT_STATUS_ONLY_CONFIRMATION_REQUIRED");
  assert.ok(process.env.LOCAL_ACCEPTANCE_PREVIEW === "true", "LOCAL_ACCEPTANCE_PREVIEW_REQUIRED");

  const db = getSupabaseAdminClient();
  const { data: task, error } = await db.from("video_tasks")
  .select("id,user_id,model_id,task_id_external,status,billing_state,price_charged")
  .eq("id", taskId)
  .maybeSingle();
  assert.ifError(error);
  assert.ok(task, "VIDEO_TASK_NOT_FOUND");
  assert.ok(task.task_id_external, "PROVIDER_TASK_ID_REQUIRED");
  assert.ok(!["failed", "cancelled", "expired"].includes(String(task.status)), "TERMINAL_FAILURE_STATUS_REFUSED");

  if (process.argv.includes("--diagnose-provider-host-only")) {
    const { data: model, error: modelError } = await db.from("video_models")
      .select("id,name,provider,api_endpoint,api_key,protocol_type,price_per_use,duration_seconds,supports_image_input,model_name,api_protocol_config")
      .eq("id", task.model_id)
      .maybeSingle();
    assert.ifError(modelError);
    assert.ok(model?.api_endpoint && model?.api_key, "VIDEO_MODEL_CONFIGURATION_REQUIRED");
    const config: VideoModelConfig = {
      id: String(model.id),
      name: String(model.name || model.id),
      provider: String(model.provider || ""),
      api_endpoint: String(model.api_endpoint),
      api_key: resolveProviderSecret(String(model.api_key)),
      protocol_type: String(model.protocol_type || "openai_compatible"),
      price_per_use: Number(model.price_per_use) || 0,
      duration_seconds: Number(model.duration_seconds) || 5,
      supports_image_input: Boolean(model.supports_image_input),
      model_name: String(model.model_name || model.id),
      api_protocol_config: (model.api_protocol_config || undefined) as Record<string, unknown> | undefined,
    };
    const result = await pollVideoTask(config, String(task.task_id_external), "");
    let resultHostname: string | null = null;
    if (result.videoUrl) resultHostname = new URL(result.videoUrl).hostname.toLowerCase();
    const diagnostic = {
      checkedAt: new Date().toISOString(),
      localOnly: true,
      providerSubmissionRequests: 0,
      providerStatusRequests: 1,
      taskId,
      modelId: String(task.model_id),
      providerStatus: result.status,
      terminalState: result.terminalState || null,
      hasVideoUrl: Boolean(result.videoUrl),
      resultHostname,
    };
    if (evidencePath) {
      const target = path.resolve(evidencePath);
      assert.ok(target.startsWith(`${path.resolve(".codex-evidence")}${path.sep}`), "EVIDENCE_PATH_REQUIRED");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: "wx" });
    }
    console.log(JSON.stringify(diagnostic, null, 2));
    return;
  }

  const { data: owner, error: ownerError } = await db.from("users")
  .select("id,role")
  .eq("id", task.user_id)
  .maybeSingle();
  assert.ifError(ownerError);
  assert.ok(owner, "VIDEO_TASK_OWNER_NOT_FOUND");

  const response = await refreshOwnedVideoTaskStatus(
  { userId: String(owner.id), role: owner.role === "admin" ? "admin" : "student" },
  new URLSearchParams({ taskId: String(task.task_id_external), modelId: String(task.model_id) }),
);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const report = {
  checkedAt: new Date().toISOString(),
  localOnly: true,
  providerSubmissionRequests: 0,
  taskId,
  modelId: String(task.model_id),
  statusHttp: response.status,
  status: String(body.status || ""),
  processingStage: body.processingStage || null,
  progress: body.progress ?? null,
  errorCode: body.errorCode || null,
  billingState: body.billingState || String(task.billing_state || ""),
  priceCharged: Number(body.priceCharged ?? task.price_charged ?? 0),
  hasPlaybackUrl: Boolean(body.videoUrl || body.storageUrl),
  };
  if (evidencePath) {
    const target = path.resolve(evidencePath);
    assert.ok(target.startsWith(`${path.resolve(".codex-evidence")}${path.sep}`), "EVIDENCE_PATH_REQUIRED");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
