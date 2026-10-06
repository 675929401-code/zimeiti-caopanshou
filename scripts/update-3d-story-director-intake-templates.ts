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
  compatiblePromptShas: [
    "5c819ab803e976acce6e8bd1941557ccfcb6392cb495efcecad4fa7a1269a4f9",
    "5264336a6e7015c0605164552e58240687267d8a2ecbbeb80a923a84206df2f8",
    "289279c5bc8dd31ed6b4af8688f2236f53c9a63dc20709a8d446f30c9668e641",
  ],
  compatiblePresetShas: [
    "e040d8957f9afb8071bf4bfe8411c68ba827c597550280ba3951059371eb65d3",
    "5b43f4b500bc55d9a5c70908e1edbf5dc1b6acfa8757d4709519faa38c5ed1b4",
    "7445bb8dff7fa2574ffd570a363fddc197ab6c411594c63979c29c2ad63168d6",
    "4600dd24d40c1a2731c85e1419c75fa92454f221f3539425bb907f53e956cbd8",
  ],
} as const;

const protectedHighEnergy = {
  id: "agent-1786843330392-emdjv2",
  name: "3D故事导演｜高能版",
  expectedPromptSha: "da8f144b23ee6a4be1c46698017b8d8433128abc8b9d6842cafb7c56314db856",
  expectedPresetSha: "e9ee055c90bd8d169fb0d298b125f2300a5c344304da4184db3fa60a7ba400ee",
} as const;

const backupRoot = resolve("backups/story-director-intake-template-20260928");

type AgentRecord = {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: Array<Record<string, unknown>>;
  updated_at: string;
  deleted_at?: string | null;
};

type SourceLabel = "shared-cloud" | "local-acceptance";

type UpdateResult = {
  label: SourceLabel;
  alreadyApplied: boolean;
  outcome: "already-applied" | "updated" | "recovered-target-state";
  beforePresetSha256: string;
  afterReadbackSha256: string;
  beforeUpdatedAt: string;
  afterUpdatedAt: string;
  afterReadbackPassed: true;
};

type RecoveryResult = {
  label: SourceLabel;
  outcome: "already-restored" | "restored" | "recovered-restored-state";
  presetSha256: string;
  updatedAt: string;
};

const nextPresetFields: Array<Record<string, unknown>> = [
  {
    id: "segmented_script",
    label: "分段文案",
    type: "textarea",
    placeholder: "粘贴已分好的口播文案，例如：\n1.【约10秒或15秒的一段文案】\n2.【下一段文案】",
    required: true,
    options: [],
    order: 0,
    sendLabel: true,
    sendText: "segmented_script",
    description: "保留用户已经划定的段落边界、编号、顺序和原文，不重新拆段。",
  },
  {
    id: "target_duration_seconds",
    label: "分段时长",
    type: "select",
    placeholder: "选择每段视频时长",
    required: true,
    options: [
      "10秒版：每段3-4个镜头",
      "15秒版：每段4-5个镜头",
    ],
    order: 1,
    sendLabel: true,
    sendText: "target_duration_seconds",
    description: "10秒使用3-4个实际镜头；15秒使用4-5个实际镜头。故事板格数不等于实际镜头数。",
    defaultValue: "10秒版：每段3-4个镜头",
  },
  {
    id: "aspect_ratio",
    label: "视频比例",
    type: "select",
    placeholder: "选择视频比例",
    required: true,
    options: ["16:9", "9:16"],
    order: 2,
    sendLabel: true,
    sendText: "aspect_ratio",
    description: "16:9为横屏，9:16为竖屏；所选比例同时约束故事板、首帧构图和视频运镜。",
    defaultValue: "16:9",
  },
  {
    id: "animation_style",
    label: "动画风格",
    type: "select",
    placeholder: "选择3D动画风格",
    required: true,
    options: [
      "高能商业3D动画喜剧（皮克斯式）",
      "童话电影3D动画（迪士尼式）",
      "欧美反差3D动画喜剧（梦工厂式）",
      "高饱和萌宠3D动画喜剧（照明娱乐式）",
      "温暖家庭3D动画电影",
      "电影级风格化半写实3D",
      "手工黏土定格质感3D动画",
      "Q版玩具模型3D动画",
      "东方国潮3D动画电影",
      "未来科技霓虹3D动画",
    ],
    order: 5,
    sendLabel: true,
    sendText: "animation_style",
    description: "沿用电影叙事版原有的10套独立风格模板，不与高能版的动画风格选项混用。",
    defaultValue: "高能商业3D动画喜剧（皮克斯式）",
  },
  {
    id: "owner_gender",
    label: "主人性别",
    type: "select",
    placeholder: "选择默认主人性别",
    required: true,
    options: [
      "文案优先，未指定默认女主人",
      "女主人",
      "男主人",
    ],
    order: 3,
    sendLabel: true,
    sendText: "owner_gender",
    description: "优先服从分段文案中的人物设定；文案未指定时按所选主人性别统一全片角色资产。",
    defaultValue: "文案优先，未指定默认女主人",
  },
  {
    id: "dog_breed",
    label: "狗狗品种",
    type: "select",
    placeholder: "不选：按文案识别犬种",
    required: false,
    options: [
      "柯基",
      "金毛",
      "哈士奇",
      "泰迪/贵宾",
      "比熊",
      "中华田园犬",
      "拉布拉多",
      "边境牧羊犬",
      "萨摩耶",
      "博美",
      "法国斗牛犬",
      "柴犬",
      "德国牧羊犬",
      "阿拉斯加",
      "雪纳瑞",
      "巴哥",
      "吉娃娃",
      "约克夏",
      "腊肠犬",
      "杜宾",
    ],
    order: 4,
    sendLabel: true,
    sendText: "dog_breed",
    description: "不选时不发送犬种字段，由智能体从文案识别；只有明确选择时才用所选犬种覆盖。",
  },
  {
    id: "special_notes",
    label: "特殊备注",
    type: "textarea",
    placeholder: "可填毛色、服装、场景、道具、参考图重点、禁用内容或目标视频模型；没有就留空。",
    required: false,
    options: [],
    order: 6,
    sendLabel: true,
    sendText: "special_notes",
    description: "选填；明确的毛色、服装、场景、道具、禁用内容和模型要求优先于默认设定。",
  },
].sort((a, b) => Number(a.order) - Number(b.order));

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalizeJson(record[key])]),
    );
  }
  return value;
}

const canonicalJson = (value: unknown) => JSON.stringify(canonicalizeJson(value));
const jsonSha256 = (value: unknown) => sha256(canonicalJson(value));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyPresetState(
  currentPresetFields: Array<Record<string, unknown>>,
  previousPresetFields: Array<Record<string, unknown>>,
): "previous" | "target" | "conflict" {
  if (isDeepStrictEqual(currentPresetFields, previousPresetFields)) return "previous";
  if (isDeepStrictEqual(currentPresetFields, nextPresetFields)) return "target";
  return "conflict";
}

function assertCurrentIdentity(movie: AgentRecord, high: AgentRecord) {
  assert.equal(movie.name, target.name, "电影叙事版名称异常，停止写入");
  assert.equal(movie.deleted_at ?? null, null, "电影叙事版已删除，停止写入");
  assert.ok(movie.updated_at, "电影叙事版缺少updated_at，无法执行CAS");
  assert.ok(
    target.compatiblePromptShas.some((promptSha) => promptSha === sha256(movie.system_prompt)),
    "电影叙事版提示词已漂移，停止覆盖",
  );
  const alreadyApplied = isDeepStrictEqual(movie.preset_fields, nextPresetFields);
  const currentPresetSha = jsonSha256(movie.preset_fields);
  assert.ok(
    alreadyApplied || target.compatiblePresetShas.some((sha) => sha === currentPresetSha),
    "电影叙事版接收卡已漂移，停止覆盖",
  );
  assert.equal(high.name, protectedHighEnergy.name, "高能版名称异常，停止写入");
  assert.equal(sha256(high.system_prompt), protectedHighEnergy.expectedPromptSha, "高能版提示词已漂移，停止写入");
  assert.equal(jsonSha256(high.preset_fields), protectedHighEnergy.expectedPresetSha, "高能版接收卡已漂移，停止写入");
  return { alreadyApplied };
}

async function readAgents(db: ReturnType<typeof getSupabaseAdminClient>) {
  const { data, error } = await db
    .from("agents")
    .select("id,name,system_prompt,preset_fields,updated_at,deleted_at")
    .in("id", [target.id, protectedHighEnergy.id]);
  assert.ifError(error);
  const records = (data || []) as AgentRecord[];
  const movie = records.find((record) => record.id === target.id);
  const high = records.find((record) => record.id === protectedHighEnergy.id);
  assert.ok(movie, "未找到电影叙事版智能体");
  assert.ok(high, "未找到高能版智能体");
  return { movie, high };
}

async function assertPromptHistory(
  db: ReturnType<typeof getSupabaseAdminClient>,
  label: string,
  currentPromptSha: string,
) {
  const { data: versions, error } = await db
    .from("prompt_versions")
    .select("id,prompt,created_at")
    .eq("agent_id", target.id)
    .order("created_at", { ascending: false })
    .limit(30);
  assert.ifError(error);
  assert.ok(
    (versions || []).some((version: { prompt: string }) => sha256(version.prompt) === currentPromptSha),
    `${label}的当前电影叙事版提示词不在回滚历史中，停止写入`,
  );
}

async function localDatabaseClient() {
  const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    serviceRoleKey?: string;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "本地验收数据库地址异常，停止写入");
  assert.ok(runtime.serviceRoleKey, "本地验收数据库缺少service role，停止写入");
  return createClient(runtime.supabaseUrl, runtime.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as ReturnType<typeof getSupabaseAdminClient>;
}

async function restorePreset(
  db: ReturnType<typeof getSupabaseAdminClient>,
  label: SourceLabel,
  previousPresetFields: Array<Record<string, unknown>>,
  expectedPromptSha: string,
): Promise<RecoveryResult> {
  const current = await readAgents(db);
  assertCurrentIdentity(current.movie, current.high);
  assert.equal(sha256(current.movie.system_prompt), expectedPromptSha, `${label}补偿回滚时提示词已变化`);
  const currentState = classifyPresetState(current.movie.preset_fields, previousPresetFields);
  if (currentState === "previous") {
    return {
      label,
      outcome: "already-restored",
      presetSha256: jsonSha256(current.movie.preset_fields),
      updatedAt: current.movie.updated_at,
    };
  }
  assert.equal(currentState, "target", `${label}补偿回滚时接收卡既不是原值也不是本脚本目标值`);

  const rollbackUpdatedAt = new Date().toISOString();
  let restoreFailure: unknown = null;
  try {
    const { data: restoredRows, error: restoreError } = await db
      .from("agents")
      .update({ preset_fields: previousPresetFields, updated_at: rollbackUpdatedAt })
      .eq("id", target.id)
      .eq("updated_at", current.movie.updated_at)
      .select("id,name,system_prompt,preset_fields,updated_at,deleted_at");
    assert.ifError(restoreError);
    assert.equal((restoredRows || []).length, 1, `${label}补偿回滚CAS失败`);
  } catch (error) {
    restoreFailure = error;
  }

  const verified = await readAgents(db);
  assertCurrentIdentity(verified.movie, verified.high);
  assert.equal(sha256(verified.movie.system_prompt), expectedPromptSha, `${label}补偿回滚误改提示词`);
  const verifiedState = classifyPresetState(verified.movie.preset_fields, previousPresetFields);
  if (verifiedState === "target") {
    const failureDetail = restoreFailure ? `：${describeError(restoreFailure)}` : "";
    throw new Error(`${label}补偿回滚未提交，数据库仍为本脚本目标值${failureDetail}`);
  }
  assert.equal(verifiedState, "previous", `${label}补偿回滚后接收卡进入未知冲突状态`);
  return {
    label,
    outcome: restoreFailure ? "recovered-restored-state" : "restored",
    presetSha256: jsonSha256(verified.movie.preset_fields),
    updatedAt: verified.movie.updated_at,
  };
}

async function updateOneSource(
  db: ReturnType<typeof getSupabaseAdminClient>,
  label: SourceLabel,
  backupDir: string,
): Promise<UpdateResult> {
  const before = await readAgents(db);
  const identity = assertCurrentIdentity(before.movie, before.high);
  const beforePromptSha = sha256(before.movie.system_prompt);
  await assertPromptHistory(db, label, beforePromptSha);

  await writeFile(resolve(backupDir, `${label}-${target.id}-before.json`), `${JSON.stringify(before.movie, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(resolve(backupDir, `${label}-${protectedHighEnergy.id}-protected.json`), `${JSON.stringify(before.high, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  let updateFailure: unknown = null;
  if (!identity.alreadyApplied) {
    const nextUpdatedAt = new Date().toISOString();
    try {
      const { data: updatedRows, error } = await db
        .from("agents")
        .update({ preset_fields: nextPresetFields, updated_at: nextUpdatedAt })
        .eq("id", target.id)
        .eq("updated_at", before.movie.updated_at)
        .select("id,name,system_prompt,preset_fields,updated_at,deleted_at");
      assert.ifError(error);
      assert.equal((updatedRows || []).length, 1, `${label}接收卡CAS更新失败`);
    } catch (error) {
      updateFailure = error;
    }
  }

  const after = await readAgents(db);
  assertCurrentIdentity(after.movie, after.high);
  assert.equal(after.movie.name, before.movie.name, `${label}电影叙事版名称被意外修改`);
  assert.equal(sha256(after.movie.system_prompt), beforePromptSha, `${label}电影叙事版提示词被意外修改`);
  assert.equal(sha256(after.high.system_prompt), protectedHighEnergy.expectedPromptSha, `${label}高能版提示词被意外修改`);
  assert.deepEqual(after.high.preset_fields, before.high.preset_fields, `${label}高能版接收卡被意外修改`);

  const afterIsTarget = isDeepStrictEqual(after.movie.preset_fields, nextPresetFields);
  if (!afterIsTarget) {
    const afterState = classifyPresetState(after.movie.preset_fields, before.movie.preset_fields);
    if (afterState === "previous") {
      const failureDetail = updateFailure ? `：${describeError(updateFailure)}` : "";
      throw new Error(`${label}接收卡更新未提交，数据库仍为更新前值${failureDetail}`);
    }
    assert.fail(`${label}接收卡更新后进入未知冲突状态`);
  }

  await writeFile(resolve(backupDir, `${label}-${target.id}-after.json`), `${JSON.stringify(after.movie, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  return {
    label,
    alreadyApplied: identity.alreadyApplied,
    outcome: identity.alreadyApplied
      ? "already-applied"
      : updateFailure
        ? "recovered-target-state"
        : "updated",
    beforePresetSha256: jsonSha256(before.movie.preset_fields),
    afterReadbackSha256: jsonSha256(after.movie.preset_fields),
    beforeUpdatedAt: before.movie.updated_at,
    afterUpdatedAt: after.movie.updated_at,
    afterReadbackPassed: true,
  };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const confirmedSharedWrite = process.argv.includes("--confirm-shared-config-write");
  const includeLocal = process.argv.includes("--include-local");
  const db = getSupabaseAdminClient();
  const source = configurationSourceStatus();
  assert.equal(source.configuration, "shared-cloud", "当前智能体配置源不是预期的shared-cloud，停止执行");

  const before = await readAgents(db);
  const sharedIdentity = assertCurrentIdentity(before.movie, before.high);
  await assertPromptHistory(db, "shared-cloud", sha256(before.movie.system_prompt));
  const localDb = includeLocal ? await localDatabaseClient() : null;
  const localBefore = localDb ? await readAgents(localDb) : null;
  const localIdentity = localBefore ? assertCurrentIdentity(localBefore.movie, localBefore.high) : null;
  if (localDb && localBefore) await assertPromptHistory(localDb, "local-acceptance", sha256(localBefore.movie.system_prompt));

  const preview = {
    execute,
    configurationSource: source.configuration,
    includeLocal,
    target: { id: before.movie.id, name: before.movie.name },
    beforePresetSha256: jsonSha256(before.movie.preset_fields),
    afterPresetSha256: jsonSha256(nextPresetFields),
    protectedHighEnergyPresetSha256: jsonSha256(before.high.preset_fields),
    fieldOrder: nextPresetFields.map((field) => field.id),
    durationOptions: nextPresetFields[1]?.options,
    ratioOptions: nextPresetFields[2]?.options,
    ownerGenderOptions: nextPresetFields.find((field) => field.id === "owner_gender")?.options,
    dogBreedOptions: nextPresetFields.find((field) => field.id === "dog_breed")?.options,
    animationStyleOptionsPreserved: JSON.stringify(before.movie.preset_fields.find((field) => field.id === "animation_style")?.options)
      === JSON.stringify(nextPresetFields.find((field) => field.id === "animation_style")?.options),
    highEnergyUnchanged: true,
    promptUnchanged: true,
    sharedAlreadyApplied: sharedIdentity.alreadyApplied,
    localAlreadyApplied: localIdentity?.alreadyApplied ?? null,
  };

  if (!execute) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  assert.ok(confirmedSharedWrite, "写入shared-cloud配置必须同时传入 --confirm-shared-config-write");
  assert.ok(includeLocal, "执行接收卡升级必须同时更新local-acceptance，请传入 --include-local");
  assert.ok(localDb, "本地验收数据库未初始化");
  assert.ok(localBefore, "本地验收数据库缺少电影叙事配置");
  assert.equal(preview.animationStyleOptionsPreserved, true, "电影叙事版动画风格选项发生变化，停止写入");

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = resolve(backupRoot, stamp);
  await mkdir(backupDir, { recursive: true });
  const targets: UpdateResult[] = [];
  try {
    targets.push(await updateOneSource(localDb, "local-acceptance", backupDir));
    targets.push(await updateOneSource(db, "shared-cloud", backupDir));
  } catch (error) {
    const compensations: Array<{ label: SourceLabel; result?: RecoveryResult; error?: string }> = [];
    for (const sourceToRestore of [
      {
        db,
        label: "shared-cloud" as const,
        previousPresetFields: before.movie.preset_fields,
        expectedPromptSha: sha256(before.movie.system_prompt),
      },
      {
        db: localDb,
        label: "local-acceptance" as const,
        previousPresetFields: localBefore.movie.preset_fields,
        expectedPromptSha: sha256(localBefore.movie.system_prompt),
      },
    ]) {
      try {
        compensations.push({
          label: sourceToRestore.label,
          result: await restorePreset(
            sourceToRestore.db,
            sourceToRestore.label,
            sourceToRestore.previousPresetFields,
            sourceToRestore.expectedPromptSha,
          ),
        });
      } catch (recoveryError) {
        compensations.push({
          label: sourceToRestore.label,
          error: recoveryError instanceof Error ? recoveryError.stack || recoveryError.message : String(recoveryError),
        });
      }
    }
    await writeFile(resolve(backupDir, "failure-receipt.json"), `${JSON.stringify({
      ...preview,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.stack || error.message : String(error),
      completedTargets: targets,
      compensations,
    }, null, 2)}\n`, "utf8");
    const compensationErrors = compensations.filter((item) => item.error);
    if (compensationErrors.length > 0) {
      throw new AggregateError(
        [error instanceof Error ? error : new Error(String(error)), ...compensationErrors.map((item) => new Error(`${item.label}: ${item.error}`))],
        "双源接收卡升级失败且至少一个来源补偿恢复失败",
      );
    }
    throw error;
  }
  const receipt = {
    ...preview,
    execute: true,
    backupDir,
    targets,
  };
  await writeFile(resolve(backupDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
