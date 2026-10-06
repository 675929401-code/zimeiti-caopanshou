import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  configuredExtractionMoney,
  ExtractionPricingConfigError,
  requireConfiguredExtractionMoney,
} from "../src/lib/extract-pricing";

const root = process.cwd();
const read = (path: string) => readFile(resolve(root, path), "utf8");

async function main() {
  for (const value of [0, "0", "0.00", " 0 "]) {
    assert.equal(configuredExtractionMoney(value), 0, "an explicit zero must remain a configured free channel");
  }
  for (const value of [undefined, null, "", " ", "invalid", -1, "-1", Number.NaN, Number.POSITIVE_INFINITY, false, {}, []]) {
    assert.equal(configuredExtractionMoney(value), null, "missing or invalid money must close the channel");
  }
  assert.equal(requireConfiguredExtractionMoney("0.02", "fixture sale price"), 0.02);
  assert.throws(
    () => requireConfiguredExtractionMoney(undefined, "fixture cost"),
    (error: unknown) => error instanceof ExtractionPricingConfigError
      && error.code === "EXTRACTION_PRICING_NOT_CONFIGURED",
  );

  const [catalog, coze, single, batch, search] = await Promise.all([
    read("src/app/api/tools/runtime-catalog/route.ts"),
    read("src/lib/coze-extraction-handler.ts"),
    read("src/app/api/extract/route.ts"),
    read("src/app/api/extract/batch/route.ts"),
    read("src/app/api/extract/search/route.ts"),
  ]);

  assert.match(catalog, /select\("role,name,config,price_per_use,cost_price"\)/);
  assert.match(catalog, /pricingReady = unitPrice !== null && costPrice !== null/);
  assert.match(catalog, /available: pricingReady && hasEndpoint && hasCredential/);
  assert.doesNotMatch(catalog, /quote\([^\n]+0\.0[12]/, "catalog must not manufacture a default sale price");

  assert.match(coze, /requireConfiguredExtractionMoney\(pluginData\.price_per_use/);
  assert.match(coze, /requireConfiguredExtractionMoney\(pluginData\.cost_price/);
  assert.match(coze, /error_code: error\.code/);
  assert.match(coze, /provider_call_started: false/);
  assert.doesNotMatch(coze, /normalizePluginPrice/);
  assert.ok(
    coze.indexOf("requireConfiguredExtractionMoney(pluginData.cost_price") < coze.indexOf("await callCozeWorkflow("),
    "Coze sale/cost validation must precede workflow dispatch",
  );

  assert.doesNotMatch(single, /function getExtractConfig/);
  assert.doesNotMatch(single, /function getVideoExtractConfig/);
  assert.doesNotMatch(single, /const EXTRACT_(?:PRICE|COST)\s*=/);
  assert.doesNotMatch(single, /normalizePluginPrice/);
  assert.match(single, /const \{ data, error \} = await supabase[\s\S]*?\.select\("role"\)[\s\S]*?if \(error\) \{[\s\S]*?throw new ExtractionPricingConfigError/);
  assert.doesNotMatch(single, /async function getActiveTextExtractPluginRole[\s\S]*?catch \{\s*return null;/);
  assert.match(single, /configuredExtractionMoney\(process\.env\.EXTRACT_FALLBACK_PRICE\)/);
  assert.match(single, /configuredExtractionMoney\(process\.env\.EXTRACT_FALLBACK_COST\)/);
  assert.match(single, /EXTRACTION_FALLBACK_PRICING_NOT_CONFIGURED/);
  assert.match(single, /costPrice: extractionTotalPrice\(textThirdPartyConfig!\.costPrice, successCount\)/);
  assert.match(single, /costPrice: extractionTotalPrice\(textThirdPartySource\.costPrice, ppt6SuccessCount\)/);
  assert.match(single, /costPrice: extractionTotalPrice\(fallbackPricing\.costPrice, fallbackSuccessCount\)/);

  const fallbackBlock = single.slice(single.indexOf("方案二（主方案）：douyin.wtf + ASR/LLM"));
  assert.ok(fallbackBlock.indexOf("resolveExtractionFallbackPricing()") >= 0);
  assert.ok(
    fallbackBlock.indexOf("resolveExtractionFallbackPricing()") < fallbackBlock.indexOf("fetchDouyinVideoMultiSource(videoId)"),
    "fallback pricing must be resolved before douyin.wtf/multi-source dispatch",
  );

  for (const [name, source] of Object.entries({ batch, search })) {
    assert.match(source, /cost_price/, `${name} must read configured provider cost`);
    assert.doesNotMatch(source, /costPrice:\s*0\b/, `${name} must not record unknown provider cost as zero`);
    assert.match(source, /provider_call_started: false/, `${name} must expose a safe pre-dispatch failure`);
  }
  const batchHandler = batch.slice(batch.indexOf("async function handlePost"));
  assert.ok(
    batch.indexOf("requireConfiguredExtractionMoney(videoPlugin.cost_price") < batchHandler.indexOf("resolveCreatorShortUrl(") + batch.indexOf("async function handlePost"),
    "all batch channel prices must be validated before provider/short-link dispatch",
  );
  assert.ok(
    search.indexOf("configuredExtractionMoney(data.cost_price)") < search.indexOf("await getDouyinVideoSearch("),
    "search sale/cost validation must precede Cyanlis dispatch",
  );
  for (const queryError of ["batchPluginError", "textPluginError", "videoPluginError"]) {
    assert.match(batch, new RegExp(`if \\(${queryError}\\) \\{[\\s\\S]*?throw new ExtractionPricingConfigError`), `${queryError} must stop fallback to a lower-priority channel`);
  }

  console.log("extraction pricing fail-closed zero-cost contract: PASS (static sources + pure parser; network/provider/wallet/database calls: 0)");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
