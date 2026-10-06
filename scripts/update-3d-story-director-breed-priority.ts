import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";

import { configurationSourceStatus } from "../src/storage/database/configuration-source";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

const target = {
  id: "agent-1786633444187-594spj",
  name: "3D故事导演｜电影叙事",
  historicalPromptSha: "5c819ab803e976acce6e8bd1941557ccfcb6392cb495efcecad4fa7a1269a4f9",
  oldPromptSha: "5264336a6e7015c0605164552e58240687267d8a2ecbbeb80a923a84206df2f8",
  newPromptSha: "289279c5bc8dd31ed6b4af8688f2236f53c9a63dc20709a8d446f30c9668e641",
  promptPath: resolve("prompts/storyboard-voiceover-cinematic-v4.3.2.md"),
} as const;

const protectedHighEnergy = {
  id: "agent-1786843330392-emdjv2",
  name: "3D故事导演｜高能版",
  promptSha: "da8f144b23ee6a4be1c46698017b8d8433128abc8b9d6842cafb7c56314db856",
  presetSha: "76cbfe285ab67507b984daf9f3b53e51e588277fd3a83ff4ee4a0112720beaf4",
} as const;

const backupRoot = resolve("backups/story-director-breed-priority-20260928");

type DbClient = ReturnType<typeof getSupabaseAdminClient>;
type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: Array<Record<string, unknown>>;
  updated_at: string;
  deleted_at?: string | null;
};
type PromptVersion = {
  id: string;
  agent_id: string;
  prompt: string;
  created_at: string;
};
type SourceLabel = "shared-cloud" | "local-acceptance";
type SourceState = {
  movie: AgentRecord;
  high: AgentRecord;
  history: PromptVersion[];
};
type UpdateResult = {
  label: SourceLabel;
  alreadyApplied: boolean;
  appliedThisRun: boolean;
  historyRepairedThisRun: boolean;
  uncertainUpdateRecovered: boolean;
  beforePromptSha256: string;
  afterPromptSha256: string;
  beforeUpdatedAt: string;
  afterUpdatedAt: string;
  beforeHistoryCount: number;
  afterHistoryCount: number;
  latestHistorySha256: string;
  newHistoryId: string | null;
};
type HistoryAlignment = {
  state: SourceState;
  inserted: boolean;
  historyId: string | null;
  beforeLatestSha256: string;
  afterLatestSha256: string;
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const jsonSha256 = (value: unknown) => sha256(JSON.stringify(value));

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function currentPromptSha(state: SourceState): string {
  return sha256(state.movie.system_prompt);
}

function latestHistorySha(state: SourceState): string {
  return sha256(state.history.at(-1)?.prompt || "");
}

function promptFromHistory(state: SourceState, promptSha: string, label: SourceLabel): string {
  const version = state.history.find((item) => sha256(item.prompt) === promptSha);
  assert.ok(version, `${label}历史中找不到待恢复提示词 ${promptSha}`);
  return version.prompt;
}

function historyRepairAction(state: SourceState): "none" | "append-old" | "append-new" {
  const currentSha = currentPromptSha(state);
  if (latestHistorySha(state) === currentSha) return "none";
  return currentSha === target.oldPromptSha ? "append-old" : "append-new";
}

function assertBreedContract(movie: AgentRecord) {
  assert.ok(Array.isArray(movie.preset_fields), "电影叙事版接收卡不是数组");
  const breed = movie.preset_fields.find((field) => field.id === "dog_breed");
  assert.ok(breed, "电影叙事版缺少dog_breed字段");
  assert.equal(breed.required, false, "dog_breed仍为必填，停止更新提示词");
  assert.equal(Object.hasOwn(breed, "defaultValue"), false, "dog_breed仍携带默认值，停止更新提示词");
  assert.equal(breed.placeholder, "不选：按文案识别犬种", "dog_breed空值说明异常");
  assert.ok(Array.isArray(breed.options), "dog_breed选项异常");
  assert.equal(breed.options.length, 20, "dog_breed应只保留20个真实犬种");
  assert.ok(breed.options.includes("哈士奇"), "dog_breed缺少哈士奇选项");
  assert.ok(!breed.options.includes("文案优先，未指定默认柯基"), "dog_breed仍包含伪默认选项");
}

function assertIdentity(
  state: SourceState,
  label: SourceLabel,
  options: { requireLatestHistoryMatch?: boolean } = {},
) {
  assert.equal(state.movie.id, target.id, `${label}电影叙事版ID异常`);
  assert.equal(state.movie.name, target.name, `${label}电影叙事版名称异常`);
  assert.equal(state.movie.deleted_at ?? null, null, `${label}电影叙事版已删除，停止写入`);
  assert.ok(state.movie.updated_at, `${label}电影叙事版缺少updated_at，无法CAS`);
  assert.ok(
    [target.oldPromptSha, target.newPromptSha].some((promptSha) => promptSha === sha256(state.movie.system_prompt)),
    `${label}电影叙事版提示词已漂移，停止覆盖`,
  );
  assertBreedContract(state.movie);

  assert.equal(state.high.id, protectedHighEnergy.id, `${label}高能版ID异常`);
  assert.equal(state.high.name, protectedHighEnergy.name, `${label}高能版名称异常`);
  assert.equal(sha256(state.high.system_prompt), protectedHighEnergy.promptSha, `${label}高能版提示词已漂移`);
  assert.equal(jsonSha256(state.high.preset_fields), protectedHighEnergy.presetSha, `${label}高能版接收卡已漂移`);

  assert.ok(state.history.length > 0, `${label}电影叙事版缺少提示词历史`);
  const currentSha = currentPromptSha(state);
  assert.ok(state.history.some((version) => sha256(version.prompt) === target.oldPromptSha), `${label}历史缺少旧提示词`);
  assert.ok(state.history.some((version) => sha256(version.prompt) === target.historicalPromptSha), `${label}历史缺少v4.3.1提示词`);
  assert.ok(
    [target.oldPromptSha, target.newPromptSha].some((promptSha) => promptSha === latestHistorySha(state)),
    `${label}最新提示词历史不是已知旧版或新版，停止自愈`,
  );
  if (options.requireLatestHistoryMatch !== false) {
    assert.equal(latestHistorySha(state), currentSha, `${label}最新历史与当前提示词不一致`);
  }
}

async function readSource(
  db: DbClient,
  label: SourceLabel,
  options: { requireLatestHistoryMatch?: boolean } = {},
): Promise<SourceState> {
  const [{ data: agents, error: agentsError }, { data: history, error: historyError }] = await Promise.all([
    db.from("agents").select("id,name,system_prompt,preset_fields,updated_at,deleted_at").in("id", [target.id, protectedHighEnergy.id]),
    db.from("prompt_versions").select("id,agent_id,prompt,created_at").eq("agent_id", target.id).order("created_at", { ascending: true }),
  ]);
  assert.ifError(agentsError);
  assert.ifError(historyError);
  const records = (agents || []) as AgentRecord[];
  const movie = records.find((record) => record.id === target.id);
  const high = records.find((record) => record.id === protectedHighEnergy.id);
  assert.ok(movie, `${label}未找到电影叙事版`);
  assert.ok(high, `${label}未找到高能版`);
  const state = { movie, high, history: (history || []) as PromptVersion[] };
  assertIdentity(state, label, options);
  return state;
}

async function localDatabaseClient(): Promise<DbClient> {
  const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    serviceRoleKey?: string;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "本地验收数据库地址异常，停止写入");
  assert.ok(runtime.serviceRoleKey, "本地验收数据库缺少service role，停止写入");
  return createClient(runtime.supabaseUrl, runtime.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as DbClient;
}

async function writeSnapshot(backupDir: string, label: SourceLabel, state: SourceState) {
  await writeFile(
    resolve(backupDir, `${label}-before.json`),
    `${JSON.stringify({
      source: label,
      capturedAt: new Date().toISOString(),
      agent: state.movie,
      protectedAgent: state.high,
      promptVersions: state.history,
      promptVersionShas: state.history.map((version) => ({ id: version.id, sha256: sha256(version.prompt), created_at: version.created_at })),
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function ensureCurrentPromptInHistory(
  db: DbClient,
  label: SourceLabel,
  newPrompt: string,
): Promise<HistoryAlignment> {
  const before = await readSource(db, label, { requireLatestHistoryMatch: false });
  const currentSha = currentPromptSha(before);
  const beforeLatestSha = latestHistorySha(before);
  if (beforeLatestSha === currentSha) {
    return {
      state: before,
      inserted: false,
      historyId: null,
      beforeLatestSha256: beforeLatestSha,
      afterLatestSha256: beforeLatestSha,
    };
  }

  const prompt = currentSha === target.oldPromptSha
    ? promptFromHistory(before, target.oldPromptSha, label)
    : newPrompt;
  assert.equal(sha256(prompt), currentSha, `${label}待补齐历史的提示词SHA异常`);

  let insertedRow: PromptVersion | null = null;
  let insertAwaitError: unknown = null;
  try {
    const { data, error } = await db
      .from("prompt_versions")
      .insert({ agent_id: target.id, prompt })
      .select("id,agent_id,prompt,created_at")
      .single();
    if (error) throw error;
    insertedRow = data as PromptVersion;
  } catch (error) {
    // The request may have committed before the transport failed. Resolve the
    // uncertainty from a fresh database read instead of trusting the await.
    insertAwaitError = error;
  }

  const after = await readSource(db, label, { requireLatestHistoryMatch: false });
  if (latestHistorySha(after) !== currentPromptSha(after)) {
    const mismatch = new Error(`${label}提示词历史补齐后仍与当前提示词不一致`);
    if (insertAwaitError) throw new AggregateError([toError(insertAwaitError), mismatch], mismatch.message);
    throw mismatch;
  }
  assert.equal(currentPromptSha(after), currentSha, `${label}补齐历史期间当前提示词发生并发变化`);
  return {
    state: after,
    inserted: true,
    historyId: insertedRow?.id ?? after.history.at(-1)?.id ?? null,
    beforeLatestSha256: beforeLatestSha,
    afterLatestSha256: latestHistorySha(after),
  };
}

async function restorePromptSnapshot(
  db: DbClient,
  label: SourceLabel,
  desiredPrompt: string,
  newPrompt: string,
): Promise<{ restored: boolean; historyId: string | null }> {
  const initial = await readSource(db, label, { requireLatestHistoryMatch: false });
  const desiredSha = sha256(desiredPrompt);
  assert.ok(
    [target.oldPromptSha, target.newPromptSha].some((promptSha) => promptSha === desiredSha),
    `${label}补偿目标提示词不是已知版本`,
  );
  const initiallyDifferent = currentPromptSha(initial) !== desiredSha;
  let lastUpdateError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readSource(db, label, { requireLatestHistoryMatch: false });
    if (currentPromptSha(current) === desiredSha) {
      const aligned = await ensureCurrentPromptInHistory(db, label, newPrompt);
      await readSource(db, label);
      return { restored: initiallyDifferent, historyId: aligned.historyId };
    }

    try {
      const { data, error } = await db
        .from("agents")
        .update({ system_prompt: desiredPrompt, updated_at: new Date().toISOString() })
        .eq("id", target.id)
        .eq("updated_at", current.movie.updated_at)
        .select("id,name,system_prompt,preset_fields,updated_at,deleted_at");
      if (error) throw error;
      if ((data || []).length !== 1) throw new Error(`${label}补偿回滚CAS未命中`);
    } catch (error) {
      lastUpdateError = error;
    }

    // Always resolve an update await/response ambiguity from persisted state.
    const observed = await readSource(db, label, { requireLatestHistoryMatch: false });
    if (currentPromptSha(observed) === desiredSha) {
      const aligned = await ensureCurrentPromptInHistory(db, label, newPrompt);
      await readSource(db, label);
      return { restored: true, historyId: aligned.historyId };
    }
  }

  const failure = new Error(`${label}补偿恢复三次后数据库仍未回到运行前提示词`);
  if (lastUpdateError) throw new AggregateError([toError(lastUpdateError), failure], failure.message);
  throw failure;
}

async function updateOneSource(
  db: DbClient,
  label: SourceLabel,
  backupDir: string,
  newPrompt: string,
): Promise<UpdateResult> {
  const initial = await readSource(db, label, { requireLatestHistoryMatch: false });
  await writeSnapshot(backupDir, label, initial);
  const initialAlignment = await ensureCurrentPromptInHistory(db, label, newPrompt);
  const before = initialAlignment.state;
  const beforePromptSha = currentPromptSha(before);
  if (beforePromptSha === target.newPromptSha) {
    return {
      label,
      alreadyApplied: true,
      appliedThisRun: false,
      historyRepairedThisRun: initialAlignment.inserted,
      uncertainUpdateRecovered: false,
      beforePromptSha256: beforePromptSha,
      afterPromptSha256: beforePromptSha,
      beforeUpdatedAt: initial.movie.updated_at,
      afterUpdatedAt: before.movie.updated_at,
      beforeHistoryCount: initial.history.length,
      afterHistoryCount: before.history.length,
      latestHistorySha256: latestHistorySha(before),
      newHistoryId: initialAlignment.historyId,
    };
  }

  assert.equal(beforePromptSha, target.oldPromptSha, `${label}提示词基线不是预期旧版本`);
  const beforePresetFields = structuredClone(before.movie.preset_fields);
  const beforeHigh = structuredClone(before.high);
  const initialHistoryIds = initial.history.map((version) => version.id);
  const nextUpdatedAt = new Date().toISOString();
  let updateAwaitError: unknown = null;

  try {
    try {
      const { data: updatedRows, error: updateError } = await db
        .from("agents")
        .update({ system_prompt: newPrompt, updated_at: nextUpdatedAt })
        .eq("id", target.id)
        .eq("updated_at", before.movie.updated_at)
        .select("id,name,system_prompt,preset_fields,updated_at,deleted_at");
      if (updateError) throw updateError;
      if ((updatedRows || []).length !== 1) throw new Error(`${label}提示词CAS更新未命中`);
      if (sha256(String(updatedRows?.[0]?.system_prompt || "")) !== target.newPromptSha) {
        throw new Error(`${label}提示词更新返回值异常`);
      }
    } catch (error) {
      updateAwaitError = error;
    }

    // Do not infer commit state from the await result. A timeout may arrive
    // after PostgreSQL committed, so decide only from a fresh persisted read.
    const observed = await readSource(db, label, { requireLatestHistoryMatch: false });
    if (currentPromptSha(observed) === target.oldPromptSha) {
      if (updateAwaitError) throw toError(updateAwaitError);
      throw new Error(`${label}提示词CAS更新后数据库仍为旧版`);
    }

    const historyAlignment = await ensureCurrentPromptInHistory(db, label, newPrompt);
    const after = await readSource(db, label);
    assert.equal(currentPromptSha(after), target.newPromptSha, `${label}提示词读回SHA不一致`);
    assert.ok(isDeepStrictEqual(after.movie.preset_fields, beforePresetFields), `${label}接收卡被意外修改`);
    assert.ok(isDeepStrictEqual(after.high, beforeHigh), `${label}高能版被意外修改`);
    assert.ok(after.history.length >= before.history.length + 1, `${label}提示词历史没有新增候选版本`);
    assert.deepEqual(after.history.slice(0, initialHistoryIds.length).map((version) => version.id), initialHistoryIds, `${label}既有提示词历史被改写`);
    assert.equal(latestHistorySha(after), target.newPromptSha, `${label}最新历史不是新提示词`);

    return {
      label,
      alreadyApplied: false,
      appliedThisRun: true,
      historyRepairedThisRun: initialAlignment.inserted || historyAlignment.inserted,
      uncertainUpdateRecovered: updateAwaitError !== null,
      beforePromptSha256: beforePromptSha,
      afterPromptSha256: currentPromptSha(after),
      beforeUpdatedAt: initial.movie.updated_at,
      afterUpdatedAt: after.movie.updated_at,
      beforeHistoryCount: initial.history.length,
      afterHistoryCount: after.history.length,
      latestHistorySha256: latestHistorySha(after),
      newHistoryId: historyAlignment.historyId,
    };
  } catch (error) {
    try {
      await restorePromptSnapshot(db, label, before.movie.system_prompt, newPrompt);
    } catch (recoveryError) {
      throw new AggregateError([toError(error), toError(recoveryError)], `${label}升级失败且补偿恢复失败`);
    }
    throw error;
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  const confirmedSharedWrite = process.argv.includes("--confirm-shared-config-write");
  const includeLocal = process.argv.includes("--include-local");
  const sharedDb = getSupabaseAdminClient();
  const source = configurationSourceStatus();
  assert.equal(source.configuration, "shared-cloud", "当前智能体配置源不是预期的shared-cloud，停止执行");
  if (execute) {
    assert.ok(confirmedSharedWrite, "写入shared-cloud必须同时传入 --confirm-shared-config-write");
    assert.ok(includeLocal, "执行提示词升级必须同时更新local-acceptance，请传入 --include-local");
  }

  const newPrompt = (await readFile(target.promptPath, "utf8")).replace(/^\uFEFF/u, "").trimEnd();
  assert.equal(sha256(newPrompt), target.newPromptSha, "v4.3.2提示词文件SHA不匹配，停止执行");
  assert.match(newPrompt, /下拉具体选择 > 特殊备注明确犬种 > 原文主角犬种 > 项目兜底/u);
  assert.match(newPrompt, /空值不是一次用户选择，不得覆盖备注或原文/u);
  assert.match(newPrompt, /下拉未选择、特殊备注没有明确犬种、原文也没有犬种线索/u);
  assert.match(newPrompt, /任何后续格位和镜头不得回退为柯基/u);
  assert.match(newPrompt, /生成门禁：犬种设定冲突，请明确主角狗犬种或拆分文案/u);

  const localDb = includeLocal ? await localDatabaseClient() : null;
  // Startup reads deliberately tolerate a known old/new current/history
  // mismatch left by an interrupted previous run. Dry-run reports the repair;
  // execute mode repairs it before attempting the next CAS update.
  const sharedBefore = await readSource(sharedDb, "shared-cloud", { requireLatestHistoryMatch: false });
  const localBefore = localDb ? await readSource(localDb, "local-acceptance", { requireLatestHistoryMatch: false }) : null;
  const preview = {
    execute,
    includeLocal,
    configurationSource: source.configuration,
    target: { id: target.id, name: target.name },
    newPromptPath: target.promptPath,
    newPromptSha256: target.newPromptSha,
    shared: {
      currentPromptSha256: sha256(sharedBefore.movie.system_prompt),
      promptHistoryCount: sharedBefore.history.length,
      alreadyApplied: sha256(sharedBefore.movie.system_prompt) === target.newPromptSha,
      latestHistorySha256: latestHistorySha(sharedBefore),
      startupRepair: historyRepairAction(sharedBefore),
    },
    local: localBefore ? {
      currentPromptSha256: sha256(localBefore.movie.system_prompt),
      promptHistoryCount: localBefore.history.length,
      alreadyApplied: sha256(localBefore.movie.system_prompt) === target.newPromptSha,
      latestHistorySha256: latestHistorySha(localBefore),
      startupRepair: historyRepairAction(localBefore),
    } : null,
    protectedHighEnergy: true,
    breedPriority: ["explicit-dropdown", "explicit-special-notes", "script-semantics", "project-fallback"],
  };
  if (!execute) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = resolve(backupRoot, stamp);
  await mkdir(backupDir, { recursive: true });
  const results: UpdateResult[] = [];

  try {
    assert.ok(localDb, "本地验收数据库未初始化");
    results.push(await updateOneSource(localDb, "local-acceptance", backupDir, newPrompt));
    results.push(await updateOneSource(sharedDb, "shared-cloud", backupDir, newPrompt));
  } catch (error) {
    const compensations: Array<{ label: SourceLabel; result?: { restored: boolean; historyId: string | null }; error?: string }> = [];
    for (const sourceToRestore of [
      { db: sharedDb, label: "shared-cloud" as const },
      ...(localDb ? [{ db: localDb, label: "local-acceptance" as const }] : []),
    ]) {
      try {
        compensations.push({
          label: sourceToRestore.label,
          result: await restorePromptSnapshot(
            sourceToRestore.db,
            sourceToRestore.label,
            sourceToRestore.label === "shared-cloud"
              ? sharedBefore.movie.system_prompt
              : localBefore!.movie.system_prompt,
            newPrompt,
          ),
        });
      } catch (recoveryError) {
        compensations.push({
          label: sourceToRestore.label,
          error: toError(recoveryError).stack || toError(recoveryError).message,
        });
      }
    }
    await writeFile(resolve(backupDir, "failure-receipt.json"), `${JSON.stringify({
      ...preview,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack || error.message : String(error),
      completedResults: results,
      compensations,
    }, null, 2)}\n`, "utf8");
    const compensationErrors = compensations.filter((item) => item.error).map((item) => new Error(`${item.label}: ${item.error}`));
    if (compensationErrors.length > 0) {
      throw new AggregateError([toError(error), ...compensationErrors], "双源升级失败且至少一个来源补偿恢复失败");
    }
    throw error;
  }

  const finalShared = await readSource(sharedDb, "shared-cloud");
  const finalLocal = await readSource(localDb!, "local-acceptance");
  assert.equal(sha256(finalShared.movie.system_prompt), target.newPromptSha, "shared-cloud最终提示词异常");
  assert.equal(sha256(finalLocal.movie.system_prompt), target.newPromptSha, "local-acceptance最终提示词异常");
  assert.equal(sha256(finalShared.movie.system_prompt), sha256(finalLocal.movie.system_prompt), "两套配置源提示词不一致");

  const receipt = {
    ...preview,
    execute: true,
    completedAt: new Date().toISOString(),
    backupDir,
    results,
    finalPromptSha256: target.newPromptSha,
    dualSourceReadbackPassed: true,
  };
  await writeFile(resolve(backupDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
