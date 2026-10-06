import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || "";
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
const target = path.resolve("scripts/verify-youcai-benchmark-chains.ts");
const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
const result = spawnSync(process.execPath, [tsxCli, target], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.signal) throw new Error("benchmark runner terminated by " + result.signal);
if (result.status !== 0) process.exitCode = result.status || 1;
