#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const databaseOrigin = String(process.env.COZE_SUPABASE_URL || "").replace(/\/+$/u, "");
const databaseKey = String(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(origin), "LOCAL_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.equal(databaseOrigin, "http://127.0.0.1:54321", "LOCAL_DATABASE_REQUIRED");
assert.ok(databaseKey, "LOCAL_DATABASE_KEY_REQUIRED");

async function readJson(pathname) {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, `${pathname} returned HTTP ${response.status}`);
  return body;
}

async function readDatabaseRows(table, query) {
  const url = new URL(`/rest/v1/${table}`, databaseOrigin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { apikey: databaseKey, Authorization: `Bearer ${databaseKey}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok && Array.isArray(body), `${table} returned HTTP ${response.status}`);
  return body;
}

function opaque(value) {
  const text = String(value || "").trim();
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 12) : null;
}

function summarizeModel(model) {
  return {
    id: String(model?.id || ""),
    displayName: String(model?.displayName || model?.name || ""),
    available: model?.capabilities?.available === true,
    supportsRemoteCancel: model?.capabilities?.supportsRemoteCancel === true || model?.supportsRemoteCancel === true,
    workspaceSurfaces: Array.isArray(model?.capabilities?.workspaceSurfaces) ? model.capabilities.workspaceSurfaces.map(String) : [],
  };
}

function summarizeTask(task, modelById, source) {
  const modelId = String(task?.publicModelId || task?.modelId || task?.model_id || task?.videoTaskModelId || task?.videoModelId || task?.video_model_id || "");
  const model = modelById.get(modelId);
  return {
    source,
    task: opaque(task?.taskId || task?.task_id || task?.id || task?.videoTaskId),
    status: String(task?.status || task?.videoStatus || ""),
    modelId,
    modelName: String(task?.modelName || task?.model_name || task?.videoTaskModelName || task?.videoModelName || model?.displayName || ""),
    supportsRemoteCancel: task?.supportsRemoteCancel === true || task?.videoSupportsRemoteCancel === true || model?.supportsRemoteCancel === true,
    createdAt: task?.createdAt || task?.created_at || (Number(task?.videoStartedAt) > 0 ? new Date(Number(task.videoStartedAt)).toISOString() : null),
    clientRequestPresent: Boolean(String(task?.clientRequestId || task?.client_request_id || task?.videoClientRequestId || "").trim()),
    clientRequest: opaque(task?.clientRequestId || task?.client_request_id || task?.videoClientRequestId),
  };
}

const [identity, videoCatalogBody, storyboardCatalogBody, historyBody, projectsBody] = await Promise.all([
  readJson("/api/auth/me"),
  readJson("/api/video/models?surface=video-page"),
  readJson("/api/video/models?surface=storyboard-workbench"),
  readJson("/api/video/history?limit=200&offset=0"),
  readJson("/api/storyboard/projects?offset=0"),
]);
assert.equal(identity?.user?.role, "admin", "ADMIN_REQUIRED");
const activeStatuses = new Set(["pending", "queued", "processing", "generating", "running", "submitted", "finalizing"]);

const [internalModels, internalActiveTasks] = await Promise.all([
  readDatabaseRows("video_models", {
    select: "id,name,model_name,provider,protocol_type,is_active,is_hidden,api_endpoint,api_protocol_config",
    order: "sort_order.asc,id.asc",
  }),
  readDatabaseRows("video_tasks", {
    select: "id,task_id_external,model_id,status,created_at,billing_state,client_request_id,routing_snapshot,batch_id,card_index,submission_error_code",
    order: "created_at.desc",
    limit: "500",
  }),
]);

const internalModelSummaries = internalModels.map((row) => {
  const config = row?.api_protocol_config && typeof row.api_protocol_config === "object" && !Array.isArray(row.api_protocol_config)
    ? row.api_protocol_config : {};
  let endpointHost = "";
  try { endpointHost = new URL(String(row?.api_endpoint || "")).host; } catch { /* invalid endpoint is represented by an empty host */ }
  return {
    id: String(row?.id || ""),
    name: String(row?.name || ""),
    provider: String(row?.provider || ""),
    protocolType: String(row?.protocol_type || ""),
    endpointHost,
    active: row?.is_active === true,
    hidden: row?.is_hidden === true,
    supportsRemoteCancel: config.supports_remote_cancel === true,
    cancelContract: {
      method: String(config.cancel_method || ""),
      path: String(config.cancel_path || ""),
      taskIdPlacement: String(config.cancel_task_id_placement || ""),
      taskIdField: String(config.cancel_task_id_field || ""),
      terminalStatuses: Array.isArray(config.cancel_terminal_statuses) ? config.cancel_terminal_statuses.map(String) : [],
    },
  };
});
const internalModelById = new Map(internalModelSummaries.map((model) => [model.id, model]));
const internalTaskSummaries = internalActiveTasks.map((task) => {
  const snapshot = task?.routing_snapshot && typeof task.routing_snapshot === "object" && !Array.isArray(task.routing_snapshot)
    ? task.routing_snapshot : {};
  const snapshotConfig = snapshot.apiProtocolConfig && typeof snapshot.apiProtocolConfig === "object" && !Array.isArray(snapshot.apiProtocolConfig)
    ? snapshot.apiProtocolConfig : {};
  const model = internalModelById.get(String(task?.model_id || ""));
  return {
    id: opaque(task?.id),
    externalTaskIdPresent: Boolean(String(task?.task_id_external || "").trim()),
    externalTask: opaque(task?.task_id_external),
    modelId: String(task?.model_id || ""),
    modelName: model?.name || "",
    status: String(task?.status || ""),
    billingState: String(task?.billing_state || ""),
    clientRequestPresent: Boolean(String(task?.client_request_id || "").trim()),
    clientRequest: opaque(task?.client_request_id),
    createdAt: task?.created_at || null,
    routingSnapshotPresent: Object.keys(snapshot).length > 0,
    snapshotProtocolType: String(snapshot.protocolType || ""),
    snapshotSupportsRemoteCancel: snapshotConfig.supports_remote_cancel === true,
    batch: opaque(task?.batch_id),
    cardIndex: Number(task?.card_index || 0),
    submissionErrorCode: String(task?.submission_error_code || ""),
  };
});

const activeInternalTaskSummaries = internalTaskSummaries.filter((task) => activeStatuses.has(task.status));

const videoModels = (Array.isArray(videoCatalogBody?.models) ? videoCatalogBody.models : []).map(summarizeModel);
const storyboardModels = (Array.isArray(storyboardCatalogBody?.models) ? storyboardCatalogBody.models : []).map(summarizeModel);
const modelById = new Map([...videoModels, ...storyboardModels].map((model) => [model.id, model]));
const historyTasks = (Array.isArray(historyBody?.tasks) ? historyBody.tasks : [])
  .map((task) => summarizeTask(task, modelById, "video-history"))
  .filter((task) => activeStatuses.has(task.status));

const projectSummaries = Array.isArray(projectsBody?.projects) ? projectsBody.projects.slice(0, 50) : [];
const storyboardTasks = [];
for (const project of projectSummaries) {
  if (!project?.id) continue;
  const detail = await readJson(`/api/storyboard/projects?id=${encodeURIComponent(project.id)}`);
  const cards = Array.isArray(detail?.project?.document?.cards) ? detail.project.document.cards : [];
  for (const card of cards) {
    const status = String(card?.videoStatus || "");
    if (!activeStatuses.has(status)) continue;
    storyboardTasks.push({
      ...summarizeTask(card, modelById, "storyboard-project"),
      project: opaque(project.id),
      card: opaque(card?.id),
      order: Number(card?.order || 0),
    });
  }
}
const storyboardClientRequestHashes = new Set(storyboardTasks.map((task) => task.clientRequest).filter(Boolean));
const relatedInternalTasks = internalTaskSummaries.filter((task) => storyboardClientRequestHashes.has(task.clientRequest));

const report = {
  checkedAt: new Date().toISOString(),
  origin,
  actor: { role: identity.user.role },
  videoModels,
  storyboardModels,
  cancellationCoverage: {
    video: {
      total: videoModels.length,
      remotelyCancellable: videoModels.filter((model) => model.supportsRemoteCancel).length,
    },
    storyboard: {
      total: storyboardModels.length,
      remotelyCancellable: storyboardModels.filter((model) => model.supportsRemoteCancel).length,
    },
  },
  activeTasks: [...historyTasks, ...storyboardTasks],
  internalModels: internalModelSummaries,
  internalActiveTasks: activeInternalTaskSummaries,
  relatedInternalTasks,
  providerCalls: 0,
  paidCalls: 0,
  databaseWrites: 0,
};

const evidenceDirectory = path.resolve(".codex-evidence", "video-cancellation-readonly-20261004");
await fs.mkdir(evidenceDirectory, { recursive: true });
const evidencePath = path.join(evidenceDirectory, "report.json");
await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ...report.cancellationCoverage,
  activeTasks: report.activeTasks,
  internalModels: report.internalModels,
  internalActiveTasks: report.internalActiveTasks,
  evidencePath,
  providerCalls: 0,
  paidCalls: 0,
  databaseWrites: 0,
}, null, 2));
