import "server-only";
import { COVER_BUILTIN_STYLE_METADATA } from "../cover-style-catalog";
import { COVER_BENCHMARK_PROMPT_PACKS } from "../cover-benchmark-prompt-packs";
import { DEFAULT_COVER_ANALYSIS_BUSINESS_RULES } from "./cover-analysis-business-defaults";
import { coverStyleReleaseHash, coverWorkflowReleaseHash, type CoverStyleCatalog, type CoverStyleRelease, type CoverWorkflowRelease } from "./cover-style-config";

export const COVER_BENCHMARK_ANALYSIS_RULES = [
  "先找原文真正想表达的一句话，再找支撑它的人物或商品、关系对象、一个关键动作及前后变化；没有提供的经历、冲突或结论不能为了戏剧性补造。",
  "口播提炼主题、观点、关系、情绪和一个可画事件；商品介绍提炼品类、已给定的卖点、适用场景及规格；带货口播同时保留故事看点与商品事实，不把所有内容套成宠物故事。",
  "标题候选可分别采用有依据的概括、反差、问题或结果兴趣缺口；标题必须让用户看懂与自己有什么关系，不把普通概括机械变成夸张承诺或悬念套句。",
  "主标题先提炼为1至2行可读短语，信息过长时先在分析阶段精炼核心对象和关系，不用第3行装入完整正文。用户确认后逐字保留标题、标点与显式换行，不再改词或截断。",
  "只选择当前材料确实支持的钩子：例如犹豫到行动、误会被澄清、动作与结果的反差、关系中的期待。材料没有明显反差时使用清晰具体的总结，不强造危险、焦虑或震惊。",
  "visualBrief中的主体、动作、场景、情绪应共同表现同一个关键瞬间，而非互不相关的四个词；让眼神或动作指向明确对象，缩略图上也能读懂这个瞬间。",
  "区分原文事实与表现主题的创意场景：无来源的房间、道具或表演细节只能是示意性创作，不得升级为真实人物经历、商品性能、医学结论或实证承诺。",
  "无真实商品图时只能规划商品概念或使用场景示意；已提供照片时先说明实际可见的外观和用户要求保留的范围，不能把模型重绘称为真实SKU或像素级保真。",
  "每个候选标题和非空画面字段仍须按当前JSON协议提供有效来源依据；不要为表达钩子新增协议未定义字段。用户手工标题及显式换行优先，不能被候选覆盖。",
  "先保持共同事实层，再按所选风格包编写标题和画面表达；切换风格不改变事实，但准备与缓存必须绑定真实风格/提示词版本，不能拿旧风格结果冒称新分析，也不能自动重发未知付费结果。",
] as const;

/** Read-time compatibility only: never writes defaults into historical releases. */
export function createDefaultCoverWorkflowRelease(): CoverWorkflowRelease {
  const payload = { sharedRules: [...COVER_BENCHMARK_ANALYSIS_RULES, ...DEFAULT_COVER_ANALYSIS_BUSINESS_RULES].join("\n"), textModelId: null, imageModelId: null,
    releaseId: "builtin:cover-workflow:1.0.0", version: "1.0.0", sequence: 1,
    createdAt: "2026-11-06T00:00:00.000Z", createdBy: "builtin" };
  return { ...payload, snapshotSha256: coverWorkflowReleaseHash(payload) };
}

/** Deterministic initial state only when the dedicated row does not yet exist.
 * Read failures and malformed persisted state never fall back to this data. */
export function createDefaultCoverStyleCatalog(): CoverStyleCatalog {
  const at = "2026-11-06T00:00:00.000Z";
  return { schemaVersion: "cover-style-catalog/1", revision: 0, audit: [], entries: COVER_BUILTIN_STYLE_METADATA.map(meta => {
    const pack = COVER_BENCHMARK_PROMPT_PACKS[meta.styleKey as "cartoon" | "funny-cartoon"];
    const payload = { releaseId: `builtin:${meta.styleKey}:1.0.0`, styleKey: meta.styleKey, version: "1.0.0", sequence: 1,
      displayName: meta.displayName, description: meta.description, analysisPrompt: pack.analysisRules.join("\n"),
      generationPrompt: pack.nativeCoverRules.join("\n"), createdAt: at, createdBy: "builtin" };
    const release: CoverStyleRelease = { ...payload, snapshotSha256: coverStyleReleaseHash(payload) };
    const published = { releaseId: release.releaseId, publishedAt: at, publishedBy: "builtin" };
    return { styleKey: meta.styleKey, enabled: true, order: meta.order, draftReleaseId: null, current: published,
      releases: [release], publications: [{ ...published, action: "publish" as const }] };
  }) };
}

/** Historical server-only style grammar; never returned by the public catalog. */
export const COVER_PRIVATE_LEGACY_STYLE_PROFILES = [
  {
    key: "cartoon", version: "3.0.0", displayName: "好运降临 · 温情叙事",
    researchSources: [{ creator: "好运降临", sampleCount: 17 }],
    visualGrammar: [
      "主体严格来自当前内容：职场或日常口播使用相应人物与行动，动物内容才使用对应动物，商品内容围绕明确品类或使用场景；不把狗、宠物脸或任何博主固定角色当全行业默认。",
      "采用高完成度商业3D动画造型，圆润但有结构与体积；材质随主体适配：人物有自然皮肤和布料，动物有柔软且分层的毛发，商品有符合材料描述的表面与反射，不把人物或物品做成毛绒宠物。",
      "柔和电影主光、适量体积光和清楚的前中后景；温暖高光配柔和阴影，主体眼睛与关键接触处清晰，景深仅用于分离背景，避免过曝、塑料油亮或背景细节抢占主体。",
      "先确定一种可信情绪，再用眼神、嘴角、肩背和手部或肢体动作表现；期待、释然、惊讶、依赖或委屈需服务当前事件，不靠随意变形和无关卖萌替代内容。",
      "一个关键动作指向一个关系对象或语义道具，例如开始动手、等待回应、递出物品或做出选择；动作与目光形成关系，单看图也能理解发生了什么。",
      "截取故事发生前后可想象的一个瞬间，让动作、结果线索或关系产生温和兴趣缺口；不得增加原文没有的伤害、灾难、真实经历或商品功效。",
      "场景随内容选择居家、办公室、课堂、日常街景或适合品类的使用环境；采用中近景或有明确主次的关系构图，主体一般位于中下部，重要脸部、手部和商品轮廓在目标裁切内完整可辨。",
      "文字空间随场景在上方、左上或关系间隙形成连续自然的低细节区域；优先利用墙面、天空、景深背景或场景光色，不固定制造空白顶栏、标题框、卡片或下方色块。",
      "情感内容偏克制的暖白或金色标题语法；知识、清单和疑问内容可采用更厚的层级和少量对比色。这里仅为应用排版留空间，底图不绘制任何标题、数字或拟文字。",
      "清单主题可用有限的实物关系或少量辅助小场景表现结构，但不能默认把正文逐句塞进图里；未提供的数量、功能、步骤和对比结果不得凭空补齐。",
      "暖金、橙棕、奶油色构成主调，必要的蓝或粉只作层次与重点；光色帮助分离人物关系和事件，不把整图压成单一黄色滤镜。",
      "缩略图首先读懂主体表情与动作，其次理解生活背景；保持轮廓清楚、关系可见、主体与文字区域明暗有区别，不以大量装饰代替明确叙事。",
      "用户提供并要求保留的真实人物、商品或背景属于原图图层；新的画面指令只作用于明确允许生成的区域，不重绘包装、标识或外观后宣称保真。",
      "只迁移公开样本的制作语法，不复制研究账号的角色形象、原标题、品牌或成套版式；无字底图不得出现汉字、字母、数字、问号、Logo、水印、拟文字和空条幅。",
    ],
    palette: ["暖金主光", "橙与棕的生活场景", "奶油色高光", "少量蓝或粉的语义重点"],
    typography: { profile: "warm_story", maxLines: 3, respectExplicitLineBreaks: true },
  },
  {
    key: "funny-cartoon", version: "3.0.0", displayName: "哈尼有话讲 · 夸张反应",
    researchSources: [{ creator: "哈尼有话讲", sampleCount: 18 }],
    visualGrammar: [
      "主体由新文案决定，人物、动物或商品使用场景分别适配；保留内容中的关系对象和动作，不固定复用狗脸、金毛角色或研究账号的人物形象。",
      "高完成度商业3D动画质感，造型有体积与清楚轮廓；人物采用适合表演的面部、皮肤与布料，动物采用分层毛发，物品材质按内容描述呈现，不能给无生命商品凭空添加会被当成真实功能的结构。",
      "用鼻眼嘴的形态、眉眼方向、嘴角与头部透视强化单一可读反应；可表现疑惑、嫌弃、惊讶、得意、偷看或被抓包，但必须与当前事件相关，避免无关怪脸。",
      "表情与肢体动作共同形成笑点：一个目光、停顿、后仰、前探、护住物品或突然回头的动作就应能读懂反应，不把夸张仅理解为放大眼睛。",
      "选择材料支持的误会、前后反差、期待与结果不同或突然被看见的戏剧瞬间；原文没有失控、危险或尴尬时不强加这些经历。",
      "主体在中下部占较大比例，脸部或关键动作先于背景被看到；中近景、适度透视与清晰前景关系加强反应，手部、身体与关键商品不被裁切破坏。",
      "生活、职场、学习或消费场景提供笑点上下文，保留一两件关键道具即可；背景用景深和光色降低复杂度，不用密集物体抢走主角。",
      "上方约25%至35%可形成标题识别区，但须为场景本身连续低细节区域；横版与不同主体允许向左上或自然空隙适配，不为满足比例强加空白横条或标题框。",
      "桃粉、珊瑚橙、亮黄、青蓝及少量紫色形成高对比与层级；暖色生活光可保留，主体边缘、表情和动作在缩略图上仍要清晰，避免全画面霓虹过载。",
      "电影暖光或适量聚光强调反应瞬间，局部高光、边缘光和浅景深辅助主次；允许少量无文字符号含义的运动线或光线，但不生成问号、感叹号、字母和文字贴纸。",
      "标题视觉由应用完成：粗体、深酒红或深紫描边、立体投影与黄粉青的分行强调；通常两至三行，强调短反应或反问的阅读节奏，底图只留相应空间。",
      "先通过主体反应和冲突让缩略图可读，再让应用标题补足兴趣缺口；如果去掉标题就完全看不懂当前事件，应简化场景而非增加无关装饰。",
      "用户要求保留的商品、人物或背景采用原资产图层；不得为增强搞怪而重绘商品包装、篡改人物身份或改变品牌标识，再宣称忠实保留。",
      "风格可以放大表现幅度，不能放大事实：不添加原文没有的销量、功效、医学结论、价格或保证，也不把概念画面当真实SKU。",
      "迁移研究中的反应语法、配色与阅读层级，不复制原作者标题和固定角色；无字底图不得绘制真实或伪造文字、数字、水印、Logo、空卡片和条幅。",
    ],
    palette: ["桃粉与珊瑚橙", "亮黄重点", "青蓝对比", "少量紫色层次", "应用文字深酒红或深紫描边"],
    typography: { profile: "high_contrast_reaction", maxLines: 3, respectExplicitLineBreaks: true },
  },
] as const;
