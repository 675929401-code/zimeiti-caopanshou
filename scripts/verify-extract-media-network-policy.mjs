import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  isSyntheticProxyAddress,
  isTrustedExtractMediaHostname,
  temporaryExtractMediaNetworkOptions,
} from "../src/lib/extract-media-network.ts";

const synthetic = [
  { address: "198.18.0.109", family: 4 },
  { address: "2001:2::5a", family: 6 },
];
const systemPinned = { networkPolicy: "system-dns-pinned" };
const credentialBearingUrl = new URL("https://v5-dy-ov-experiment.zjcdn.com/video.mp4");
credentialBearingUrl.username = "fixture-user";
credentialBearingUrl.password = "fixture-secret";

assert.equal(isTrustedExtractMediaHostname("v5-coldm.douyinvod.com"), true);
assert.equal(isTrustedExtractMediaHostname("V5-COLDM.DOUYINVOD.COM."), true);
assert.equal(isTrustedExtractMediaHostname("v5-dy-ov-experiment.zjcdn.com"), true);
assert.equal(isTrustedExtractMediaHostname("v5-hl-zenl-ov.zjcdn.com"), true);
assert.equal(isTrustedExtractMediaHostname("douyinvod.com.evil.invalid"), false);
assert.equal(isTrustedExtractMediaHostname("zjcdn.com"), false);
assert.equal(isTrustedExtractMediaHostname("zjcdn.com.evil.invalid"), false);
assert.equal(isTrustedExtractMediaHostname("evil.zjcdn.com"), false);
assert.equal(isTrustedExtractMediaHostname("evil.v5-dy-ov-experiment.zjcdn.com"), false);
assert.equal(isTrustedExtractMediaHostname("v5-dy-ov-experiment.zjcdn.com.evil.invalid"), false);
assert.equal(isSyntheticProxyAddress("198.18.0.109"), true);
assert.equal(isSyntheticProxyAddress("198.19.255.254"), true);
assert.equal(isSyntheticProxyAddress("198.20.0.1"), false);
assert.equal(isSyntheticProxyAddress("2001:2::5a"), true);
assert.equal(isSyntheticProxyAddress("2001:0002:0:0:0:0:0:5a"), true);
assert.equal(isSyntheticProxyAddress("127.0.0.1"), false);

let lookups = 0;
const trusted = await temporaryExtractMediaNetworkOptions(
  new URL("https://v5-coldm.douyinvod.com/video.mp4"),
  async hostname => {
    lookups += 1;
    assert.equal(hostname, "v5-coldm.douyinvod.com");
    return synthetic;
  },
);
assert.deepEqual(trusted, { trustedHostnames: ["v5-coldm.douyinvod.com"] });
assert.equal(lookups, 1);

for (const hostname of ["v5-dy-ov-experiment.zjcdn.com", "v5-hl-zenl-ov.zjcdn.com"]) {
  assert.deepEqual(
    await temporaryExtractMediaNetworkOptions(
      new URL(`https://${hostname}/video.mp4`),
      async resolvedHostname => {
        assert.equal(resolvedHostname, hostname);
        return synthetic;
      },
    ),
    { trustedHostnames: [hostname] },
  );
}

for (const [url, addresses] of [
  ["http://v5-coldm.douyinvod.com/video.mp4", synthetic],
  ["https://v5-coldm.douyinvod.com:8443/video.mp4", synthetic],
  ["https://douyinvod.com.evil.invalid/video.mp4", synthetic],
  ["https://zjcdn.com/video.mp4", synthetic],
  ["https://zjcdn.com.evil.invalid/video.mp4", synthetic],
  ["https://evil.zjcdn.com/video.mp4", synthetic],
  ["https://evil.v5-dy-ov-experiment.zjcdn.com/video.mp4", synthetic],
  ["https://v5-dy-ov-experiment.zjcdn.com.evil.invalid/video.mp4", synthetic],
  [credentialBearingUrl.toString(), synthetic],
  ["https://v5-dy-ov-experiment.zjcdn.com:8443/video.mp4", synthetic],
  ["https://v5-coldm.douyinvod.com/video.mp4", [{ address: "1.1.1.1", family: 4 }]],
  ["https://v5-dy-ov-experiment.zjcdn.com/video.mp4", [{ address: "1.1.1.1", family: 4 }]],
  ["https://v5-coldm.douyinvod.com/video.mp4", [...synthetic, { address: "127.0.0.1", family: 4 }]],
  ["https://v5-dy-ov-experiment.zjcdn.com/video.mp4", [...synthetic, { address: "127.0.0.1", family: 4 }]],
  ["https://v5-coldm.douyinvod.com/video.mp4", []],
]) {
  assert.deepEqual(
    await temporaryExtractMediaNetworkOptions(new URL(url), async () => addresses),
    systemPinned,
    `unsafe fallback for ${url}`,
  );
}

assert.deepEqual(
  await temporaryExtractMediaNetworkOptions(
    new URL("https://v5-coldm.douyinvod.com/video.mp4"),
    async () => { throw new Error("DNS unavailable"); },
  ),
  systemPinned,
);

const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  cases: 36,
  exactApprovedHostnameRequired: true,
  httpsDefaultPortRequired: true,
  allDnsAnswersMustBeSyntheticProxyAddresses: true,
  arbitraryPrivateAndLookalikeHostsRemainPinnedAndBlocked: true,
  realNetworkRequests: 0,
  realDatabaseWrites: 0,
};
await mkdir(".codex-evidence/extract-media-network-policy", { recursive: true });
await writeFile(".codex-evidence/extract-media-network-policy/report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report));
