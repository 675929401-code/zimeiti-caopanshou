#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertJsonSchema, canonicalJson, compareProtocolStrings, sha256 } from "./lib/json-schema-contract.mjs";

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error("ARGUMENT_INVALID");
    values.set(key, argv[++index]);
  }
  return values;
}

function atomicWrite(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNonRuntimePackageDocumentation(relative) {
  const normalized = relative.replace(/\\/gu, "/").toLowerCase();
  const extension = path.posix.extname(normalized);
  return normalized.split("/").includes("node_modules")
    && (extension === ".md" || extension === ".markdown");
}

function collect(absolute, relative, files, options) {
  const stat = fs.lstatSync(absolute);
  if (path.posix.extname(relative).toLowerCase() === ".map" || isNonRuntimePackageDocumentation(relative)) return;
  if (stat.isSymbolicLink()) {
    const realTarget = fs.realpathSync.native(absolute);
    if (!options.trustedRoots.some((trustedRoot) => isInside(trustedRoot, realTarget))) {
      throw new Error("BUILD_OUTPUT_SYMLINK_ESCAPE");
    }
    const targetStat = fs.statSync(absolute);
    if (targetStat.isDirectory()) {
      const key = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
      if (options.activeRealDirectories.has(key)) throw new Error("BUILD_OUTPUT_SYMLINK_CYCLE");
      options.activeRealDirectories.add(key);
      try {
        for (const entry of fs.readdirSync(realTarget).sort(compareProtocolStrings)) {
          collect(path.join(realTarget, entry), `${relative}/${entry}`, files, { ...options, materialized: true });
        }
      } finally {
        options.activeRealDirectories.delete(key);
      }
      return;
    }
    if (!targetStat.isFile()) throw new Error("BUILD_OUTPUT_SYMLINK_TARGET_INVALID");
    const body = fs.readFileSync(absolute);
    files.push({
      path: relative,
      kind: "file",
      sourceKind: "materialized-symlink",
      mode: targetStat.mode & 0o777,
      size: body.length,
      sha256: sha256(body),
    });
    return;
  }
  if (stat.isDirectory()) {
    const realDirectory = fs.realpathSync.native(absolute);
    const key = process.platform === "win32" ? realDirectory.toLowerCase() : realDirectory;
    if (options.activeRealDirectories.has(key)) throw new Error("BUILD_OUTPUT_DIRECTORY_CYCLE");
    options.activeRealDirectories.add(key);
    try {
      for (const entry of fs.readdirSync(absolute).sort(compareProtocolStrings)) {
        collect(path.join(absolute, entry), `${relative}/${entry}`, files, options);
      }
    } finally {
      options.activeRealDirectories.delete(key);
    }
    return;
  }
  if (!stat.isFile()) throw new Error("BUILD_OUTPUT_NON_FILE_FORBIDDEN");
  const body = fs.readFileSync(absolute);
  files.push({
    path: relative,
    kind: "file",
    sourceKind: options.materialized ? "materialized-symlink" : "direct",
    mode: stat.mode & 0o777,
    size: body.length,
    sha256: sha256(body),
  });
}

export function computeBuildOutputDigest(root, service, commit, sourceVersion) {
  if (!new Set(["web", "voice"]).has(service)) throw new Error("BUILD_OUTPUT_SERVICE_INVALID");
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) throw new Error("BUILD_OUTPUT_COMMIT_INVALID");
  if (!sourceVersion || /[\u0000-\u001f\u007f]/u.test(sourceVersion)) throw new Error("BUILD_OUTPUT_SOURCE_VERSION_INVALID");
  const serviceRoot = service === "voice" ? path.join(root, "voice-platform") : root;
  const buildRoot = path.join(serviceRoot, ".next");
  const roots = [".next/BUILD_ID", ".next/standalone", ".next/static"];
  for (const relative of roots) {
    const absolute = path.join(serviceRoot, ...relative.split("/"));
    if (!fs.existsSync(absolute)) throw new Error(`BUILD_OUTPUT_ROOT_MISSING:${relative}`);
  }
  const files = [];
  const trustedRoots = [
    path.join(serviceRoot, ".next", "standalone"),
    path.join(serviceRoot, "node_modules"),
    path.join(root, "node_modules"),
  ].filter((candidate, index, values) => fs.existsSync(candidate) && values.indexOf(candidate) === index)
    .map((candidate) => fs.realpathSync.native(candidate));
  for (const relative of roots) {
    collect(path.join(serviceRoot, ...relative.split("/")), relative, files, {
      trustedRoots,
      activeRealDirectories: new Set(),
      materialized: false,
    });
  }
  files.sort((left, right) => compareProtocolStrings(left.path, right.path));
  const buildId = fs.readFileSync(path.join(buildRoot, "BUILD_ID"), "utf8").trim();
  if (!buildId || /[\u0000-\u001f\u007f]/u.test(buildId)) throw new Error("BUILD_OUTPUT_BUILD_ID_INVALID");
  const identity = { service, commit, sourceVersion, buildId, files };
  return {
    schemaVersion: "zimeiti-release-build-output-digest.v1",
    service,
    commit,
    sourceVersion,
    buildId,
    roots,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    outputDigest: sha256(canonicalJson(identity)),
  };
}

function main() {
  const options = args(process.argv.slice(2));
  const root = path.resolve(options.get("--root") || process.cwd());
  const schema = JSON.parse(fs.readFileSync(path.join(root, "scripts/contracts/release-build-output-digest.v1.schema.json"), "utf8"));
  const receiptFile = path.resolve(options.get("--receipt") || "");
  const service = options.get("--service");
  const commit = String(options.get("--commit") || "").toLowerCase();
  const sourceVersion = options.get("--source-version");
  const actual = computeBuildOutputDigest(root, service, commit, sourceVersion);
  assertJsonSchema(schema, actual, "BUILD_OUTPUT_DIGEST_SCHEMA_INVALID");
  if (options.has("--verify")) {
    const expected = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    assertJsonSchema(schema, expected, "BUILD_OUTPUT_DIGEST_SCHEMA_INVALID");
    if (canonicalJson(expected) !== canonicalJson(actual)) throw new Error("BUILD_OUTPUT_DIGEST_MISMATCH");
  } else {
    atomicWrite(receiptFile, `${JSON.stringify(actual, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ service, buildId: actual.buildId, outputDigest: actual.outputDigest, verified: options.has("--verify") })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(`RELEASE_BUILD_OUTPUT_DIGEST_FAILED ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}\n`);
    process.exitCode = 2;
  }
}
