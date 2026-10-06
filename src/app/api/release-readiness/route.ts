import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { NextResponse } from "next/server";
import {
  resolveAppDataDir,
  resolveAppRuntimeDir,
  resolveBackupDir,
  resolveIdempotencyDir,
} from "@/lib/runtime-paths";
import { probeProductionDatabaseReadiness } from "@/lib/production-database-readiness";
import { probeProductionReferenceDataReadiness } from "@/lib/production-reference-data-readiness";
import { resolveVoiceSqlitePath } from "@/lib/voice-studio/database-path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const REQUIRED_DATA_FILES = [
  "engine-configs.json",
  "custom-voices.json",
  "service-cards.json",
  "studio-config.json",
  "voices.json",
  "voice-studio/service-cards.json",
  "voice-studio/voices.json",
] as const;
const PROJECT_ID = "zimeiti-caopanshou";

function sha256File(filePath: string) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(/* turbopackIgnore: true */ filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function requireDirectory(environmentName: string, writable = true) {
  const configured = process.env[environmentName]?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${environmentName} must be an absolute path`);
  const resolved = path.resolve(/* turbopackIgnore: true */ configured);
  const linkStats = fs.lstatSync(/* turbopackIgnore: true */ resolved);
  if (linkStats.isSymbolicLink()) throw new Error(`${environmentName} cannot be a symbolic link`);
  if (!linkStats.isDirectory()) throw new Error(`${environmentName} must be a directory`);
  fs.accessSync(/* turbopackIgnore: true */ resolved, writable ? fs.constants.R_OK | fs.constants.W_OK : fs.constants.R_OK);
  return resolved;
}

function readAssetReceipt(publicAssetRoot: string) {
  const releaseRoot = path.dirname(/* turbopackIgnore: true */ publicAssetRoot);
  const receiptPath = path.join(/* turbopackIgnore: true */ releaseRoot, ".release", "public-assets.ready.v1.json");
  const manifestPath = path.join(/* turbopackIgnore: true */ releaseRoot, ".release", "public-assets.v1.json");
  for (const metadataPath of [receiptPath, manifestPath]) {
    const stats = fs.lstatSync(/* turbopackIgnore: true */ metadataPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("asset release metadata must be a real file");
  }
  const receipt = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ receiptPath, "utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ manifestPath, "utf8")) as Record<string, unknown>;
  const expectedDigest = process.env.ASSET_DIGEST?.trim();
  const expectedManifestSha = process.env.ASSET_MANIFEST_SHA256?.trim();
  if (!expectedDigest || !/^[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error("ASSET_DIGEST is invalid");
  if (!expectedManifestSha || !/^[0-9a-f]{64}$/u.test(expectedManifestSha)) throw new Error("ASSET_MANIFEST_SHA256 is invalid");
  if (
    manifest.schemaVersion !== 1
    || manifest.projectId !== PROJECT_ID
    || manifest.kind !== "public-assets"
    || manifest.contentAddressing !== "sha256-files-and-asset-policy"
    || typeof manifest.assetPolicySha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(manifest.assetPolicySha256)
    || manifest.digest !== expectedDigest
    || manifest.assetVersion !== `sha256-${expectedDigest}`
    || manifest.mutableUploadsIncluded !== false
    || !Number.isSafeInteger(manifest.fileCount)
    || !Number.isSafeInteger(manifest.totalBytes)
    || !Array.isArray(manifest.files)
    || manifest.files.length !== manifest.fileCount
  ) throw new Error("asset manifest contract mismatch");
  const manifestFiles = manifest.files as Array<Record<string, unknown>>;
  let declaredTotalBytes = 0;
  const declaredPaths = new Set<string>();
  for (const file of manifestFiles) {
    const assetPath = typeof file.path === "string" ? file.path : "";
    if (
      !assetPath.startsWith("public/")
      || assetPath.includes("../")
      || declaredPaths.has(assetPath)
      || !Number.isSafeInteger(file.bytes)
      || Number(file.bytes) < 0
      || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) throw new Error("asset manifest file entry is invalid");
    declaredPaths.add(assetPath);
    declaredTotalBytes += Number(file.bytes);
  }
  if (declaredTotalBytes !== manifest.totalBytes) throw new Error("asset manifest totalBytes mismatch");
  if (
    receipt.schemaVersion !== 1
    || receipt.projectId !== PROJECT_ID
    || receipt.kind !== "public-assets-readiness-receipt"
    || receipt.status !== "READY"
    || receipt.assetDigest !== expectedDigest
    || receipt.assetVersion !== `sha256-${expectedDigest}`
    || receipt.fileCount !== manifest.fileCount
    || receipt.totalBytes !== manifest.totalBytes
    || receipt.mutableUploadsIncluded !== false
    || receipt.verificationMode !== "full-sha256"
    || !["disk", "cos"].includes(String(receipt.storageBackend || ""))
    || typeof receipt.location !== "string"
    || !receipt.location
    || typeof receipt.verifiedAt !== "string"
    || Number.isNaN(Date.parse(receipt.verifiedAt))
  ) throw new Error("asset readiness receipt contract mismatch");
  if (receipt.manifestSha256 !== expectedManifestSha || sha256File(manifestPath) !== expectedManifestSha) {
    throw new Error("asset manifest sha256 mismatch");
  }
  return {
    digest: expectedDigest,
    version: receipt.assetVersion,
    files: receipt.fileCount,
    bytes: receipt.totalBytes,
  };
}

export async function GET() {
  const checks: Record<string, unknown> = {};
  try {
    if (process.env.NODE_ENV !== "production" || process.env.COZE_PROJECT_ENV !== "PROD") {
      throw new Error("release readiness is only valid in production mode");
    }
    const releaseId = process.env.RELEASE_ID?.trim();
    const commitSha = process.env.DEPLOY_COMMIT_SHA?.trim().toLowerCase();
    if (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u.test(releaseId)) throw new Error("RELEASE_ID is invalid");
    if (!commitSha || !/^[0-9a-f]{40,64}$/u.test(commitSha)) throw new Error("DEPLOY_COMMIT_SHA is invalid");
    const buildId = process.env.EXPECTED_BUILD_ID?.trim();
    if (!buildId || !/^[A-Za-z0-9._-]{1,256}$/u.test(buildId)) throw new Error("EXPECTED_BUILD_ID is invalid");

    const databaseReadiness = await probeProductionDatabaseReadiness();
    checks.database = {
      state: databaseReadiness.state,
      contractId: databaseReadiness.contractId,
      contractVersion: databaseReadiness.contractVersion,
      tableCount: databaseReadiness.tableCount,
      rpcCount: databaseReadiness.rpcCount,
      missingTableCount: databaseReadiness.missingTables.length,
      missingColumnCount: databaseReadiness.missingColumns.length,
      missingRpcCount: databaseReadiness.missingRpcs.length,
      missingRpcArgumentCount: databaseReadiness.missingRpcArguments.length,
      forbiddenRpcCount: databaseReadiness.forbiddenRpcsPresent.length,
    };
    if (!databaseReadiness.ok) {
      throw new Error(`production database contract is not ready: ${databaseReadiness.code}`);
    }

    const referenceDataReadiness = await probeProductionReferenceDataReadiness();
    checks.referenceData = {
      state: referenceDataReadiness.state,
      voiceActivePriceCount: referenceDataReadiness.voiceActivePriceCount,
      manjuRequiredDomainCount: referenceDataReadiness.manjuRequiredDomainCount,
      manjuReadyDomainCount: referenceDataReadiness.manjuReadyDomainCount,
      missingManjuDomainCount: referenceDataReadiness.missingManjuDomains.length,
      serviceRoleConfigured: referenceDataReadiness.serviceRoleConfigured,
      manjuStorageReadyDomainCount: referenceDataReadiness.manjuStorageReadyDomainCount,
      missingManjuStorageDomainCount: referenceDataReadiness.missingManjuStorageDomains.length,
      videoHealthProtocolVersion: referenceDataReadiness.videoHealthProtocolVersion,
      activeVideoModelCount: referenceDataReadiness.activeVideoModelCount,
      verifiedVideoModelCount: referenceDataReadiness.verifiedVideoModelCount,
      unverifiedVideoModelCount: referenceDataReadiness.unverifiedVideoModelIds.length,
    };
    if (!referenceDataReadiness.ok) {
      throw new Error(`production reference data is not ready: ${referenceDataReadiness.code}`);
    }

    const dataRoot = resolveAppDataDir();
    const dataFiles: Record<string, { bytes: number; sha256: string; records: number | null }> = {};
    for (const relativePath of REQUIRED_DATA_FILES) {
      const filePath = path.resolve(/* turbopackIgnore: true */ dataRoot, relativePath);
      if (!filePath.startsWith(`${dataRoot}${path.sep}`)) throw new Error(`invalid runtime data path: ${relativePath}`);
      const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as unknown;
      const stats = fs.statSync(/* turbopackIgnore: true */ filePath);
      dataFiles[relativePath] = {
        bytes: stats.size,
        sha256: sha256File(filePath),
        records: Array.isArray(parsed) ? parsed.length : null,
      };
    }
    checks.data = { files: dataFiles };

    const runtimeRoot = resolveAppRuntimeDir();
    const idempotencyRoot = resolveIdempotencyDir();
    const backupRoot = resolveBackupDir();
    checks.runtime = { runtimeRoot: path.basename(runtimeRoot), idempotencyReady: Boolean(idempotencyRoot), backupReady: Boolean(backupRoot) };

    const uploadRoot = requireDirectory("STORAGE_LOCAL_BASE_PATH");
    const referenceAudioRoot = requireDirectory("VOICE_REFERENCE_AUDIO_DIR");
    const publicAssetRoot = requireDirectory("PUBLIC_ASSET_ROOT", false);
    checks.storage = {
      uploadsReady: Boolean(uploadRoot),
      referenceAudioReady: Boolean(referenceAudioRoot),
      assets: readAssetReceipt(publicAssetRoot),
    };

    const voiceDatabasePath = resolveVoiceSqlitePath();
    const voiceStats = fs.statSync(/* turbopackIgnore: true */ voiceDatabasePath);
    if (!voiceStats.isFile() || voiceStats.size <= 0) throw new Error("voice database is empty");
    const voiceDatabase = new Database(voiceDatabasePath, { readonly: true, fileMustExist: true });
    try {
      const quickCheck = voiceDatabase.pragma("quick_check", { simple: true });
      if (quickCheck !== "ok") throw new Error(`voice database quick_check failed: ${String(quickCheck)}`);
      const voiceCount = (voiceDatabase.prepare("SELECT COUNT(*) AS count FROM Voice").get() as { count: number }).count;
      checks.voiceDatabase = { bytes: voiceStats.size, voices: voiceCount, quickCheck: "ok" };
    } finally {
      voiceDatabase.close();
    }

    return NextResponse.json({
      ready: true,
      service: "web",
      releaseId,
      commitSha,
      buildId,
      assetDigest: process.env.ASSET_DIGEST,
      checks,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      ready: false,
      service: "web",
      releaseId: process.env.RELEASE_ID || null,
      commitSha: process.env.DEPLOY_COMMIT_SHA || null,
      buildId: null,
      code: "RELEASE_NOT_READY",
      error: error instanceof Error ? error.message : String(error),
      checks,
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
