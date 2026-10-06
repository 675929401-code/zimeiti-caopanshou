import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "f7fa3ed66f2610ac64ef0dce55a9a5e0ec12fa18f06ad0344604df41403035fd",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

interface PromptVersion { id: string; prompt: string }
interface AgentRecord {
  id: string;
  name: string;
  system_prompt: string;
  output_style?: Record<string, unknown>;
  [key: string]: unknown;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

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

function replaceSection(prompt: string, heading: string, nextHeading: string, replacement: string): string {
  const start = prompt.indexOf(heading);
  const end = prompt.indexOf(nextHeading, start + heading.length);
  assert.ok(start >= 0 && end > start, `未找到替换区段：${heading}`);
  return `${prompt.slice(0, start)}${replacement.trim()}\n\n${prompt.slice(end)}`;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前 Prompt 不是预期 vNext.4.3.4.5，禁止覆盖");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }
  assert.equal(agent.output_style?.free_canvas_coupling, false, "自由画布解耦状态异常");

  const hiddenDirector = `# 隐藏导演决策
每段先在原口播内部标出事实出现、误解升级、反转和结论四类语义节拍，但不改原文。确定一个主冲突、一个信息任务和一个视觉母题；主包装在对应语义出现时触发，在动作峰值增强，在反转处碰撞或变形，在结论处收束，不能提前剧透或滞后错位。

每个核心概念内部生成三个候选：现实道具、熟悉符号、场景机关。按语义准确、一秒识别、角色可互动、动作冲击、因果闭环、视频可演、场景新鲜七项选优；低一层已经准确可懂时立即停止升级。50例只作为灵感原型，匹配时可直接调用；复用原型至少改变材质、尺度、空间、互动、动作、功能色、生命周期中的三项。只输出胜出画面，不展示分析、候选、评分或案例编号。

紧凑语义路由：防护/抵抗看盾、门、围栏或缓冲物；对比/轻重看天平、跷跷板、刻度或岔路；紧张/疑惑看表针、弹簧、放大镜或问号；信任/分离看桥、门缝、松紧牵引带或灯；隐形信息看声纹、气味轨迹、脚印、局部放大或环境反馈；过量/不足看量杯、能量条、阶梯或堆叠物；规则/路径看红线、路障、信号灯或门槛；健康机制看外部检查、友好局部示意、透明外轮廓或测量器；诱惑/冲动看磁力、滚动物、抓取轨迹或漏斗；结论/奖励看奖杯、英雄道具、场景变形或状态翻转。它们都是候选，不是一对一死绑定。

视觉母题按“出现→增强→碰撞→转化/收束”推进；动作按“预备→发力→反应→环境余波→停留”组织。上一格的视线、飞散物、门窗、滚动物、光线或运动方向自然交给下一格。`;

  const packagingMethod = `# 语义包装方法
每格固定“一个主信息＋一个动作峰值＋一个主道具”，最多两个辅助效果。文案已有零食袋、耳朵、玩具、门、秤、食盆、牵引绳等实物时先放大真实互动；抽象结论才调用熟悉符号或场景机关。高潮格让主包装占画面约20%至35%，成为一秒可懂的视觉中心；人物或宠物必须推、挡、抓、躲、撞、追、托、踩或承受它的反馈。

特效从具体接触点发生：写清触发点、传播方向、遮挡、碰撞结果和最终落点。爆发线、速度线、粉尘、毛发、碎屑、光圈、震动和形变只强化当前动作，不单独悬浮装饰。只有文案明确科技或机械主题时才使用科技载体。

色彩使用一个清楚的功能色对，随“场景基础→冲突增强→高潮对比→明亮回归”变化；危险、安全、知识和情绪各有功能，不给整板套统一滤镜。同一批内部记录主道具、包装家族、材质、功能色、机位和高潮构图；复用必须由语义证明，禁止连续整套复制。`;

  const imageBudget = `# 生图 Prompt：内容与预算
每段第一份代码框控制在1600至2300个中文字符，按以下顺序写：
1. 比例、4/5格布局，以及一次全局美术定义。布局句后逐字写：制作说明条的唯一文字资产是下方四条英文 Frame 句，使用清晰黑色无衬线体逐字完整排印。IP相似性只在内部静默检查；输出不得出现“原创”“不复制”“现成角色”或“IP”等审查话术。
2. 一次完整资产锁：人物、宠物、服装、识别特征、场景、真实道具、视觉母题与逐格色彩脚本。
3. 每格只写可见内容：事件峰值、人物/宠物表演、相机/前景、主包装互动、物理反馈、功能色和过渡钩子；不写方法论、评分、候选、验收过程或解释性话术。
4. 每格紧随准确英文说明条，控制8至14词，格式：Frame N: subject acts as camera moves and one effect lands.
5. 末尾只保留：角色资产连续；肢体完整且归属正确；角色不做连续说话口型；无新增字幕、品牌与水印。`;

  const videoPrompt = `# 视频 Prompt：只回答“怎么演”
每段第二份代码框控制在600至1000个中文字符。开头只写一句“保持参考图的高端商业风格化3D动画形象与资产连续”。
10秒使用3至4个实际镜头，15秒使用4至5个实际镜头；面板数不等于切镜数。按口播语义节拍分配时间，让画面在对应含义出现时才触发包装。每镜格式为：
镜头N（起止秒，来源格）：主运镜；主体预备、发力和重心变化；另一角色的表情与姿态反应；道具/环境从接触点产生的位移、形变和余波；已有包装怎样增强、碰撞、转化或消退；下一镜钩子。
每镜只保留一个主运镜、一个核心动作和一个关键反应，强弱交替，最后0.5至1秒稳定落幅。声音只写与动作同步的犬爪、衣料、道具、呼吸和环境声。
末尾只保留：角色资产连续且肢体完整；不连续开合嘴模拟说话；成片不显示故事板网格、Frame说明条、额外文字、品牌或水印。`;

  let nextPrompt = replaceSection(agent.system_prompt, "# 隐藏导演决策", "# 高能故事结构", hiddenDirector);
  nextPrompt = replaceSection(nextPrompt, "# 语义包装方法", "# 健康、文字与结构安全", packagingMethod);
  nextPrompt = replaceSection(nextPrompt, "# 生图 Prompt：内容与预算", "# 视频 Prompt：只回答“怎么演”", imageBudget);
  nextPrompt = replaceSection(nextPrompt, "# 视频 Prompt：只回答“怎么演”", "# 输出前静默门禁", videoPrompt);

  assert.ok(nextPrompt.includes("事实出现、误解升级、反转和结论四类语义节拍"));
  assert.ok(nextPrompt.includes("现实道具、熟悉符号、场景机关"));
  assert.ok(nextPrompt.includes("1600至2300个中文字符"));
  assert.ok(nextPrompt.includes("600至1000个中文字符"));
  assert.ok(!nextPrompt.includes("800至1300个中文字符"));
  assert.ok(!nextPrompt.includes("1800至2600个中文字符"));
  assert.ok(nextPrompt.length <= 3900, `Prompt 超出精简预算：${nextPrompt.length}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-4-6-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");

  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
  });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.4.5 回滚版本未进入平台历史");

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.4.6",
    narration_trigger_alignment: "fact_misunderstanding_reversal_conclusion",
    semantic_candidate_router: "literal_prop_familiar_symbol_scene_mechanism",
    candidate_score: "accuracy_readability_interaction_impact_causality_video_freshness",
    packaging_lifecycle: "trigger_spread_collide_transform_resolve",
    prompt_budget: {
      art_definition_occurrences: 1,
      image_prompt_chinese_chars: "1600-2300",
      video_prompt_chinese_chars: "600-1000",
      end_constraints: 3,
    },
    exemplar_library: "retrieval_only_never_dump_full_50_cases",
    free_canvas_coupling: false,
  };

  await requestJson(`${baseUrl}/api/admin/agents`, session.token, {
    method: "PUT",
    body: JSON.stringify({ agentId: agent.id, system_prompt: nextPrompt, output_style: outputStyle }),
  });
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: nextPrompt, max_versions: 20 }),
  });

  const verifiedPayload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const verified = verifiedPayload.agents.find((item) => item.id === target.id);
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能 vNext.4.3.4.6 未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }

  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(
    `${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`,
    session.token,
  );
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(nextPrompt));
  assert.ok(liveVersion, "vNext.4.3.4.6 当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: agent.id,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(nextPrompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    changes: [
      "口播语义节拍与包装触发对齐",
      "现实道具/熟悉符号/场景机关三候选七维选优",
      "50例仅作检索原型且复用至少改变三项",
      "接触点驱动的特效生命周期",
      "视频Prompt减负为600至1000字",
    ],
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    freeCanvasCoupling: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
