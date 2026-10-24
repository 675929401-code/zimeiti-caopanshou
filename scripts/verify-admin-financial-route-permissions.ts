import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const cash = read("src/app/api/admin/cash/route.ts");
const credits = read("src/app/api/admin/credits/route.ts");
const balanceAudit = read("src/app/api/admin/balance-audit/route.ts");
const offline = read("src/app/api/admin/offline-payments/route.ts");
const paymentMethods = read("src/app/api/admin/payment-methods/route.ts");

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

assert.match(cash, /authorizeAdminCapability\(req, "wallet\.adjust"/u);
assert.match(cash, /requireStepUp:\s*true/u);
assert.match(cash, /auditAllowed:\s*true/u);

assert.match(credits, /authorizeAdminCapability\(request, 'wallet\.adjust'/u);
assert.match(credits, /authorizeAdminCapability\(request, 'billing\.view'/u);
assert.match(credits, /mode === 'set' \? 'admin_credit_set' : 'admin_credit_topup'/u);
assert.match(credits, /requireStepUp:\s*true/u);

assert.match(balanceAudit, /authorizeAdminCapability\(request, "billing\.view"/u);
assert.match(offline, /authorizeAdminCapability\(request, "billing\.view"/u);
assert.match(offline, /authorizeAdminCapability\(request, "wallet\.adjust"/u);
assert.equal(count(offline, "requireStepUp: true"), 2, "offline record and void must both require step-up");
assert.equal(count(offline, "auditAllowed: true"), 2, "offline record and void must both request governance audit");

assert.match(paymentMethods, /authorizeAdminCapability\(request, "payment\.settings\.manage"/u);
assert.match(paymentMethods, /operation: "payment_methods_view"/u);
assert.match(paymentMethods, /return noStore\(NextResponse\.json\(/u);
assert.doesNotMatch(paymentMethods.slice(0, paymentMethods.indexOf("export async function POST")), /verifyAdminToken/u);

console.log(JSON.stringify({
  verifier: "admin-financial-route-permissions",
  status: "PASS",
  reads: ["billing.view", "payment.settings.manage"],
  writes: ["wallet.adjust + step-up"],
  databaseWrites: 0,
  providerCalls: 0,
}, null, 2));
