import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  normalizeAllowedAgentCategoryIds,
  resolveAllowedAgentNavigationKeys,
} from "../src/lib/agent-category-access";

const apply = process.argv.includes("--apply");
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse(readFileSync(runtimePath, "utf8").replace(/^\uFEFF/u, "")) as {
  supabaseUrl?: string;
  serviceRoleKey?: string;
};
const databaseUrl = String(runtime.supabaseUrl || "");
const serviceKey = String(runtime.serviceRoleKey || "");
if (!databaseUrl || !serviceKey) throw new Error("本地数据库配置缺失");

const databaseHost = new URL(databaseUrl).hostname.toLowerCase();
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(databaseHost)) {
  throw new Error("本脚本只允许修复本地数据库；远端迁移必须走发布批次与独立审计");
}

const db = createClient(databaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function main() {
  const [usersResult, categoriesResult, agentsResult] = await Promise.all([
    db.from("users").select("id, role, allowed_categories").neq("role", "admin"),
    db.from("categories").select("id, name"),
    db.from("agents").select("id, name, category").is("deleted_at", null),
  ]);
  if (usersResult.error) throw usersResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  if (agentsResult.error) throw agentsResult.error;

  const categories = categoriesResult.data || [];
  const agents = agentsResult.data || [];
  const changes = (usersResult.data || []).map((user) => {
    const before = normalizeAllowedAgentCategoryIds(user.allowed_categories);
    const after = resolveAllowedAgentNavigationKeys(before, categories, agents);
    return {
      userId: user.id,
      accountRef: fingerprint(user.id),
      before,
      after,
      changed: JSON.stringify(before) !== JSON.stringify(after),
    };
  }).filter((change) => change.changed);

  const summary = {
    mode: apply ? "apply" : "dry-run",
    ordinaryUsers: usersResult.data?.length || 0,
    changedUsers: changes.length,
    staleOrLegacyGrantCount: changes.reduce((sum, change) => sum + change.before.length, 0),
    stableNavigationGrantCount: changes.reduce((sum, change) => sum + change.after.length, 0),
    accounts: changes.map(({ accountRef, before, after }) => ({
      accountRef,
      beforeCount: before.length,
      after,
    })),
  };

  if (!apply || changes.length === 0) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backupDirectory = join(process.cwd(), ".codex-backups", `agent-navigation-grants-${Date.now()}`);
  mkdirSync(backupDirectory, { recursive: true });
  writeFileSync(
    join(backupDirectory, "local-user-grants-before.json"),
    JSON.stringify({ createdAt: new Date().toISOString(), databaseHost, changes }, null, 2),
    "utf8",
  );

  for (const change of changes) {
    const { error } = await db
      .from("users")
      .update({ allowed_categories: change.after })
      .eq("id", change.userId);
    if (error) throw new Error(`权限迁移失败 ${change.accountRef}: ${error.message}`);
  }

  console.log(JSON.stringify({ ...summary, backupDirectory }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
