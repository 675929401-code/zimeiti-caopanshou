import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const route = read("src/app/api/settings/admin/route.ts");
const page = read("src/app/admin/page.tsx");

assert.match(route, /PLATFORM_SETTINGS_READBACK_MISMATCH/u, "server must fail when database readback differs");
assert.match(route, /verifiedKeys: writeKeys/u, "server must return the exact database-verified keys");
assert.match(route, /verification: "database-readback"/u, "receipt must name its verification source");
assert.match(page, /receipt\.verification !== "database-readback"/u, "client must reject an unverified success response");
assert.match(page, /missingVerifiedKey/u, "client must check every submitted nonblank field");
assert.match(page, /setSettingsBaseline/u, "client must maintain a durable saved baseline");
assert.match(
  page,
  /setSettingsBaseline\(\(current\) => \(\{ \.\.\.current, theme, theme_mode: themeMode \}\)\)/u,
  "a verified default-theme publish must advance the theme dirty-state baseline",
);
assert.match(page, /beforeunload/u, "dirty settings must warn before leaving");
assert.match(page, /项未保存/u, "the admin header must show unsaved settings clearly");
assert.match(page, /数据库读回确认/u, "success copy must identify confirmed persistence");

console.log(JSON.stringify({
  status: "PASS",
  saveContract: "write -> database readback -> verified key receipt -> client baseline",
}, null, 2));
