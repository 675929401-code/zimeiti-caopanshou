import { COVER_OUTPUT_SPECS, type CoverOutputSpec, type CoverTitleStyle } from "./cover-composition";

export type BenchmarkCoverStyleKey = "cartoon" | "funny-cartoon";
export type BenchmarkCoverRatio = keyof typeof COVER_OUTPUT_SPECS;
export type BenchmarkCoverLayoutIntent = {
  structure: "single" | "relationship" | "comparison" | "list";
  focus: "expression" | "action" | "object";
  evidenceRefs: readonly string[];
};
export type BenchmarkCoverLayoutInput = {
  analysis: { primaryTitle: string; visualBrief: { subject: string; action: string; scene: string; emotion: string };
    layoutIntent?: BenchmarkCoverLayoutIntent };
  styleKey: BenchmarkCoverStyleKey;
  ratio: BenchmarkCoverRatio;
};
export type BenchmarkCoverRegion = { x: number; y: number; width: number; height: number };
export type BenchmarkCoverLayoutPlan = {
  templateId: string;
  displayName: string;
  reason: string;
  source: "semantic_intent" | "legacy_default";
  outputSpec: CoverOutputSpec;
  titleStyle: Required<Pick<CoverTitleStyle, "x" | "y" | "width" | "scale">> & { colorMode: "palette" };
  titleZone: BenchmarkCoverRegion;
  subjectZone: BenchmarkCoverRegion;
  sceneDirectives: string[];
  researchSources: Array<{ creator: string; sampleCount: number; evidencePath: string }>;
};
export class BenchmarkCoverLayoutError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BenchmarkCoverLayoutError"; }
}
const refuse = (code: string, message: string): never => { throw new BenchmarkCoverLayoutError(code, message); };
const region = (x: number, y: number, width: number, height: number): BenchmarkCoverRegion => ({ x, y, width, height });
const round = (value: number) => Math.round(value * 10_000) / 10_000;
type Geometry = { id: string; name: string; title: BenchmarkCoverRegion; subject: BenchmarkCoverRegion; direction: string };

function warmGeometry(intent: BenchmarkCoverLayoutIntent, portrait: boolean): Geometry {
  if (intent.structure === "relationship") return portrait
    ? { id: "warm-relationship-top", name: "温情关系 · 上题下景", title: region(.07, .055, .86, .25), subject: region(.07, .36, .86, .59),
      direction: "中近景展示原内容确有的关系主体，眼神、手部或动作指向对方；用上方自然标题区和下方关系场景交代一个情绪瞬间。" }
    : { id: "warm-relationship-top", name: "温情关系 · 上题双侧", title: region(.07, .05, .86, .24), subject: region(.065, .355, .87, .59),
      direction: "横版采用上方标题、下方左右关系构图；主角与原内容中的关系对象占据清楚比例，不用远景小人物和大量空房间稀释情绪。" };
  if (intent.structure === "comparison") return portrait
    ? { id: "warm-comparison-top", name: "暖色反差 · 上题对照", title: region(.10, .045, .80, .22), subject: region(.045, .315, .91, .63),
      direction: "用下方左右或前后关系呈现材料支持的差别；主体动作与结果线索可比较，仍是自然场景，不生成空卡片、分隔文字或虚构的前后效果。" }
    : { id: "warm-comparison-top", name: "暖色反差 · 横向对照", title: region(.07, .045, .86, .22), subject: region(.055, .325, .89, .625),
      direction: "上方简洁标题区、下方横向对照，把材料明确支持的两个状态或对象排出主次；差别依靠动作和场景线索表达，不添加新事实。" };
  if (intent.structure === "list") return portrait
    ? { id: "warm-list-top", name: "暖色清单 · 主体与辅助", title: region(.06, .045, .88, .235), subject: region(.055, .345, .89, .60),
      direction: "语义确为清单才采用主体加少量辅助分组；分组数量依据当前分析，未给定数量不补步骤、序号或新卖点，底图不写数字。" }
    : { id: "warm-list-left", name: "暖色清单 · 左题右组", title: region(.05, .13, .34, .40), subject: region(.455, .12, .495, .80),
      direction: "横版左侧自然标题区，右侧一个主要对象配少量辅助分组；分组只来自语义清单，不把每句口播拼成一张小图。" };
  if (portrait) return intent.focus === "expression"
    ? { id: "warm-face-top", name: "暖色情绪 · 表情近景", title: region(.08, .05, .84, .245), subject: region(.15, .355, .70, .605),
      direction: "中下部采用头肩或关键主体近景，眼神与细微表情在缩略图上可辨；上方保留连续低细节场景，不把主体缩成全景里的小角色。" }
    : { id: "warm-action-top", name: "暖色故事 · 上题动作", title: region(.07, .06, .86, .23), subject: region(.095, .345, .81, .605),
      direction: "主体位于中下部，以一个关键动作或语义物件讲清事件；保留必要手部、身体与物件关系，背景只交代生活情境。" };
  return intent.focus === "expression"
    ? { id: "warm-face-left", name: "暖色情绪 · 左题右近景", title: region(.055, .12, .38, .37), subject: region(.495, .15, .455, .79),
      direction: "横版左题右主体，右侧表情近景明显大于环境细节；保留眼神关系和适当景深，避免宽镜头里表情过小。" }
    : { id: "warm-action-left", name: "暖色故事 · 左题右动作", title: region(.055, .14, .39, .36), subject: region(.505, .13, .445, .81),
      direction: "横版左侧留自然阅读空间，右侧用中近景展示行动与关键对象；主体和动作占据清楚面积，不靠空房间或泛化装饰撑画面。" };
}

function funnyGeometry(intent: BenchmarkCoverLayoutIntent, portrait: boolean): Geometry {
  if (intent.structure === "relationship") return { id: "funny-relationship-top", name: "搞怪反应 · 上题关系", title: region(.06, .04, .88, .30),
    subject: portrait ? region(.045, .405, .91, .55) : region(.045, .42, .91, .53),
    direction: "标题在上方形成强层级，下方让原内容中的主角与关系对象呈现一主一辅的反应；面部和动作比背景更突出，不凭构图需要添加新人物。" };
  if (intent.structure === "comparison") return { id: "funny-comparison-top", name: "搞怪反差 · 上题双侧", title: region(.055, .035, .89, .29),
    subject: portrait ? region(.035, .385, .93, .57) : region(.035, .405, .93, .55),
    direction: "下方左右对照让表情或动作反差一眼可读，上方留两至三行强标题空间；对照必须来自语义计划，不能生成未提供的功效前后图。" };
  if (intent.structure === "list") return portrait
    ? { id: "funny-list-top", name: "搞怪清单 · 上题反应组", title: region(.06, .04, .88, .28), subject: region(.055, .375, .89, .58),
      direction: "只在分析明确为清单时，用一个大反应主体和少量辅助对象表达结构；维持主角最大，不让分组淹没表情，也不绘制编号。" }
    : { id: "funny-list-left", name: "搞怪清单 · 左题右组", title: region(.04, .09, .40, .42), subject: region(.505, .10, .445, .84),
      direction: "左侧短而醒目的标题区，右侧紧凑的主反应与辅助分组；只表达原材料已确认的项目，不能从标题里的数字擅自反推清单。" };
  if (portrait) return intent.focus === "expression"
    ? { id: "funny-face-top", name: "搞怪大表情 · 上题下脸", title: region(.065, .04, .87, .30), subject: region(.085, .395, .83, .565),
      direction: "上方约三成自然标题区，下方大表情近景；鼻眼嘴、眉眼方向和头部透视适度夸张，保留主体身份与关键轮廓，先看懂反应再读标题。" }
    : { id: "funny-action-top", name: "搞怪动作 · 上题下反应", title: region(.06, .035, .88, .285), subject: region(.055, .39, .89, .565),
      direction: "上方强标题，下方中近景完整展示关键动作或物件引发的反应；喜剧幅度高于温情路线，但动作必须对应当前语义。" };
  return intent.focus === "expression"
    ? { id: "funny-face-left", name: "搞怪大表情 · 左题右脸", title: region(.045, .10, .42, .40), subject: region(.535, .075, .415, .86),
      direction: "横版左题右脸，右侧大近景突出一眼可辨的夸张反应；主体明显大于环境，背景只保留一两项笑点上下文。" }
    : { id: "funny-action-left", name: "搞怪动作 · 左题右反应", title: region(.05, .09, .39, .40), subject: region(.505, .16, .445, .78),
      direction: "左侧强标题区，右侧放大动作和反应主体；适度透视、光线与主次强化喜剧，不生成无关怪脸或密集小物体。" };
}

/** Only validated semantic layoutIntent selects structure. No title keywords,
 * numerical-title heuristics, OCR, model calls or account lookup occur here. */
export function resolveBenchmarkCoverLayout(input: BenchmarkCoverLayoutInput): BenchmarkCoverLayoutPlan {
  if (input.styleKey !== "cartoon" && input.styleKey !== "funny-cartoon") return refuse("COVER_BENCHMARK_LAYOUT_STYLE_INVALID", "当前风格不使用两套动画研究版式。");
  if (!Object.hasOwn(COVER_OUTPUT_SPECS, input.ratio)) return refuse("COVER_BENCHMARK_LAYOUT_RATIO_INVALID", "请选择有效的封面比例。");
  if (typeof input.analysis?.primaryTitle !== "string" || !input.analysis.primaryTitle.trim()
    || input.analysis.primaryTitle.length > 80 || input.analysis.primaryTitle.split(/\r?\n/u).length > 3) {
    return refuse("COVER_BENCHMARK_LAYOUT_TITLE_INVALID", "请先提供有效的封面标题，最多80字、3行。");
  }
  const supplied = input.analysis.layoutIntent;
  if (supplied && (!["single", "relationship", "comparison", "list"].includes(supplied.structure)
    || !["expression", "action", "object"].includes(supplied.focus) || !Array.isArray(supplied.evidenceRefs)
    || !supplied.evidenceRefs.length || supplied.evidenceRefs.some(id => typeof id !== "string" || !id.trim()))) {
    return refuse("COVER_BENCHMARK_LAYOUT_INTENT_INVALID", "版式意图缺少有效结构或内容依据，请查询原分析结果。");
  }
  const source = supplied ? "semantic_intent" as const : "legacy_default" as const;
  const intent: BenchmarkCoverLayoutIntent = supplied ?? { structure: "single", focus: "action", evidenceRefs: [] };
  const portrait = input.ratio === "9:16" || input.ratio === "3:4";
  const geometry = input.styleKey === "cartoon" ? warmGeometry(intent, portrait) : funnyGeometry(intent, portrait);
  const titleZone = { ...geometry.title }, subjectZone = { ...geometry.subject };
  // Four fixed aspect ratios receive explicit geometry adaptation. Tall
  // portraits reserve more breathing room; 4:3 protects the narrower subject.
  if (input.ratio === "9:16") { titleZone.height = round(titleZone.height - .015); subjectZone.y = round(subjectZone.y + .01); subjectZone.height = round(subjectZone.height - .01); }
  if (input.ratio === "4:3") {
    if (geometry.id.endsWith("left")) { titleZone.width = round(titleZone.width - .025); subjectZone.x = round(subjectZone.x - .015); subjectZone.width = round(subjectZone.width + .015); }
    else { titleZone.height = round(titleZone.height + .015); subjectZone.y = round(subjectZone.y + .015); subjectZone.height = round(subjectZone.height - .015); }
  }
  if (intent.focus === "object" && intent.structure === "single") {
    subjectZone.x = round(subjectZone.x + .015); subjectZone.width = round(subjectZone.width - .03);
    subjectZone.y = round(subjectZone.y + .025); subjectZone.height = round(subjectZone.height - .04);
  }
  const baseline = portrait ? input.styleKey === "funny-cartoon" ? .31 : .27 : .30;
  const scale = round(Math.max(.7, Math.min(1.3, titleZone.height / baseline)));
  const outputSpec: CoverOutputSpec = { aspectRatio: input.ratio, ...COVER_OUTPUT_SPECS[input.ratio], format: "png" };
  return {
    templateId: `gaoding-benchmark-${geometry.id}-${input.ratio.replace(":", "")}`,
    displayName: geometry.name,
    reason: supplied ? `依据已验证的${({ single: "单主体", relationship: "关系叙事", comparison: "反差对照", list: "清单" } as const)[intent.structure]}意图，${portrait ? "采用竖版上下层级" : "采用横版阅读与主体分区"}；${geometry.direction}`
      : `原分析没有版式意图，采用明确标注的单主体默认版式；不从标题关键词猜清单或关系。${geometry.direction}`,
    source, outputSpec,
    titleStyle: { x: titleZone.x, y: titleZone.y, width: titleZone.width, scale, colorMode: "palette" },
    titleZone, subjectZone,
    sceneDirectives: [
      `实际封面目标为${input.ratio}、${outputSpec.width}×${outputSpec.height}；本版式为“${geometry.name}”。底图构图同时适配原生比例到该目标的裁切，关键主体不得落在裁切损失区。`,
      geometry.direction,
      `归一化标题建议区=${JSON.stringify(titleZone)}。该区必须是场景自身连续、自然的低细节区域；不生成标题、数字、字母、拟文字、空卡片、横条或文字框。应用保留标题原文和手工显式换行。`,
      `归一化关键主体保护区=${JSON.stringify(subjectZone)}。面部、重要手部或商品轮廓必须清楚放在该区；不要用标题区放关键面部，不要把主体缩成宽镜头中的小点。`,
      intent.focus === "expression" ? "表情优先：用中近景把目光、眉眼、嘴角和关系对象表达清楚；主体没有面部时以其可辨认形态表达主题，不强加人脸。"
        : intent.focus === "object" ? "物件优先：关键对象外观与使用关系清楚，材质和光线服从原内容；只使用已给定事实，不添加规格、功效或品牌。"
          : "动作优先：完整保留一个关键动作及其对象，手、爪、工具或产品接触关系自然；背景仅交代必要情境。",
      "标题区与关键主体区是互不重叠的构图指导；最终应用仍须根据实际字形与图像校验遮挡，不能仅凭归一化区域宣称像素级避让已验收。",
    ],
    researchSources: [],
  };
}
