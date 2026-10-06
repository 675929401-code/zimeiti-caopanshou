import assert from "node:assert/strict";
import fs from "node:fs";

import {
  VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED,
  videoBillingAdapterAdmission,
} from "../src/lib/video-model-availability";

const ordinary = videoBillingAdapterAdmission({ billing_unit: "per_use" });
assert.equal(ordinary.ready, true);
assert.equal(ordinary.code, "");

for (const config of [
  { provider_billing_unit: "token", billing_unit: "per_use", public_billing_pending: true },
  { provider_billing_unit: "TOKEN", billing_unit: "output_second" },
  { provider_billing_unit: "token", token_billing_adapter_ready: true, public_billing_pending: true },
]) {
  const admission = videoBillingAdapterAdmission(config);
  assert.equal(admission.ready, false);
  assert.equal(admission.code, VIDEO_TOKEN_BILLING_ADAPTER_REQUIRED);
  assert.match(admission.message, /Token.*精确结算/u);
}

const explicitlyReady = videoBillingAdapterAdmission({
  provider_billing_unit: "token",
  token_billing_adapter_ready: true,
  public_billing_pending: false,
});
assert.equal(explicitlyReady.ready, true);

const route = fs.readFileSync("src/app/api/video/generate/route.ts", "utf8");
const admissionIndex = route.indexOf("videoBillingAdapterAdmission(selectedProtocolConfig)");
const reservationIndex = route.indexOf("reserveVideoGenerationTask({");
const providerSubmitIndex = route.indexOf("submitVideoTask(channelConfig");
assert.ok(admissionIndex > 0, "VIDEO_BILLING_ADMISSION_MISSING");
assert.ok(reservationIndex > admissionIndex, "VIDEO_BILLING_ADMISSION_MUST_PRECEDE_RESERVATION");
assert.ok(providerSubmitIndex > admissionIndex, "VIDEO_BILLING_ADMISSION_MUST_PRECEDE_PROVIDER_SUBMIT");

console.log(JSON.stringify({
  passed: true,
  checks: 10,
  providerRequests: 0,
  databaseWrites: 0,
}));
