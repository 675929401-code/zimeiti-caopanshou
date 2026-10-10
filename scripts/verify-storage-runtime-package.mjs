import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeRuntimePackages, materializeStorageRuntime, materializeWebRuntime, materializeTracedRuntime, verifyStorageRuntime } from "./materialize-storage-runtime.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "storage-runtime-verification-"));
try {
  const source = path.join(temporary, "source");
  const output = path.join(temporary, "artifact");
  const sdk = path.join(source, "node_modules", "cos-nodejs-sdk-v5");
  const makePackage = (directory, manifest, code) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, "index.js"), code);
  };
  makePackage(sdk, { name: "cos-nodejs-sdk-v5", version: "fixture", main: "index.js", dependencies: { cookie: "2" } }, "if(require('cookie')!==2)throw Error('wrong cookie version'); module.exports=class { putObject(){} headObject(){} };");
  makePackage(path.join(sdk, "node_modules", "cookie"), { name: "cookie", version: "2", main: "index.js" }, "module.exports=2;");
  fs.writeFileSync(path.join(sdk, "top-level.map"), "source map fixture");
  fs.writeFileSync(path.join(sdk, "node_modules", "cookie", "nested.map"), "nested source map fixture");
  makePackage(path.join(output, "node_modules", "cookie"), { name: "cookie", version: "5", main: "missing.js" }, "module.exports=5;");
  const result = materializeStorageRuntime(source, output);
  assert.equal(result.packageCopies, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "node_modules", "cos-nodejs-sdk-v5", "node_modules", "cookie", "package.json"))).version, "2");
  assert.equal(fs.existsSync(path.join(output, "node_modules", "cos-nodejs-sdk-v5", "top-level.map")), false);
  assert.equal(fs.existsSync(path.join(output, "node_modules", "cos-nodejs-sdk-v5", "node_modules", "cookie", "nested.map")), false);
  // Removing the actual dependency must fail instead of falling back to source.
  fs.renameSync(path.join(output, "node_modules", "cos-nodejs-sdk-v5", "node_modules", "cookie"), path.join(output, "cookie-removed"));
  assert.throws(() => verifyStorageRuntime(output), /Storage runtime dependency check failed/);
  const framework = path.join(source, "node_modules", "next");
  const frameworkStore = path.join(source, "node_modules", ".pnpm", "next@fixture", "node_modules", "next");
  makePackage(frameworkStore, { name: "next", version: "fixture", dependencies: { "@swc/helpers": "1" } }, "require('@swc/helpers'); module.exports=function(){};");
  makePackage(path.join(frameworkStore, "node_modules", "@swc", "helpers"), { name: "@swc/helpers", version: "1" }, "module.exports={};");
  fs.writeFileSync(path.join(frameworkStore, "pnpm-store.map"), "pnpm source map fixture");
  fs.symlinkSync(frameworkStore, framework, process.platform === "win32" ? "junction" : "dir");
  makePackage(path.join(source, "node_modules", "react"), { name: "react", version: "fixture" }, "module.exports={};");
  makePackage(path.join(source, "node_modules", "react-dom"), { name: "react-dom", version: "fixture" }, "module.exports={};");
  fs.writeFileSync(path.join(source, "node_modules", "react-dom", "server.js"), "module.exports={};");
  // Framework loading must be independent of the optional COS SDK (voice service).
  const frameworkOutput = path.join(temporary, "framework-artifact");
  fs.mkdirSync(frameworkOutput);
  materializeWebRuntime(source, frameworkOutput);
  assert.equal(fs.existsSync(path.join(frameworkOutput, "node_modules", "next", "pnpm-store.map")), false);
  fs.renameSync(path.join(frameworkOutput, "node_modules", "next", "node_modules", "@swc"), path.join(frameworkOutput, "swc-removed"));
  assert.throws(() => verifyStorageRuntime(frameworkOutput, { web: true, storage: false }), /dependency check failed/);
  const pg = path.join(source, "node_modules", "pg");
  makePackage(pg, { name: "pg", version: "fixture", dependencies: { "pg-types": "1" } }, "module.exports={Pool:class{},Client:class{},types:require('pg-types')};");
  makePackage(path.join(pg, "node_modules", "pg-types"), { name: "pg-types", version: "1" }, "module.exports={getTypeParser:()=>Number};");
  const fullOutput = path.join(temporary, "traced-artifact");
  fs.mkdirSync(fullOutput);
  const complete = materializeTracedRuntime(source, source, fullOutput, { storage: true });
  assert.ok(complete.roots.includes("pg"));
  fs.renameSync(path.join(fullOutput, "node_modules", "pg", "node_modules", "pg-types"), path.join(fullOutput, "pg-types-removed"));
  assert.throws(() => verifyStorageRuntime(fullOutput, { web: true, storage: true, database: true }), /dependency check failed/);
  const cyclePackage = path.join(source, "node_modules", "cycle-package");
  makePackage(cyclePackage, { name: "cycle-package", version: "fixture" }, "module.exports={};");
  fs.symlinkSync(cyclePackage, path.join(cyclePackage, "cycle"), process.platform === "win32" ? "junction" : "dir");
  const cycleOutput = path.join(temporary, "cycle-artifact");
  fs.mkdirSync(cycleOutput);
  assert.throws(() => materializeRuntimePackages(source, cycleOutput, ["cycle-package"]), /directory link cycle/iu);
  console.log(JSON.stringify({ status: "PASS", conflictingHoistedVersionIsolated: true, missingDependencyRejected: true, frameworkScopedDependencyPreserved: true, frameworkMissingDependencyRejected: true, completeTracedRootsPreserved: true, databaseMissingDependencyRejected: true, sourceMapsOmitted: true, directoryCycleRejected: true, realProviderRequests: 0 }));
} finally {
  const resolved = fs.realpathSync(temporary);
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot);
  assert.ok(path.basename(resolved).startsWith("storage-runtime-verification-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
