import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.resolve(
  scriptDirectory,
  "../src/components/admin/invitation-attribution-panel.tsx",
);
const adminPagePath = path.resolve(scriptDirectory, "../src/app/admin/page.tsx");
const source = readFileSync(componentPath, "utf8");
const adminPageSource = readFileSync(adminPagePath, "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

assert.match(
  source,
  /canManagePackages\s*=\s*false[\s\S]*canExportBilling\s*=\s*false/u,
  "permission props must fail closed when the parent has not supplied access",
);

const loadSection = section("const load = useCallback", "const filtered = useMemo");
assert.match(
  loadSection,
  /canManagePackages\s*\?\s*fetch\("\/api\/admin\/member-packages\/automation"[\s\S]*?:\s*Promise\.resolve\(null\)/u,
  "package automation must not be requested without packages.manage",
);
assert.equal(
  loadSection.match(/\/api\/admin\/member-packages\/automation/gu)?.length,
  1,
  "package automation must have one auditable request site",
);
assert.match(
  loadSection,
  /\}, \[canManagePackages, token\]\);/u,
  "permission changes must refresh the request plan",
);
assert.match(
  loadSection,
  /if \(!canManagePackages\) setPackageRecordId\(null\);/u,
  "revoking packages.manage must close any stale package dialog state",
);

const downloadSection = section("const downloadLedger = async", "const saveMonthlyLimit = async");
assert.match(
  downloadSection,
  /if \(!token \|\| exporting \|\| !canExportBilling\) return;/u,
  "the export handler must reject calls without billing.export",
);
assert.match(
  source,
  /\{canExportBilling && <button data-testid="download-invitation-ledger"/u,
  "the relationship-ledger export must be absent without billing.export",
);

assert.match(
  source,
  /\{canManagePackages && <a data-testid="open-benefit-packages"/u,
  "the benefit-package entry must be absent without packages.manage",
);
assert.match(
  source,
  /\{canManagePackages && <div data-testid="invitation-package-workflow-card"[\s\S]*data-testid="open-member-package"[\s\S]*<\/div>\}/u,
  "the package selection action must be contained by packages.manage",
);
assert.match(
  source,
  /\{canManagePackages && packageRecord && \([\s\S]*data-testid="invitation-package-assignment-dialog"[\s\S]*<MemberPackageAssignmentDialog/u,
  "the package assignment dialog must be absent without packages.manage",
);

const panelMount = adminPageSource.match(/<InvitationAttributionPanel[\s\S]*?\/>/u)?.[0] || "";
assert.match(
  panelMount,
  /canManagePackages=\{canManagePackages\}/u,
  "the admin page must pass its packages.manage plus step-up capability to the panel",
);
assert.match(
  panelMount,
  /canExportBilling=\{canExportBilling\}/u,
  "the admin page must pass its billing.export plus step-up capability to the panel",
);

console.log("invitation attribution permission gates: passed");
