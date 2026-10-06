import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { findModelByPublicId } from "@/lib/public-model-dto";

const unhealthyPublicIds = (process.env.UNHEALTHY_CHAT_PUBLIC_IDS || "pm_TNtojGKPTpXGOWN8zHWFzyf8")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

type LlmModelRow = {
  id: string;
  name: string;
  model_name: string;
  is_active: boolean | null;
  is_hidden: boolean | null;
  user_access: string | null;
  admin_notes: string | null;
};

function safeRow(row: LlmModelRow | null | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    model_name: row.model_name,
    is_active: row.is_active,
    is_hidden: row.is_hidden,
    user_access: row.user_access,
    admin_notes: row.admin_notes,
  };
}

async function main() {
  throw new Error("AUTO_QUARANTINE_DISABLED_USE_ADMIN_DELETE_FOR_EXPLICIT_RETIREMENT");
  const db = getSupabaseClient();
  const { data, error } = await db
    .from("llm_models")
    .select("id, name, model_name, is_active, is_hidden, user_access, admin_notes")
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const rows = (data || []) as LlmModelRow[];
  const matched = unhealthyPublicIds.map((publicId) => {
    const row = findModelByPublicId("chat", rows as unknown as Record<string, unknown>[], publicId)
      || findModelByPublicId("llm", rows as unknown as Record<string, unknown>[], publicId);
    return { publicId, row: row as unknown as LlmModelRow | null };
  });

  const missing = matched.filter((item) => !item.row);
  if (missing.length > 0) {
    throw new Error(`unhealthy public model id not found: ${missing.map((item) => item.publicId).join(", ")}`);
  }

  const generatedAt = new Date().toISOString();
  const evidenceDir = path.resolve(".codex-evidence", "chat-model-quarantine-20260831");
  await mkdir(evidenceDir, { recursive: true });

  const changes = [];
  for (const item of matched) {
    const row = item.row!;
    const before = safeRow(row);
    const reason = `前台隔离：${generatedAt} 端到端 canary 返回上游额度/账号不可用；保留后台记录，渠道恢复后重新验收再发布。`;
    const previousNotes = String(row.admin_notes || "").trim();
    const nextNotes = previousNotes.includes(reason) ? previousNotes : [previousNotes, reason].filter(Boolean).join("\n");

    const { data: updated, error: updateError } = await db
      .from("llm_models")
      .update({
        is_hidden: true,
        user_access: "hidden",
        admin_notes: nextNotes,
        updated_at: generatedAt,
      })
      .eq("id", row.id)
      .select("id, name, model_name, is_active, is_hidden, user_access, admin_notes")
      .single();
    if (updateError) throw updateError;

    changes.push({
      publicId: item.publicId,
      before,
      after: safeRow(updated as LlmModelRow),
    });
  }

  const reportPath = path.join(evidenceDir, `${generatedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, JSON.stringify({ ok: true, changes }, null, 2), "utf8");

  console.log(JSON.stringify({
    ok: true,
    quarantined: changes.length,
    reportPath,
    changes: changes.map((item) => ({
      publicId: item.publicId,
      name: item.after?.name,
      isHidden: item.after?.is_hidden,
      userAccess: item.after?.user_access,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
