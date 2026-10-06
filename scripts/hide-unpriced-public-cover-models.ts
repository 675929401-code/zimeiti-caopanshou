import { getSupabaseClient } from "@/storage/database/supabase-client";

const execute = process.argv.includes("--execute");

type CoverModelRow = {
  id: string;
  name: string | null;
  model_name: string | null;
  provider: string | null;
  cost_price: number | string | null;
  selling_price: number | string | null;
  is_active: boolean | null;
  is_hidden: boolean | null;
  updated_at?: string | null;
};

function isInvalidPublicCoverModel(row: CoverModelRow): boolean {
  return Boolean(row.is_active)
    && row.is_hidden !== true
    && (!Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) <= 0
      || !Number.isFinite(Number(row.cost_price)) || Number(row.cost_price) < 0);
}

async function main() {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("cover_models")
    .select("id, name, model_name, provider, cost_price, selling_price, is_active, is_hidden, updated_at")
    .eq("is_active", true)
    .eq("is_hidden", false)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const targets = ((data || []) as CoverModelRow[]).filter(isInvalidPublicCoverModel);
  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      action: "hide active visible cover models with invalid public prices",
      targets: targets.map((row) => ({
        id: row.id,
        name: row.name,
        modelName: row.model_name,
        provider: row.provider,
        costPrice: row.cost_price,
        sellingPrice: row.selling_price,
      })),
    }, null, 2));
    return;
  }

  for (const row of targets) {
    const { error: updateError } = await db
      .from("cover_models")
      .update({ is_hidden: true, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("is_active", true)
      .eq("is_hidden", false);
    if (updateError) throw updateError;
  }

  console.log(JSON.stringify({
    ok: true,
    mode: "execute",
    hidden: targets.map((row) => ({
      id: row.id,
      name: row.name,
      reason: "invalid public cover model price",
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
