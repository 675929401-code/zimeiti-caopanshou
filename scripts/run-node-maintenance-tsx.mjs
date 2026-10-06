#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, "..");
const target = process.argv[2];
const args = process.argv.slice(3);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!target) {
  fail("Usage: node ./scripts/run-node-maintenance-tsx.mjs ./scripts/<maintenance-script>.ts [args...]");
}

const normalizedTarget = target.replace(/\\/gu, "/");
if (!normalizedTarget.startsWith("./scripts/") && !normalizedTarget.startsWith("scripts/")) {
  fail(`Refusing to run a non-scripts target: ${target}`);
}

const absoluteTarget = path.resolve(root, target);
const scriptsRoot = `${path.resolve(root, "scripts")}${path.sep}`;
if (!absoluteTarget.startsWith(scriptsRoot) || path.extname(absoluteTarget) !== ".ts") {
  fail(`Refusing to run a target outside scripts/*.ts: ${target}`);
}
if (!existsSync(absoluteTarget)) {
  fail(`Maintenance script not found: ${target}`);
}

const serverOnlyRegister = path.resolve(root, "scripts", "register-node-script-server-only.cjs");
if (!existsSync(serverOnlyRegister)) {
  fail("Missing scripts/register-node-script-server-only.cjs");
}

const result = spawnSync(
  process.execPath,
  ["--require", serverOnlyRegister, "--import", "tsx", absoluteTarget, ...args],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error) {
  fail(result.error.message);
}
process.exit(typeof result.status === "number" ? result.status : 1);
