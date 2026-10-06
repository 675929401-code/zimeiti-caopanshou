import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { LLMProxy } from "../src/lib/llm-proxy/proxy";
import { resolveProviderSecret } from "../src/lib/provider-secret";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import {
  STORY_DIRECTOR_PROMPT_QUALITY_BASELINE,
  buildHighEnergyPromptQualityCandidate,
  buildMoviePromptQualityCandidate,
  sha256,
} from "./story-director-prompt-quality-candidates";
import {
  collectHighEnergyOutputIssues,
  collectMovieOvertimeGateIssues,
} from "./verify-story-director-prompt-quality-candidates";

type AgentRow = {
  id: string;
  name: string;
  model: string;
  model_id: string;
  system_prompt: string;
  temperature: number | null;
  deep_thinking_type: number | null;
  is_active: boolean;
  deleted_at: string | null;
};

type ModelRow = {
  id: string;
  name: string;
  model_name: string;
  api_endpoint: string;
  api_key: string;
  is_active: boolean;
  is_hidden: boolean;
  deep_thinking_type: number | null;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  cached_cost_per_million: number | null;
};

type HistoricalAudit = {
  agents: Array<{
    mode: "movie" | "high_energy";
    latestConversation: {
      messages: Array<{ role: string; content: string }>;
    };
  }>;
};

type CanarySpec = {
  mode: "movie" | "high_energy";
  agent: AgentRow;
  candidate: string;
  userInput: string;
  maxTokens: number;
  fixture: "historical" | "synthetic-overtime-derived-from-historical";
};

type CanaryResult = {
  mode: CanarySpec["mode"];
  passed: boolean;
  candidateSha256: string;
  inputSha256: string;
  outputSha256: string;
  outputCharacters: number;
  elapsedMs: number;
  usage: { prompt_tokens: number; completion_tokens: number; cached_tokens: number } | null;
  configuredCostEstimateCny: number | null;
  issues: string[];
  outputFile: string;
  error?: string;
  fixture: CanarySpec["fixture"];
};

const runId = String(process.env.STORY_DIRECTOR_CANARY_RUN_ID || new Date().toISOString().replace(/[:.]/gu, "-")).trim();
assert.match(runId, /^[a-zA-Z0-9_-]{3,80}$/u, "CANARY_RUN_ID_INVALID");
const evidenceDir = resolve(".codex-evidence/story-director-prompt-quality-20260929/canary", runId);
const historicalAuditPath = resolve(".codex-evidence/story-director-intake-template-20260928/latest-output-quality-audit.json");
const configuredBudgetCny = Number(process.env.STORY_DIRECTOR_CANARY_MAX_COST_CNY || "0.50");
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const roundMoney = (value: number): number => Number(value.toFixed(6));

function configuredCost(
  usage: CanaryResult["usage"],
  model: ModelRow,
): number | null {
  if (!usage) return null;
  const inputRate = Number(model.input_cost_per_million || 0);
  const outputRate = Number(model.output_cost_per_million || 0);
  const cachedRate = Number(model.cached_cost_per_million || inputRate);
  const cachedTokens = Math.min(usage.cached_tokens, usage.prompt_tokens);
  const uncachedTokens = Math.max(0, usage.prompt_tokens - cachedTokens);
  return roundMoney(
    (uncachedTokens * inputRate + cachedTokens * cachedRate + usage.completion_tokens * outputRate) / 1_000_000,
  );
}

function conservativeMaximumCost(specs: CanarySpec[], model: ModelRow): number {
  const inputRate = Number(model.input_cost_per_million || 0);
  const outputRate = Number(model.output_cost_per_million || 0);
  return roundMoney(specs.reduce((total, spec) => {
    // Chinese text is conservatively budgeted at 1.5 tokens per character.
    const inputTokens = Math.ceil((spec.candidate.length + spec.userInput.length) * 1.5);
    return total + (inputTokens * inputRate + spec.maxTokens * outputRate) / 1_000_000;
  }, 0));
}

function latestUserInput(audit: HistoricalAudit, mode: CanarySpec["mode"]): string {
  const agent = audit.agents.find((item) => item.mode === mode);
  const message = agent?.latestConversation.messages.findLast((item) => item.role === "user");
  assert.ok(message?.content, `${mode}缺少真实历史输入`);
  return message.content;
}

function movieOvertimeInput(audit: HistoricalAudit): string {
  const historical = latestUserInput(audit, "movie");
  return historical.split(/\r?\n/u).map((line) =>
    /^\s*\d{1,3}\s*[.、].*】\s*$/u.test(line)
      ? line.replace(/】\s*$/u, "这段补充文字用于验证确定性口播超时门禁必须在调用模型之前立即停止】")
      : line,
  ).join("\n");
}

async function runCanary(proxy: LLMProxy, model: ModelRow, spec: CanarySpec): Promise<CanaryResult> {
  const outputFile = resolve(evidenceDir, `${spec.mode}-candidate-output.md`);
  const startedAt = Date.now();
  try {
    const response = await proxy.chat({
      model: model.model_name,
      messages: [
        { role: "system", content: spec.candidate },
        { role: "user", content: spec.userInput },
      ],
      max_tokens: spec.maxTokens,
      temperature: spec.agent.temperature ?? 0.2,
      enable_thinking: (model.deep_thinking_type ?? spec.agent.deep_thinking_type) === 2,
    });
    const output = response.content.trim();
    await writeFile(outputFile, `${output}\n`, "utf8");
    const audit = spec.mode === "movie"
      ? { issues: collectMovieOvertimeGateIssues(output, [1, 2, 3, 4, 5, 6, 7, 8]) }
      : collectHighEnergyOutputIssues(output, 14, 10);
    return {
      mode: spec.mode,
      passed: audit.issues.length === 0,
      candidateSha256: sha256(spec.candidate),
      inputSha256: sha(spec.userInput),
      outputSha256: sha(output),
      outputCharacters: output.length,
      elapsedMs: Date.now() - startedAt,
      usage: response.usage || null,
      configuredCostEstimateCny: configuredCost(response.usage || null, model),
      issues: audit.issues,
      outputFile,
      fixture: spec.fixture,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(outputFile, "", "utf8");
    return {
      mode: spec.mode,
      passed: false,
      candidateSha256: sha256(spec.candidate),
      inputSha256: sha(spec.userInput),
      outputSha256: sha(""),
      outputCharacters: 0,
      elapsedMs: Date.now() - startedAt,
      usage: null,
      configuredCostEstimateCny: null,
      issues: ["真实模型调用未完成"],
      outputFile,
      fixture: spec.fixture,
      error: message.slice(0, 500),
    };
  }
}

async function main(): Promise<void> {
  assert.ok(Number.isFinite(configuredBudgetCny) && configuredBudgetCny > 0 && configuredBudgetCny <= 1, "CANARY_BUDGET_MUST_BE_WITHIN_1_CNY");
  const db = getSupabaseAdminClient();
  const ids = [STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.id, STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.id];
  const [{ data: rows, error: agentsError }, auditText] = await Promise.all([
    db.from("agents")
      .select("id,name,model,model_id,system_prompt,temperature,deep_thinking_type,is_active,deleted_at")
      .in("id", ids),
    readFile(historicalAuditPath, "utf8"),
  ]);
  assert.ifError(agentsError);
  assert.equal(rows?.length, 2, "双导演配置不完整");
  const agents = rows as AgentRow[];
  const movie = agents.find((row) => row.id === ids[0]);
  const highEnergy = agents.find((row) => row.id === ids[1]);
  assert.ok(movie && highEnergy, "双导演配置读取失败");
  assert.equal(sha256(movie.system_prompt), STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.promptSha256, "电影版稳定Prompt已漂移");
  assert.equal(sha256(highEnergy.system_prompt), STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.promptSha256, "高能版稳定Prompt已漂移");
  assert.equal(movie.model_id, highEnergy.model_id, "双导演模型绑定不一致");
  assert.ok(movie.is_active && highEnergy.is_active && !movie.deleted_at && !highEnergy.deleted_at, "双导演不是稳定启用状态");

  const { data: modelData, error: modelError } = await db.from("llm_models")
    .select("id,name,model_name,api_endpoint,api_key,is_active,is_hidden,deep_thinking_type,input_cost_per_million,output_cost_per_million,cached_cost_per_million")
    .eq("id", movie.model_id)
    .single();
  assert.ifError(modelError);
  const model = modelData as ModelRow;
  assert.equal(model.id, movie.model_id, "模型绑定读回不一致");
  assert.equal(model.model_name, movie.model, "模型名称与绑定不一致");
  assert.ok(model.is_active && !model.is_hidden, "绑定模型未公开启用");
  const endpoint = new URL(model.api_endpoint);
  assert.equal(endpoint.protocol, "https:", "真实canary只允许HTTPS模型端点");
  const apiKey = resolveProviderSecret(model.api_key).trim();
  assert.ok(apiKey.length >= 8, "模型密钥不可用");

  const historicalAudit = JSON.parse(auditText) as HistoricalAudit;
  const requestedModes = new Set(
    String(process.env.STORY_DIRECTOR_CANARY_MODES || "movie,high_energy")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  assert.ok(requestedModes.size > 0, "CANARY_MODE_REQUIRED");
  for (const mode of requestedModes) assert.ok(mode === "movie" || mode === "high_energy", `CANARY_MODE_INVALID:${mode}`);
  const allSpecs: CanarySpec[] = [
    {
      mode: "movie",
      agent: movie,
      candidate: buildMoviePromptQualityCandidate(movie.system_prompt),
      userInput: movieOvertimeInput(historicalAudit),
      maxTokens: 2_500,
      fixture: "synthetic-overtime-derived-from-historical",
    },
    {
      mode: "high_energy",
      agent: highEnergy,
      candidate: buildHighEnergyPromptQualityCandidate(highEnergy.system_prompt),
      userInput: latestUserInput(historicalAudit, "high_energy"),
      maxTokens: 32_768,
      fixture: "historical",
    },
  ];
  const specs = allSpecs.filter((spec) => requestedModes.has(spec.mode));
  const maximumConfiguredCostCny = conservativeMaximumCost(specs, model);
  assert.ok(maximumConfiguredCostCny <= configuredBudgetCny, `CANARY_MAX_COST_${maximumConfiguredCostCny}_EXCEEDS_${configuredBudgetCny}`);

  await mkdir(evidenceDir, { recursive: true });
  const proxy = new LLMProxy({
    apiBase: model.api_endpoint,
    apiKey,
    defaultModel: model.model_name,
    timeout: 720,
    stream: false,
    includeUsage: true,
    keepAlive: true,
    retryCount: 0,
    retryDelay: 0,
  });
  const results: CanaryResult[] = [];
  for (const spec of specs) results.push(await runCanary(proxy, model, spec));
  const configuredCostEstimateCny = roundMoney(results.reduce((sum, item) => sum + (item.configuredCostEstimateCny || 0), 0));
  const report = {
    schemaVersion: 1,
    task: "STORY-DIRECTOR-PROMPT-ACTIVATION-R562",
    runId,
    generatedAt: new Date().toISOString(),
    passed: results.every((item) => item.passed),
    isolation: "candidate-system-prompts-directly-through-production-llm-proxy",
    provider: {
      endpointHost: endpoint.hostname,
      modelId: model.id,
      modelName: model.model_name,
      credentialPrinted: false,
    },
    billing: {
      requestCount: results.length,
      retryCount: 0,
      configuredBudgetCny,
      maximumConfiguredCostCny,
      configuredCostEstimateCny,
      databaseBillingWrites: 0,
    },
    stablePromptWrites: 0,
    results,
  };
  await writeFile(resolve(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.passed, "STORY_DIRECTOR_PROMPT_CANARY_FAILED");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
