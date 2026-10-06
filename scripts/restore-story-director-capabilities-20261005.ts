import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

import {
  buildHighEnergyPromptQualityCandidate,
  buildMoviePromptQualityCandidate,
  sha256,
} from "./story-director-prompt-quality-candidates";

type AgentRow = {
  id: string;
  name: string;
  system_prompt: string;
  preset_fields: Array<Record<string, unknown>>;
  updated_at: string;
  deleted_at: string | null;
};

const targets = {
  movie: {
    id: "agent-1786633444187-594spj",
    name: "3D故事导演｜电影叙事",
    expectedPromptSha256: "289279c5bc8dd31ed6b4af8688f2236f53c9a63dc20709a8d446f30c9668e641",
  },
  highEnergy: {
    id: "agent-1786843330392-emdjv2",
    name: "3D故事导演｜高能版",
    expectedPromptSha256: "9a3547f253891131cf928400b55458bd12a21a18e3013f6b18c5fcb1197adff4",
  },
} as const;

const backupRoot = resolve("backups/story-director-restoration-20261005-Codex");
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function replaceExactOnce(source: string, before: string, after: string, label: string): string {
  const start = source.indexOf(before);
  assert.notEqual(start, -1, `${label}：找不到预期片段`);
  assert.equal(source.indexOf(before, start + before.length), -1, `${label}：预期片段出现多次`);
  return `${source.slice(0, start)}${after}${source.slice(start + before.length)}`;
}

function replaceSectionOnce(source: string, startText: string, endText: string, replacement: string, label: string): string {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `${label}：找不到起始片段`);
  assert.equal(source.indexOf(startText, start + startText.length), -1, `${label}：起始片段出现多次`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `${label}：找不到结束片段`);
  return `${source.slice(0, start)}${replacement.trimEnd()}\n${source.slice(end)}`;
}

const generationModelField = {
  id: "video_model_profile",
  label: "生成模型",
  type: "select",
  placeholder: "选择视频提示词适配模型",
  required: true,
  options: [
    "自动通用（分镜工作台再选择模型）",
    "MiniMax H3（官方结构适配）",
    "Omni Flash（官方时序与音轨适配）",
    "Grok Imagine（官方图生视频适配）",
  ],
  order: 2,
  sendLabel: true,
  sendText: "video_model_profile",
  description: "只转换视频提示词的模型表达协议，不改变故事、动作、镜头、风格、角色、道具、时长或声音边界。",
  defaultValue: "自动通用（分镜工作台再选择模型）",
};

function buildMoviePrompt(currentPrompt: string): string {
  let prompt = buildMoviePromptQualityCandidate(currentPrompt).replace(/\r\n/gu, "\n");
  prompt = replaceExactOnce(
    prompt,
    "特殊备注出现“Omni”、“xAI”或“MiniMax H3”时启用对应模型路由；未指定时使用三者兼容的通用路由。",
    "接收卡的“生成模型”优先决定视频提示词路由；可选自动通用、MiniMax H3、Omni Flash 或 Grok Imagine。特殊备注只有在明确提出模型要求时才作为补充；未指定时使用通用路由。模型路由只转换表达协议，不改变故事、动作、镜头、风格、角色、道具、时长或声音边界。",
    "电影版生成模型输入",
  );
  prompt = replaceSectionOnce(
    prompt,
    "每个视频 Prompt 代码框的第一行必须写：",
    "每镜写清：",
    `每个视频 Prompt 代码框的第一行必须写：“生成模型：自动通用 / MiniMax H3 / Omni Flash / Grok Imagine｜时长：10秒或15秒｜比例：16:9或9:16｜实际镜头数：N”。只保留本次真实选中的值，不得把斜杠候选项原样输出。即使使用默认值，也必须在该行明示写出自动通用、16:9、10秒和实际镜头数。
先静默冻结唯一的 canonical_video_plan：逐镜起止秒、人物与宠物资产、场景与道具、动作顺序、运镜、必要包装、现场声和结束状态。生成模型只改字段名、句式、参考图标签和时间表达，不能增删或改写语义事实：
- **自动通用**：使用清晰中文执行口令，按“首帧参考绑定 + 秒级动作 + 运镜 + 道具/包装变化 + 现场声 + 稳定落幅”表达。
- **MiniMax H3**：把工作台裁出的单首帧作为 <Picture 1>，使用 subject_definitions、summary、retention_analysis、detailed_description、overall_soundscape、non_diegetic_music 的字段顺序；结构说明与执行正文使用英文，逐镜用 [Shot 1] 和精确时间点；现场声保留在 overall_soundscape，non_diegetic_music 写 none。
- **Omni Flash**：使用自然直接的英文指令，先声明上传图片是单首帧参考、最终视频正常全屏；用 [0-2s] 等时间码写顺序动作，需要切镜时写 cut，连续镜头写 continuous shot；声音边界写 No dialogue. No narration. No background music.
- **Grok Imagine**：使用简洁自然的英文提示词，先绑定上传图片为首帧参考，再按时间顺序写主体动作、镜头运动、物理反馈和结束状态；时长由接收卡与上游 duration 参数共同控制，不发明伪标签或复杂内部术语。
四种表达必须与 canonical_video_plan 语义等价；若所选模型不支持当前时长，只能明确提示不兼容并建议更换模型或时长，不得擅自压缩、拉长或改写故事。`,
    "电影版模型同义编译层",
  );
  return prompt;
}

function withMovieGenerationModel(fields: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  assert.ok(!fields.some((field) => field.id === "storyboard_mode" || field.id === "storyboard_format"), "电影版仍有故事板形态字段");
  const withoutModel = fields.filter((field) => field.id !== generationModelField.id);
  const shifted = withoutModel.map((field) => {
    const order = Number(field.order);
    return Number.isFinite(order) && order >= 2 ? { ...field, order: order + 1 } : { ...field };
  });
  shifted.push({ ...generationModelField });
  return shifted.sort((left, right) => Number(left.order) - Number(right.order));
}

function withHighEnergyGenerationModel(fields: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  assert.ok(!fields.some((field) => field.id === "storyboard_mode" || field.id === "storyboard_format"), "高能版仍有故事板形态字段");
  let found = false;
  const next = fields.map((field) => {
    if (field.id !== generationModelField.id) return { ...field };
    found = true;
    return { ...field, label: "生成模型", description: generationModelField.description };
  });
  assert.ok(found, "高能版缺少既有生成模型字段");
  return next;
}

function durationOptions(fields: Array<Record<string, unknown>>): string[] {
  const duration = fields.find((field) => field.id === "target_duration_seconds" || field.id === "segment_duration");
  return Array.isArray(duration?.options) ? duration.options.map(String) : [];
}

function assertRestored(movie: AgentRow, highEnergy: AgentRow): void {
  assert.deepEqual(durationOptions(movie.preset_fields), ["10秒版：每段3-4个镜头", "15秒版：每段4-5个镜头"]);
  assert.deepEqual(durationOptions(highEnergy.preset_fields), ["8秒版：每段3个镜头", "10秒版：每段3-4个镜头", "15秒版：每段4-6个镜头"]);
  for (const row of [movie, highEnergy]) {
    const fields = row.preset_fields;
    assert.equal(fields.filter((field) => field.id === generationModelField.id).length, 1, `${row.name}生成模型字段异常`);
    assert.ok(row.system_prompt.includes("生图 Prompt") || row.system_prompt.includes("生图Prompt"), `${row.name}缺少生图Prompt`);
    assert.ok(row.system_prompt.includes("视频 Prompt") || row.system_prompt.includes("videoPrompt"), `${row.name}缺少视频Prompt`);
    assert.ok(/Frame/u.test(row.system_prompt), `${row.name}缺少英文Frame规则`);
    assert.ok(/连续|连贯/u.test(row.system_prompt), `${row.name}缺少连续性规则`);
    assert.ok(/MiniMax H3/u.test(row.system_prompt) && /Omni Flash/u.test(row.system_prompt) && /Grok Imagine/u.test(row.system_prompt), `${row.name}模型路由不完整`);
  }
  assert.ok(highEnergy.system_prompt.includes("# 全文包装账本与减法门"), "高能版缺少全文包装账本");
  assert.ok(highEnergy.system_prompt.includes("10秒控制在270至420个字符"), "高能版缺少视频长度门禁");
  assert.ok(movie.system_prompt.startsWith("# 最高优先级口播时长门禁"), "电影版缺少口播时长硬门禁");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const runtimePath = resolve("../../../运行数据/自媒体操盘手/local-data-20260902/config/runtime.json");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as {
    supabaseUrl?: string;
    ownerConnection?: pg.ClientConfig;
  };
  assert.equal(runtime.supabaseUrl, "http://127.0.0.1:54321", "只允许更新本地验收数据库");
  assert.ok(runtime.ownerConnection, "本地数据库连接缺失");
  const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-story-director-restoration-20261005" });
  await client.connect();
  try {
    await client.query("begin");
    const result = await client.query<AgentRow>(
      "select id,name,system_prompt,preset_fields,updated_at,deleted_at from public.agents where id=any($1::text[]) order by id for update",
      [[targets.movie.id, targets.highEnergy.id]],
    );
    assert.equal(result.rows.length, 2, "目标智能体数量异常");
    const movieBefore = result.rows.find((row) => row.id === targets.movie.id);
    const highBefore = result.rows.find((row) => row.id === targets.highEnergy.id);
    assert.ok(movieBefore && highBefore, "目标智能体读取失败");
    assert.equal(movieBefore.name, targets.movie.name);
    assert.equal(highBefore.name, targets.highEnergy.name);
    assert.equal(movieBefore.deleted_at, null);
    assert.equal(highBefore.deleted_at, null);
    assert.equal(sha256(movieBefore.system_prompt), targets.movie.expectedPromptSha256, "电影版当前Prompt漂移");
    assert.equal(sha256(highBefore.system_prompt), targets.highEnergy.expectedPromptSha256, "高能版当前Prompt漂移");
    const protectedBefore = await client.query("select id,name,system_prompt,preset_fields,updated_at from public.agents where name ilike '%架构师%' order by id");

    const movieAfter: AgentRow = {
      ...movieBefore,
      system_prompt: buildMoviePrompt(movieBefore.system_prompt),
      preset_fields: withMovieGenerationModel(movieBefore.preset_fields),
    };
    const highAfter: AgentRow = {
      ...highBefore,
      system_prompt: buildHighEnergyPromptQualityCandidate(highBefore.system_prompt, {
        expectedBaseSha256: targets.highEnergy.expectedPromptSha256,
        currentVersionLabel: "故事版短视频导演智能体 v2.5.7·受保护恢复版",
        nextVersionLabel: "故事版短视频导演智能体 v2.5.9-restored-r4",
        prepareBase: (prompt) => replaceExactOnce(
          prompt,
          "整段videoPrompt采用“开场绑定句 + 所选时长对应的时间镜头 + 收尾边界句”的高密度结构。开场绑定句不超过180字，只锁定完整故事板、默认风格指纹、核心角色、核心道具、成片全屏连续和声音边界；参考图已锁住外观，后文只写演法。每个镜头只写一个主动作、一个主运镜、一个包装变化和一个接力物；同一镜头不得同时安排三种以上包装。8秒视频Prompt建议650至1100个中文字符，10秒建议800至1400个中文字符，15秒建议1100至1800字；这个区间用于保证“风格不丢、动作能演、信息不溢出”。超过上限时优先删除重复风格、重复服装、解释性语句、口播复述和无接触来源的装饰描述，保留参考绑定、秒级动作、特效生命周期、声音边界和落幅。",
          "整段videoPrompt采用“开场绑定句 + 3至4个时间镜头 + 收尾边界句”的高密度结构。开场绑定句不超过180字，只锁定完整故事板、默认风格指纹、核心角色、核心道具、成片全屏连续和声音边界；参考图已锁住外观，后文只写演法。每个镜头只写一个主动作、一个主运镜、一个包装变化和一个接力物；同一镜头不得同时安排三种以上包装。10秒视频Prompt建议800至1400个中文字符，15秒建议1100至1800字；这个区间用于保证“风格不丢、动作能演、信息不溢出”。超过上限时优先删除重复风格、重复服装、解释性语句、口播复述和无接触来源的装饰描述，保留参考绑定、秒级动作、特效生命周期、声音边界和落幅。",
          "高能版已恢复的8秒视频预算预处理",
        ),
      }),
      preset_fields: withHighEnergyGenerationModel(highBefore.preset_fields),
    };
    assertRestored(movieAfter, highAfter);

    const report = {
      mode: apply ? "apply" : "dry-run",
      targets: [movieAfter, highAfter].map((row) => ({
        id: row.id,
        name: row.name,
        beforePromptSha256: sha256(row.id === movieBefore.id ? movieBefore.system_prompt : highBefore.system_prompt),
        afterPromptSha256: sha256(row.system_prompt),
        durations: durationOptions(row.preset_fields),
        generationModelLabel: row.preset_fields.find((field) => field.id === generationModelField.id)?.label,
      })),
      protectedArchitectCount: protectedBefore.rows.length,
    };
    if (!apply) {
      await client.query("rollback");
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const runId = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupDir = resolve(backupRoot, runId);
    await mkdir(backupDir, { recursive: true });
    await writeFile(resolve(backupDir, "before.json"), `${JSON.stringify({ movieBefore, highBefore, protectedBefore: protectedBefore.rows }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    for (const row of [movieAfter, highAfter]) {
      const updatedAt = new Date().toISOString();
      const before: AgentRow = row.id === movieBefore.id ? movieBefore : highBefore;
      const update: pg.QueryResult<{ id: string }> = await client.query<{ id: string }>(
        "update public.agents set system_prompt=$1,preset_fields=$2::jsonb,updated_at=$3 where id=$4 and updated_at=$5 returning id",
        [row.system_prompt, JSON.stringify(row.preset_fields), updatedAt, row.id, before.updated_at],
      );
      assert.equal(update.rowCount, 1, `${row.name} CAS更新失败`);
      await client.query("insert into public.prompt_versions(agent_id,prompt) values($1,$2)", [row.id, row.system_prompt]);
    }
    const afterRows = await client.query<AgentRow>(
      "select id,name,system_prompt,preset_fields,updated_at,deleted_at from public.agents where id=any($1::text[]) order by id",
      [[targets.movie.id, targets.highEnergy.id]],
    );
    const movieReadback = afterRows.rows.find((row) => row.id === targets.movie.id);
    const highReadback = afterRows.rows.find((row) => row.id === targets.highEnergy.id);
    assert.ok(movieReadback && highReadback);
    assertRestored(movieReadback, highReadback);
    const protectedAfter = await client.query("select id,name,system_prompt,preset_fields,updated_at from public.agents where name ilike '%架构师%' order by id");
    assert.equal(sha(JSON.stringify(protectedAfter.rows)), sha(JSON.stringify(protectedBefore.rows)), "受保护的2D/3D影像架构师发生变化");
    await client.query("commit");
    const finalReport = { ...report, backupDir, committedAt: new Date().toISOString() };
    await writeFile(resolve(backupDir, "receipt.json"), `${JSON.stringify(finalReport, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify(finalReport, null, 2));
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main();
