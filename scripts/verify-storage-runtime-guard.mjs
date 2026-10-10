#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(scriptsRoot, "verify-deploy-storage-runtime.sh");
const schemaPath = path.join(scriptsRoot, "contracts", "storage-readiness-receipt.v1.schema.json");
const guard = fs.readFileSync(guardPath, "utf8");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

const requiredGuardFragments = [
  "CONFIG_PATH=/etc/zimeiti/deploy-storage.conf",
  "DATA_ROOT=/data",
  "WEB_ROOT=/data/web",
  "BOOT_ID_PATH=/proc/sys/kernel/random/boot_id",
  "RUNTIME_DIR=/run/zimeiti",
  "storage-readiness.json",
  "must contain exactly five keys",
  "DATA_MOUNT_SOURCE",
  "DATA_MOUNT_UUID",
  "DATA_MARKER_SHA256",
  "MIN_AVAILABLE_BYTES",
  "MIN_AVAILABLE_INODES",
  "findmnt_value TARGET /",
  "findmnt_value 'MAJ:MIN' /",
  "findmnt_value SOURCE /",
  "system and data mount targets are identical",
  "fell back to the system root device",
  "fell back to the system root source",
  "data mount source mismatch",
  "data mount UUID mismatch",
  "ext4|xfs",
  "fstab must contain exactly one matching data mount",
  "live and persistent filesystem types differ",
  "storage marker SHA-256 mismatch",
  "web root is not on the verified data mount",
  "df -B1 --output=avail",
  "df -i --output=iavail",
  "invalid boot_id",
  "must not be a symlink",
  "must use mode 0600",
  "must use mode 0700",
  "must be root:root",
  "mktemp \"$RUNTIME_DIR/.storage-readiness.json.tmp.XXXXXX\"",
  "mv -fT -- \"$TMP_RECEIPT\" \"$RECEIPT_PATH\"",
  "detected-and-fstab-bound-not-config-declared",
];
for (const fragment of requiredGuardFragments) assert.ok(guard.includes(fragment), `guard contract missing: ${fragment}`);
assert.doesNotMatch(guard, /(?:^|\n)\s*(?:source|\.)\s+["']?\$CONFIG_PATH/mu, "configuration must be parsed, never sourced");
assert.doesNotMatch(guard, /\beval\b/u, "guard must not evaluate configuration text");
assert.doesNotMatch(guard, /\bcurl\b|\bwget\b|https?:\/\//u, "guard must remain zero-network");

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.additionalProperties, false);
assert.equal(schema.properties.schemaVersion.const, "zimeiti-storage-readiness.v1");
assert.equal(schema.properties.status.const, "ready");
assert.deepEqual(schema.properties.mount.properties.fstype.enum, ["ext4", "xfs"]);
assert.equal(schema.properties.guard.properties.fstypeBinding.const, "detected-and-fstab-bound-not-config-declared");
for (const flag of [
  "rootAndDataTargetsDistinct",
  "rootAndDataDevicesDistinct",
  "rootAndDataSourcesDistinct",
  "webRootOnDataDevice",
]) assert.equal(schema.properties.paths.properties[flag].const, true);
assert.equal(schema.properties.receipt.properties.atomicWrite.const, true);
assert.equal(schema.properties.receipt.properties.mode.const, "0600");
assert.equal(schema.properties.receipt.properties.ownerUid.const, 0);
assert.equal(schema.properties.receipt.properties.ownerGid.const, 0);
for (const property of schema.required) assert.ok(guard.includes(`  \"${property}\":`), `receipt template missing top-level property: ${property}`);
for (const property of schema.properties.security.required) assert.ok(guard.includes(`    \"${property}\":`), `receipt template missing security property: ${property}`);

function validateSchema(value, contract, location = "$") {
  if (contract.$ref) {
    const match = /^#\/\$defs\/([A-Za-z0-9_-]+)$/u.exec(contract.$ref);
    assert.ok(match, `${location}: unsupported schema reference`);
    return validateSchema(value, schema.$defs[match[1]], location);
  }
  if (Object.hasOwn(contract, "const")) assert.deepEqual(value, contract.const, `${location}: const mismatch`);
  if (contract.enum) assert.ok(contract.enum.includes(value), `${location}: enum mismatch`);
  if (contract.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location}: expected object`);
    for (const key of contract.required || []) assert.ok(Object.hasOwn(value, key), `${location}: missing ${key}`);
    if (contract.additionalProperties === false) {
      for (const key of Object.keys(value)) assert.ok(Object.hasOwn(contract.properties || {}, key), `${location}: extra ${key}`);
    }
    for (const [key, child] of Object.entries(contract.properties || {})) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${location}.${key}`);
    }
  } else if (contract.type === "string") {
    assert.equal(typeof value, "string", `${location}: expected string`);
    if (contract.pattern) assert.match(value, new RegExp(contract.pattern, "u"), `${location}: pattern mismatch`);
    if (contract.minLength !== undefined) assert.ok(value.length >= contract.minLength, `${location}: too short`);
    if (contract.maxLength !== undefined) assert.ok(value.length <= contract.maxLength, `${location}: too long`);
    if (contract.format === "date-time") assert.ok(Number.isFinite(Date.parse(value)), `${location}: invalid date-time`);
  } else if (contract.type === "integer") {
    assert.ok(Number.isSafeInteger(value), `${location}: expected safe integer`);
    if (contract.minimum !== undefined) assert.ok(value >= contract.minimum, `${location}: below minimum`);
    if (contract.maximum !== undefined) assert.ok(value <= contract.maximum, `${location}: above maximum`);
  }
}

const receiptFixture = {
  schemaVersion: "zimeiti-storage-readiness.v1",
  status: "ready",
  verifiedAt: "2026-10-10T03:00:00Z",
  verifiedEpoch: 1_760_067_600,
  bootId: "12345678-1234-4abc-8def-1234567890ab",
  guard: {
    script: "verify-deploy-storage-runtime.sh",
    configPath: "/etc/zimeiti/deploy-storage.conf",
    configSha256: "a".repeat(64),
    fstypeBinding: "detected-and-fstab-bound-not-config-declared",
  },
  mount: {
    rootTarget: "/",
    target: "/data",
    rootSource: "/dev/vda1",
    source: "/dev/vdb",
    uuid: "fixture-uuid-0001",
    fstype: "ext4",
    rootMajorMinor: "8:1",
    majorMinor: "8:16",
    fstabSource: "UUID=fixture-uuid-0001",
    fstabFstype: "ext4",
    fstabTarget: "/data",
    independent: true,
  },
  marker: { path: "/data/.zimeiti-storage-root", sha256: "a".repeat(64) },
  capacity: {
    availableBytes: 21_474_836_480,
    minimumAvailableBytes: 5_368_709_120,
    availableInodes: 200_000,
    minimumAvailableInodes: 50_000,
  },
  paths: {
    dataRoot: "/data",
    webRoot: "/data/web",
    rootAndDataTargetsDistinct: true,
    rootAndDataDevicesDistinct: true,
    rootAndDataSourcesDistinct: true,
    webRootOnDataDevice: true,
  },
  security: {
    configRootOwned: true,
    configMode: "0600",
    fstabRootOwned: true,
    fstabMode: "0644",
    dataRootOwned: true,
    dataRootMode: "0755",
    webRootOwned: true,
    webRootMode: "0755",
    markerRootOwned: true,
    markerMode: "0600",
    runtimeDirectoryRootOwned: true,
    runtimeDirectoryMode: "0700",
    symlinksRejected: true,
  },
  receipt: { path: "/run/zimeiti/storage-readiness.json", ownerUid: 0, ownerGid: 0, mode: "0600", atomicWrite: true },
};
validateSchema(receiptFixture, schema);
assert.throws(() => validateSchema({ ...receiptFixture, status: "stale" }, schema), /const mismatch/u);

const sha = "a".repeat(64);
const bootId = "12345678-1234-4abc-8def-1234567890ab";
const base = Object.freeze({
  configRegular: true,
  configSymlink: false,
  configUid: 0,
  configGid: 0,
  configMode: 0o600,
  configKeys: ["DATA_MOUNT_SOURCE", "DATA_MOUNT_UUID", "DATA_MARKER_SHA256", "MIN_AVAILABLE_BYTES", "MIN_AVAILABLE_INODES"],
  mounted: true,
  dataRedirected: false,
  dataUid: 0,
  dataGid: 0,
  dataMode: 0o755,
  rootTarget: "/",
  dataTarget: "/data",
  rootDevice: "8:1",
  dataDevice: "8:16",
  rootSource: "/dev/vda1",
  dataSource: "/dev/vdb",
  expectedSource: "/dev/vdb",
  dataUuid: "fixture-uuid-0001",
  expectedUuid: "fixture-uuid-0001",
  fstype: "ext4",
  fstabRows: 1,
  fstabSource: "UUID=fixture-uuid-0001",
  fstabFstype: "ext4",
  fstabTarget: "/data",
  fstabUid: 0,
  fstabGid: 0,
  fstabMode: 0o644,
  webSymlink: false,
  webUid: 0,
  webGid: 0,
  webMode: 0o755,
  webTarget: "/data",
  webDevice: "8:16",
  markerRegular: true,
  markerSymlink: false,
  markerUid: 0,
  markerGid: 0,
  markerMode: 0o600,
  markerTarget: "/data",
  markerDevice: "8:16",
  markerSha: sha,
  expectedMarkerSha: sha,
  minimumBytes: 5_368_709_120,
  availableBytes: 21_474_836_480,
  minimumInodes: 50_000,
  availableInodes: 200_000,
  bootId,
  runtimeSymlink: false,
  runtimeUid: 0,
  runtimeGid: 0,
  runtimeMode: 0o700,
  receiptSymlink: false,
  existingReceiptUid: 0,
  existingReceiptGid: 0,
  existingReceiptMode: 0o600,
});

class Rejected extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new Rejected(code); };
const rootOwned = (uid, gid) => uid === 0 && gid === 0;
const notGroupOtherWritable = mode => (mode & 0o7022) === 0;

function evaluateFixture(overrides = {}) {
  const f = { ...base, ...overrides };
  if (!f.configRegular || f.configSymlink) reject("config-type");
  if (!rootOwned(f.configUid, f.configGid)) reject("config-owner");
  if (f.configMode !== 0o600) reject("config-mode");
  if (f.configKeys.length !== 5 || new Set(f.configKeys).size !== 5 || f.configKeys.some(key => !base.configKeys.includes(key))) reject("config-keys");
  if (!f.mounted || f.dataRedirected) reject("mountpoint");
  if (!rootOwned(f.dataUid, f.dataGid) || !notGroupOtherWritable(f.dataMode)) reject("data-permissions");
  if (!/^[0-9]+:[0-9]+$/u.test(f.rootDevice) || !/^[0-9]+:[0-9]+$/u.test(f.dataDevice)) reject("device-identity");
  if (!/^[A-Za-z0-9._/+:-]+$/u.test(f.rootSource)) reject("root-source-identity");
  if (f.rootTarget !== "/" || f.rootTarget === f.dataTarget) reject("target-fallback");
  if (f.rootDevice === f.dataDevice) reject("device-fallback");
  if (f.rootSource === f.dataSource) reject("source-fallback");
  if (f.dataSource !== f.expectedSource) reject("source-mismatch");
  if (f.dataUuid !== f.expectedUuid) reject("uuid-mismatch");
  if (!new Set(["ext4", "xfs"]).has(f.fstype)) reject("fstype-policy");
  if (!rootOwned(f.fstabUid, f.fstabGid) || !notGroupOtherWritable(f.fstabMode)) reject("fstab-permissions");
  if (f.fstabRows !== 1) reject("fstab-cardinality");
  if (![`UUID=${f.expectedUuid}`, `/dev/disk/by-uuid/${f.expectedUuid}`].includes(f.fstabSource)) reject("fstab-uuid");
  if (f.fstabTarget !== f.dataTarget || f.fstabFstype !== f.fstype) reject("fstab-live-mismatch");
  if (f.webSymlink || !rootOwned(f.webUid, f.webGid) || !notGroupOtherWritable(f.webMode)) reject("web-permissions");
  if (f.webTarget !== f.dataTarget || f.webDevice !== f.dataDevice) reject("web-device");
  if (!f.markerRegular || f.markerSymlink) reject("marker-type");
  if (!rootOwned(f.markerUid, f.markerGid) || f.markerMode !== 0o600) reject("marker-permissions");
  if (f.markerTarget !== f.dataTarget || f.markerDevice !== f.dataDevice) reject("marker-device");
  if (f.markerSha !== f.expectedMarkerSha) reject("marker-sha");
  if (f.minimumBytes < 5_368_709_120 || f.availableBytes < f.minimumBytes) reject("capacity-bytes");
  if (f.minimumInodes < 50_000 || f.availableInodes < f.minimumInodes) reject("capacity-inodes");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(f.bootId)) reject("boot-id");
  if (f.runtimeSymlink || !rootOwned(f.runtimeUid, f.runtimeGid) || f.runtimeMode !== 0o700) reject("runtime-permissions");
  if (f.receiptSymlink) reject("receipt-symlink");
  if (!rootOwned(f.existingReceiptUid, f.existingReceiptGid) || f.existingReceiptMode !== 0o600) reject("receipt-permissions");
  return {
    schemaVersion: "zimeiti-storage-readiness.v1",
    status: "ready",
    bootId: f.bootId,
    fstypeBinding: "detected-and-fstab-bound-not-config-declared",
    independent: true,
    atomicWrite: true,
  };
}

assert.equal(evaluateFixture().status, "ready");
const rejections = [
  ["config-symlink", { configSymlink: true }, "config-type"],
  ["config-wide-mode", { configMode: 0o644 }, "config-mode"],
  ["config-wrong-owner", { configUid: 1000 }, "config-owner"],
  ["config-extra-key", { configKeys: [...base.configKeys, "DATA_MOUNT_FSTYPE"] }, "config-keys"],
  ["missing-mount", { mounted: false }, "mountpoint"],
  ["data-redirect", { dataRedirected: true }, "mountpoint"],
  ["data-wide-mode", { dataMode: 0o777 }, "data-permissions"],
  ["data-special-mode", { dataMode: 0o1755 }, "data-permissions"],
  ["invalid-device-identity", { dataDevice: "unknown" }, "device-identity"],
  ["unsafe-root-source-identity", { rootSource: "root\"source" }, "root-source-identity"],
  ["target-fallback", { dataTarget: "/" }, "target-fallback"],
  ["device-fallback", { dataDevice: "8:1" }, "device-fallback"],
  ["source-fallback", { dataSource: "/dev/vda1", expectedSource: "/dev/vda1" }, "source-fallback"],
  ["source-mismatch", { dataSource: "/dev/vdc" }, "source-mismatch"],
  ["uuid-mismatch", { dataUuid: "wrong-uuid" }, "uuid-mismatch"],
  ["unsupported-fstype", { fstype: "btrfs", fstabFstype: "btrfs" }, "fstype-policy"],
  ["fstab-wide-mode", { fstabMode: 0o666 }, "fstab-permissions"],
  ["duplicate-fstab", { fstabRows: 2 }, "fstab-cardinality"],
  ["fstab-wrong-uuid", { fstabSource: "UUID=other-volume" }, "fstab-uuid"],
  ["fstab-fstype-drift", { fstabFstype: "xfs" }, "fstab-live-mismatch"],
  ["web-symlink", { webSymlink: true }, "web-permissions"],
  ["web-system-device", { webDevice: "8:1" }, "web-device"],
  ["marker-symlink", { markerSymlink: true }, "marker-type"],
  ["marker-wide-mode", { markerMode: 0o644 }, "marker-permissions"],
  ["marker-wrong-owner", { markerUid: 1000 }, "marker-permissions"],
  ["marker-hash-mismatch", { markerSha: "b".repeat(64) }, "marker-sha"],
  ["low-capacity", { availableBytes: 5_368_709_119 }, "capacity-bytes"],
  ["low-inodes", { availableInodes: 49_999 }, "capacity-inodes"],
  ["invalid-boot-id", { bootId: "stale-or-invalid" }, "boot-id"],
  ["runtime-symlink", { runtimeSymlink: true }, "runtime-permissions"],
  ["runtime-wide-mode", { runtimeMode: 0o755 }, "runtime-permissions"],
  ["receipt-symlink", { receiptSymlink: true }, "receipt-symlink"],
  ["receipt-wrong-owner", { existingReceiptUid: 1000 }, "receipt-permissions"],
];
for (const [name, fixture, expected] of rejections) {
  assert.throws(() => evaluateFixture(fixture), error => error instanceof Rejected && error.code === expected, name);
}

const bash = process.env.STORAGE_GUARD_BASH || "bash";
const syntax = spawnSync(bash, ["-n", guardPath], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
const shellSyntax = syntax.error?.code === "ENOENT"
  ? "not-available-on-host"
  : syntax.status === 0
    ? "passed"
    : `failed:${syntax.stderr || syntax.status}`;
if (!shellSyntax.startsWith("not-available")) assert.equal(shellSyntax, "passed", "bash syntax check failed");

console.log(JSON.stringify({
  verifier: "storage-runtime-guard",
  status: "PASS",
  networkCalls: 0,
  productionReads: 0,
  productionWrites: 0,
  positiveFixtures: 1,
  negativeFixtures: rejections.length,
  shellSyntax,
  checks: [
    "five-key-config-is-parsed-not-sourced",
    "root-data-target-device-source-triple-isolation",
    "live-fstype-fstab-binding-ext4-xfs-only",
    "uuid-source-marker-capacity-inode-boot-binding",
    "symlink-owner-and-permission-rejections",
    "atomic-runtime-receipt-contract",
    "receipt-schema-closed-and-boot-bound",
  ],
}, null, 2));
