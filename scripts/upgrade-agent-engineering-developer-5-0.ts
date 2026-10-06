import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import { configurationSourceStatus } from "../src/storage/database/configuration-source";

const TARGET_ID = "agent-1781690935600-gkt1xg";
const TARGET_MODEL = {
  id: "9b177ccc-4afc-4d49-96bb-fdd01f09bf89",
  model_name: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol · 渠道A",
} as const;
const ALLOWED_NAMES = new Set([
  "智能体工程开师 5.0",
  "智能体工程师 5.0",
  "智能体工程师 5.1",
  "智能体工程开发者 5.0",
]);
const DOC_PATH = path.resolve("docs/智能体工程开发者5.0-系统提示词.md");
const EVIDENCE_DIR = path.resolve("运行日志/智能体工程开发者5.0-20260922");

type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  sort_order: number | null;
  model: string | null;
  model_id: string | null;
  system_prompt: string | null;
  guide_message: string | null;
  preset_fields: unknown;
  max_context_rounds: number | null;
  max_context_tokens: number | null;
  max_reply_tokens: number | null;
  timeout: number | null;
  temperature: number | null;
  response_format: string | null;
  is_active: boolean | null;
  deleted_at: string | null;
  updated_at: string;
};

type ModelRow = {
  id: string;
  name: string | null;
  model_name: string | null;
  category: string | null;
  is_active: boolean | null;
  is_hidden: boolean | null;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function extractBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  assert.ok(from >= 0 && to > from, `文档缺少标记：${start} / ${end}`);
  return source.slice(from + start.length, to).trim();
}

function parseCardFields(source: string): unknown[] {
  const match = source.match(/## 主站接收卡\s*```json\s*([\s\S]*?)```/u);
  assert.ok(match, "文档缺少主站接收卡 JSON");
  const parsed = JSON.parse(match[1]) as { schema_version?: string; fields?: unknown[] };
  assert.equal(parsed.schema_version, "agent_preset_fields.v1");
  assert.ok(Array.isArray(parsed.fields));
  return parsed.fields;
}

async function readTarget(): Promise<AgentRow> {
  const db = getSupabaseAdminClient();
  const result = await db
    .from("agents")
    .select("id,name,description,category,sort_order,model,model_id,system_prompt,guide_message,preset_fields,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,temperature,response_format,is_active,deleted_at,updated_at")
    .eq("id", TARGET_ID)
    .single();
  if (result.error) throw result.error;
  return result.data as AgentRow;
}

async function candidateModels(): Promise<ModelRow[]> {
  const db = getSupabaseAdminClient();
  const result = await db
    .from("llm_models")
    .select("id,name,model_name,category,is_active,is_hidden")
    .eq("is_active", true);
  if (result.error) throw result.error;
  return (result.data as ModelRow[]).filter((model) =>
    /(?:gpt[- ]?6|gpt[- ]?5\.6|claude.*4\.6|sonnet.*4\.6|opus.*4\.6)/iu.test(`${model.name ?? ""} ${model.model_name ?? ""}`),
  );
}

async function inspect() {
  const row = await readTarget();
  const models = await candidateModels();
  console.log(JSON.stringify({
    mode: "inspect",
    configuration_source: configurationSourceStatus(),
    target: {
      id: row.id,
      name: row.name,
      category: row.category,
      sort_order: row.sort_order,
      model: row.model,
      model_id: row.model_id,
      prompt_chars: row.system_prompt?.length ?? 0,
      prompt_sha256: sha256(row.system_prompt ?? ""),
      preset_field_count: Array.isArray(row.preset_fields) ? row.preset_fields.length : 0,
      is_active: row.is_active,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
    },
    strongest_configured_candidates: models,
  }, null, 2));
}

async function apply() {
  const db = getSupabaseAdminClient();
  const previous = await readTarget();
  assert.ok(ALLOWED_NAMES.has(previous.name), `目标名称不符合预期：${previous.name}`);
  assert.equal(previous.deleted_at, null, "目标智能体已软删除");
  assert.equal(previous.is_active, true, "目标智能体未启用");
  const modelCheck = await db.from("llm_models")
    .select("id,name,model_name,is_active,is_hidden")
    .eq("id", TARGET_MODEL.id)
    .single();
  if (modelCheck.error) throw modelCheck.error;
  assert.equal(modelCheck.data.model_name, TARGET_MODEL.model_name, "目标模型标识已变化");
  assert.equal(modelCheck.data.is_active, true, "目标模型未启用");
  assert.notEqual(modelCheck.data.is_hidden, true, "目标模型已隐藏");

  const source = await readFile(DOC_PATH, "utf8");
  const systemPrompt = extractBetween(source, "<!--SYSTEM_PROMPT_START-->", "<!--SYSTEM_PROMPT_END-->");
  const presetFields = parseCardFields(source);
  const patch = {
    name: "智能体工程开发者 5.0",
    description: "把需求、旧提示词、样例与工具约束编译成可测试、可回归、可发布的智能体或 Skill，覆盖文案、逆向、2D/3D与视频立项。",
    system_prompt: systemPrompt,
    guide_message: "直接说你想搭建什么，或贴上旧提示词和失败结果。还没想清楚也能开始；我会先诊断，再给方案、成品和可验证的测试包。",
    preset_fields: presetFields,
    model: TARGET_MODEL.model_name,
    model_id: TARGET_MODEL.id,
    max_context_rounds: 40,
    max_context_tokens: 50000,
    max_reply_tokens: 12000,
    timeout: 300,
    temperature: 0.45,
    response_format: "markdown",
  };

  await mkdir(EVIDENCE_DIR, { recursive: true });
  const backupPath = path.join(EVIDENCE_DIR, `before-${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify({
    schema_version: "agent_config_backup.v1",
    created_at: new Date().toISOString(),
    agent: previous,
  }, null, 2), "utf8");

  if (previous.system_prompt) {
    const history = await db.from("prompt_versions").insert({
      agent_id: TARGET_ID,
      prompt: previous.system_prompt,
    });
    if (history.error) throw history.error;
  }

  const updated = await db
    .from("agents")
    .update(patch)
    .eq("id", TARGET_ID)
    .eq("updated_at", previous.updated_at)
    .select("id,name,description,category,sort_order,model,model_id,system_prompt,guide_message,preset_fields,max_context_rounds,max_context_tokens,max_reply_tokens,timeout,temperature,response_format,is_active,deleted_at,updated_at")
    .maybeSingle();
  if (updated.error) throw updated.error;
  assert.ok(updated.data, "目标记录在更新前发生变化，已中止写入");

  try {
    const row = updated.data as AgentRow;
    assert.equal(row.name, patch.name);
    assert.equal(row.description, patch.description);
    assert.equal(row.system_prompt, patch.system_prompt);
    assert.equal(row.guide_message, patch.guide_message);
    assert.deepEqual(row.preset_fields, patch.preset_fields);
    assert.equal(row.model, patch.model);
    assert.equal(row.model_id, patch.model_id);
    assert.equal(row.max_context_rounds, patch.max_context_rounds);
    assert.equal(row.max_context_tokens, patch.max_context_tokens);
    assert.equal(row.max_reply_tokens, patch.max_reply_tokens);
    assert.equal(row.timeout, patch.timeout);
    assert.equal(row.response_format, patch.response_format);

    const history = await db.from("prompt_versions").insert({
      agent_id: TARGET_ID,
      prompt: systemPrompt,
    });
    if (history.error) throw history.error;

    const report = {
      schema_version: "agent_engineering_developer_upgrade_report.v1",
      applied_at: new Date().toISOString(),
      target_id: TARGET_ID,
      before: {
        name: previous.name,
        prompt_sha256: sha256(previous.system_prompt ?? ""),
        preset_field_count: Array.isArray(previous.preset_fields) ? previous.preset_fields.length : 0,
        updated_at: previous.updated_at,
      },
      after: {
        name: row.name,
        prompt_sha256: sha256(row.system_prompt ?? ""),
        prompt_chars: row.system_prompt?.length ?? 0,
        preset_field_count: Array.isArray(row.preset_fields) ? row.preset_fields.length : 0,
        model: row.model,
        model_id: row.model_id,
        updated_at: row.updated_at,
      },
      backup_path: path.relative(process.cwd(), backupPath).replaceAll("\\", "/"),
      shared_configuration_written: true,
      production_code_deployed: false,
      paid_generation_count: 0,
    };
    await writeFile(path.join(EVIDENCE_DIR, "upgrade-report.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const rollback = await db.from("agents").update({
      name: previous.name,
      description: previous.description,
      system_prompt: previous.system_prompt,
      guide_message: previous.guide_message,
      preset_fields: previous.preset_fields,
      max_context_rounds: previous.max_context_rounds,
      max_context_tokens: previous.max_context_tokens,
      max_reply_tokens: previous.max_reply_tokens,
      timeout: previous.timeout,
      temperature: previous.temperature,
      response_format: previous.response_format,
      model: previous.model,
      model_id: previous.model_id,
    }).eq("id", TARGET_ID);
    if (rollback.error) throw new AggregateError([error as Error, rollback.error], "验收失败且回滚失败");
    throw error;
  }
}

const mode = process.argv.includes("--apply") ? "apply" : "inspect";
(mode === "apply" ? apply() : inspect()).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
  process.exitCode = 1;
});
