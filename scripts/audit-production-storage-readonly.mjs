#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const rootArgument = process.argv.find((argument) => argument.startsWith("--root="));
const requestedRoot = rootArgument?.slice("--root=".length) || "/srv/zimeiti-caopanshou";
const releaseRoot = fs.realpathSync(requestedRoot);

function pointer(name, expectedParent) {
  const file = path.join(releaseRoot, name);
  const link = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!link) return { name, present: false, valid: false };
  if (!link.isSymbolicLink()) return { name, present: true, valid: false, reason: "not-symlink" };
  let target;
  try {
    target = fs.realpathSync(file);
  } catch {
    return { name, present: true, valid: false, reason: "broken-symlink" };
  }
  const parent = path.join(releaseRoot, expectedParent) + path.sep;
  return {
    name,
    present: true,
    valid: target.startsWith(parent),
    target: path.relative(releaseRoot, target).replaceAll(path.sep, "/"),
  };
}

function collectLocalMediaUrls(value, found = new Set()) {
  if (typeof value === "string") {
    if (/^\/commerce\/discovery\/media\/[a-f0-9]{64}\.[a-z0-9]{2,8}$/iu.test(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocalMediaUrls(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectLocalMediaUrls(item, found);
  }
  return found;
}

function directoryState(relativePath) {
  const target = path.join(releaseRoot, relativePath);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  return {
    path: relativePath,
    present: Boolean(stat),
    regularDirectory: Boolean(stat?.isDirectory() && !stat.isSymbolicLink()),
  };
}

const discoveryRoot = path.join(releaseRoot, "shared", "runtime", "commerce-discovery");
const mediaRoot = path.join(discoveryRoot, "media");
const catalogPath = path.join(discoveryRoot, "catalog.json");
const catalogStat = fs.lstatSync(catalogPath, { throwIfNoEntry: false });
const catalog = catalogStat?.isFile() && !catalogStat.isSymbolicLink()
  ? JSON.parse(fs.readFileSync(catalogPath, "utf8").replace(/^\uFEFF/u, ""))
  : null;
const urls = catalog ? [...collectLocalMediaUrls(catalog)].sort() : [];
const expectedByUrl = new Map();
for (const item of catalog?.items || []) {
  for (const asset of Array.isArray(item.assets) ? item.assets : []) {
    if (typeof asset?.url === "string") expectedByUrl.set(asset.url, asset);
  }
}

const issues = [];
let verifiedBytes = 0;
for (const url of urls) {
  const fileName = path.posix.basename(url);
  const candidate = path.join(mediaRoot, fileName);
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) {
    issues.push({ code: "MISSING_MEDIA", file: fileName });
    continue;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    issues.push({ code: "UNSAFE_MEDIA_ENTRY", file: fileName });
    continue;
  }
  const resolved = fs.realpathSync(candidate);
  if (!resolved.startsWith(fs.realpathSync(mediaRoot) + path.sep)) {
    issues.push({ code: "MEDIA_PATH_ESCAPE", file: fileName });
    continue;
  }
  const expected = expectedByUrl.get(url);
  if (Number.isSafeInteger(expected?.bytes) && expected.bytes !== stat.size) {
    issues.push({ code: "MEDIA_SIZE_MISMATCH", file: fileName, expected: expected.bytes, actual: stat.size });
    continue;
  }
  verifiedBytes += stat.size;
}

const filesystem = fs.statfsSync(releaseRoot);
const report = {
  schemaVersion: 1,
  kind: "production-storage-readonly-audit",
  observedAt: new Date().toISOString(),
  releaseRoot,
  pointers: [
    pointer("current-web", "releases"),
    pointer("current-voice", "releases"),
    pointer(path.join("shared", "assets", "current"), path.join("shared", "assets", "releases")),
  ],
  persistentRoots: [
    "shared/data",
    "shared/runtime",
    "shared/uploads",
    "shared/assets",
    "shared/voice",
    "shared/logs",
    "shared/backups",
  ].map(directoryState),
  discovery: {
    catalogPresent: Boolean(catalog),
    catalogSchema: catalog?.schema ?? null,
    itemCount: Array.isArray(catalog?.items) ? catalog.items.length : 0,
    referencedMediaCount: urls.length,
    verifiedMediaCount: urls.length - issues.length,
    verifiedBytes,
    issueCount: issues.length,
    issues: issues.slice(0, 20),
  },
  filesystem: {
    blockSize: filesystem.bsize,
    blocks: filesystem.blocks,
    blocksAvailable: filesystem.bavail,
    bytesAvailable: filesystem.bsize * filesystem.bavail,
  },
  databaseWrites: 0,
  fileWrites: 0,
  paidCalls: 0,
};

report.passed = report.pointers.every((item) => item.present ? item.valid : item.name === "current-voice")
  && report.persistentRoots.every((item) => item.regularDirectory)
  && report.discovery.catalogPresent
  && report.discovery.itemCount > 0
  && report.discovery.referencedMediaCount > 0
  && report.discovery.issueCount === 0;

console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 2;
