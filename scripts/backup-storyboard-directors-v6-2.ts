import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const TARGETS = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", role: "high_energy" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", role: "cinematic" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", role: "lyrical" },
] as const;

const SAFE_COLUMNS = [
  "id",
  "name",
  "description",
  "category",
  "source",
  "model",
  "model_id",
  "is_active",
  "user_access",
  "sort_order",
  "system_prompt",
  "preset_fields",
  "output_style",
  "response_format",
  "max_context_rounds",
  "max_context_tokens",
  "max_reply_tokens",
  "temperature",
  "timeout",
  "enable_web_search",
  "guide_message",
  "config_revision",
  "updated_at",
  "deleted_at",
] as const;

type SafeColumn = typeof SAFE_COLUMNS[number];
type SafeAgentRow = Record<SafeColumn, unknown> & { id: string; name: string; system_prompt: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function restoreSql(rows: SafeAgentRow[], backupId: string): string {
  const updates = rows.map((row) => `UPDATE public.agents
SET
  name = ${sqlLiteral(row.name)},
  description = ${sqlLiteral(row.description)},
  category = ${sqlLiteral(row.category)},
  source = ${sqlLiteral(row.source)},
  model = ${sqlLiteral(row.model)},
  model_id = ${sqlLiteral(row.model_id)},
  is_active = ${sqlLiteral(row.is_active)},
  user_access = ${sqlLiteral(row.user_access)},
  sort_order = ${sqlLiteral(row.sort_order)},
  system_prompt = ${sqlLiteral(row.system_prompt)},
  preset_fields = ${sqlJson(row.preset_fields)},
  output_style = ${sqlJson(row.output_style)},
  response_format = ${sqlLiteral(row.response_format)},
  max_context_rounds = ${sqlLiteral(row.max_context_rounds)},
  max_context_tokens = ${sqlLiteral(row.max_context_tokens)},
  max_reply_tokens = ${sqlLiteral(row.max_reply_tokens)},
  temperature = ${sqlLiteral(row.temperature)},
  timeout = ${sqlLiteral(row.timeout)},
  enable_web_search = ${sqlLiteral(row.enable_web_search)},
  guide_message = ${sqlLiteral(row.guide_message)},
  updated_at = ${sqlLiteral(row.updated_at)}::timestamptz
WHERE id = ${sqlLiteral(row.id)}
  AND name = ${sqlLiteral(row.name)}
  AND deleted_at IS NULL
  AND config_revision = ${sqlLiteral(row.config_revision)}::bigint;

IF NOT FOUND THEN
  RAISE EXCEPTION 'restore target missing, name mismatch, or revision conflict: ${row.id}' USING ERRCODE = '40001';
END IF;`).join("\n\n");

  return `-- Generated from local backup ${backupId}. Contains only allowlisted agent configuration.
-- Execute only through a PostgreSQL transaction-capable connection.
BEGIN;

DO $restore$
DECLARE
  target_count integer;
BEGIN
  SELECT count(*) INTO target_count
  FROM public.agents
  WHERE id = ANY (ARRAY[${rows.map((row) => sqlLiteral(row.id)).join(", ")}])
    AND deleted_at IS NULL;

  IF target_count <> ${rows.length} THEN
    RAISE EXCEPTION 'expected ${rows.length} restore targets, found %', target_count;
  END IF;

${updates.split("\n").map((line) => `  ${line}`).join("\n")}
END
$restore$;

COMMIT;
`;
}

async function verifyBackup(directory: string) {
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Array<{ file: string; sha256: string }>;
    agents: Array<{ id: string; file: string; prompt_sha256: string }>;
  };
  if (manifest.agents.length !== TARGETS.length) throw new Error("manifest agent count mismatch");
  for (const entry of manifest.files) {
    const content = await readFile(path.join(directory, entry.file));
    if (sha256(content) !== entry.sha256) throw new Error(`SHA256 mismatch: ${entry.file}`);
  }
  for (const entry of manifest.agents) {
    const row = JSON.parse(await readFile(path.join(directory, entry.file), "utf8")) as SafeAgentRow;
    if (sha256(String(row.system_prompt ?? "")) !== entry.prompt_sha256) {
      throw new Error(`prompt SHA256 mismatch: ${entry.id}`);
    }
  }
  return manifest;
}

async function main() {
  const url = required("COZE_SUPABASE_URL");
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || required("COZE_SUPABASE_ANON_KEY");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client
    .from("agents")
    .select(SAFE_COLUMNS.join(","))
    .in("id", TARGETS.map((target) => target.id));
  if (error) throw error;
  const rows = (data ?? []) as unknown as SafeAgentRow[];

  if (rows.length !== TARGETS.length || new Set(rows.map((row) => row.id)).size !== TARGETS.length) {
    throw new Error(`expected ${TARGETS.length} unique agents, found ${rows.length}`);
  }
  for (const target of TARGETS) {
    const row = rows.find((item) => item.id === target.id);
    if (!row || row.name !== target.name || row.deleted_at !== null || !row.system_prompt) {
      throw new Error(`precondition mismatch: ${target.id}`);
    }
  }

  const ordered = TARGETS.map((target) => rows.find((row) => row.id === target.id) as SafeAgentRow);
  const backupId = `storyboard-directors-v6.2-preflight-${isoStamp()}`;
  const directory = path.resolve("backups", backupId);
  const agentDirectory = path.join(directory, "agents");
  await mkdir(agentDirectory, { recursive: true });

  const fileEntries: Array<{ file: string; sha256: string }> = [];
  const agentEntries = [];
  for (const [index, row] of ordered.entries()) {
    const target = TARGETS[index];
    const relativeFile = `agents/${row.id}.json`;
    const content = `${JSON.stringify(row, null, 2)}\n`;
    await writeFile(path.join(directory, relativeFile), content, "utf8");
    fileEntries.push({ file: relativeFile, sha256: sha256(content) });
    agentEntries.push({
      id: row.id,
      name: row.name,
      role: target.role,
      file: relativeFile,
      prompt_chars: row.system_prompt.length,
      prompt_sha256: sha256(row.system_prompt),
      preset_field_count: Array.isArray(row.preset_fields) ? row.preset_fields.length : 0,
      updated_at: row.updated_at,
    });
  }

  const restore = restoreSql(ordered, backupId);
  await writeFile(path.join(directory, "restore.sql"), restore, "utf8");
  fileEntries.push({ file: "restore.sql", sha256: sha256(restore) });

  const recovery = `# 恢复说明\n\n本目录是三张故事版导演在 v6.2 / 8-10-15 秒适配前的本地只读快照。\n\n- 仅包含白名单智能体配置，不包含密钥、渠道凭据、用户、支付或计费数据。\n- 使用有事务能力的 PostgreSQL 连接执行 restore.sql。\n- SQL 只按固定 agent_id 和名称恢复三张卡，任一目标不匹配会整笔回滚。\n- 执行前再次核对 manifest.json 与所有 SHA256。\n\n\`\`\`powershell\npsql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f \"${path.join(directory, "restore.sql").replace(/\\/g, "\\\\")}\"\n\`\`\`\n`;
  await writeFile(path.join(directory, "恢复说明.md"), recovery, "utf8");
  fileEntries.push({ file: "恢复说明.md", sha256: sha256(recovery) });

  const manifest = {
    schema_version: "storyboard_director_local_backup.v1",
    backup_id: backupId,
    purpose: "v6.2 前置备份/8-10-15秒适配前",
    created_at: new Date().toISOString(),
    source: "Supabase agents read-only allowlist query",
    contains_secrets: false,
    contains_user_data: false,
    safe_columns: SAFE_COLUMNS,
    agents: agentEntries,
    files: fileEntries,
  };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const verified = await verifyBackup(directory);
  console.log(JSON.stringify({ directory, verified_agents: verified.agents.length, manifest_sha256: sha256(await readFile(path.join(directory, "manifest.json"))) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
