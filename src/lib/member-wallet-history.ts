import type { getSupabaseClient } from "@/storage/database/supabase-client";

export function classifyWalletEntry(type: string): "topup" | "spend" | "refund" | "adjustment" {
  if (type === "refund") return "refund";
  if (type === "recharge" || type === "topup") return "topup";
  if (["consume", "consumption", "deduction"].includes(type)) return "spend";
  return "adjustment";
}

export function summarizeWalletEntries(rows: Array<{type: string; amount: number | string}>) {
  let recharged = 0, consumed = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) throw new Error("INVALID_WALLET_AMOUNT");
    const kind = classifyWalletEntry(row.type);
    if (kind === "topup" && amount > 0) recharged += amount;
    if (kind === "spend") consumed += Math.abs(amount);
  }
  return { recharged, consumed };
}

export async function readWalletTotals(client: ReturnType<typeof getSupabaseClient>, userId: string, table: "credit_transactions" | "cash_transactions") {
  let recharged = 0, consumed = 0;
  // Page past PostgREST's default row cap using its stable primary key.
  let lastId: string | number | undefined;
  for (;;) {
    let q = client.from(table).select("id,amount,type").eq("user_id",userId).order("id").limit(500);
    if (lastId !== undefined) q = q.gt("id",lastId);
    const {data,error} = await q;
    if (error || !Array.isArray(data)) throw new Error("WALLET_TOTALS_UNAVAILABLE");
    const part = summarizeWalletEntries(data);
    recharged += part.recharged;
    consumed += part.consumed;
    if (data.length < 500) break;
    lastId = data[data.length-1].id;
  }
  return {recharged: Math.round(recharged*100)/100, consumed: Math.round(consumed*100)/100};
}
