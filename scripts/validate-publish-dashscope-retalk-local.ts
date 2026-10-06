import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ORIGIN = "http://127.0.0.1:5000";
const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const MODEL_ID = "videoretalk-dashscope";
const VIDEO_ASSET_ID = "cc5cbc3c-d15f-4453-8944-04c8b2831c02";
const AUDIO_ASSET_ID = "0e07e6e0-343f-4066-ae21-c5c30c85309b";
type Json = Record<string, unknown>;
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function clean(value: unknown) { return String(value || "").replace(/https?:\/\/\S+/giu, "[url]").slice(0, 500); }
async function body(response: Response) { const text = await response.text(); try { return text ? JSON.parse(text) as Json : {}; } catch { return { error: clean(text) }; } }
async function api(token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(new URL(pathname, ORIGIN), { ...init, headers, signal: init.signal || AbortSignal.timeout(180_000) });
  return { response, data: await body(response) };
}
async function loadPublishedCanaryRecovery(runtime: Json, userId: string) {
  const databaseUrl = new URL(String(runtime.databaseUrl || ""));
  assert.equal(databaseUrl.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(databaseUrl.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(databaseUrl.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
  const pgModule = await import("pg"); const pg = pgModule.default || pgModule;
  const client = new pg.Client({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  await client.connect();
  try {
    const modelResult = await client.query("SELECT api_protocol_config->'__model_activation_gate'->'publication' AS publication FROM public.video_models WHERE id=$1", [MODEL_ID]);
    const publication = object(modelResult.rows[0]?.publication);
    const businessTaskId = String(publication.taskId || "");
    assert.match(businessTaskId, /^vt_[a-f0-9]{40}$/u, "RELEASE_CANARY_PUBLICATION_TASK_MISSING");
    assert.equal(String(publication.userId || ""), userId, "RELEASE_CANARY_PUBLICATION_OWNER_MISMATCH");
    const taskResult = await client.query("SELECT id,user_id,model_id,client_request_id,task_id_external,status FROM public.video_tasks WHERE id=$1", [businessTaskId]);
    const task = object(taskResult.rows[0]);
    assert.equal(task.user_id, userId, "RELEASE_CANARY_TASK_OWNER_MISMATCH");
    assert.equal(task.model_id, MODEL_ID, "RELEASE_CANARY_TASK_MODEL_MISMATCH");
    assert.equal(task.client_request_id, publication.validationKey, "RELEASE_CANARY_TASK_PROOF_MISMATCH");
    assert.equal(task.status, "completed", "RELEASE_CANARY_TASK_NOT_COMPLETED");
    return {
      taskId: String(task.task_id_external || task.id), businessTaskId,
      status: String(task.status), proof: {
        validationKey: String(publication.validationKey || ""), configurationHash: String(publication.configurationHash || ""),
        healthEpoch: String(publication.healthEpoch || ""), clientRequestId: String(publication.validationKey || ""),
      },
    };
  } finally { await client.end(); }
}
async function main() {
  if (!process.argv.includes("--execute")) { console.log(JSON.stringify({ mode: "plan", modelId: MODEL_ID, providerRequests: 0, directHealthWrites: 0 })); return; }
  assert.ok(process.argv.includes("--confirm-one-release-canary"), "RELEASE_CANARY_CONFIRMATION_REQUIRED");
  const runtime = JSON.parse((await readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, "")) as Json;
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED"); assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(new URL(String(runtime.supabaseUrl || runtime.restUrl)).origin, "http://127.0.0.1:54321", "LOCAL_REST_REQUIRED");
  const sessionResponse = await fetch(`${ORIGIN}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" }, signal: AbortSignal.timeout(20_000) });
  const session = await body(sessionResponse); assert.ok(sessionResponse.ok && session.token && object(session.user).role === "admin", "LOCAL_ADMIN_SESSION_REQUIRED");
  const token = String(session.token);
  const preflight = await api(token, `/api/admin/video-models/validation?${new URLSearchParams({ modelId: MODEL_ID })}`, { cache: "no-store" });
  assert.ok(preflight.response.ok && preflight.data.validationKey, `VALIDATION_PREFLIGHT_FAILED:${preflight.response.status}:${clean(preflight.data.error)}`);
  assert.equal(preflight.data.busy, false, "MODEL_VALIDATION_OWNED_BY_ANOTHER_ADMIN");
  let proof = {
    validationKey: String(preflight.data.validationKey), configurationHash: String(preflight.data.configurationHash),
    healthEpoch: String(preflight.data.healthEpoch), clientRequestId: String(preflight.data.validationKey),
  };
  assert.match(proof.validationKey, /^vav_[a-f0-9]{64}$/u); assert.match(proof.configurationHash, /^[a-f0-9]{64}$/u); assert.match(proof.healthEpoch, /^[a-f0-9]{64}$/u);
  const assets = await api(token, `/api/digital-human/assets?${new URLSearchParams([["id", VIDEO_ASSET_ID], ["id", AUDIO_ASSET_ID]])}`, { cache: "no-store" });
  assert.ok(assets.response.ok && Array.isArray(assets.data.assets), "VALIDATION_ASSETS_UNAVAILABLE");
  const video = (assets.data.assets as Json[]).find((row) => row.id === VIDEO_ASSET_ID);
  const audio = (assets.data.assets as Json[]).find((row) => row.id === AUDIO_ASSET_ID);
  assert.ok(video?.url && audio?.url, "VALIDATION_ASSET_URLS_MISSING");
  const minimum = object(preflight.data.minimumInput); const model = object(preflight.data.model);
  const buildRequest = () => ({
    model_id: MODEL_ID, prompt: "保持原视频画面，人物口型与配音同步。", image_url: "", last_frame_url: "",
    reference_image_urls: [], reference_audio_urls: [String(audio.url)], source_video_url: String(video.url),
    duration: Number(minimum.durationSeconds), aspect_ratio: String(minimum.aspectRatio || "9:16"),
    resolution: String(minimum.resolution || "720p"), resolution_tier: String(minimum.resolution || "720p"),
    surface: "video-page", task_label: `管理员验证 · ${String(model.displayName || MODEL_ID)}`,
    admin_validation: true, admin_validation_key: proof.validationKey,
    admin_validation_confirmation: String(preflight.data.confirmation), client_request_id: proof.validationKey,
  });
  const evidenceDir = path.resolve("artifacts", `dashscope-retalk-release-canary-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  await mkdir(evidenceDir, { recursive: true }); const evidence = path.join(evidenceDir, "summary.json");
  const existing = object(preflight.data.existingTask);
  const resumeExistingOnly = process.argv.includes("--resume-existing-only");
  let taskId = String(existing.taskId || "");
  let businessTaskId = String(existing.businessTaskId || "");
  if (!businessTaskId && resumeExistingOnly) {
    const recovered = await loadPublishedCanaryRecovery(runtime, String(object(session.user).id || ""));
    taskId = recovered.taskId; businessTaskId = recovered.businessTaskId; proof = recovered.proof;
    assert.match(proof.validationKey, /^vav_[a-f0-9]{64}$/u); assert.match(proof.configurationHash, /^[a-f0-9]{64}$/u); assert.match(proof.healthEpoch, /^[a-f0-9]{64}$/u);
    Object.assign(existing, { status: recovered.status, validationKey: proof.validationKey });
  }
  const providerSubmissionCountThisRun = businessTaskId ? 0 : 1;
  const trace: Json[] = [];
  if (businessTaskId) {
    assert.match(businessTaskId, /^vt_[a-f0-9]{40}$/u, "RELEASE_CANARY_EXISTING_TASK_INVALID");
    assert.equal(String(existing.validationKey || proof.validationKey), proof.validationKey, "RELEASE_CANARY_EXISTING_PROOF_MISMATCH");
    taskId ||= businessTaskId;
    trace.push({ phase: "resume-existing", at: new Date().toISOString(), status: existing.status, taskId, businessTaskId });
    console.log(JSON.stringify({ event: "release-canary-resumed", taskId, businessTaskId, status: existing.status, providerPostRequests: 0, at: new Date().toISOString() }));
  } else {
    assert.equal(resumeExistingOnly, false, "RELEASE_CANARY_EXISTING_TASK_NOT_FOUND_NO_REPLAY");
    console.log(JSON.stringify({ event: "submit-release-canary", modelId: MODEL_ID, validationKeyHashSuffix: proof.validationKey.slice(-8), at: new Date().toISOString() }));
    let submitted;
    try { submitted = await api(token, "/api/video/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": proof.validationKey }, body: JSON.stringify(buildRequest()) }); }
    catch { await writeFile(evidence, JSON.stringify({ state: "submission_unknown", proof, replayed: false, credentialsPrinted: false }, null, 2)); throw new Error("RELEASE_CANARY_SUBMISSION_UNKNOWN"); }
    businessTaskId = String(submitted.data.business_task_id || submitted.data.businessTaskId || "");
    taskId = String(submitted.data.task_id || submitted.data.taskId || businessTaskId);
    assert.ok(submitted.response.ok && taskId && /^vt_[a-f0-9]{40}$/u.test(businessTaskId), `RELEASE_CANARY_REJECTED:${submitted.response.status}:${clean(submitted.data.error || submitted.data.error_code)}`);
    console.log(JSON.stringify({ event: "release-canary-registered", taskId, businessTaskId, status: submitted.data.status, at: new Date().toISOString() }));
    trace.push({ phase: "submit", at: new Date().toISOString(), status: submitted.data.status, taskId, businessTaskId });
  }
  let terminal: Json = {}; const deadline = Date.now() + 30 * 60_000; let lastPrint = 0;
  while (Date.now() < deadline) {
    const statusResult = await api(token, `/api/video/status?${new URLSearchParams({ taskId, modelId: String(model.publicId || "") })}`, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const status = String(statusResult.data.status || "unknown"); const point = { phase: "poll", status, at: new Date().toISOString(), stage: statusResult.data.processingStage, errorCode: statusResult.data.errorCode || null, error: clean(statusResult.data.errorMessage) };
    trace.push(point); await writeFile(evidence, JSON.stringify({ state: status, taskId, businessTaskId, proof, trace, replayed: false, credentialsPrinted: false }, null, 2));
    if (Date.now() - lastPrint > 30_000 || ["completed", "failed", "cancelled"].includes(status)) { console.log(JSON.stringify({ event: "poll-release-canary", taskId, status, stage: point.stage, at: point.at })); lastPrint = Date.now(); }
    if (["completed", "failed", "cancelled"].includes(status)) { terminal = statusResult.data; break; }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  assert.equal(terminal.status, "completed", `RELEASE_CANARY_NOT_COMPLETED:${clean(terminal.errorMessage || terminal.error)}`);
  const publishRequest = { modelId: MODEL_ID, taskId: businessTaskId, confirmation: "PUBLISH_VALIDATED_VIDEO_MODEL", ...proof };
  const published = await api(token, "/api/admin/video-models/validation/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(publishRequest) });
  assert.ok(published.response.ok && published.data.success === true && published.data.taskId === businessTaskId, `RELEASE_PUBLICATION_FAILED:${published.response.status}:${clean(published.data.error || published.data.code)}`);
  const verified = await api(token, `/api/admin/video-models/validation?${new URLSearchParams({ modelId: MODEL_ID })}`, { cache: "no-store" });
  assert.ok(verified.response.ok, "RELEASE_VERIFICATION_READ_FAILED");
  const report = { modelId: MODEL_ID, taskId, businessTaskId, state: "completed", published: true, verificationState: object(verified.data.health).verification_state || null, providerSubmissionCountThisRun, originalCanaryProviderSubmissionCount: 1, requestReplayCount: 0, directHealthWrites: 0, credentialsPrinted: false, trace };
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, taskId, businessTaskId, published: true, evidence, providerSubmissionCountThisRun, originalCanaryProviderSubmissionCount: 1, requestReplayCount: 0, credentialsPrinted: false }, null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ ok: false, error: clean(error instanceof Error ? error.message : error), replayed: false, credentialsPrinted: false })); process.exitCode = 1; });
