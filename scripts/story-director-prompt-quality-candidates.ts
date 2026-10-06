import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const STORY_DIRECTOR_PROMPT_QUALITY_BASELINE = {
  movie: {
    id: "agent-1786633444187-594spj",
    name: "3D故事导演｜电影叙事",
    version: "storyboard-voiceover-cinematic-v4.3.2",
    promptSha256: "289279c5bc8dd31ed6b4af8688f2236f53c9a63dc20709a8d446f30c9668e641",
  },
  highEnergy: {
    id: "agent-1786843330392-emdjv2",
    name: "3D故事导演｜高能版",
    version: "storyboard-short-video-director-v2.5.7",
    promptSha256: "da8f144b23ee6a4be1c46698017b8d8433128abc8b9d6842cafb7c56314db856",
  },
} as const;

export const STORY_DIRECTOR_PROMPT_QUALITY_CANDIDATE = {
  movieVersion: "storyboard-voiceover-cinematic-v4.3.3-candidate-r2",
  highEnergyVersion: "storyboard-short-video-director-v2.5.8-candidate-r3",
  moviePromptSha256: "55d46be070e1db618caf37b80f2db3a4ce5c9c71a57dac3857ecf4ad0c144885",
  highEnergyPromptSha256: "3fd59ee3f1daa8109c1f5d6c01967fa74fd8496d9be66ed2612eb1118d1bf963",
  activation: "activated-dual-source-2026-10-01",
  requiredGate: "real-platform-model-canary-passed",
} as const;

export const HIGH_ENERGY_OUTPUT_BUDGET = {
  8: { imageMax: 580, videoMax: 400, combinedMax: 900 },
  10: { imageMax: 700, videoMax: 480, combinedMax: 1050 },
  15: { imageMax: 850, videoMax: 650, combinedMax: 1400 },
} as const;

export const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function replaceExactOnce(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label}：找不到预期基线片段`);
  assert.equal(source.indexOf(before, first + before.length), -1, `${label}：预期基线片段出现多次`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function replaceSectionOnce(
  source: string,
  startHeading: string,
  nextHeading: string,
  replacement: string,
  label: string,
): string {
  const start = source.indexOf(startHeading);
  assert.notEqual(start, -1, `${label}：找不到起始标题`);
  assert.equal(source.indexOf(startHeading, start + startHeading.length), -1, `${label}：起始标题出现多次`);
  const end = source.indexOf(nextHeading, start + startHeading.length);
  assert.notEqual(end, -1, `${label}：找不到结束标题`);
  return `${source.slice(0, start)}${replacement.trimEnd()}\n\n${source.slice(end)}`;
}

export function buildMoviePromptQualityCandidate(basePrompt: string): string {
  assert.equal(sha256(basePrompt), STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.movie.promptSha256, "电影叙事版基线 Prompt 已漂移");

  const oldOvertimeRule = "先统计汉字和数字，以每秒5至6个有效字估算口播负载，再按语义权重分配连续时间段。开头拍点覆盖原文开头，结尾拍点覆盖原文结尾，转折必须在对应语义到达后才发生。不得为了跟标点而频繁切镜，也不得提前演后文。若有效字数超过目标秒数乘以6，不假装能够同步；视频 Prompt 第一行只写“生成门禁：口播超时，请重新分段后再生成”，后续仍可给出导演草案，但不得作为可提交成片 Prompt。";
  const strictOvertimeRule = `先统计每段汉字和数字，以每秒5至6个有效字估算口播负载，再按语义权重分配连续时间段。开头拍点覆盖原文开头，结尾拍点覆盖原文结尾，转折必须在对应语义到达后才发生。不得为了跟标点而频繁切镜，也不得提前演后文。

生成任何故事板或视频 Prompt 之前，必须先完成整批口播时长预检。只要任一段有效字数超过目标秒数乘以6，整个批次只输出口播超时门禁，不进入导演编译：第一行固定写“生成门禁：口播超时，请先压缩或重新分段”；随后按段列出“第N段：X个有效字 / 上限Y字 / 建议压缩到Z字以内”。列完全部超时段后立即停止。门禁结果不得出现代码框、故事板、生图 Prompt、视频 Prompt、导演草案、可复制执行指令或“仍可继续生成”的表述；未超时段也不先行生成。用户修正并重新提交后，再对整批重新预检。`;

  const topPriorityGate = `# 最高优先级口播时长门禁（先于本提示词其他全部任务）
收到输入后，第一步只读取目标秒数和全部编号分段，逐段统计汉字与数字。每段硬上限=目标秒数×6个有效字。此检查优先于角色、风格、故事板、视频和下方输出格式，禁止先构思画面。

只要任一段超过硬上限，立即切换为唯一允许的门禁输出：第一行必须逐字写“生成门禁：口播超时，请先压缩或重新分段”；随后只列全部超时段“第N段：X个有效字 / 上限Y字 / 建议压缩到Z字以内”；列完立即结束。此分支绝不能出现 Markdown 代码框、原文案标题、故事板、生图 Prompt、视频 Prompt、导演草案或任何可提交生成的内容。只有全部分段均未超时，才继续执行后续导演任务。`;

  let candidate = replaceExactOnce(
    basePrompt,
    oldOvertimeRule,
    strictOvertimeRule,
    "电影叙事版口播超时门禁",
  );

  candidate = replaceExactOnce(
    candidate,
    "# 角色与目标\n",
    `${topPriorityGate}\n\n# 角色与目标\n`,
    "电影叙事版最高优先级门禁",
  );

  candidate = replaceExactOnce(
    candidate,
    "# 输出格式\n直接输出结果，不寒暄、不输出JSON、不增加总结。标题中的X必须替换为本段实际选定的4或5，禁止原样输出字母X。每段依次输出：",
    `# 输出格式\n到达本节时再次执行最高优先级口播时长门禁。若任一段超时，下列正常格式全部失效，只输出门禁首行与全部超时段明细后结束。只有整批全部通过时，才直接输出正常结果，不寒暄、不输出JSON、不增加总结。标题中的X必须替换为本段实际选定的4或5，禁止原样输出字母X。每段依次输出：`,
    "电影叙事版输出前二次门禁",
  );

  assert.ok(candidate.includes("整个批次只输出口播超时门禁"), "电影叙事候选缺少整批停止规则");
  assert.ok(candidate.startsWith("# 最高优先级口播时长门禁"), "电影叙事候选没有把门禁提升到首要位置");
  assert.ok(candidate.includes("下列正常格式全部失效"), "电影叙事候选缺少输出前二次门禁");
  assert.ok(candidate.includes("不得出现代码框、故事板、生图 Prompt、视频 Prompt、导演草案"), "电影叙事候选缺少禁止降级草案规则");
  assert.ok(!candidate.includes("后续仍可给出导演草案"), "电影叙事候选仍保留矛盾的降级草案规则");
  return candidate;
}

const GLOBAL_PACKAGING_LEDGER = `# 全文包装账本与减法门
通读全部分段后，先静默建立一张全文包装账本，再逐段输出。每段只登记：语义核、现实触发物、主视觉载体、功能色、高潮构图、主运镜、结束状态。账本用于跨段查重，不展示给用户。

现实场景道具、角色身体动作和环境反馈优先于抽象警示层。只有现实证据仍无法在一秒内讲清风险、判断或机制时，才增加一个抽象包装；抽象包装不是每段必填项。红黑、红橙、金色、绿色只是按语义选用的候选功能色，不自动组成“红黑警示 -> 金色解决”的固定路径，也不得因为高能风格而强制出现。

连续故事允许同一母题延续，但必须推进状态，例如完整 -> 受压 -> 裂开 -> 残留，而不是每段重演出现、爆发、转金、收束。独立主题中，相邻段不得复用相同的主视觉载体、功能色与高潮构图三件套；任意四个独立主题段内，同一种抽象包装家族最多担任一次主包装。已用家族在后续段降权，优先改用当前场景的门、牵引绳、食盆、地面路径、视线、重心、毛发、呼吸、手势或空间遮挡。

输出前执行减法：同一资产只保留一次紧凑身份锚；后续段仅写会变化的状态。删除创作解释、同义品质词、重复服装材质、重复声音边界、重复包装生命周期和不影响生成的限制句。每段双 Prompt 必须分别可复制，但不重复整套方法论。为给模型计数误差留安全余量，两个代码框合计内部硬目标为：8秒800个字符、10秒930个字符、15秒1250个字符；单框和合计任一超限都要继续压缩。每格英文 Frame 注释最多8个英文单词，只写动作与结果，不重复角色、服装、场景或运镜品质词。`;

const HIGH_ENERGY_DENSITY_SECTION = `# 高能语义包装强度层
默认输出保持高能，但高能来自清楚的动作峰值、表情反应、道具受力和有动机的镜头，不靠每段堆满警示牌、金色粒子与爆炸转化。

1. 事件预算：8秒安排2个强事件和1次主镜头冲击；10秒安排2至3个强事件和1至2次主镜头冲击；15秒安排3至4个强事件和2至3次主镜头冲击。只有原文确有独立升级或二次反转时才增加，不为凑数量造事件。
2. 包装可选：每段最多1个主包装，可再有1个只负责接力的辅助包装；现实动作已经能讲清时使用0个抽象包装。没有主包装时，把视觉注意力交给角色剪影、前景道具、空间压力或物理反馈。
3. 生命周期按需：包装只完成当前语义必需的一次清楚变化，例如逼近、裂开、偏转、吸附、退场或留下痕迹；不强制每段同时完成爆发、碰撞、转色和收束。
4. 镜头动机：主运镜必须由角色、道具或空间变化触发。相邻镜头不重复同一种冲击；同一镜头只保留一种主运镜。
5. 表演峰值：8秒至少1次、10秒1至2次、15秒2至3次清楚的狗狗表情或重心峰值；主人只在语义需要时使用大表情，避免每段都从惊讶演到释然。
6. 色彩服从语义：危险可选红黑或红橙，正确动作可选绿色、蓝色、自然暖光或材质本色，奖励可选金色；也可完全依靠现实道具和光影。悬念段、观察段和连续冲突段不得被强行改写成解决色结尾。
7. 声画爆点：强事件只配一个最能证明接触或受力的现场声；不为每个粒子和转场重复堆音效。
8. 剪枝顺序：先删解释与同义形容，再删重复资产、重复包装和无动作价值的镜头；保留原文核心证据、角色身份、道具路径、结束状态和必要安全边界。`;

type HighEnergyPromptQualityBuildOptions = {
  expectedBaseSha256?: string;
  currentVersionLabel?: string;
  nextVersionLabel?: string;
  prepareBase?: (basePrompt: string) => string;
};

export function buildHighEnergyPromptQualityCandidate(
  basePrompt: string,
  options: HighEnergyPromptQualityBuildOptions = {},
): string {
  const expectedBaseSha256 = options.expectedBaseSha256
    ?? STORY_DIRECTOR_PROMPT_QUALITY_BASELINE.highEnergy.promptSha256;
  const currentVersionLabel = options.currentVersionLabel
    ?? "故事版短视频导演智能体 v2.5.7";
  const nextVersionLabel = options.nextVersionLabel
    ?? "故事版短视频导演智能体 v2.5.8-r3";
  assert.equal(sha256(basePrompt), expectedBaseSha256, "高能版基线 Prompt 已漂移");

  let candidate = replaceExactOnce(
    options.prepareBase ? options.prepareBase(basePrompt) : basePrompt,
    currentVersionLabel,
    nextVersionLabel,
    "高能版候选版本",
  );

  candidate = replaceExactOnce(
    candidate,
    "3. 风格可视化：用精致商业动画电影级3D质感、圆润大眼、细腻皮肤和布料、弹性肢体、蓬松毛发、高饱和暖金光、金橙放射、红黑警示包装锁风格，不依赖空泛风格词。",
    "3. 风格可视化：用精致商业动画电影级3D质感、圆润大眼、细腻皮肤和布料、弹性肢体、蓬松毛发、清楚主次与场景光色锁定风格；功能色由本段语义和全文包装账本决定，不把金橙或红黑设为每段默认。",
    "高能版固定功能色",
  );

  candidate = replaceExactOnce(
    candidate,
    "色彩是暖金阳光或室内暖光，高饱和但不过曝，高对比但保留面部细节，金橙解决色与红黑警示色并存，角色边缘稳定，主体不糊，空气干净少颗粒，画面像高预算动画电影角色进入宠物科普短视频爆点场景。",
    "色彩高饱和但不过曝、高对比且保留面部细节；主光服从真实场景，功能色按语义从红橙、青蓝、绿色、金色、材质本色中择一到两种，跨段查重后使用。角色边缘稳定，主体不糊，空气干净少颗粒，画面像高预算动画电影角色进入宠物科普短视频爆点场景。",
    "高能版默认色彩指纹",
  );

  candidate = replaceExactOnce(
    candidate,
    "画面内只使用少量醒目中文语义牌、爆炸贴纸、警示牌、金色奖励牌和爪印符号作为视觉钩子；工作台UI、口播字幕、长句解释、价格、单位和复杂知识说明不写入图片画面。",
    "画面内只在语义需要时使用少量醒目中文语义牌、爆炸贴纸、警示牌、奖励牌或爪印符号作为视觉钩子；工作台UI、口播字幕、长句解释、价格、单位和复杂知识说明不写入图片画面。",
    "高能版故事板默认奖励色",
  );

  candidate = replaceExactOnce(
    candidate,
    "最终结论牌使用不透明金色或红黑实体牌",
    "最终结论牌使用与本段语义和全文包装账本匹配的不透明高对比实体牌",
    "高能版结论牌默认色",
  );

  candidate = replaceExactOnce(
    candidate,
    "同一个红黑牌、金色光、刻度盘或电弧只能在语义匹配时使用。",
    "同一种牌面、光效、刻度盘或电弧只能在语义匹配且未触发全文查重时使用。",
    "高能版路由母题示例",
  );

  candidate = replaceExactOnce(
    candidate,
    "5. 设计互动生命周期：出现 → 增强 → 与角色/道具碰撞或改变 → 收束/转化；每个特效必须有来源、方向、接触点和结果。",
    "5. 设计最短可见生命周期：现实来源 → 一次峰值变化 → 明确结束或接力；只保留当前语义需要的阶段，并写清方向、接触点和结果。",
    "高能版包装方法论生命周期",
  );

  candidate = replaceExactOnce(
    candidate,
    "# 高能语义包装强度层",
    `${GLOBAL_PACKAGING_LEDGER}\n\n# 高能语义包装强度层`,
    "高能版全文包装账本",
  );

  candidate = replaceSectionOnce(
    candidate,
    "# 高能语义包装强度层",
    "# 精彩表演调度层",
    HIGH_ENERGY_DENSITY_SECTION,
    "高能版强度预算",
  );

  candidate = replaceExactOnce(
    candidate,
    "2. 表演反差：每段至少设计2次清楚反差，例如平静→惊讶、靠近→后撤、红黑压迫→金色解除、杂乱飞散→整齐收束、狗狗紧张→放松信任。",
    "2. 表演反差：每段只保留原文真正需要的1次主反差；15秒且原文有升级时可用2次。反差优先来自靠近与后撤、松弛与僵硬、道具完整与受损、空间开放与受阻、视线信任与回避，不固定套用警示色转解决色。",
    "高能版表演反差",
  );

  candidate = replaceExactOnce(
    candidate,
    "3. 情绪故事锚点：每段必须有“主人意图或误解 → 狗狗感受 → 风险显形 → 主人纠偏或保护 → 关系回暖或行动落点”的情绪链，让观众先共情狗狗，再理解知识点。",
    "3. 情绪故事锚点：连续多段先为全文分配“触发、感受、风险、纠偏、关系或行动落点”等职责，每段只完成当前原文所在的1至2个节点；禁止把完整的误解、风险、纠偏和回暖链重复塞进每一段。独立主题才建立自己的最短因果闭环。",
    "高能版逐段完整情绪链",
  );

  candidate = replaceExactOnce(
    candidate,
    "6. 镜头动机：强运镜来自角色动作或包装冲击，例如牵引绳绷紧带出甩镜、零食飞出带出横移、红黑牌压近带出推近、金色粒子上扬带出俯拍。不得只写“快速运镜”而没有触发物。",
    "6. 镜头动机：强运镜来自角色动作、现实道具或空间变化，例如牵引绳绷紧带出甩镜、零食飞出带出横移、前景门板逼近带出推近、爪子落地带出俯拍。不得只写“快速运镜”而没有触发物。",
    "高能版镜头动机母题示例",
  );

  candidate = replaceExactOnce(
    candidate,
    "4. 包装继承锚点：参考图里出现且服务主语义的红色光晕、电弧、速度线、警示牌、金色光线、腰线描边、刻度盘、粒子路径、爆炸贴纸，视频Prompt必须写出同形态运动：来源、增强、接触、影响对象、收束结果；不能把电弧或光晕弱化成普通发光。",
    "4. 包装继承锚点：参考图里出现且服务主语义的光晕、电弧、速度线、实体牌、轮廓线、刻度盘、粒子路径或爆炸贴纸，视频Prompt必须写出同形态运动的来源、变化、接触、影响对象和结束状态；不能把有动作功能的包装弱化成普通发光。",
    "高能版继承锚点母题示例",
  );

  candidate = replaceExactOnce(
    candidate,
    "每段必须先提取一个主语义核，再选包装，不得机械复用上一段。包装有强度预算：每段只允许 1 个主包装、1 个辅助包装、1 个结论锚点；其余视觉能量交给角色表演、场景道具和运镜。主包装承担语义和最大冲击，不是角落贴纸；辅助包装承担转场，结论锚点承担记忆点。主包装必须在至少一个关键格或关键镜头中成为强视觉事件，占画面约25%至40%的视觉注意力，并与角色、道具或环境发生接触。按以下路由判断：",
    "每段必须先提取一个主语义核，再查全文包装账本。优先用角色表演、场景道具和运镜完成；仍需包装时最多选择1个主包装和1个可选接力包装，不设置必填结论锚点，也不为了填槽增加抽象层。主包装只在语义需要时成为强视觉事件并与角色、道具或环境发生接触；连续故事按状态推进复用，独立主题按账本去重。按以下路由判断：",
    "高能版逐段包装槽",
  );

  candidate = replaceExactOnce(
    candidate,
    "包装必须有生命周期：出现 → 增强 → 与角色/道具接触或改变 → 收束/转化。每段至少让主包装完成爆发、压迫、撞击、裂开、弹回、吸附、追逐、转金或转绿中的两步；相邻段若主语义核、载体、空间形态重复三项以上，必须改变互动方式、颜色或生命周期。抽象光效只作为主包装接触后的反馈，不单独承担语义。健康检查类不写半透明文字量表或小字清单，改用放大镜实体、无字刻度、红橙痛点光晕、金色清除光、发光轮廓和狗狗表情峰值表达。",
    "包装只写当前段能看见的最短生命周期：现实触发 -> 一次峰值变化 -> 明确结束或接力状态。连续故事复用同一母题时推进其状态；独立主题若载体、功能色与高潮构图重复两项以上，必须回查账本并改用现实道具、身体动作或另一种空间形态。抽象光效只作为接触后的反馈，不单独承担语义。健康检查类不写半透明文字量表或小字清单，优先使用放大镜实体、无字刻度、身体姿态、触摸证据和狗狗表情峰值。",
    "高能版包装生命周期",
  );

  candidate = replaceExactOnce(
    candidate,
    "- 误解/纠偏：撕裂爆炸牌、反向箭头、错配标签、红黑文字牌，例如“不是挑衅”；",
    "- 误解/纠偏：撕裂实体牌、反向箭头、错配标签、方向冲突牌，例如“不是挑衅”；",
    "高能版误解路由默认色",
  );

  candidate = replaceExactOnce(
    candidate,
    "- 解决/奖励/正确动作：金色圆角奖励牌、发光交换卡、盾牌、勾选章、温暖光束，例如“成功交换”；",
    "- 解决/奖励/正确动作：圆角奖励牌、发光交换卡、盾牌、勾选章、温暖光束，例如“成功交换”；",
    "高能版奖励路由默认色",
  );

  candidate = replaceExactOnce(
    candidate,
    "- 体态/胖瘦/身材判断：俯视轮廓线、腰线发光描边、圆球化对比、称重盘、肋骨触摸放大窗、红叉“别养成猪”和金色“瘦点好”结论牌；必须用健康、友好、非羞辱的表达，重点表现控制体重与健康风险；",
    "- 体态/胖瘦/身材判断：俯视轮廓线、腰线发光描边、圆球化对比、称重盘、肋骨触摸放大窗、无字健康结论牌；必须用健康、友好、非羞辱的表达，重点表现控制体重与健康风险；",
    "高能版体态路由默认色",
  );

  candidate = replaceExactOnce(
    candidate,
    "生图Prompt采用“资产锁定句 + 本段语义句 + 分格动作句 + 收尾约束句”的高密度结构。资产锁定句只写一次，必须包含默认风格指纹和本段角色/犬种/服装/场景核心资产；分格内用“女主人”“狗狗”“主道具”承接，不重复整套脸型、服装和材质。每格优先写8项：景别机位、主体动作峰值、表情/重心、狗狗眼白/瞳孔/耳朵变化、主道具来源或当前状态、语义包装触发点、包装生命周期阶段、安全构图。每段生图Prompt建议900至1500个中文字符；复杂5格可放宽到1800字。这个区间是质量密度门槛，不是低字数目标；低于下限容易丢风格和构图，高于上限优先删除解释性废话、重复形容词、重复服装外貌和无来源装饰。",
    "生图Prompt采用“紧凑资产锚 + 本段语义句 + 分格动作句 + 收尾边界句”的结构。资产锚只写角色、犬种、服装、场景和所选风格中真正影响本段的识别点；后续连续段用固定资产名承接，只补状态变化。每格优先写景别机位、一个动作峰值、表情或重心、主道具状态、必要包装阶段和安全构图，不逐格重复整套材质。8秒控制在360至500个字符，10秒控制在430至620个字符，15秒控制在540至760个字符；达到上限后先删解释、同义品质词、重复资产、冗长英文Frame说明和无来源装饰。",
    "高能版生图Prompt预算",
  );

  candidate = replaceExactOnce(
    candidate,
    "整段videoPrompt采用“开场绑定句 + 3至4个时间镜头 + 收尾边界句”的高密度结构。开场绑定句不超过180字，只锁定完整故事板、默认风格指纹、核心角色、核心道具、成片全屏连续和声音边界；参考图已锁住外观，后文只写演法。每个镜头只写一个主动作、一个主运镜、一个包装变化和一个接力物；同一镜头不得同时安排三种以上包装。10秒视频Prompt建议800至1400个中文字符，15秒建议1100至1800字；这个区间用于保证“风格不丢、动作能演、信息不溢出”。超过上限时优先删除重复风格、重复服装、解释性语句、口播复述和无接触来源的装饰描述，保留参考绑定、秒级动作、特效生命周期、声音边界和落幅。",
    "整段videoPrompt采用“短开场绑定句 + 时间镜头 + 收尾边界句”的结构。开场绑定句不超过80字，只锁定参考图、核心角色、核心道具、成片全屏连续和声音边界；参考图已锁住外观，后文只写演法。每个镜头只写一个主动作、一个主运镜、最多一个包装变化和一个结束状态。8秒控制在220至350个字符，10秒控制在270至420个字符，15秒控制在380至560个字符；超过上限时删除重复风格、重复服装、解释性语句、口播复述、重复声轨边界和无接触来源装饰，保留秒级动作、接触受力、必要包装、结束状态和落幅。",
    "高能版视频Prompt预算",
  );

  candidate = replaceExactOnce(
    candidate,
    "- 每镜写清动作余波和转场接力物，例如问号向右甩出带出横向跟拍、红色纸片向上飞散引导俯拍、金色粒子汇聚成腰线、牵引绳斜线带向主人手势；",
    "- 每镜写清动作余波和转场接力物，例如问号向右甩出带出横向跟拍、纸片向上飞散引导俯拍、地面轨迹汇聚成腰线、牵引绳斜线带向主人手势；",
    "高能版转场母题示例",
  );

  candidate = replaceExactOnce(
    candidate,
    "和金色健康轮廓，不使用半透明文字量表、底部小字或多项列表。",
    "和高对比健康轮廓，不使用半透明文字量表、底部小字或多项列表。",
    "高能版健康轮廓默认色",
  );

  candidate = replaceExactOnce(
    candidate,
    "特效按“出现→增强→接触→改变→收束”运动，疑问可变成误解牌，误解碎片可变成金色腰线，红色警示可变成绿色勾选或金色结论牌。参考图中的核心光晕、电弧、速度线、实体牌和粒子路径必须在视频里同形态运动继承。",
    "特效只完成当前语义需要的最短变化；疑问可以落到误解牌，错误标记可以裂开或偏转，现实道具状态可以接成下一镜的结果锚点。参考图中的核心光晕、电弧、速度线、实体牌和粒子路径必须在视频里同形态运动继承。",
    "高能版视频生命周期母题示例",
  );

  candidate = replaceExactOnce(
    candidate,
    "高能版每段至少3个强视觉事件，至少2次强镜头冲击，至少1次红黑冲突包装向金色或绿色解决包装转化；如果某段视频Prompt读起来像平稳说明片，必须补回前景冲击、爆点触发、表情定格和包装收束。",
    "高能版按时长执行事件预算：8秒2个、10秒2至3个、15秒3至4个强视觉事件；镜头冲击分别为1次、1至2次、2至3次。功能色与包装服从语义和全文账本，不强制冲突色转解决色；平稳说明片优先补动作峰值、表情定格或现实道具反馈，只在必要时增加包装。",
    "高能版视频密度总门",
  );

  candidate = replaceExactOnce(
    candidate,
    "16. 是否通过高能密度自检：至少3个强视觉事件、至少2次可见镜头冲击、至少2个狗狗表情峰值、主包装在关键格或关键镜头占画面约25%至40%的视觉注意力、至少1次从冲突色到解决色的转化。",
    "16. 是否通过按时长高能密度自检，并通过全文包装账本查重：事件、镜头冲击和表情峰值不超载；现实证据优先；独立主题没有连续复用相同载体、功能色与高潮构图；没有强制冲突色转解决色。",
    "高能版最终自检",
  );

  const forbiddenRules = [
    "每段至少出现一次从冲突色到解决色的转化",
    "至少1次红黑冲突包装向金色或绿色解决包装转化",
    "每段必须有“主人意图或误解 → 狗狗感受 → 风险显形 → 主人纠偏或保护 → 关系回暖或行动落点”",
    "每段生图Prompt建议900至1500个中文字符",
    "10秒视频Prompt建议800至1400个中文字符",
  ];
  for (const forbidden of forbiddenRules) {
    assert.ok(!candidate.includes(forbidden), `高能候选仍包含旧公式：${forbidden}`);
  }
  assert.ok(candidate.includes("# 全文包装账本与减法门"), "高能候选缺少全文包装账本");
  const finalLengthGate = `# 输出提交前硬长度复核
每段两个代码框写完后，必须按最终实际字符重新计数，再决定是否提交。10秒生图代码框内部目标不超过620字符，视频不超过420字符，两框合计不超过930字符；8秒分别不超过500、350、合计800；15秒分别不超过760、560、合计1250。英文 Frame 注释每格最多8个单词。任一内部目标超限时，先缩短英文注释，再删除重复身份、场景、材质、声音和限制句；不得把超长草稿直接输出，也不得展示计数过程。`;
  candidate = `${candidate.trimEnd()}\n\n${finalLengthGate}\n`;

  assert.ok(candidate.includes("10秒控制在430至620个字符"), "高能候选缺少10秒生图安全预算");
  assert.ok(candidate.includes("10秒控制在270至420个字符"), "高能候选缺少10秒视频安全预算");
  assert.ok(candidate.includes("10秒930个字符"), "高能候选缺少双Prompt合计安全预算");
  assert.ok(candidate.includes("英文 Frame 注释每格最多8个单词"), "高能候选缺少英文Frame压缩门禁");
  assert.ok(candidate.includes("不强制冲突色转解决色"), "高能候选没有移除固定色彩转化");
  assert.ok(candidate.includes("**视频提示词**") && candidate.includes("**生图提示词**"), "高能候选改变了公开输出结构");
  const motifCount = (value: string, pattern: RegExp): number => [...value.matchAll(pattern)].length;
  assert.ok(
    motifCount(candidate, /红黑|黑红/gu) < motifCount(basePrompt, /红黑|黑红/gu),
    "高能候选未降低红黑母题词频",
  );
  assert.ok(
    motifCount(candidate, /金色|鎏金|黄金/gu) < motifCount(basePrompt, /金色|鎏金|黄金/gu),
    "高能候选未降低金色母题词频",
  );
  return candidate;
}
