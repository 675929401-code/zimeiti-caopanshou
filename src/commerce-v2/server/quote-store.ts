import "server-only";

import { randomUUID } from "node:crypto";

import { get, put } from "../../commerce/server/store";
import type { ProductionPlan, ProductionQuote } from "../domain/contracts";
import { createProductionQuote } from "../domain/quote-contract";

type StoredProductionQuote = ProductionQuote & {
  owner: string;
  plan: ProductionPlan;
  createdAt: number;
  status: "quoted" | "expired" | "consumed";
};

function publicQuote(value: StoredProductionQuote) {
  const { owner: _owner, plan: _plan, ...quote } = value;
  void _owner;
  void _plan;
  return quote;
}

export function storeCommerceV2Quote(owner: string, plan: ProductionPlan, planHash: string, now = Date.now()) {
  const quote = createProductionQuote({ quoteId: randomUUID(), plan, planHash, now });
  const stored: StoredProductionQuote = { ...quote, owner, plan: structuredClone(plan), createdAt: now, status: "quoted" };
  put("commerce-v2-quotes", stored.quoteId, owner, stored);
  return publicQuote(stored);
}

export function readCommerceV2Quote(owner: string, quoteId: string, now = Date.now()) {
  const stored = get<StoredProductionQuote>("commerce-v2-quotes", quoteId, owner);
  if (!stored) return null;
  if (stored.status === "quoted" && stored.expiresAt <= now) {
    const expired = { ...stored, status: "expired" as const, confirmable: false };
    put("commerce-v2-quotes", quoteId, owner, expired);
    return publicQuote(expired);
  }
  return publicQuote(stored);
}
