import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const TARGETS = [
  { id: "agent-1781690935600-gkt1xg", role: "agent_engineer", names: ["智能体工程开师 5.0", "智能体工程师 5.0", "智能体工程师 5.1", "智能体工程开发者 5.0"] },
  { id: "agent-1786633444187-594spj", role: "high_energy", names: ["故事版导演｜高能夸张"] },
  { id: "agent-1786642714227-e1zid1", role: "cinematic", names: ["故事版导演｜电影叙事"] },
  { id: "agent-1786642714448-m6iaou", role: "lyrical", names: ["故事版导演｜抒情情感"] },
] as const;

interface AgentRow {
  id: string;
  name: string;
  system_prompt: string | null;
  preset_fields: unknown;
  output_style: unknown;
  response_format: string | null;
  max_context_rounds: number | null;
  max_context_tokens: number | null;
  max_reply_tokens: number | null;
  guide_message: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

interface PromptVersionRow {
  id: string;
  agent_id: string;
  prompt: string;
  created_at: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function presetSummary(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const field = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: field.id ?? null,
      type: field.type ?? null,
      required: field.required ?? null,
      options: Array.isArray(field.options) ? field.options.length : 0,
    };
  });
}

async function main() {
  const url = required("COZE_SUPABASE_URL");
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || required("COZE_SUPABASE_ANON_KEY");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = TARGETS.map((target) => target.id);

  const { data: agentData, error: agentError } = await client
    .from("agents")
    .select("id,name,system_prompt,preset_fields,output_style,response_format,max_context_rounds,max_context_tokens,max_reply_tokens,guide_message,updated_at,deleted_at")
    .in("id", ids);
  if (agentError) throw agentError;
  const agents = (agentData ?? []) as unknown as AgentRow[];

  const { data: versionData, error: versionError } = await client
    .from("prompt_versions")
    .select("id,agent_id,prompt,created_at")
    .in("agent_id", ids)
    .order("created_at", { ascending: false });
  if (versionError) throw versionError;
  const versions = (versionData ?? []) as unknown as PromptVersionRow[];

  const { data: backupData, error: backupError } = await client
    .from("agent_config_migration_backups")
    .select("migration_key,agent_id,created_at")
    .in("agent_id", ids);

  const openApiResponse = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const openApi = openApiResponse.ok
    ? await openApiResponse.json() as Record<string, unknown>
    : {};
  const paths = openApi.paths && typeof openApi.paths === "object"
    ? Object.keys(openApi.paths as Record<string, unknown>)
    : [];
  const schemas = openApi.definitions && typeof openApi.definitions === "object"
    ? openApi.definitions as Record<string, unknown>
    : openApi.components && typeof openApi.components === "object"
      && (openApi.components as Record<string, unknown>).schemas
      && typeof (openApi.components as Record<string, unknown>).schemas === "object"
      ? (openApi.components as { schemas: Record<string, unknown> }).schemas
      : {};

  const summaries = TARGETS.map((target) => {
    const row = agents.find((agent) => agent.id === target.id);
    const prompt = row?.system_prompt ?? "";
    const rowVersions = versions.filter((version) => version.agent_id === target.id);
    return {
      id: target.id,
      role: target.role,
      found: Boolean(row),
      name: row?.name ?? null,
      expected_name: row ? target.names.includes(row.name as never) : false,
      deleted_at: row?.deleted_at ?? null,
      prompt_chars: prompt.length,
      prompt_sha256_16: prompt ? hash(prompt) : null,
      prompt_markers: {
        engineer_v5_legacy: prompt.includes('M27') || prompt.includes('<module id="M01"'),
        engineer_v51: prompt.includes("agent_engineer_state:v1") && prompt.includes("agent_prompt_package.v1"),
        storyboard_core: [
          "# 全片资产锁定",
          "# 口播转故事的方法",
          "# 语义包装",
          "# 3D风格执行字典",
          "# 故事板生图Prompt写法",
          "# 图生视频Prompt写法",
          "# 固定输出格式",
        ].every((marker) => prompt.includes(marker)),
        storyboard_machine_schema: prompt.includes("storyboard_director_output.v1"),
      },
      preset_fields: presetSummary(row?.preset_fields),
      output_style: row?.output_style ?? null,
      response_format: row?.response_format ?? null,
      context: row ? {
        rounds: row.max_context_rounds,
        tokens: row.max_context_tokens,
        reply: row.max_reply_tokens,
      } : null,
      prompt_versions: {
        count: rowVersions.length,
        latest_created_at: rowVersions[0]?.created_at ?? null,
        latest_prompt_sha256_16: rowVersions[0]?.prompt ? hash(rowVersions[0].prompt) : null,
      },
      updated_at: row?.updated_at ?? null,
    };
  });

  console.log(JSON.stringify({
    targets: summaries,
    preconditions: {
      all_targets_found_once: agents.length === TARGETS.length
        && new Set(agents.map((agent) => agent.id)).size === TARGETS.length,
      all_names_expected: summaries.every((item) => item.expected_name),
      no_soft_deleted_targets: summaries.every((item) => item.deleted_at === null),
      storyboard_core_present: summaries
        .filter((item) => item.role !== "agent_engineer")
        .every((item) => item.prompt_markers.storyboard_core),
    },
    backup_table: backupError
      ? { accessible: false, error_code: backupError.code, message: backupError.message }
      : { accessible: true, rows: backupData ?? [] },
    openapi: {
      accessible: openApiResponse.ok,
      status: openApiResponse.status,
      schema_tables: ["agents", "prompt_versions", "agent_config_migration_backups"].map((name) => ({
        name,
        exposed: Object.prototype.hasOwnProperty.call(schemas, name),
      })),
      sql_rpc_paths: paths.filter((path) => /\/rpc\/(?:exec|execute|run|query).*sql/i.test(path)),
    },
    execution_capability: {
      direct_database_url_configured: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL),
      transactional_sql_rpc_exposed: paths.some((path) => /\/rpc\/(?:exec|execute|run|query).*sql/i.test(path)),
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
