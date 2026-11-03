#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  computeLocalBuildFingerprint,
  verifyLocalBuildFingerprintReceipt,
  writeLocalBuildFingerprintReceipt,
} from "./local-build-fingerprint.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-build-fingerprint-"));

try {
  execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot, windowsHide: true });
  fs.writeFileSync(path.join(temporaryRoot, "source.ts"), "export const version = 1;\n", "utf8");
  fs.writeFileSync(path.join(temporaryRoot, "next-env.d.ts"), "/// <reference types=\"next\" />\n", "utf8");
  fs.writeFileSync(path.join(temporaryRoot, ".env.local"), "PRIVATE_TEST_VALUE=one\n", "utf8");
  fs.mkdirSync(path.join(temporaryRoot, ".next"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, ".next", "BUILD_ID"), "build-one\n", "utf8");
  execFileSync("git", ["add", "source.ts", "next-env.d.ts"], { cwd: temporaryRoot, windowsHide: true });

  const initial = computeLocalBuildFingerprint(temporaryRoot);
  const receiptPath = ".next/local-source-fingerprint.v1.json";
  writeLocalBuildFingerprintReceipt(temporaryRoot, receiptPath, initial.fingerprint);
  assert.deepEqual(
    verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath),
    { ...initial, buildId: "build-one" },
  );

  fs.mkdirSync(path.join(temporaryRoot, ".runtime"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, ".runtime", "ignored.log"), "runtime-only\n", "utf8");
  assert.equal(
    verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath).fingerprint,
    initial.fingerprint,
    "runtime files must not invalidate a source build",
  );

  fs.mkdirSync(path.join(temporaryRoot, ".tmp-e2e"), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, ".tmp-e2e", "browser-result.json"), '{"checkedAt":"now"}\n', "utf8");
  execFileSync("git", ["add", ".tmp-e2e/browser-result.json"], { cwd: temporaryRoot, windowsHide: true });
  assert.equal(
    verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath).fingerprint,
    initial.fingerprint,
    "temporary E2E evidence must not invalidate a source build even when tracked",
  );

  fs.writeFileSync(path.join(temporaryRoot, "next-env.d.ts"), "/// <reference types=\"next/types/global\" />\n", "utf8");
  assert.equal(
    verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath).fingerprint,
    initial.fingerprint,
    "Next-generated next-env declarations must not invalidate their own build",
  );

  fs.writeFileSync(path.join(temporaryRoot, "source.ts"), "export const version = 2;\n", "utf8");
  assert.throws(
    () => verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath),
    /bundle is stale relative to the current source/u,
    "tracked source changes must refuse an old bundle",
  );

  const rebuilt = computeLocalBuildFingerprint(temporaryRoot);
  writeLocalBuildFingerprintReceipt(temporaryRoot, receiptPath, rebuilt.fingerprint);
  fs.writeFileSync(path.join(temporaryRoot, ".env.local"), "PRIVATE_TEST_VALUE=two\n", "utf8");
  assert.throws(
    () => verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath),
    /bundle is stale relative to the current source/u,
    "local environment changes must also require a fresh bundle",
  );

  const historicalTree = fs.mkdtempSync(path.join(temporaryRoot, ".git", "historical-"));
  execFileSync("git", ["config", "core.worktree", historicalTree], { cwd: temporaryRoot, windowsHide: true });
  const beforeNewFile = computeLocalBuildFingerprint(temporaryRoot);
  writeLocalBuildFingerprintReceipt(temporaryRoot, receiptPath, beforeNewFile.fingerprint);
  fs.writeFileSync(path.join(temporaryRoot, "new-route.ts"), "export const live = true;\n", "utf8");
  assert.throws(() => verifyLocalBuildFingerprintReceipt(temporaryRoot, receiptPath), /bundle is stale/u,
    "new files under the build root must invalidate the bundle even when Git points to a historical checkout");

  console.log(JSON.stringify({
    ok: true,
    network_requests: 0,
    paid_requests: 0,
    stale_source_refused: true,
    stale_environment_refused: true,
    runtime_noise_ignored: true,
    temporary_e2e_evidence_ignored: true,
    next_generated_declaration_ignored: true,
  }, null, 2));
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (!resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
    throw new Error(`refusing to remove unexpected temporary directory: ${resolvedTemporaryRoot}`);
  }
  fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
}
