import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const root = process.cwd();
  const [page, route] = await Promise.all([
    readFile(path.join(root, "src/app/admin/page.tsx"), "utf8"),
    readFile(path.join(root, "src/app/api/health/route.ts"), "utf8"),
  ]);

  assert.match(route, /recentFixes:\s*fixesResult\.error\s*\?\s*\[\]\s*:\s*fixesResult\.data/u, "HEALTH_API_RECENT_FIXES_MISSING");
  assert.match(route, /recentFixes:\s*fixesResult\.error\s*\?\s*'unavailable'\s*:\s*'available'/u, "HEALTH_API_FIX_EVIDENCE_STATE_MISSING");
  assert.match(page, /data-testid="health-recent-fixes"/u, "HEALTH_FIX_PANEL_MISSING");
  assert.match(page, /healthData\.recentFixes\.map/u, "HEALTH_FIX_API_FIELD_NOT_RENDERED");
  assert.doesNotMatch(page, /healthData\?\.fixes|healthData\.fixes/u, "HEALTH_FIX_STALE_FIELD_REGRESSION");
  assert.match(page, /evidenceAvailability\?\.recentFixes === 'unavailable'/u, "HEALTH_FIX_UNAVAILABLE_STATE_HIDDEN");
  assert.match(page, /不会把读取失败显示成“没有记录”/u, "HEALTH_FIX_FAILURE_DISCLOSURE_MISSING");

  console.log(JSON.stringify({
    ok: true,
    apiField: "recentFixes",
    unavailableStateVisible: true,
    emptyStateDistinct: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
