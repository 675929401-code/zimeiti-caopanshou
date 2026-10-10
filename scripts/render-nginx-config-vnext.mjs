#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PROJECT_ROOT = process.cwd();
const DEFAULT_TEMPLATE = path.join(
  PROJECT_ROOT,
  "deploy",
  "nginx",
  "agent-hub.vnext.conf.example",
);
const TOKENS = Object.freeze({
  releaseRoot: "__RELEASE_ROOT__",
  serverNames: "__SERVER_NAMES__",
});

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = { force: false, template: DEFAULT_TEMPLATE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      values.force = true;
      continue;
    }
    if (!["--release-root", "--server-names", "--output", "--template"].includes(arg)) {
      fail(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
    index += 1;
    if (arg === "--release-root") values.releaseRoot = value;
    if (arg === "--server-names") values.serverNames = value;
    if (arg === "--output") values.output = value;
    if (arg === "--template") values.template = path.resolve(value);
  }
  return values;
}

function validateReleaseRoot(input) {
  const value = String(input || "").trim().replace(/\/+$/u, "");
  if (!/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    fail("--release-root must be a scoped absolute Linux path");
  }
  if (["/", "/data", "/srv", "/var", "/www", "/opt", "/home", "/root", "/mnt"].includes(value)) {
    fail("--release-root is too broad");
  }
  return value;
}

function validateServerNames(input) {
  const values = String(input || "")
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  if (values.length === 0) fail("--server-names must contain at least one hostname");
  const normalized = [];
  for (const value of values) {
    const hostname = value.toLowerCase();
    if (
      hostname === "example.invalid"
      || hostname.length > 253
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname)
    ) {
      fail(`invalid production hostname: ${value}`);
    }
    if (!normalized.includes(hostname)) normalized.push(hostname);
  }
  return normalized.join(" ");
}

function replaceAll(source, token, value) {
  const occurrences = source.split(token).length - 1;
  if (occurrences === 0) fail(`template token is missing: ${token}`);
  return source.split(token).join(value);
}

function blockFor(source, header) {
  const match = header.exec(source);
  if (!match) fail(`rendered config is missing required block: ${header.source}`);
  const opening = source.indexOf("{", match.index);
  if (opening < 0) fail(`rendered config has an invalid block: ${header.source}`);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  fail(`rendered config has an unterminated block: ${header.source}`);
}

function validateRequestBodyLimits(output) {
  const active = output
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const serverStart = active.search(/(?:^|\n)\s*server\s*\{/u);
  const firstLocation = active.search(/(?:^|\n)\s*location\s/u);
  if (serverStart < 0 || firstLocation <= serverStart) fail("rendered config is missing the server request-size boundary");
  const serverPreamble = active.slice(serverStart, firstLocation);
  if (!/client_max_body_size\s+200m\s*;/u.test(serverPreamble)) {
    fail("server compatibility upload ceiling must remain exactly 200 MiB");
  }

  const notify = blockFor(active, /location\s*=\s*\/api\/payment\/notify\s*\{/u);
  if (!/client_max_body_size\s+64k\s*;/u.test(notify)
    || !/client_body_buffer_size\s+64k\s*;/u.test(notify)) {
    fail("payment notify must keep the 64 KiB edge body and buffer ceilings");
  }

  const refund = blockFor(active, /location\s*=\s*\/api\/payment\/refund\s*\{/u);
  if (!/client_max_body_size\s+16k\s*;/u.test(refund)
    || !/client_body_buffer_size\s+16k\s*;/u.test(refund)
    || !/limit_req\s+zone=agent_hub_paid_write_ip\s+burst=5\s+nodelay\s*;/u.test(refund)) {
    fail("payment refund must keep the 16 KiB edge ceilings and shared paid-write limiter");
  }
  if (!/~\^POST:\/api\/payment\/refund\$\s+\$binary_remote_addr\s*;/u.test(active)) {
    fail("payment refund is missing from the shared paid-write client map");
  }

  for (const [name, header] of [
    ["web application", /location\s+\/\s*\{/u],
    ["voice application", /location\s+\/voice-platform\/\s*\{/u],
  ]) {
    const block = blockFor(active, header);
    if (/client_max_body_size\s+(?:16|64)k\s*;/u.test(block)) {
      fail(`${name} location must not inherit a payment-only body ceiling`);
    }
  }
}

function render({ template, releaseRoot, serverNames }) {
  if (!fs.existsSync(template)) fail(`template does not exist: ${template}`);
  const source = fs.readFileSync(template, "utf8");
  let output = replaceAll(source, TOKENS.releaseRoot, releaseRoot);
  output = replaceAll(output, TOKENS.serverNames, serverNames);
  if (/__[A-Z0-9_]+__/u.test(output)) fail("rendered config contains unresolved placeholders");
  const activeDirectives = output
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  if (
    /^\s*server_name\s+[^;]*example\.invalid[^;]*;/mu.test(activeDirectives)
    || /^\s*(?:root|alias)\s+\/srv\/zimeiti-caopanshou(?:\/|;)/mu.test(activeDirectives)
  ) {
    fail("rendered config still contains an example deployment target");
  }
  if (!output.includes(`server_name ${serverNames};`)) fail("rendered server_name is inconsistent");
  for (const suffix of [
    "/shared/assets/current/public",
    "/shared",
  ]) {
    if (!output.includes(`${releaseRoot}${suffix}`)) fail(`rendered config is missing ${suffix}`);
  }
  const privateReferenceAudio = blockFor(output, /location\s+\^~\s+\/voice-platform\/reference-audio\/\s*\{/u);
  if (!/return\s+404\s*;/u.test(privateReferenceAudio) || /\balias\b/u.test(privateReferenceAudio)) {
    fail("voice reference audio must fail closed at the edge");
  }
  validateRequestBodyLimits(output);
  return `# Generated by render-nginx-config-vnext.mjs; do not edit in place.\n${output}`;
}

function writeAtomic(outputPath, contents, force) {
  const target = path.resolve(outputPath);
  if (fs.existsSync(target) && !force) fail(`output already exists; pass --force to replace it: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o640 });
    if (force && fs.existsSync(target)) fs.rmSync(target);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return target;
}

const args = parseArgs(process.argv.slice(2));
if (!args.releaseRoot) fail("--release-root is required");
if (!args.serverNames) fail("--server-names is required");
if (!args.output) fail("--output is required");

const releaseRoot = validateReleaseRoot(args.releaseRoot);
const serverNames = validateServerNames(args.serverNames);
const contents = render({ template: args.template, releaseRoot, serverNames });
const output = writeAtomic(args.output, contents, args.force);

console.log(JSON.stringify({
  ok: true,
  output,
  releaseRoot,
  serverNames: serverNames.split(" "),
  bytes: Buffer.byteLength(contents),
}, null, 2));
