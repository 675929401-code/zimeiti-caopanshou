import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { configurationSourceStatus } from "../src/storage/database/configuration-source";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import {
  HIGH_ENERGY_OUTPUT_BUDGET,
  STORY_DIRECTOR_PROMPT_QUALITY_BASELINE,
  STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE,
  buildHighEnergyPromptQualityCandidate,
  buildMoviePromptQualityCandidate,
  sha256,
} from "./story-director-prompt-quality-candidates";

type DbClient = ReturnType<typeof getSupabaseAdminClient>;
type SourceLabel = "shared-cloud" | "local-acceptance";
type AgentRow = {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: Array<Record<string, unknown>>;
  model: string | null;
  model_id: string | null;
  source: string;
  is_active: boolean;
  deleted_at: string | null;
  updated_at: string;
  max_reply_tokens: number | null;
};
type SourceState = {
  label: SourceLabel;
  movie: AgentRow;
  highEnergy: AgentRow;
  movieHistory: PromptVersion[];
  highEnergyHistory: PromptVersion[];
};
type PromptVersion = { prompt: string; created_at: string };
type HistoricalAudit = {
  agents: Array<{
    mode: "movie" | "high_energy";
    id: string;
    latestConversation: {
      messages: Array<{ role: string; content: string }>;
      assistantMetrics: {
        characters: number;
        textCodeBlocks: number;
        overtimeFlags: number;
        directorDraftFlags: number;
        redBlackMentions: number;
        goldMentions: number;
      };
    };
  }>;
};

const AGENT_COLUMNS = "id,name,system_prompt,preset_fields,model,model_id,source,is_active,deleted_at,updated_at,max_reply_tokens";
const evidencePath = resolve(".codex-evidence/story-director-intake-template-20260928/latest-output-quality-audit.json");
const moviePromptPath = resolve("prompts/storyboard-voiceover-cinematic-v4.3.2.md");

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function jsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

async function localDatabaseClient(): Promise<DbClient> {
  const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    serviceRoleKey?: string;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "本地验收数据库地址异常");
  assert.ok(runtime.serviceRoleKey, "本地验收数据库缺少 service role");
  return createClient(runtime.supabaseUrl, runtime.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as DbClient;
}

async function readSource(db: DbClient, label: SourceLabel): Promise<SourceState> {
  const ids = [STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.id, STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.id];
  const [{ data: agents, error: agentError }, movieHistory, highEnergyHistory] = await Promise.all([
    db.from("agents").select(AGENT_COLUMNS).in("id", ids),
    db.from("prompt_versions").select("prompt,created_at").eq("agent_id", ids[0]).order("created_at", { ascending: true }),
    db.from("prompt_versions").select("prompt,created_at").eq("agent_id", ids[1]).order("created_at", { ascending: true }),
  ]);
  assert.ifError(agentError);
  assert.ifError(movieHistory.error);
  assert.ifError(highEnergyHistory.error);
  const rows = (agents || []) as AgentRow[];
  const movie = rows.find((row) => row.id === ids[0]);
  const highEnergy = rows.find((row) => row.id === ids[1]);
  assert.ok(movie, `${label}缺少电影叙事版`);
  assert.ok(highEnergy, `${label}缺少高能版`);
  return {
    label,
    movie,
    highEnergy,
    movieHistory: (movieHistory.data || []) as PromptVersion[],
    highEnergyHistory: (highEnergyHistory.data || []) as PromptVersion[],
  };
}

function assertSourceActivated(state: SourceState): void {
  const pairs = [
    {
      row: state.movie,
      expected: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie,
      candidateSha256: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.moviePromptSha256,
      history: state.movieHistory,
    },
    {
      row: state.highEnergy,
      expected: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy,
      candidateSha256: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.highEnergyPromptSha256,
      history: state.highEnergyHistory,
    },
  ];
  for (const { row, expected, candidateSha256, history } of pairs) {
    assert.equal(row.id, expected.id, `${state.label}稳定ID漂移`);
    assert.equal(row.name, expected.name, `${state.label}${expected.name}名称漂移`);
    assert.equal(sha256(row.system_prompt), candidateSha256, `${state.label}${expected.name}候选Prompt未激活或已漂移`);
    assert.equal(row.deleted_at, null, `${state.label}${expected.name}已删除`);
    assert.equal(row.is_active, true, `${state.label}${expected.name}不是启用状态`);
    assert.ok(row.model, `${state.label}${expected.name}缺少模型名`);
    assert.ok(row.model_id, `${state.label}${expected.name}缺少模型绑定`);
    const historyShas = history.map((item) => sha256(item.prompt));
    assert.ok(historyShas.includes(expected.promptSha256), `${state.label}${expected.name}缺少基线回滚点`);
    assert.ok(historyShas.includes(candidateSha256), `${state.label}${expected.name}缺少候选审计历史`);
    assert.equal(historyShas.at(-1), candidateSha256, `${state.label}${expected.name}最新历史未对齐候选`);
  }
}

function promptFromHistory(history: PromptVersion[], promptSha256: string, label: string): string {
  const version = history.find((item) => sha256(item.prompt) === promptSha256);
  assert.ok(version, `${label}历史缺少Prompt ${promptSha256}`);
  return version.prompt;
}

function assertSourcesAligned(shared: SourceState, local: SourceState): void {
  for (const key of ["movie", "highEnergy"] as const) {
    const sharedAgent = shared[key];
    const localAgent = local[key];
    assert.equal(sha256(localAgent.system_prompt), sha256(sharedAgent.system_prompt), `${key}双源Prompt不一致`);
    assert.equal(jsonSha256(localAgent.preset_fields), jsonSha256(sharedAgent.preset_fields), `${key}双源接收卡不一致`);
    assert.equal(localAgent.model, sharedAgent.model, `${key}双源模型名不一致`);
    assert.equal(localAgent.model_id, sharedAgent.model_id, `${key}双源模型绑定不一致`);
    assert.equal(localAgent.max_reply_tokens, sharedAgent.max_reply_tokens, `${key}双源回复上限不一致`);
  }
}

function assistantOutput(agent: HistoricalAudit["agents"][number]): string {
  const message = agent.latestConversation.messages.findLast((item) => item.role === "assistant");
  assert.ok(message?.content, `${agent.mode}历史样本缺少助手输出`);
  return message.content;
}

export function collectMovieOvertimeGateIssues(output: string, overtimeSegmentNumbers: number[]): string[] {
  const issues: string[] = [];
  const firstLine = output.trimStart().split(/\r?\n/u)[0]?.trim() || "";
  if (firstLine !== "生成门禁：口播超时，请先压缩或重新分段") {
    issues.push("首行不是严格口播超时门禁");
  }
  for (const segmentNumber of overtimeSegmentNumbers) {
    if (!new RegExp(`第\\s*${segmentNumber}\\s*段`, "u").test(output)) {
      issues.push(`缺少第${segmentNumber}段超时明细`);
    }
  }
  const forbiddenPatterns = [
    /```/u,
    /故事板分镜|生图\s*Prompt/iu,
    /图生视频\s*Prompt|视频提示词/iu,
    /导演草案/u,
    /仍可.*生成/u,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(output))) {
    issues.push("超时门禁后仍包含导演草案或可提交Prompt");
  }
  return issues;
}

type HighEnergySegmentMetrics = {
  number: number;
  videoChars: number;
  imageChars: number;
  combinedChars: number;
  redBlackMentions: number;
  solutionColorMentions: number;
};

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function highEnergySegmentMetrics(output: string): HighEnergySegmentMetrics[] {
  // Both heading forms are part of the stable public surface. Historical
  // outputs used `## 分段 N`, while the current prompt also permits the
  // equivalent bold label `**分段 N**：`.
  const heading = /^(?:##\s*)?(?:\*\*)?分段\s+(\d+)[^\r\n]*?(?:\*\*)?：?\s*$/gmu;
  const matches = [...output.matchAll(heading)];
  return matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = matches[index + 1]?.index ?? output.length;
    const chunk = output.slice(start, end);
    const video = chunk.match(/\*\*视频提示词\*\*：?\s*```text\s*([\s\S]*?)```/iu)?.[1]?.trim() || "";
    const image = chunk.match(/\*\*生图提示词\*\*：?\s*```text\s*([\s\S]*?)```/iu)?.[1]?.trim() || "";
    return {
      number: Number(match[1]),
      videoChars: video.length,
      imageChars: image.length,
      combinedChars: video.length + image.length,
      redBlackMentions: countMatches(chunk, /红黑|黑红/gu),
      solutionColorMentions: countMatches(chunk, /金色|鎏金|黄金/gu),
    };
  });
}

export function collectHighEnergyOutputIssues(
  output: string,
  expectedSegments: number,
  durationSeconds: keyof typeof HIGH_ENERGY_OUTPUT_BUDGET,
): { issues: string[]; segments: HighEnergySegmentMetrics[] } {
  const issues: string[] = [];
  const budget = HIGH_ENERGY_OUTPUT_BUDGET[durationSeconds];
  const segments = highEnergySegmentMetrics(output);
  if (segments.length !== expectedSegments) {
    issues.push(`段落数异常：${segments.length}/${expectedSegments}`);
  }
  for (const segment of segments) {
    if (!segment.videoChars || !segment.imageChars) issues.push(`第${segment.number}段双Prompt不完整`);
    if (segment.videoChars > budget.videoMax) issues.push(`第${segment.number}段视频Prompt超预算：${segment.videoChars}/${budget.videoMax}`);
    if (segment.imageChars > budget.imageMax) issues.push(`第${segment.number}段生图Prompt超预算：${segment.imageChars}/${budget.imageMax}`);
    if (segment.combinedChars > budget.combinedMax) issues.push(`第${segment.number}段双Prompt超预算：${segment.combinedChars}/${budget.combinedMax}`);
  }
  const solutionColorSegments = segments.filter((segment) => segment.solutionColorMentions > 0).length;
  const sameColorFamilyLimit = Math.floor(expectedSegments / 2);
  if (solutionColorSegments > sameColorFamilyLimit) {
    issues.push(`解决色母题覆盖${solutionColorSegments}/${expectedSegments}段，超过${sameColorFamilyLimit}段上限`);
  }
  const adjacentRepeatedPairs = segments.slice(1).filter((segment, index) => {
    const previous = segments[index];
    return segment.redBlackMentions > 0 && segment.solutionColorMentions > 0
      && previous.redBlackMentions > 0 && previous.solutionColorMentions > 0;
  }).length;
  if (adjacentRepeatedPairs > 0) issues.push(`相邻段重复冲突色到解决色母题${adjacentRepeatedPairs}次`);
  return { issues, segments };
}

function syntheticHighEnergyOutput(segmentCount: number): string {
  return Array.from({ length: segmentCount }, (_, index) => {
    const number = index + 1;
    const video = `参考图绑定。0-5秒，女主人侧身停步，牵引绳由绷紧回松，柯基后撤半步并转开视线；镜头短推后稳定。5-10秒，主人放低手掌并留出通道，柯基沿地面空隙离开，爪声渐远，落在安全距离。段落${number}结束状态清楚。`;
    const image = `16:9四格3D故事板。固定女主人、三色柯基和客厅入口。第1格中景建立人物、狗与牵引绳；第2格柯基后撤、耳朵后贴，主人停手；第3格侧面显示绳索回松与通道打开；第4格狗移到安全距离，主人侧身等待。每格动作、道具状态和机位不同，主体完整，短中文牌为0，材质与光线连续。段落${number}只使用现实道具和身体反应。`;
    return `## 分段 ${number}（分段文案）：\n【测试段${number}】\n\n**视频提示词**：\n\`\`\`text\n${video}\n\`\`\`\n\n**生图提示词**：\n\`\`\`text\n${image}\n\`\`\``;
  }).join("\n\n");
}

async function main(): Promise<void> {
  const source = configurationSourceStatus();
  assert.ok(
    ["cloud", "shared-cloud"].includes(source.configuration),
    `当前智能体配置源不是云端共享配置：${source.configuration}`,
  );

  const [shared, local, moviePromptFile, auditText] = await Promise.all([
    readSource(getSupabaseAdminClient(), "shared-cloud"),
    localDatabaseClient().then((client) => readSource(client, "local-acceptance")),
    readFile(moviePromptPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]);
  assertSourceActivated(shared);
  assertSourceActivated(local);
  assertSourcesAligned(shared, local);
  assert.equal(
    sha256(moviePromptFile.trimEnd()),
    STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.promptSha256,
    "电影叙事基线文件与数据库不一致",
  );

  const movieBaseline = moviePromptFile.trimEnd();
  const highEnergyBaseline = promptFromHistory(
    shared.highEnergyHistory,
    STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.promptSha256,
    "shared-cloud/highEnergy",
  );
  const movieCandidate = buildMoviePromptQualityCandidate(movieBaseline);
  const highEnergyCandidate = buildHighEnergyPromptQualityCandidate(highEnergyBaseline);
  assert.equal(sha256(movieCandidate), sha256(shared.movie.system_prompt), "电影叙事已激活Prompt与候选构建结果不一致");
  assert.equal(sha256(highEnergyCandidate), sha256(shared.highEnergy.system_prompt), "高能版已激活Prompt与候选构建结果不一致");
  assert.ok(
    highEnergyCandidate.length <= highEnergyBaseline.length + 2_000,
    "高能候选为输出减法引入了过多系统Prompt负载",
  );

  const audit = JSON.parse(auditText) as HistoricalAudit;
  const historicalMovie = audit.agents.find((agent) => agent.mode === "movie");
  const historicalHighEnergy = audit.agents.find((agent) => agent.mode === "high_energy");
  assert.ok(historicalMovie && historicalHighEnergy, "历史质量审计缺少两卡样本");
  assert.equal(historicalMovie.latestConversation.assistantMetrics.overtimeFlags, 8, "电影历史负样本超时标记漂移");
  assert.equal(historicalMovie.latestConversation.assistantMetrics.directorDraftFlags, 8, "电影历史负样本导演草案标记漂移");
  const movieNegativeIssues = collectMovieOvertimeGateIssues(assistantOutput(historicalMovie), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(movieNegativeIssues.includes("超时门禁后仍包含导演草案或可提交Prompt"), "电影历史负样本没有触发门禁矛盾回归");
  const moviePositiveIssues = collectMovieOvertimeGateIssues(
    "生成门禁：口播超时，请先压缩或重新分段\n- 第2段：72个有效字 / 上限60字 / 建议压缩到60字以内\n- 第5段：68个有效字 / 上限60字 / 建议压缩到60字以内",
    [2, 5],
  );
  assert.deepEqual(moviePositiveIssues, [], "电影严格门禁正向夹具失败");

  const highEnergyNegative = collectHighEnergyOutputIssues(assistantOutput(historicalHighEnergy), 14, 10);
  assert.ok(highEnergyNegative.issues.some((issue) => issue.startsWith("解决色母题覆盖14/14段")), "高能历史负样本没有触发母题重复回归");
  assert.ok(highEnergyNegative.issues.some((issue) => issue.includes("Prompt超预算")), "高能历史负样本没有触发长度回归");
  const highEnergyPositive = collectHighEnergyOutputIssues(syntheticHighEnergyOutput(14), 14, 10);
  assert.deepEqual(highEnergyPositive.issues, [], "高能审计器正向夹具失败");

  const immutableFields = {
    movie: {
      id: shared.movie.id,
      name: shared.movie.name,
      presetSha256: jsonSha256(shared.movie.preset_fields),
      model: shared.movie.model,
      modelId: shared.movie.model_id,
      source: shared.movie.source,
      maxReplyTokens: shared.movie.max_reply_tokens,
    },
    highEnergy: {
      id: shared.highEnergy.id,
      name: shared.highEnergy.name,
      presetSha256: jsonSha256(shared.highEnergy.preset_fields),
      model: shared.highEnergy.model,
      modelId: shared.highEnergy.model_id,
      source: shared.highEnergy.source,
      maxReplyTokens: shared.highEnergy.max_reply_tokens,
    },
  };

  console.log(JSON.stringify({
    passed: true,
    activation: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.activation,
    requiredGate: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.requiredGate,
    candidates: {
      movie: {
        version: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.movieVersion,
        baseSha256: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.promptSha256,
        candidateSha256: sha256(movieCandidate),
        baseCharacters: movieBaseline.length,
        candidateCharacters: movieCandidate.length,
        historicalNegativeIssues: movieNegativeIssues,
      },
      highEnergy: {
        version: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.highEnergyVersion,
        baseSha256: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.promptSha256,
        candidateSha256: sha256(highEnergyCandidate),
        baseCharacters: highEnergyBaseline.length,
        candidateCharacters: highEnergyCandidate.length,
        historicalNegativeIssueCount: highEnergyNegative.issues.length,
        historicalNegativeIssues: highEnergyNegative.issues,
        budget: HIGH_ENERGY_OUTPUT_BUDGET,
      },
    },
    immutableFields,
    sources: [shared.label, local.label],
    stablePromptWrites: 0,
    modelRequests: 0,
    mediaRequests: 0,
    billingWrites: 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
