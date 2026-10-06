#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";

const readiness = fs.readFileSync("scripts/verify-deployment-readiness.mjs", "utf8");
const nginx = fs.readFileSync("deploy/nginx/agent-hub.vnext.conf.example", "utf8");

assert.match(readiness, /function safeRemoteMetadata\(/u);
assert.doesNotMatch(readiness, /remoteRows\.push\(\{\s*name,\s*url,/u,
  "readiness report must not serialize raw Git remote URLs");
assert.match(readiness, /if \(mode === "production"\) \{\s*const schema = runTsx/u,
  "production schema probe must require production mode");
assert.match(readiness, /skipped in code mode; production database verification requires an explicit production gate/u);
assert.match(readiness, /credentialedRequired\.length === 0/u,
  "credential-bearing HTTPS remotes must fail the formal remote gate");

const accessLogLine = nginx.split(/\r?\n/u).find((line) => /^access_log\s/u.test(line.trim()));
assert.ok(accessLogLine, "Nginx deployment example must select an explicit safe access log format");
assert.match(nginx, /log_format agent_hub_no_args/u);
const logFormatBlock = nginx.slice(nginx.indexOf("log_format agent_hub_no_args"), nginx.indexOf("access_log"));
assert.match(logFormatBlock, /\$request_method \$uri \$server_protocol/u);
assert.doesNotMatch(logFormatBlock, /\$request_uri|\$args|\$query_string|(?:^|[^_])\$request(?:\s|')/u,
  "access log format must not persist request query strings");

console.log("PASS deployment readiness keeps code mode offline from production schema probes");
console.log("PASS deployment readiness redacts raw Git remote URLs and rejects embedded HTTPS credentials");
console.log("PASS Nginx access logs omit query strings that can contain media access tickets");
