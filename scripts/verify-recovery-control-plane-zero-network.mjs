#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DETACHED_SIGNATURE_SCHEMA, PROJECT_ID, TRUSTED_ISSUERS_SCHEMA, defaultReadiness, loadAndValidateCatalogSchema,
  sha256Buffer, sha256File, stableJson, validateSourceManifest,
} from "./recovery-export-v1.mjs";
import { runCosPlanCli } from "./recovery-cos-plan-v1.mjs";
import { runExportCli } from "./recovery-export-v1.mjs";
import { executeRestore, runRestoreCli, verifyBundle } from "./recovery-restore-v1.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-recovery-zero-network-"));
const roots = Object.fromEntries(["source", "public", "user", "output", "inputs", "evidence"].map((name) => [name, path.join(fixtureRoot, name)]));
Object.values(roots).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
function write(root, relative, bytes) { const target = path.join(root, ...relative.split("/")); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); return target; }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); return file; }
function argv(entries, execute = false, confirm = null) { const result = ["node", "fixture"]; for (const [key, value] of Object.entries(entries)) result.push(`--${key}`, String(value)); if (execute) result.push("--execute"); if (confirm) result.push("--confirm", confirm); return result; }
function expectFailure(label, action, pattern) { let error; try { action(); } catch (caught) { error = caught; } assert.ok(error, `${label} must fail closed`); if (pattern) assert.match(String(error.message), pattern, label); }

const environment = "fixture-recovery";
const sourceVersion = "R000977-test";
const gitCommit = "a".repeat(40);
const now = new Date();
const issuedAt = new Date(now.getTime() - 60_000).toISOString();
const expiresAt = new Date(now.getTime() + 60 * 60_000).toISOString();
const sourceBytes = Buffer.from("offline source fixture\n");
const publicBytes = Buffer.from("public fixture\n");
const userBytes = Buffer.from("user fixture\n");
write(roots.source, "app.txt", sourceBytes);
write(roots.public, "public/demo.png", publicBytes);
write(roots.user, "uploads/user.bin", userBytes);
const databasePackagePath = write(roots.inputs, "package.tar.gz.age", Buffer.from("encrypted-age-fixture"));

const publicManifest = { schemaVersion: 1, projectId: PROJECT_ID, kind: "public-assets", assetPolicySha256: sha256Buffer("asset-policy"), contentAddressing: "sha256-files-and-asset-policy", assetVersion: "", files: [{ path: "public/demo.png", bytes: publicBytes.length, sha256: sha256Buffer(publicBytes) }], fileCount: 1, totalBytes: publicBytes.length, digest: "", mutableUploadsIncluded: false };
publicManifest.digest = sha256Buffer(Buffer.from(`asset-policy-sha256  ${publicManifest.assetPolicySha256}\n${publicManifest.files[0].sha256}  public/demo.png\n`));
publicManifest.assetVersion = `sha256-${publicManifest.digest}`;
const publicManifestPath = writeJson(path.join(roots.inputs, "public-assets.v1.json"), publicManifest);
const sourceManifest = { schemaVersion: 1, projectId: PROJECT_ID, kind: "clean-source-snapshot", canonicalTextEol: "lf", policySha256: sha256Buffer("source-policy"), sourceFingerprint: sha256Buffer("source-fingerprint"), assetManifestSha256: sha256File(publicManifestPath), assetDigest: publicManifest.digest, assetVersion: publicManifest.assetVersion, fileCount: 1, totalBytes: sourceBytes.length, files: [{ path: "app.txt", bytes: sourceBytes.length, sha256: sha256Buffer(sourceBytes) }] };
const sourceManifestPath = writeJson(path.join(roots.inputs, "source-files.v1.json"), sourceManifest);
const sourceCommitReceiptPath = writeJson(path.join(roots.inputs, "source-commit-receipt.v1.json"), { schemaVersion: "zimeiti-source-commit-receipt.v1", projectId: PROJECT_ID, status: "VERIFIED", gitCommit, sourceVersion, sourceManifestSha256: sha256File(sourceManifestPath), verificationMode: "git-object-manifest-sha256", verifiedAt: issuedAt });
const readyReceipt = { schemaVersion: 1, projectId: PROJECT_ID, kind: "public-assets-readiness-receipt", status: "READY", assetVersion: publicManifest.assetVersion, assetDigest: publicManifest.digest, assetPolicySha256: publicManifest.assetPolicySha256, manifestSha256: sha256File(publicManifestPath), fileCount: 1, totalBytes: publicBytes.length, mutableUploadsIncluded: false, verificationMode: "full-sha256", storageBackend: "cos", location: `cos://fixture-bucket/assets/releases/${publicManifest.assetVersion}`, publisherId: "fixture-publisher", publisherProtocolVersion: 1, publisherScriptSha256: sha256Buffer("publisher"), remoteVerification: "full", remoteVerifiedFileCount: 1, remoteVerifiedTotalBytes: publicBytes.length, remoteContentTypeVerified: true, remoteCacheControlVerified: true, overwriteProtocol: "put-object-forbid-overwrite", publicationOrder: "assets-then-manifest-then-ready", verifiedAt: issuedAt };
const readyReceiptPath = writeJson(path.join(roots.inputs, "public-assets.ready.v1.json"), readyReceipt);
const userInventory = { schemaVersion: "zimeiti-user-object-inventory.v1", projectId: PROJECT_ID, environment, sourceVersion, snapshotAt: issuedAt, bucket: "user-assets-fixture-1250000000", accountId: "account-fixture", tenantId: "tenant-fixture", region: "ap-guangzhou", ownerId: "owner-fixture", databaseIdentity: "postgres-fixture-cluster", crossComponentConsistency: false, files: [{ relativePath: "uploads/user.bin", objectKey: "users/fixture/user.bin", versionId: "version-fixture-1", bytes: userBytes.length, sha256: sha256Buffer(userBytes) }], fileCount: 1, totalBytes: userBytes.length, digest: "" };
userInventory.digest = sha256Buffer(Buffer.from(`source-version  ${sourceVersion}\nsnapshot-at  ${userInventory.snapshotAt}\nbucket  ${userInventory.bucket}\naccount-id  ${userInventory.accountId}\ntenant-id  ${userInventory.tenantId}\nregion  ${userInventory.region}\nowner-id  ${userInventory.ownerId}\ndatabase-identity  ${userInventory.databaseIdentity}\n${userInventory.files[0].sha256}  ${userBytes.length}  version-fixture-1  users/fixture/user.bin  uploads/user.bin\n`));
const userInventoryPath = writeJson(path.join(roots.inputs, "user-object-inventory.v1.json"), userInventory);
const componentSnapshots = Array.from({ length: 8 }, (_, index) => ({ component: `component-${index}`, method: "fixture", startedEpoch: 1_760_000_000, completedEpoch: 1_760_000_001, consistency: "verified", sharedWithOtherComponents: false, evidenceSha256: sha256Buffer(`component-${index}`) }));
const databaseReceiptPath = writeJson(path.join(roots.inputs, "database-backup-receipt.v1.json"), { schemaVersion: "zimeiti-backup-receipt.v1", status: "complete", backupId: "backup-20261010T000000Z-1", sourceVersion, createdEpoch: 1_760_000_000, completedEpoch: 1_760_000_010, artifactCreationDurationSeconds: 10, oldestComponentAgeAtCompletionSeconds: 10, encryptedPackage: "package.tar.gz.age", encryptedSha256: sha256File(databasePackagePath), manifestSha256: sha256Buffer("backup-manifest"), componentSnapshots, sharedSnapshot: false, productionConsistency: "incomplete", productionConsistencyComplete: false, sourceTargetDisjoint: true, expectedDeviceVerified: true, plaintextFinalPackage: false, finalPackageHashVerified: true, manifestHashVerified: true, atomicCommit: true });

const baseOptions = { "source-root": roots.source, "source-manifest": sourceManifestPath, "source-commit-receipt": sourceCommitReceiptPath, "git-commit": gitCommit, "source-version": sourceVersion, environment, "public-root": roots.public, "public-manifest": publicManifestPath, "public-ready-receipt": readyReceiptPath, "user-root": roots.user, "user-inventory": userInventoryPath, "database-package": databasePackagePath, "database-receipt": databaseReceiptPath, "output-root": roots.output };
const blockedPlan = runExportCli(argv(baseOptions));
assert.equal(blockedPlan.readiness, "BLOCKED");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const fingerprint = sha256Buffer(publicKey.export({ type: "spki", format: "der" }));
const allowedEvidenceTypes = ["source-commit", "public-ready", "database-backup", "user-inventory", "cos-download", ...defaultReadiness(blockedPlan.recoveryBindingSha256, environment).checks.map((check) => `readiness:${check.id}`)];
const trustPath = writeJson(path.join(roots.inputs, "trusted-issuers.v1.json"), { schemaVersion: TRUSTED_ISSUERS_SCHEMA, projectId: PROJECT_ID, environment, issuers: [{ issuerId: "fixture-ca", publicKeyPem, publicKeyFingerprint: fingerprint, allowedEvidenceTypes }] });
const identity = { projectId: PROJECT_ID, environment, catalogBindingSha256: blockedPlan.recoveryBindingSha256, gitCommit, assetVersion: publicManifest.assetVersion, databaseIdentity: userInventory.databaseIdentity, accountId: userInventory.accountId, tenantId: userInventory.tenantId };
let sequence = 0;
function signBytes(file, bytes, evidenceType, overrides = {}) { sequence += 1; const envelope = { schemaVersion: DETACHED_SIGNATURE_SCHEMA, algorithm: "Ed25519", issuerId: "fixture-ca", publicKeyFingerprint: fingerprint, receiptId: `receipt-${sequence}`, nonce: `nonce-${sequence}`, issuedAt, expiresAt, evidenceType, targetSha256: sha256Buffer(bytes), ...identity, ...overrides }; envelope.signature = crypto.sign(null, Buffer.from(stableJson(envelope)), privateKey).toString("base64"); return writeJson(file, envelope); }
const sourceSignature = signBytes(path.join(roots.inputs, "source.sig.json"), fs.readFileSync(sourceCommitReceiptPath), "source-commit");
const publicSignature = signBytes(path.join(roots.inputs, "public.sig.json"), fs.readFileSync(readyReceiptPath), "public-ready");
const databaseSignature = signBytes(path.join(roots.inputs, "database.sig.json"), fs.readFileSync(databaseReceiptPath), "database-backup");
const userSignature = signBytes(path.join(roots.inputs, "user.sig.json"), fs.readFileSync(userInventoryPath), "user-inventory");
const trustOptions = { ...baseOptions, "trusted-issuers": trustPath, "source-signature": sourceSignature, "public-signature": publicSignature, "database-signature": databaseSignature, "user-signature": userSignature };

const drillSupport = writeJson(path.join(roots.evidence, "actual-empty-disk-drill.json"), { schemaVersion: "fixture-drill.v1", catalogBindingSha256: blockedPlan.recoveryBindingSha256, status: "complete", errors: 0 });
const reportSupport = writeJson(path.join(roots.evidence, "actual-zero-error-report.json"), { schemaVersion: "fixture-verification-report.v1", catalogBindingSha256: blockedPlan.recoveryBindingSha256, verificationErrors: 0 });
const semantics = {
  "primary-copy": ["primary-recovery-set", "account-primary", "ap-guangzhou", "owner-primary", "primary-cloud", "cloud-services", false, false, false],
  "offline-copy": ["offline-recovery-copy", "account-offline", "local-offline", "owner-offline", "offline-disk", "removable-storage", true, false, true],
  "independent-offsite-copy": ["offsite-immutable-copy", "account-offsite", "ap-shanghai", "owner-offsite", "offsite-cloud", "object-storage", false, true, true],
  "two-failure-domains": ["failure-domain-audit", "account-audit-a", "audit-region-a", "owner-audit-a", "audit-domain-a", "audit", false, true, true],
  "offline-or-immutable": ["offline-or-immutable-audit", "account-audit-b", "audit-region-b", "owner-audit-b", "audit-domain-b", "audit", false, true, true],
  "empty-disk-drill": ["empty-disk-drill", "account-drill", "isolated-region", "owner-drill", "drill-domain", "isolated-restore", true, false, true],
  "zero-verification-errors": ["verification-summary", "account-zero", "audit-region-zero", "owner-zero", "audit-domain-zero", "audit", false, true, true],
};
function materializeReadiness(document, ownerOverride = null, dateOverride = null) {
  for (const check of document.checks) {
    const [targetId, accountOrTenant, region, ownerId, failureDomain, mediaType, offline, immutable, independentFromPrimary] = semantics[check.id];
    const support = check.id === "empty-disk-drill" ? drillSupport : check.id === "zero-verification-errors" ? reportSupport : null;
    const item = { schemaVersion: "zimeiti-recovery-readiness-item.v1", projectId: PROJECT_ID, checkId: check.id, status: "VERIFIED", environment, recoveryBindingSha256: blockedPlan.recoveryBindingSha256, targetId, observedAt: dateOverride || issuedAt, accountOrTenant, region, ownerId: ownerOverride && check.id === "offline-copy" ? ownerOverride : ownerId, failureDomain, mediaType, offline, immutable, independentFromPrimary, verificationErrors: 0, drillReceiptSha256: check.id === "empty-disk-drill" ? sha256File(drillSupport) : null, verificationReportSha256: check.id === "zero-verification-errors" ? sha256File(reportSupport) : null, supportingEvidencePath: support ? `evidence/${path.basename(support)}` : null, supportingEvidenceSha256: support ? sha256File(support) : null };
    const itemPath = writeJson(path.join(roots.evidence, `${check.id}.json`), item);
    const signaturePath = signBytes(path.join(roots.evidence, `${check.id}.sig.json`), fs.readFileSync(itemPath), `readiness:${check.id}`);
    Object.assign(check, { verified: true, evidencePath: `evidence/${check.id}.json`, evidenceSha256: sha256File(itemPath), signaturePath: `evidence/${check.id}.sig.json`, signatureSha256: sha256File(signaturePath), issuerFingerprint: fingerprint });
  }
  return writeJson(path.join(roots.inputs, `readiness-${crypto.randomUUID()}.json`), document);
}
const readiness = defaultReadiness(blockedPlan.recoveryBindingSha256, environment);
const readinessPath = materializeReadiness(readiness);
const readyOptions = { ...trustOptions, "readiness-evidence": readinessPath, "readiness-evidence-root": roots.evidence };
const readyPlan = runExportCli(argv(readyOptions));
assert.equal(readyPlan.readiness, "READY");
const signedOutput = path.join(fixtureRoot, "signed-output"); fs.mkdirSync(signedOutput);
const signedExecuted = runExportCli(argv({ ...readyOptions, "output-root": signedOutput }, true, readyPlan.catalogSha256));
assert.equal(verifyBundle(signedExecuted.finalRoot).catalog.readiness.status, "READY");

const forged = JSON.parse(fs.readFileSync(path.join(roots.evidence, "primary-copy.sig.json"))); forged.signature = Buffer.from("forged").toString("base64");
const forgedPath = writeJson(path.join(roots.evidence, "primary-copy-forged.sig.json"), forged);
const forgedReadiness = structuredClone(readiness); forgedReadiness.checks[0].signaturePath = `evidence/${path.basename(forgedPath)}`; forgedReadiness.checks[0].signatureSha256 = sha256File(forgedPath);
expectFailure("forged signature", () => runExportCli(argv({ ...trustOptions, "readiness-evidence": writeJson(path.join(roots.inputs, "forged-readiness.json"), forgedReadiness), "readiness-evidence-root": roots.evidence })), /signature verification failed/u);
const expiredSignature = signBytes(path.join(roots.inputs, "expired.sig.json"), fs.readFileSync(sourceCommitReceiptPath), "source-commit", { issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z" });
expectFailure("expired signature", () => runExportCli(argv({ ...trustOptions, "source-signature": expiredSignature })), /expired|too old/u);
const replaySignature = signBytes(path.join(roots.inputs, "replay.sig.json"), fs.readFileSync(readyReceiptPath), "public-ready", { receiptId: "receipt-1", nonce: "nonce-1" });
expectFailure("signature replay", () => runExportCli(argv({ ...trustOptions, "public-signature": replaySignature })), /replay/u);
const commonOwnerPath = materializeReadiness(defaultReadiness(blockedPlan.recoveryBindingSha256, environment), "owner-primary");
expectFailure("common owner", () => runExportCli(argv({ ...trustOptions, "readiness-evidence": commonOwnerPath, "readiness-evidence-root": roots.evidence })), /independent failure domains/u);
const dateOnlyPath = materializeReadiness(defaultReadiness(blockedPlan.recoveryBindingSha256, environment), null, "2026-10-10");
expectFailure("date-only", () => runExportCli(argv({ ...trustOptions, "readiness-evidence": dateOnlyPath, "readiness-evidence-root": roots.evidence })), /semantic mismatch|date-time/u);

const executed = runExportCli(argv(baseOptions, true, blockedPlan.catalogSha256));
expectFailure("no replace", () => runExportCli(argv(baseOptions, true, blockedPlan.catalogSha256)), /already exists/u);
const catalog = JSON.parse(fs.readFileSync(path.join(executed.finalRoot, "metadata", "recovery-catalog.v1.json"))); catalog.source.totalBytes = 0;
expectFailure("schema minimum", () => loadAndValidateCatalogSchema(catalog), /must be >= 1/u);
catalog.createdAt = "2026-10-10";
expectFailure("strict date-time", () => loadAndValidateCatalogSchema(catalog), /date-time/u);
const wrongDbBundle = path.join(fixtureRoot, "wrong-db-bundle"); fs.cpSync(executed.finalRoot, wrongDbBundle, { recursive: true });
const wrongDbPath = path.join(wrongDbBundle, "metadata", "recovery-catalog.v1.json"); const wrongDb = JSON.parse(fs.readFileSync(wrongDbPath)); wrongDb.databaseBackup.databaseIdentity = "wrong-cluster"; writeJson(wrongDbPath, wrongDb);
expectFailure("wrong database", () => verifyBundle(wrongDbBundle), /binding mismatch|catalogSha256|schema/u);

const target = path.join(fixtureRoot, "restore-success"); fs.mkdirSync(target); const restorePlan = runRestoreCli(argv({ bundle: executed.finalRoot, target })); runRestoreCli(argv({ bundle: executed.finalRoot, target }, true, restorePlan.catalogSha256));
const verified = verifyBundle(executed.finalRoot);
const raceTarget = path.join(fixtureRoot, "restore-race"); fs.mkdirSync(raceTarget);
expectFailure("blank target race", () => executeRestore(verified, raceTarget, verified.catalogSha256, { beforeCommit: ({ target: root }) => write(root, "intruder.txt", "race") }), /target changed/u);
const tamperTarget = path.join(fixtureRoot, "restore-tamper"); fs.mkdirSync(tamperTarget);
expectFailure("post rename database tamper", () => executeRestore(verified, tamperTarget, verified.catalogSha256, { afterCommit: ({ finalRoot }) => fs.appendFileSync(path.join(finalRoot, "database", "package.tar.gz.age"), "tamper") }), /package hash mismatch|encrypted package binding/u);

const malicious = structuredClone(userInventory); malicious.files[0].relativePath = "../escape";
expectFailure("path traversal", () => runExportCli(argv({ ...baseOptions, "user-inventory": writeJson(path.join(roots.inputs, "malicious.json"), malicious) })), /unsafe segment/u);
const zeroSource = structuredClone(sourceManifest); zeroSource.files[0].bytes = 0; zeroSource.files[0].sha256 = sha256Buffer(Buffer.alloc(0)); zeroSource.totalBytes = 0;
expectFailure("zero source", () => validateSourceManifest(zeroSource), /totals/u);

let symlinkSwap = "unsupported-by-host";
const swapOutput = path.join(fixtureRoot, "swap-output"); fs.mkdirSync(swapOutput);
const originalReadSync = fs.readSync; let swapped = false;
fs.readSync = function guardedRead(descriptor, ...rest) { const result = originalReadSync.call(fs, descriptor, ...rest); if (!swapped && result > 0) { swapped = true; const original = path.join(roots.source, "app.txt"); const moved = path.join(roots.source, "app-original.txt"); fs.renameSync(original, moved); try { fs.symlinkSync(moved, original, "file"); symlinkSwap = "passed"; } catch { fs.copyFileSync(moved, original); } } return result; };
try { expectFailure("symlink swap", () => runExportCli(argv({ ...baseOptions, "output-root": swapOutput }, true, blockedPlan.catalogSha256)), /swap|mismatch|symbolic link/u); } finally { fs.readSync = originalReadSync; }

Object.assign(process.env, { RECOVERY_PUBLIC_COS_BUCKET: "fixture-bucket", RECOVERY_USER_COS_BUCKET: userInventory.bucket, RECOVERY_USER_ACCOUNT_ID: userInventory.accountId, RECOVERY_USER_TENANT_ID: userInventory.tenantId, RECOVERY_USER_REGION: userInventory.region, RECOVERY_USER_OWNER_ID: userInventory.ownerId, RECOVERY_DATABASE_IDENTITY: userInventory.databaseIdentity });
const cosOptions = { "public-manifest": publicManifestPath, "public-ready-receipt": readyReceiptPath, "user-inventory": userInventoryPath, "source-version": sourceVersion, "git-commit": gitCommit, "catalog-binding": blockedPlan.recoveryBindingSha256, environment, "trusted-issuers": trustPath, "public-signature": publicSignature, "user-signature": userSignature };
const cosPlan = runCosPlanCli(argv(cosOptions));
const downloadRoot = path.join(fixtureRoot, "downloads"); for (const item of cosPlan.plan.items) write(downloadRoot, item.relativePath, item.class === "public-assets" ? publicBytes : userBytes);
const downloadReceiptPath = writeJson(path.join(roots.inputs, "download.json"), { schemaVersion: "zimeiti-coscli-download-receipt.v1", projectId: PROJECT_ID, status: "complete", planSha256: cosPlan.planSha256, networkTool: "official-coscli", publicBucket: cosPlan.plan.publicBucket, userStorageIdentity: cosPlan.plan.userStorageIdentity, items: cosPlan.plan.items.map((item) => ({ bucket: item.bucket, relativePath: item.relativePath, objectKey: item.objectKey, observedVersion: item.expectedVersion, bytes: item.bytes, sha256: item.sha256 })) });
const downloadSignature = signBytes(path.join(roots.inputs, "download.sig.json"), fs.readFileSync(downloadReceiptPath), "cos-download");
assert.equal(runCosPlanCli(argv({ ...cosOptions, "download-root": downloadRoot, "download-receipt": downloadReceiptPath, "download-signature": downloadSignature, "trusted-issuers": trustPath })).verification.detachedSignatureVerified, true);
for (const script of ["recovery-export-v1.mjs", "recovery-cos-plan-v1.mjs", "recovery-restore-v1.mjs"]) { const text = fs.readFileSync(path.join(scriptRoot, script), "utf8"); assert.doesNotMatch(text, /from\s+["']node:(?:http|https|net|tls|dns)["']/u); assert.doesNotMatch(text, /\bfetch\s*\(/u); }
console.log(JSON.stringify({ ok: true, networkAccessed: false, productionWithoutTrustedKey: "BLOCKED", signedFixtureReady: true, forgedSignatureRejected: true, expiredSignatureRejected: true, replayRejected: true, commonOwnerRejected: true, wrongDatabaseRejected: true, dateOnlyRejected: true, fullTreePreAndPostCommitVerified: true, blankTargetRaceRejected: true, renameAfterDatabaseTamperRejected: true, noReplaceRejected: true, symlinkSwap, cosDownloadSignatureVerified: true, realCosExecuted: false, realEmptyDiskDrillExecuted: false, productionReadiness: "BLOCKED", fixtureRoot }, null, 2));
