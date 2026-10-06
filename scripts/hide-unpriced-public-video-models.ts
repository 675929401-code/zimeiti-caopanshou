import { getSupabaseClient } from "@/storage/database/supabase-client";

const execute = process.argv.includes("--execute");

type VideoModelRow = {
  id: string;
  name: string | null;
  model_name: string | null;
  provider: string | null;
  cost_price: number | string | null;
  price_per_use: number | string | null;
  is_active: boolean | null;
  is_hidden: boolean | null;
};

function isInvalidPublicVideoModel(row: VideoModelRow): boolean {
  return Boolean(row.is_active)
    && row.is_hidden !== true
    && (!Number.isFinite(Number(row.price_per_use)) || Number(row.price_per_use) <= 0
      || !Number.isFinite(Number(row.cost_price)) || Number(row.cost_price) < 0);
}

async function main() {
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("video_models")
    .select("id, name, model_name, provider, cost_price, price_per_use, is_active, is_hidden")
    .eq("is_active", true)
    .eq("is_hidden", false)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const targets = ((data || []) as VideoModelRow[]).filter(isInvalidPublicVideoModel);
  if (!execute) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      action: "hide active visible video models with invalid public prices",
      targets: targets.map((row) => ({
        id: row.id,
        name: row.name,
        modelName: row.model_name,
        provider: row.provider,
        costPrice: row.cost_price,
        pricePerUse: row.price_per_use,
      })),
    }, null, 2));
    return;
  }

  for (const row of targets) {
    const { error: updateError } = await db
      .from("video_models")
      .update({ is_hidden: true })
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
      reason: "invalid public video model price",
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
