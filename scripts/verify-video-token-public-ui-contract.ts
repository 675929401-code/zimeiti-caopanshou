import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getVideoBillingUnit,
  parseVideoTokenMaxCharge,
  readVideoTokenPublicPricing,
  resolveVideoCharge,
  resolveVideoTokenBillingConsent,
  videoTokenBudgetTotal,
  videoTokenRateLabel,
} from "../src/lib/video-model-capabilities";
import { getVideoTokenPublicPricing } from "../src/lib/video-token-billing";
import { videoBillingAdapterAdmission } from "../src/lib/video-model-availability";
import { containsForbiddenPublicModelKey, publicMediaBillingCapabilities, toPublicModelDto } from "../src/lib/public-model-dto";

const rates = { "720p:no_reference_video": 12, "720p:reference_video": 8 };
const config = {
  provider_billing_unit: "token", billing_unit: "token",
  token_billing_adapter_ready: true, token_billing_adapter_version: "video_token_quote.v1",
  token_sale_prices_per_million: rates,
  token_cost_prices_per_million: { "720p:no_reference_video": 10, "720p:reference_video": 6 },
};
const pricing = getVideoTokenPublicPricing({ api_protocol_config: config });
assert.ok(pricing);
const dto = toPublicModelDto("video", { id: "fixture-video-token", name: "视频模型", price_per_use: 0, provider: "private", api_protocol_config: config }, 0, {
  ...publicMediaBillingCapabilities("token"), priceReady: true, generationReady: false,
}, { ...pricing, providerCosts: config.token_cost_prices_per_million } as typeof pricing);
assert.equal(containsForbiddenPublicModelKey(dto), false);
assert.deepEqual(Object.keys(dto.tokenPricing!).sort(), ["priceVersion", "salePricesPerMillion"]);
assert.deepEqual(dto.tokenPricing, pricing);
assert.equal(dto.capabilities.priceReady, true, "A known sales rate remains visible before adapter activation");
assert.equal(dto.capabilities.generationReady, false);
assert.equal(getVideoBillingUnit(dto), "token");
assert.ok(Number.isNaN(resolveVideoCharge(dto, "720p", 10).publicPrice), "Token cannot use an old per-use price");
assert.match(videoTokenRateLabel(dto), /¥12\/百万Token/u);
assert.match(videoTokenRateLabel(dto, "720p", true), /¥8\/百万Token/u);
assert.equal(readVideoTokenPublicPricing({ salePricesPerMillion: { ...rates, "720p:reference_video": -1 }, priceVersion: "bad" }), undefined);

for (const invalid of ["", " ", "0", "0.00", "-1", "+1", ".5", "1.", "1.001", "1e2", "Infinity", "NaN", "9007199254740991"])
  assert.equal(parseVideoTokenMaxCharge(invalid), undefined, `Reject amount ${JSON.stringify(invalid)}`);
for (const valid of ["0.01", "1", "1.20", "20.99"])
  assert.equal(parseVideoTokenMaxCharge(valid), Number(valid));
assert.equal(videoTokenBudgetTotal(0.1, 3), 0.3, "Budget uses integer cents");
assert.equal(videoTokenBudgetTotal(1.23, 20), 24.6);
assert.ok(Number.isNaN(videoTokenBudgetTotal(0.001, 2)));
assert.ok(Number.isNaN(videoTokenBudgetTotal(1, 0)));
assert.ok(Number.isNaN(videoTokenBudgetTotal(1, 1.5)));
assert.ok(Number.isNaN(videoTokenBudgetTotal(90071992547409, 20)));
const consent = { modelId: dto.id, priceVersion: pricing.priceVersion, amount: "2.35" };
assert.deepEqual(resolveVideoTokenBillingConsent(dto, consent), { maxChargeYuan: 2.35, priceVersion: pricing.priceVersion });
assert.equal(resolveVideoTokenBillingConsent(dto, null), undefined);
assert.equal(resolveVideoTokenBillingConsent(dto, { ...consent, amount: "" }), undefined);
assert.equal(resolveVideoTokenBillingConsent(dto, { ...consent, priceVersion: "old" }), undefined);
assert.equal(resolveVideoTokenBillingConsent(dto, { ...consent, modelId: "another-model" }), undefined);
assert.equal(resolveVideoTokenBillingConsent({ ...dto, billingUnit: "per_use" }, consent), undefined);
assert.equal(resolveVideoCharge({ pricePerUse: 2, billingUnit: "per_use" }, "720p", 3).publicPrice, 2);
assert.equal(resolveVideoCharge({ pricePerUse: 2, billingUnit: "output_second" }, "720p", 3).publicPrice, 6);
assert.equal(videoBillingAdapterAdmission(config).ready, true);
for (const patch of [
  { billing_unit: "per_use" }, { token_billing_adapter_ready: false }, { public_billing_pending: true },
  { token_billing_adapter_version: "old" }, { token_cost_prices_per_million: {} }, { token_sale_prices_per_million: {} },
]) assert.equal(videoBillingAdapterAdmission({ ...config, ...patch }).ready, false);
assert.equal(videoBillingAdapterAdmission({ billing_unit: "per_use" }).ready, true);
assert.equal(videoBillingAdapterAdmission({ billing_unit: "output_second" }).ready, true);

// Binding checks supplement the runtime helper tests; visual/UI behavior is verified separately.
for (const file of ["src/app/video/page.tsx", "src/components/storyboard-workbench.tsx"]) {
  const source = readFileSync(file, "utf8");
  assert.match(source, /resolveVideoTokenBillingConsent\(/u);
  assert.match(source, /\.\.\.\(tokenBilling \? \{ tokenBilling \} : \{\}\)/u);
  assert.match(source, /预留不是扣费/u);
  assert.match(source, /超额待确认/u);
}
const storyboard = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
assert.match(storyboard, /videoTokenBudgetTotal\(authorization\.tokenBilling\.maxChargeYuan, cardIds\.length\)/u);
assert.match(storyboard, /tokenBilling\?\.priceVersion !== batchAuthorization\.tokenBilling\.priceVersion/u);
assert.match(storyboard, /videoBatchPreflightRef\.current = true/u);
console.log(JSON.stringify({ passed: true, checks: "token pricing privacy, non-flat quotes, explicit caps, stale versions, integer batch budget, admission and UI submission bindings", providerRequests: 0, databaseWrites: 0 }));
