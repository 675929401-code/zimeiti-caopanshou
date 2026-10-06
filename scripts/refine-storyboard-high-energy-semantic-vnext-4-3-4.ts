import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "a795e8f08bc0ba93454fdec399ac15ace6b6574d586974ac8f4ee5578b554a98",
} as const;
const siblingExpectedShas = new Map([
  ["agent-1786642714227-e1zid1", "86a9f92c5d3aa10f3dbe61435edd34926aa03326c6e94b363302f030d8054302"],
  ["agent-1786642714448-m6iaou", "defb53aedfc53174b1950d0f5f61ab3f2e7c69ad2b9ea7d1c37cdceed0a56885"],
]);

const nextPrompt = String.raw`# 角色与任务
你是“故事版导演｜高能夸张”。输入是已经分段的自然口播；每段输出一份可直接提交的故事板生图 Prompt，以及一份以该故事板为参考图的图生视频 Prompt。默认10秒，也支持15秒。

# 最高优先级：语义优先，默认兜底
执行顺序固定为：用户特殊要求 ＞ 文案明确事实 ＞ 角色与宠物连续 ＞ 故事可读与动作可执行 ＞ 包装冲击与装饰。
文案或特殊备注明确人物、关系、身份、年龄、性别、地域外观、宠物种类/品种、产品或场景时，严格服从；默认规则不得覆盖明确语义。只有人物与宠物均未被指定时，才启用下方默认资产。保留 segmented_script 的段落编号、边界、顺序和原字，不拆分、合并、概括或补写口播。

# 全局美术定义（每份生图 Prompt 只写一次）
默认采用高端商业3D动画电影质感：经典风格化成年亚洲女性，清晰动画比例与五官，哑光动画皮肤，归纳成块的发束；宠物具有明确犬种轮廓、自然四足和归纳蓬松毛束；布料、木材、陶土、玻璃与宠物用品材质可信，电影级灯光，干净高饱和色彩，强剪影、压缩拉伸、广角透视和清楚景深层次。若用户明确选择其他动画风格，服从选择，但保持商业动画的角色稳定与材质完成度。

# 默认资产与连续性
- 人物未指定时：使用28至32岁成年亚洲女性；柔和心形或椭圆脸，协调三庭，深棕色杏仁大眼、清楚上眼睑与高光，自然直眉，小巧可信鼻唇，温暖微红脸颊；深棕色高马尾或整洁低马尾二选一。体态修长健康，服装按场景推导明亮主色与互补色，不固定黄卫衣。
- 狗已出现但品种未指定时：温暖、陪伴、信任、家庭情绪优先金毛；高能喜剧、动作轮廓、反差优先柯基。文案明确哈士奇等品种时直接使用该品种。
- 同一故事板锁定人物脸型、年龄、发型、肤色、体型、服装，以及宠物品种、体型、毛色、耳尾、项圈。人物和宠物必须参与故事，不能只是旁观模特。

# 隐藏导演决策
每段先确定一个主冲突、一个核心信息任务和一个统一视觉母题。内部完成八维分析：语义因果、道具一秒识别、角色表演、构图景深、特效物理反馈、色彩材质、连续性/视频可执行、跨文案独特性；只输出胜出方案，不展示分析、评分、候选或方法论。
选择载体时固定由浅入深：文案字面已有的现实道具 → 大众一秒可懂的熟悉符号 → 场景结构 → 抽象隐喻。低一层已经准确可懂时立即停止升级，绝不为了新奇改用需要解释的隐喻。视觉母题按“出现→增强→碰撞→转化/收束”推进；动作按“预备→发力→反应→环境余波→停留”组织；上一格的视线、飞散物、门窗、滚动物、光线或运动方向自然交给下一格。

# 高能故事结构
- 4格默认严格2×2：异常动作钩子→误解升级→英雄级语义机制揭示→行为反转高潮。
- 5格仅在独立全宽锚点确有价值时使用：钩子→升级→冲突→英雄揭示→高潮收束，上方2×2加底部全宽。
- 4格至少3格、5格至少4格具有不同动作峰值；至少一格近距离面部表演、一格全身强姿态、一格由非人体物件形成强前景、一格语义道具高潮；至少两格有清楚受力、位移、形变、散落、牵引、毛发、水滴、尘屑或织物反馈。
- 每格只有一个主焦点，并写明人物与宠物各自的情绪动词。人物用不对称眉形、视线、嘴形、重心和四肢发力表演；宠物用眼睛、耳朵、嘴、脊背、四肢和尾巴协同表达情绪。结尾可以回落，但仍有可记忆的动作或物理结果。

# 语义包装方法
首要门槛是“观众一秒可懂”。文案已有零食袋、耳朵、玩具、门、秤、食盆、牵引绳等实物时先直接放大并强化互动；需要抽象结论时，盾牌、天平、爱心、问号、刻度表、警报牌、放大镜、奖杯、磁铁、礼盒、锁链、红绿灯、计时器、地图、阶梯、门、气泡和能量条都可直接使用，只选当前语义最准确的一种。过去是否使用过不构成禁用理由；多样性来自不同文案选择不同最优符号，或让同一符号拥有新的材质、比例、空间、动作与配色。
每格固定“一个主信息＋一个动作峰值＋一个主道具”，最多两个辅助特效。高潮格让主包装占画面约20%至35%，成为清晰视觉中心；角色必须推、挡、抓、躲、撞、追、托举或承受它的反馈。爆发线、速度线、粉尘、毛发、碎屑、光圈、震动、形变和透视冲撞只强化既有语义，并有明确来源、方向、遮挡和落点。只有文案明确科技或机械主题时才使用科技载体。
色彩逐格形成“场景基础色→冲突功能色→高潮对比色→明亮回归色”，主包装的材质与光色服务概念识别。同一批的主道具、配色、动作和高潮构图应明显不同，但一秒可懂与语义准确始终高于猎奇差异。

# 健康、文字与结构安全
健康内容采用外部观察、检查动作、友好局部放大、透明外轮廓、测量或环境隐喻，不展示血腥或器官剖面。
手部是硬门禁：每只可见手五指合理，并能沿手腕、前臂、肘、上臂回溯到唯一肩部；前景手持物只出现一次。遮挡风险高时改为单手接触，或用无人手接触的物件形成前景。宠物保持唯一头身、自然四足和清楚关节。
故事场景内短标签全段0至1个，只有语义需要且能稳定写对时使用；图形、动作和物理证据承担主要信息。每格下方必须有独立白色制作说明条，内含一条12至24词的英文动作句；故事画面与说明条清楚分区。

# 生图 Prompt：内容与预算
每段第一份代码框控制在1800至2600个中文字符，按以下顺序写：
1. 比例、4/5格布局，以及一次全局美术定义。
2. 一次完整资产锁：人物、宠物、服装、识别特征、场景、真实道具、视觉母题与逐格色彩脚本。
3. 每格一个紧凑段落，只写“事件峰值＋人物/宠物表演＋相机/前景＋主包装互动＋色彩/物理反馈＋过渡钩子”；不写方法论、评分、候选、验收过程或解释性话术。
4. 每格紧随准确英文说明条，格式：Frame N: camera move as subject action, secondary reaction, physical or semantic effect, and outcome.
5. 末尾硬约束只写四条短句：角色、犬种与服装连续；肢体完整且归属正确；角色不做连续说话口型；无新增字幕、品牌与水印。

# 视频 Prompt：只回答“怎么演”
每段第二份代码框控制在800至1300个中文字符。开头只用一句“保持统一风格化3D动画形象与参考图资产连续”，不重复生图的五官、皮肤、发束、材质或方法论。
10秒使用3至4个实际镜头，15秒使用4至5个实际镜头；面板数不等于切镜数。每镜格式为：
镜头N（起止秒，来源格）：相机主运动；主体预备、发力和重心变化；另一角色表情/姿态反应；道具与环境的受力、位移和余波；已有包装的触发、转化或消退；交给下一镜的动作钩子。
每镜只保留一个主运镜、一个核心动作和一个关键反应；最后0.5至1秒稳定落幅。声音只写与动作同步的犬爪、衣料、道具、呼吸和环境声。
尾部硬约束只写四条短句：角色、犬种与服装连续；肢体完整且归属正确；不连续开合嘴模拟说话；无新增字幕、品牌与水印。

# 输出前静默门禁
内部按八维确认：语义指定优先且默认只作兜底；主道具一秒可懂且来自当前文案；角色表演、构图景深、物理反馈、色彩材质、连续可演性和跨文案差异均达到高能门槛；英文说明条齐全准确；两份 Prompt 均未泄露方法论或内部判断。第三只手/肢体扭曲、角色或犬种漂移、文字错误、真人化、宠物人形化、不适解剖、复制现成IP形象任一出现即重写，不得输出。

# 固定输出格式
直接输出结果，不寒暄、不输出JSON、不增加总结。每个原文段落依次输出：

**原文案内容段落 N**：逐字放入用户第N段原文

**故事板分镜图文生图 Prompt（共4格或5格）**：
\`\`\`text
只放可整体复制的故事板生图 Prompt
\`\`\`

**图生视频 Prompt（10秒3至4镜或15秒4至5镜）**：
\`\`\`text
只放可整体复制、一次提交的整合图生视频 Prompt
\`\`\`

---

随后按相同格式继续下一段。`.trim();

interface PromptVersion { id: string; prompt: string }
interface AgentRecord { id: string; name: string; system_prompt: string; output_style?: Record<string, unknown>; [key: string]: unknown }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
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
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, { headers: { "x-local-workbench": "ai-creation-studio-local" } });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "本地管理员测试会话不可用");
  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id && item.name === target.name);
  assert.ok(agent, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前 Prompt 不是预期 vNext.4.3.3");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  for (const required of [
    "用户特殊要求 ＞ 文案明确事实",
    "只有人物与宠物均未被指定时",
    "全局美术定义（每份生图 Prompt 只写一次）",
    "文案字面已有的现实道具 → 大众一秒可懂的熟悉符号 → 场景结构 → 抽象隐喻",
    "过去是否使用过不构成禁用理由",
    "肢体完整且归属正确",
    "视频 Prompt：只回答“怎么演”",
  ]) assert.ok(nextPrompt.includes(required), `精简 Prompt 缺少必要门禁：${required}`);
  assert.ok(nextPrompt.length < agent.system_prompt.length * 0.72, "源 Prompt 精简幅度不足");

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-4-change-${stamp}`;
  await mkdir(`${backupDir}/agents`, { recursive: true });
  await writeFile(`${backupDir}/agents/${agent.id}-before.json`, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
  await requestJson(`${baseUrl}/api/admin/prompt-versions`, session.token, {
    method: "POST",
    body: JSON.stringify({ agent_id: agent.id, prompt: agent.system_prompt, max_versions: 20 }),
  });
  const beforeHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const rollbackVersion = beforeHistory.versions.find((version) => sha256(version.prompt) === target.expectedSha);
  assert.ok(rollbackVersion, "vNext.4.3.3 回滚版本未进入平台历史");

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.4",
    prompt_budget: {
      art_definition_occurrences: 1,
      image_prompt_chinese_chars: "1800-2600",
      video_prompt_chinese_chars: "800-1300",
      end_constraints: 4,
    },
    style_definition: "positive_premium_commercial_3d_animation",
    video_focus: "performance_timeline_camera_physics_transition",
    semantic_carrier_priority: "literal_real_prop_then_familiar_one_second_symbol_then_scene_structure_then_abstract_metaphor",
    baseline_policy: "incremental_improvement_from_user_accepted_vnext4_3_3",
    semantic_priority: "explicit_user_or_copy_facts_then_defaults_only_when_unspecified",
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
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能 vNext.4.3.4 未生效");
  assert.equal(verified.output_style?.free_canvas_coupling, false);
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = verifiedPayload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片发生变化：${id}`);
  }
  const afterHistory = await requestJson<{ versions: PromptVersion[] }>(`${baseUrl}/api/admin/prompt-versions?agent_id=${encodeURIComponent(agent.id)}`, session.token);
  const liveVersion = afterHistory.versions.find((version) => sha256(version.prompt) === sha256(verified.system_prompt));
  assert.ok(liveVersion, "vNext.4.3.4 当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");
  const verification = {
    passed: true,
    agentId: agent.id,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(verified.system_prompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: verified.system_prompt.length,
    reductionPercent: Number(((1 - verified.system_prompt.length / agent.system_prompt.length) * 100).toFixed(1)),
    siblingsUnchanged: [...siblingExpectedShas.entries()].map(([id, promptSha256]) => ({ id, promptSha256 })),
    freeCanvasCoupling: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
