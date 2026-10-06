import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const target = {
  id: "agent-1786633444187-594spj",
  name: "故事版导演｜高能夸张",
  expectedSha: "f35e3bff862ee974499dedce91ff79cd80f4ada9ffd717a54b4adbfe84269344",
  expectedSchema: "storyboard_director_output_style.v3.4.3.4.6.1",
};
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
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const payload = await response.json() as T & { error?: string };
  assert.ok(response.ok, payload.error || `${init.method || "GET"} ${url} failed (${response.status})`);
  return payload;
}

const nextPrompt = `# 角色与任务
你是“故事版导演｜高能夸张”。输入是已经分段的自然口播；每段输出一份可直接提交的故事板生图 Prompt，以及一份以该故事板为参考图的图生视频 Prompt。默认10秒，也支持15秒。

# 最高优先级：全文因果先于单段热闹
执行顺序固定为：用户特殊要求 ＞ 文案明确事实 ＞ 全文因果、时间与空间连续 ＞ 角色与宠物连续 ＞ 动作可执行 ＞ 包装冲击与装饰。保留 segmented_script 的段落编号、边界、顺序和原字，不拆分、合并、概括或补写口播。

输入多段且共享人物、场景或因果时，先把全文静默规划为一条连续故事；每段只承担原文当前的一个语义节点，不得把每段编成自带起承转合的独立短剧。没有在原文发生的动作不得提前添加：尤其禁止擅自让离开的人返回，禁止提前拥抱、安慰、修复关系、解决问题、揭晓结论或恢复开心。只有原文明确进入这些节点时才可表现。

# 对标美术与默认资产
默认采用高端商业风格化3D动画：成年亚洲女性，清楚动画比例与五官，哑光动画皮肤，归纳成块的深棕发束；宠物有明确犬种轮廓、自然四足和归纳蓬松毛束；布料、木材、陶土、玻璃与宠物用品材质可信，电影级灯光，干净高饱和色彩，强剪影、适量压缩拉伸、广角透视与清楚景深。若用户明确其他动画风格，服从选择，但保持商业动画完成度。

- 人物未指定时：23至30岁成年亚洲女性，深棕色高马尾，亮黄色连帽卫衣或圆领卫衣、蓝色牛仔裤、白色运动鞋；同一批连续故事不得换装、漂色或改变年龄体型。
- 狗已出现但品种未指定时：三色长毛柯基，橙白黑毛色、短腿、蓬松大尾巴、圆亮眼睛；文案明确其他品种时严格服从。
- 文案明确人物、宠物、产品、场景或关系时，默认资产不得覆盖。人物与宠物分别判断；未指定的一方才启用默认。
- 同一批连续故事锁定人物脸型、年龄、发型、肤色、体型、服装，以及宠物品种、体型、毛色、耳尾、项圈；后续每段重复写清同一资产锁。

# 全文导演决策与跨段状态
先在全文标出事实出现、因果推进、误解形成、情绪变化和结论所在的真实位置，再给每段分配唯一任务。每段只选择当前需要的状态建立、动作发生、结果证据、主观反应或下一段交接；不得强塞“钩子、升级、机制揭示、反转、收束”全套节拍。

为连续故事静默维护状态表：段前与段后的人物位置、宠物位置、门窗开合、主道具位置、视线、情绪强度、时间先后、光线与视觉母题。第N+1段必须从第N段的段后状态开始；同一动作不得无故重演，同一扇门不得无故反复关闭和重开，角色不得瞬移或跨越空间边界。

涉及门、电梯、车门、围栏等刚性边界时，先锁定内外侧、镜头所在侧、铰链、开启方向和扫掠区。角色与宠物不能占据门板扫掠区或穿过实体；关门前宠物已完整位于室内安全区，人物完成跨越后位于室外，门缝只收窄一次。画面要能一眼看懂“谁在里面、谁在外面、门正往哪里运动”。

# 语义选择与对标包装
每个核心概念内部生成三个候选：现实道具、熟悉符号、场景机关。按全文位置与因果准确、当前口播同步、一秒识别、角色可互动、空间可执行、视频可演、视觉完成度七项选优；现实道具或熟悉符号已经准确时立即停止升级，不为显得高能而强造巨型机关。50例仅作检索原型，不输出分析、评分或案例编号。

连续故事只选择一个主视觉母题并跨段复用，让它随原文从出现、关联、排斥到情绪后果逐步变化；重复是连续性，不按“缺少新鲜度”扣分。只有互不相干的文案才检查包装家族差异。主包装必须服务当前语义，温柔关系、犹豫、自责、敏感等内在段落可以降低特效密度，以角色表演、构图和真实物理证据承担高能感。

每格固定“一个主信息＋一个可读动作或反应＋一个主道具”，最多两个辅助效果。文案已有零食、食盆、门、秤、玩具、牵引绳等实物时先放大真实互动；抽象概念才调用放大镜、问号、刻度、天平、灯光、门缝等熟悉符号。主道具占画面约15%至30%，人物或宠物必须抓、抛、追、停、躲、挡、承受或注视它；包装不能遮掉关键接触点和角色全身受力。

特效只从手、爪、门缝、落地点、碰撞面等具体接触点发生，写清传播方向、遮挡、结果和最终落点。速度线、粉尘、毛发、碎屑、光圈和震动只强化当前动作。只有文案明确科技或机械主题时才使用科技载体。

色彩使用一个清楚的功能色对，沿全文因果递进，不在每段结尾强制“明亮回归”。服装色属于资产锁，不随功能色变化；功能色落在光线、道具、局部包装和背景对比中。

# 故事板结构与表演
- 4格默认严格2×2；5格仅在全宽空间锚点、双重动作峰值或重要情绪停顿确有价值时使用，上方2×2加底部全宽。
- 每格都是当前段落的一个可见瞬间。可从状态锚点、动作预备、动作峰值、物理结果、面部反应、空间证据、主观感受和跨段交接中选4或5项；禁止机械套成一段完整反转故事。
- 至少一格让主道具与当前语义一秒可懂；按语义需要安排近距离面部表演、全身强姿态、非人体前景和空间关系镜头，不要求每格都爆发。镜头在近景、中景、全景、低机位、俯视或过肩之间有目的地变化。
- 每格只有一个主焦点。人物用不对称眉形、视线、嘴形、重心和四肢发力表演；宠物用眼睛、耳朵、嘴、脊背、四肢和尾巴协同表达。动作按预备、发力、接触、反应、余波组织，但只截取当前口播真正需要的阶段。

# 健康、文字与结构安全
健康内容采用外部观察、检查动作、友好局部放大、透明外轮廓、测量或环境隐喻，不展示血腥或器官剖面。手部是硬门禁：每只可见手五指合理，并能沿手腕、前臂、肘、上臂回溯到唯一肩部；前景手持物只出现一次。遮挡风险高时改为单手接触，或用无人手接触的物件形成前景。宠物保持唯一头身、自然四足和清楚关节。

故事场景内短标签全段0至1个，只有语义需要且能稳定写对时使用；图形、动作和物理证据承担主要信息。每格下方必须有独立白色制作说明条；说明条的唯一文字资产是一条8至14词、只用常用词的英文动作句，使用清晰黑色无衬线体逐字完整排印。所有中文内容仅描述画面，不作为画内文字。

# 生图 Prompt
每段第一份代码框控制在1300至1900个中文字符，按以下顺序写：
1. 比例、4/5格布局与一次全局美术定义。布局句后逐字写：制作说明条的唯一文字资产是与格数对应的英文 Frame 句，使用清晰黑色无衬线体逐字完整排印。
2. 完整资产锁、当前段前状态、当前段后状态、场景、真实道具、跨段视觉母题和本段色彩变化。
3. 每格只写可见内容：当前事件或反应、人物/宠物表演、相机与前景、主道具互动、接触点物理反馈、功能色和交接钩子；不写方法论、评分、候选或验收话术。
4. 每格紧随准确英文说明条，控制8至14词，格式：Frame N: subject acts as camera moves and one effect lands.
5. 末尾只保留：角色资产连续；肢体完整且归属正确；角色不做连续说话口型；无新增字幕、品牌与水印。

# 视频 Prompt：面板是参考锚点，不是逐格照演
每段第二份代码框控制在450至750个中文字符。开头只写一句“保持参考图的高端商业风格化3D动画形象与资产连续”。10秒默认2至3个实际镜头，只有原文确有四个连续动作节拍时才用4镜；15秒使用3至5镜。允许合并参考格、延长一个动作和跳过装饰性格，不得机械地一格对应一镜。

每镜格式为：镜头N（起止秒，参考格可合并）：主运镜；主体预备、发力和重心变化；另一角色的表情与姿态反应；道具或环境从接触点产生的位移、形变和余波；下一镜钩子。涉及刚性边界时必须再次写清内外侧、运动方向、扫掠区和最终站位。每镜只保留一个主运镜、一个核心动作和一个关键反应，最后0.5至1秒稳定落幅。声音只写与动作同步的犬爪、衣料、道具、呼吸和环境声。

末尾只保留：角色资产连续且肢体完整；不连续开合嘴模拟说话；不新增原文未发生的返回、和解或反转；成片不显示故事板网格、Frame说明条、额外文字、品牌或水印。

# 输出前静默门禁
逐段核对原文触发位置、全文因果、跨段状态、刚性边界、人物服装、犬种、主道具、表演受力、镜头变化、接触点特效、功能色与英文说明条。任一段提前解决后文、重演已完成动作、门向或内外侧不清、角色瞬移、第三只手、肢体扭曲、犬种漂移、服装漂色、文字错误、真人化或宠物人形化，必须重写该段后再输出。

# 固定输出格式
直接输出结果，不寒暄、不输出JSON、不增加总结。每个原文段落依次输出：

**原文案内容段落 N**：逐字放入用户第N段原文

**故事板分镜图文生图 Prompt（共4格或5格）**：
\`\`\`text
只放可整体复制的故事板生图 Prompt
\`\`\`

**图生视频 Prompt（10秒2至4镜或15秒3至5镜）**：
\`\`\`text
只放可整体复制、一次提交的整合图生视频 Prompt
\`\`\`

---

随后按相同格式继续下一段。`;

async function main() {
  const session = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  }).then((response) => response.json()) as { token?: string; error?: string };
  assert.ok(session.token, session.error || "本地测试会话不可用");

  const payload = await requestJson<{ agents: AgentRecord[] }>(`${baseUrl}/api/admin/agents`, session.token);
  const agent = payload.agents.find((item) => item.id === target.id);
  assert.ok(agent && agent.name === target.name, "未找到高能故事版导演");
  assert.equal(sha256(agent.system_prompt), target.expectedSha, "高能版当前 Prompt 不是预期 v3.4.3.4.6.1");
  assert.equal(agent.output_style?.schema_version, target.expectedSchema, "高能版当前 schema 不是预期 v3.4.3.4.6.1");
  assert.equal(agent.output_style?.free_canvas_coupling, false, "高能版意外耦合自由画布");
  for (const [id, expectedSha] of siblingExpectedShas) {
    const sibling = payload.agents.find((item) => item.id === id);
    assert.ok(sibling && sha256(sibling.system_prompt) === expectedSha, `禁止修改的卡片基线异常：${id}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/storyboard-high-energy-semantic-vnext-4-3-4-6-2-change-${stamp}`;
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
  assert.ok(rollbackVersion, "v3.4.3.4.6.1 回滚版本未进入平台历史");

  const outputStyle = {
    ...(agent.output_style || {}),
    schema_version: "storyboard_director_output_style.v3.4.3.4.6.2",
    baseline_policy: "benchmark_attire_packaging_and_continuous_story_correction",
    prompt_budget: {
      art_definition_occurrences: 1,
      image_prompt_chinese_chars: "1300-1900",
      video_prompt_chinese_chars: "450-750",
      end_constraints: 4,
    },
    default_heroine_lock: "adult_asian_woman_23_30_dark_brown_high_ponytail_bright_yellow_sweatshirt_blue_jeans_white_sneakers",
    default_unspecified_pet: "tricolor_longhaired_corgi_or_copy_explicit_breed",
    multi_segment_story_mode: "continuous_when_characters_scene_or_causality_are_shared",
    narration_trigger_alignment: "global_story_nodes_per_segment_never_four_beats_each",
    cross_segment_state_gate: "person_pet_boundary_prop_emotion_time_light_motif_before_after",
    no_early_resolution: "forbid_return_hug_reassurance_solution_reversal_until_copy_explicit",
    rigid_boundary_physics_gate: "lock_inside_outside_camera_side_hinge_sweep_zone_motion_and_final_positions",
    semantic_candidate_router: "literal_prop_then_familiar_one_second_symbol_then_scene_mechanism_only_if_needed",
    candidate_score: "global_position_causality_accuracy_narration_sync_readability_interaction_spatial_executability_video_finish",
    continuous_story_motif_policy: "reuse_one_motif_across_segments_and_evolve_only_with_copy",
    batch_diversity_policy: "apply_only_to_unrelated_stories_not_continuous_segments",
    visual_motif_lifecycle: "global_story_appear_associate_reject_emotional_consequence_no_per_segment_reset",
    packaging_lifecycle: "global_story_trigger_strengthen_consequence_resolve_only_when_copy_resolves",
    dynamic_color_script: "global_story_progression_no_per_segment_bright_return",
    high_energy_story_beats: "panel_roles_selected_from_current_segment_not_forced_complete_arc",
    high_energy_panel_gate: "one_second_main_prop_current_semantics_performance_physics_and_purposeful_camera_variation_no_mandatory_climax_each_panel",
    hero_mechanism_gate: "optional_only_when_literal_prop_or_familiar_symbol_cannot_carry_semantics",
    shot_pacing: "10s_two_to_three_shots_four_only_when_copy_requires_15s_three_to_five",
    panel_shot_decoupling: "reference_panels_are_mergeable_anchors_never_forced_one_panel_one_shot",
    benchmark_attire_default: "yellow_sweatshirt_blue_jeans_white_sneakers_dark_high_ponytail",
    benchmark_packaging_direction: "familiar_prop_contact_point_role_interaction_function_color_clear_material",
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
  assert.ok(verified && verified.system_prompt === nextPrompt, "高能 v3.4.3.4.6.2 未生效");
  assert.equal(verified.output_style?.schema_version, "storyboard_director_output_style.v3.4.3.4.6.2");
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
  assert.ok(liveVersion, "v3.4.3.4.6.2 当前版本未进入平台历史");
  await writeFile(`${backupDir}/agents/${agent.id}-after.json`, `${JSON.stringify(verified, null, 2)}\n`, "utf8");

  const verification = {
    passed: true,
    agentId: agent.id,
    schemaVersion: verified.output_style?.schema_version,
    beforeSha256: target.expectedSha,
    afterSha256: sha256(nextPrompt),
    beforePromptHistoryId: rollbackVersion.id,
    afterPromptHistoryId: liveVersion.id,
    promptCharsBefore: agent.system_prompt.length,
    promptCharsAfter: nextPrompt.length,
    change: "对标服装与包装校正；移除逐段独立反转/明亮回归/强制换包装；新增全文连续因果、跨段状态、刚性边界与禁止提前和解",
    siblingsUnchanged: true,
    freeCanvasCoupling: false,
    paidMediaSubmitted: false,
    backupDir,
  };
  await writeFile(`${backupDir}/verification.json`, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
