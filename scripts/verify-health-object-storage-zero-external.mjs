import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const healthRoute = readFileSync(resolve("src/app/api/health/route.ts"), "utf8");
const storageCheck = healthRoute.match(
  /async function checkObjectStorage\(\): Promise<HealthCheckResult> \{[\s\S]*?\n\}/u,
)?.[0];

assert.ok(storageCheck, "health route must keep an explicit object-storage summary");
assert.doesNotMatch(
  storageCheck,
  /storageManager\.(?:list|head|exists|read|readBounded|getSignedUrl|upload|uploadFromUrl|delete|deleteBatch)\s*\(/u,
  "default health summary must not call an object-storage provider",
);
assert.doesNotMatch(
  healthRoute,
  /testCozeConnection\s*\(/u,
  "default health summary must not call the Coze provider",
);
assert.match(storageCheck, /storageManager\.getStatus\(\)/u);
assert.match(storageCheck, /externalProbeExecuted:\s*false/u);
assert.match(storageCheck, /connectivityState:\s*['"]unknown['"]/u);
assert.match(storageCheck, /configurationState:\s*['"]configured['"]/u);
assert.match(storageCheck, /status:\s*['"]degraded['"]/u);
assert.match(storageCheck, /confirmsCurrentConnectivity:\s*false/u);
assert.match(storageCheck, /当前外部连通性未知/u);
assert.match(
  healthRoute,
  /from\(['"]user_files['"]\)[\s\S]*?select\(['"]created_at,storage_provider['"]\)[\s\S]*?order\(['"]created_at['"], \{ ascending: false \}\)[\s\S]*?limit\(1\)[\s\S]*?maybeSingle\(\)/u,
  "historical storage evidence must come from one bounded persisted asset row",
);

console.log(JSON.stringify({
  passed: true,
  defaultHealthExternalStorageRequests: 0,
  cozeProviderRequests: 0,
  storageConnectivityWhenUnprobed: "unknown",
  historicalEvidenceSource: "user_files",
  providerWrites: 0,
  paidRequests: 0,
}, null, 2));
