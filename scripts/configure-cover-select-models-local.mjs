#!/usr/bin/env node
// Plan (default): node scripts/with-local-admin-session.mjs scripts/with-local-admin-step-up-session.mjs scripts/configure-cover-select-models-local.mjs
// Apply: append --apply to the command above. The existing step-up wrapper
// removes its temporary authorization session in finally; plan sends GET only.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SURFACE = "cover-studio";
const WORKSPACE_API = "/api/admin/workspace-model-releases";
const POOL_API = "/api/admin/model-pool-releases";
const PUBLIC_API = "/api/cover-models?surface=cover-studio";
const EXPECTED_CURRENT = {
  releaseId: "ebdffd67-2d31-4229-b37a-9fef8d5ca383",
  snapshotSha256: "7a3190d6d6fa135c8540f216f25423ee31240a8835aa1ce0b84632fc6e13b5cd",
};
const TARGETS = [
  { label: "GPT2.5", rawId: "pending-cover-model-1789125082114-2ea1a1e15b37", publicId: "pm_PZ3hS353YQNbfRnz2_9Ro0aX" },
  { label: "Banana", rawId: "gemini-3-1-flash-image-chA", publicId: "pm_sHaGkgaNoH1ZgQzpHW2dEUyF" },
  { label: "豆包5.0", rawId: "cover-model-seedream-5-pro", publicId: "pm_7y8qxRpEQYgNuYBVvqL4MJgs" },
];
const RAW_IDS = TARGETS.map((model) => model.rawId);
const PUBLIC_IDS = TARGETS.map((model) => model.publicId);
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const requireThat = (value, code) => { if (!value) fail(code); };
const canonical = (value) => JSON.stringify(value, function (_key, entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry;
});
const same = (left, right) => canonical(left) === canonical(right);
const sha256 = (value) => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const identity = (row) => ({ releaseId: row.id, version: row.release_version, snapshotSha256: row.snapshot_sha256 });
const runtimeIdentity = (version) => ({ sourceVersion: version.sourceVersion, version: version.version, buildId: version.buildId, hash: version.hash });

function currentRelease(overview, kind) {
  const row = overview.current;
  requireThat(overview.ok === true && overview.kind === kind && row?.is_current === true
    && row.status === "published" && row.snapshot, `${kind.toUpperCase().replaceAll("-", "_")}_CURRENT_REQUIRED`);
  requireThat(/^[a-f0-9-]{36}$/u.test(row.id) && /^[a-f0-9]{64}$/u.test(row.snapshot_sha256), "RELEASE_IDENTITY_INVALID");
  requireThat(sha256(row.snapshot) === row.snapshot_sha256, "RELEASE_SNAPSHOT_HASH_MISMATCH");
  requireThat(overview.runtimeEnforcement?.ready === true, "PLATFORM_CONFIGURATION_RUNTIME_NOT_READY");
  return row;
}

function checkStorage(body) {
  requireThat(body.ok === true && body.storage?.configuration === "local-acceptance"
    && body.storage.businessData === "local", "RUNNING_STORAGE_MUST_BE_LOCAL_ACCEPTANCE");
  return { configuration: body.storage.configuration, businessData: body.storage.businessData };
}

function targetConfigured(snapshot) {
  const slot = snapshot.surfaces?.[SURFACE];
  return slot?.kind === "image" && same([...(slot.assignedModelIds || [])].sort(), [...RAW_IDS].sort())
    && same(slot.orderedModelIds, RAW_IDS);
}

function checkProtectedSnapshot(before, after) {
  requireThat(before.schema === "workspace-model-config/v1" && after.schema === before.schema, "WORKSPACE_SCHEMA_CHANGED");
  const withoutCover = (snapshot) => ({ ...snapshot, surfaces: Object.fromEntries(
    Object.entries(snapshot.surfaces).filter(([surface]) => surface !== SURFACE),
  ) });
  requireThat(same(withoutCover(before), withoutCover(after)), "OTHER_SURFACE_OR_POOL_REFERENCE_CHANGED");
  const beforeCover = before.surfaces[SURFACE];
  const afterCover = after.surfaces[SURFACE];
  const exceptAssignments = (slot) => Object.fromEntries(Object.entries(slot)
    .filter(([key]) => !["assignedModelIds", "orderedModelIds"].includes(key)));
  requireThat(same(exceptAssignments(beforeCover), exceptAssignments(afterCover)), "COVER_NON_ASSIGNMENT_FIELD_CHANGED");
  requireThat(targetConfigured(after), "COVER_TARGET_CONFIGURATION_MISMATCH");
}

function checkTargetReadiness(catalog, publicCatalog, exact = false) {
  const surface = catalog.surfaces?.find((entry) => entry.id === SURFACE);
  requireThat(catalog.access?.mode === "manage" && surface?.kind === "image", "COVER_MANAGEMENT_CATALOG_REQUIRED");
  const ready = TARGETS.map((target) => {
    const model = surface.models?.find((entry) => entry.id === target.rawId);
    requireThat(model && model.hidden === false && model.active === true && model.compatible === true
      && model.priceReady === true && model.publishable === true, `COVER_TARGET_NOT_PUBLISHABLE_${target.label === "GPT2.5" ? "GPT25" : target.label === "Banana" ? "BANANA" : "SEEDREAM5"}`);
    const publicModel = publicCatalog.models?.find((entry) => entry.id === target.publicId);
    // Unassigned targets are absent from the current public catalog by design.
    if (exact || model.assigned || publicModel) requireThat(publicModel?.capabilities?.available === true
      && publicModel.capabilities.priceReady === true && Number.isFinite(publicModel.publicPrice)
      && publicModel.publicPrice >= 0, "COVER_PUBLIC_TARGET_NOT_READY");
    return { ...target, displayName: String(publicModel?.displayName || model.name || ""),
      publicVisible: Boolean(publicModel), publicPrice: publicModel?.publicPrice ?? null, publishable: true };
  });
  if (exact) {
    requireThat(same(publicCatalog.models.map((entry) => entry.id), PUBLIC_IDS), "COVER_PUBLIC_IDS_OR_ORDER_MISMATCH");
    requireThat(same(surface.models.filter((entry) => entry.assigned).map((entry) => entry.id), RAW_IDS), "COVER_ADMIN_ASSIGNMENT_READBACK_MISMATCH");
  }
  return ready;
}

export async function main(args = process.argv.slice(2)) {
  requireThat(args.every((argument) => ["--plan", "--apply"].includes(argument))
    && !(args.includes("--plan") && args.includes("--apply")), "ONLY_PLAN_OR_APPLY_ARGUMENTS_ALLOWED");
  const apply = args.includes("--apply");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const stepUp = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
  requireThat(origin === "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  requireThat(adminToken && stepUp, "USE_EXISTING_LOCAL_ADMIN_AND_STEP_UP_WRAPPERS");
  let database;
  try { database = new URL(process.env.DATABASE_URL || ""); } catch { fail("LOCAL_DATABASE_REQUIRED"); }
  requireThat(database.protocol === "postgresql:" && database.hostname === "127.0.0.1"
    && database.port === "54322" && database.pathname === "/zimeiti_local", "EXACT_LOCAL_DATABASE_REQUIRED");

  const outputRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../运行日志/封面双层底板修复-20261018/model-select");
  const output = path.join(outputRoot, `configuration-${apply ? "apply" : "plan"}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomUUID()}`);
  await fs.mkdir(output, { recursive: true });
  const report = {
    schema: "cover-select-models-local/v1", checkedAt: new Date().toISOString(), origin, mode: apply ? "apply" : "plan",
    status: "started", targets: TARGETS, operations: [], publicationAttempted: false, publicationSucceeded: false,
    configurationPosts: 0, paidGenerationRequests: 0, poolWrites: 0,
    authenticationSession: "existing-local-step-up-wrapper; temporary-session-cleanup-is-owned-by-wrapper",
  };
  const save = (name, value) => fs.writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  const request = async (pathname, body) => {
    const allowed = [WORKSPACE_API, POOL_API, PUBLIC_API, "/api/version", "/api/admin/commerce", "/api/admin/workspace-models"];
    requireThat(allowed.includes(pathname) || pathname.startsWith(`${WORKSPACE_API}?previewReleaseId=`), "API_PATH_OUTSIDE_SCOPE");
    if (body) requireThat(apply && pathname === WORKSPACE_API
      && ["draft", "validate", "publish"].includes(body.action), "CONFIGURATION_WRITE_OUTSIDE_SCOPE");
    const operation = { method: body ? "POST" : "GET", pathname, ...(body ? { action: body.action } : {}) };
    report.operations.push(operation);
    if (body) report.configurationPosts += 1;
    let response;
    try {
      response = await fetch(`${origin}${pathname}`, {
        method: operation.method, headers: { Authorization: `Bearer ${adminToken}`, "x-admin-step-up": stepUp,
          Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000),
      });
    } catch { fail("LOCAL_API_NETWORK_OR_TIMEOUT"); }
    operation.status = response.status;
    let result;
    try { result = await response.json(); } catch { fail("LOCAL_API_JSON_REQUIRED"); }
    requireThat(response.ok && result.ok !== false, `LOCAL_API_HTTP_${response.status}`);
    return result;
  };
  try {
    // This comes from the running server, rather than the launcher's environment.
    const [storageBefore, versionBefore] = await Promise.all([request("/api/admin/commerce"), request("/api/version")]);
    report.storageBefore = checkStorage(storageBefore);
    const sourceVersion = JSON.parse(await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/version.json"), "utf8"));
    report.source = { sourceVersion: sourceVersion.sourceVersion, revision: sourceVersion.revision, sourceDigest: sourceVersion.sourceDigest };
    report.runtimeBefore = runtimeIdentity(versionBefore);
    requireThat(typeof versionBefore.buildId === "string" && versionBefore.buildId.length > 0
      && versionBefore.sourceVersion === sourceVersion.sourceVersion, "RUNNING_VERSION_MUST_MATCH_CURRENT_SOURCE_VERSION");
    const [workspace, pool, catalog, publicCatalog] = await Promise.all([
      request(WORKSPACE_API), request(POOL_API), request("/api/admin/workspace-models"), request(PUBLIC_API),
    ]);
    const before = currentRelease(workspace, "workspace-models");
    const poolBefore = currentRelease(pool, "model-pool");
    requireThat(same(before.snapshot.modelPoolRelease, { releaseId: poolBefore.id, snapshotSha256: poolBefore.snapshot_sha256 }), "WORKSPACE_POOL_REFERENCE_IS_NOT_CURRENT");
    report.before = identity(before);
    report.poolBefore = identity(poolBefore);
    report.readiness = checkTargetReadiness(catalog, publicCatalog);
    await save("workspace-before.json", before.snapshot);
    const target = structuredClone(before.snapshot);
    requireThat(target.surfaces?.[SURFACE]?.kind === "image", "COVER_SURFACE_REQUIRED");
    target.surfaces[SURFACE].assignedModelIds = [...RAW_IDS].sort();
    target.surfaces[SURFACE].orderedModelIds = [...RAW_IDS];
    checkProtectedSnapshot(before.snapshot, target);
    await save("workspace-target.json", target);
    report.targetSnapshotSha256 = sha256(target);
    report.alreadyConfigured = targetConfigured(before.snapshot);
    if (!report.alreadyConfigured) {
      requireThat(before.id === EXPECTED_CURRENT.releaseId && before.snapshot_sha256 === EXPECTED_CURRENT.snapshotSha256, "EXPECTED_BASELINE_CHANGED_REVIEW_REQUIRED");
    }
    if (apply && !report.alreadyConfigured) {
      const drafted = (await request(WORKSPACE_API, { action: "draft", snapshot: target,
        changeNote: "封面模型下拉默认按 GPT2.5、Banana、豆包5.0 分发和排序；其他工作面与模型池保持不变" })).release;
      requireThat(drafted?.id && drafted.is_current === false && same(drafted.snapshot, target)
        && drafted.snapshot_sha256 === report.targetSnapshotSha256, "DRAFT_READBACK_MISMATCH");
      report.candidate = identity(drafted);
      const validated = (await request(WORKSPACE_API, { action: "validate", releaseId: drafted.id })).release;
      requireThat(validated?.status === "validated" && validated.validation_result?.ok === true
        && validated.id === drafted.id && same(validated.snapshot, target)
        && validated.snapshot_sha256 === report.targetSnapshotSha256, "WORKSPACE_VALIDATION_FAILED");
      const preview = (await request(`${WORKSPACE_API}?previewReleaseId=${encodeURIComponent(drafted.id)}`)).preview;
      const { previewSha256, ...previewBody } = preview || {};
      requireThat(/^[a-f0-9]{64}$/u.test(previewSha256 || "") && sha256(previewBody) === previewSha256
        && preview.current?.releaseId === before.id && preview.current.snapshotSha256 === before.snapshot_sha256
        && preview.candidate?.releaseId === drafted.id && preview.candidate.snapshotSha256 === report.targetSnapshotSha256
        && preview.diff?.modelPoolRelease?.changed === false && Array.isArray(preview.diff.surfaces)
        && same(preview.diff.surfaces.filter((entry) => entry.changed).map((entry) => entry.surface), [SURFACE]), "PREVIEW_NOT_EXCLUSIVELY_COVER_ASSIGNMENTS");
      await save("publish-preview.json", preview);
      const [freshWorkspace, freshPool, freshStorage, freshVersion] = await Promise.all([
        request(WORKSPACE_API), request(POOL_API), request("/api/admin/commerce"), request("/api/version"),
      ]);
      checkStorage(freshStorage);
      requireThat(same(runtimeIdentity(freshVersion), report.runtimeBefore), "RUNTIME_CHANGED_BEFORE_PUBLISH");
      requireThat(same(currentRelease(freshWorkspace, "workspace-models"), before), "WORKSPACE_CHANGED_BEFORE_PUBLISH");
      requireThat(same(currentRelease(freshPool, "model-pool"), poolBefore), "POOL_CHANGED_BEFORE_PUBLISH");
      report.publicationAttempted = true;
      report.publicationSucceeded = null; // An interrupted POST has an unknown outcome until read back.
      const published = (await request(WORKSPACE_API, { action: "publish", releaseId: drafted.id, previewSha256 })).release;
      requireThat(published?.id === drafted.id && published.status === "published" && published.is_current === true
        && same(published.snapshot, target) && published.snapshot_sha256 === report.targetSnapshotSha256, "PUBLISHED_RESPONSE_MISMATCH");
      report.publicationSucceeded = true;
      report.published = identity(published);
    }
    const [afterWorkspace, afterPool, afterCatalog, afterPublic, afterStorage, afterVersion] = await Promise.all([
      request(WORKSPACE_API), request(POOL_API), request("/api/admin/workspace-models"), request(PUBLIC_API), request("/api/admin/commerce"), request("/api/version"),
    ]);
    const after = currentRelease(afterWorkspace, "workspace-models");
    const poolAfter = currentRelease(afterPool, "model-pool");
    report.storageAfter = checkStorage(afterStorage);
    report.runtimeAfter = runtimeIdentity(afterVersion);
    requireThat(same(report.runtimeAfter, report.runtimeBefore), "RUNTIME_CHANGED_DURING_CONFIGURATION_CHECK");
    requireThat(same(poolBefore, poolAfter), "POOL_CURRENT_CHANGED");
    requireThat(same(after.snapshot, apply ? target : before.snapshot), "WORKSPACE_READBACK_MISMATCH");
    if (report.publicationSucceeded) requireThat(after.id === report.published.releaseId, "PUBLISHED_CURRENT_ID_MISMATCH");
    else requireThat(same(after, before), "WORKSPACE_CURRENT_CHANGED_WITHOUT_PUBLICATION");
    report.readback = checkTargetReadiness(afterCatalog, afterPublic, apply || report.alreadyConfigured);
    const comparedPrices = report.readiness.filter((entry) => entry.publicPrice !== null);
    requireThat(comparedPrices.every((entry) => report.readback.find((model) => model.rawId === entry.rawId)?.publicPrice === entry.publicPrice), "COVER_PUBLIC_PRICES_CHANGED");
    report.comparedPublicPrices = comparedPrices.length;
    report.publicPricesUnchanged = true;
    report.after = identity(after);
    report.poolAfter = identity(poolAfter);
    report.poolCurrentUnchanged = true;
    report.otherSurfacesUnchanged = true;
    report.publicIds = afterPublic.models.map((entry) => entry.id);
    await save("workspace-after.json", after.snapshot);
    report.status = report.alreadyConfigured ? "already_configured_no_publication" : apply ? "published_and_read_back" : "planned_no_configuration_writes";
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]{1,150}$/u.test(String(error?.code || "")) ? error.code : "UNEXPECTED_LOCAL_FAILURE";
    if (report.publicationAttempted && report.publicationSucceeded !== true) {
      try {
        const observed = currentRelease(await request(WORKSPACE_API), "workspace-models");
        report.publicationReconciliation = identity(observed);
        if (observed.id === report.candidate?.releaseId && observed.snapshot_sha256 === report.targetSnapshotSha256) {
          report.publicationSucceeded = true;
          report.published = identity(observed);
        }
        // A baseline read cannot exclude an in-flight server publish after a client timeout.
      } catch { report.publicationReconciliation = { code: "READBACK_UNAVAILABLE" }; }
    }
    report.status = report.publicationSucceeded === true ? "published_readback_failed"
      : report.publicationAttempted ? "publication_outcome_unknown" : "failed_stopped";
  } finally {
    report.finishedAt = new Date().toISOString();
    await save("report.json", report);
  }
  console.log(JSON.stringify({ status: report.status, mode: report.mode, publicationAttempted: report.publicationAttempted, publicationSucceeded: report.publicationSucceeded,
    configurationPosts: report.configurationPosts, evidence: output, ...(report.errorCode ? { errorCode: report.errorCode } : {}) }, null, 2));
  if (report.errorCode) fail(report.errorCode);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`COVER_SELECT_MODELS_STOPPED:${/^[A-Z0-9_]{1,150}$/u.test(String(error?.code || "")) ? error.code : "UNEXPECTED_LOCAL_FAILURE"}`); process.exitCode = 1; });
}
