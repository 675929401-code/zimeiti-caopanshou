import assert from "node:assert/strict";
import {wholeWalletCredits} from "../src/lib/wallet-credit-conversion";
import {readChatTokenUsage} from "../src/lib/reported-token-usage";
import {normalizeRechargeAmount, rechargeCreditsForAmount} from "../src/lib/recharge-amount";
import {withoutCatalogRates, catalogRatesForMember, BillingCatalogRequest} from "../src/lib/server/member-model-catalog";

async function main() {
  for (let fen = 1; fen < 10000; fen++) {
    assert.equal(wholeWalletCredits(fen/100,100,"ceil"),fen);
    assert.equal(rechargeCreditsForAmount(fen/100,100),fen);
    assert.equal(wholeWalletCredits(fen/100,50,"ceil"),Math.ceil(fen/2));
  }
  assert.equal(wholeWalletCredits(0.070001,100,"ceil"),8);
  assert.equal(wholeWalletCredits(1e-8,50,"ceil"),1);
  assert.equal(normalizeRechargeAmount(1e-12),null);
  assert.throws(()=>wholeWalletCredits(Infinity,50,"ceil"));
  assert.throws(()=>wholeWalletCredits(1,0,"floor"));
  const usage = {prompt_tokens:100,completion_tokens:20};
  assert.equal(readChatTokenUsage({...usage,prompt_cache_miss_tokens:70})?.cached_tokens,30);
  assert.equal(readChatTokenUsage({...usage,prompt_cache_hit_tokens:30,prompt_cache_miss_tokens:70})?.cached_tokens,30);
  assert.equal(readChatTokenUsage({...usage,prompt_tokens_details:{cached_tokens:10},prompt_cache_hit_tokens:30}),undefined);
  assert.equal(readChatTokenUsage({...usage,prompt_cache_hit_tokens:31,prompt_cache_miss_tokens:70}),undefined);
  assert.equal(readChatTokenUsage({...usage,cached_tokens:null}),undefined);
  const dto = {id:"m",displayName:"M",variantLabel:"",avatarUrl:"",publicPrice:9,capabilities:{priceReady:true,resolutionPrices:["1K:9"],resolutionOptions:["1K"]}};
  assert.deepEqual(withoutCatalogRates(dto),{id:"m",displayName:"M",variantLabel:"",avatarUrl:"",capabilities:{priceReady:true,resolutionOptions:["1K"]}});
  assert.equal(await catalogRatesForMember(new Request("https://local.invalid")),false);
  assert.equal(await catalogRatesForMember(new BillingCatalogRequest("https://local.invalid")),true);
  console.log("PASS decimal conversion, cache receipts and private catalog boundaries");
}
void main();
