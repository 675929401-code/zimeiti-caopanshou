#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const unitPath = "deploy/systemd/pm2-root.service.d/20-zimeiti-data-mount.conf.example";
const unit = fs.readFileSync(unitPath, "utf8");
const readiness = fs.readFileSync("src/app/api/release-readiness/route.ts", "utf8");
const environment = fs.readFileSync("deploy/environments/production.env.example", "utf8");
const pm2 = fs.readFileSync("deploy/pm2/ecosystem.vnext.config.cjs", "utf8");

for (const marker of [
  "RequiresMountsFor=/data",
  "BindsTo=data.mount",
  "After=data.mount",
  "ConditionPathIsMountPoint=/data",
  "ConditionPathExists=/data/.zimeiti-storage-root",
  "ExecStartPre=/usr/bin/mountpoint -q /data",
  "ExecStartPre=/usr/bin/test -r /etc/zimeiti/deploy-storage.conf",
]) assert.match(unit, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

assert.match(readiness, /requireDedicatedDataMount/u);
assert.match(readiness, /dataStats\.dev === rootStats\.dev/u);
assert.match(environment, /^RELEASE_ROOT=\/data\/web$/mu);
assert.match(environment, /^APP_RUNTIME_DIR=\/data\/web\/shared\/runtime$/mu);
assert.doesNotMatch(environment, /^RELEASE_ROOT=\/srv/mu);
assert.match(pm2, /process\.env\.RELEASE_ROOT \|\| "\/data\/web"/u);

console.log(JSON.stringify({
  verifier: "pm2-data-mount-unit",
  passed: true,
  networkCalls: 0,
  productionWrites: 0,
  checks: [
    "systemd requires-and-binds-data-mount",
    "systemd marker-and-contract-preconditions",
    "application-readiness-device-isolation",
    "production-path-defaults-on-data-disk",
  ],
}, null, 2));
