import assert from "node:assert/strict";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const modelIds = [
  "pending-cover-model-gpt-image-2-image-2-1k",
  "pending-cover-model-gpt-image-2-official",
  "pending-cover-model-gpt-image-2-adobe-mid",
];

async function readContext(modelId, retestReason = "") {
  const query = new URLSearchParams({ modelId });
  if (retestReason) query.set("retestReason", retestReason);
  const response = await fetch(`${origin}/api/admin/cover-models/validation?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  return {
    httpStatus: response.status,
    success: body.success === true,
    code: String(body.code || ""),
    modelId,
    active: body.active === true,
    hidden: body.hidden === true,
    credentialReady: body.credentialReady === true,
    priceReady: body.priceReady === true,
    acceptance: String(body.acceptance || ""),
    epoch: Number.isSafeInteger(body.epoch) ? body.epoch : null,
    validationKeyReady: /^iav_[a-f0-9]{64}$/u.test(String(body.validationKey || "")),
    busy: body.busy === true,
    canRequestRetest: body.canRequestRetest === true,
    existingAttempt: body.existingAttempt ? {
      state: String(body.existingAttempt.state || ""),
      requestState: String(body.existingAttempt.requestState || ""),
      deliveryState: String(body.existingAttempt.deliveryState || ""),
      hasProviderCheckpoint: body.existingAttempt.hasProviderCheckpoint === true,
      assetReady: Boolean(body.existingAttempt.assetId),
    } : null,
  };
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_PORT_5000_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  const contexts = [];
  for (const modelId of modelIds) {
    const current = await readContext(modelId);
    const retest = current.canRequestRetest
      ? await readContext(modelId, "修复响应协议后只读获取复测证明")
      : null;
    contexts.push({ current, retest });
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    origin,
    contexts,
    providerRequests: 0,
    paidGenerationRequests: 0,
    databaseWrites: 0,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) {
  await main();
}
