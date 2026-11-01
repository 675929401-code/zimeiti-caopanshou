#!/usr/bin/env node

// Exercise the actual snapshot and Git checkout, with a fully synthetic tree.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const workflow = path.join(projectRoot, "scripts", "release-workflow.mjs");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-release-bytes-"));
const source = path.join(fixtureRoot, "source");
const snapshot = path.join(fixtureRoot, "snapshot");
const checkout = path.join(fixtureRoot, "checkout");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const put = (relative, bytes) => {
  const target = path.join(source, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
};
const command = (file, args, cwd) => {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${path.basename(file)} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const node = (args) => command(process.execPath, [workflow, ...args, "--root", source, "--policy", "deploy/release-policy.json"], source);
const git = (cwd, args) => command("git", args, cwd);

try {
  fs.mkdirSync(path.join(source, "public"), { recursive: true });
  const policy = {
    schemaVersion: 1,
    projectId: "release-byte-fixture",
    source: { maxBytes: 1000000, maxFileBytes: 1000000, topLevelFiles: [".gitattributes"], roots: ["supabase", "src", "deploy"], excludeGlobs: [], excludeDirectoryNames: [".git"], excludeFileNames: [], publicSourcePaths: [] },
    assets: { root: "public", manifest: "deploy/manifests/assets.json", externalRoots: [], requiredPaths: [], forbiddenPublicRoots: [], forbiddenCuratedJsonMarkers: [] },
    runtime: { mutablePaths: [], secretPaths: [] },
  };
  put("deploy/release-policy.json", `${JSON.stringify(policy)}\n`);
  put(".gitattributes", fs.readFileSync(path.join(projectRoot, ".gitattributes")));
  const originals = new Map([
    ["supabase/migrations/20260101000000_crlf.sql", Buffer.from("SELECT 1;\r\nSELECT 2;\r\n")],
    ["supabase/migrations/20260101000001_mixed.sql", Buffer.from("SELECT 1;\nSELECT 2;\r\n")],
    ["supabase/migrations/20260101000002_lf.sql", Buffer.from("SELECT 1;\n")],
  ]);
  for (const [file, bytes] of originals) put(file, bytes);
  put("src/ordinary.ts", "export const value = 1;\r\n");
  put("supabase/other/ordinary.sql", "SELECT 1;\r\n");
  node(["assets", "--write"]);
  node(["snapshot", "--output", snapshot]);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, ".release", "source-files.v1.json"), "utf8"));
  for (const [file, bytes] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(snapshot, ...file.split("/"))), bytes, `snapshot changed ${file}`);
    const row = manifest.files.find((entry) => entry.path === file);
    assert.equal(row?.sha256, sha(bytes), `manifest changed ${file}`);
  }
  assert.equal(fs.readFileSync(path.join(snapshot, "src", "ordinary.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(fs.readFileSync(path.join(snapshot, "supabase", "other", "ordinary.sql"), "utf8"), "SELECT 1;\n");

  git(snapshot, ["init", "--quiet"]);
  git(snapshot, ["-c", "core.autocrlf=true", "add", "--all"]);
  git(snapshot, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  git(fixtureRoot, ["-c", "core.autocrlf=true", "clone", "--quiet", snapshot, checkout]);
  for (const [file, bytes] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(checkout, ...file.split("/"))), bytes, `Git checkout changed ${file}`);
  }
  assert.equal(fs.readFileSync(path.join(checkout, "src", "ordinary.ts"), "utf8"), "export const value = 1;\n");
  git(checkout, ["-c", "core.whitespace=blank-at-eol", "diff", "--check"]);
  const changedMigration = path.join(checkout, "supabase", "migrations", "20260101000000_crlf.sql");
  fs.appendFileSync(changedMigration, "SELECT 3;\r\n");
  git(checkout, ["-c", "core.whitespace=blank-at-eol", "diff", "--check"]);
  fs.appendFileSync(changedMigration, "SELECT 4; \r\n");
  const bad = spawnSync("git", ["-c", "core.whitespace=blank-at-eol", "diff", "--check"], { cwd: checkout, encoding: "utf8", windowsHide: true });
  assert.equal(bad.status, 2, "migration diff must still reject actual trailing whitespace");
  assert.match(bad.stdout, /trailing whitespace/u);
  console.log(JSON.stringify({ verifier: "release-source-bytes-zero-network", status: "PASS", migrations: originals.size, networkCalls: 0 }));
} finally {
  // Remove only the directory returned by mkdtemp under the OS temp root.
  assert.ok(path.dirname(fixtureRoot) === os.tmpdir() && path.basename(fixtureRoot).startsWith("zimeiti-release-bytes-"));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
