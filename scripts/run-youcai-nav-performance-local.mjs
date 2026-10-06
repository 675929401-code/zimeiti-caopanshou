import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || "";
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
const result = spawnSync(process.execPath, [
  path.resolve("node_modules/tsx/dist/cli.mjs"),
  path.resolve("scripts/probe-youcai-nav-performance.ts"),
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`performance runner terminated by ${result.signal}`);
if (result.status !== 0) process.exitCode = result.status || 1;
