import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const unhealthyIds = (process.env.UNHEALTHY_IMAGE_MODEL_IDS || "gpt-image-2-chA-1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

type CoverModelRow = {
  id: string;
  name: string;
  model_name: string;
  provider: string | null;
  is_active: boolean | null;
  is_hidden: boolean | null;
  selling_price: number | null;
  cost_price: number | null;
};

function safeRow(row: CoverModelRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    model_name: row.model_name,
    provider: row.provider,
    is_active: row.is_active,
    is_hidden: row.is_hidden,
    selling_price: row.selling_price,
    cost_price: row.cost_price,
  };
}

async function main() {
  const db = getSupabaseClient();
  const generatedAt = new Date().toISOString();
  const evidenceDir = path.resolve(".codex-evidence", "image-model-quarantine-20260831");
  await mkdir(evidenceDir, { recursive: true });

  const changes = [];
  for (const id of unhealthyIds) {
    const { data: before, error: beforeError } = await db
      .from("cover_models")
      .select("id, name, model_name, provider, is_active, is_hidden, selling_price, cost_price")
      .eq("id", id)
      .maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) throw new Error(`unhealthy image model not found: ${id}`);

    const { data: after, error: updateError } = await db
      .from("cover_models")
      .update({
        is_hidden: true,
        updated_at: generatedAt,
      })
      .eq("id", id)
      .select("id, name, model_name, provider, is_active, is_hidden, selling_price, cost_price")
      .single();
    if (updateError) throw updateError;

    changes.push({ before: safeRow(before as CoverModelRow), after: safeRow(after as CoverModelRow) });
  }

  const reportPath = path.join(evidenceDir, `${generatedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, JSON.stringify({ ok: true, changes }, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    quarantined: changes.length,
    reportPath,
    changes: changes.map((item) => ({
      id: item.after?.id,
      name: item.after?.name,
      isHidden: item.after?.is_hidden,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
