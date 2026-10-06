import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manjuAdminCapability, type ManjuAdminOperation } from "../src/lib/admin-manju-capabilities";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const expected = {
  prompt: ["prompts.view", "prompts.edit"],
  skill: ["internal_tools.manage", "internal_tools.manage"],
  agent: ["agents.view", "agents.manage"],
  workflow: ["agents.view", "agents.manage"],
  model_policy: ["models.view", "models.manage"],
  ui: ["brand.settings.manage", "brand.settings.manage"],
  content: ["brand.settings.manage", "brand.settings.manage"],
  media: ["brand.settings.manage", "brand.settings.manage"],
  feature_flags: ["platform.settings.manage", "platform.settings.manage"],
} as const;

for (const [domain, [readPermission, writePermission]] of Object.entries(expected)) {
  assert.equal(manjuAdminCapability(domain as keyof typeof expected, "read").permission, readPermission);
  assert.equal(manjuAdminCapability(domain as keyof typeof expected, "validate").permission, writePermission);
  for (const operation of ["save-draft", "publish", "rollback"] satisfies ManjuAdminOperation[]) {
    const capability = manjuAdminCapability(domain as keyof typeof expected, operation);
    assert.equal(capability.permission, writePermission, `${domain}/${operation} write permission`);
    assert.equal(capability.requireStepUp, true, `${domain}/${operation} must require step-up`);
  }
}

assert.equal(manjuAdminCapability("prompt", "read").requireStepUp, true, "prompt source read must require step-up");
assert.equal(manjuAdminCapability("skill", "read").requireStepUp, true, "skill source read must require step-up");
assert.equal(manjuAdminCapability("agent", "read").requireStepUp, false);
assert.equal(manjuAdminCapability("model_policy", "validate").requireStepUp, false, "validation is non-mutating");

const governance = read("src/lib/admin-governance.ts");
assert.match(
  governance,
  /\^\\\/api\\\/admin\\\/(?:\(aiweb-import\|coze-import\)|\(coze-import\|aiweb-import\))[\s\S]{0,180}permission:\s*["']prompts\.edit["']/u,
  "central import boundary must keep prompts.edit",
);

for (const routeName of ["aiweb-import", "coze-import"] as const) {
  const source = read(`src/app/api/admin/${routeName}/route.ts`);
  assert.match(source, /authorizeAdminCapability\(request, ['"]agents\.manage['"]/u, `${routeName} must require agents.manage`);
  assert.match(source, /if \(!catData\) \{[\s\S]*authorizeAdminCapability\(request, ['"]internal_tools\.manage['"]/u, `${routeName} must guard category creation`);
  assert.doesNotMatch(source, /requiredPermission/u, `${routeName} must not expose raw permission keys`);
  assert.doesNotMatch(source, /verifyAdminToken/u, `${routeName} must not fall back to role-only authorization`);
}

const manjuRoute = read("src/app/api/admin/manju-config/route.ts");
assert.match(manjuRoute, /manjuAdminCapability\(domain, "read"\)/u);
assert.match(manjuRoute, /manjuAdminCapability\(action\.domain, action\.action\)/u);
assert.ok((manjuRoute.match(/authorizeAdminCapability\(/gu) || []).length >= 2, "Manju GET and POST need route-local capability checks");
assert.doesNotMatch(manjuRoute, /requiredPermission/u, "Manju denial must not expose raw permission keys");

console.log(JSON.stringify({
  ok: true,
  importRoutes: ["aiweb-import", "coze-import"],
  manjuDomains: Object.keys(expected),
  mutatingStepUp: ["save-draft", "publish", "rollback"],
}, null, 2));
