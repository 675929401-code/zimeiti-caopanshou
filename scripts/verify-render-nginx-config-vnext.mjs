#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const renderer = path.join(root, "scripts", "render-nginx-config-vnext.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nginx-vnext-render-"));
const output = path.join(temporaryRoot, "agent-hub.conf");

function run(args) {
  return spawnSync(process.execPath, [renderer, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

function blockFor(source, header) {
  const match = header.exec(source);
  assert.ok(match, `missing block: ${header.source}`);
  const opening = source.indexOf("{", match.index);
  assert.notEqual(opening, -1, `missing opening brace: ${header.source}`);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  assert.fail(`unterminated block: ${header.source}`);
}

try {
  const valid = run([
    "--release-root", "/data/web",
    "--server-names", "zycheni9.com,www.zycheni9.com zyuani8.com www.zyuani8.com",
    "--output", output,
  ]);
  assert.equal(valid.status, 0, valid.stderr);
  const rendered = fs.readFileSync(output, "utf8");
  assert.match(rendered, /server_name zycheni9\.com www\.zycheni9\.com zyuani8\.com www\.zyuani8\.com;/u);
  assert.match(rendered, /root \/data\/web\/shared\/assets\/current\/public;/u);
  assert.match(rendered, /root \/data\/web\/shared;/u);
  assert.match(rendered, /alias \/data\/web\/shared\/voice\/reference-audio\//u);
  const notify = blockFor(rendered, /location\s*=\s*\/api\/payment\/notify\s*\{/u);
  assert.match(notify, /client_max_body_size 64k;/u);
  assert.match(notify, /client_body_buffer_size 64k;/u);
  const refund = blockFor(rendered, /location\s*=\s*\/api\/payment\/refund\s*\{/u);
  assert.match(refund, /client_max_body_size 16k;/u);
  assert.match(refund, /client_body_buffer_size 16k;/u);
  assert.match(refund, /limit_req zone=agent_hub_paid_write_ip burst=5 nodelay;/u);
  assert.match(rendered, /~\^POST:\/api\/payment\/refund\$ \$binary_remote_addr;/u);
  assert.match(rendered, /server\s*\{[\s\S]*?client_max_body_size 200m;/u);
  for (const header of [/location\s+\/\s*\{/u, /location\s+\/voice-platform\/\s*\{/u]) {
    assert.doesNotMatch(blockFor(rendered, header), /client_max_body_size\s+(?:16|64)k;/u);
  }
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/u);
  assert.doesNotMatch(rendered, /^\s*server_name\s+[^;]*example\.invalid[^;]*;/mu);
  assert.doesNotMatch(rendered, /^\s*(?:root|alias)\s+\/srv\/zimeiti-caopanshou(?:\/|;)/mu);

  const refusesOverwrite = run([
    "--release-root", "/data/web",
    "--server-names", "zycheni9.com",
    "--output", output,
  ]);
  assert.notEqual(refusesOverwrite.status, 0);
  assert.match(refusesOverwrite.stderr, /output already exists/u);

  const forced = run([
    "--release-root", "/data/web",
    "--server-names", "zycheni9.com",
    "--output", output,
    "--force",
  ]);
  assert.equal(forced.status, 0, forced.stderr);

  for (const args of [
    ["--release-root", "/data", "--server-names", "zycheni9.com", "--output", path.join(temporaryRoot, "broad.conf")],
    ["--release-root", "/data/web", "--server-names", "example.invalid", "--output", path.join(temporaryRoot, "example.conf")],
    ["--release-root", "/data/web", "--server-names", "zycheni9.com;return", "--output", path.join(temporaryRoot, "inject.conf")],
  ]) {
    const invalid = run(args);
    assert.notEqual(invalid.status, 0, `unsafe renderer input unexpectedly passed: ${args.join(" ")}`);
  }

  const templateSource = fs.readFileSync(path.join(root, "deploy", "nginx", "agent-hub.vnext.conf.example"), "utf8");
  const unsafeTemplates = [
    ["wide-refund", templateSource.replace("client_max_body_size 16k;", "client_max_body_size 200m;")],
    ["small-upload", templateSource.replace("location / {", "location / {\n        client_max_body_size 16k;")],
    ["wide-server", templateSource.replace("client_max_body_size 200m;", "client_max_body_size 500m;")],
  ];
  for (const [name, source] of unsafeTemplates) {
    const template = path.join(temporaryRoot, `${name}.template`);
    fs.writeFileSync(template, source, "utf8");
    const invalid = run([
      "--release-root", "/data/web",
      "--server-names", "zycheni9.com",
      "--template", template,
      "--output", path.join(temporaryRoot, `${name}.conf`),
    ]);
    assert.notEqual(invalid.status, 0, `unsafe request-size template unexpectedly passed: ${name}`);
  }

  console.log("PASS Nginx vNext renderer pins the requested release root and production hostnames");
  console.log("PASS payment body ceilings are exact while media upload routes retain the 200 MiB compatibility ceiling");
  console.log("PASS unsafe roots, placeholder domains, injection text, request-size drift and accidental overwrite are rejected");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
