import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { configurationSourceStatus } from "../src/storage/database/configuration-source";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import {
  STORY_DIRECTOR_PROMPT_QUALITY_BASELINE,
  STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE,
  buildHighEnergyPromptQualityCandidate,
  buildMoviePromptQualityCandidate,
  sha256,
} from "./story-director-prompt-quality-candidates";

type DbClient = ReturnType<typeof getSupabaseAdminClient>;
type SourceLabel = "local-acceptance" | "shared-cloud";
type AgentKey = "movie" | "highEnergy";
type JsonRecord = Record<string, unknown>;

type AgentRow = JsonRecord & {
  id: string;
  name: string;
  system_prompt: string;
  updated_at: string;
  is_active?: boolean;
  deleted_at?: string | null;
};

type PromptVersion = {
  id: string;
  agent_id: string;
  prompt: string;
  created_at: string;
};

type SourceState = {
  label: SourceLabel;
  agents: Record<AgentKey, AgentRow>;
  history: Record<AgentKey, PromptVersion[]>;
};

type CandidateSet = Record<AgentKey, string>;

type AppliedMutation = {
  db: DbClient;
  label: SourceLabel;
  key: AgentKey;
  agentId: string;
  baselinePrompt: string;
  candidatePrompt: string;
  beforeUpdatedAt: string;
  activatedUpdatedAt: string;
};

const targets = {
  movie: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie,
  highEnergy: STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy,
} as const;

const expectedCandidateShas: Record<AgentKey, string> = {
  movie: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.moviePromptSha256,
  highEnergy: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE.highEnergyPromptSha256,
};

const canaryReportPath = resolve(
  ".codex-evidence/story-director-prompt-quality-20260929/canary/2026-09-30T21-38-33-201Z/report.json",
);
const evidenceRoot = resolve(".codex-evidence/story-director-prompt-quality-20260929");
const backupRoot = resolve("backups/story-director-prompt-quality-activation-20261001");
const safeAgentColumns = [
  "id",
  "name",
  "description",
  "guide_message",
  "system_prompt",
  "preset_fields",
  "model",
  "model_id",
  "source",
  "is_active",
  "deleted_at",
  "updated_at",
  "max_reply_tokens",
  "response_format",
  "user_access",
  "category",
  "output_style",
  "temperature",
  "deep_thinking_type",
].join(",");

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const sameInstant = (left: string, right: string): boolean => {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

function immutableAgentView(row: AgentRow): JsonRecord {
  const copy: JsonRecord = { ...row };
  delete copy.system_prompt;
  delete copy.updated_at;
  return copy;
}

function latestPromptSha(history: PromptVersion[]): string {
  return sha256(history.at(-1)?.prompt || "");
}

function findPrompt(history: PromptVersion[], promptSha: string, label: string): string {
  const version = history.find((item) => sha256(item.prompt) === promptSha);
  assert.ok(version, `${label}历史中缺少提示词 ${promptSha}`);
  return version.prompt;
}

async function localDatabaseClient(): Promise<DbClient> {
  const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    serviceRoleKey?: string;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "本地验收数据库地址异常，停止执行");
  assert.ok(runtime.serviceRoleKey, "本地验收数据库缺少service role，停止执行");
  return createClient(runtime.supabaseUrl, runtime.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as DbClient;
}

async function readSource(db: DbClient, label: SourceLabel): Promise<SourceState> {
  const ids = [targets.movie.id, targets.highEnergy.id];
  const [{ data: agentData, error: agentError }, { data: historyData, error: historyError }] = await Promise.all([
    db.from("agents").select(safeAgentColumns).in("id", ids),
    db.from("prompt_versions")
      .select("id,agent_id,prompt,created_at")
      .in("agent_id", ids)
      .order("created_at", { ascending: true }),
  ]);
  assert.ifError(agentError);
  assert.ifError(historyError);
  const rows = (agentData || []) as AgentRow[];
  assert.equal(rows.length, 2, `${label}双导演配置不完整`);
  const movie = rows.find((row) => row.id === targets.movie.id);
  const highEnergy = rows.find((row) => row.id === targets.highEnergy.id);
  assert.ok(movie && highEnergy, `${label}双导演配置读取失败`);
  const history = (historyData || []) as PromptVersion[];
  return {
    label,
    agents: { movie, highEnergy },
    history: {
      movie: history.filter((item) => item.agent_id === targets.movie.id),
      highEnergy: history.filter((item) => item.agent_id === targets.highEnergy.id),
    },
  };
}

function assertSourceIdentity(state: SourceState): CandidateSet {
  const baselines = {} as CandidateSet;
  for (const key of ["movie", "highEnergy"] as const) {
    const target = targets[key];
    const row = state.agents[key];
    const history = state.history[key];
    assert.equal(row.id, target.id, `${state.label}/${key} ID异常`);
    assert.equal(row.name, target.name, `${state.label}/${key}名称异常`);
    assert.equal(row.deleted_at ?? null, null, `${state.label}/${key}已删除`);
    assert.equal(row.is_active, true, `${state.label}/${key}未启用`);
    assert.ok(row.updated_at, `${state.label}/${key}缺少updated_at，无法CAS`);
    assert.ok(history.length > 0, `${state.label}/${key}缺少Prompt历史`);
    const baseline = findPrompt(history, target.promptSha256, `${state.label}/${key}`);
    baselines[key] = baseline;
    const currentSha = sha256(row.system_prompt);
    assert.ok(
      currentSha === target.promptSha256 || currentSha === expectedCandidateShas[key],
      `${state.label}/${key}当前Prompt已漂移:${currentSha}`,
    );
    assert.equal(latestPromptSha(history), currentSha, `${state.label}/${key}最新Prompt历史与当前配置不一致`);
  }
  return baselines;
}

function buildCandidates(baselines: CandidateSet): CandidateSet {
  const candidates = {
    movie: buildMoviePromptQualityCandidate(baselines.movie),
    highEnergy: buildHighEnergyPromptQualityCandidate(baselines.highEnergy),
  };
  for (const key of ["movie", "highEnergy"] as const) {
    assert.equal(sha256(candidates[key]), expectedCandidateShas[key], `${key}候选SHA已漂移`);
  }
  return candidates;
}

function sourceActivationState(state: SourceState): "baseline" | "candidate" | "mixed" {
  const shas = (["movie", "highEnergy"] as const).map((key) => sha256(state.agents[key].system_prompt));
  if (shas.every((value, index) => value === targets[index === 0 ? "movie" : "highEnergy"].promptSha256)) return "baseline";
  if (shas.every((value, index) => value === expectedCandidateShas[index === 0 ? "movie" : "highEnergy"])) return "candidate";
  return "mixed";
}

async function verifyPassedCanary(candidates: CandidateSet): Promise<JsonRecord> {
  const raw = await readFile(canaryReportPath, "utf8");
  const report = JSON.parse(raw) as JsonRecord & {
    passed?: boolean;
    stablePromptWrites?: number;
    billing?: JsonRecord;
    results?: Array<JsonRecord>;
  };
  assert.equal(report.passed, true, "指定真实模型canary没有通过");
  assert.equal(report.stablePromptWrites, 0, "canary不应改写稳定Prompt");
  assert.equal(report.billing?.requestCount, 2, "canary请求数异常");
  assert.equal(report.billing?.retryCount, 0, "canary发生了重试");
  const results = report.results || [];
  assert.equal(results.length, 2, "canary结果数异常");
  for (const key of ["movie", "highEnergy"] as const) {
    const mode = key === "highEnergy" ? "high_energy" : "movie";
    const result = results.find((item) => item.mode === mode);
    assert.ok(result, `canary缺少${mode}结果`);
    assert.equal(result.passed, true, `${mode} canary未通过`);
    assert.equal(result.candidateSha256, sha256(candidates[key]), `${mode} canary候选SHA不匹配`);
    assert.deepEqual(result.issues, [], `${mode} canary仍有问题`);
    const outputPath = resolve(String(result.outputFile || ""));
    assert.ok(outputPath.startsWith(`${evidenceRoot}\\`) || outputPath.startsWith(`${evidenceRoot}/`), `${mode}输出证据越界`);
    const output = (await readFile(outputPath, "utf8")).trim();
    assert.equal(hash(output), result.outputSha256, `${mode}输出证据SHA不匹配`);
  }
  return {
    path: canaryReportPath,
    sha256: hash(raw),
    generatedAt: report.generatedAt,
    configuredCostEstimateCny: report.billing?.configuredCostEstimateCny,
  };
}

function assertSourcesAligned(local: SourceState, shared: SourceState): void {
  for (const key of ["movie", "highEnergy"] as const) {
    assert.ok(
      canonicalJson(immutableAgentView(local.agents[key])) === canonicalJson(immutableAgentView(shared.agents[key])),
      `${key}在local-acceptance与shared-cloud的非Prompt配置不一致`,
    );
  }
  const localState = sourceActivationState(local);
  const sharedState = sourceActivationState(shared);
  assert.notEqual(localState, "mixed", "local-acceptance处于部分激活状态，停止自动写入");
  assert.notEqual(sharedState, "mixed", "shared-cloud处于部分激活状态，停止自动写入");
  assert.equal(localState, sharedState, "双配置源激活状态不一致，停止自动写入");
}

async function writeSourceBackup(backupDir: string, state: SourceState): Promise<void> {
  await writeFile(
    resolve(backupDir, `${state.label}-before.json`),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), ...state }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function appendHistoryIfNeeded(
  db: DbClient,
  label: SourceLabel,
  key: AgentKey,
  prompt: string,
): Promise<{ inserted: boolean; latestSha256: string }> {
  const agentId = targets[key].id;
  const targetSha = sha256(prompt);
  const before = await readSource(db, label);
  const beforeLatestSha = latestPromptSha(before.history[key]);
  if (beforeLatestSha === targetSha) return { inserted: false, latestSha256: targetSha };

  let insertError: unknown = null;
  try {
    const { error } = await db.from("prompt_versions").insert({ agent_id: agentId, prompt });
    if (error) throw error;
  } catch (error) {
    insertError = error;
  }
  const after = await readSource(db, label);
  const afterLatestSha = latestPromptSha(after.history[key]);
  if (afterLatestSha !== targetSha) {
    const detail = insertError instanceof Error ? `:${insertError.message}` : "";
    throw new Error(`${label}/${key} Prompt历史追加失败${detail}`);
  }
  return { inserted: true, latestSha256: afterLatestSha };
}

async function activateOne(
  mutationLog: AppliedMutation[],
  db: DbClient,
  label: SourceLabel,
  key: AgentKey,
  before: AgentRow,
  baselinePrompt: string,
  candidatePrompt: string,
): Promise<JsonRecord> {
  const currentSha = sha256(before.system_prompt);
  if (currentSha === expectedCandidateShas[key]) {
    const history = await appendHistoryIfNeeded(db, label, key, candidatePrompt);
    return { key, outcome: "already-activated", updatedAt: before.updated_at, history };
  }
  assert.equal(currentSha, targets[key].promptSha256, `${label}/${key}不是预期基线`);
  const requestedUpdatedAt = new Date().toISOString();
  let updateError: unknown = null;
  try {
    const { data, error } = await db.from("agents")
      .update({ system_prompt: candidatePrompt, updated_at: requestedUpdatedAt })
      .eq("id", targets[key].id)
      .eq("updated_at", before.updated_at)
      .select(safeAgentColumns);
    if (error) throw error;
    assert.equal((data || []).length, 1, `${label}/${key} CAS未命中唯一记录`);
  } catch (error) {
    updateError = error;
  }

  const after = await readSource(db, label);
  const afterRow = after.agents[key];
  if (sha256(afterRow.system_prompt) !== expectedCandidateShas[key] || !sameInstant(afterRow.updated_at, requestedUpdatedAt)) {
    const detail = updateError instanceof Error ? `:${updateError.message}` : "";
    throw new Error(`${label}/${key} CAS激活未形成可确认目标状态${detail}`);
  }
  assert.ok(
    canonicalJson(immutableAgentView(afterRow)) === canonicalJson(immutableAgentView(before)),
    `${label}/${key}激活时意外修改了非Prompt字段`,
  );
  mutationLog.push({
    db,
    label,
    key,
    agentId: targets[key].id,
    baselinePrompt,
    candidatePrompt,
    beforeUpdatedAt: before.updated_at,
    activatedUpdatedAt: afterRow.updated_at,
  });
  const history = await appendHistoryIfNeeded(db, label, key, candidatePrompt);
  return {
    key,
    outcome: updateError ? "activated-readback-recovered" : "activated",
    beforeUpdatedAt: before.updated_at,
    afterUpdatedAt: afterRow.updated_at,
    beforeSha256: currentSha,
    afterSha256: sha256(afterRow.system_prompt),
    history,
  };
}

async function rollbackMutation(mutation: AppliedMutation): Promise<JsonRecord> {
  const requestedUpdatedAt = new Date().toISOString();
  const { data, error } = await mutation.db.from("agents")
    .update({ system_prompt: mutation.baselinePrompt, updated_at: requestedUpdatedAt })
    .eq("id", mutation.agentId)
    .eq("updated_at", mutation.activatedUpdatedAt)
    .select(safeAgentColumns);
  assert.ifError(error);
  assert.equal((data || []).length, 1, `${mutation.label}/${mutation.key}补偿回滚CAS失败`);
  const state = await readSource(mutation.db, mutation.label);
  const row = state.agents[mutation.key];
  assert.equal(sha256(row.system_prompt), targets[mutation.key].promptSha256, `${mutation.label}/${mutation.key}补偿回滚读回失败`);
  assert.ok(sameInstant(row.updated_at, requestedUpdatedAt), `${mutation.label}/${mutation.key}补偿回滚版本不一致`);
  const history = await appendHistoryIfNeeded(
    mutation.db,
    mutation.label,
    mutation.key,
    mutation.baselinePrompt,
  );
  return { label: mutation.label, key: mutation.key, outcome: "rolled-back", updatedAt: row.updated_at, history };
}

async function verifyActivatedSource(
  db: DbClient,
  label: SourceLabel,
  before: SourceState,
): Promise<JsonRecord> {
  const after = await readSource(db, label);
  for (const key of ["movie", "highEnergy"] as const) {
    assert.equal(sha256(after.agents[key].system_prompt), expectedCandidateShas[key], `${label}/${key}最终Prompt未激活`);
    assert.equal(latestPromptSha(after.history[key]), expectedCandidateShas[key], `${label}/${key}最新Prompt历史未对齐`);
    assert.ok(
      canonicalJson(immutableAgentView(after.agents[key])) === canonicalJson(immutableAgentView(before.agents[key])),
      `${label}/${key}非Prompt配置发生变化`,
    );
  }
  return {
    label,
    state: sourceActivationState(after),
    agents: Object.fromEntries((["movie", "highEnergy"] as const).map((key) => [key, {
      id: after.agents[key].id,
      name: after.agents[key].name,
      promptSha256: sha256(after.agents[key].system_prompt),
      updatedAt: after.agents[key].updated_at,
      promptHistoryCount: after.history[key].length,
      latestHistorySha256: latestPromptSha(after.history[key]),
    }])),
  };
}

async function recoverRecognizedLocalFirstFailure(
  localDb: DbClient,
  local: SourceState,
  shared: SourceState,
): Promise<JsonRecord> {
  assert.equal(sha256(local.agents.movie.system_prompt), expectedCandidateShas.movie, "本地电影版不是待恢复候选状态");
  assert.equal(sha256(local.agents.highEnergy.system_prompt), targets.highEnergy.promptSha256, "本地高能版已被修改，拒绝自动恢复");
  assert.equal(sha256(shared.agents.movie.system_prompt), targets.movie.promptSha256, "共享电影版已被修改，拒绝自动恢复");
  assert.equal(sha256(shared.agents.highEnergy.system_prompt), targets.highEnergy.promptSha256, "共享高能版已被修改，拒绝自动恢复");
  assert.equal(latestPromptSha(local.history.movie), targets.movie.promptSha256, "本地电影版历史不是已知失败前基线");
  assert.equal(latestPromptSha(local.history.highEnergy), targets.highEnergy.promptSha256, "本地高能版历史异常");
  assert.equal(latestPromptSha(shared.history.movie), targets.movie.promptSha256, "共享电影版历史异常");
  assert.equal(latestPromptSha(shared.history.highEnergy), targets.highEnergy.promptSha256, "共享高能版历史异常");
  const baselinePrompt = findPrompt(local.history.movie, targets.movie.promptSha256, "local-acceptance/movie恢复");
  const before = local.agents.movie;
  const requestedUpdatedAt = new Date().toISOString();
  const { data, error } = await localDb.from("agents")
    .update({ system_prompt: baselinePrompt, updated_at: requestedUpdatedAt })
    .eq("id", targets.movie.id)
    .eq("updated_at", before.updated_at)
    .select(safeAgentColumns);
  assert.ifError(error);
  assert.equal((data || []).length, 1, "本地电影版失败恢复CAS未命中唯一记录");
  const after = await readSource(localDb, "local-acceptance");
  assert.equal(sha256(after.agents.movie.system_prompt), targets.movie.promptSha256, "本地电影版失败恢复读回不一致");
  assert.ok(sameInstant(after.agents.movie.updated_at, requestedUpdatedAt), "本地电影版失败恢复版本时间不一致");
  assert.equal(latestPromptSha(after.history.movie), targets.movie.promptSha256, "本地电影版失败恢复后历史未对齐");
  assert.ok(
    canonicalJson(immutableAgentView(after.agents.movie)) === canonicalJson(immutableAgentView(before)),
    "本地电影版失败恢复意外修改非Prompt字段",
  );
  const report = {
    schemaVersion: 1,
    task: "STORY-DIRECTOR-PROMPT-ACTIVATION-R562",
    recoveredAt: new Date().toISOString(),
    outcome: "recognized-local-first-write-restored-to-baseline",
    source: "local-acceptance",
    agentId: targets.movie.id,
    beforeSha256: expectedCandidateShas.movie,
    afterSha256: targets.movie.promptSha256,
    beforeUpdatedAt: before.updated_at,
    afterUpdatedAt: after.agents.movie.updated_at,
    sharedWrites: 0,
    secretValuesPrinted: false,
  };
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const recoveryDir = resolve(evidenceRoot, `activation-recovery-${stamp}`);
  await mkdir(recoveryDir, { recursive: true });
  await writeFile(resolve(recoveryDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { ...report, recoveryDir };
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const confirmedSharedWrite = process.argv.includes("--confirm-shared-config-write");
  const includeLocal = process.argv.includes("--include-local");
  const recoverLocalFirstFailure = process.argv.includes("--recover-local-first-failure");
  const sharedDb = getSupabaseAdminClient();
  const sourceStatus = configurationSourceStatus();
  assert.equal(sourceStatus.configuration, "shared-cloud", "当前配置源不是shared-cloud，停止执行");
  const localDb = await localDatabaseClient();

  const [localBefore, sharedBefore] = await Promise.all([
    readSource(localDb, "local-acceptance"),
    readSource(sharedDb, "shared-cloud"),
  ]);
  if (recoverLocalFirstFailure) {
    assert.ok(execute && includeLocal, "失败恢复必须显式传入 --execute --include-local");
    const recovery = await recoverRecognizedLocalFirstFailure(localDb, localBefore, sharedBefore);
    console.log(JSON.stringify(recovery, null, 2));
    return;
  }
  const localBaselines = assertSourceIdentity(localBefore);
  const sharedBaselines = assertSourceIdentity(sharedBefore);
  assert.ok(canonicalJson(localBaselines) === canonicalJson(sharedBaselines), "双配置源基线Prompt正文不一致");
  assertSourcesAligned(localBefore, sharedBefore);
  const candidates = buildCandidates(sharedBaselines);
  const canary = await verifyPassedCanary(candidates);
  const initialState = sourceActivationState(sharedBefore);

  const preview = {
    schemaVersion: 1,
    task: "STORY-DIRECTOR-PROMPT-ACTIVATION-R562",
    execute,
    configurationSource: sourceStatus.configuration,
    initialState,
    candidateVersions: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE,
    candidates: Object.fromEntries((["movie", "highEnergy"] as const).map((key) => [key, {
      id: targets[key].id,
      name: targets[key].name,
      baselineSha256: targets[key].promptSha256,
      candidateSha256: sha256(candidates[key]),
      candidateCharacters: candidates[key].length,
    }])),
    canary,
    sharedWritesRequested: execute,
    localWritesRequested: execute,
    secretValuesPrinted: false,
  };

  if (!execute) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }
  assert.ok(confirmedSharedWrite, "激活必须显式传入 --confirm-shared-config-write");
  assert.ok(includeLocal, "激活必须显式传入 --include-local");
  if (initialState === "candidate") {
    const alreadyReport = {
      ...preview,
      completedAt: new Date().toISOString(),
      outcome: "already-activated",
      verification: await Promise.all([
        verifyActivatedSource(localDb, "local-acceptance", localBefore),
        verifyActivatedSource(sharedDb, "shared-cloud", sharedBefore),
      ]),
    };
    console.log(JSON.stringify(alreadyReport, null, 2));
    return;
  }
  assert.equal(initialState, "baseline", "只有完整基线状态允许开始激活");

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupDir = resolve(backupRoot, stamp);
  const activationEvidenceDir = resolve(evidenceRoot, `activation-${stamp}`);
  await Promise.all([mkdir(backupDir, { recursive: true }), mkdir(activationEvidenceDir, { recursive: true })]);
  await Promise.all([
    writeSourceBackup(backupDir, localBefore),
    writeSourceBackup(backupDir, sharedBefore),
    writeFile(resolve(backupDir, "candidate-prompts.json"), `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      versions: STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE,
      prompts: candidates,
      shas: expectedCandidateShas,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  ]);

  const mutationLog: AppliedMutation[] = [];
  const activations: JsonRecord[] = [];
  try {
    for (const source of [
      { db: localDb, label: "local-acceptance" as const, before: localBefore, baselines: localBaselines },
      { db: sharedDb, label: "shared-cloud" as const, before: sharedBefore, baselines: sharedBaselines },
    ]) {
      const sourceResults: JsonRecord[] = [];
      for (const key of ["movie", "highEnergy"] as const) {
        sourceResults.push(await activateOne(
          mutationLog,
          source.db,
          source.label,
          key,
          source.before.agents[key],
          source.baselines[key],
          candidates[key],
        ));
      }
      activations.push({ label: source.label, results: sourceResults });
    }
    const verification = await Promise.all([
      verifyActivatedSource(localDb, "local-acceptance", localBefore),
      verifyActivatedSource(sharedDb, "shared-cloud", sharedBefore),
    ]);
    const receipt = {
      ...preview,
      completedAt: new Date().toISOString(),
      outcome: "activated",
      backupDir,
      activationEvidenceDir,
      activations,
      verification,
      rollbackPolicy: "CAS-compensation-plus-append-only-baseline-history",
    };
    await writeFile(resolve(backupDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(resolve(activationEvidenceDir, "report.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    const rollbacks: JsonRecord[] = [];
    const rollbackErrors: Error[] = [];
    for (const mutation of [...mutationLog].reverse()) {
      try {
        rollbacks.push(await rollbackMutation(mutation));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
      }
    }
    const failure = {
      ...preview,
      failedAt: new Date().toISOString(),
      outcome: rollbackErrors.length === 0 ? "failed-and-rolled-back" : "failed-with-rollback-error",
      backupDir,
      activations,
      error: error instanceof Error ? error.stack || error.message : String(error),
      rollbacks,
      rollbackErrors: rollbackErrors.map((item) => item.stack || item.message),
    };
    await writeFile(resolve(backupDir, "failure-receipt.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    await writeFile(resolve(activationEvidenceDir, "failure-report.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "激活失败且补偿回滚不完整");
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
