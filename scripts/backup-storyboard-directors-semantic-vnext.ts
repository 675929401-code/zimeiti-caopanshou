import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const targets = [
  { id: "agent-1786633444187-594spj", name: "故事版导演｜高能夸张", mode: "high_energy" },
  { id: "agent-1786642714227-e1zid1", name: "故事版导演｜电影叙事", mode: "cinematic" },
  { id: "agent-1786642714448-m6iaou", name: "故事版导演｜抒情情感", mode: "lyrical" },
] as const;
const requestedMode = process.env.TARGET_MODE?.trim() || "";
const selectedTargets = requestedMode
  ? targets.filter((target) => target.mode === requestedMode)
  : [...targets];
assert.ok(selectedTargets.length > 0, `未知TARGET_MODE：${requestedMode}`);

const safeColumns = [
  "id", "name", "description", "category", "source", "model", "model_id",
  "is_active", "user_access", "sort_order", "system_prompt", "preset_fields",
  "output_style", "response_format", "max_context_rounds", "max_context_tokens",
  "max_reply_tokens", "temperature", "timeout", "enable_web_search", "guide_message",
  "updated_at", "deleted_at",
] as const;

interface PromptVersion {
  id: string;
  ts: number;
  prompt: string;
}

interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: unknown;
  output_style: unknown;
  updated_at: string;
  deleted_at: null;
  [key: string]: unknown;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} 请求失败（${response.status}）`);
  return payload;
}

async function main() {
  const key = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || required("COZE_SUPABASE_ANON_KEY");
  const client = createClient(required("COZE_SUPABASE_URL"), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client
    .from("agents")
    .select(safeColumns.join(","))
    .in("id", selectedTargets.map((target) => target.id));
  if (error) throw error;
  const rows = (data || []) as unknown as AgentRow[];
  assert.equal(rows.length, selectedTargets.length, "本地备份目标数量异常");

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员会话不可用");

  const backupId = `storyboard-directors-semantic-vnext-preflight-${stamp()}`;
  const backupDir = path.resolve("backups", backupId);
  await mkdir(path.join(backupDir, "agents"), { recursive: true });

  const manifestAgents = [];
  for (const target of selectedTargets) {
    const row = rows.find((item) => item.id === target.id);
    assert.ok(row && row.name === target.name && row.deleted_at === null, `目标卡片不匹配：${target.id}`);
    const promptSha = sha256(row.system_prompt);

    const versionBackup = await requestJson<{ skipped?: boolean; version?: PromptVersion | null }>(
      `${baseUrl}/api/admin/prompt-versions`,
      session.token,
      {
        method: "POST",
        body: JSON.stringify({ agent_id: row.id, prompt: row.system_prompt, max_versions: 20 }),
      },
    );
    const history = await requestJson<{ versions: PromptVersion[] }>(
      `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(row.id)}`,
      session.token,
    );
    const matchingVersion = history.versions.find((version) => sha256(version.prompt) === promptSha);
    assert.ok(matchingVersion, `${row.name} 当前Prompt未在后台历史中找到`);

    const agentFile = `agents/${row.id}.json`;
    const historyFile = `agents/${row.id}.prompt-history.json`;
    await writeFile(path.join(backupDir, agentFile), `${JSON.stringify(row, null, 2)}\n`, "utf8");
    await writeFile(path.join(backupDir, historyFile), `${JSON.stringify(history, null, 2)}\n`, "utf8");
    manifestAgents.push({
      ...target,
      source_updated_at: row.updated_at,
      prompt_chars: row.system_prompt.length,
      prompt_sha256: promptSha,
      local_agent_file: agentFile,
      local_history_file: historyFile,
      backend_backup_request: versionBackup.skipped ? "already_latest" : "created",
      backend_history_id: matchingVersion.id,
      backend_history_created_at: new Date(matchingVersion.ts).toISOString(),
      backend_history_count: history.versions.length,
    });
  }

  const recovery = [
    "# 语义泛化 vNext 修改前恢复说明",
    "",
    "优先恢复方式：在三张智能体后台的 Prompt 历史中，按 manifest.json 记录的 backend_history_id 选择对应版本并恢复。",
    "",
    "本地恢复方式：读取 agents/<agent-id>.json，将其中 system_prompt、preset_fields、output_style、guide_message 通过管理员 PUT /api/admin/agents 写回。",
    "",
    "恢复后重新 GET /api/admin/agents，核对 Prompt SHA256 必须与 manifest.json 一致。",
    "",
    "本备份仅含白名单智能体配置与 Prompt 历史，不含 API Key、渠道密钥、用户数据或支付数据。",
    "",
  ].join("\n");
  await writeFile(path.join(backupDir, "恢复说明.md"), recovery, "utf8");

  const manifest = {
    schema_version: "storyboard_director_local_backup.v2",
    backup_id: backupId,
    purpose: requestedMode ? `${requestedMode}线上Prompt修改前单卡备份` : "语义泛化vNext线上Prompt修改前备份",
    created_at: new Date().toISOString(),
    source: "Supabase safe-column snapshot + platform prompt history",
    contains_secrets: false,
    contains_user_data: false,
    agents: manifestAgents,
    rollback: {
      preferred: "admin prompt history by backend_history_id",
      local: "PUT backed-up system_prompt, preset_fields, output_style and guide_message, then verify SHA256",
    },
  };
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const verified = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8")) as typeof manifest;
  assert.equal(verified.agents.length, selectedTargets.length);
  console.log(JSON.stringify({ passed: true, backupDir, agents: manifestAgents }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
