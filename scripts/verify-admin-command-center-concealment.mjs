import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const route = readFileSync(
  resolve(process.cwd(), "src/app/api/admin/command-center/route.ts"),
  "utf8",
);

const incompleteStart = route.indexOf("if (missingPermissions.length > 0)");
assert.notEqual(incompleteStart, -1, "command-center incomplete-permission branch is required");
const responseStart = route.indexOf("return noStore(NextResponse.json({", incompleteStart);
const responseEnd = route.indexOf("}, { status: 403 }))", responseStart);
assert.ok(responseStart > incompleteStart && responseEnd > responseStart, "command-center denial response must be inspectable");

const clientDenial = route.slice(responseStart, responseEnd);
assert.match(clientDenial, /ADMIN_PERMISSION_SET_INCOMPLETE/u);
assert.doesNotMatch(
  clientDenial,
  /requiredPermissions|missingPermissions|ADMIN_COMMAND_CENTER_PERMISSION_KEYS/u,
  "ordinary denial must not serialize granted or missing permission names",
);

const auditBlock = route.slice(incompleteStart, responseStart);
assert.match(auditBlock, /metadata:\s*\{[\s\S]*requiredPermissions[\s\S]*missingPermissions/u);

console.log("admin command-center concealment contract: ok");
