import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const { Client } = pg;
const execFileAsync = promisify(execFile);

const AGENT_ID = "agent-1787163730859-vecrr6";
const AGENT_NAME = "网站功能推广师";
const AGENT_CATEGORY = "自用";
const MODEL_ID = "3a998bfc-aab4-4f8f-9128-b27498894a7b";
const MODEL_NAME = "claude-sonnet-4-6";
const storageRoot = path.resolve(process.cwd(), "../../..");
const bundleRoot = path.join(
  storageRoot,
  "03_知识库/自媒体操盘手长期知识库/08_智能体与数据链/网站功能推广师V2.0候选包/agent-build/自媒体获客文案操盘手",
);
const runtimeFile = path.join(storageRoot, "运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
const handoffStateFile = path.join(storageRoot, "01_网页开发项目/自媒体操盘手/协作交接记录/state.json");
const launcherFile = path.join(storageRoot, "启动自媒体操盘手本地预览.ps1");
const bundledKnowledgeFile = path.resolve(process.cwd(), "src/generated/website-promoter-knowledge.v1.json");

type Json = Record<string, unknown>;
type Runtime = { localOnly?: boolean; host?: string; supabaseUrl?: string; serviceRoleKey?: string; databaseUrl?: string };
type AgentRow = Record<string, unknown> & {
  id: string;
  name: string;
  category: string;
  system_prompt: string;
  preset_fields: unknown[];
  model: string;
  model_id: string;
  updated_at: string;
  updated_at_exact?: string;
};

const managedFields = [
  "id", "name", "description", "avatar", "category", "source", "model", "model_id",
  "system_prompt", "guide_message", "preset_fields", "is_active", "user_access", "sort_order",
  "max_context_rounds", "max_context_tokens", "max_reply_tokens", "timeout", "enable_web_search",
  "response_format", "temperature", "deep_thinking_type", "deduct_deep_think", "token_billing_enabled", "cost_per_message", "output_style",
  "enable_knowledge_base", "knowledge_base_id", "image_parsing", "file_parsing", "updated_at", "deleted_at",
] as const;
const managedNumericFields = new Set([
  "sort_order", "max_context_rounds", "max_context_tokens", "max_reply_tokens", "timeout",
  "temperature", "deep_thinking_type", "deduct_deep_think", "cost_per_message",
]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Json;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function valueOf(name: string): string {
  const exact = process.argv.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}

function objectValue(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    } catch { /* Keep an empty compatible object. */ }
  }
  return {};
}

async function readText(file: string): Promise<string> {
  return (await readFile(file, "utf8")).replace(/^\uFEFF/u, "");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readText(file)) as T;
}

function pickManaged(row: AgentRow): Json {
  return Object.fromEntries(managedFields.filter((key) => key in row).map((key) => [key, row[key]]));
}

function normalizePgManagedRow(raw: Record<string, unknown>): AgentRow {
  const normalized: Record<string, unknown> = { ...raw };
  for (const key of managedNumericFields) {
    if (normalized[key] === null || normalized[key] === undefined || normalized[key] === "") continue;
    const parsed = Number(normalized[key]);
    assert.ok(Number.isFinite(parsed), `invalid numeric database value for ${key}`);
    normalized[key] = parsed;
  }
  if (normalized.updated_at instanceof Date) normalized.updated_at = normalized.updated_at.toISOString();
  return normalized as unknown as AgentRow;
}

async function compileTarget() {
  const [basePrompt, intake, card, promptPackage, painDb, sampleDb, hotspotDb, capabilityDb, knowledgeManifest, bundledKnowledge] = await Promise.all([
    readText(path.join(bundleRoot, "系统提示词.md")),
    readJson<{ fields: unknown[] }>(path.join(bundleRoot, "接收卡.json")),
    readJson<{ card: { description: string; welcome_message: string }; candidate_identity: Json }>(path.join(bundleRoot, "主站工具卡片候选.v1.json")),
    readJson<{ agent: { id: string; name: string; version: string }; system_prompt: string; preset_fields: unknown[]; platform: Json }>(path.join(bundleRoot, "agent_prompt_package.v1.json")),
    readJson<{ pains: Json[]; generated_at: string; knowledge_base_id: string }>(path.join(bundleRoot, "知识库/数据/自媒体用户痛点总库.v2.json")),
    readJson<{ samples: Json[]; built_at: string }>(path.join(bundleRoot, "知识库/数据/抖音达人作品研究样本.v1.json")),
    readJson<{ topics: Json[]; generated_at: string; valid_until: string; menu_id: string; snapshot_status: string }>(path.join(bundleRoot, "热点库/当前选题菜单.v1.json")),
    readJson<{ capabilities: Json[]; verified_at: string }>(path.join(bundleRoot, "知识库/数据/项目能力证据卡.v1.json")),
    readJson<Json>(path.join(bundleRoot, "知识库清单.json")),
    readJson<Json>(bundledKnowledgeFile),
  ]);
  assert.equal(painDb.pains.length, 160, "pain library count changed; review before publishing");
  assert.equal(sampleDb.samples.length, 65, "research sample count changed; review before publishing");
  assert.equal(hotspotDb.topics.length, 12, "hotspot menu batch changed; review before publishing");
  assert.equal(capabilityDb.capabilities.length, 7, "capability evidence count changed; review before publishing");
  assert.deepEqual(promptPackage.agent, { id: "agent-self-media-acquisition-copy", name: AGENT_NAME, version: "2.0.0" }, "prompt package identity changed");
  assert.equal(promptPackage.system_prompt, basePrompt, "prompt package and system prompt artifact diverged");
  assert.equal(canonical(promptPackage.preset_fields), canonical(intake.fields), "prompt package and intake artifact diverged");
  assert.equal(String(card.candidate_identity.stable_package_agent_id), promptPackage.agent.id, "card/package agent identity mismatch");
  assert.equal(String(card.candidate_identity.display_name), AGENT_NAME, "card display name changed");
  assert.equal(String(card.candidate_identity.version), promptPackage.agent.version, "card/package version mismatch");
  assert.equal(String(card.candidate_identity.category), AGENT_CATEGORY, "card category changed");
  const bundledCounts = objectValue(bundledKnowledge.counts);
  const bundledContract = objectValue(bundledKnowledge.runtime_contract);
  const { snapshot_id: bundledSnapshotId, snapshot_sha256: bundledSnapshotSha, ...bundledPayload } = bundledKnowledge;
  assert.equal(bundledKnowledge.schema_version, "website_promoter_knowledge_snapshot.v1", "bundled knowledge schema changed");
  assert.equal(bundledKnowledge.agent_id, AGENT_ID, "bundled knowledge agent changed");
  assert.equal(bundledKnowledge.knowledge_base_id, String(promptPackage.platform.knowledge_base_id), "bundled knowledge id changed");
  assert.equal(bundledContract.knowledge_mode, "bundled_snapshot_retrieval", "bundled knowledge runtime mode changed");
  assert.equal(bundledContract.isolation, "exact_agent_id", "bundled knowledge isolation changed");
  assert.equal(Number(bundledCounts.pains), 160, "bundled pain count changed");
  assert.equal(Number(bundledCounts.evidence), 65, "bundled evidence count changed");
  assert.equal(Number(bundledCounts.topics), 12, "bundled topic count changed");
  assert.equal(Number(bundledCounts.capabilities), 7, "bundled capability count changed");
  assert.equal(String(bundledSnapshotSha), sha256(canonical(bundledPayload)), "bundled knowledge snapshot hash mismatch");
  assert.equal(String(bundledSnapshotId), `wps-${String(bundledSnapshotSha).slice(0, 16)}`, "bundled knowledge snapshot id mismatch");

  const prompt = basePrompt;
  const sourceTimestamps = {
    pain: painDb.generated_at,
    samples: sampleDb.built_at,
    hotspot: hotspotDb.generated_at,
    capabilities: capabilityDb.verified_at,
  };
  const sourceEpochs = Object.values(sourceTimestamps).map((value) => Date.parse(String(value)));
  assert.ok(sourceEpochs.every(Number.isFinite), "knowledge source timestamps must be valid ISO timestamps");
  const knowledgeSnapshot = {
    schema_version: "website_promoter_external_knowledge_snapshot.v1",
    knowledge_base_id: String(promptPackage.platform.knowledge_base_id || painDb.knowledge_base_id),
    runtime_binding: "unbound",
    storage_mode: "independent_f_drive_assets",
    pain_count: painDb.pains.length,
    sample_count: sampleDb.samples.length,
    hotspot_count: hotspotDb.topics.length,
    capability_count: capabilityDb.capabilities.length,
    generated_at: new Date(Math.max(...sourceEpochs)).toISOString(),
    source_timestamps: sourceTimestamps,
    source_hashes: {
      pain: sha256(canonical(painDb)),
      samples: sha256(canonical(sampleDb)),
      hotspot: sha256(canonical(hotspotDb)),
      capabilities: sha256(canonical(capabilityDb)),
      manifest: sha256(canonical(knowledgeManifest)),
    },
    snapshot_sha256: sha256(canonical({ painDb, sampleDb, hotspotDb, capabilityDb, knowledgeManifest })),
  };
  assert.equal(Number(promptPackage.platform.max_reply_tokens), 6144, "review candidate reply limit before applying");
  assert.equal(Number(promptPackage.platform.timeout), 180, "review candidate timeout before applying");
  assert.equal(Number(promptPackage.platform.temperature), 0.45, "review candidate temperature before applying");
  assert.equal(Number(promptPackage.platform.max_context_rounds), 20, "review candidate context rounds before applying");
  assert.equal(String(promptPackage.platform.category), AGENT_CATEGORY, "review candidate category before applying");
  assert.equal(String(promptPackage.platform.source), "llm", "review candidate source before applying");
  assert.equal(String(promptPackage.platform.response_format), "markdown", "review candidate response format before applying");
  assert.equal(promptPackage.platform.enable_web_search, false, "review candidate web-search setting before applying");
  assert.equal(promptPackage.platform.token_billing_enabled, false, "review candidate message-billing setting before applying");
  assert.equal(Number(promptPackage.platform.cost_per_message), 0, "review candidate per-message cost before applying");
  assert.equal(String(promptPackage.platform.image_parsing), "auto", "review candidate image parsing before applying");
  assert.equal(String(promptPackage.platform.file_parsing), "auto", "review candidate file parsing before applying");
  return { prompt, intake, card, promptPackage, knowledgeSnapshot, bundledKnowledge };
}

async function assertRunningLatest(): Promise<void> {
  const result = await execFileAsync("pwsh.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & $env:CODEX_PROMOTER_LAUNCHER -CheckOnly",
  ], {
    cwd: storageRoot,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CODEX_PROMOTER_LAUNCHER: launcherFile },
  });
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, "local runtime identity output is missing");
  const identity = JSON.parse(result.stdout.slice(start, end + 1)) as Json;
  assert.equal(identity.runningLatest, true, "local F-drive build is not the current source");
  assert.equal(path.resolve(String(identity.source || "")).toLowerCase(), process.cwd().toLowerCase(), "local runtime source mismatch");
}

async function assertActiveHandoff(session: string) {
  assert.ok(session, "--session is required for local database writes");
  const state = await readJson<{ active?: { id?: string; tool?: string } }>(handoffStateFile);
  assert.equal(state.active?.id, session, "collaboration session is no longer active");
  assert.equal(state.active?.tool, "Codex", "active collaboration writer is not Codex");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const attestRuntime = process.argv.includes("--attest-runtime");
  const rehearseRollback = process.argv.includes("--rehearse-rollback");
  const sessionIndex = process.argv.indexOf("--session");
  const session = sessionIndex >= 0 ? String(process.argv[sessionIndex + 1] || "") : "";
  const expectedCurrentPromptSha = valueOf("--expected-current-prompt-sha256");
  const expectedCurrentUpdatedAt = valueOf("--expected-current-updated-at");
  const evaluationReportPath = valueOf("--evaluation-report");
  assert.ok(!(apply && attestRuntime), "choose either --apply or --attest-runtime");
  if (apply || attestRuntime) {
    await assertActiveHandoff(session);
    await assertRunningLatest();
  }

  const runtime = await readJson<Runtime>(runtimeFile);
  assert.equal(runtime.localOnly, true, "local-only runtime required");
  assert.equal(runtime.host, "127.0.0.1", "loopback runtime required");
  assert.equal(new URL(String(runtime.supabaseUrl)).origin, "http://127.0.0.1:54321", "local Supabase required");
  assert.ok(runtime.serviceRoleKey, "local service role key is missing");
  assert.ok(runtime.databaseUrl, "local database URL is missing");
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(new URL(String(runtime.databaseUrl)).hostname), "loopback PostgreSQL required");
  const db = createClient(String(runtime.supabaseUrl), String(runtime.serviceRoleKey), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const target = await compileTarget();
  const currentResult = await db.from("agents").select(managedFields.join(",")).eq("id", AGENT_ID).maybeSingle();
  assert.ifError(currentResult.error);
  const current = currentResult.data as AgentRow | null;
  assert.ok(current, "existing website promoter card not found in local acceptance database");
  assert.equal(current.name, AGENT_NAME, "agent id/name mismatch");
  assert.equal(current.category, AGENT_CATEGORY, "agent category mismatch");
  assert.equal(current.deleted_at, null, "target card is deleted");
  if (apply) {
    assert.match(expectedCurrentPromptSha, /^[a-f0-9]{64}$/u, "reviewed baseline prompt hash is required");
    assert.ok(expectedCurrentUpdatedAt, "reviewed baseline updated_at is required");
    assert.equal(sha256(current.system_prompt || ""), expectedCurrentPromptSha, "current prompt is not the reviewed baseline");
    assert.equal(current.updated_at, expectedCurrentUpdatedAt, "current revision is not the reviewed baseline");
  }
  const duplicates = await db.from("agents").select("id,name,category").eq("name", AGENT_NAME).eq("category", AGENT_CATEGORY).is("deleted_at", null);
  assert.ifError(duplicates.error);
  assert.equal(duplicates.data?.length, 1, "duplicate website promoter cards detected");
  const model = await db.from("llm_models").select("id,name,model_name,is_active,is_hidden,user_access,input_cost_per_million,output_cost_per_million,profit_margin").eq("id", MODEL_ID).maybeSingle();
  assert.ifError(model.error);
  assert.ok(model.data, "reviewed Claude model binding is missing");
  assert.equal(model.data.model_name, MODEL_NAME, "reviewed model id now points to a different model");
  assert.equal(model.data.is_active, true, "reviewed model is inactive");
  assert.notEqual(model.data.is_hidden, true, "reviewed model is hidden");

  const transactionId = `website-promoter-v2-${randomUUID()}`;
  const bundledRuntime = objectValue(target.bundledKnowledge.runtime_contract);
  const bundledCounts = objectValue(target.bundledKnowledge.counts);
  const targetPatch: Json = {
    name: AGENT_NAME,
    description: target.card.card.description,
    category: AGENT_CATEGORY,
    source: "llm",
    model: MODEL_NAME,
    model_id: MODEL_ID,
    system_prompt: target.prompt,
    guide_message: target.card.card.welcome_message,
    preset_fields: target.intake.fields,
    is_active: true,
    user_access: "available",
    max_context_rounds: 20,
    max_context_tokens: 0,
    max_reply_tokens: Number(target.promptPackage.platform.max_reply_tokens),
    timeout: Number(target.promptPackage.platform.timeout),
    enable_web_search: false,
    response_format: "markdown",
    temperature: Number(target.promptPackage.platform.temperature),
    deep_thinking_type: 0,
    deduct_deep_think: 1,
    token_billing_enabled: false,
    cost_per_message: 0,
    enable_knowledge_base: false,
    knowledge_base_id: target.knowledgeSnapshot.knowledge_base_id,
    image_parsing: "auto",
    file_parsing: "auto",
    output_style: {
      ...objectValue(current.output_style),
      website_promoter: {
        schema_version: "website_promoter_binding.v2",
        package_agent_id: "agent-self-media-acquisition-copy",
        package_version: "2.0.0",
        knowledge_mode: "bundled_snapshot_retrieval",
        knowledge_snapshot_sha256: String(target.bundledKnowledge.snapshot_sha256),
        source_knowledge_snapshot_sha256: target.knowledgeSnapshot.snapshot_sha256,
        knowledge_binding_status: "bundled_snapshot_compiled_builtin_database_kb_disabled",
        dynamic_runtime_status: "source_ready",
        knowledge_runtime: {
          knowledge_mode: "bundled_snapshot_retrieval",
          dynamic_runtime_status: "source_ready",
          agent_id: AGENT_ID,
          snapshot_id: String(target.bundledKnowledge.snapshot_id),
          snapshot_sha256: String(target.bundledKnowledge.snapshot_sha256),
          source_manifest_sha256: String(target.bundledKnowledge.source_manifest_sha256),
          source_latest_at: String(target.bundledKnowledge.compiled_from_latest_source_at),
          counts: bundledCounts,
          max_context_characters: Number(bundledRuntime.max_context_characters),
          isolation: String(bundledRuntime.isolation),
          runtime_route: String(bundledRuntime.route),
        },
        upgrade_transaction_id: transactionId,
      },
    },
  };
  const plan = {
    mode: apply ? "apply" : attestRuntime ? "attest-runtime" : "plan",
    target: "local-acceptance",
    database_origin: new URL(String(runtime.supabaseUrl)).origin,
    production_written: false,
    agent: { id: current.id, name: current.name, category: current.category, updated_at: current.updated_at },
    from: { prompt_sha256: sha256(current.system_prompt || ""), prompt_chars: (current.system_prompt || "").length, field_ids: (current.preset_fields || []).map((item: any) => item.id) },
    to: { prompt_sha256: sha256(target.prompt), prompt_chars: target.prompt.length, field_ids: target.intake.fields.map((item: any) => item.id), knowledge_snapshot: target.knowledgeSnapshot },
    model: { id: model.data.id, name: model.data.name, model_name: model.data.model_name, input_cost_per_million: model.data.input_cost_per_million, output_cost_per_million: model.data.output_cost_per_million, profit_margin: model.data.profit_margin },
    rollback_rehearsal_requested: rehearseRollback,
    reviewed_baseline: { prompt_sha256: expectedCurrentPromptSha || null, updated_at: expectedCurrentUpdatedAt || null },
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!apply && !attestRuntime) return;
  if (rehearseRollback) assert.notEqual(sha256(current.system_prompt || ""), sha256(target.prompt), "rollback rehearsal requires a distinct reviewed baseline");

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const evidenceDir = path.resolve(".codex-evidence", "website-promoter-v2", stamp);
  const backupDir = path.resolve(".codex-backups", "website-promoter-v2", stamp);
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });
  const prompts = await db.from("prompt_versions").select("id,agent_id,prompt,created_at").eq("agent_id", AGENT_ID).order("created_at", { ascending: true });
  assert.ifError(prompts.error);
  const skills = await db.from("agent_skills").select("*").eq("agent_id", AGENT_ID);
  assert.ifError(skills.error);
  const before = { captured_at: new Date().toISOString(), agent: pickManaged(current), prompt_versions: prompts.data || [], agent_skills: skills.data || [] };
  const beforeText = `${JSON.stringify(before, null, 2)}\n`;
  await writeFile(path.join(backupDir, "before.json"), beforeText, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(backupDir, "before.json.sha256"), `${sha256(beforeText)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(evidenceDir, "compiled-knowledge-snapshot.json"), `${JSON.stringify(target.knowledgeSnapshot, null, 2)}\n`, "utf8");

  async function casPatch(expectedUpdatedAt: string, expectedPrompt: string, patch: Json): Promise<{ row: AgentRow; updatedAtExact: string }> {
    const sql = new Client({ connectionString: String(runtime.databaseUrl), ssl: false, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
    await sql.connect();
    try {
      await sql.query("BEGIN");
      const locked = await sql.query("SELECT id, updated_at, updated_at::text AS updated_at_exact, system_prompt, (updated_at = $2::timestamptz) AS revision_matches FROM public.agents WHERE id = $1 FOR UPDATE", [AGENT_ID, expectedUpdatedAt]);
      assert.equal(locked.rowCount, 1, "target agent disappeared during transaction");
      assert.equal(locked.rows[0].revision_matches, true, "agent configuration changed concurrently; stopped without overwrite");
      assert.equal(sha256(String(locked.rows[0].system_prompt || "")), sha256(expectedPrompt), "agent prompt changed concurrently; stopped without overwrite");
      const latest = await sql.query("SELECT prompt FROM public.prompt_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1", [AGENT_ID]);
      if (String(latest.rows[0]?.prompt || "") !== expectedPrompt) {
        await sql.query("INSERT INTO public.prompt_versions (agent_id, prompt) VALUES ($1, $2)", [AGENT_ID, expectedPrompt]);
      }
      const entries = Object.entries(patch);
      const values = entries.map(([, value]) => value && typeof value === "object" ? JSON.stringify(value) : value);
      const assignments = entries.map(([key, value], index) => {
        assert.ok(/^[a-z_]+$/u.test(key), `unsafe patch key: ${key}`);
        return `${key} = $${index + 2}${value && typeof value === "object" ? "::jsonb" : ""}`;
      });
      const updated = await sql.query(
        `UPDATE public.agents SET ${assignments.join(", ")}, updated_at = clock_timestamp() WHERE id = $1 RETURNING ${managedFields.join(", ")}, updated_at::text AS updated_at_exact`,
        [AGENT_ID, ...values],
      );
      assert.equal(updated.rowCount, 1, "transactional agent update failed");
      const nextPrompt = String(patch.system_prompt || expectedPrompt);
      const afterLatest = await sql.query("SELECT prompt FROM public.prompt_versions WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1", [AGENT_ID]);
      if (String(afterLatest.rows[0]?.prompt || "") !== nextPrompt) {
        await sql.query("INSERT INTO public.prompt_versions (agent_id, prompt) VALUES ($1, $2)", [AGENT_ID, nextPrompt]);
      }
      await sql.query("COMMIT");
      const row = normalizePgManagedRow(updated.rows[0] as Record<string, unknown>);
      const updatedAtExact = String(row.updated_at_exact || "");
      assert.ok(updatedAtExact, "transaction did not return an exact revision timestamp");
      return { row, updatedAtExact };
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  async function readManagedExact(): Promise<{ row: AgentRow; updatedAtExact: string }> {
    const sql = new Client({ connectionString: String(runtime.databaseUrl), ssl: false, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
    await sql.connect();
    try {
      const observed = await sql.query(
        `SELECT ${managedFields.join(", ")}, updated_at::text AS updated_at_exact FROM public.agents WHERE id = $1`,
        [AGENT_ID],
      );
      assert.equal(observed.rowCount, 1, "target agent disappeared during exact readback");
      const row = normalizePgManagedRow(observed.rows[0] as Record<string, unknown>);
      const updatedAtExact = String(row.updated_at_exact || "");
      assert.ok(updatedAtExact, "exact readback did not return a revision timestamp");
      return { row, updatedAtExact };
    } finally {
      await sql.end().catch(() => undefined);
    }
  }

  async function verifyTarget(): Promise<AgentRow> {
    const result = await db.from("agents").select(managedFields.join(",")).eq("id", AGENT_ID).maybeSingle();
    assert.ifError(result.error);
    const row = result.data as unknown as AgentRow;
    assert.equal(sha256(row.system_prompt), sha256(target.prompt), "target prompt readback mismatch");
    assert.equal(row.model_id, MODEL_ID, "target model readback mismatch");
    assert.equal(row.category, AGENT_CATEGORY, "target category readback mismatch");
    assert.deepEqual((row.preset_fields || []).map((item: any) => item.id), target.intake.fields.map((item: any) => item.id), "target intake readback mismatch");
    for (const [key, expected] of Object.entries(targetPatch)) {
      const actual = row[key];
      if (expected && typeof expected === "object") assert.equal(canonical(actual), canonical(expected), `${key} readback mismatch`);
      else assert.equal(actual, expected, `${key} readback mismatch`);
    }
    return row;
  }

  if (attestRuntime) {
    const runtimeAttestationEnabled: boolean = false;
    assert.ok(runtimeAttestationEnabled, "RUNTIME_ATTESTATION_DISABLED_PENDING_FAIL_CLOSED_EVIDENCE_VALIDATOR");
    assert.ok(evaluationReportPath, "--evaluation-report is required for runtime attestation");
    const reportAbsolute = path.resolve(evaluationReportPath);
    const allowedEvidenceRoot = `${path.resolve(".codex-evidence", "website-promoter-v2-live")}${path.sep}`.toLowerCase();
    assert.ok(reportAbsolute.toLowerCase().startsWith(allowedEvidenceRoot), "evaluation report must be inside the reviewed local evidence root");
    const reportRaw = await readText(reportAbsolute);
    const evaluation = JSON.parse(reportRaw) as Json;
    assert.equal(evaluation.schema_version, "agent_evaluation_run.v1-candidate", "evaluation report schema mismatch");
    assert.equal(evaluation.environment, "local-acceptance", "evaluation environment mismatch");
    assert.equal(evaluation.production_written, false, "evaluation must not write production");
    assert.equal(evaluation.agent_id, AGENT_ID, "evaluation agent mismatch");
    assert.equal(evaluation.package_agent_id, "agent-self-media-acquisition-copy", "evaluation package mismatch");
    assert.equal(evaluation.package_version, "2.0.0", "evaluation package version mismatch");
    assert.equal(evaluation.agent_prompt_sha256, sha256(target.prompt), "evaluation prompt mismatch");
    assert.equal(evaluation.agent_updated_at, current.updated_at, "agent revision changed after evaluation");
    assert.equal(evaluation.passed, true, "evaluation did not pass all release gates");
    assert.equal(Number(evaluation.total), 20, "evaluation case count mismatch");
    assert.equal(Number(evaluation.pass_count), 20, "evaluation pass count mismatch");
    assert.equal(Number(evaluation.blocked_count), 0, "evaluation contains blocked cases");
    assert.equal(Number(evaluation.hard_fail_count), 0, "evaluation contains hard failures");
    assert.equal(evaluation.cost_cap_respected, true, "evaluation cost cap failed");
    const evaluatedKnowledge = objectValue(evaluation.knowledge_runtime);
    assert.equal(evaluatedKnowledge.runtime_ready_for_evaluation, true, "bundled knowledge runtime was not proven during evaluation");
    assert.equal(evaluatedKnowledge.bundled_snapshot_sha256, target.bundledKnowledge.snapshot_sha256, "evaluated knowledge snapshot mismatch");
    const currentStyle = objectValue(current.output_style);
    const currentBinding = objectValue(currentStyle.website_promoter);
    const currentKnowledgeRuntime = objectValue(currentBinding.knowledge_runtime);
    assert.equal(currentBinding.knowledge_mode, "bundled_snapshot_retrieval", "current agent is not using bundled retrieval");
    assert.equal(currentBinding.dynamic_runtime_status, "source_ready", "runtime attestation requires source_ready state");
    assert.equal(currentKnowledgeRuntime.snapshot_sha256, target.bundledKnowledge.snapshot_sha256, "current runtime snapshot mismatch");
    const attestedStyle = {
      ...currentStyle,
      website_promoter: {
        ...currentBinding,
        dynamic_runtime_status: "deployed",
        knowledge_runtime: {
          ...currentKnowledgeRuntime,
          dynamic_runtime_status: "deployed",
          attested_at: new Date().toISOString(),
          evaluation_run_id: String(evaluation.run_id || ""),
          evaluation_report_sha256: sha256(reportRaw),
        },
      },
    };
    const attestedTransaction = await casPatch(current.updated_at, current.system_prompt, { output_style: attestedStyle });
    const attested = await readManagedExact();
    assert.equal(attested.updatedAtExact, attestedTransaction.updatedAtExact, "runtime attestation revision mismatch");
    assert.equal(canonical(attested.row.output_style), canonical(attestedStyle), "runtime attestation readback mismatch");
    const receipt = {
      schema_version: "website_promoter_runtime_attestation.v1",
      attested_at: new Date().toISOString(),
      environment: "local-acceptance",
      production_written: false,
      agent_id: AGENT_ID,
      package_version: "2.0.0",
      updated_at_exact: attested.updatedAtExact,
      snapshot_id: target.bundledKnowledge.snapshot_id,
      snapshot_sha256: target.bundledKnowledge.snapshot_sha256,
      evaluation_run_id: evaluation.run_id,
      evaluation_report: path.relative(process.cwd(), reportAbsolute).replace(/\\/gu, "/"),
      evaluation_report_sha256: sha256(reportRaw),
      rollback_ref: path.relative(process.cwd(), path.join(backupDir, "before.json")).replace(/\\/gu, "/"),
    };
    await writeFile(path.join(evidenceDir, "runtime-attestation-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ passed: true, mode: "attest-runtime", evidenceDir, receipt }, null, 2));
    return;
  }

  let applied: AgentRow | null = null;
  let appliedUpdatedAtExact = "";
  try {
    const appliedTransaction = await casPatch(current.updated_at, current.system_prompt, targetPatch);
    appliedUpdatedAtExact = appliedTransaction.updatedAtExact;
    applied = await verifyTarget();
    const rollbackTrace: Json[] = [{ phase: "v2-applied", at: new Date().toISOString(), prompt_sha256: sha256(applied.system_prompt), updated_at_exact: appliedUpdatedAtExact }];
    if (rehearseRollback) {
      const restorePatch = { ...pickManaged(current) };
      delete restorePatch.id;
      delete restorePatch.updated_at;
      delete restorePatch.deleted_at;
      const restoredTransaction = await casPatch(appliedUpdatedAtExact, target.prompt, restorePatch);
      const restored = restoredTransaction.row;
      assert.equal(sha256(restored.system_prompt), sha256(current.system_prompt), "rollback prompt readback mismatch");
      const restoredComparable = pickManaged(restored);
      const currentComparable = pickManaged(current);
      delete restoredComparable.updated_at;
      delete currentComparable.updated_at;
      assert.equal(canonical(restoredComparable), canonical(currentComparable), "rollback managed configuration readback mismatch");
      rollbackTrace.push({ phase: "v1-restored", at: new Date().toISOString(), prompt_sha256: sha256(restored.system_prompt), updated_at_exact: restoredTransaction.updatedAtExact });
      const reappliedTransaction = await casPatch(restoredTransaction.updatedAtExact, current.system_prompt, targetPatch);
      appliedUpdatedAtExact = reappliedTransaction.updatedAtExact;
      applied = await verifyTarget();
      rollbackTrace.push({ phase: "v2-reapplied", at: new Date().toISOString(), prompt_sha256: sha256(applied.system_prompt), updated_at_exact: appliedUpdatedAtExact });
    }
    const promptsAfter = await db.from("prompt_versions").select("id,agent_id,prompt,created_at").eq("agent_id", AGENT_ID).order("created_at", { ascending: true });
    assert.ifError(promptsAfter.error);
    const historyAfter = promptsAfter.data || [];
    assert.equal(canonical(historyAfter.slice(0, before.prompt_versions.length)), canonical(before.prompt_versions), "prompt version history prefix changed");
    assert.equal(String(historyAfter.at(-1)?.prompt || ""), target.prompt, "target prompt is not the latest prompt version");
    if (rehearseRollback) {
      assert.deepEqual(historyAfter.slice(-3).map((item) => String(item.prompt || "")), [target.prompt, current.system_prompt, target.prompt], "rollback/reapply prompt history suffix mismatch");
    }
    const report = {
      schema_version: "website_promoter_local_upgrade_receipt.v1",
      receipt_id: `website-promoter-local-${randomUUID()}`,
      completed_at: new Date().toISOString(),
      environment: "local-acceptance",
      production_written: false,
      agent_id: AGENT_ID,
      version: "2.0.0-local-candidate",
      source_prompt_sha256: sha256(target.prompt),
      readback_prompt_sha256: sha256(applied.system_prompt),
      intake_sha256: sha256(canonical(target.intake.fields)),
      knowledge_snapshot_sha256: target.knowledgeSnapshot.snapshot_sha256,
      model_id: MODEL_ID,
      upgrade_transaction_id: transactionId,
      applied_updated_at_exact: appliedUpdatedAtExact,
      rollback_rehearsed: rehearseRollback,
      rollback_scope: "agent_configuration_row",
      prompt_version_history_policy: "append_only_audit_history",
      rollback_trace: rollbackTrace,
      prompt_version_history: {
        before_count: before.prompt_versions.length,
        after_count: historyAfter.length,
        append_only_prefix_verified: true,
        latest_prompt_sha256: sha256(String(historyAfter.at(-1)?.prompt || "")),
      },
      backup_ref: path.relative(process.cwd(), path.join(backupDir, "before.json")).replace(/\\/gu, "/"),
      runtime_tests_passed: false,
      publication_status: "local_candidate_not_published",
    };
    const skillsAfter = await db.from("agent_skills").select("*").eq("agent_id", AGENT_ID);
    assert.ifError(skillsAfter.error);
    assert.equal(canonical(skillsAfter.data || []), canonical(skills.data || []), "agent skill bindings changed unexpectedly");
    await writeFile(path.join(evidenceDir, "upgrade-receipt.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ passed: true, evidenceDir, backupDir, report }, null, 2));
  } catch (error) {
    let recoveryError: unknown = null;
    try {
      const observed = await readManagedExact();
      const observedRow = observed.row;
      const expectedApplied = { ...pickManaged(current), ...targetPatch };
      delete expectedApplied.updated_at;
      const observedComparable = pickManaged(observedRow);
      delete observedComparable.updated_at;
      if (canonical(observedComparable) === canonical(expectedApplied)) {
        const restorePatch = { ...pickManaged(current) };
        delete restorePatch.id;
        delete restorePatch.updated_at;
        delete restorePatch.deleted_at;
        await casPatch(observed.updatedAtExact, target.prompt, restorePatch);
        const restored = await readManagedExact();
        const restoredComparable = pickManaged(restored.row);
        const currentComparable = pickManaged(current);
        delete restoredComparable.updated_at;
        delete currentComparable.updated_at;
        assert.equal(canonical(restoredComparable), canonical(currentComparable), "automatic recovery managed-row readback mismatch");
        await writeFile(path.join(evidenceDir, "automatic-recovery-completed.json"), `${JSON.stringify({ recovered_at: new Date().toISOString(), failed_transaction_id: transactionId, restored_updated_at_exact: restored.updatedAtExact, managed_state_sha256: sha256(canonical(restoredComparable)) }, null, 2)}\n`, "utf8");
      } else {
        await writeFile(path.join(evidenceDir, "automatic-recovery-skipped.json"), `${JSON.stringify({ skipped_at: new Date().toISOString(), failed_transaction_id: transactionId, reason: "observed managed state no longer equals this transaction target", observed_updated_at_exact: observed.updatedAtExact, observed_managed_sha256: sha256(canonical(observedComparable)), expected_applied_sha256: sha256(canonical(expectedApplied)) }, null, 2)}\n`, "utf8");
      }
    } catch (restoreError) {
      recoveryError = restoreError;
    }
    if (recoveryError) {
      try {
        await writeFile(path.join(evidenceDir, "emergency-recovery-failure.json"), `${JSON.stringify({ failed_at: new Date().toISOString(), original_error: String(error), recovery_error: String(recoveryError), backup_ref: path.join(backupDir, "before.json") }, null, 2)}\n`, "utf8");
      } catch { /* The immutable backup was already written before mutation. */ }
      throw new AggregateError([error, recoveryError], "upgrade failed and automatic configuration recovery also failed");
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
