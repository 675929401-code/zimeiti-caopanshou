#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertJsonSchema, canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";
import { assertDescriptor, verifyPackage, verifyCandidatePackage } from "./deployment-control-plane.mjs";

const BUNDLE_SCHEMA_VERSION = "zimeiti-release-change-validation-bundle.v1";
const AUTOMATED_REQUIRED = Object.freeze([
  "credential-scan",
  "source-integrity",
  "diff-check",
  "build",
  "build-identity",
]);
const EXTERNAL_BROWSER_REQUIRED = Object.freeze([
  "desktop-precise-route-visual-1440x900",
  "desktop-two-adjacent-pages-visual",
  "console-and-request-errors",
]);

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("ARGUMENT_NAME_REQUIRED");
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.set(token, next);
      index += 1;
    } else {
      parsed.set(token, "1");
    }
  }
  return parsed;
}

function strictRelativePath(candidate, code = "UNSAFE_RELATIVE_PATH") {
  if (typeof candidate !== "string" || candidate.length === 0) throw new Error(code);
  if (/[\\\u0000-\u001f\u007f]|\p{Bidi_Control}/u.test(candidate)) throw new Error(code);
  if (candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) throw new Error(code);
  const parts = candidate.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(code);
  if (path.posix.normalize(candidate) !== candidate) throw new Error(code);
  return candidate;
}

function resolveWithin(root, relative, code = "PATH_OUTSIDE_ROOT") {
  const safe = strictRelativePath(relative, code);
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) throw new Error(code);
  const realRoot = fs.realpathSync.native(absoluteRoot);
  const absolute = path.resolve(absoluteRoot, ...safe.split("/"));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error(code);
  let cursor = absoluteRoot;
  for (const segment of safe.split("/")) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) break;
    const real = fs.realpathSync.native(cursor);
    const relativeReal = path.relative(realRoot, real);
    if (relativeReal === "" || (!relativeReal.startsWith(`..${path.sep}`) && relativeReal !== ".." && !path.isAbsolute(relativeReal))) continue;
    throw new Error(code);
  }
  return absolute;
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(code);
  }
}

function writeAtomic(filePath, body) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (!fs.existsSync(absolute)) {
    fs.renameSync(temporary, absolute);
    return;
  }
  const previous = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.previous`);
  fs.renameSync(absolute, previous);
  try {
    fs.renameSync(temporary, absolute);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(absolute) && fs.existsSync(previous)) fs.renameSync(previous, absolute);
    throw error;
  }
  fs.rmSync(previous, { force: true });
}

function summary(attestations) {
  return {
    requiredCount: attestations.length,
    passedCount: attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: attestations.filter((entry) => entry.status === "failed").length,
  };
}

function bundleId(bundle) {
  const payload = { ...bundle };
  delete payload.bundleId;
  return `validation-${sha256(canonicalJson(payload)).slice(0, 24)}`;
}

function assertBundleSemantic(bundle) {
  if (bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw new Error("BUNDLE_SCHEMA_VERSION_INVALID");
  if (bundle.bundleId !== bundleId(bundle)) throw new Error("BUNDLE_ID_MISMATCH");
  const required = [...bundle.scope.requiredValidations].sort((left, right) => left.localeCompare(right));
  const ids = bundle.attestations.map((entry) => entry.validationId).sort((left, right) => left.localeCompare(right));
  if (canonicalJson(ids) !== canonicalJson(required)) throw new Error("BUNDLE_ATTESTATION_SET_MISMATCH");
  if (new Set(ids).size !== ids.length) throw new Error("BUNDLE_DUPLICATE_ATTESTATION");
  if (canonicalJson(bundle.summary) !== canonicalJson(summary(bundle.attestations))) throw new Error("BUNDLE_SUMMARY_MISMATCH");
  const sortedServices = [...bundle.subject.services].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(bundle.subject.services) !== canonicalJson(sortedServices)) throw new Error("BUNDLE_SERVICES_NOT_SORTED");
  if (!bundle.subject.services.includes("web")) throw new Error("BUNDLE_WEB_BUILD_REQUIRED_FOR_BROWSER_ACCEPTANCE");
  if (bundle.subject.controlPlane !== null) {
    assertDescriptor(bundle.subject.controlPlane);
    if (bundle.subject.controlPlane.subject.mode !== "formal"
      || bundle.subject.controlPlane.subject.sourceCommit !== bundle.subject.commit) throw new Error("CONTROL_PLANE_CANDIDATE_SUBJECT_MISMATCH");
  }
  const sortedRoutes = [...bundle.scope.browserAcceptance.requiredRoutes].sort((left, right) => left.localeCompare(right));
  if (canonicalJson(bundle.scope.browserAcceptance.requiredRoutes) !== canonicalJson(sortedRoutes)
    || new Set(sortedRoutes).size !== sortedRoutes.length || sortedRoutes.length < 3) throw new Error("BUNDLE_BROWSER_ROUTES_INVALID");
  if (!sortedRoutes.includes(bundle.scope.browserAcceptance.preciseRoute)) throw new Error("BUNDLE_PRECISE_ROUTE_INVALID");
  for (const service of ["web", "voice"]) {
    if ((bundle.subject.builds[service] === null) !== (bundle.subject.buildOutputDigests[service] === null)) {
      throw new Error("BUNDLE_BUILD_DIGEST_PAIR_INVALID");
    }
    if (!bundle.subject.services.includes(service) && bundle.subject.candidatePayloads[service] !== null) {
      throw new Error("BUNDLE_UNREQUESTED_CANDIDATE_PAYLOAD");
    }
  }
  for (const entry of bundle.attestations) {
    const hasEvidence = entry.evidenceRef !== null || entry.evidenceSha256 !== null;
    const hasSignature = entry.signatureRef !== null || entry.signatureSha256 !== null;
    if (entry.status === "passed") {
      if (entry.executor === "unassigned" || !entry.evidenceRef || !entry.evidenceSha256) {
        throw new Error("PASSED_ATTESTATION_EVIDENCE_REQUIRED");
      }
      strictRelativePath(entry.evidenceRef, "ATTESTATION_EVIDENCE_REF_UNSAFE");
      if (entry.executor === "external-browser") {
        if (!entry.signatureRef || !entry.signatureSha256) throw new Error("BROWSER_ATTESTATION_SIGNATURE_REQUIRED");
        strictRelativePath(entry.signatureRef, "ATTESTATION_SIGNATURE_REF_UNSAFE");
      } else if (hasSignature) throw new Error("NON_BROWSER_ATTESTATION_SIGNATURE_FORBIDDEN");
    } else if (hasEvidence || hasSignature || entry.executor !== "unassigned") {
      throw new Error("NON_PASSED_ATTESTATION_MUST_BE_UNASSIGNED");
    }
  }
}

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("TRUSTED_ISSUER_KEY_NOT_ED25519");
  return sha256(key.export({ type: "spki", format: "der" }));
}

function loadContract(root, name, code) {
  return readJson(path.join(root, "scripts", "contracts", name), code);
}

function validateCredentialReceipt(bundle, receipt, schema) {
  assertJsonSchema(schema, receipt, "SECRET_SCAN_RECEIPT_SCHEMA_INVALID");
  if (receipt.status !== "PASS" || receipt.mode !== "release-candidate" || receipt.candidate.cleanRequired !== true) {
    throw new Error("SECRET_SCAN_DID_NOT_PASS_CLEAN_CANDIDATE");
  }
  if (receipt.candidate.commit !== bundle.subject.commit) throw new Error("SECRET_SCAN_COMMIT_MISMATCH");
  if (receipt.scopeReceiptId !== bundle.scope.receiptId || receipt.scopeReceiptSha256 !== bundle.scope.receiptSha256) {
    throw new Error("SECRET_SCAN_SCOPE_RECEIPT_MISMATCH");
  }
  if (bundle.scope.input.kind !== "git-range"
    || receipt.gitHistory.base !== bundle.scope.input.base
    || receipt.gitHistory.head !== bundle.scope.input.head
    || receipt.gitHistory.includeBase !== !bundle.scope.input.trustedBase) {
    throw new Error("SECRET_SCAN_HISTORY_RANGE_MISMATCH");
  }
}

function validateTargetedRegressionReceipt(bundle, receipt, schema) {
  assertJsonSchema(schema, receipt, "TARGETED_REGRESSION_RECEIPT_SCHEMA_INVALID");
  if (receipt.scopeReceiptId !== bundle.scope.receiptId
    || receipt.scopeReceiptSha256 !== bundle.scope.receiptSha256
    || receipt.subjectCommit !== bundle.subject.commit
    || receipt.classification !== "FAST"
    || receipt.result !== "passed") throw new Error("TARGETED_REGRESSION_RECEIPT_BINDING_MISMATCH");
}

function copyVerifiedEvidence(sourceFile, targetRoot, targetRef) {
  if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile()) throw new Error("ATTESTATION_SOURCE_EVIDENCE_MISSING");
  const body = fs.readFileSync(sourceFile);
  const target = resolveWithin(targetRoot, targetRef, "ATTESTATION_EVIDENCE_PATH_UNSAFE");
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(body)) throw new Error("ATTESTATION_EVIDENCE_ALREADY_DIFFERS");
  } else {
    fs.copyFileSync(sourceFile, target, fs.constants.COPYFILE_EXCL);
  }
  return { body, sha256: sha256(body) };
}

function loadBundle(bundlePath, schema) {
  const bundle = readJson(bundlePath, "BUNDLE_JSON_INVALID");
  assertJsonSchema(schema, bundle, "BUNDLE_JSON_SCHEMA_INVALID");
  assertBundleSemantic(bundle);
  return bundle;
}

function saveBundle(bundlePath, schema, bundle) {
  bundle.attestations.sort((left, right) => left.validationId.localeCompare(right.validationId));
  bundle.summary = summary(bundle.attestations);
  bundle.bundleId = bundleId({ ...bundle, bundleId: "validation-placeholder" });
  assertJsonSchema(schema, bundle, "BUNDLE_JSON_SCHEMA_INVALID");
  assertBundleSemantic(bundle);
  writeAtomic(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
}

function verifyScopeReceipt(root, scopeReceiptPath, args) {
  const classifierPath = path.join(root, "scripts", "classify-release-change-scope.mjs");
  const classifierArgs = [classifierPath, "--root", root, "--verify-receipt", scopeReceiptPath, "--quiet"];
  if (args.has("--scope-policy")) classifierArgs.push("--policy", args.get("--scope-policy"));
  if (args.has("--scope-schema")) classifierArgs.push("--schema", args.get("--scope-schema"));
  try {
    execFileSync(process.execPath, classifierArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("SCOPE_RECEIPT_VALIDATION_FAILED");
  }
  return readJson(scopeReceiptPath, "SCOPE_RECEIPT_JSON_INVALID");
}

function evidenceFileName(validationId) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(validationId)) throw new Error("VALIDATION_ID_UNSAFE");
  return `${validationId}.json`;
}

function validateEvidence(bundle, evidenceRoot) {
  for (const entry of bundle.attestations.filter((item) => item.status === "passed")) {
    const evidencePath = resolveWithin(evidenceRoot, entry.evidenceRef, "ATTESTATION_EVIDENCE_PATH_UNSAFE");
    if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) throw new Error("ATTESTATION_EVIDENCE_MISSING");
    if (sha256(fs.readFileSync(evidencePath)) !== entry.evidenceSha256) throw new Error("ATTESTATION_EVIDENCE_SHA256_MISMATCH");
    if (entry.signatureRef) {
      const signaturePath = resolveWithin(evidenceRoot, entry.signatureRef, "ATTESTATION_SIGNATURE_PATH_UNSAFE");
      if (!fs.existsSync(signaturePath) || !fs.statSync(signaturePath).isFile()) throw new Error("ATTESTATION_SIGNATURE_MISSING");
      if (sha256(fs.readFileSync(signaturePath)) !== entry.signatureSha256) throw new Error("ATTESTATION_SIGNATURE_SHA256_MISMATCH");
    }
  }
}

function recordPassed(bundle, validationId, executor, evidenceRoot, evidenceLabel, evidenceFile, contracts) {
  const entry = bundle.attestations.find((item) => item.validationId === validationId);
  if (!entry) return false;
  if (!new Set(["ci", "external-browser", "external-verifier"]).has(executor)) throw new Error("ATTESTATION_EXECUTOR_INVALID");
  const ref = evidenceFileName(validationId);
  if (evidenceFile) {
    const source = fs.realpathSync.native(path.resolve(evidenceFile));
    const receipt = readJson(source, "ATTESTATION_SOURCE_EVIDENCE_JSON_INVALID");
    if (validationId === "credential-scan") validateCredentialReceipt(bundle, receipt, contracts.secretScan);
    else if (validationId === "targeted-zero-network-regression") validateTargetedRegressionReceipt(bundle, receipt, contracts.targetedRegression);
    else throw new Error("EXTERNAL_EVIDENCE_FILE_NOT_ALLOWED_FOR_VALIDATION");
    const copied = copyVerifiedEvidence(source, evidenceRoot, ref);
    entry.status = "passed";
    entry.executor = executor;
    entry.evidenceRef = ref;
    entry.evidenceSha256 = copied.sha256;
    entry.signatureRef = null;
    entry.signatureSha256 = null;
    return true;
  }
  if (validationId === "credential-scan" || validationId === "targeted-zero-network-regression") {
    throw new Error("VALIDATION_REQUIRES_MACHINE_RECEIPT");
  }
  if (typeof evidenceLabel !== "string" || !evidenceLabel || /[\u0000-\u001f\u007f]/u.test(evidenceLabel)) throw new Error("ATTESTATION_EVIDENCE_LABEL_INVALID");
  const evidence = {
    schemaVersion: "zimeiti-release-change-validation-evidence.v1",
    scopeReceiptId: bundle.scope.receiptId,
    subjectCommit: bundle.subject.commit,
    validationId,
    executor,
    result: "passed",
    evidenceLabel,
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidencePath = resolveWithin(evidenceRoot, ref, "ATTESTATION_EVIDENCE_PATH_UNSAFE");
  if (fs.existsSync(evidencePath)) {
    if (fs.readFileSync(evidencePath, "utf8") !== body) throw new Error("ATTESTATION_EVIDENCE_ALREADY_DIFFERS");
  } else {
    writeAtomic(evidencePath, body);
  }
  entry.status = "passed";
  entry.executor = executor;
  entry.evidenceRef = ref;
  entry.evidenceSha256 = sha256(body);
  entry.signatureRef = null;
  entry.signatureSha256 = null;
  return true;
}

function loadTrustedIssuers(root, policy, schema) {
  const pin = policy.browserAcceptanceTrust;
  if (!pin?.path || !/^[a-f0-9]{64}$/u.test(pin.sha256 || "") || !pin.trustRootId) throw new Error("TRUSTED_ISSUERS_POLICY_PIN_INVALID");
  const trustPath = resolveWithin(root, pin.path, "TRUSTED_ISSUERS_PATH_UNSAFE");
  if (sha256(fs.readFileSync(trustPath)) !== pin.sha256) throw new Error("TRUSTED_ISSUERS_POLICY_HASH_MISMATCH");
  const trust = readJson(trustPath, "TRUSTED_ISSUERS_JSON_INVALID");
  assertJsonSchema(schema, trust, "TRUSTED_ISSUERS_SCHEMA_INVALID");
  if (trust.trustRoot.rootId !== pin.trustRootId
    || trust.trustRoot.custody !== "external-controlled" || trust.trustRoot.keyMaterial !== "public-only") {
    throw new Error("TRUSTED_ISSUERS_ROOT_MISMATCH");
  }
  const issuers = new Map();
  for (const issuer of trust.issuers) {
    if (/PRIVATE KEY/u.test(issuer.publicKeyPem) || issuer.trustRootId !== trust.trustRoot.rootId
      || issuers.has(issuer.issuerId) || publicKeyFingerprint(issuer.publicKeyPem) !== issuer.publicKeyFingerprint) {
      throw new Error("TRUSTED_ISSUER_INVALID");
    }
    issuers.set(issuer.issuerId, issuer);
  }
  return { ...trust, issuers };
}

function validateBrowserEvidence(bundle, evidenceBytes, signatureBytes, contracts, trust, replay) {
  let evidence;
  let signature;
  try { evidence = JSON.parse(evidenceBytes.toString("utf8")); } catch { throw new Error("BROWSER_EVIDENCE_JSON_INVALID"); }
  try { signature = JSON.parse(signatureBytes.toString("utf8")); } catch { throw new Error("BROWSER_SIGNATURE_JSON_INVALID"); }
  assertJsonSchema(contracts.browserEvidence, evidence, "BROWSER_EVIDENCE_SCHEMA_INVALID");
  assertJsonSchema(contracts.browserSignature, signature, "BROWSER_SIGNATURE_SCHEMA_INVALID");
  const evidenceRoutes = [evidence.preciseRoute, ...evidence.adjacentRoutes];
  if (new Set(evidenceRoutes).size !== evidenceRoutes.length) throw new Error("BROWSER_ROUTES_MUST_BE_DISTINCT");
  if (evidence.preciseRoute !== bundle.scope.browserAcceptance.preciseRoute) throw new Error("BROWSER_EVIDENCE_PRECISE_ROUTE_MISMATCH");
  if (canonicalJson([...evidenceRoutes].sort((a, b) => a.localeCompare(b)))
    !== canonicalJson(bundle.scope.browserAcceptance.requiredRoutes)) throw new Error("BROWSER_EVIDENCE_SCOPE_ROUTES_MISMATCH");
  if (canonicalJson(evidence.subject) !== canonicalJson({
    commit: bundle.subject.commit,
    sourceVersion: bundle.subject.sourceVersion,
    builds: bundle.subject.builds,
    buildOutputDigests: bundle.subject.buildOutputDigests,
    candidatePayloads: bundle.subject.candidatePayloads,
    controlPlane: bundle.subject.controlPlane,
  })) throw new Error("BROWSER_EVIDENCE_BUILD_IDENTITY_MISMATCH");
  for (const service of bundle.subject.services) {
    const readback = evidence.runtimeReadbacks[service];
    if (!readback || canonicalJson(readback) !== canonicalJson({
      commit: bundle.subject.commit,
      sourceVersion: bundle.subject.sourceVersion,
      buildId: bundle.subject.builds[service],
      buildOutputDigest: bundle.subject.buildOutputDigests[service],
    })) throw new Error("BROWSER_RUNTIME_READBACK_MISMATCH");
  }
  for (const service of ["web", "voice"].filter((candidate) => !bundle.subject.services.includes(candidate))) {
    if (evidence.runtimeReadbacks[service] !== null) throw new Error("BROWSER_RUNTIME_READBACK_UNREQUESTED_SERVICE");
  }
  const strictTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  if (![evidence.checkedAt, signature.issuedAt, signature.expiresAt].every((value) => strictTimestamp.test(value))) {
    throw new Error("BROWSER_EVIDENCE_TIMESTAMP_INVALID");
  }
  const checkedAt = Date.parse(evidence.checkedAt);
  const issuedAt = Date.parse(signature.issuedAt);
  const expiresAt = Date.parse(signature.expiresAt);
  const now = Date.now();
  const maxAge = trust.maxEvidenceAgeSeconds * 1000;
  if (![checkedAt, issuedAt, expiresAt].every(Number.isFinite)
    || checkedAt > now + 5 * 60 * 1000 || issuedAt > now + 5 * 60 * 1000
    || now - checkedAt > maxAge || now - issuedAt > maxAge || expiresAt <= now
    || expiresAt <= issuedAt || expiresAt - issuedAt > maxAge) throw new Error("BROWSER_EVIDENCE_EXPIRED_OR_FUTURE_DATED");
  const issuer = trust.issuers.get(signature.issuerId);
  if (!issuer || !issuer.allowedEvidenceTypes.includes(signature.evidenceType)
    || signature.publicKeyFingerprint !== issuer.publicKeyFingerprint
    || signature.targetSha256 !== sha256(evidenceBytes)
    || signature.receiptId !== evidence.receiptId || signature.nonce !== evidence.nonce
    || signature.subjectCommit !== bundle.subject.commit
    || signature.sourceVersion !== bundle.subject.sourceVersion
    || signature.webBuildId !== bundle.subject.builds.web
    || signature.voiceBuildId !== bundle.subject.builds.voice
    || signature.webOutputDigest !== bundle.subject.buildOutputDigests.web
    || signature.voiceOutputDigest !== bundle.subject.buildOutputDigests.voice) throw new Error("BROWSER_SIGNATURE_BINDING_MISMATCH");
  if (replay.receiptIds.has(signature.receiptId) || replay.nonces.has(signature.nonce)) throw new Error("BROWSER_SIGNATURE_REPLAY");
  const signed = { ...signature };
  delete signed.signature;
  let signatureBuffer;
  try { signatureBuffer = Buffer.from(signature.signature, "base64"); } catch { throw new Error("BROWSER_SIGNATURE_ENCODING_INVALID"); }
  if (!crypto.verify(null, Buffer.from(canonicalJson(signed)), issuer.publicKeyPem, signatureBuffer)) throw new Error("BROWSER_SIGNATURE_INVALID");
  replay.receiptIds.add(signature.receiptId);
  replay.nonces.add(signature.nonce);
}

function copyExternalEvidence(externalBundle, externalRoot, targetRoot, validationId) {
  const entry = externalBundle.attestations.find((item) => item.validationId === validationId);
  const sourcePath = resolveWithin(externalRoot, entry.evidenceRef, "EXTERNAL_EVIDENCE_PATH_UNSAFE");
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error("EXTERNAL_EVIDENCE_MISSING");
  const body = fs.readFileSync(sourcePath);
  if (sha256(body) !== entry.evidenceSha256) throw new Error("EXTERNAL_EVIDENCE_SHA256_MISMATCH");
  const targetRef = `external-${evidenceFileName(validationId)}`;
  const targetPath = resolveWithin(targetRoot, targetRef, "ATTESTATION_EVIDENCE_PATH_UNSAFE");
  if (fs.existsSync(targetPath)) {
    if (!fs.readFileSync(targetPath).equals(body)) throw new Error("EXTERNAL_EVIDENCE_TARGET_DIFFERS");
  } else {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  }
  return { ref: targetRef, sha256: entry.evidenceSha256 };
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.has("--trusted-issuers")) throw new Error("TRUSTED_ISSUERS_OVERRIDE_FORBIDDEN");
  const root = path.resolve(args.get("--root") || process.cwd());
  const schemaPath = path.resolve(root, args.get("--schema") || "scripts/contracts/release-change-validation-bundle.v1.schema.json");
  const schema = readJson(schemaPath, "BUNDLE_SCHEMA_INVALID");
  const contracts = {
    secretScan: loadContract(root, "release-secret-exposure-receipt.v1.schema.json", "SECRET_SCAN_SCHEMA_INVALID"),
    targetedRegression: loadContract(root, "release-targeted-regression-receipt.v1.schema.json", "TARGETED_REGRESSION_SCHEMA_INVALID"),
    browserEvidence: loadContract(root, "release-browser-acceptance-evidence.v1.schema.json", "BROWSER_EVIDENCE_CONTRACT_INVALID"),
    browserSignature: loadContract(root, "release-browser-acceptance-signature.v1.schema.json", "BROWSER_SIGNATURE_CONTRACT_INVALID"),
    trustedIssuers: loadContract(root, "release-acceptance-trusted-issuers.v1.schema.json", "TRUSTED_ISSUERS_CONTRACT_INVALID"),
    buildOutputDigest: loadContract(root, "release-build-output-digest.v1.schema.json", "BUILD_OUTPUT_DIGEST_CONTRACT_INVALID"),
  };
  const scopePolicy = readJson(path.join(root, "deploy/policies/release-change-scope.v1.json"), "SCOPE_POLICY_JSON_INVALID");

  if (command === "init") {
    const scopePath = path.resolve(args.get("--scope-receipt") || "");
    const outputPath = path.resolve(args.get("--output") || "");
    const commit = String(args.get("--subject-commit") || "").toLowerCase();
    const target = args.get("--target");
    const services = [...new Set(String(args.get("--services") || "web").split(",").filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("SUBJECT_COMMIT_INVALID");
    if (!new Set(["source-candidate", "release-ready"]).has(target)) throw new Error("BUNDLE_TARGET_INVALID");
    if (services.length === 0 || services.some((service) => !new Set(["web", "voice"]).has(service))) throw new Error("BUNDLE_SERVICES_INVALID");
    if (!services.includes("web")) services.unshift("web");
    const scope = verifyScopeReceipt(root, scopePath, args);
    if (scope.input.kind === "git-range" && scope.input.head !== commit) throw new Error("SCOPE_SUBJECT_COMMIT_MISMATCH");
    const attestations = scope.requiredValidations.map((validationId) => ({
      validationId,
      status: "pending-required",
      executor: "unassigned",
      evidenceRef: null,
      evidenceSha256: null,
      signatureRef: null,
      signatureSha256: null,
    }));
    const bundle = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bundleId: "validation-placeholder",
      scope: {
        receiptId: scope.receiptId,
        receiptSha256: sha256(fs.readFileSync(scopePath)),
        classification: scope.classification,
        input: {
          kind: scope.input.kind,
          base: scope.input.base,
          head: scope.input.head,
          rangeMode: scope.input.rangeMode,
          trustedBase: scope.input.trustedBase,
        },
        browserAcceptance: scope.browserAcceptance,
        requiredValidations: [...scope.requiredValidations].sort((left, right) => left.localeCompare(right)),
      },
      subject: {
        commit, sourceVersion: null, services,
        builds: { web: null, voice: null },
        buildOutputDigests: { web: null, voice: null },
        candidatePayloads: { web: null, voice: null },
        controlPlane: null,
      },
      target,
      status: "pending-required",
      attestations,
      summary: summary(attestations),
    };
    saveBundle(outputPath, schema, bundle);
    return;
  }

  const bundlePath = path.resolve(args.get("--bundle") || "");
  const bundle = loadBundle(bundlePath, schema);

  if (command === "bind-control-plane") {
    const descriptor = readJson(path.resolve(args.get("--descriptor") || ""), "CONTROL_DESCRIPTOR_INVALID");
    assertDescriptor(descriptor);
    if (descriptor.subject.mode !== "formal" || descriptor.subject.sourceCommit !== bundle.subject.commit
      || descriptor.subject.repository !== process.env.GITHUB_REPOSITORY
      || descriptor.subject.candidateRunId !== process.env.GITHUB_RUN_ID
      || descriptor.subject.candidateRunAttempt !== process.env.GITHUB_RUN_ATTEMPT) throw new Error("CONTROL_PLANE_CANDIDATE_SUBJECT_MISMATCH");
    verifyPackage(path.dirname(path.resolve(args.get("--descriptor"))), descriptor);
    if (bundle.subject.controlPlane !== null && canonicalJson(bundle.subject.controlPlane) !== canonicalJson(descriptor)) throw new Error("CONTROL_PLANE_ALREADY_BOUND");
    bundle.subject.controlPlane = descriptor;
    saveBundle(bundlePath, schema, bundle);
    return;
  }
  if (command === "verify-control-plane") {
    if (!bundle.subject.controlPlane) throw new Error("CONTROL_PLANE_REQUIRED");
    verifyCandidatePackage(path.resolve(args.get("--package") || ""), bundle.subject.controlPlane,
      readJson(path.resolve(args.get("--candidate-run-json") || ""), "CANDIDATE_RUN_INVALID"), process.env.GITHUB_REPOSITORY);
    process.stdout.write(`${JSON.stringify({verified:true, controlPlane:bundle.subject.controlPlane})}\n`);
    return;
  }

  if (command === "record") {
    const validationId = args.get("--validation");
    const required = bundle.scope.requiredValidations.includes(validationId);
    if (!required && args.has("--if-required")) return;
    if (!required) throw new Error("VALIDATION_NOT_REQUIRED_FOR_SCOPE");
    const evidenceRoot = path.resolve(args.get("--evidence-root") || "");
    recordPassed(bundle, validationId, args.get("--executor"), evidenceRoot, args.get("--evidence-label"), args.get("--evidence-file"), contracts);
    saveBundle(bundlePath, schema, bundle);
    return;
  }

  if (command === "bind-identity") {
    const sourceVersion = args.get("--source-version");
    const buildId = args.get("--build-id");
    const service = args.get("--service") || "web";
    const digestReceiptPath = path.resolve(args.get("--build-output-digest-receipt") || "");
    if (!bundle.subject.services.includes(service) || !sourceVersion || !buildId || /[\u0000-\u001f\u007f]/u.test(sourceVersion + buildId)) {
      throw new Error("BUILD_IDENTITY_INVALID");
    }
    if (bundle.subject.sourceVersion && bundle.subject.sourceVersion !== sourceVersion) throw new Error("SOURCE_VERSION_CHANGED_BETWEEN_BUILDS");
    const digestReceipt = readJson(digestReceiptPath, "BUILD_OUTPUT_DIGEST_RECEIPT_INVALID");
    assertJsonSchema(contracts.buildOutputDigest, digestReceipt, "BUILD_OUTPUT_DIGEST_RECEIPT_SCHEMA_INVALID");
    if (digestReceipt.service !== service || digestReceipt.commit !== bundle.subject.commit
      || digestReceipt.sourceVersion !== sourceVersion || digestReceipt.buildId !== buildId) {
      throw new Error("BUILD_OUTPUT_DIGEST_RECEIPT_BINDING_MISMATCH");
    }
    bundle.subject.sourceVersion = sourceVersion;
    bundle.subject.builds[service] = buildId;
    bundle.subject.buildOutputDigests[service] = digestReceipt.outputDigest;
    saveBundle(bundlePath, schema, bundle);
    return;
  }

  if (command === "bind-package-payload") {
    if (bundle.target !== "source-candidate" || bundle.status !== "pending-required") {
      throw new Error("CANDIDATE_PAYLOAD_BINDING_PHASE_INVALID");
    }
    const service = args.get("--service") || "web";
    const manifestPath = path.resolve(args.get("--manifest") || "");
    const archivePath = path.resolve(args.get("--archive") || "");
    if (!bundle.subject.services.includes(service) || !fs.existsSync(manifestPath) || !fs.existsSync(archivePath)) {
      throw new Error("CANDIDATE_PAYLOAD_INPUT_INVALID");
    }
    const manifest = readJson(manifestPath, "CANDIDATE_PAYLOAD_MANIFEST_INVALID");
    const archiveSha256 = sha256(fs.readFileSync(archivePath));
    if (manifest.schemaVersion !== 2 || manifest.service !== service || manifest.commitSha !== bundle.subject.commit
      || manifest.sourceVersion !== bundle.subject.sourceVersion
      || manifest.buildId !== bundle.subject.builds[service]
      || manifest.buildOutputDigest !== bundle.subject.buildOutputDigests[service]
      || !/^[a-f0-9]{64}$/u.test(manifest.artifactDigest || "")
      || !Number.isInteger(manifest.fileCount) || manifest.fileCount < 1
      || !Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 1) {
      throw new Error("CANDIDATE_PAYLOAD_BUILD_IDENTITY_MISMATCH");
    }
    bundle.subject.candidatePayloads[service] = {
      releaseId: manifest.releaseId,
      artifactDigest: manifest.artifactDigest,
      archiveSha256,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    };
    saveBundle(bundlePath, schema, bundle);
    return;
  }

  if (command === "merge-external") {
    const externalRelative = args.get("--external-bundle");
    const externalEvidenceRelative = args.get("--external-evidence-root");
    if (!externalRelative || !externalEvidenceRelative) return;
    const externalPath = resolveWithin(root, externalRelative, "EXTERNAL_BUNDLE_PATH_UNSAFE");
    if (!fs.existsSync(externalPath)) return;
    const externalEvidenceRoot = resolveWithin(root, externalEvidenceRelative, "EXTERNAL_EVIDENCE_ROOT_UNSAFE");
    const targetEvidenceRoot = path.resolve(args.get("--evidence-root") || "");
    const trustedIssuers = loadTrustedIssuers(root, scopePolicy, contracts.trustedIssuers);
    const external = loadBundle(externalPath, schema);
    if (external.scope.receiptId !== bundle.scope.receiptId
      || external.scope.receiptSha256 !== bundle.scope.receiptSha256
      || canonicalJson(external.scope.requiredValidations) !== canonicalJson(bundle.scope.requiredValidations)
      || canonicalJson(external.subject) !== canonicalJson(bundle.subject)) {
      throw new Error("EXTERNAL_BUNDLE_IDENTITY_MISMATCH");
    }
    validateEvidence(external, externalEvidenceRoot);
    const replay = { receiptIds: new Set(), nonces: new Set() };
    for (const externalEntry of external.attestations.filter((entry) => entry.status === "passed")) {
      if (!new Set(["external-browser", "external-verifier"]).has(externalEntry.executor)) continue;
      const localEntry = bundle.attestations.find((entry) => entry.validationId === externalEntry.validationId);
      if (!localEntry) throw new Error("EXTERNAL_VALIDATION_NOT_REQUIRED");
      if (EXTERNAL_BROWSER_REQUIRED.includes(externalEntry.validationId)) {
        if (externalEntry.executor !== "external-browser") throw new Error("BROWSER_VALIDATION_EXECUTOR_INVALID");
        if (externalEntry.signatureRef !== `${externalEntry.evidenceRef}.sig.json`) throw new Error("EXTERNAL_BROWSER_SIGNATURE_REF_INVALID");
        const evidencePath = resolveWithin(externalEvidenceRoot, externalEntry.evidenceRef, "EXTERNAL_EVIDENCE_PATH_UNSAFE");
        const signaturePath = resolveWithin(externalEvidenceRoot, `${externalEntry.evidenceRef}.sig.json`, "EXTERNAL_SIGNATURE_PATH_UNSAFE");
        if (!fs.existsSync(signaturePath) || !fs.statSync(signaturePath).isFile()) throw new Error("EXTERNAL_BROWSER_SIGNATURE_MISSING");
        validateBrowserEvidence(bundle, fs.readFileSync(evidencePath), fs.readFileSync(signaturePath), contracts, trustedIssuers, replay);
      }
      const copied = copyExternalEvidence(external, externalEvidenceRoot, targetEvidenceRoot, externalEntry.validationId);
      if (EXTERNAL_BROWSER_REQUIRED.includes(externalEntry.validationId)) {
        const sourceSignature = resolveWithin(externalEvidenceRoot, `${externalEntry.evidenceRef}.sig.json`, "EXTERNAL_SIGNATURE_PATH_UNSAFE");
        const targetSignatureRef = `${copied.ref}.sig.json`;
        const targetSignature = resolveWithin(targetEvidenceRoot, targetSignatureRef, "ATTESTATION_SIGNATURE_PATH_UNSAFE");
        const signatureBytes = fs.readFileSync(sourceSignature);
        if (fs.existsSync(targetSignature)) {
          if (!fs.readFileSync(targetSignature).equals(signatureBytes)) throw new Error("EXTERNAL_SIGNATURE_TARGET_DIFFERS");
        } else {
          fs.copyFileSync(sourceSignature, targetSignature, fs.constants.COPYFILE_EXCL);
        }
        localEntry.signatureRef = targetSignatureRef;
        localEntry.signatureSha256 = sha256(signatureBytes);
      }
      localEntry.status = "passed";
      localEntry.executor = externalEntry.executor;
      localEntry.evidenceRef = copied.ref;
      localEntry.evidenceSha256 = copied.sha256;
      if (!EXTERNAL_BROWSER_REQUIRED.includes(externalEntry.validationId)) {
        localEntry.signatureRef = null;
        localEntry.signatureSha256 = null;
      }
    }
    saveBundle(bundlePath, schema, bundle);
    return;
  }

  if (command === "promote-release-ready") {
    if (!bundle.subject.controlPlane) throw new Error("CONTROL_PLANE_REQUIRED");
    if (bundle.target !== "source-candidate"
      || !new Set(["source-candidate-pending-required", "source-candidate-complete"]).has(bundle.status)) {
      throw new Error("RELEASE_PROMOTION_SOURCE_CANDIDATE_REQUIRED");
    }
    if (!bundle.scope.input.trustedBase) throw new Error("RELEASE_TRUSTED_BASE_REQUIRED");
    if (bundle.scope.browserAcceptance.explicitRoutesRequired) throw new Error("RELEASE_BROWSER_ROUTES_UNRESOLVED");
    const byId = new Map(bundle.attestations.map((entry) => [entry.validationId, entry]));
    for (const validationId of AUTOMATED_REQUIRED) {
      if (byId.get(validationId)?.status !== "passed" || byId.get(validationId)?.executor !== "ci") {
        throw new Error(`CI_ATTESTATION_REQUIRED:${validationId}`);
      }
    }
    if (!bundle.subject.sourceVersion
      || bundle.subject.services.some((service) => !bundle.subject.builds[service] || !bundle.subject.buildOutputDigests[service]
        || !bundle.subject.candidatePayloads[service])) {
      throw new Error("RELEASE_BUILD_IDENTITY_REQUIRED");
    }
    bundle.target = "release-ready";
    bundle.status = "pending-required";
    saveBundle(bundlePath, schema, bundle);
    return;
  }

  if (command === "verify-release-ready") {
    if (!bundle.subject.controlPlane) throw new Error("CONTROL_PLANE_REQUIRED");
    if (bundle.target !== "release-ready" || bundle.status !== "release-ready") throw new Error("RELEASE_READY_BUNDLE_REQUIRED");
    const scopePath = path.resolve(args.get("--scope-receipt") || "");
    const evidenceRoot = path.resolve(args.get("--evidence-root") || "");
    const scope = verifyScopeReceipt(root, scopePath, args);
    const expectedScope = {
      receiptId: scope.receiptId,
      receiptSha256: sha256(fs.readFileSync(scopePath)),
      classification: scope.classification,
      input: {
        kind: scope.input.kind,
        base: scope.input.base,
        head: scope.input.head,
        rangeMode: scope.input.rangeMode,
        trustedBase: scope.input.trustedBase,
      },
      browserAcceptance: scope.browserAcceptance,
      requiredValidations: [...scope.requiredValidations].sort((left, right) => left.localeCompare(right)),
    };
    if (canonicalJson(bundle.scope) !== canonicalJson(expectedScope) || scope.input.head !== bundle.subject.commit) {
      throw new Error("RELEASE_READY_SCOPE_RECLASSIFICATION_MISMATCH");
    }
    validateEvidence(bundle, evidenceRoot);
    if (bundle.attestations.some((entry) => entry.status !== "passed")) throw new Error("RELEASE_READY_ATTESTATIONS_INCOMPLETE");
    const credential = bundle.attestations.find((entry) => entry.validationId === "credential-scan");
    validateCredentialReceipt(bundle, readJson(resolveWithin(evidenceRoot, credential.evidenceRef), "SECRET_SCAN_RECEIPT_INVALID"), contracts.secretScan);
    const targeted = bundle.attestations.find((entry) => entry.validationId === "targeted-zero-network-regression");
    if (targeted) validateTargetedRegressionReceipt(bundle, readJson(resolveWithin(evidenceRoot, targeted.evidenceRef), "TARGETED_REGRESSION_RECEIPT_INVALID"), contracts.targetedRegression);
    const trustedIssuers = loadTrustedIssuers(root, scopePolicy, contracts.trustedIssuers);
    const replay = { receiptIds: new Set(), nonces: new Set() };
    for (const validationId of EXTERNAL_BROWSER_REQUIRED) {
      const entry = bundle.attestations.find((candidate) => candidate.validationId === validationId);
      if (!entry || entry.executor !== "external-browser" || entry.signatureRef !== `${entry.evidenceRef}.sig.json`) {
        throw new Error(`EXTERNAL_BROWSER_ATTESTATION_REQUIRED:${validationId}`);
      }
      validateBrowserEvidence(
        bundle,
        fs.readFileSync(resolveWithin(evidenceRoot, entry.evidenceRef, "ATTESTATION_EVIDENCE_PATH_UNSAFE")),
        fs.readFileSync(resolveWithin(evidenceRoot, entry.signatureRef, "ATTESTATION_SIGNATURE_PATH_UNSAFE")),
        contracts,
        trustedIssuers,
        replay,
      );
    }
    process.stdout.write(`${JSON.stringify({ verified: true, bundleId: bundle.bundleId, commit: bundle.subject.commit })}\n`);
    return;
  }

  if (command === "finalize") {
    const target = args.get("--target");
    if (target !== bundle.target) throw new Error("FINALIZE_TARGET_MISMATCH");
    const evidenceRoot = path.resolve(args.get("--evidence-root") || "");
    validateEvidence(bundle, evidenceRoot);
    const byId = new Map(bundle.attestations.map((entry) => [entry.validationId, entry]));
    for (const validationId of AUTOMATED_REQUIRED) {
      if (byId.get(validationId)?.status !== "passed" || byId.get(validationId)?.executor !== "ci") {
        throw new Error(`CI_ATTESTATION_REQUIRED:${validationId}`);
      }
    }
    if (bundle.attestations.some((entry) => entry.status === "failed")) throw new Error("FAILED_ATTESTATION_PRESENT");
    if (!bundle.subject.controlPlane) throw new Error("CONTROL_PLANE_REQUIRED");
    if (target === "release-ready") {
      if (!bundle.scope.input.trustedBase) throw new Error("RELEASE_TRUSTED_BASE_REQUIRED");
      if (!bundle.subject.sourceVersion
        || bundle.subject.services.some((service) => !bundle.subject.builds[service] || !bundle.subject.buildOutputDigests[service]
          || !bundle.subject.candidatePayloads[service])) {
        throw new Error("RELEASE_BUILD_IDENTITY_REQUIRED");
      }
      if (bundle.scope.browserAcceptance.explicitRoutesRequired) {
        throw new Error("RELEASE_BROWSER_ROUTES_UNRESOLVED");
      }
      const pending = bundle.attestations.filter((entry) => entry.status !== "passed");
      if (pending.length > 0) throw new Error(`RELEASE_ATTESTATIONS_PENDING:${pending[0].validationId}`);
      for (const validationId of EXTERNAL_BROWSER_REQUIRED) {
        if (byId.get(validationId)?.executor !== "external-browser") {
          throw new Error(`EXTERNAL_BROWSER_ATTESTATION_REQUIRED:${validationId}`);
        }
      }
      bundle.status = "release-ready";
    } else {
      bundle.status = bundle.attestations.some((entry) => entry.status === "pending-required")
        ? "source-candidate-pending-required"
        : "source-candidate-complete";
    }
    saveBundle(bundlePath, schema, bundle);
    if (args.has("--github-output")) {
      fs.appendFileSync(args.get("--github-output"), [
        `validation_status=${bundle.status}`,
        `release_ready=${bundle.status === "release-ready" ? "true" : "false"}`,
        `validation_bundle_id=${bundle.bundleId}`,
      ].join("\n") + "\n", "utf8");
    }
    if (!args.has("--quiet")) process.stdout.write(`${JSON.stringify({ bundleId: bundle.bundleId, status: bundle.status })}\n`);
    return;
  }

  if (command === "verify") {
    if (!args.has("--quiet")) process.stdout.write(`${JSON.stringify({ bundleId: bundle.bundleId, valid: true })}\n`);
    return;
  }

  throw new Error("VALIDATION_GATE_COMMAND_REQUIRED");
}

try {
  main();
} catch (error) {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  process.stderr.write(`RELEASE_VALIDATION_GATE_FAILED ${code}\n`);
  process.exitCode = 2;
}
